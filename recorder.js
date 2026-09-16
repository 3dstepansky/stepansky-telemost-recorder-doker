/**
 * Универсальная точка входа рекордера.
 *
 * Телемост запускается через проверенный production-рекордер со всей логикой
 * атрибуции спикеров. Google Meet и Zoom используют новые платформенные драйверы.
 */
import dotenv from 'dotenv';
import { detectPlatform } from './services/platform-detector.js';

dotenv.config();

const joinUrl = process.argv[2];
const outputFile = process.argv[3];

if (!joinUrl || !outputFile) {
  console.error('Использование: node recorder.js <join_url> <output_file>');
  process.exit(1);
}

const detection = detectPlatform(joinUrl);
if (!detection.valid || detection.platform === 'teams') {
  console.error(`[recorder-router] Неподдерживаемая ссылка: ${joinUrl}`);
  process.exit(2);
}

console.log(`[recorder-router] Платформа: ${detection.displayName} (${detection.platform})`);

if (detection.platform === 'telemost') {
  // Production-модуль использует process.argv и сам управляет lifecycle.
  await import('./recorders/telemost-production.js');
} else {
  const { createRecorder } = await import('./recorders/index.js');
  const recorder = createRecorder(joinUrl, {
    outputFile,
    botName: process.env.BOT_DISPLAY_NAME || 'Бот-Ассистент'
  });

  const shutdown = async (signal) => {
    console.log(`[recorder-router] Получен ${signal}, завершаем запись...`);
    await recorder.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await recorder.joinAndRecord();
  } catch (error) {
    console.error('[recorder-router] Ошибка записи:', error);
    await recorder.stop();
    process.exit(1);
  }
}
