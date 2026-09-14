const UNKNOWN_SPEAKER = 'unknown';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeName(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (/^(unknown|undefined|null|audio|microphone|default)$/i.test(cleaned)) return null;
  return cleaned;
}

function normalizeParticipantMetadata(candidate = {}) {
  const displayName = sanitizeName(candidate.displayName || candidate.name || candidate.title || candidate.label);
  const participantId = typeof candidate.participantId === 'string' && candidate.participantId.trim()
    ? candidate.participantId.trim()
    : null;
  const confidence = isFiniteNumber(candidate.confidence)
    ? Math.max(0, Math.min(1, candidate.confidence))
    : (displayName || participantId ? 0.5 : 0);

  return {
    participantId,
    displayName,
    speakerName: displayName || UNKNOWN_SPEAKER,
    provenance: candidate.provenance || (displayName || participantId ? 'metadata' : 'fallback:unknown'),
    confidence,
  };
}

function unknownSpeakerMetadata(provenance = 'fallback:unknown') {
  return normalizeParticipantMetadata({ provenance, confidence: 0 });
}

function createMeetingClock({ wallStartMs = null, monoStartMs = null } = {}) {
  let originWallStartMs = isFiniteNumber(wallStartMs) ? wallStartMs : null;
  let originMonoStartMs = isFiniteNumber(monoStartMs) ? monoStartMs : null;
  let lastMs = 0;

  function ensureStarted(inputMonoMs = 0, inputWallMs = Date.now()) {
    if (originMonoStartMs === null) {
      originMonoStartMs = isFiniteNumber(inputMonoMs) ? inputMonoMs : 0;
      originWallStartMs = isFiniteNumber(inputWallMs) ? inputWallMs : Date.now();
    }
    return originMonoStartMs;
  }

  return {
    get wallStartMs() {
      return originWallStartMs;
    },
    get monoStartMs() {
      return originMonoStartMs;
    },
    isStarted() {
      return originMonoStartMs !== null;
    },
    start(inputMonoMs = 0, inputWallMs = Date.now()) {
      ensureStarted(inputMonoMs, inputWallMs);
      return 0;
    },
    relative(inputMonoMs) {
      if (originMonoStartMs === null) return 0;
      const raw = isFiniteNumber(inputMonoMs) ? inputMonoMs - originMonoStartMs : 0;
      return Math.max(0, Math.round(raw));
    },
    now(inputMonoMs) {
      ensureStarted(inputMonoMs);
      const rounded = this.relative(inputMonoMs);
      lastMs = Math.max(lastMs, rounded);
      return lastMs;
    },
    isoAt(relativeMs) {
      const safeRelative = isFiniteNumber(relativeMs) ? Math.max(0, relativeMs) : lastMs;
      return new Date((originWallStartMs ?? Date.now()) + safeRelative).toISOString();
    },
  };
}

function normalizeSpeechSegment({ startMonoMs, endMonoMs, clock }) {
  if (!clock || typeof clock.now !== 'function') {
    throw new Error('normalizeSpeechSegment requires a meeting clock');
  }
  const start_ms = clock.relative(startMonoMs);
  const end_ms = Math.max(start_ms, clock.now(endMonoMs));
  return { start_ms, end_ms };
}

function pickBestMetadata(candidates = []) {
  if (!Array.isArray(candidates) || candidates.length === 0) return unknownSpeakerMetadata();
  const normalized = candidates.map(normalizeParticipantMetadata);
  normalized.sort((a, b) => b.confidence - a.confidence);
  const best = normalized[0];
  return best && (best.displayName || best.participantId) ? best : unknownSpeakerMetadata(best?.provenance || 'fallback:unknown');
}

function resolveTrackMetadata({ track = {}, streams = [], participantSnapshots = [] } = {}) {
  const trackId = track.id || null;
  const streamIds = streams.map((s) => s && s.id).filter(Boolean);

  const exact = participantSnapshots.find((p) => {
    const ids = [p.trackId, p.mediaTrackId, p.streamId, ...(Array.isArray(p.streamIds) ? p.streamIds : [])].filter(Boolean);
    return (trackId && ids.includes(trackId)) || streamIds.some((id) => ids.includes(id));
  });

  if (exact) {
    return normalizeParticipantMetadata({
      participantId: exact.participantId || exact.userId || null,
      displayName: exact.displayName || exact.name || null,
      provenance: exact.provenance || 'participant-snapshot:exact-track-or-stream-match',
      confidence: isFiniteNumber(exact.confidence) ? exact.confidence : 0.9,
    });
  }

  return unknownSpeakerMetadata('fallback:unknown:no-safe-track-participant-match');
}

export {
  UNKNOWN_SPEAKER,
  createMeetingClock,
  normalizeSpeechSegment,
  normalizeParticipantMetadata,
  unknownSpeakerMetadata,
  pickBestMetadata,
  resolveTrackMetadata,
};
