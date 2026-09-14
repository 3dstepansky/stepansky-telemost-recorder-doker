export function escapeTelegramHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function markdownSummaryToTelegramHtml(value) {
  const escaped = escapeTelegramHtml(value);
  return escaped
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>')
    .replace(/_([^_\n]+)_/g, '<i>$1</i>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

export function splitTelegramText(value, maxLength = 3900) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let rest = text;
  while (rest.length > maxLength) {
    let splitAt = rest.lastIndexOf('\n\n', maxLength);
    if (splitAt < Math.floor(maxLength * 0.5)) splitAt = rest.lastIndexOf('\n', maxLength);
    if (splitAt < Math.floor(maxLength * 0.5)) splitAt = rest.lastIndexOf(' ', maxLength);
    if (splitAt <= 0) splitAt = maxLength;
    chunks.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
