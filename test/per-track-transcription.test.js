import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadTrackMetadata,
  mergeTrackUtterances,
  transcribeTracks,
} from '../services/perTrackTranscription.js';
import { normalizeAssemblyAITranscript } from '../services/transcribe.js';

function tempRecordingDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemost-cycle2-'));
  fs.mkdirSync(path.join(dir, 'tracks'));
  fs.mkdirSync(path.join(dir, 'meta'));
  return dir;
}

function writeTrack(dir, trackId, body = 'webm') {
  fs.writeFileSync(path.join(dir, 'tracks', `${trackId}.webm`), body);
}

function writeSummary(dir, tracks) {
  fs.writeFileSync(path.join(dir, 'meta', 'tracks_summary.json'), JSON.stringify({ tracks }, null, 2));
}

function writeEvents(dir, events) {
  fs.writeFileSync(path.join(dir, 'meta', 'track_events.ndjson'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
}

test('mergeTrackUtterances merges tracks on one audio-relative timeline with deterministic order', () => {
  const merged = mergeTrackUtterances([
    {
      trackId: 'b-track',
      metadata: { speakerName: 'Bob', recordingOffsetMs: 2000, provenance: 'unit', confidence: 1 },
      result: { utterances: [{ speaker: 'ignored', text: 'second', start: 0, end: 1 }] },
    },
    {
      trackId: 'a-track',
      metadata: { speakerName: 'Alice', recordingOffsetMs: 0, provenance: 'unit', confidence: 1 },
      result: { utterances: [{ speaker: 'ignored', text: 'first', start: 1, end: 1.5 }] },
    },
  ]);

  assert.deepEqual(merged.map((u) => [u.speaker, u.text, u.start, u.end, u.trackId]), [
    ['Alice', 'first', 1, 1.5, 'a-track'],
    ['Bob', 'second', 2, 3, 'b-track'],
  ]);
});

test('mergeTrackUtterances preserves real overlaps instead of shifting utterances', () => {
  const merged = mergeTrackUtterances([
    {
      trackId: 'alice',
      metadata: { speakerName: 'Alice', recordingOffsetMs: 0, provenance: 'unit', confidence: 1 },
      result: { utterances: [{ text: 'говорю', start: 1, end: 4 }] },
    },
    {
      trackId: 'bob',
      metadata: { speakerName: 'Bob', recordingOffsetMs: 0, provenance: 'unit', confidence: 1 },
      result: { utterances: [{ text: 'перебиваю', start: 2, end: 3 }] },
    },
  ]);

  assert.equal(merged[0].start, 1);
  assert.equal(merged[0].end, 4);
  assert.equal(merged[1].start, 2);
  assert.equal(merged[1].end, 3);
});

test('late track offset from metadata is applied to local ASR timestamps', () => {
  const merged = mergeTrackUtterances([
    {
      trackId: 'late',
      metadata: {
        speakerName: 'Late Speaker',
        recordingOffsetMs: 12_345,
        recordingOffsetProvenance: 'track-events:track-added',
        provenance: 'unit',
        confidence: 1,
      },
      result: { utterances: [{ text: 'late hello', start: 0.5, end: 1.5 }] },
    },
  ]);

  assert.equal(merged[0].start, 12.85);
  assert.equal(merged[0].end, 13.85);
  assert.equal(merged[0].track_recording_offset_ms, 12_345);
  assert.equal(merged[0].track_recording_offset_provenance, 'track-events:track-added');
});

test('metadata loader keeps unknown speaker honest when only fallback metadata exists', () => {
  const dir = tempRecordingDir();
  writeEvents(dir, [{
    type: 'track-added',
    trackId: 't-unknown',
    speakerName: 'unknown',
    displayName: null,
    provenance: 'fallback:unknown:no-safe-track-participant-match',
    confidence: 0,
    t_ms: 777,
  }]);

  const metadata = loadTrackMetadata(dir).byTrackId.get('t-unknown');
  assert.equal(metadata.speakerName, 'unknown');
  assert.equal(metadata.displayName, null);
  assert.equal(metadata.confidence, 0);
  assert.equal(metadata.recordingOffsetMs, 777);
});

test('metadata loader prefers real displayName over placeholder speakerName unknown', () => {
  const dir = tempRecordingDir();
  writeSummary(dir, [{
    trackId: 't-real-name',
    speakerName: 'unknown',
    displayName: 'Real Participant',
    provenance: 'safe-match',
    confidence: 0.9,
  }]);

  const metadata = loadTrackMetadata(dir).byTrackId.get('t-real-name');
  assert.equal(metadata.speakerName, 'Real Participant');
  assert.equal(metadata.displayName, 'Real Participant');
});

test('AssemblyAI normalization builds utterances from words when speaker labels are disabled', () => {
  const normalized = normalizeAssemblyAITranscript({
    text: 'hello world second phrase',
    utterances: [],
    words: [
      { text: 'hello', start: 100, end: 250 },
      { text: 'world', start: 300, end: 500 },
      { text: 'second', start: 1500, end: 1800 },
      { text: 'phrase', start: 1850, end: 2100 },
    ],
  }, { speakerLabels: false });

  assert.equal(normalized.text, 'hello world second phrase');
  assert.deepEqual(normalized.utterances.map((u) => [u.speaker, u.text, u.start, u.end]), [
    ['Спикер', 'hello world', 0.1, 0.5],
    ['Спикер', 'second phrase', 1.5, 2.1],
  ]);
  assert.ok(!normalized.utterances.some((u) => u.speaker.includes('undefined')));
});

test('AssemblyAI normalization treats no-speech payload as empty transcript', () => {
  const normalized = normalizeAssemblyAITranscript({
    text: '',
    utterances: [],
    words: [],
  }, { speakerLabels: false });

  assert.deepEqual(normalized, { text: '', utterances: [] });
});

test('transcribeTracks uses normalized words-only AssemblyAI payload and keeps partial no-speech diagnostics', async () => {
  const dir = tempRecordingDir();
  writeTrack(dir, 'a', 'aaaa');
  writeTrack(dir, 'b', 'bbbb');
  writeSummary(dir, [
    { trackId: 'a', speakerName: 'Alice', recordingOffsetMs: 0, provenance: 'unit', confidence: 1 },
    { trackId: 'b', speakerName: 'Bob', recordingOffsetMs: 0, provenance: 'unit', confidence: 1 },
  ]);

  const result = await transcribeTracks(dir, {
    convertFn: async (filePath) => filePath,
    assemblyFn: async (filePath) => {
      if (filePath.endsWith('b.webm')) {
        return normalizeAssemblyAITranscript({ text: '', utterances: [], words: [] }, { speakerLabels: false });
      }
      return normalizeAssemblyAITranscript({
        text: 'words only',
        words: [
          { text: 'words', start: 0, end: 250 },
          { text: 'only', start: 300, end: 600 },
        ],
      }, { speakerLabels: false });
    },
  });

  assert.equal(result.usedPerTrack, true);
  assert.deepEqual(result.utterances.map((u) => [u.trackId, u.speaker, u.text, u.start, u.end]), [
    ['a', 'Alice', 'words only', 0, 0.6],
  ]);
  assert.equal(result.track_diagnostics.successes.length, 1);
  assert.equal(result.track_diagnostics.noSpeech.length, 1);
  assert.equal(result.track_diagnostics.failures.length, 0);
});

test('transcribeTracks returns mixed fallback signal when all channels have no speech', async () => {
  const dir = tempRecordingDir();
  writeTrack(dir, 'a', 'aaaa');

  const result = await transcribeTracks(dir, {
    convertFn: async (filePath) => filePath,
    assemblyFn: async () => normalizeAssemblyAITranscript({ text: '', utterances: [], words: [] }, { speakerLabels: false }),
  });

  assert.equal(result.usedPerTrack, false);
  assert.equal(result.reason, 'no-track-speech');
  assert.equal(result.diagnostics.noSpeech.length, 1);
  assert.equal(result.diagnostics.failures.length, 0);
});

test('transcribeTracks keeps successful channels and reports failed channels', async () => {
  const dir = tempRecordingDir();
  writeTrack(dir, 'a', 'aaaa');
  writeTrack(dir, 'b', 'bbbb');
  writeSummary(dir, [
    { trackId: 'a', speakerName: 'Alice', recordingOffsetMs: 0, provenance: 'unit', confidence: 1 },
    { trackId: 'b', speakerName: 'Bob', recordingOffsetMs: 0, provenance: 'unit', confidence: 1 },
  ]);

  const result = await transcribeTracks(dir, {
    convertFn: async (filePath) => filePath,
    assemblyFn: async (filePath, options) => {
      assert.equal(options.speakerLabels, false, 'single-track AssemblyAI call must not request diarization');
      if (filePath.endsWith('b.webm')) throw new Error('assembly down');
      return { text: 'ok', utterances: [{ speaker: 'provider', text: 'hello', start: 0, end: 1 }] };
    },
    segmentFn: async () => { throw new Error('groq fallback down'); },
  });

  assert.equal(result.usedPerTrack, true);
  assert.deepEqual(result.utterances.map((u) => [u.trackId, u.speaker, u.text]), [['a', 'Alice', 'hello']]);
  assert.equal(result.track_diagnostics.successes.length, 1);
  assert.equal(result.track_diagnostics.failures.length, 1);
  assert.match(result.track_diagnostics.failures[0].error, /groq fallback down/);
});

test('transcribeTracks requests mixed fallback when no tracks or all track ASR calls fail', async () => {
  const noTracks = tempRecordingDir();
  const noTrackResult = await transcribeTracks(noTracks);
  assert.equal(noTrackResult.usedPerTrack, false);
  assert.equal(noTrackResult.reason, 'no-valid-track-files');

  const allFail = tempRecordingDir();
  writeTrack(allFail, 'a', 'aaaa');
  const failResult = await transcribeTracks(allFail, {
    convertFn: async (filePath) => filePath,
    assemblyFn: async () => { throw new Error('assembly fail'); },
    segmentFn: async () => { throw new Error('groq fail'); },
  });

  assert.equal(failResult.usedPerTrack, false);
  assert.equal(failResult.reason, 'all-track-asr-failed');
  assert.equal(failResult.diagnostics.failures.length, 1);
});
