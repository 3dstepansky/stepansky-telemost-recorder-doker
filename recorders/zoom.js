/**
 * recorders/zoom.js
 * Драйвер видеовстреч Zoom через Zoom Web Client (zoom.us/wc/join/...)
 */

import { BaseMeetingRecorder } from './base.js';
import { detectPlatform } from '../services/platform-detector.js';

export class ZoomRecorder extends BaseMeetingRecorder {
  getPlatformName() {
    return 'zoom';
  }

  async joinAndRecord() {
    await this.initBrowser();

    // Преобразуем ссылку в Zoom Web Client формат
    const detected = detectPlatform(this.joinUrl);
    const webClientUrl = detected.normalizedUrl || this.joinUrl;

    console.log(`[zoom] Переход по веб-ссылке встречи: ${webClientUrl}`);
    await this.page.goto(webClientUrl, { waitUntil: 'networkidle2', timeout: 50000 });
    console.log('[zoom] Страница веб-клиента Zoom загружена...');

    await new Promise(r => setTimeout(r, 6000));

    // 1. Согласие с куки / условиями, если есть
    try {
      await this.page.evaluate(() => {
        const acceptBtns = [...document.querySelectorAll('button, #onetrust-accept-btn-handler')];
        const btn = acceptBtns.find(b => /accept|agree|принять|согласен/i.test(b.innerText || ''));
        if (btn) btn.click();
      });
    } catch (e) {}

    // 2. Ввод имени в Zoom Web Client
    try {
      const nameInput = await this.page.evaluateHandle(() => {
        return document.querySelector('input#inputname, input[name="inputname"], input[placeholder*="name"], input[placeholder*="имя"]');
      });

      if (nameInput && nameInput.asElement()) {
        await this.page.evaluate((input, name) => {
          input.value = name;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }, nameInput, this.botName);
        console.log(`[zoom] Имя бота установлено: "${this.botName}"`);
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {}

    // 3. Нажатие кнопки "Войти" (Join)
    try {
      const joinBtn = await this.page.evaluateHandle(() => {
        return document.querySelector('button#joinBtn, button.preview-join-button, button[type="submit"]');
      });

      if (joinBtn && joinBtn.asElement()) {
        await this.page.evaluate((el) => el.click(), joinBtn);
        console.log('[zoom] Нажата кнопка входа в Zoom');
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e) {}

    // 4. Подключение аудио через компьютер (Join Audio by Computer)
    try {
      await this.page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        const joinAudioBtn = buttons.find(b => /join audio by computer|войти с использованием звука компьютера|join audio/i.test(b.innerText || ''));
        if (joinAudioBtn) joinAudioBtn.click();
      });
      console.log('[zoom] Запрошено подключение компьютерного звука');
    } catch (e) {}

    console.log('[zoom] ✅ Бот подключен к встрече Zoom. Запись активна.');
    await this.setupWatchdog();
  }

  async setupWatchdog() {
    const checkInterval = 10000;
    const maxIdleMs = this.maxIdleMins * 60 * 1000;
    const maxDurationMs = this.maxDurationMins * 60 * 1000;
    const startTime = Date.now();
    let lastActiveTime = Date.now();

    const interval = setInterval(async () => {
      if (this.isShuttingDown) {
        clearInterval(interval);
        return;
      }

      if (Date.now() - startTime > maxDurationMs) {
        console.log('[zoom-watchdog] Превышена максимальная длительность. Завершаем.');
        clearInterval(interval);
        await this.stop();
        return;
      }

      try {
        const status = await this.page.evaluate(() => {
          const bodyText = document.body ? document.body.innerText : '';
          const isEnded = /meeting has ended|встреча завершена|the host has ended/i.test(bodyText);
          const hasMedia = document.querySelectorAll('video, audio').length > 0;
          return { isEnded, hasMedia };
        });

        if (status.isEnded) {
          console.log('[zoom-watchdog] Обнаружен выход из встречи Zoom.');
          clearInterval(interval);
          await this.stop();
          return;
        }

        if (status.hasMedia) {
          lastActiveTime = Date.now();
        } else if (Date.now() - lastActiveTime > maxIdleMs) {
          console.log('[zoom-watchdog] Не обнаружено активных участников (idle timeout).');
          clearInterval(interval);
          await this.stop();
        }
      } catch (e) {
        clearInterval(interval);
      }
    }, checkInterval);
  }
}
