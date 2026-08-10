import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ingestTelemostToWikiRaw, __private__ } from '../services/wikiIngest.js';

const { isWikiRawIngestEnabled } = __private__;

test('wiki raw ingest is gated by explicit enable flag and Telegram chat allowlist', () => {
  assert.equal(isWikiRawIngestEnabled('533234854', {
    WIKI_RAW_INGEST_ENABLED: 'false',
    WIKI_RAW_INGEST_CHAT_IDS: '533234854',
  }), false);

  assert.equal(isWikiRawIngestEnabled('533234854', {
    WIKI_RAW_INGEST_ENABLED: 'true',
    WIKI_RAW_INGEST_CHAT_IDS: '123, 533234854',
  }), true);

  assert.equal(isWikiRawIngestEnabled('999', {
    WIKI_RAW_INGEST_ENABLED: 'true',
    WIKI_RAW_INGEST_CHAT_IDS: '533234854',
  }), false);
});

test('ingestTelemostToWikiRaw saves immutable raw transcript and summary notes', () => {
  const wikiPath = fs.mkdtempSync(path.join(os.tmpdir(), 'telemost-wiki-'));
  fs.writeFileSync(path.join(wikiPath, 'log.md'), '# Wiki Log\n', 'utf8');

  const result = ingestTelemostToWikiRaw({
    chatId: '533234854',
    title: 'Проверочная встреча',
    targetDirName: '2026-08-10_test',
    activeDirName: '2026-08-10_проверочная встреча',
    transcriptText: 'Спикер 1: Привет\nСпикер 2: Решили писать в raw.',
    summaryText: '**Итог:** пишем в raw.',
    createdAt: new Date('2026-08-10T12:34:56.000Z'),
    env: {
      WIKI_RAW_INGEST_ENABLED: 'true',
      WIKI_RAW_INGEST_CHAT_IDS: '533234854',
      WIKI_PATH: wikiPath,
    },
  });

  assert.equal(result.skipped, false);
  assert.equal(result.files.length, 2);

  const relFiles = result.files.map((file) => path.relative(wikiPath, file));
  assert.deepEqual(relFiles, [
    'raw/transcripts/telemost-2026-08-10-12-34-56-проверочная-встреча-transcript.md',
    'raw/transcripts/telemost-2026-08-10-12-34-56-проверочная-встреча-summary.md',
  ]);

  const transcript = fs.readFileSync(result.files[0], 'utf8');
  assert.match(transcript, /source_url: "yandex-disk:Yandex.Telemost.Records\/2026-08-10_проверочная встреча"/);
  assert.match(transcript, /sha256: [a-f0-9]{64}/);
  assert.match(transcript, /Спикер 2: Решили писать в raw\./);

  const log = fs.readFileSync(path.join(wikiPath, 'log.md'), 'utf8');
  assert.match(log, /ingest \| Telemost raw transcript — Проверочная встреча/);
});
