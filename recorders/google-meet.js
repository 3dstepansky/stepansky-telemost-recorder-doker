/**
 * recorders/google-meet.js
 * Драйвер видеовстреч Google Meet (meet.google.com)
 */

import { BaseMeetingRecorder } from './base.js';

export class GoogleMeetRecorder extends BaseMeetingRecorder {
  getPlatformName() {
    return 'google-meet';
  }

  async joinAndRecord() {
    // Для Google Meet нужны расширенные флаги для медиа и гостевого доступа
    await this.initBrowser([
      '--use-fake-device-for-media-stream',
      '--disable-notifications'
    ]);

    console.log(`[google-meet] Переход по ссылке встречи: ${this.joinUrl}`);
    await this.page.goto(this.joinUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    console.log('[google-meet] Страница загружена, настраиваем вход...');

    await new Promise(r => setTimeout(r, 6000));

    // 1. Отключаем микрофон и камеру перед входом (если включены)
    try {
      await this.page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"]')];
        // Ищем кнопки выключения микрофона и камеры по aria-label или подсказкам
        const micBtn = buttons.find(b => /выключить микрофон|turn off microphone|mute mic/i.test(b.getAttribute('aria-label') || b.innerText));
        const camBtn = buttons.find(b => /выключить камеру|turn off camera|turn off video/i.test(b.getAttribute('aria-label') || b.innerText));
        if (micBtn) micBtn.click();
        if (camBtn) camBtn.click();
      });
      console.log('[google-meet] Микрофон и камера заглушены');
    } catch (e) {}

    // 2. Ввод имени в гостевом режиме
    try {
      const nameInput = await this.page.evaluateHandle(() => {
        const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')];
        return inputs.find(inp => /ваше имя|your name|name/i.test(inp.getAttribute('aria-label') || inp.placeholder || ''));
      });

      if (nameInput && nameInput.asElement()) {
        await this.page.evaluate((input, name) => {
          input.value = name;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }, nameInput, this.botName);
        console.log(`[google-meet] Имя бота установлено: "${this.botName}"`);
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {}

    // 3. Нажатие кнопки "Присоединиться" / "Попросить присоединиться"
    try {
      const joinBtn = await this.page.evaluateHandle(() => {
        const buttons = [...document.querySelectorAll('button, [role="button"], span')];
        return buttons.find(b => /присоединиться|попросить войти|ask to join|join now/i.test(b.innerText || b.getAttribute('aria-label') || ''));
      });

      if (joinBtn && joinBtn.asElement()) {
        await this.page.evaluate((el) => el.click(), joinBtn);
        console.log('[google-meet] Нажата кнопка входа в Google Meet');
      }
    } catch (e) {}

    console.log('[google-meet] ✅ Бот подключен к встрече Google Meet. Запись активна.');
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
        console.log('[google-meet-watchdog] Превышена максимальная длительность. Завершаем.');
        clearInterval(interval);
        await this.stop();
        return;
      }

      try {
        const status = await this.page.evaluate(() => {
          const bodyText = document.body ? document.body.innerText : '';
          const isEnded = /встреча закончилась|you left the meeting|звонок завершен/i.test(bodyText);
          const hasMedia = document.querySelectorAll('video, audio').length > 0;
          return { isEnded, hasMedia };
        });

        if (status.isEnded) {
          console.log('[google-meet-watchdog] Обнаружен выход из встречи Google Meet.');
          clearInterval(interval);
          await this.stop();
          return;
        }

        if (status.hasMedia) {
          lastActiveTime = Date.now();
        } else if (Date.now() - lastActiveTime > maxIdleMs) {
          console.log('[google-meet-watchdog] Не обнаружено активных участников (idle timeout).');
          clearInterval(interval);
          await this.stop();
        }
      } catch (e) {
        clearInterval(interval);
      }
    }, checkInterval);
  }
}
