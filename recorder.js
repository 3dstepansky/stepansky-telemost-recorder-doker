/**
 * recorder.js — Универсальный мультиплатформенный бот для записи встреч
 * Поддерживает: Яндекс.Телемост, Google Meet, Zoom
 *
 * Использование:
 *   node recorder.js <join_url> <output_file>
 */

import dotenv from 'dotenv';
import { createRecorder } from './recorders/index.js';
import { detectPlatform } from './services/platform-detector.js';

dotenv.config();

const joinUrl = process.argv[2];
const outputFile = process.argv[3];

if (!joinUrl || !outputFile) {
  console.error('Использование: node recorder.js <join_url> <output_file>');
  process.exit(1);
}

const detection = detectPlatform(joinUrl);
console.log(`[recorder-cli] Платформа: ${detection.icon} ${detection.displayName} (${detection.platform})`);

const recorder = createRecorder(joinUrl, {
  outputFile,
  botName: process.env.BOT_DISPLAY_NAME || 'Бот-Ассистент'
});

// Обработка системных сигналов
const handleSignal = async (signal) => {
  console.log(`[recorder-cli] Получен сигнал ${signal}. Завершаем работу...`);
  await recorder.stop();
  process.exit(0);
};

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

try {
  await recorder.joinAndRecord();
} catch (error) {
  console.error('[recorder-cli] Ошибка при записи встречи:', error);
  await recorder.stop();
  process.exit(1);
}
