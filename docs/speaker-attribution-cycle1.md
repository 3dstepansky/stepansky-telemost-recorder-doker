# Speaker attribution Cycle 1

Cycle 1 adds conservative speaker metadata logging for Telemost recordings without changing the existing transcription pipeline contract.

## Time model

All `track_events.ndjson` events use one audio-relative monotonic clock. The origin is **not** page load or `evaluateOnNewDocument`; it is initialized when the mixed `meeting_audio.webm` recording starts (the first remote audio track that triggers `mixRecorder`). This keeps ASR timestamps, VAD `speech-segment` offsets, and `track-added` events on the same zero point.

- `t_ms` / `meeting_relative_ms`: event timestamp in milliseconds from mixed-audio origin.
- `ts`: ISO wall-clock timestamp derived from the same mixed-audio origin.
- `speech-segment.start_ms` and `speech-segment.end_ms`: mixed-audio-relative offsets, not per-track offsets.
- The first pre-origin `track-added` candidate is clamped/buffered to zero rather than going negative; later tracks reuse the same origin and event timestamps are monotonic.

`start_ms`/`end_ms` are kept for backward compatibility with `transcribe.js`, which still matches transcription utterances to VAD segments by overlap.

## Speaker metadata model

`track-added`, `speech-segment`, and `tracks_summary.json` entries include:

```json
{
  "trackId": "...",
  "speakerName": "unknown",
  "participantId": null,
  "displayName": null,
  "provenance": "fallback:unknown:no-safe-track-participant-match",
  "confidence": 0
}
```

When the browser can find an exact DOM-exposed Telemost participant key matching the WebRTC `track.id` or one of the remote `MediaStream.id` values, the recorder writes the matched `participantId`/`displayName`, provenance, and higher confidence. Otherwise it writes `unknown` with explicit fallback provenance.

## Safety constraints

Cycle 1 deliberately does **not** infer speaker identity from participant order, visible tile order, last active speaker UI, or WebRTC track arrival order. Those signals can be wrong after reconnects, muted/unmuted tracks, or layout changes.

No per-track transcription, voiceprints, or mixed-audio diarization are introduced in this cycle. Mixed diarization can remain a future fallback, but primary attribution should come from reliable track metadata when Telemost exposes it.

## Known limitations

- Telemost may not expose stable `participantId`/`displayName` keys in DOM attributes accessible to this recorder version.
- Exact mapping requires a live meeting/browser state; unit tests cover normalization and conservative resolver behavior, not Telemost production DOM.
- Without a live meeting with multiple remote participants, we cannot verify that Telemost currently publishes track/stream IDs in the page state.
