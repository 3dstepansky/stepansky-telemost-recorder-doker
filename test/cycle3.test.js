import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  enrichUtteranceConfidence,
  resolveParticipantTracks,
  applyMixedTrackEventSpeakerRemap,
  mergeTrackUtterances,
} from '../services/perTrackTranscription.js';
import { createVoiceprintSession, VoiceprintSession } from '../services/voiceprintSession.js';

function tempRecordingDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemost-cycle3-'));
  fs.mkdirSync(path.join(dir, 'tracks'));
  fs.mkdirSync(path.join(dir, 'meta'));
  return dir;
}

test('enrichUtteranceConfidence aggregates confidence, calculates needs_human_review, preserves original_speaker_label', () => {
  // Test 1: MIN(trackMetadata.confidence, asr_word_confidence)
  const utt1 = {
    speaker: 'Спикер A',
    text: 'Hello world',
    words: [
      { text: 'Hello', start: 0, end: 500, confidence: 0.95 },
      { text: 'world', start: 500, end: 1000, confidence: 0.60 },
    ],
  };
  const meta1 = { confidence: 0.90, displayName: 'Alice' };
  const res1 = enrichUtteranceConfidence(utt1, meta1);

  assert.equal(res1.speaker_confidence, 0.60);
  assert.equal(res1.needs_human_review, false);
  assert.equal(res1.original_speaker_label, 'Спикер A');

  // Test 2: trackMetadata.confidence < 0.3 AND !displayName -> needs_human_review: true
  const utt2 = { speaker: 'Спикер 1', text: 'Low confidence' };
  const meta2 = { confidence: 0.20, displayName: null };
  const res2 = enrichUtteranceConfidence(utt2, meta2);

  assert.equal(res2.speaker_confidence, 0.20);
  assert.equal(res2.needs_human_review, true);
  assert.equal(res2.original_speaker_label, 'Спикер 1');

  // Test 3: trackMetadata.confidence < 0.3 BUT has displayName -> needs_human_review: false
  const utt3 = { speaker: 'Спикер 2', text: 'Low confidence with name' };
  const meta3 = { confidence: 0.25, displayName: 'Bob' };
  const res3 = enrichUtteranceConfidence(utt3, meta3);

  assert.equal(res3.needs_human_review, false);

  // Test 4: mergeTrackUtterances attaches enrichment fields to output utterances
  const merged = mergeTrackUtterances([
    {
      trackId: 'track-1',
      metadata: { speakerName: 'Alice', displayName: 'Alice', recordingOffsetMs: 0, provenance: 'unit', confidence: 0.8 },
      result: {
        utterances: [
          { speaker: 'Спикер A', text: 'Testing merge', start: 0, end: 2, words: [{ confidence: 0.7 }] },
        ],
      },
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].speaker, 'Alice');
  assert.equal(merged[0].original_speaker_label, 'Спикер A');
  assert.equal(merged[0].speaker_confidence, 0.7);
  assert.equal(merged[0].needs_human_review, false);
});

test('resolveParticipantTracks merges tracks by participantId and preserves merged_tracks & name priority', () => {
  const metadataMap = new Map([
    [
      'track-101',
      {
        trackId: 'track-101',
        participantId: 'part-1',
        displayName: null,
        speakerName: 'unknown',
        confidence: 0.5,
      },
    ],
    [
      'track-102',
      {
        trackId: 'track-102',
        participantId: 'part-1',
        displayName: 'Charlie Brown',
        speakerName: 'Charlie',
        confidence: 0.9,
      },
    ],
    [
      'track-201',
      {
        trackId: 'track-201',
        participantId: 'part-2',
        displayName: 'David',
        speakerName: 'David',
        confidence: 0.8,
      },
    ],
  ]);

  const resolved = resolveParticipantTracks(metadataMap);

  assert.equal(resolved.size, 2);

  // Participant 1: merged 2 tracks, picked known name
  const p1 = resolved.get('part-1');
  assert.ok(p1);
  assert.equal(p1.displayName, 'Charlie Brown');
  assert.equal(p1.speakerName, 'Charlie');
  assert.deepEqual(p1.trackIds, ['track-101', 'track-102']);
  assert.deepEqual(p1.merged_tracks, ['track-101', 'track-102']);

  // Participant 2: single track, merged_tracks is empty array
  const p2 = resolved.get('part-2');
  assert.ok(p2);
  assert.equal(p2.displayName, 'David');
  assert.deepEqual(p2.trackIds, ['track-201']);
  assert.deepEqual(p2.merged_tracks, []);
});

test('VoiceprintSession in-memory stub operations', () => {
  const vp = createVoiceprintSession();
  assert.ok(vp instanceof VoiceprintSession);

  // Initial empty
  assert.deepEqual(vp.getAllParticipants(), []);
  assert.equal(vp.lookupParticipant('p1'), null);

  // Add track for p1
  vp.addTrack('p1', 't1', { displayName: 'Eve' });
  const p1 = vp.lookupParticipant('p1');
  assert.ok(p1);
  assert.equal(p1.participantId, 'p1');
  assert.equal(p1.displayName, 'Eve');
  assert.deepEqual(p1.trackIds, ['t1']);

  // Add second track for p1
  vp.addTrack('p1', 't2', { displayName: 'Eve Online' });
  const p1Updated = vp.lookupParticipant('p1');
  assert.equal(p1Updated.displayName, 'Eve'); // Keeps first known name
  assert.deepEqual(p1Updated.trackIds, ['t1', 't2']);

  // Add track for p2
  vp.addTrack('p2', 't3', { speakerName: 'Frank' });

  const all = vp.getAllParticipants();
  assert.equal(all.length, 2);
});

test('applyMixedTrackEventSpeakerRemap maps "Спикер A" to displayName from metadata', () => {
  const dir = tempRecordingDir();

  // Write tracks summary metadata
  fs.writeFileSync(
    path.join(dir, 'meta', 'tracks_summary.json'),
    JSON.stringify({
      tracks: [
        { trackId: 't1', participantId: 'p1', displayName: 'Grace Hopper', confidence: 0.9 },
        { trackId: 't2', participantId: 'p2', displayName: 'Alan Turing', confidence: 0.9 },
      ],
    })
  );

  // Write speech segments in track_events
  const events = [
    { type: 'speech-segment', trackId: 't1', participantId: 'p1', displayName: 'Grace Hopper', start_ms: 1000, end_ms: 5000 },
  ];
  fs.writeFileSync(
    path.join(dir, 'meta', 'track_events.ndjson'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  );

  const transcriptionResult = {
    text: '',
    utterances: [
      { speaker: 'Спикер A', text: 'First phrase', start: 1, end: 4 },
      { speaker: 'Спикер A', text: 'Second phrase later', start: 10, end: 15 },
      { speaker: 'Спикер B', text: 'Third phrase', start: 20, end: 25 },
    ],
  };

  const remapped = applyMixedTrackEventSpeakerRemap(transcriptionResult, dir);

  // Utterance 1 overlaps speech-segment -> Grace Hopper
  assert.equal(remapped.utterances[0].speaker, 'Grace Hopper');
  // Utterance 2 has speaker "Спикер A" (no direct speech-segment overlap), remapped via secondary pass -> Grace Hopper
  assert.equal(remapped.utterances[1].speaker, 'Grace Hopper');
  // Utterance 3 has speaker "Спикер B", remapped via secondary pass from participantMap -> Alan Turing
  assert.equal(remapped.utterances[2].speaker, 'Alan Turing');

  assert.ok(remapped.text.includes('Grace Hopper: First phrase'));
  assert.ok(remapped.text.includes('Grace Hopper: Second phrase later'));
  assert.ok(remapped.text.includes('Alan Turing: Third phrase'));

  // Clean up
  fs.rmSync(dir, { recursive: true, force: true });
});
