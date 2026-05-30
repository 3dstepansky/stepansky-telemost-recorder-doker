import fs from 'fs';
import path from 'path';
import { uploadToYandexDisk } from './services/webdav.js';

const filePath = process.argv[2];
const title = process.argv[3] || 'Без названия';
const chatId = process.argv[4] || 'unknown';
const yandexUser = process.env.YANDEX_USER || process.argv[5];
const yandexPassword = process.env.YANDEX_WEBDAV_PASSWORD || process.argv[6];

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
    console.error(`[system] Загрузка оригинального аудиофайла на Яндекс.Диск через WebDAV...`);
    const relativeYandexPath = await uploadToYandexDisk(
      resolvedPath, 
      targetDirName, 
      targetFileName,
      yandexUser,
      yandexPassword
    );

    // Вывод JSON для n8n
    console.log(JSON.stringify({
      status: 'success',
      step: 'upload_audio',
      file_path: relativeYandexPath,
      target_dir_name: targetDirName,
      title: title,
      chat_id: chatId
    }));

  } catch (e) {
    console.error("[fatal] Ошибка выгрузки аудио:", e.message);
    console.log(JSON.stringify({ error: e.message }));
    process.exit(1);
  }
}

run();
