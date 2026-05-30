import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Проверяет размер файла и при необходимости нарезает его на сегменты с помощью FFmpeg.
 * Нарезка происходит без перекодирования (-c copy) для экономии ресурсов CPU.
 * 
 * @param {string} inputFilePath - Абсолютный путь к исходному аудиофайлу WebM
 * @param {number} segmentTimeSeconds - Длина одного чанка в секундах (по умолчанию 1200 сек / 20 мин)
 * @returns {Promise<string[]>} Массив путей к файлам (исходный файл или список чанков)
 */
export function segmentAudioIfNecessary(inputFilePath, segmentTimeSeconds = 1200) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputFilePath)) {
      return reject(new Error(`Файл не найден: ${inputFilePath}`));
    }

    const stats = fs.statSync(inputFilePath);
    const fileSizeMB = stats.size / (1024 * 1024);
    const maxLimitMB = 24.5; // Лимит Groq Whisper = 25 МБ (берем с запасом)

    console.log(`[ffmpeg] Размер аудиофайла: ${fileSizeMB.toFixed(2)} МБ`);

    if (fileSizeMB <= maxLimitMB) {
      console.log("[ffmpeg] Файл не превышает лимит. Сегментация не требуется.");
      return resolve([inputFilePath]);
    }

    const inputDir = path.dirname(inputFilePath);
    const ext = path.extname(inputFilePath);
    const baseName = path.basename(inputFilePath, ext);
    
    // Создаем временную директорию для чанков внутри папки записи
    const chunksDir = path.join(inputDir, 'chunks');
    if (!fs.existsSync(chunksDir)) {
      fs.mkdirSync(chunksDir, { recursive: true });
    }

    const outputPattern = path.join(chunksDir, `${baseName}_%03d${ext}`);
    // Команда нарезки без перекодирования
    const command = `ffmpeg -y -i "${inputFilePath}" -f segment -segment_time ${segmentTimeSeconds} -c copy "${outputPattern}"`;

    console.log(`[ffmpeg] Запуск сегментации: ${command}`);

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("[ffmpeg] Ошибка выполнения FFmpeg:", error.message);
        return reject(error);
      }

      // Читаем файлы из директории чанков
      try {
        const files = fs.readdirSync(chunksDir)
          .filter(file => file.startsWith(baseName) && file.endsWith(ext))
          .map(file => path.join(chunksDir, file))
          .sort(); // Сортируем по имени для соблюдения хронологии

        console.log(`[ffmpeg] Успешно нарезано на ${files.length} чанков.`);
        resolve(files);
      } catch (err) {
        reject(err);
      }
    });
  });
}
