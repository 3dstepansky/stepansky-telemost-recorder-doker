import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeTelegramHtml, markdownSummaryToTelegramHtml } from '../services/telegramFormat.js';

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
