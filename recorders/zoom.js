/**
 * Zoom Web Client recorder.
 *
 * A join is only successful after the real in-meeting controls appear. The
 * pre-join screen also contains audio/video controls, so those alone are not
 * sufficient proof.
 */

import { BaseMeetingRecorder } from './base.js';
import { detectPlatform } from '../services/platform-detector.js';

const NAME_INPUT_SELECTORS = [
  '#input-for-name',
  'input#inputname',
  'input[name="inputname"]',
  'input[placeholder*="name" i]',
  'input[placeholder*="имя" i]',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function selectZoomNameInput(documentRef = document) {
  for (const selector of NAME_INPUT_SELECTORS) {
    const input = documentRef.querySelector(selector);
    if (input) return input;
  }
  return null;
}

export function inspectZoomUiState({ url = '', bodyText = '', buttons = [], hasNameInput = false } = {}) {
  const normalizedButtons = buttons.map((value) => String(value || '').trim()).filter(Boolean);
  return { url, bodyText: String(bodyText || ''), buttons: normalizedButtons, hasNameInput: Boolean(hasNameInput) };
}

export function isZoomWaitingRoom(state) {
  return /host will let you in|meeting host will let you in|waiting room|организатор.*впуст|ожидайте.*организатор/i.test(state.bodyText);
}

export function isZoomMeetingJoined(state) {
  if (state.hasNameInput || isZoomWaitingRoom(state)) return false;
  const controls = `${state.bodyText}\n${state.buttons.join('\n')}`;
  const hasLeave = /(^|\n|\s)(leave|покинуть)(\s|$|\n)/i.test(controls);
  const hasParticipants = /participants|участники/i.test(controls);
  const hasMeetingToolbar = /chat|react|reactions|more|чат|реакц/i.test(controls);
  return hasLeave && hasParticipants && hasMeetingToolbar;
}

export class ZoomRecorder extends BaseMeetingRecorder {
  getPlatformName() {
    return 'zoom';
  }

  async readUiState() {
    const raw = await this.page.evaluate(() => ({
      url: location.href,
      bodyText: document.body?.innerText || '',
      buttons: [...document.querySelectorAll('button')].map((button) =>
        (button.getAttribute('aria-label') || button.innerText || '').trim()
      ),
      hasNameInput: Boolean(
        document.querySelector('#input-for-name, input#inputname, input[name="inputname"], input[placeholder*="name" i], input[placeholder*="имя" i]')
      ),
    }));
    return inspectZoomUiState(raw);
  }

  async acceptConsent() {
    await this.page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, #onetrust-accept-btn-handler')];
      const button = buttons.find((candidate) => /accept|agree|принять|согласен/i.test(candidate.innerText || ''));
      button?.click();
    }).catch(() => {});
  }

  async fillDisplayName() {
    const found = await this.page.evaluate((botName) => {
      const selectors = [
        '#input-for-name',
        'input#inputname',
        'input[name="inputname"]',
        'input[placeholder*="name" i]',
        'input[placeholder*="имя" i]',
      ];
      const input = selectors.map((selector) => document.querySelector(selector)).find(Boolean);
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, botName);
      else input.value = botName;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, this.botName);

    if (!found) throw new Error('Zoom: поле имени гостя не найдено');
    console.log(`[zoom] Имя бота установлено: ${this.botName}`);
  }

  async clickJoin() {
    const clicked = await this.page.evaluate(() => {
      const visible = (element) => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
      const buttons = [...document.querySelectorAll('button')];
      const button = buttons.find((candidate) => visible(candidate) && /^(join|подключиться|войти)$/i.test((candidate.innerText || '').trim()));
      if (!button || button.disabled) return false;
      button.click();
      return true;
    });
    if (!clicked) throw new Error('Zoom: активная кнопка Join не найдена');
    console.log('[zoom] Нажата настоящая кнопка Join на форме входа');
  }

  async waitForJoined(timeoutMs = Number(process.env.ZOOM_JOIN_TIMEOUT_MS || 180000)) {
    const startedAt = Date.now();
    let waitingLogged = false;
    while (Date.now() - startedAt < timeoutMs) {
      const state = await this.readUiState();
      if (isZoomMeetingJoined(state)) return state;
      if (isZoomWaitingRoom(state) && !waitingLogged) {
        console.log('[zoom] Бот находится в зале ожидания; ожидаем допуска организатором...');
        waitingLogged = true;
      }
      if (/meeting has ended|meeting was ended|встреча завершена|совещание завершено/i.test(state.bodyText)) {
        throw new Error('Zoom: встреча завершена до входа ассистента');
      }
      await sleep(1000);
    }
    const state = await this.readUiState();
    throw new Error(`Zoom: вход во встречу не подтверждён за ${Math.round(timeoutMs / 1000)} с (url=${state.url}, prejoin=${state.hasNameInput}, waiting=${isZoomWaitingRoom(state)})`);
  }

  async joinComputerAudio() {
    await this.page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      const button = buttons.find((candidate) => /join audio by computer|computer audio|подключ.*звук|звук компьютера/i.test(
        `${candidate.innerText || ''} ${candidate.getAttribute('aria-label') || ''}`
      ));
      button?.click();
    }).catch(() => {});
  }

  async joinAndRecord() {
    await this.initBrowser();
    const detected = detectPlatform(this.joinUrl);
    const webClientUrl = detected.normalizedUrl || this.joinUrl;

    console.log(`[zoom] Переход по веб-ссылке встречи: ${webClientUrl}`);
    await this.page.goto(webClientUrl, { waitUntil: 'networkidle2', timeout: 50000 });
    console.log('[zoom] Страница веб-клиента Zoom загружена');

    await this.page.waitForSelector('#input-for-name, input#inputname, input[name="inputname"]', { timeout: 30000 });
    await this.acceptConsent();
    await this.fillDisplayName();
    await this.clickJoin();

    await this.waitForJoined();
    await this.joinComputerAudio();
    await sleep(1500);

    const verified = await this.readUiState();
    if (!isZoomMeetingJoined(verified)) {
      throw new Error('Zoom: экран встречи исчез после попытки подключения звука');
    }

    console.log('[zoom] ✅ Вход подтверждён по экрану встречи (Leave + Participants + toolbar). Запись активна.');
    await this.startMonitor();
    return this;
  }
}
