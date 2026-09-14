import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createMeetingClock,
  normalizeParticipantMetadata,
  normalizeSpeechSegment,
  resolveTrackMetadata,
  unknownSpeakerMetadata,
} from '../services/speakerAttribution.js';

test('meeting clock normalizes all timestamps to one meeting-relative monotonic scale', () => {
  const clock = createMeetingClock({ wallStartMs: Date.UTC(2026, 0, 1), monoStartMs: 1000 });

  assert.equal(clock.now(1250), 250);
  assert.equal(clock.now(1200), 250, 'event time never moves backwards');
  assert.equal(clock.relative(1100), 100, 'historical segment starts keep true meeting-relative offset');
  assert.equal(clock.isoAt(250), '2026-01-01T00:00:00.250Z');
});

test('meeting clock starts at mixed-audio recorder start, not page-load/injection time', () => {
  const clock = createMeetingClock();

  const pageLoadMonoMs = 1_000;
  const firstTrackArrivalMonoMs = pageLoadMonoMs + 45_000;
  const mixRecorderStartMonoMs = firstTrackArrivalMonoMs + 120;

  assert.equal(clock.isStarted(), false);
  assert.equal(clock.relative(firstTrackArrivalMonoMs), 0, 'pre-origin track-added candidates clamp to zero, never negative');

  clock.start(mixRecorderStartMonoMs, Date.UTC(2026, 0, 1));
  assert.equal(clock.now(mixRecorderStartMonoMs), 0, 'mixed-audio start is the ASR/VAD zero point');
  assert.equal(clock.relative(pageLoadMonoMs), 0, 'page-load delay is not included in event offsets');
  assert.equal(clock.relative(mixRecorderStartMonoMs + 1_500), 1500);
  assert.equal(clock.isoAt(0), '2026-01-01T00:00:00.000Z');
});

test('late tracks keep the first mixed-audio origin and monotonic event timestamps', () => {
  const clock = createMeetingClock();
  clock.start(10_000, Date.UTC(2026, 0, 1));

  assert.equal(clock.now(10_000), 0, 'first track starts at audio-relative zero');
  assert.equal(clock.now(70_000), 60_000, 'late track uses original mixed-audio origin');
  assert.equal(clock.now(69_500), 60_000, 'event timestamps remain monotonic after a late/out-of-order event');
  assert.equal(clock.relative(10_250), 250, 'segment boundaries still use true audio-relative offsets');
});

test('speech segment normalization uses meeting origin, not per-track origin', () => {
  const clock = createMeetingClock({ monoStartMs: 10_000 });
  clock.now(12_000); // e.g. first track-added event

  const seg = normalizeSpeechSegment({ startMonoMs: 15_500, endMonoMs: 16_250, clock });
  assert.deepEqual(seg, { start_ms: 5500, end_ms: 6250 });
});

test('recorder.js clock contract matches audio-relative helper behavior', () => {
  const recorderPath = path.resolve('recorder.js');
  const source = fs.readFileSync(recorderPath, 'utf8');

  assert.match(source, /wallStartMs:\s*null/, 'browser clock must not start at evaluateOnNewDocument/page load');
  assert.match(source, /monoStartMs:\s*null/, 'browser clock must wait for mixed audio recorder start');
  assert.match(source, /activeRecorders\.size === 0 && meetingClock\.isStarted\(\)[\s\S]*meetingClock\.now\(meetingClock\.monoStartMs\)/, 'first track-added event is pinned to exact audio-relative zero');
  assert.match(source, /meetingClock\.start\(performance\.now\(\), Date\.now\(\)\);[\s\S]*mixRecorder = new MediaRecorder/, 'browser code starts the shared clock immediately before creating/starting the mixed recorder');
  assert.doesNotMatch(source, /wallStartMs:\s*Date\.now\(\)[\s\S]{0,120}monoStartMs:\s*performance\.now\(\)/, 'browser code must not reintroduce page-load origin');
});

test('speaker metadata fallback is explicit unknown with provenance and zero confidence', () => {
  assert.deepEqual(unknownSpeakerMetadata('fallback:test'), {
    participantId: null,
    displayName: null,
    speakerName: 'unknown',
    provenance: 'fallback:test',
    confidence: 0,
  });

  const resolved = resolveTrackMetadata({ track: { id: 'track-a' }, streams: [{ id: 'stream-a' }], participantSnapshots: [] });
  assert.equal(resolved.speakerName, 'unknown');
  assert.equal(resolved.confidence, 0);
  assert.match(resolved.provenance, /fallback:unknown/);
});

test('track metadata resolves only on exact track/stream evidence', () => {
  const byTrack = resolveTrackMetadata({
    track: { id: 'track-42' },
    participantSnapshots: [{ trackId: 'track-42', participantId: 'p1', displayName: 'Alice' }],
  });
  assert.equal(byTrack.participantId, 'p1');
  assert.equal(byTrack.displayName, 'Alice');
  assert.equal(byTrack.speakerName, 'Alice');
  assert.ok(byTrack.confidence >= 0.9);

  const byStream = resolveTrackMetadata({
    track: { id: 'new-track-after-reconnect' },
    streams: [{ id: 'stream-p2' }],
    participantSnapshots: [{ streamId: 'stream-p2', participantId: 'p2', displayName: 'Bob' }],
  });
  assert.equal(byStream.participantId, 'p2');
  assert.equal(byStream.speakerName, 'Bob');
});

test('reconnect/new track without exact metadata does not reuse stale participant mapping', () => {
  const first = resolveTrackMetadata({
    track: { id: 'old-track' },
    participantSnapshots: [{ trackId: 'old-track', participantId: 'p1', displayName: 'Alice' }],
  });
  assert.equal(first.speakerName, 'Alice');

  const reconnected = resolveTrackMetadata({
    track: { id: 'new-track' },
    participantSnapshots: [{ trackId: 'old-track', participantId: 'p1', displayName: 'Alice' }],
  });
  assert.equal(reconnected.speakerName, 'unknown');
  assert.equal(reconnected.participantId, null);
});

test('participant metadata sanitizes empty names while preserving participantId', () => {
  const meta = normalizeParticipantMetadata({ participantId: ' user-1 ', displayName: '   ', provenance: 'unit' });
  assert.equal(meta.participantId, 'user-1');
  assert.equal(meta.displayName, null);
  assert.equal(meta.speakerName, 'unknown');
  assert.equal(meta.provenance, 'unit');
});
