export class MeetingProcessRegistry {
  constructor() {
    this.processes = new Map();
  }

  key(chatId, meetingId) {
    return `${chatId}:${meetingId}`;
  }

  register(chatId, meetingId, child) {
    this.processes.set(this.key(chatId, meetingId), child);
    return child;
  }

  get(chatId, meetingId) {
    return this.processes.get(this.key(chatId, meetingId));
  }

  unregister(chatId, meetingId, child) {
    const key = this.key(chatId, meetingId);
    if (this.processes.get(key) === child) this.processes.delete(key);
  }

  stop(chatId, meetingId) {
    return this.processes.has(this.key(chatId, meetingId));
  }
}
