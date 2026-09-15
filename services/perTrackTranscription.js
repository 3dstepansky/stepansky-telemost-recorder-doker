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

function isKnownName(value) {
  const str = safeString(value);
  return str !== null && str.toLowerCase() !== UNKNOWN_SPEAKER;
}

function safeSpeakerName(metadata = {}) {
  const speakerName = safeString(metadata.speakerName);
  const displayName = safeString(metadata.displayName);
  if (speakerName && speakerName.toLowerCase() !== UNKNOWN_SPEAKER) return speakerName;
  return displayName || speakerName || UNKNOWN_SPEAKER;
}

function enrichUtteranceConfidence(utterance = {}, trackMetadata = {}) {
  const trackConfidence = isFiniteNumber(trackMetadata.confidence)
    ? Math.max(0, Math.min(1, trackMetadata.confidence))
    : 0;

  let minWordConfidence = 1;
  if (Array.isArray(utterance.words) && utterance.words.length > 0) {
    let foundWordConfidence = false;
    for (const w of utterance.words) {
      if (w && isFiniteNumber(w.confidence)) {
        foundWordConfidence = true;
        minWordConfidence = Math.min(minWordConfidence, Math.max(0, Math.min(1, w.confidence)));
      }
    }
    if (!foundWordConfidence) {
      minWordConfidence = 1;
    }
  }

  const rawConfidence = Math.min(trackConfidence, minWordConfidence);
  const speaker_confidence = Number(rawConfidence.toFixed(2));
  const displayName = safeString(trackMetadata.displayName) || safeString(utterance.displayName);
  const needs_human_review = trackConfidence < 0.3 && !displayName;
  const original_speaker_label = utterance.speaker !== undefined ? utterance.speaker : null;

  return {
    speaker_confidence,
    needs_human_review,
    original_speaker_label,
  };
}

function resolveParticipantTracks(input) {
  let tracks = [];
  if (input && input.byTrackId instanceof Map) {
    tracks = Array.from(input.byTrackId.values());
  } else if (input instanceof Map) {
    tracks = Array.from(input.values());
  } else if (Array.isArray(input)) {
    tracks = input;
  }

  const resultMap = new Map();

  for (const track of tracks) {
    if (!track) continue;
    const participantId = safeString(track.participantId);
    if (!participantId) continue;

    const trackId = safeString(track.trackId);
    let entry = resultMap.get(participantId);
    if (!entry) {
      entry = {
        speakerName: UNKNOWN_SPEAKER,
        displayName: null,
        trackIds: [],
        merged_tracks: [],
      };
      resultMap.set(participantId, entry);
    }

    if (trackId && !entry.trackIds.includes(trackId)) {
      entry.trackIds.push(trackId);
    }

    const candDisplayName = safeString(track.displayName);
    const candSpeakerName = safeString(track.speakerName);

    if (!isKnownName(entry.displayName) && isKnownName(candDisplayName)) {
      entry.displayName = candDisplayName;
    }
    if (!isKnownName(entry.speakerName) && isKnownName(candSpeakerName)) {
      entry.speakerName = candSpeakerName;
    }
  }

  for (const [pid, entry] of resultMap.entries()) {
    if (!isKnownName(entry.speakerName) && isKnownName(entry.displayName)) {
      entry.speakerName = entry.displayName;
    }
    if (!isKnownName(entry.displayName) && isKnownName(entry.speakerName)) {
      entry.displayName = entry.speakerName;
    }
    if (entry.trackIds.length > 1) {
      entry.merged_tracks = [...entry.trackIds];
    } else {
      entry.merged_tracks = [];
    }
  }

  return resultMap;
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
      const confidenceInfo = enrichUtteranceConfidence(utterance, trackResult.metadata);

      utterances.push({
        ...utterance,
        speaker: speakerName,
        original_speaker_label: confidenceInfo.original_speaker_label,
        text: utterance.text || '',
        start,
        end,
        trackId: trackResult.trackId,
        participantId: trackResult.metadata.participantId,
        displayName: trackResult.metadata.displayName,
        speaker_provenance: trackResult.metadata.provenance,
        speaker_confidence: confidenceInfo.speaker_confidence,
        needs_human_review: confidenceInfo.needs_human_review,
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

function applyMixedTrackEventSpeakerRemap(transcriptionResult, recordingDir) {
  if (!transcriptionResult || !Array.isArray(transcriptionResult.utterances) || transcriptionResult.utterances.length === 0) {
    return transcriptionResult;
  }

  const trackEventsPath = recordingDir ? path.join(recordingDir, 'meta', 'track_events.ndjson') : null;
  const eventsRaw = (trackEventsPath && fs.existsSync(trackEventsPath)) ? fs.readFileSync(trackEventsPath, 'utf-8') : '';
  const segments = [];

  if (eventsRaw) {
    eventsRaw.split('\n').forEach(line => {
      if (!line.trim()) return;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'speech-segment') {
          segments.push(ev);
        }
      } catch(e) {}
    });
  }

  let metadataIndex = null;
  let participantMap = null;
  if (recordingDir && fs.existsSync(recordingDir)) {
    try {
      metadataIndex = loadTrackMetadata(recordingDir);
      participantMap = resolveParticipantTracks(metadataIndex);
    } catch (e) {}
  }

  const diarizedToDisplayName = new Map();

  function isDiarizedLabel(label) {
    if (typeof label !== 'string') return false;
    const trimmed = label.trim();
    return /^Спикер\s+[A-Z0-9]+$/i.test(trimmed) || /^[A-Z]$/i.test(trimmed);
  }

  function getDisplayNameForSegment(seg) {
    if (!seg) return null;
    let name = safeString(seg.displayName) || safeString(seg.speakerName);
    if (name && name.toLowerCase() !== UNKNOWN_SPEAKER) return name;

    if (seg.trackId && metadataIndex && metadataIndex.byTrackId.has(seg.trackId)) {
      const meta = metadataIndex.byTrackId.get(seg.trackId);
      if (meta && isKnownName(meta.displayName)) return meta.displayName;
      if (meta && isKnownName(meta.speakerName)) return meta.speakerName;
      if (meta && meta.participantId && participantMap && participantMap.has(meta.participantId)) {
        const p = participantMap.get(meta.participantId);
        if (isKnownName(p.displayName)) return p.displayName;
        if (isKnownName(p.speakerName)) return p.speakerName;
      }
    }

    if (seg.participantId && participantMap && participantMap.has(seg.participantId)) {
      const p = participantMap.get(seg.participantId);
      if (isKnownName(p.displayName)) return p.displayName;
      if (isKnownName(p.speakerName)) return p.speakerName;
    }

    return null;
  }

  // Pass 1: Primary remap by track_events speech-segment overlap
  if (segments.length > 0) {
    for (const utt of transcriptionResult.utterances) {
      const origSpeaker = utt.speaker;
      let bestMatch = null;
      let maxOverlap = 0;

      for (const seg of segments) {
        const segStart = seg.start_ms / 1000;
        const segEnd = seg.end_ms / 1000;
        const overlapStart = Math.max(utt.start, segStart);
        const overlapEnd = Math.min(utt.end, segEnd);
        const overlap = overlapEnd - overlapStart;

        if (overlap > maxOverlap) {
          maxOverlap = overlap;
          bestMatch = seg;
        }
      }

      if (bestMatch && maxOverlap > 0.5) {
        const resolvedName = getDisplayNameForSegment(bestMatch) || safeString(bestMatch.displayName) || safeString(bestMatch.speakerName) || UNKNOWN_SPEAKER;
        utt.speaker = resolvedName;

        if (isDiarizedLabel(origSpeaker) && isKnownName(resolvedName)) {
          diarizedToDisplayName.set(origSpeaker, resolvedName);
          const rawLetter = origSpeaker.replace(/^Спикер\s+/i, '').trim();
          diarizedToDisplayName.set(rawLetter, resolvedName);
          diarizedToDisplayName.set(`Спикер ${rawLetter}`, resolvedName);
        }
      }
    }
  }

  // Fallback for Pass 1: If diarized labels exist but were not mapped by speech-segments, check participantMap in order
  if (participantMap && participantMap.size > 0) {
    const knownParticipants = Array.from(participantMap.values()).filter(p => isKnownName(p.displayName) || isKnownName(p.speakerName));
    const diarizedLabelsFound = [];
    for (const utt of transcriptionResult.utterances) {
      if (isDiarizedLabel(utt.speaker)) {
        const rawLetter = utt.speaker.replace(/^Спикер\s+/i, '').trim();
        if (!diarizedLabelsFound.includes(rawLetter)) {
          diarizedLabelsFound.push(rawLetter);
        }
      }
    }
    diarizedLabelsFound.forEach((letter, index) => {
      if (index < knownParticipants.length) {
        const p = knownParticipants[index];
        const name = p.displayName || p.speakerName;
        if (!diarizedToDisplayName.has(letter)) {
          diarizedToDisplayName.set(letter, name);
          diarizedToDisplayName.set(`Спикер ${letter}`, name);
        }
      }
    });
  }

  // Pass 2: Secondary remap for diarized speakers "Спикер A/B/C" or "A/B/C" -> displayName from metadata/mapping
  for (const utt of transcriptionResult.utterances) {
    if (isDiarizedLabel(utt.speaker)) {
      if (diarizedToDisplayName.has(utt.speaker)) {
        utt.speaker = diarizedToDisplayName.get(utt.speaker);
      } else {
        const rawLetter = utt.speaker.replace(/^Спикер\s+/i, '').trim();
        if (diarizedToDisplayName.has(rawLetter)) {
          utt.speaker = diarizedToDisplayName.get(rawLetter);
        }
      }
    }
  }

  let newText = '';
  for (const utt of transcriptionResult.utterances) {
    newText += `${utt.speaker}: ${utt.text}\n`;
  }
  transcriptionResult.text = newText.trim();

  return transcriptionResult;
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
  enrichUtteranceConfidence,
  resolveParticipantTracks,
  applyMixedTrackEventSpeakerRemap,
};
