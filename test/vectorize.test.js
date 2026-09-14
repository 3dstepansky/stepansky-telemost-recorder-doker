import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkTranscript } from '../services/vectorize.js';

test('chunkTranscript keeps short Russian transcript intact', () => {
  const text = 'Павел обсудил с Денисом сроки запуска проекта.';
  assert.deepEqual(chunkTranscript(text), [text]);
});

test('chunkTranscript splits long Russian transcript into bounded chunks', () => {
  const text = Array.from({ length: 80 }, (_, i) => `Реплика ${i}: обсудили бюджет, сроки и ответственного за задачу.`).join('\n\n');
  const chunks = chunkTranscript(text, 500, 50);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 550));
  assert.match(chunks.join(' '), /бюджет/);
});
