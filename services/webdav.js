import axios from 'axios';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

/**
 * Загружает локальный файл на Яндекс.Диск по протоколу WebDAV.
 * Автоматически создает папку Yandex.Telemost.Records и подпапку встречи.
 * 
 * @param {string} localFilePath - Локальный путь к аудиофайлу
 * @param {string} targetDirName - Имя подпапки встречи (например, 2026-05-29_MeetingName)
 * @param {string} targetFileName - Имя файла на Яндекс.Диске (например, meeting_audio.webm)
 * @returns {Promise<string>} Относительный путь к загруженному файлу
 */
export async function uploadToYandexDisk(localFilePath, targetDirName, targetFileName) {
  const username = process.env.YANDEX_USER;
  const password = process.env.YANDEX_WEBDAV_PASSWORD;

  if (!username || !password) {
    throw new Error("Не заданы YANDEX_USER или YANDEX_WEBDAV_PASSWORD в файле .env");
  }

  if (!fs.existsSync(localFilePath)) {
    throw new Error(`Локальный файл не найден: ${localFilePath}`);
  }

  const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const baseUrl = 'https://webdav.yandex.ru';

  const axiosInstance = axios.create({
    baseURL: baseUrl,
    headers: {
      'Authorization': authHeader
    }
  });

  // Функция для безопасного создания папки (игнорирует ошибку 405, если папка уже существует)
  const createFolder = async (folderPath) => {
    try {
      console.log(`[webdav] Создание папки: ${folderPath}`);
      await axiosInstance({
        method: 'MKCOL',
        url: encodeURI(folderPath)
      });
      console.log(`[webdav] Папка создана успешно: ${folderPath}`);
    } catch (error) {
      if (error.response && error.response.status === 405) {
        console.log(`[webdav] Папка уже существует: ${folderPath}`);
      } else {
        console.error(`[webdav] Ошибка создания папки ${folderPath}:`, error.message);
        throw error;
      }
    }
  };

  try {
    // 1. Создаем корневую папку Yandex.Telemost.Records
    await createFolder('/Yandex.Telemost.Records');

    // 2. Создаем подпапку встречи
    const targetFolder = `/Yandex.Telemost.Records/${targetDirName}`;
    await createFolder(targetFolder);

    // 3. Загружаем файл по WebDAV методом PUT
    const targetFilePath = `${targetFolder}/${targetFileName}`;
    console.log(`[webdav] Начинаем загрузку файла в: ${targetFilePath}`);

    const fileStream = fs.createReadStream(localFilePath);
    const fileStats = fs.statSync(localFilePath);

    await axiosInstance({
      method: 'PUT',
      url: encodeURI(targetFilePath),
      data: fileStream,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileStats.size
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    console.log(`[webdav] Файл успешно загружен на Яндекс.Диск: ${targetFilePath}`);
    
    // Возвращаем относительный путь без лидирующего слэша для записи в БД
    return targetFilePath.substring(1);
  } catch (error) {
    console.error('[webdav] Критическая ошибка работы с WebDAV:', error.response?.data || error.message);
    throw error;
  }
}
