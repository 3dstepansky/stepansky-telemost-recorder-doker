import fs from 'fs';
import path from 'path';
import { segmentAudioIfNecessary } from './services/ffmpeg.js';
import { transcribeAudio } from './services/transcribe.js';
import { uploadToYandexDisk } from './services/webdav.js';

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
    // 1. Нарезка аудио на чанки по 20 минут (если > 25 МБ)
    console.error(`[system] Проверка размера и сегментация для: ${resolvedPath}`);
    const audioChunks = await segmentAudioIfNecessary(resolvedPath, 1200);

    // 2. Транскрибация
    console.error(`[system] Запуск ИИ-транскрибации для ${audioChunks.length} чанков...`);
    const transcriptionResult = await transcribeAudio(audioChunks, 1200);

    // 3. Создание текстового файла с транскрипцией
    const txtFileName = 'transcript.txt';
    const txtFilePath = path.join(path.dirname(resolvedPath), txtFileName);
    fs.writeFileSync(txtFilePath, transcriptionResult.text);
    console.error(`[system] Текстовый файл транскрипции создан: ${txtFilePath}`);

    // 4. Выгрузка .txt на Яндекс.Диск в ту же папку
    console.error(`[system] Выгрузка ${txtFileName} на Яндекс.Диск...`);
    const relativeYandexTxtPath = await uploadToYandexDisk(
      txtFilePath, 
      targetDirName, 
      txtFileName,
      yandexUser,
      yandexPassword
    );

    // 5. Очистка локальных файлов
    console.error(`[system] Очистка локальных файлов...`);
    
    if (fs.existsSync(resolvedPath)) fs.unlinkSync(resolvedPath);
    if (fs.existsSync(txtFilePath)) fs.unlinkSync(txtFilePath);

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
    } catch (e) {}

    // 6. Вывод JSON для n8n
    console.log(JSON.stringify({
      step: 'transcription',
      title: title,
      chat_id: chatId,
      transcript_file: relativeYandexTxtPath,
      transcript: transcriptionResult.text,
      utterances: transcriptionResult.utterances,
      speaker_count: 1,
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
