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
} from "fs";
import { resolve, dirname } from "path";
import { tmpdir } from "os";
import dotenv from "dotenv";

dotenv.config();

const joinUrl = process.argv[2];
const isCreateMode = joinUrl === '--create';
const outputFile = isCreateMode ? null : process.argv[3];
const isHeadless = process.env.HEADLESS !== "false";

if (!joinUrl || (!isCreateMode && !outputFile)) {
  console.error("Использование: node recorder.js <join_url> <output_file> ИЛИ node recorder.js --create");
  process.exit(1);
}

let outputPath;
if (!isCreateMode) {
  outputPath = resolve(outputFile);
  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  // Очистка старого файла
  writeFileSync(outputPath, "");
  console.log(`[recorder] join_url: ${joinUrl}`);
  console.log(`[recorder] output:   ${outputPath}`);
} else {
  console.log(`[recorder] Режим создания новой встречи активен.`);
}

const BOT_NAME = process.env.BOT_DISPLAY_NAME || "Telemost Recorder";

const browser = await puppeteer.launch({
  headless: isHeadless,
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

// Функция для получения чанков аудио из браузера
await page.exposeFunction("__saveAudioChunk", (base64data) => {
  const buffer = Buffer.from(base64data, "base64");
  appendFileSync(outputPath, buffer);
});

// МОНКИ-ПАТЧИНГ WebRTC (Ядро из 3dstepansky)
await page.evaluateOnNewDocument(() => {
  const originalRTCPeerConnection = window.RTCPeerConnection;
  const allRemoteTracks = [];
  let recorderStarted = false;

  window.RTCPeerConnection = function (...args) {
    const peerConnection = new originalRTCPeerConnection(...args);

    peerConnection.addEventListener("track", (event) => {
      if (event.track.kind === "audio") {
        console.log("[recorder-inject] Получен аудио-трек:", event.track.id);
        allRemoteTracks.push(event.track);
        tryStartRecorder();
      }
    });

    return peerConnection;
  };

  window.RTCPeerConnection.prototype = originalRTCPeerConnection.prototype;
  Object.keys(originalRTCPeerConnection).forEach((key) => {
    window.RTCPeerConnection[key] = originalRTCPeerConnection[key];
  });

  function tryStartRecorder() {
    if (recorderStarted || allRemoteTracks.length === 0) return;
    recorderStarted = true;

    const audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();

    for (const track of allRemoteTracks) {
      const stream = new MediaStream([track]);
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(destination);
    }

    const recorder = new MediaRecorder(destination.stream, {
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 32000,
    });

    recorder.ondataavailable = async (event) => {
      if (event.data.size > 0) {
        const arrayBuffer = await event.data.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
        window.__saveAudioChunk(base64);
      }
    };

    recorder.start(2000); // Чанки по 2 сек
    console.log("[recorder-inject] MediaRecorder запущен");

    window.__stopRecorder = () => {
      recorder.stop();
      audioContext.close();
      console.log("[recorder-inject] MediaRecorder остановлен");
    };
  }
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
  const MAX_IDLE_MINS = parseInt(process.env.MAX_IDLE_MINS || "3");
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
    } catch (e) {
      console.error("[monitor] Ошибка проверки участников:", e.message);
    }
  }

  await gracefulShutdown();

} catch (error) {
  console.error("[error] Критическая ошибка рекордера:", error.message);
} finally {
  console.log("[system] Финальное закрытие браузера...");
  if (browser) await browser.close();
  process.exit(0);
}

// ФУНКЦИЯ ДЛЯ ЧИСТОЙ ОСТАНОВКИ
async function gracefulShutdown() {
    console.log("[recorder] Завершение записи и сохранение файлов...");
    try {
        await page.evaluate(() => {
            if (window.__stopRecorder) window.__stopRecorder();
        });
        await new Promise(r => setTimeout(r, 3000)); 
    } catch (e) {}
    if (browser) await browser.close();
    console.log("[recorder] Браузер закрыт штатно.");
    process.exit(0);
}

