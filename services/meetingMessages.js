import { escapeTelegramHtml } from './telegramFormat.js';

export function formatMeetingStarted({ icon, displayName, botName }) {
  return `<b>${escapeTelegramHtml(icon)} Запись ${escapeTelegramHtml(displayName)}</b>\n\n` +
    `Бот <b>${escapeTelegramHtml(botName)}</b> подключается к встрече.\n` +
    'Для завершения нажмите кнопку ниже.';
}

export function formatMeetingStopping() {
  return '<b>⏳ Завершаем запись</b>\n\n' +
    'Бот выходит из встречи и сохраняет запись.\n' +
    'Обработка займёт несколько секунд.';
}

export function formatMeetingStopped() {
  return '<b>✅ Команда принята</b>\n\n' +
    'Бот завершает запись. Результат обработки придёт отдельным сообщением.';
}
