import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPuppeteerLaunchOptions } from '../recorders/base.js';

test('Puppeteer does not close Chromium before recorder graceful signal handler', () => {
  const options = buildPuppeteerLaunchOptions({
    isHeadless: true,
    userDataDir: '/tmp/zoom-test',
    args: ['--no-sandbox'],
  });

  assert.equal(options.handleSIGINT, false);
  assert.equal(options.handleSIGTERM, false);
  assert.equal(options.handleSIGHUP, false);
});
