import { describe, it } from 'node:test';
import assert from 'node:assert';
import { detectPlatform } from '../services/platform-detector.js';

describe('Platform Detector Service', () => {
  it('should detect Yandex Telemost URLs', () => {
    const res = detectPlatform('https://telemost.yandex.ru/j/12345678901234');
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.platform, 'telemost');
    assert.strictEqual(res.meetingId, '12345678901234');
    assert.strictEqual(res.icon, '🟣');
  });

  it('should detect Google Meet URLs', () => {
    const res = detectPlatform('https://meet.google.com/abc-defg-hij');
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.platform, 'google-meet');
    assert.strictEqual(res.meetingId, 'abc-defg-hij');
    assert.strictEqual(res.icon, '🟢');
  });

  it('should detect Zoom URLs with and without password', () => {
    const res1 = detectPlatform('https://zoom.us/j/9876543210');
    assert.strictEqual(res1.valid, true);
    assert.strictEqual(res1.platform, 'zoom');
    assert.strictEqual(res1.meetingId, '9876543210');
    assert.strictEqual(res1.normalizedUrl, 'https://zoom.us/wc/join/9876543210');

    const res2 = detectPlatform('https://us04web.zoom.us/j/1234567890?pwd=secretPassword123');
    assert.strictEqual(res2.valid, true);
    assert.strictEqual(res2.platform, 'zoom');
    assert.strictEqual(res2.meetingId, '1234567890');
    assert.strictEqual(res2.pwd, 'secretPassword123');
    assert.strictEqual(res2.normalizedUrl, 'https://zoom.us/wc/join/1234567890?pwd=secretPassword123');
  });

  it('should detect Microsoft Teams URLs', () => {
    const res = detectPlatform('https://teams.live.com/meet/948294829482');
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.platform, 'teams');
  });

  it('should reject invalid URLs gracefully', () => {
    const res1 = detectPlatform('https://youtube.com/watch?v=12345');
    assert.strictEqual(res1.valid, false);
    assert.strictEqual(res1.platform, 'unknown');

    const res2 = detectPlatform('');
    assert.strictEqual(res2.valid, false);

    const res3 = detectPlatform(null);
    assert.strictEqual(res3.valid, false);
  });
});
