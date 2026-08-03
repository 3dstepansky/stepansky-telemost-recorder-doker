const MAX_TELEGRAM_TEXT_LENGTH = 4096;

export function escapeTelegramHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatInlineMarkdown(escapedText) {
  return escapedText.replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, '<b>$1</b>');
}

export function markdownSummaryToTelegramHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');

  return lines.map((line) => {
    const escaped = escapeTelegramHtml(line);

    const headingMatch = escaped.match(/^\s*\*\*([^*]+):\*\*\s*$/);
    if (headingMatch) {
      return `<b>${headingMatch[1]}:</b>`;
    }

    const bulletMatch = escaped.match(/^\s*\*\s+(.+)$/);
    if (bulletMatch) {
      return `• ${formatInlineMarkdown(bulletMatch[1])}`;
    }

    const numberedMatch = escaped.match(/^(\s*\d+\.\s+)(.+)$/);
    if (numberedMatch) {
      return `${numberedMatch[1]}${formatInlineMarkdown(numberedMatch[2])}`;
    }

    return formatInlineMarkdown(escaped);
  }).join('\n');
}

export function buildMeetingProcessedTelegramHtml({ title, diskPath, summaryText }) {
  const safeTitle = escapeTelegramHtml(title || 'Без названия');
  const diskInfo = diskPath
    ? `<b>Папка на Яндекс.Диске:</b>\n<code>${escapeTelegramHtml(diskPath)}</code>\n\n`
    : '';

  return `<b>Встреча обработана!</b>\n\n` +
    `<b>Тема:</b> ${safeTitle}\n` +
    diskInfo +
    `<b>Сводка встречи (ИИ-саммари):</b>\n` +
    markdownSummaryToTelegramHtml(summaryText);
}

export function splitTelegramHtmlMessage(html, maxLength = MAX_TELEGRAM_TEXT_LENGTH) {
  const text = String(html ?? '');
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let current = '';

  for (const paragraph of text.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    if (current) chunks.push(current);

    if (paragraph.length <= maxLength) {
      current = paragraph;
      continue;
    }

    let rest = paragraph;
    while (rest.length > maxLength) {
      const cutAt = rest.lastIndexOf('\n', maxLength);
      const splitAt = cutAt > maxLength * 0.5 ? cutAt : maxLength;
      chunks.push(rest.slice(0, splitAt));
      rest = rest.slice(splitAt).replace(/^\n+/, '');
    }
    current = rest;
  }

  if (current) chunks.push(current);
  return chunks;
}
