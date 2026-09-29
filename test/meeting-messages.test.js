import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMeetingStarted, formatMeetingStopping, formatMeetingStopped } from '../services/meetingMessages.js';

test('meeting status messages contain real line breaks and valid escaped HTML', () => {
  const started = formatMeetingStarted({ icon: '🔵', displayName: 'Zoom <Web>', botName: 'Бот <Ассистент>' });
  assert.equal(started, '<b>🔵 Запись Zoom &lt;Web&gt;</b>\n\nБот <b>Бот &lt;Ассистент&gt;</b> подключается к встрече.\nДля завершения нажмите кнопку ниже.');
  assert.equal(started.includes('\\n'), false);
  assert.equal(formatMeetingStopping().includes('\\n'), false);
  assert.equal(formatMeetingStopped().includes('\\n'), false);
});
