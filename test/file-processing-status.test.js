import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldNotifyFileProcessingError } from '../services/fileProcessingStatus.js';

test('does not report a user file error when container shutdown killed processing', () => {
  assert.equal(shouldNotifyFileProcessingError({ code: null, signal: 'SIGTERM', shuttingDown: true }), false);
});

test('reports a real transcribe failure with non-zero exit code', () => {
  assert.equal(shouldNotifyFileProcessingError({ code: 1, signal: null, shuttingDown: false }), true);
});
