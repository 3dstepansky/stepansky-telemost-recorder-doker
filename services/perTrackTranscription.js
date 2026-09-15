import fs from 'fs';
import path from 'path';
import { segmentAudioIfNecessary, convertToMp3 } from './ffmpeg.js';
import { transcribeAudioAssemblyAI, transcribeAudioGroq } from './transcribe.js';

const UNKNOWN_SPEAKER = 'unknown';
const DEFAULT_GROQ_SEGMENT_SECONDS = 600;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function roundSeconds(value) {
  return Number(value.toFixed(2));
}

function safeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeSpeakerName(metadata = {}) {
  const speakerName = safeString(metadata.speakerName);
  const displayName = safeString(metadata.displayName);
  if (speakerName && speakerName.toLowerCase() !== UNKNOWN_SPEAKER) return speakerName;
  return displayName || speakerName || UNKNOWN_SPEAKER;
}

function parseJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

function readTrackEvents(metaDir) {
  const eventsPath = path.join(metaDir, 'track_events.ndjson');
  if (!fs.existsSync(eventsPath)) return [];

  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

function eventRelativeMs(event = {}) {
  for (const key of ['recording_offset_ms', 'recordingOffsetMs', 'meeting_relative_ms', 't_ms', 'start_ms']) {
    if (isFiniteNumber(event[key])) return Math.max(0, Math.round(event[key]));
  }
  return null;
}

function normalizeTrackMetadata(raw = {}, fallbackTrackId = null) {
  const trackId = safeString(raw.trackId) || fallbackTrackId;
  const offsetMs = isFiniteNumber(raw.recordingOffsetMs)
    ? Math.max(0, Math.round(raw.recordingOffsetMs))
    : (isFiniteNumber(raw.recording_offset_ms) ? Math.max(0, Math.round(raw.recording_offset_ms)) : null);

  return {
    trackId,
    speakerName: safeSpeakerName(raw),
    participantId: safeString(raw.participantId),
    displayName: safeString(raw.displayName),
    provenance: safeString(raw.provenance) || 'fallback:unknown:no-safe-track-participant-match',
    confidence: isFiniteNumber(raw.confidence) ? raw.confidence : 0,
    recordingOffsetMs: offsetMs,
    recordingOffsetProvenance: safeString(raw.recordingOffsetProvenance) || safeString(raw.recording_offset_provenance) || null,
    label: safeString(raw.label),
  };
}

function loadTrackMetadata(recordingDir) {
  const metaDir = path.join(recordingDir, 'meta');
  const summary = parseJsonFile(path.join(metaDir, 'tracks_summary.json'), { tracks: [] }) || { tracks: [] };
  const events = readTrackEvents(metaDir);
  const byTrackId = new Map();

  for (const track of Array.isArray(summary.tracks) ? summary.tracks : []) {
    const normalized = normalizeTrackMetadata(track);
    if (normalized.trackId) byTrackId.set(normalized.trackId, normalized);
  }

  for (const event of events) {
    if (!event || !event.trackId) continue;
    const current = byTrackId.get(event.trackId) || normalizeTrackMetadata({ trackId: event.trackId });

    if (event.type === 'track-added') {
      const offsetMs = eventRelativeMs(event);
      byTrackId.set(event.trackId, {
        ...current,
        ...normalizeTrackMetadata({ ...current, ...event, trackId: event.trackId }),
        recordingOffsetMs: current.recordingOffsetMs ?? offsetMs ?? 0,
        recordingOffsetProvenance: current.recordingOffsetProvenance || (offsetMs === null ? 'fallback:zero:no-track-added-offset' : 'track-events:track-added'),
      });
    } else if (!byTrackId.has(event.trackId)) {
      byTrackId.set(event.trackId, normalizeTrackMetadata({ ...event, trackId: event.trackId }));
    }
  }

  return {
    summary,
    events,
    byTrackId,
  };
}

function getTrackMetadata(metadataIndex, trackId) {
  const metadata = metadataIndex.byTrackId.get(trackId);
  if (metadata) {
    return {
      ...metadata,
      recordingOffsetMs: metadata.recordingOffsetMs ?? 0,
      recordingOffsetProvenance: metadata.recordingOffsetProvenance || 'fallback:zero:no-track-added-offset',
    };
  }

  return normalizeTrackMetadata({
    trackId,
    speakerName: UNKNOWN_SPEAKER,
    provenance: 'fallback:unknown:missing-track-metadata',
    confidence: 0,
    recordingOffsetMs: 0,
    recordingOffsetProvenance: 'fallback:zero:no-track-added-offset',
  }, trackId);
}

function findValidTrackFiles(recordingDir, { minBytes = 1 } = {}) {
  const tracksDir = path.join(recordingDir, 'tracks');
  if (!fs.existsSync(tracksDir)) return [];

  return fs.readdirSync(tracksDir)
    .filter((file) => file.endsWith('.webm'))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => {
      const filePath = path.join(tracksDir, file);
      const stat = fs.statSync(filePath);
      return {
        trackId: path.basename(file, '.webm'),
        filePath,
        bytes: stat.size,
      };
    })
    .filter((track) => track.bytes >= minBytes);
}

function mergeTrackUtterances(trackResults) {
  const utterances = [];

  for (const trackResult of trackResults) {
    const offsetSeconds = (trackResult.metadata.recordingOffsetMs || 0) / 1000;
    const sourceUtterances = Array.isArray(trackResult.result?.utterances) ? trackResult.result.utterances : [];

    sourceUtterances.forEach((utterance, index) => {
      const localStart = isFiniteNumber(utterance.start) ? utterance.start : 0;
      const localEnd = isFiniteNumber(utterance.end) ? utterance.end : localStart;
      const start = roundSeconds(Math.max(0, localStart + offsetSeconds));
      const end = roundSeconds(Math.max(start, localEnd + offsetSeconds));
      const speakerName = safeSpeakerName(trackResult.metadata);

      utterances.push({
        ...utterance,
        speaker: speakerName,
        text: utterance.text || '',
        start,
        end,
        trackId: trackResult.trackId,
        participantId: trackResult.metadata.participantId,
        displayName: trackResult.metadata.displayName,
        speaker_provenance: trackResult.metadata.provenance,
        speaker_confidence: trackResult.metadata.confidence,
        track_recording_offset_ms: trackResult.metadata.recordingOffsetMs || 0,
        track_recording_offset_provenance: trackResult.metadata.recordingOffsetProvenance || 'fallback:zero:no-track-added-offset',
        source_utterance_index: index,
      });
    });
  }

  utterances.sort((a, b) =>
    (a.start - b.start) ||
    (a.end - b.end) ||
    String(a.trackId).localeCompare(String(b.trackId)) ||
    ((a.source_utterance_index || 0) - (b.source_utterance_index || 0))
  );

  return utterances;
}

function formatTranscriptText(utterances) {
  return utterances.map((u) => `${u.speaker || UNKNOWN_SPEAKER}: ${u.text || ''}`.trim()).join('\n').trim();
}

function normalizeTranscriptionResult(result = {}) {
  const utterances = (Array.isArray(result.utterances) ? result.utterances : [])
    .map((utterance) => ({
      ...utterance,
      text: safeString(utterance?.text) || '',
    }))
    .filter((utterance) => utterance.text.length > 0);
  const text = safeString(result.text) || formatTranscriptText(utterances);

  if (utterances.length === 0 && text) {
    utterances.push({ speaker: UNKNOWN_SPEAKER, text, start: 0, end: 0 });
  }

  return {
    ...result,
    text,
    utterances,
  };
}

function hasUsableTranscription(result = {}) {
  const normalized = normalizeTranscriptionResult(result);
  return normalized.text.length > 0 || normalized.utterances.length > 0;
}

async function transcribeAudioWithFallback(filePath, {
  singleTrack = false,
  assemblyFn = transcribeAudioAssemblyAI,
  groqFn = transcribeAudioGroq,
  convertFn = convertToMp3,
  segmentFn = segmentAudioIfNecessary,
  groqSegmentSeconds = DEFAULT_GROQ_SEGMENT_SECONDS,
} = {}) {
  try {
    const mp3Path = await convertFn(filePath);
    const result = await assemblyFn(mp3Path, { speakerLabels: !singleTrack });
    return { result, provider: 'assemblyai', mp3Path };
  } catch (assemblyError) {
    const chunks = await segmentFn(filePath, groqSegmentSeconds);
    const result = await groqFn(chunks, groqSegmentSeconds);
    return { result, provider: 'groq', assemblyError };
  }
}

async function transcribeTracks(recordingDir, options = {}) {
  const metadataIndex = loadTrackMetadata(recordingDir);
  const validTracks = findValidTrackFiles(recordingDir, options);
  const diagnostics = {
    attempted: validTracks.length,
    successes: [],
    failures: [],
    noSpeech: [],
    skipped: [],
  };

  if (validTracks.length === 0) {
    return {
      usedPerTrack: false,
      reason: 'no-valid-track-files',
      diagnostics,
    };
  }

  const successes = [];
  for (const track of validTracks) {
    const metadata = getTrackMetadata(metadataIndex, track.trackId);
    try {
      const { result, provider } = await transcribeAudioWithFallback(track.filePath, { ...options, singleTrack: true });
      const normalizedResult = normalizeTranscriptionResult(result);
      if (!hasUsableTranscription(normalizedResult)) {
        diagnostics.noSpeech.push({
          trackId: track.trackId,
          provider,
          bytes: track.bytes,
          speakerName: metadata.speakerName,
          reason: 'empty-transcription',
        });
        continue;
      }

      successes.push({ ...track, metadata, result: normalizedResult, provider });
      diagnostics.successes.push({
        trackId: track.trackId,
        provider,
        bytes: track.bytes,
        speakerName: metadata.speakerName,
        utteranceCount: normalizedResult.utterances.length,
        textLength: normalizedResult.text.length,
      });
    } catch (error) {
      diagnostics.failures.push({
        trackId: track.trackId,
        filePath: track.filePath,
        bytes: track.bytes,
        error: error.message,
      });
    }
  }

  if (successes.length === 0) {
    return {
      usedPerTrack: false,
      reason: diagnostics.noSpeech.length > 0 ? 'no-track-speech' : 'all-track-asr-failed',
      diagnostics,
    };
  }

  const utterances = mergeTrackUtterances(successes);
  if (utterances.length === 0 || !formatTranscriptText(utterances)) {
    return {
      usedPerTrack: false,
      reason: 'no-usable-track-transcript',
      diagnostics,
    };
  }

  return {
    usedPerTrack: true,
    text: formatTranscriptText(utterances),
    utterances,
    provider: successes.map((s) => s.provider).join('+'),
    track_diagnostics: diagnostics,
  };
}

export {
  UNKNOWN_SPEAKER,
  DEFAULT_GROQ_SEGMENT_SECONDS,
  findValidTrackFiles,
  formatTranscriptText,
  getTrackMetadata,
  loadTrackMetadata,
  mergeTrackUtterances,
  normalizeTranscriptionResult,
  hasUsableTranscription,
  transcribeAudioWithFallback,
  transcribeTracks,
};
