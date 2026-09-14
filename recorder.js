/**
 * recorder.js — Zero Cost Puppeteer-бот для записи аудио из Яндекс.Телемоста.
 * Адаптировано для Windows. Без зависимости от Яндекс 360.
 *
 * Использование:
 *   node recorder.js <join_url> <output_file>
 */

import puppeteer from "puppeteer";
import {
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "fs";
import { resolve, dirname } from "path";
import { tmpdir } from "os";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const joinUrl = process.argv[2];
const meetingIdStr = joinUrl ? joinUrl.split('/').pop().replace(/[^a-zA-Z0-9_-]/g, '') : 'default';
const userDataDir = resolve(tmpdir(), `puppeteer_telemost_${meetingIdStr}_${Date.now()}`);

const isCreateMode = joinUrl === '--create';
const outputFile = isCreateMode ? null : process.argv[3];
const isHeadless = process.env.HEADLESS !== "false";

if (!joinUrl || (!isCreateMode && !outputFile)) {
  console.error("Использование: node recorder.js <join_url> <output_file> ИЛИ node recorder.js --create");
  process.exit(1);
}

let outputPath;
let outputDir;
let tracksDir;
let metaDir;

if (!isCreateMode) {
  outputPath = resolve(outputFile);
  outputDir = dirname(outputPath);
  tracksDir = resolve(outputDir, "tracks");
  metaDir = resolve(outputDir, "meta");

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  if (!existsSync(tracksDir)) mkdirSync(tracksDir, { recursive: true });
  if (!existsSync(metaDir)) mkdirSync(metaDir, { recursive: true });

  // Change directory permissions so host user (ubuntu) can create transcript.txt and delete files
  try { chmodSync(outputDir, 0o777); } catch(e) { console.error(e); }
  try { chmodSync(tracksDir, 0o777); } catch(e) { console.error(e); }
  try { chmodSync(metaDir, 0o777); } catch(e) { console.error(e); }
  
  // Очистка старого файла микса
  writeFileSync(outputPath, "");
  // Создание track_events.ndjson
  writeFileSync(resolve(metaDir, "track_events.ndjson"), "");

  try { chmodSync(outputPath, 0o666); } catch(e) { console.error(e); }
  try { chmodSync(resolve(metaDir, "track_events.ndjson"), 0o666); } catch(e) { console.error(e); }

  console.log(`[recorder] join_url: ${joinUrl}`);
  console.log(`[recorder] output:   ${outputPath}`);
  console.log(`[recorder] tracks:   ${tracksDir}`);
} else {
  console.log(`[recorder] Режим создания новой встречи активен.`);
}

// Очистка от случайных кавычек или скобок
const rawBotName = process.env.BOT_DISPLAY_NAME || "Telemost Recorder";
const BOT_NAME = rawBotName.replace(/^["'\[\(\{]+|["'\]\)\}]+$/g, '');

const browser = await puppeteer.launch({
  headless: isHeadless,
  userDataDir: userDataDir,
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false,
  defaultViewport: { width: 1280, height: 720 },
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--disable-features=WebRtcHideLocalIpsWithMdns,ExternalProtocolDialog",
    "--disable-infobars",
    "--disable-external-intent-requests",
    "--disable-popup-blocking",
    "--no-default-browser-check"
  ],
});

const page = await browser.newPage();

await page.setUserAgent(
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
);

// Функция для получения чанков аудио из браузера (микс)
await page.exposeFunction("__saveAudioChunk", (base64data) => {
  const buffer = Buffer.from(base64data, "base64");
  appendFileSync(outputPath, buffer);
});

// Сохранение чанков для конкретного трека
await page.exposeFunction("__saveTrackChunk", (trackId, base64data) => {
  const buffer = Buffer.from(base64data, "base64");
  const trackPath = resolve(tracksDir, `${trackId}.webm`);
  if (!existsSync(trackPath)) {
    writeFileSync(trackPath, "");
    try { chmodSync(trackPath, 0o666); } catch(e) {}
  }
  appendFileSync(trackPath, buffer);
});

// Запись события (например, речь)
await page.exposeFunction("__logTrackEvent", (eventObj) => {
  const eventLine = JSON.stringify(eventObj) + "\n";
  appendFileSync(resolve(metaDir, "track_events.ndjson"), eventLine);
});

// Сохранение summary при закрытии
await page.exposeFunction("__saveTracksSummary", (summaryObj) => {
  const summaryPath = resolve(metaDir, "tracks_summary.json");
  writeFileSync(summaryPath, JSON.stringify(summaryObj, null, 2));
});

// МОНКИ-ПАТЧИНГ WebRTC (Dual-Output: микс + отдельные треки + AnalyserNode)
await page.evaluateOnNewDocument(() => {
  const originalRTCPeerConnection = window.RTCPeerConnection;
  const allRemoteTracks = [];
  const activeRecorders = new Map(); // track.id -> MediaRecorder
  const trackMetadata = new Map(); // track.id -> resolved participant metadata
  const meetingClock = {
    wallStartMs: null,
    monoStartMs: null,
    lastMs: 0,
    isStarted() {
      return this.monoStartMs !== null;
    },
    start(inputMonoMs = performance.now(), inputWallMs = Date.now()) {
      if (this.monoStartMs === null) {
        this.monoStartMs = inputMonoMs;
        this.wallStartMs = inputWallMs;
      }
      return 0;
    },
    relative(inputMonoMs = performance.now()) {
      if (this.monoStartMs === null) return 0;
      return Math.max(0, Math.round(inputMonoMs - this.monoStartMs));
    },
    now(inputMonoMs = performance.now()) {
      if (this.monoStartMs === null) this.start(inputMonoMs);
      const raw = this.relative(inputMonoMs);
      this.lastMs = Math.max(this.lastMs, raw);
      return this.lastMs;
    },
    isoAt(relativeMs = this.lastMs) {
      const wallStartMs = this.wallStartMs === null ? Date.now() : this.wallStartMs;
      return new Date(wallStartMs + Math.max(0, relativeMs)).toISOString();
    }
  };
  let mixRecorderStarted = false;
  let mixAudioContext = null;
  let mixDestination = null;
  let mixRecorder = null;

  window.RTCPeerConnection = function (...args) {
    const peerConnection = new originalRTCPeerConnection(...args);

    peerConnection.addEventListener("track", (event) => {
      if (event.track.kind === "audio") {
        console.log("[recorder-inject] Получен аудио-трек:", event.track.id);
        allRemoteTracks.push(event.track);

        // 1. Обновляем микс
        tryStartMixRecorder();
        
        // 2. Запускаем индивидуальный трекинг
        startTrackRecording(event.track, event);
      }
    });

    return peerConnection;
  };

  window.RTCPeerConnection.prototype = originalRTCPeerConnection.prototype;
  Object.keys(originalRTCPeerConnection).forEach((key) => {
    window.RTCPeerConnection[key] = originalRTCPeerConnection[key];
  });

  function cleanText(value) {
    if (typeof value !== "string") return null;
    const cleaned = value.replace(/\s+/g, " ").trim();
    return cleaned || null;
  }

  function safeMetadata(candidate = {}) {
    const displayName = cleanText(candidate.displayName || candidate.name || candidate.title || candidate.label);
    const participantId = cleanText(candidate.participantId || candidate.userId || candidate.peerId);
    const confidence = typeof candidate.confidence === "number"
      ? Math.max(0, Math.min(1, candidate.confidence))
      : (displayName || participantId ? 0.5 : 0);
    return {
      participantId: participantId || null,
      displayName: displayName || null,
      speakerName: displayName || "unknown",
      provenance: candidate.provenance || (displayName || participantId ? "metadata" : "fallback:unknown"),
      confidence
    };
  }

  function collectParticipantSnapshots() {
    const snapshots = [];
    const nodes = [...document.querySelectorAll("[data-participant-id], [data-user-id], [data-peer-id], [data-track-id], [data-stream-id], [aria-label], [title]")];
    for (const node of nodes) {
      const dataset = node.dataset || {};
      const participantId = dataset.participantId || dataset.userId || dataset.peerId || dataset.memberId || null;
      const trackId = dataset.trackId || dataset.mediaTrackId || null;
      const streamId = dataset.streamId || dataset.mediaStreamId || null;
      const displayName = dataset.displayName || dataset.name || node.getAttribute("aria-label") || node.getAttribute("title") || null;
      if (participantId || trackId || streamId) {
        snapshots.push({
          participantId,
          trackId,
          streamId,
          displayName,
          provenance: "dom:data-attributes",
          confidence: trackId || streamId ? 0.85 : 0.35
        });
      }
    }
    return snapshots;
  }

  function resolveTrackMetadata(track, event) {
    const streamIds = (event?.streams || []).map(s => s && s.id).filter(Boolean);
    const snapshots = collectParticipantSnapshots();
    const exact = snapshots.find(snapshot => {
      const ids = [snapshot.trackId, snapshot.streamId].filter(Boolean);
      return ids.includes(track.id) || streamIds.some(id => ids.includes(id));
    });
    if (exact) {
      return safeMetadata({
        ...exact,
        provenance: `${exact.provenance}:exact-track-or-stream-match`,
        confidence: Math.max(exact.confidence || 0, 0.9)
      });
    }

    // Cycle 1 intentionally does not guess from DOM order or participant list order.
    // If Telemost does not expose an exact track/stream participant key, keep unknown.
    return safeMetadata({
      provenance: "fallback:unknown:no-safe-track-participant-match",
      confidence: 0
    });
  }

  function metadataForTrack(track) {
    return trackMetadata.get(track.id) || safeMetadata({ provenance: "fallback:unknown:track-not-registered", confidence: 0 });
  }

  function getSpeakerName(track) {
    return metadataForTrack(track).speakerName;
  }

  function startTrackRecording(track, event) {
    if (activeRecorders.has(track.id)) return;

    const metadata = resolveTrackMetadata(track, event);
    trackMetadata.set(track.id, metadata);
    // The track that starts the mixed recorder arrived just before the origin existed.
    // Pin that initial track-added event to exact audio-relative zero; later tracks use
    // the same origin and monotonic clock.
    const addedMs = activeRecorders.size === 0 && meetingClock.isStarted()
      ? meetingClock.now(meetingClock.monoStartMs)
      : meetingClock.now();
    window.__logTrackEvent({
      ts: meetingClock.isoAt(addedMs),
      t_ms: addedMs,
      meeting_relative_ms: addedMs,
      type: "track-added",
      trackId: track.id,
      speakerName: metadata.speakerName,
      participantId: metadata.participantId,
      displayName: metadata.displayName,
      provenance: metadata.provenance,
      confidence: metadata.confidence,
      streamIds: (event?.streams || []).map(s => s && s.id).filter(Boolean),
      kind: track.kind,
      label: track.label,
      muted: track.muted,
      readyState: track.readyState
    });

    const stream = new MediaStream([track]);
    
    // Рекордер для отдельного трека
    const recorder = new MediaRecorder(stream, {
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 32000,
    });

    recorder.ondataavailable = async (event) => {
      if (event.data.size > 0) {
        const arrayBuffer = await event.data.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
        window.__saveTrackChunk(track.id, base64);
      }
    };

    recorder.start(2000);
    
    // Анализатор амплитуды для VAD (Voice Activity Detection)
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const dataArray = new Float32Array(analyser.fftSize);
    let speaking = false;
    let speakingStartMonoMs = 0;
    let maxAmplitude = 0;
    
    const intervalId = setInterval(() => {
      analyser.getFloatTimeDomainData(dataArray);
      let peak = 0;
      for (let i = 0; i < dataArray.length; i++) {
        if (Math.abs(dataArray[i]) > peak) peak = Math.abs(dataArray[i]);
      }
      
      const threshold = 0.005; 
      
      if (peak > threshold) {
        if (!speaking) {
          speaking = true;
          speakingStartMonoMs = performance.now();
          maxAmplitude = peak;
        } else {
          if (peak > maxAmplitude) maxAmplitude = peak;
        }
      } else {
        if (speaking) {
          speaking = false;
          const endMonoMs = performance.now();
          const duration = endMonoMs - speakingStartMonoMs;
          if (duration > 300) { 
            const segmentMetadata = metadataForTrack(track);
            const startMs = meetingClock.relative(speakingStartMonoMs);
            const endMs = Math.max(startMs, meetingClock.now(endMonoMs));
            window.__logTrackEvent({
              ts: meetingClock.isoAt(endMs),
              t_ms: endMs,
              meeting_relative_ms: endMs,
              type: "speech-segment",
              trackId: track.id,
              speakerName: segmentMetadata.speakerName,
              participantId: segmentMetadata.participantId,
              displayName: segmentMetadata.displayName,
              provenance: segmentMetadata.provenance,
              confidence: segmentMetadata.confidence,
              start_ms: startMs,
              end_ms: endMs,
              amplitude_peak: parseFloat(maxAmplitude.toFixed(4))
            });
          }
        }
      }
    }, 100);

    activeRecorders.set(track.id, {
      recorder,
      audioContext,
      intervalId,
      track
    });
    
    console.log(`[recorder-inject] Начата запись трека ${track.id}`);
  }

  function tryStartMixRecorder() {
    if (!mixAudioContext) {
      mixAudioContext = new AudioContext();
      mixDestination = mixAudioContext.createMediaStreamDestination();
    }

    // Подключаем только новые треки
    const newTracks = allRemoteTracks.filter(t => !t._mixed);
    for (const track of newTracks) {
      const stream = new MediaStream([track]);
      const source = mixAudioContext.createMediaStreamSource(stream);
      source.connect(mixDestination);
      track._mixed = true;
    }

    if (!mixRecorderStarted && allRemoteTracks.length > 0) {
      mixRecorderStarted = true;
      // The mixed WebM starts here; all ASR offsets and VAD/track events must use this
      // audio-relative origin, not the earlier page-load/injection time.
      meetingClock.start(performance.now(), Date.now());
      mixRecorder = new MediaRecorder(mixDestination.stream, {
        mimeType: "audio/webm;codecs=opus",
        audioBitsPerSecond: 32000,
      });

      mixRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          const arrayBuffer = await event.data.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
          window.__saveAudioChunk(base64);
        }
      };

      mixRecorder.start(2000);
      console.log("[recorder-inject] Mix MediaRecorder запущен");
    }
  }

  window.__stopRecorder = () => {
    // 1. Остановка микса
    if (mixRecorder && mixRecorder.state !== "inactive") {
      mixRecorder.stop();
    }
    if (mixAudioContext) mixAudioContext.close();

    // 2. Остановка отдельных треков
    const summary = {
      tracks: []
    };

    for (const [trackId, data] of activeRecorders.entries()) {
      clearInterval(data.intervalId);
      if (data.recorder.state !== "inactive") {
        data.recorder.stop();
      }
      data.audioContext.close();
      const metadata = metadataForTrack(data.track);
      summary.tracks.push({
        trackId: trackId,
        label: data.track.label,
        speakerName: metadata.speakerName,
        participantId: metadata.participantId,
        displayName: metadata.displayName,
        provenance: metadata.provenance,
        confidence: metadata.confidence
      });
    }

    window.__saveTracksSummary(summary);
    console.log("[recorder-inject] Все MediaRecorder остановлены, summary сохранен");
  };
});

// ПЕРЕХОД ПО ССЫЛКЕ
try {
  // --- ПЕРЕХОД ПО ССЫЛКЕ ---
  if (isCreateMode) {
    await page.goto("https://telemost.yandex.ru/", { waitUntil: "networkidle2" });
    console.log("[recorder] Зашли на главную для создания встречи...");
    
    // Ищем кнопку "Создать встречу"
    const buttonSelector = 'button[class*="CreateCallButton"]';
    await page.waitForSelector(buttonSelector, { timeout: 10000 });
    await page.click(buttonSelector);

    console.log("[recorder] Ожидание генерации ссылки...");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 });
    const newUrl = page.url();
    console.log(`[SUCCESS_JOIN_URL] ${newUrl}`);
    await browser.close();
    process.exit(0);
  }

  // ОБРАБОТКА СИГНАЛОВ (для предотвращения зомби)
  const signals = ["SIGINT", "SIGTERM"];
  signals.forEach((signal) => {
    process.on(signal, async () => {
      console.log(`[system] Получен сигнал ${signal}. Начинаем экстренное сохранение...`);
      await gracefulShutdown();
    });
  });

  await page.goto(joinUrl, { waitUntil: "networkidle2", timeout: 45000 });
  console.log("[recorder] Страница загружена");

  // ЛОГИКА ВХОДА (улучшенная)
  await new Promise(r => setTimeout(r, 8000));

  // 1. ПРОВЕРКА КНОПКИ "ПРОДОЛЖИТЬ В БРАУЗЕРЕ"
  try {
    const continueBtn = await page.evaluateHandle(() => {
      const buttons = [...document.querySelectorAll("button, [role='button'], a")];
      return buttons.find((b) => /продолжить в браузере|continue in browser/i.test(b.textContent));
    });
    if (continueBtn && continueBtn.asElement()) {
      await page.evaluate((el) => el.click(), continueBtn);
      console.log("[recorder] Нажато: Продолжить в браузере");
      await new Promise(r => setTimeout(r, 5000));
    }
  } catch (e) {}

  // 2. Ищем поле ввода имени
  const nameInput = await page.evaluateHandle(() => {
    const labels = [...document.querySelectorAll('div, span, p')];
    const nameLabel = labels.find(el => el.textContent.includes('Ваше имя на встрече'));
    if (nameLabel && nameLabel.parentElement) {
      return nameLabel.parentElement.querySelector('input, [contenteditable="true"]');
    }
    return document.querySelector('input[placeholder*="имя"], .name-input input');
  });

  if (nameInput && nameInput.asElement()) {
    await page.evaluate((input, name) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      nativeSetter.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, nameInput.asElement(), BOT_NAME);
    console.log(`[recorder] Имя "${BOT_NAME}" установлено.`);
    await new Promise(r => setTimeout(r, 1000));
  }

  // 3. Выключаем мик и камеру перед входом
  await page.evaluate(() => {
    const mic = document.querySelector('[data-testid="turn-off-mic-button"]');
    if (mic) mic.click();
    const cam = document.querySelector('[data-testid="turn-off-camera-button"]');
    if (cam) cam.click();
  });

  // 4. Кнопка "Присоединиться"
  const joinBtn = await page.evaluateHandle(() => {
    const buttons = [...document.querySelectorAll("button, [role='button']")];
    return buttons.find((b) => /подключиться|присоединиться|join/i.test(b.textContent));
  });

  if (joinBtn && joinBtn.asElement()) {
    await page.evaluate((el) => el.click(), joinBtn);
    console.log("[recorder] Кнопка входа нажата!");
  }

  // --- МОНИТОР ПРИСУТСТВИЯ ---
  const MAX_IDLE_MINS = parseInt(process.env.MAX_IDLE_MINS || "2");
  const MAX_DURATION_MINS = parseInt(process.env.MAX_DURATION_MINS || "180");
  let idleSeconds = 0;
  let totalSeconds = 0;

  console.log(`[monitor] Лимиты: Ожидание ${MAX_IDLE_MINS}м, Макс. запись ${MAX_DURATION_MINS}м`);

  while (totalSeconds < MAX_DURATION_MINS * 60) {
    await new Promise(r => setTimeout(r, 10000));
    totalSeconds += 10;

    try {
      const count = await page.evaluate(() => {
          const btn = document.querySelector('[data-testid="participants-button"]');
          if (btn) {
              const m = btn.innerText.match(/(\d+)/);
              if (m) return parseInt(m[1]);
          }
          return document.querySelectorAll('[class*="ParticipantItem"]').length || 1;
      });

      if (count <= 1) {
          idleSeconds += 10;
          if (idleSeconds >= MAX_IDLE_MINS * 60) {
              console.log("[monitor] Бот один в комнате слишком долго. Выходим.");
              break;
          }
      } else {
          idleSeconds = 0;
      }
      
      // Check for stop lock file
      const lockFile = resolve(`stop_${meetingIdStr}`);
      if (fs.existsSync(lockFile)) {
          console.log("[monitor] Найден файл остановки. Завершаем...");
          fs.unlinkSync(lockFile);
          break;
      }
      
      const isMeetingEnded = await page.evaluate(() => {
          return document.body.innerText.includes("Встреча завершена") || 
                 document.body.innerText.includes("Оцените качество") ||
                 !window.location.href.includes("/j/");
      });

      if (isMeetingEnded) {
          console.log("[monitor] Встреча завершена организатором. Выходим.");
          break;
      }
      
    } catch (e) {
      console.error("[monitor] Ошибка проверки участников:", e.message);
      // Если контекст уничтожен (страница закрылась/редирект), выходим
      if (e.message.includes("Execution context was destroyed") || e.message.includes("Session closed")) {
          console.log("[monitor] Страница закрыта или перенаправлена. Выходим.");
          break;
      }
    }
  }

  await gracefulShutdown();

} catch (error) {
  console.error("[error] Критическая ошибка рекордера:", error.message);
} finally {
  console.log("[system] Финальное закрытие браузера...");
  if (browser) await browser.close();
  try {
      if (fs.existsSync(userDataDir)) {
          fs.rmSync(userDataDir, { recursive: true, force: true });
          console.log("[system] Временная папка профиля удалена.");
      }
  } catch(e) {
      console.error("[error] Ошибка удаления userDataDir:", e.message);
  }
  process.exit(0);
}

// ФУНКЦИЯ ДЛЯ ЧИСТОЙ ОСТАНОВКИ
async function gracefulShutdown() {
    console.log("[recorder] Завершение записи и сохранение файлов...");
    try {
        await page.evaluate(() => {
            if (window.__stopRecorder) window.__stopRecorder();
        });
        
        console.log("[recorder] Нажимаем кнопку 'Покинуть встречу'...");
        await page.evaluate(() => {
            const leaveSelectors = [
                '[data-testid="leave-call-button"]', 
                'button[class*="LeaveButton"]', 
                'button[aria-label*="Покинуть"]', 
                'button[aria-label*="Завершить"]',
                'button[data-tooltip*="Покинуть"]'
            ];
            for (const selector of leaveSelectors) {
                const btn = document.querySelector(selector);
                if (btn) {
                    btn.click();
                    break;
                }
            }
        });
        
        await new Promise(r => setTimeout(r, 3000)); 
    } catch (e) {
        console.error("[recorder] Ошибка при graceful shutdown:", e.message);
    }
    if (browser) await browser.close();
    console.log("[recorder] Браузер закрыт штатно.");
    process.exit(0);
}

