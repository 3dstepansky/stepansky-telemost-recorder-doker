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
      if (owner) output.push(`@@OWNER:${owner}`);
      if (task) output.push(...task.split('\n').map((item) => item.trim()).filter(Boolean));
      output.push('');
      continue;
    }

    output.push(line.replace(/<br\s*\/?>/gi, '\n'));
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function markdownSummaryToTelegramHtml(value) {
  const normalized = normalizeSummaryMarkdown(value);
  const lines = normalized.split('\n');
  const output = [];

  const sectionMeta = (text) => {
    const clean = text.replace(/^\d+\.\s*/, '').replace(/:$/, '').trim();
    if (/ключевые темы/i.test(clean)) return `💡 <b>${formatInlineMarkdown(clean)}</b>`;
    if (/принятые решения/i.test(clean)) return `✅ <b>${formatInlineMarkdown(clean)}</b>`;
    if (/задачи|следующие шаги/i.test(clean)) return `📌 <b>${formatInlineMarkdown(clean)}</b>`;
    return null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const owner = line.match(/^@@OWNER:(.+)$/);
    if (owner) {
      const block = [`<b>👤 ${formatInlineMarkdown(owner[1])}</b>`];
      while (index + 1 < lines.length && lines[index + 1].trim()) {
        const item = lines[++index].replace(/^\s*[•*-]\s*/, '');
        block.push(`• ${formatInlineMarkdown(item)}`);
      }
      output.push(`<blockquote expandable>${block.join('\n')}</blockquote>`);
      continue;
    }

    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const numberedCandidate = line.match(/^(\d+\.\s+.+)$/);
    const headingText = heading?.[1] || numberedCandidate?.[1];
    const styledSection = headingText ? sectionMeta(headingText) : null;
    if (styledSection) {
      output.push(styledSection);
      continue;
    }
    if (heading) {
      output.push(`<b>${formatInlineMarkdown(heading[1])}</b>`);
      continue;
    }

    const bullet = line.match(/^\s*[*-]\s+(.+)$/);
    if (bullet) {
      output.push(`• ${formatInlineMarkdown(bullet[1])}`);
      continue;
    }
    output.push(formatInlineMarkdown(line));
  }

  return output.join('\n');
}

export function buildMeetingProcessedTelegramHtml({ title, diskPath, summaryText }) {
  const diskInfo = diskPath
    ? `\n🗂 <b>Файлы встречи</b>\n<tg-spoiler><code>${escapeTelegramHtml(diskPath)}</code></tg-spoiler>\n`
    : '';
  return `✅ <b>Встреча обработана</b>\n` +
    `<blockquote><b>${escapeTelegramHtml(title || 'Без названия')}</b></blockquote>${diskInfo}\n` +
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
