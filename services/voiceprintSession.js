function safeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isKnownName(value) {
  const str = safeString(value);
  return str !== null && str.toLowerCase() !== 'unknown';
}

export class VoiceprintSession {
  constructor() {
    this.participants = new Map();
  }

  addTrack(participantId, trackId, metadata = {}) {
    if (!participantId) return null;
    const pid = String(participantId).trim();
    if (!pid) return null;

    let entry = this.participants.get(pid);
    if (!entry) {
      entry = {
        participantId: pid,
        trackIds: [],
        displayName: null,
        speakerName: 'unknown',
      };
      this.participants.set(pid, entry);
    }

    if (trackId) {
      const tid = String(trackId).trim();
      if (tid && !entry.trackIds.includes(tid)) {
        entry.trackIds.push(tid);
      }
    }

    const candDisplayName = safeString(metadata.displayName);
    const candSpeakerName = safeString(metadata.speakerName);

    if (!isKnownName(entry.displayName) && isKnownName(candDisplayName)) {
      entry.displayName = candDisplayName;
    }
    if (!isKnownName(entry.speakerName) && isKnownName(candSpeakerName)) {
      entry.speakerName = candSpeakerName;
    }

    if (!isKnownName(entry.speakerName) && isKnownName(entry.displayName)) {
      entry.speakerName = entry.displayName;
    }
    if (!isKnownName(entry.displayName) && isKnownName(entry.speakerName)) {
      entry.displayName = entry.speakerName;
    }

    return entry;
  }

  lookupParticipant(participantId) {
    if (!participantId) return null;
    const pid = String(participantId).trim();
    return this.participants.get(pid) || null;
  }

  getAllParticipants() {
    return Array.from(this.participants.values());
  }
}

export function createVoiceprintSession() {
  return new VoiceprintSession();
}
