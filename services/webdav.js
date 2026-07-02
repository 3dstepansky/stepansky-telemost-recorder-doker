import axios from 'axios';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

/**
 * Загружает локальный файл на Яндекс.Диск по протоколу WebDAV.
 * Автоматически создает папку Yandex.Telemost.Records и подпапку встречи.
 * 
 * @param {string} localFilePath - Локальный путь к файлу
 * @param {string} targetDirName - Имя подпапки встречи (например, 2026-05-29_MeetingName)
 * @param {string} targetFileName - Имя файла на Яндекс.Диске (например, meeting_audio.webm)
 * @param {string} [yandexUser] - Логин Яндекс (опционально, фоллбэк на .env)
 * @param {string} [yandexPassword] - Пароль WebDAV (опционально, фоллбэк на .env)
 * @returns {Promise<string>} Относительный путь к загруженному файлу
 */
export async function uploadToYandexDisk(localFilePath, targetDirName, targetFileName, yandexUser, yandexPassword) {
  const username = yandexUser || process.env.YANDEX_USER;
  let password = yandexPassword || process.env.YANDEX_WEBDAV_PASSWORD;
  if (password) password = password.replace(/\s/g, '');

  if (!username || !password) {
    throw new Error("Не заданы логин или пароль для Яндекс.Диска (передайте в функцию или укажите в .env)");
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

/**
 * Переименовывает (перемещает) папку на Яндекс.Диске с помощью метода MOVE.
 * 
 * @param {string} oldDirName - Старое имя папки (например, 2026-06-20_tempID)
 * @param {string} newDirName - Новое имя папки (например, 2026-06-20_Павел_и_Ксения...)
 * @param {string} [yandexUser] - Логин Яндекс (опционально, фоллбэк на .env)
 * @param {string} [yandexPassword] - Пароль WebDAV (опционально, фоллбэк на .env)
 * @returns {Promise<string>} Результирующий путь к папке на Яндекс.Диске без лидирующего слэша
 */
export async function renameYandexDiskFolder(oldDirName, newDirName, yandexUser, yandexPassword) {
  const username = yandexUser || process.env.YANDEX_USER;
  let password = yandexPassword || process.env.YANDEX_WEBDAV_PASSWORD;
  if (password) password = password.replace(/\s/g, '');

  if (!username || !password) {
    throw new Error("Не заданы логин или пароль для Яндекс.Диска (передайте в функцию или укажите в .env)");
  }

  const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const baseUrl = 'https://webdav.yandex.ru';

  const oldPath = `/Yandex.Telemost.Records/${oldDirName}`;
  const newPath = `/Yandex.Telemost.Records/${newDirName}`;

  console.log(`[webdav] Переименование папки: ${oldPath} -> ${newPath}`);

  try {
    await axios({
      method: 'MOVE',
      baseURL: baseUrl,
      url: encodeURI(oldPath),
      headers: {
        'Authorization': authHeader,
        'Destination': encodeURI(`${baseUrl}${newPath}`),
        'Overwrite': 'F' // Предотвращаем перезапись, если папка с таким именем уже существует
      }
    });

    console.log(`[webdav] Папка успешно переименована в: ${newPath}`);
    return newPath.substring(1);
  } catch (error) {
    console.error('[webdav] Ошибка при переименовании папки по WebDAV:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Проверяет корректность логина и пароля для Яндекс.Диска.
 * 
 * @param {string} username 
 * @param {string} password 
 * @returns {Promise<boolean>}
 */
export async function checkYandexDiskConnection(username, password) {
  if (!username || !password) return false;
  password = password.replace(/\s/g, '');
  
  const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  console.log(`[webdav-debug] Check auth for username="${username}" (pass length=${password.length})`);
  try {
    await axios({
      method: 'PROPFIND',
      url: 'https://webdav.yandex.ru/',
      headers: {
        'Authorization': authHeader,
        'Depth': '0'
      },
      timeout: 5000
    });
    return true;
  } catch (error) {
    if (error.response && (error.response.status === 401 || error.response.status === 403)) {
      console.log(`[webdav] Тест авторизации отклонен сервером (status: ${error.response.status})`);
      return false;
    }
    console.error('[webdav] Ошибка проверки соединения:', error.message);
    throw error;
  }
}


