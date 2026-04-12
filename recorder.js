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
const outputFile = process.argv[3];
const isHeadless = process.env.HEADLESS !== "false"; // По умолчанию в Docker используем headless

if (!joinUrl || !outputFile) {
  console.error("Использование: node recorder.js <join_url> <output_file>");
  process.exit(1);
}

const outputPath = resolve(outputFile);
const outputDir = dirname(outputPath);
if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
}

console.log(`[recorder] join_url: ${joinUrl}`);
console.log(`[recorder] output:   ${outputPath}`);

// Очистка старого файла
writeFileSync(outputPath, "");

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
    await page.goto(joinUrl, { waitUntil: "networkidle2", timeout: 45000 });
    console.log("[recorder] Страница загружена");
} catch (e) {
    console.error("[recorder] Ошибка загрузки:", e.message);
}

// ЛОГИКА ВХОДА ГАСТЕМ
await new Promise(r => setTimeout(r, 8000)); // Даем время на редиректы

// 1. ПРОВЕРКА КНОПКИ "ПРОДОЛЖИТЬ В БРАУЗЕРЕ"
try {
    const continueInBrowser = await page.evaluateHandle(() => {
        const buttons = [...document.querySelectorAll("button, [role='button'], a")];
        return buttons.find((b) => /продолжить в браузере|continue in browser/i.test(b.textContent));
    });

    if (continueInBrowser && continueInBrowser.asElement()) {
        await page.evaluate((el) => el.click(), continueInBrowser); // Принудительный клик через JS
        console.log("[recorder] Нажато (JS): Продолжить в браузере");
        await new Promise(r => setTimeout(r, 5000));
    }
} catch (e) {
    console.log("[recorder] Кнопка 'Продолжить в браузере' не найдена или не требуется");
}

// 2. Ищем поле ввода имени
const nameInput = await page.evaluateHandle(() => {
    // Ищем инпут внутри контейнера, который следует за текстом "Ваше имя на встрече"
    const labels = [...document.querySelectorAll('div, span, p')];
    const nameLabel = labels.find(el => el.textContent.includes('Ваше имя на встрече'));
    if (nameLabel && nameLabel.parentElement) {
        return nameLabel.parentElement.querySelector('input, [contenteditable="true"]');
    }
    return document.querySelector('input[placeholder*="имя"], .name-input input');
});

if (nameInput && nameInput.asElement()) {
    const el = nameInput.asElement();
    
    await page.evaluate((input, name) => {
        // Хак для обхода React/Vue сеттеров
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        nativeInputValueSetter.call(input, name);

        // Уведомляем систему, что значение изменилось
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
    }, el, BOT_NAME);
    
    console.log(`[recorder] Установлено имя через JS-инъекцию: ${BOT_NAME}`);
    await new Promise(r => setTimeout(r, 500)); // Даем Яндексу время "переварить" имя
}

// 3. ПОПЫТКА ЗАКРЫТЬ СИСТЕМНОЕ ОКНО (Escape)
await page.keyboard.press('Escape');
console.log("[recorder] Отправлен Escape для закрытия системного окна");
await new Promise(r => setTimeout(r, 2000));

// Выключаем мик и камеру перед входом
await page.evaluate(() => {
    const micBtn = document.querySelector('[data-testid="turn-off-mic-button"]');
    if (micBtn) micBtn.click();
    const camBtn = document.querySelector('[data-testid="turn-off-camera-button"]');
    if (camBtn) camBtn.click();
});

// Кнопка "Присоединиться" или "Подключиться"
const joinButton = await page.evaluateHandle(() => {
  const buttons = [...document.querySelectorAll("button, [role='button']")];
  return buttons.find((b) => /подключиться|присоединиться|join/i.test(b.textContent));
});

if (joinButton && joinButton.asElement()) {
    await page.evaluate((el) => el.click(), joinButton); // Принудительный клик через JS
    console.log("[recorder] Нажата кнопка входа (JS)");
}

console.log("[recorder] Запись активна. Ожидание...");

// ФУНКЦИЯ ДЛЯ ЧИСТОЙ ОСТАНОВКИ (Фикс повреждения файлов)
async function gracefulShutdown() {
    console.log("[recorder] Завершение записи...");
    try {
        await page.evaluate(() => {
            if (window.__stopRecorder) window.__stopRecorder();
        });
        await new Promise(r => setTimeout(r, 3000)); // Ждем финальные чанки
    } catch (e) {}
    await browser.close();
    console.log("[recorder] Браузер закрыт.");
    process.exit(0);
}

// Обработка закрытия браузера вручную
browser.on('disconnected', () => {
    console.log("[recorder] Браузер закрыт пользователем.");
    process.exit(0);
});

// Обработка Ctrl+C
process.on("SIGINT", async () => {
    await gracefulShutdown();
});

// Авто-стоп если встреча закончилась (признак - редирект на главную)
setInterval(async () => {
    try {
        const path = await page.evaluate(() => window.location.pathname);
        if (path === "/" || path === "") {
            console.log("[recorder] Встреча завершена. Закрываемся.");
            await browser.close();
        }
    } catch (e) {}
}, 5000);
