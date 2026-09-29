export function escapeTelegramHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatInlineMarkdown(value) {
  return escapeTelegramHtml(value)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>')
    .replace(/_([^_\n]+)_/g, '<i>$1</i>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

function normalizeSummaryMarkdown(value) {
  const lines = String(value ?? '').replace(/\r\n/g, '\n').split('\n');
  const output = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^Вот краткое и ёмкое саммари(?: рабочей встречи)?:?$/i.test(line.trim())) continue;
    if (/^---+$/.test(line.trim())) continue;

    if (/^\s*\|/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      if (!cells.length || cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
      if (/^Ответственный$/i.test(cells[0] || '')) continue;
      const owner = cells[0];
      const task = cells.slice(1).join(' — ').replace(/<br\s*\/?>/gi, '\n');
      if (owner) output.push(`**${owner}**`);
      if (task) output.push(...task.split('\n').map((item) => item.trim()).filter(Boolean));
      output.push('');
      continue;
    }

    output.push(line.replace(/<br\s*\/?>/gi, '\n'));
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function markdownSummaryToTelegramHtml(value) {
  return normalizeSummaryMarkdown(value).split('\n').map((line) => {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) return `<b>${formatInlineMarkdown(heading[1])}</b>`;

    const numberedHeading = line.match(/^(\d+\.\s+[^:]+)$/);
    if (numberedHeading) return `<b>${formatInlineMarkdown(numberedHeading[1])}</b>`;

    const bullet = line.match(/^\s*[*-]\s+(.+)$/);
    if (bullet) return `• ${formatInlineMarkdown(bullet[1])}`;

    return formatInlineMarkdown(line);
  }).join('\n');
}

export function buildMeetingProcessedTelegramHtml({ title, diskPath, summaryText }) {
  const diskInfo = diskPath
    ? `\n<b>Папка на Яндекс.Диске:</b>\n<code>${escapeTelegramHtml(diskPath)}</code>\n`
    : '';
  return `✅ <b>Встреча обработана</b>\n\n` +
    `<b>Тема:</b> ${escapeTelegramHtml(title || 'Без названия')}${diskInfo}\n\n` +
    markdownSummaryToTelegramHtml(summaryText);
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
