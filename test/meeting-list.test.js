import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMeetingList, summaryPreview } from '../services/meetingList.js';

test('summaryPreview skips headings and returns at most two concise sentences', () => {
  const preview = summaryPreview('Вот краткое и ёмкое саммари рабочей встречи:\n\n**Ключевые темы:**\n* **Первая тема.** Второе решение! Третья деталь.');
  assert.equal(preview, 'Первая тема. Второе решение!');
});

test('formatMeetingList includes title and summary and escapes Telegram HTML', () => {
  const text = formatMeetingList([{
    title: 'Встреча <Павел>',
    summary: '**Решили запустить тест.** Следующий шаг — проверить результат. Остальное не нужно.',
    createdAt: new Date('2026-09-16T08:17:03.528Z'),
  }]);
  assert.match(text, /Встреча &lt;Павел&gt;/);
  assert.match(text, /Решили запустить тест\. Следующий шаг — проверить результат\./);
  assert.doesNotMatch(text, /Остальное не нужно/);
});
