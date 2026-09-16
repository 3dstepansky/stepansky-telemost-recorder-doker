/**
 * recorders/telemost.js
 * Драйвер видеовстреч Яндекс.Телемост
 */

import { BaseMeetingRecorder } from './base.js';

export class TelemostRecorder extends BaseMeetingRecorder {
  getPlatformName() {
    return 'telemost';
  }

  async joinAndRecord() {
    await this.initBrowser();

    console.log(`[telemost] Переход по ссылке встречи: ${this.joinUrl}`);
    await this.page.goto(this.joinUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    console.log('[telemost] Страница загружена, ожидаем инициализацию UI...');

    await new Promise(r => setTimeout(r, 6000));

    // 1. Проверка кнопки "Продолжить в браузере"
    try {
      const continueBtn = await this.page.evaluateHandle(() => {
        const buttons = [...document.querySelectorAll("button, [role='button'], a")];
        return buttons.find((b) => /продолжить в браузере|continue in browser/i.test(b.textContent));
      });
      if (continueBtn && continueBtn.asElement()) {
        await this.page.evaluate((el) => el.click(), continueBtn);
        console.log('[telemost] Нажато: Продолжить в браузере');
        await new Promise(r => setTimeout(r, 4000));
      }
    } catch (e) {}

    // 2. Ввод имени бота
    const nameInput = await this.page.evaluateHandle(() => {
      const labels = [...document.querySelectorAll('div, span, p')];
      const nameLabel = labels.find(el => el.textContent && el.textContent.includes('Ваше имя на встрече'));
      if (nameLabel && nameLabel.parentElement) {
        return nameLabel.parentElement.querySelector('input, [contenteditable="true"]');
      }
      return document.querySelector('input[placeholder*="имя"], .name-input input');
    });

    if (nameInput && nameInput.asElement()) {
      await this.page.evaluate((input, name) => {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(input, name);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, nameInput, this.botName);
      console.log(`[telemost] Имя бота установлено: "${this.botName}"`);
      await new Promise(r => setTimeout(r, 1000));
    }

    // 3. Нажатие кнопки входа
    const joinBtn = await this.page.evaluateHandle(() => {
      const buttons = [...document.querySelectorAll("button, [role='button']")];
      return buttons.find((b) => /подключиться|войти|join/i.test(b.textContent));
    });

    if (joinBtn && joinBtn.asElement()) {
      await this.page.evaluate((el) => el.click(), joinBtn);
      console.log('[telemost] Нажата кнопка подключения');
    }

    console.log('[telemost] ✅ Бот успешно подключен к встрече Телемоста. Запись активна.');
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

      // Проверка максимальной длительности
      if (Date.now() - startTime > maxDurationMs) {
        console.log('[telemost-watchdog] Превышена максимальная длительность встречи. Завершаем.');
        clearInterval(interval);
        await this.stop();
        return;
      }

      try {
        // Проверка завершения встречи / наличия участников
        const status = await this.page.evaluate(() => {
          const bodyText = document.body ? document.body.innerText : '';
          const isEnded = /встреча завершена|meeting ended|вы покинули встречу/i.test(bodyText);
          const hasVideoOrAudio = document.querySelectorAll('video, audio').length > 0;
          return { isEnded, hasMedia: hasVideoOrAudio };
        });

        if (status.isEnded) {
          console.log('[telemost-watchdog] Обнаружен экран завершения встречи.');
          clearInterval(interval);
          await this.stop();
          return;
        }

        if (status.hasMedia) {
          lastActiveTime = Date.now();
        } else if (Date.now() - lastActiveTime > maxIdleMs) {
          console.log('[telemost-watchdog] Не обнаружено активных участников (idle timeout).');
          clearInterval(interval);
          await this.stop();
        }
      } catch (e) {
        // Страница закрыта
        clearInterval(interval);
      }
    }, checkInterval);
  }
}
