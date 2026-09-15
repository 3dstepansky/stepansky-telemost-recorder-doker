# Speaker Attribution Architecture — Cycle 3

## Overview
Cycle 3 introduces confidence aggregation, reconnect / track churn resolution, an in-memory Voiceprint Session stub for participant state tracking, and enhanced mixed fallback speaker diarization.

---

## 1. Confidence Aggregation Model

### Formula
Utterance-level confidence (`speaker_confidence`) is computed as:
$$\text{speaker\_confidence} = \min(\text{trackMetadata.confidence}, \min_{w \in \text{words}} w.\text{confidence})$$

- Clamped within $[0, 1]$ range.
- `trackMetadata.confidence` reflects the WebRTC track attribution certainty (e.g. 1.0 for single-participant DOM matches, 0.5 default, 0.0 for unknown).
- `asr_word_confidence` is extracted from ASR word-level confidence scores if present. If no word confidence is available, track confidence is used.

### Audit & Review Flags
- `original_speaker_label`: Preserves the raw speaker string returned by ASR prior to metadata mapping (e.g., `"Спикер A"` or `"Спикер"`).
- `needs_human_review`: Set to `true` when `trackMetadata.confidence < 0.3` AND `!displayName` (no valid display name associated with the speaker).

---

## 2. Reconnect / Track-Churn Handling (`resolveParticipantTracks`)

When participants reconnect, drop, or switch audio devices during a Yandex.Telemost meeting, multiple WebRTC `trackId` entries share the same `participantId`.

### Key Functions
`resolveParticipantTracks(input)`:
- Accepts track metadata (Map, Array, or `metadataIndex`).
- Consolidates multiple tracks under a single `participantId`.
- Chooses the first known (non-`"unknown"`) `displayName` and `speakerName` across all associated tracks.
- Populates `merged_tracks: [trackId, ...]` when `trackIds.length > 1` (or `[]` when $\le 1$).
- Returns `Map<participantId, { speakerName, displayName, trackIds, merged_tracks }>`.

---

## 3. Voiceprint Session Stub (`VoiceprintSession`)

The `VoiceprintSession` class (`services/voiceprintSession.js`) provides an in-memory JVM participant registry for real-time and post-processing participant mapping without requiring external I/O or network dependencies.

### Methods & Export
- `addTrack(participantId, trackId, metadata)`: Associates a track with a participant, updating display names and track list.
- `lookupParticipant(participantId)`: Retrieves participant record or `null`.
- `getAllParticipants()`: Returns array of active participant records.
- `createVoiceprintSession()`: Factory function creating a new `VoiceprintSession` instance.

---

## 4. Mixed Fallback Improvement

When per-track transcription is unavailable (`usedPerTrack: false`), transcription falls back to the mixed single-audio channel (`meeting_audio.webm`).

### Flow
1. **AssemblyAI Diarization**: Invoked with `speakerLabels: true`.
2. **Primary Remap**: `applyMixedTrackEventSpeakerRemap` matches ASR utterances to `speech-segment` events in `meta/track_events.ndjson` based on time overlap (> 0.5s).
3. **Secondary Remap**: Any diarized speaker label (e.g., `"Спикер A"`, `"A"`) that was associated with a participant's `displayName` during primary overlap (or via participant metadata order) is remapped across all remaining utterances.
4. **Groq Fallback**: If AssemblyAI fails, Groq chunked transcription is executed as fallback.

---

## 5. Summary of API Contracts

### Utterance Object Schema (Cycle 3)
```json
{
  "speaker": "Alice",
  "original_speaker_label": "Спикер A",
  "text": "Привет всем",
  "start": 1.25,
  "end": 4.5,
  "trackId": "track-101",
  "participantId": "p-1",
  "displayName": "Alice",
  "speaker_provenance": "dom-active-speaker",
  "speaker_confidence": 0.85,
  "needs_human_review": false,
  "track_recording_offset_ms": 1500,
  "track_recording_offset_provenance": "track-events:track-added"
}
```
