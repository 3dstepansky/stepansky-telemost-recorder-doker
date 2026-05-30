import fs from 'fs';
import path from 'path';
import { segmentAudioIfNecessary } from './services/ffmpeg.js';
import { transcribeAudio } from './services/transcribe.js';
import { uploadToYandexDisk } from './services/webdav.js';

const filePath = process.argv[2];
const title = process.argv[3] || 'Без названия';
const chatId = process.argv[4] || 'unknown';

if (!filePath) {
  console.log(JSON.stringify({ error: "Путь к файлу не передан" }));
  process.exit(1);
}

async function run() {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.log(JSON.stringify({ error: `Файл не найден: ${resolvedPath}` }));
    process.exit(1);
  }

  const timestamp = new Date().toISOString().split('T')[0];
  // Очищаем название папки от недопустимых символов
  const cleanTitle = title.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_\-\s]/g, '').trim() || 'Meeting';
  const targetDirName = `${timestamp}_${cleanTitle.replace(/\s+/g, '_')}`;
  const targetFileName = path.basename(resolvedPath);

  try {
    // 1. Нарезка аудио на чанки по 20 минут (если > 25 МБ)
    console.error(`[system] Проверка размера и сегментация для: ${resolvedPath}`);
    const audioChunks = await segmentAudioIfNecessary(resolvedPath, 1200);

    // 2. Транскрибация (поочередная отправка чанков с пересчетом таймингов)
    console.error(`[system] Запуск ИИ-транскрибации для ${audioChunks.length} чанков...`);
    const transcriptionResult = await transcribeAudio(audioChunks, 1200);

    // 3. Выгрузка оригинального файла на Яндекс.Диск через WebDAV
    console.error(`[system] Загрузка оригинального файла на Яндекс.Диск через WebDAV...`);
    const relativeYandexPath = await uploadToYandexDisk(resolvedPath, targetDirName, targetFileName);

    // 4. Очистка локальных файлов на сервере (для защиты диска)
    console.error(`[system] Очистка локальных файлов...`);
    
    // Удаляем оригинальный файл
    if (fs.existsSync(resolvedPath)) {
      fs.unlinkSync(resolvedPath);
      console.error(`[system] Локальный файл удален: ${resolvedPath}`);
    }

    // Удаляем папку с чанками
    const chunksDir = path.join(path.dirname(resolvedPath), 'chunks');
    if (fs.existsSync(chunksDir)) {
      const files = fs.readdirSync(chunksDir);
      for (const file of files) {
        fs.unlinkSync(path.join(chunksDir, file));
      }
      fs.rmdirSync(chunksDir);
      console.error(`[system] Временная директория чанков удалена.`);
    }

    // Дополнительно удаляем саму родительскую папку записи, если она пустая
    const parentDir = path.dirname(resolvedPath);
    try {
      if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
        fs.rmdirSync(parentDir);
        console.error(`[system] Пустая папка записи удалена: ${parentDir}`);
      }
    } catch (e) {}

    // 5. Вывод JSON для n8n (в stdout)
    console.log(JSON.stringify({
      title: title,
      chat_id: chatId,
      file_path: relativeYandexPath, // Передаем относительный путь на Яндекс.Диске вместо локального
      transcript: transcriptionResult.text,
      utterances: transcriptionResult.utterances,
      speaker_count: 1,
      utterance_count: transcriptionResult.utterances.length,
      transcribed_at: new Date().toISOString(),
      operation_id: 'local_' + Date.now()
    }));

  } catch (e) {
    console.error("[fatal] Ошибка пайплайна транскрибации/выгрузки:", e.message);
    console.log(JSON.stringify({ error: e.message }));
    process.exit(1);
  }
}

run();
