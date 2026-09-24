import { escapeTelegramHtml } from './telegramFormat.js';

function plainSummary(value = '') {
  const structuralLine = /^(?:[-—]+|ключевые темы|принятые решения|задачи(?: и следующие шаги)?|следующие шаги|итоги|участники)\s*:?[\s*]*$/i;
  const introLine = /^вот\s+(?:краткое|краткое и ёмкое)\s+саммари[^:]*:?$/i;

  return String(value)
    .split(/\r?\n/)
    .map(line => line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\s*(?:[*•-]|\d+[.)])\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .trim())
    .filter(line => line && !structuralLine.test(line) && !introLine.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function summaryPreview(value, maxLength = 360) {
  const text = plainSummary(value);
  if (!text) return 'Саммари пока отсутствует.';

  const sentences = text.match(/[^.!?]+[.!?]+(?:[»”"])?/g) || [];
  let preview = sentences.slice(0, 2).join(' ').replace(/\s+/g, ' ').trim();
  if (!preview) preview = text;
  if (preview.length > maxLength) {
    preview = `${preview.slice(0, maxLength - 1).trimEnd()}…`;
  }
  return preview;
}

export function formatMeetingList(meetings = [], locale = 'ru-RU') {
  let text = '<b>Последние встречи:</b>\n\n';
  meetings.forEach((meeting, index) => {
    const dateValue = meeting.createdAt || meeting.updatedAt || meeting.transcribed_at;
    const date = dateValue
      ? new Date(dateValue).toLocaleString(locale, { timeZone: 'Europe/Moscow' })
      : 'дата неизвестна';
    const title = escapeTelegramHtml(meeting.title || 'Встреча');
    const summary = escapeTelegramHtml(summaryPreview(meeting.summary));
    text += `${index + 1}. <b>${title}</b>\n${escapeTelegramHtml(date)}\n<i>${summary}</i>\n\n`;
  });
  return text.trim();
}
