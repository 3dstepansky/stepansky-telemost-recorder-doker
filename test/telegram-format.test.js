import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  buildMeetingProcessedTelegramHtml,
  escapeTelegramHtml,
  markdownSummaryToTelegramHtml,
  splitTelegramHtmlMessage
} from '../services/telegram-format.js';

const SAMPLE_SUMMARY = `**Итоги встречи:**

* Были обсуждены вопросы, связанные с расчетом академической разницы.
* Было подчеркнуто, что важно разработать систему локально.

**Принятые решения:**

* Решено разработать телеграм-бота.
* Решено использовать локальную нейронную сеть.

**Список задач (Next Steps):**

1. **Разработка телеграм-бота**: Создать телеграм-бота.
2. **Интеграция с 1С-кадрами**: Обсудить интеграцию.

**Ответственные:**

* Павел (разработка телеграм-бота)
* Настя (интеграция с 1С-кадрами)`;

describe('Telegram summary formatter', () => {
  test('escapes HTML-sensitive user content', () => {
    assert.strictEqual(escapeTelegramHtml('A < B & C > D'), 'A &lt; B &amp; C &gt; D');
  });

  test('converts LLM markdown summary to Telegram HTML', () => {
    const html = markdownSummaryToTelegramHtml(SAMPLE_SUMMARY);

    assert.match(html, /<b>Итоги встречи:<\/b>/);
    assert.match(html, /• Были обсуждены вопросы/);
    assert.match(html, /1\. <b>Разработка телеграм-бота<\/b>: Создать телеграм-бота\./);
    assert.doesNotMatch(html, /\*\*Итоги встречи:\*\*/);
    assert.doesNotMatch(html, /^\* Были/m);
  });

  test('builds safe meeting processed notification', () => {
    const html = buildMeetingProcessedTelegramHtml({
      title: 'Telemost <test> & demo',
      diskPath: 'Yandex.Telemost.Records/2026-08-03_Test & Demo',
      summaryText: SAMPLE_SUMMARY
    });

    assert.match(html, /<b>Встреча обработана!<\/b>/);
    assert.match(html, /Telemost &lt;test&gt; &amp; demo/);
    assert.match(html, /<code>Yandex\.Telemost\.Records\/2026-08-03_Test &amp; Demo<\/code>/);
    assert.match(html, /<b>Сводка встречи \(ИИ-саммари\):<\/b>/);
    assert.doesNotMatch(html, /\*\*Принятые решения:\*\*/);
  });

  test('splits long Telegram HTML messages', () => {
    const chunks = splitTelegramHtmlMessage('a'.repeat(4100), 1000);

    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= 1000));
    assert.strictEqual(chunks.join(''), 'a'.repeat(4100));
  });
});
