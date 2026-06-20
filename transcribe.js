import fs from 'fs';
import path from 'path';
import { segmentAudioIfNecessary } from './services/ffmpeg.js';
import { transcribeAudioAssemblyAI, transcribeAudioGroq } from './services/transcribe.js';
import { uploadToYandexDisk, renameYandexDiskFolder } from './services/webdav.js';
import { generateFolderMeta, summarizeTranscript } from './services/summarize.js';

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

    try {
      // 1. Транскрибация (отправляем файл целиком)
      console.error(`[system] Запуск ИИ-транскрибации AssemblyAI для: ${resolvedPath}`);
      transcriptionResult = await transcribeAudioAssemblyAI(resolvedPath);
    } catch (assemblyError) {
      console.error(`[system] Ошибка AssemblyAI: ${assemblyError.message}. Переключаемся на резервную модель (Groq)...`);
      
      // 1.1 Резервная нарезка аудио на чанки по 10 минут
      console.error(`[system] Проверка размера и сегментация для Groq: ${resolvedPath}`);
      const audioChunks = await segmentAudioIfNecessary(resolvedPath, 600);

      // 1.2 Транскрибация через Groq
      console.error(`[system] Запуск резервной ИИ-транскрибации Groq для ${audioChunks.length} чанков...`);
      transcriptionResult = await transcribeAudioGroq(audioChunks, 600);
    }

    // 3. Создание текстового файла с транскрипцией
    const txtFileName = 'transcript.txt';
    const txtFilePath = path.join(path.dirname(resolvedPath), txtFileName);
    fs.writeFileSync(txtFilePath, transcriptionResult.text);
    console.error(`[system] Текстовый файл транскрипции создан: ${txtFilePath}`);

    // 4. Выгрузка .txt на Яндекс.Диск в ту же папку
    console.error(`[system] Выгрузка ${txtFileName} на Яндекс.Диск...`);
    await uploadToYandexDisk(
      txtFilePath,
      targetDirName,
      txtFileName,
      yandexUser,
      yandexPassword
    );

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

    console.error(`[system] Выгрузка ${summaryFileName} на Яндекс.Диск...`);
    await uploadToYandexDisk(
      summaryFilePath,
      targetDirName,
      summaryFileName,
      yandexUser,
      yandexPassword
    );

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

    // Переименовываем папку на Яндекс.Диске
    try {
      console.error(`[system] Попытка переименования папки на Яндекс.Диске: ${targetDirName} -> ${finalDirName}`);
      await renameYandexDiskFolder(targetDirName, finalDirName, yandexUser, yandexPassword);
      activeDirName = finalDirName;
      console.error(`[system] Папка успешно переименована в: ${finalDirName}`);
    } catch (renameErr) {
      console.error(`[error] Не удалось переименовать папку на Яндекс.Диске: ${renameErr.message}`);
    }

    // 6. Очистка локальных файлов
    console.error(`[system] Очистка локальных файлов...`);

    if (fs.existsSync(resolvedPath)) fs.unlinkSync(resolvedPath);
    if (fs.existsSync(txtFilePath)) fs.unlinkSync(txtFilePath);
    if (fs.existsSync(summaryFilePath)) fs.unlinkSync(summaryFilePath);

    const chunksDir = path.join(path.dirname(resolvedPath), 'chunks');
    if (fs.existsSync(chunksDir)) {
      const files = fs.readdirSync(chunksDir);
      for (const file of files) fs.unlinkSync(path.join(chunksDir, file));
      fs.rmdirSync(chunksDir);
    }

    const parentDir = path.dirname(resolvedPath);
    try {
      if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
        fs.rmdirSync(parentDir);
      }
    } catch (e) { }

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

  } catch (e) {
    console.error("[fatal] Ошибка пайплайна транскрибации:", e.message);
    console.log(JSON.stringify({ error: e.message }));
    process.exit(1);
  }
}

run();
