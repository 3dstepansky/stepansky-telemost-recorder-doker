import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeetingProcessRegistry } from '../services/meeting-processes.js';

test('stop requests graceful shutdown through the meeting lock file', () => {
  const registry = new MeetingProcessRegistry();
  const signals = [];
  const child = { kill(signal) { signals.push(signal); return true; } };

  registry.register('533234854', '73369103440', child);

  assert.equal(registry.stop('533234854', '73369103440'), true);
  assert.deepEqual(signals, []);
  assert.equal(registry.stop('533234854', '73369103440'), true);
});

test('an old child exit cannot remove a newer process for the same meeting', () => {
  const registry = new MeetingProcessRegistry();
  const oldChild = { kill() { return true; } };
  const newChild = { kill() { return true; } };

  registry.register('533234854', '73369103440', oldChild);
  registry.register('533234854', '73369103440', newChild);
  registry.unregister('533234854', '73369103440', oldChild);

  assert.equal(registry.get('533234854', '73369103440'), newChild);
});
