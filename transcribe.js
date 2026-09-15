import fs from 'fs';
import path from 'path';
import { transcribeTracks, transcribeAudioWithFallback, applyMixedTrackEventSpeakerRemap } from './services/perTrackTranscription.js';
import { uploadToYandexDisk, renameYandexDiskFolder } from './services/webdav.js';
import { generateFolderMeta, summarizeTranscript } from './services/summarize.js';
import { escapeTelegramHtml, markdownSummaryToTelegramHtml, splitTelegramText } from './services/telegramFormat.js';
import { ingestTelemostToWikiRaw } from './services/wikiIngest.js';
import { saveMeetingResult } from './services/mongoMemory.js';
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

    const recordingDir = path.dirname(resolvedPath);
    const metaDir = path.join(recordingDir, "meta");

    const perTrackResult = await transcribeTracks(recordingDir);
    if (perTrackResult.usedPerTrack) {
      transcriptionResult = perTrackResult;
      console.error(`[system] Per-track транскрибация успешна: ${perTrackResult.track_diagnostics.successes.length} канал(ов), ошибок: ${perTrackResult.track_diagnostics.failures.length}`);
      for (const failure of perTrackResult.track_diagnostics.failures) {
        console.error(`[warn] Ошибка ASR трека ${failure.trackId}: ${failure.error}`);
      }
    } else {
      console.error(`[system] Per-track транскрибация недоступна (${perTrackResult.reason}). Используем mixed fallback...`);
      const mixed = await transcribeAudioWithFallback(resolvedPath, { singleTrack: false });
      transcriptionResult = applyMixedTrackEventSpeakerRemap(mixed.result, recordingDir);
      finalMp3Path = mixed.mp3Path || null;
    }

    if (!Array.isArray(transcriptionResult.utterances)) {
      transcriptionResult.utterances = [];
    }
    if (typeof transcriptionResult.text !== 'string') {
      transcriptionResult.text = transcriptionResult.utterances.map(u => `${u.speaker || 'unknown'}: ${u.text || ''}`).join('\n').trim();
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

    let mongoMeeting = null;
    if (process.env.MONGODB_URI) {
      try {
        mongoMeeting = await saveMeetingResult({
          chatId,
          sourceMeetingId: targetDirName,
          title,
          transcript: transcriptionResult.text,
          summary: summaryText,
          transcriptionResult,
          recordingPath: resolvedPath,
          folderName: targetDirName,
        });
        console.error(`[mongo] Результат встречи сохранён: ${mongoMeeting._id}`);
      } catch (mongoErr) {
        console.error(`[mongo] Не удалось сохранить встречу: ${mongoErr.message}`);
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


    // 6.5. Пассивное пополнение LLM Wiki raw-слоя для разрешённых Telegram chat_id
    let wikiRawIngest = { skipped: true, reason: 'not-run' };
    try {
      wikiRawIngest = ingestTelemostToWikiRaw({
        chatId,
        title,
        targetDirName,
        activeDirName,
        transcriptText: transcriptionResult.text,
        summaryText,
      });
      if (wikiRawIngest.skipped) {
        console.error(`[system] LLM Wiki raw ingest skipped: ${wikiRawIngest.reason}`);
      } else {
        console.error(`[system] LLM Wiki raw ingest saved: ${wikiRawIngest.files.join(', ')}`);
      }
    } catch (wikiErr) {
      wikiRawIngest = { skipped: true, error: wikiErr.message };
      console.error(`[error] Ошибка записи в LLM Wiki raw: ${wikiErr.message}`);
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
      wiki_raw_ingest: wikiRawIngest,
      transcript: transcriptionResult.text,
      summary: summaryText,
      utterances: transcriptionResult.utterances,
      track_transcription: transcriptionResult.track_diagnostics ? {
        used_per_track: transcriptionResult.usedPerTrack === true,
        diagnostics: transcriptionResult.track_diagnostics
      } : undefined,
      speaker_count: finalSpeakerCount,
      utterance_count: transcriptionResult.utterances.length,
      transcribed_at: new Date().toISOString()
    }));

    // 8. Отправка уведомления и файлов в Telegram
    if (chatId && chatId !== 'unknown' && chatId !== 'manual_launch' && process.env.TELEGRAM_BOT_TOKEN) {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      
      let diskInfo = yandexUser ? `<b>Папка на Яндекс.Диске:</b>\n<code>Yandex.Telemost.Records/${escapeTelegramHtml(activeDirName)}</code>\n\n` : '';

      const formattedSummary = markdownSummaryToTelegramHtml(summaryText);
      const header = `<b>Встреча обработана!</b>\n\n` +
                     `<b>Тема:</b> ${escapeTelegramHtml(title)}\n` +
                     diskInfo +
                     `<b>Сводка встречи (ИИ-саммари):</b>\n`;
      const summaryChunks = splitTelegramText(formattedSummary, 3900 - header.length);
      try {
        for (let i = 0; i < summaryChunks.length; i++) {
          const replyMarkup = i === summaryChunks.length - 1
            ? (mongoMeeting ? {
                inline_keyboard: [[{ text: '🧠 Векторизовать разговор', callback_data: `vectorize_${mongoMeeting._id}` }]]
              } : undefined)
            : undefined;
          await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: chatId,
            text: i === 0 ? header + summaryChunks[i] : `<b>Продолжение саммари:</b>\n${summaryChunks[i]}`,
            parse_mode: 'HTML',
            reply_markup: replyMarkup
          });
        }

        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          chat_id: chatId,
          text: mongoMeeting
            ? 'Результаты встречи сохранены. Векторизация выполняется только по кнопке выше.'
            : 'Результаты встречи обработаны.',
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
      fs.rmSync(tracksDir, { recursive: true, force: true });
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
