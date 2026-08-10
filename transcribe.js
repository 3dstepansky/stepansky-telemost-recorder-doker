import fs from 'fs';
import path from 'path';
import { segmentAudioIfNecessary, convertToMp3 } from './services/ffmpeg.js';
import { transcribeAudioAssemblyAI, transcribeAudioGroq } from './services/transcribe.js';
import { uploadToYandexDisk, renameYandexDiskFolder } from './services/webdav.js';
import { generateFolderMeta, summarizeTranscript } from './services/summarize.js';
import { escapeTelegramHtml, markdownSummaryToTelegramHtml } from './services/telegramFormat.js';
import axios from 'axios';
import FormData from 'form-data';

async function sendFileToTelegram(botToken, chatId, filePath, type = 'document') {
  if (!fs.existsSync(filePath)) return false;
  if (!chatId || chatId === 'unknown' || !botToken) return false;

  const form = new FormData();
  form.append('chat_id', chatId);
  form.append(type, fs.createReadStream(filePath));

  const url = `https://api.telegram.org/bot${botToken}/send${type.charAt(0).toUpperCase() + type.slice(1)}`;
  try {
    await axios.post(url, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    console.error(`[system] Файл ${filePath} успешно отправлен в Telegram.`);
    return true;
  } catch (err) {
    console.error(`[error] Ошибка отправки файла ${filePath} в Telegram:`, err.response?.data?.description || err.message);
    return false;
  }
}

const filePath = process.argv[2];
const targetDirName = process.argv[3]; // Ожидаем имя папки из Шага 1
const title = process.argv[4] || 'Без названия';
const chatId = process.argv[5] || 'unknown';
const yandexUser = process.env.YANDEX_USER || process.argv[6];
const yandexPassword = process.env.YANDEX_WEBDAV_PASSWORD || process.argv[7];

if (!filePath || !targetDirName) {
  console.log(JSON.stringify({ error: "Путь к файлу или имя целевой папки не переданы" }));
  process.exit(1);
}

async function run() {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.log(JSON.stringify({ error: `Файл не найден: ${resolvedPath}` }));
    process.exit(1);
  }

  try {
    let transcriptionResult;
    let finalMp3Path = null;

    try {
      // 1. Транскрибация (отправляем файл целиком)
      console.error(`[system] Конвертация в MP3: ${resolvedPath}`);
      finalMp3Path = await convertToMp3(resolvedPath);
      console.error(`[system] Запуск ИИ-транскрибации AssemblyAI для: ${finalMp3Path}`);
      transcriptionResult = await transcribeAudioAssemblyAI(finalMp3Path);
    } catch (assemblyError) {
      console.error(`[system] Ошибка AssemblyAI: ${assemblyError.message}. Переключаемся на резервную модель (Groq)...`);
      
      // 1.1 Резервная нарезка аудио на чанки по 10 минут
      console.error(`[system] Проверка размера и сегментация для Groq: ${resolvedPath}`);
      const audioChunks = await segmentAudioIfNecessary(resolvedPath, 600);

      // 1.2 Транскрибация через Groq
      console.error(`[system] Запуск резервной ИИ-транскрибации Groq для ${audioChunks.length} чанков...`);
      transcriptionResult = await transcribeAudioGroq(audioChunks, 600);
    }

    // 2.5 Маппинг спикеров по track_events
    const metaDir = path.join(path.dirname(resolvedPath), "meta");
    const trackEventsPath = path.join(metaDir, "track_events.ndjson");
    if (fs.existsSync(trackEventsPath)) {
      console.error(`[system] Применяем маппинг спикеров из track_events...`);
      const eventsRaw = fs.readFileSync(trackEventsPath, 'utf-8');
      const segments = [];
      const trackIdToName = {};
      
      eventsRaw.split('\n').forEach(line => {
        if (!line.trim()) return;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'track-added') {
            trackIdToName[ev.trackId] = ev.speakerName;
          } else if (ev.type === 'speech-segment') {
            segments.push(ev);
            trackIdToName[ev.trackId] = ev.speakerName;
          }
        } catch(e) {}
      });

      if (transcriptionResult.utterances && transcriptionResult.utterances.length > 0 && segments.length > 0) {
        let newText = "";
        for (const utt of transcriptionResult.utterances) {
          let bestMatch = null;
          let maxOverlap = 0;
          
          for (const seg of segments) {
            const segStart = seg.start_ms / 1000;
            const segEnd = seg.end_ms / 1000;
            
            const overlapStart = Math.max(utt.start, segStart);
            const overlapEnd = Math.min(utt.end, segEnd);
            const overlap = overlapEnd - overlapStart;
            
            if (overlap > maxOverlap) {
              maxOverlap = overlap;
              bestMatch = seg;
            }
          }

          if (bestMatch && maxOverlap > 0.5) {
             let name = bestMatch.speakerName;
             if (!name || name === "unknown") {
                name = `Трек ${bestMatch.trackId.substring(0, 4)}`;
             }
             utt.speaker = name;
          }
          newText += `${utt.speaker}: ${utt.text}\n`;
        }
        
        transcriptionResult.text = newText.trim();
      }
    }

    // 3. Создание текстового файла с транскрипцией
    const txtFileName = 'transcript.txt';
    const txtFilePath = path.join(path.dirname(resolvedPath), txtFileName);
    fs.writeFileSync(txtFilePath, transcriptionResult.text);
    console.error(`[system] Текстовый файл транскрипции создан: ${txtFilePath}`);

    // 4. Выгрузка .txt на Яндекс.Диск
    if (yandexUser && yandexPassword) {
      console.error(`[system] Выгрузка ${txtFileName} на Яндекс.Диск...`);
      try {
        await uploadToYandexDisk(txtFilePath, targetDirName, txtFileName, yandexUser, yandexPassword);
      } catch (e) {
        console.error(`[error] Ошибка Яндекс.Диска для ${txtFileName}:`, e.message);
      }
    }

    // 4.5. Генерация суммаризации (ИИ-саммари по шаблону)
    console.error(`[system] Запуск ИИ-суммаризации...`);
    let summaryText = 'Не удалось сгенерировать саммари встречи.';
    try {
      summaryText = await summarizeTranscript(transcriptionResult.text);
    } catch (sumErr) {
      console.error(`[error] Ошибка генерации ИИ-саммари: ${sumErr.message}`);
    }

    // Сохранение и выгрузка summary.txt
    const summaryFileName = 'summary.txt';
    const summaryFilePath = path.join(path.dirname(resolvedPath), summaryFileName);
    fs.writeFileSync(summaryFilePath, summaryText);
    console.error(`[system] Текстовый файл саммари создан: ${summaryFilePath}`);

    if (yandexUser && yandexPassword) {
      console.error(`[system] Выгрузка ${summaryFileName} на Яндекс.Диск...`);
      try {
        await uploadToYandexDisk(summaryFilePath, targetDirName, summaryFileName, yandexUser, yandexPassword);
      } catch (e) {
        console.error(`[error] Ошибка Яндекс.Диска для ${summaryFileName}:`, e.message);
      }
    }

    // 5. ИИ-анализ для переименования папки
    let activeDirName = targetDirName;
    let folderMeta = { speaker_count: 1, speakers: [], topic: 'встреча' };
    try {
      folderMeta = await generateFolderMeta(summaryText);
    } catch (metaErr) {
      console.error(`[error] Ошибка извлечения ИИ-метаданных: ${metaErr.message}`);
    }

    const uniqueAiSpeakers = new Set((transcriptionResult.utterances || []).map(u => u.speaker)).size;
    const finalSpeakerCount = Math.max(folderMeta.speaker_count || 1, uniqueAiSpeakers || 1);

    // Вычисляем новое имя папки на основе ИИ-метаданных
    const datePrefix = targetDirName.split('_')[0] || new Date().toISOString().split('T')[0];
    let folderTitle = '';

    if (finalSpeakerCount >= 5) {
      folderTitle = `конференция на тему ${folderMeta.topic}`;
    } else {
      if (folderMeta.speakers && folderMeta.speakers.length > 0) {
        folderTitle = `${folderMeta.speakers.join(' и ')} о ${folderMeta.topic}`;
      } else {
        folderTitle = `${title} о ${folderMeta.topic}`;
      }
    }

    // Очищаем название папки от недопустимых символов (оставляем пробелы и русские буквы)
    const cleanFolderTitle = folderTitle.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_\-\s]/g, '').trim() || 'Встреча';
    const finalDirName = `${datePrefix}_${cleanFolderTitle}`;

    // Переименовываем папку на Яндекс.Диске (только если есть доступы)
    if (yandexUser && yandexPassword) {
      try {
        console.error(`[system] Попытка переименования папки на Яндекс.Диске: ${targetDirName} -> ${finalDirName}`);
        await renameYandexDiskFolder(targetDirName, finalDirName, yandexUser, yandexPassword);
        activeDirName = finalDirName;
        console.error(`[system] Папка успешно переименована в: ${finalDirName}`);
      } catch (renameErr) {
        console.error(`[error] Не удалось переименовать папку на Яндекс.Диске: ${renameErr.message}`);
      }
    } else {
      activeDirName = finalDirName;
    }


    // 7. Вывод JSON для n8n
    console.log(JSON.stringify({
      step: 'transcription',
      title: title,
      chat_id: chatId,
      target_dir_name: activeDirName,
      audio_file: `Yandex.Telemost.Records/${activeDirName}/meeting_audio.webm`,
      transcript_file: `Yandex.Telemost.Records/${activeDirName}/transcript.txt`,
      summary_file: `Yandex.Telemost.Records/${activeDirName}/summary.txt`,
      transcript: transcriptionResult.text,
      summary: summaryText,
      utterances: transcriptionResult.utterances,
      speaker_count: finalSpeakerCount,
      utterance_count: transcriptionResult.utterances.length,
      transcribed_at: new Date().toISOString()
    }));

    // 8. Отправка уведомления и файлов в Telegram
    if (chatId && chatId !== 'unknown' && chatId !== 'manual_launch' && process.env.TELEGRAM_BOT_TOKEN) {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      
      let diskInfo = yandexUser ? `<b>Папка на Яндекс.Диске:</b>\n<code>Yandex.Telemost.Records/${escapeTelegramHtml(activeDirName)}</code>\n\n` : '';

      const formattedSummary = markdownSummaryToTelegramHtml(summaryText);
      const textMsg = `<b>Встреча обработана!</b>\n\n` +
                      `<b>Тема:</b> ${escapeTelegramHtml(title)}\n` +
                      diskInfo +
                      `<b>Сводка встречи (ИИ-саммари):</b>\n${formattedSummary}`;
      try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          chat_id: chatId,
          text: textMsg,
          parse_mode: 'HTML',
          reply_markup: {
            keyboard: [
              ['🔴 Запись встреч', '🧠 Аналитика и ИИ'],
              ['⚙️ Настройки', 'ℹ️ Помощь']
            ],
            resize_keyboard: true
          }
        });

        console.error(`[system] Отправка файлов в Telegram...`);
        if (finalMp3Path) await sendFileToTelegram(botToken, chatId, finalMp3Path, 'audio');
        await sendFileToTelegram(botToken, chatId, summaryFilePath, 'document');
        await sendFileToTelegram(botToken, chatId, txtFilePath, 'document');
      } catch (tgErr) {
        console.error(`[error] Не удалось отправить уведомление/файлы в Telegram: ${tgErr.message}`);
      }
    }

    // 9. Очистка локальных файлов
    console.error(`[system] Очистка локальных файлов...`);

    if (fs.existsSync(resolvedPath)) fs.unlinkSync(resolvedPath);
    if (fs.existsSync(txtFilePath)) fs.unlinkSync(txtFilePath);
    if (fs.existsSync(summaryFilePath)) fs.unlinkSync(summaryFilePath);
    if (finalMp3Path && fs.existsSync(finalMp3Path)) fs.unlinkSync(finalMp3Path);

    const chunksDir = path.join(path.dirname(resolvedPath), 'chunks');
    if (fs.existsSync(chunksDir)) {
      const files = fs.readdirSync(chunksDir);
      for (const file of files) fs.unlinkSync(path.join(chunksDir, file));
      fs.rmdirSync(chunksDir);
    }

    // Удаляем meta и tracks
    if (fs.existsSync(metaDir)) {
      const files = fs.readdirSync(metaDir);
      for (const file of files) fs.unlinkSync(path.join(metaDir, file));
      fs.rmdirSync(metaDir);
    }

    const tracksDir = path.join(path.dirname(resolvedPath), 'tracks');
    if (fs.existsSync(tracksDir)) {
      const files = fs.readdirSync(tracksDir);
      for (const file of files) fs.unlinkSync(path.join(tracksDir, file));
      fs.rmdirSync(tracksDir);
    }

    const parentDir = path.dirname(resolvedPath);
    try {
      if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
        fs.rmdirSync(parentDir);
      }
    } catch (e) { }

  } catch (e) {
    console.error("[fatal] Ошибка пайплайна транскрибации:", e.message);

    // Отправка сообщения об ошибке в Telegram
    if (chatId && chatId !== 'unknown' && chatId !== 'manual_launch' && process.env.TELEGRAM_BOT_TOKEN) {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const errorMsg = `<b>Ошибка обработки встречи</b>\n\n` +
                       `<b>Тема:</b> ${title}\n` +
                       `<b>Детали:</b> <code>${e.message}</code>`;
      try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          chat_id: chatId,
          text: errorMsg,
          parse_mode: 'HTML',
          reply_markup: {
            keyboard: [
              ['🔴 Запись встреч', '🧠 Аналитика и ИИ'],
              ['⚙️ Настройки', 'ℹ️ Помощь']
            ],
            resize_keyboard: true
          }
        });
      } catch (tgErr) {
        console.error(`[error] Не удалось отправить сообщение об ошибке в Telegram: ${tgErr.message}`);
      }
    }

    console.log(JSON.stringify({ error: e.message }));
    process.exit(1);
  }
}

run();
