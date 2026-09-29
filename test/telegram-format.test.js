import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeTelegramHtml, markdownSummaryToTelegramHtml, splitTelegramText, buildMeetingProcessedTelegramHtml } from '../services/telegramFormat.js';

test('escapeTelegramHtml escapes Telegram HTML control chars', () => {
  assert.equal(escapeTelegramHtml('A < B & C > D'), 'A &lt; B &amp; C &gt; D');
});

test('markdownSummaryToTelegramHtml renders common LLM markdown for Telegram HTML parse mode', () => {
  const input = '# Итоги\n\n**Ключевые темы:**\n1. Создать `бота` для _контроля_\n*Важно* <не сломать HTML>';
  const output = markdownSummaryToTelegramHtml(input);

  assert.match(output, /<b>Итоги<\/b>/);
  assert.match(output, /<b>Ключевые темы:<\/b>/);
  assert.match(output, /<code>бота<\/code>/);
  assert.match(output, /<i>контроля<\/i>/);
  assert.match(output, /<i>Важно<\/i>/);
  assert.match(output, /&lt;не сломать HTML&gt;/);
  assert.doesNotMatch(output, /\*\*Ключевые темы:\*\*/);
});

test('processed meeting message removes markdown tables and boilerplate', () => {
  const summary = `Вот краткое и ёмкое саммари рабочей встречи:\n\n---\n\n1. Ключевые темы\n* Найм: Запустить подбор.\n\n3. Задачи и следующие шаги\n\n| Ответственный | Задача / Следующий шаг |\n| :--- | :--- |\n| Антон | • Запустить найм.<br>• Подготовить дайджест. |`;
  const output = buildMeetingProcessedTelegramHtml({
    title: 'Штаб_ИИ_29.09',
    diskPath: 'Yandex.Telemost.Records/Штаб_ИИ_29.09',
    summaryText: summary,
  });

  assert.match(output, /^✅ <b>Встреча обработана<\/b>/);
  assert.match(output, /<blockquote><b>Штаб_ИИ_29\.09<\/b><\/blockquote>/);
  assert.match(output, /💡 <b>Ключевые темы<\/b>/);
  assert.match(output, /📌 <b>Задачи и следующие шаги<\/b>/);
  assert.match(output, /<blockquote expandable><b>👤 Антон<\/b>\n• Запустить найм\.\n• Подготовить дайджест\.<\/blockquote>/);
  assert.match(output, /<tg-spoiler><code>Yandex\.Telemost\.Records\/Штаб_ИИ_29\.09<\/code><\/tg-spoiler>/);
  assert.doesNotMatch(output, /Вот краткое и ёмкое саммари/);
  assert.doesNotMatch(output, /---|\| :---|<br>/);
});

test('splitTelegramText keeps every Telegram message below the requested limit', () => {
  const input = ('Абзац с итогами встречи.\n\n').repeat(300);
  const chunks = splitTelegramText(input, 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 500));
  assert.equal(chunks.join('\n\n').replace(/\s+/g, ' ').trim(), input.replace(/\s+/g, ' ').trim());
});
