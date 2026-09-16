/**
 * recorders/base.js
 * Базовый класс для всех платформ видеоконференций (Яндекс.Телемост, Google Meet, Zoom, Teams).
 * Реализует:
 * - Инициализацию Puppeteer браузера с аудио-флагами
 * - Инъекцию WebRTC-перехватчика (Dual-Output: общий микс + per-track файлы)
 * - Диспетчеризацию голосовых команд и триггеров автовыхода
 * - Graceful shutdown и управление жизненным циклом сессии
 */

import puppeteer from 'puppeteer';
import { resolve, dirname } from 'path';
import { existsSync, mkdirSync, appendFileSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { parseVoiceTrigger } from '../services/voice-trigger.js';

export class BaseMeetingRecorder {
  constructor(options = {}) {
    this.joinUrl = options.joinUrl;
    this.outputFile = options.outputFile;
    this.botName = options.botName || process.env.BOT_DISPLAY_NAME || 'Бот-Ассистент';
    this.isHeadless = options.headless !== undefined ? options.headless : process.env.HEADLESS !== 'false';
    this.maxIdleMins = parseFloat(process.env.MAX_IDLE_MINS || '2');
    this.maxDurationMins = parseFloat(process.env.MAX_DURATION_MINS || '180');
    
    this.browser = null;
    this.page = null;
    this.isShuttingDown = false;
    this.userDataDir = null;

    if (this.outputFile) {
      this.outputPath = resolve(this.outputFile);
      this.outputDir = dirname(this.outputPath);
      this.tracksDir = resolve(this.outputDir, 'tracks');
      this.metaDir = resolve(this.outputDir, 'meta');

      if (!existsSync(this.outputDir)) mkdirSync(this.outputDir, { recursive: true });
      if (!existsSync(this.tracksDir)) mkdirSync(this.tracksDir, { recursive: true });
      if (!existsSync(this.metaDir)) mkdirSync(this.metaDir, { recursive: true });

      try { chmodSync(this.outputDir, 0o777); } catch(e) {}
      try { chmodSync(this.tracksDir, 0o777); } catch(e) {}
      try { chmodSync(this.metaDir, 0o777); } catch(e) {}

      // Очищаем/создаем выходной файл
      writeFileSync(this.outputPath, '');
      try { chmodSync(this.outputPath, 0o666); } catch(e) {}
    }
  }

  async initBrowser(customArgs = []) {
    const meetingIdStr = this.joinUrl ? this.joinUrl.split('/').pop().replace(/[^a-zA-Z0-9_-]/g, '') : 'default';
    this.userDataDir = resolve(tmpdir(), `puppeteer_${this.getPlatformName()}_${meetingIdStr}_${Date.now()}`);

    const baseArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--allow-file-access-from-files',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,720',
      '--lang=ru-RU,ru',
      ...customArgs
    ];

    console.log(`[recorder-core] Запуск браузера (${this.getPlatformName()}), headless=${this.isHeadless}...`);
    this.browser = await puppeteer.launch({
      headless: this.isHeadless ? 'new' : false,
      args: baseArgs,
      userDataDir: this.userDataDir,
      ignoreDefaultArgs: ['--mute-audio']
    });

    const pages = await this.browser.pages();
    this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();
    await this.page.setViewport({ width: 1280, height: 720 });
    await this.page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    await this.setupBridges();
    await this.injectWebRtcInterceptor();
  }

  getPlatformName() {
    return 'base';
  }

  async setupBridges() {
    if (!this.outputFile) return;

    // Сохранение микса
    await this.page.exposeFunction('__saveAudioChunk', (base64data) => {
      const buffer = Buffer.from(base64data, 'base64');
      appendFileSync(this.outputPath, buffer);
    });

    // Сохранение per-track чанков
    await this.page.exposeFunction('__saveTrackChunk', (trackId, base64data) => {
      const buffer = Buffer.from(base64data, 'base64');
      const trackPath = resolve(this.tracksDir, `${trackId}.webm`);
      if (!existsSync(trackPath)) {
        writeFileSync(trackPath, '');
        try { chmodSync(trackPath, 0o666); } catch(e) {}
      }
      appendFileSync(trackPath, buffer);
    });

    // Логирование событий треков
    await this.page.exposeFunction('__logTrackEvent', (eventObj) => {
      const eventLine = JSON.stringify(eventObj) + '\n';
      appendFileSync(resolve(this.metaDir, 'track_events.ndjson'), eventLine);
    });

    // Сохранение summary треков
    await this.page.exposeFunction('__saveTracksSummary', (summaryObj) => {
      const summaryPath = resolve(this.metaDir, 'tracks_summary.json');
      writeFileSync(summaryPath, JSON.stringify(summaryObj, null, 2));
    });

    // Хук голосового триггера автовыхода
    await this.page.exposeFunction('__onSpeechRecognized', async (text) => {
      const trigger = parseVoiceTrigger(text);
      if (trigger.isExitCommand) {
        console.log(`[voice-trigger] 🛑 Обнаружена голосовая команда выхода: "${text}". Инициируем завершение записи...`);
        await this.stop();
      }
    });
  }

  async injectWebRtcInterceptor() {
    await this.page.evaluateOnNewDocument(() => {
      const originalRTCPeerConnection = window.RTCPeerConnection;
      if (!originalRTCPeerConnection) return;

      const allRemoteTracks = [];
      const activeRecorders = new Map();
      let mixRecorderStarted = false;
      let mixAudioContext = null;
      let mixDestination = null;
      let mixRecorder = null;

      window.RTCPeerConnection = function (...args) {
        const peerConnection = new originalRTCPeerConnection(...args);

        peerConnection.addEventListener('track', (event) => {
          if (event.track.kind === 'audio') {
            console.log('[recorder-inject] Удаленный аудиотрек получен:', event.track.id);
            allRemoteTracks.push(event.track);
            
            try {
              if (window.__logTrackEvent) {
                window.__logTrackEvent({
                  type: 'track-added',
                  trackId: event.track.id,
                  timestamp: Date.now()
                });
              }
            } catch (e) {}

            startTrackRecorder(event.track);
            tryStartMixRecorder();
          }
        });

        return peerConnection;
      };

      function startTrackRecorder(track) {
        if (activeRecorders.has(track.id)) return;
        const stream = new MediaStream([track]);
        const recorder = new MediaRecorder(stream, {
          mimeType: 'audio/webm;codecs=opus',
          audioBitsPerSecond: 32000
        });

        recorder.ondataavailable = async (e) => {
          if (e.data.size > 0 && window.__saveTrackChunk) {
            const buf = await e.data.arrayBuffer();
            const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
            window.__saveTrackChunk(track.id, base64);
          }
        };

        recorder.start(2000);
        activeRecorders.set(track.id, { recorder, track });
      }

      function tryStartMixRecorder() {
        if (!mixAudioContext) {
          mixAudioContext = new AudioContext();
          mixDestination = mixAudioContext.createMediaStreamDestination();
        }

        const newTracks = allRemoteTracks.filter(t => !t._mixed);
        for (const track of newTracks) {
          const stream = new MediaStream([track]);
          const source = mixAudioContext.createMediaStreamSource(stream);
          source.connect(mixDestination);
          track._mixed = true;
        }

        if (!mixRecorderStarted && allRemoteTracks.length > 0) {
          mixRecorderStarted = true;
          mixRecorder = new MediaRecorder(mixDestination.stream, {
            mimeType: 'audio/webm;codecs=opus',
            audioBitsPerSecond: 32000
          });

          mixRecorder.ondataavailable = async (e) => {
            if (e.data.size > 0 && window.__saveAudioChunk) {
              const buf = await e.data.arrayBuffer();
              const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
              window.__saveAudioChunk(base64);
            }
          };

          mixRecorder.start(2000);
        }
      }

      window.__stopRecorder = () => {
        if (mixRecorder && mixRecorder.state !== 'inactive') mixRecorder.stop();
        if (mixAudioContext) mixAudioContext.close();
        for (const [trackId, recObj] of activeRecorders.entries()) {
          if (recObj.recorder && recObj.recorder.state !== 'inactive') {
            recObj.recorder.stop();
          }
        }
        if (window.__saveTracksSummary) {
          window.__saveTracksSummary({
            totalTracks: allRemoteTracks.length,
            trackIds: allRemoteTracks.map(t => t.id)
          });
        }
      };
    });
  }

  // Метод входа — переопределяется в подклассах
  async joinAndRecord() {
    throw new Error('joinAndRecord must be implemented by platform subclass');
  }

  async stop() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    console.log(`[recorder-core] ⏹️ Завершение записи (${this.getPlatformName()})...`);

    if (this.page) {
      try {
        await this.page.evaluate(() => {
          if (window.__stopRecorder) window.__stopRecorder();
        });
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {}
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) {}
    }
  }
}
