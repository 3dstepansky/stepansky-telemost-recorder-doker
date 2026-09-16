import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseVoiceTrigger, normalizeSpokenText } from '../services/voice-trigger.js';

describe('Voice Trigger Service', () => {
  it('should normalize spoken Russian text', () => {
    const raw = '  Светочка, привет! Как дела?  ';
    assert.strictEqual(normalizeSpokenText(raw), 'светочка привет как дела');
  });

  it('should detect exit phrases correctly', () => {
    const res1 = parseVoiceTrigger('Светочка, покинь встречу пожалуйста');
    assert.strictEqual(res1.matched, true);
    assert.strictEqual(res1.isExitCommand, true);
    assert.strictEqual(res1.command, 'leave_meeting');

    const res2 = parseVoiceTrigger('Бот, отключись прямо сейчас');
    assert.strictEqual(res2.matched, true);
    assert.strictEqual(res2.isExitCommand, true);

    const res3 = parseVoiceTrigger('Пожалуйста, заверши запись');
    assert.strictEqual(res3.matched, true);
    assert.strictEqual(res3.isExitCommand, true);

    const res4 = parseVoiceTrigger('Ok, leave meeting now');
    assert.strictEqual(res4.matched, true);
    assert.strictEqual(res4.isExitCommand, true);
  });

  it('should detect wake words and extract queries', () => {
    const res = parseVoiceTrigger('Светочка, что у нас по дедлайнам на этой неделе?');
    assert.strictEqual(res.matched, true);
    assert.strictEqual(res.isWakeWord, true);
    assert.strictEqual(res.isExitCommand, false);
    assert.strictEqual(res.command, 'assistant_query');
    assert.strictEqual(res.wakeWord, 'светочка');
    assert.strictEqual(res.query, 'что у нас по дедлайнам на этой неделе');
  });

  it('should ignore neutral in-meeting speech', () => {
    const res = parseVoiceTrigger('Давайте перейдем к обсуждению архитектуры проекта');
    assert.strictEqual(res.matched, false);
    assert.strictEqual(res.isExitCommand, false);
    assert.strictEqual(res.isWakeWord, false);
  });
});
