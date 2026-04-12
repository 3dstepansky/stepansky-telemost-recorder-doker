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
    if (isCreateMode) {
      await page.goto("https://telemost.yandex.ru/", { waitUntil: "networkidle2" });
      console.log("[recorder] Зашли на главную для создания встречи...");
      
      // Ищем кнопку "Создать встречу" (анализ показал селектор CreateCallButton)
      const buttonSelector = 'button[class*="CreateCallButton"]';
      await page.waitForSelector(buttonSelector, { timeout: 10000 });
      await page.click(buttonSelector);

      console.log("[recorder] Ожидание генерации ссылки...");
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 });
      const newUrl = page.url();
      console.log(`[SUCCESS_JOIN_URL] ${newUrl}`);
      
      // Для режима только создания - завершаем работу. 
      // Но если мы хотим продолжить запись, мы не делаем exit.
      // В нашем случае run_start.sh ждет возврата ссылки и потом запускает другой процесс.
      process.exit(0);
    }

    await page.goto(joinUrl, { waitUntil: "networkidle2", timeout: 45000 });
    console.log("[recorder] Страница загружена");
    // --- МОНИТОР ПРИСУТСТВИЯ И ТАЙМ-АУТЫ ---
    const MAX_IDLE_MINS = parseInt(process.env.MAX_IDLE_MINS || "3");
    const MAX_DURATION_MINS = parseInt(process.env.MAX_DURATION_MINS || "180");
    let idleSeconds = 0;
    let totalSeconds = 0;

    console.log(`[monitor] Лимиты: Ожидание ${MAX_IDLE_MINS}м, Макс. запись ${MAX_DURATION_MINS}м`);

    const monitorInterval = setInterval(async () => {
        totalSeconds += 10;
        
        // 1. Проверка общего времени (Hard Timeout)
        if (totalSeconds >= MAX_DURATION_MINS * 60) {
            console.log(`[monitor] Достигнут лимит времени записи (${MAX_DURATION_MINS} мин). Завершаю...`);
            clearInterval(monitorInterval);
            await gracefulShutdown();
            return;
        }

        // 2. Проверка количества участников
        try {
            const count = await page.evaluate(() => {
                // Ищем конкретно кнопку участников с иконкой человечков
                // В Телемосте это часто кнопка с aria-label или текстом "Участники"
                const participantBtn = document.querySelector('[data-testid="participants-button"]');
                if (participantBtn) {
                     const match = participantBtn.innerText.match(/(\d+)/);
                     if (match) return parseInt(match[1]);
                }

                // Альтернативный поиск по селекторам Яндекса
                const countEls = document.querySelectorAll('[class*="ParticipantsCount"]');
                for (const el of countEls) {
                    const match = el.innerText.match(/(\d+)/);
                    if (match) return parseInt(match[1]);
                }

                // Если не нашли на кнопках, считаем список
                const participantList = document.querySelectorAll('[class*="Participant-Name"], [class*="ParticipantItem"]');
                if (participantList.length > 0) return participantList.length;

                return 1; // Если совсем ничего не нашли, считаем что мы одни (безопасный выход)
            });

            console.log(`[monitor] Участников: ${count} | Прошло: ${Math.floor(totalSeconds/60)}м`);

            if (count <= 1) {
                idleSeconds += 10;
                const remaining = (MAX_IDLE_MINS * 60) - idleSeconds;
                if (idleSeconds % 30 === 0) {
                    console.log(`[monitor] Бот один в комнате. Выход через ${Math.floor(remaining)} сек...`);
                }
            } else {
                idleSeconds = 0;
            }

            if (idleSeconds >= MAX_IDLE_MINS * 60) {
                console.log(`[monitor] Бот был один слишком долго (${MAX_IDLE_MINS} мин). Завершаю сессию.`);
                clearInterval(monitorInterval);
                await gracefulShutdown();
            }
        } catch (e) {
            console.error("[monitor] Ошибка при проверке участников:", e.message);
        }
    }, 10000); // Проверка каждые 10 секунд

} catch (error) {
    console.error("[error] Критическая ошибка рекордера:", error);
    process.exit(1);
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
console.log("[recorder] Ищем поле для ввода имени...");
const nameInput = await page.evaluateHandle(() => {
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
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        nativeInputValueSetter.call(input, name);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
    }, el, BOT_NAME);
    
    console.log(`[recorder] Имя "${BOT_NAME}" установлено.`);
    await new Promise(r => setTimeout(r, 1000));
} else {
    console.log("[recorder] Поле имени не найдено, возможно бот уже вошел или селектор изменился.");
}

// 3. ПОПЫТКА ЗАКРЫТЬ СИСТЕМНОЕ ОКНО
await page.keyboard.press('Escape');
await new Promise(r => setTimeout(r, 2000));

// Выключаем мик и камеру
console.log("[recorder] Выключаем микрофон и камеру...");
await page.evaluate(() => {
    const micBtn = document.querySelector('[data-testid="turn-off-mic-button"]');
    if (micBtn) micBtn.click();
    const camBtn = document.querySelector('[data-testid="turn-off-camera-button"]');
    if (camBtn) camBtn.click();
});

// Кнопка "Присоединиться"
console.log("[recorder] Ищем кнопку входа...");
const joinButton = await page.evaluateHandle(() => {
  const buttons = [...document.querySelectorAll("button, [role='button']")];
  return buttons.find((b) => /подключиться|присоединиться|join/i.test(b.textContent));
});

if (joinButton && joinButton.asElement()) {
    await page.evaluate((el) => el.click(), joinButton);
    console.log("[recorder] Кнопка входа нажата! Входим на встречу...");
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
