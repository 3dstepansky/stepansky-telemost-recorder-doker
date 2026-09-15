# Speaker attribution Cycle 2: per-track ASR and timeline merge

Cycle 2 транскрибирует индивидуальные `tracks/<trackId>.webm` до mixed fallback. Цель — не пытаться угадывать говорящего внутри общего микса, а использовать уже разделённые WebRTC-аудиотреки и консервативную metadata из Cycle 1.

## Flow

1. `transcribe.js` определяет директорию записи рядом с `meeting_audio.webm`.
2. `services/perTrackTranscription.js` ищет валидные `tracks/*.webm`.
3. Для каждого трека запускается существующий ASR fallback chain:
   - AssemblyAI по MP3, но с `speaker_labels: false`, потому что один файл соответствует одному WebRTC track;
   - когда AssemblyAI при `speaker_labels:false` не возвращает `utterances`, результат нормализуется из `words` с timestamps: слова детерминированно группируются по паузе/длине/длительности, без `Спикер undefined`;
   - затем Groq Whisper fallback через существующую сегментацию.
4. Metadata берётся из `meta/tracks_summary.json` и `meta/track_events.ndjson`:
   - `speakerName`/`displayName`/`participantId`/`confidence`/`provenance` сохраняются на utterance;
   - если `speakerName` равен placeholder `unknown`, но есть реальный `displayName`, speaker берётся из `displayName`;
   - если безопасного соответствия нет, speaker остаётся честным `unknown`, без синтетических `Трек abcd`.
5. Utterances всех успешных треков объединяются по общей audio-relative timeline.

## Timeline merge

ASR внутри отдельного трека возвращает локальные timestamps от начала файла этого трека. Cycle 2 переводит их в общее время встречи:

```text
meeting_start = utterance.start + track_recording_offset_ms / 1000
meeting_end   = utterance.end   + track_recording_offset_ms / 1000
```

Сортировка deterministic:

1. `start`
2. `end`
3. `trackId`
4. исходный индекс utterance внутри трека

Overlap не ремапится и не сдвигается. Если два человека говорят одновременно, их интервалы остаются пересекающимися; порядок только стабилизирует вывод.

## Track recording offset accuracy

Отдельный `MediaRecorder` может стартовать на миллисекунды позже mixed recorder origin. Cycle 1 metadata теперь сохраняет:

- `recording_offset_ms`
- `recording_offset_provenance`

в `track-added` event, а также `recordingOffsetMs` / `recordingOffsetProvenance` в `tracks_summary.json`.

Текущая точность консервативная: offset равен audio-relative времени `track-added` относительно старта mixed recorder (`track-added:conservative-mediarecorder-start-offset`). Это не измерение первого encoded WebM sample, но оно безопасно не включает page-load delay и достаточно стабильно для merge. Для первого трека offset обычно `0`; поздние треки получают offset своего появления.

## Failure behavior

- Нет `tracks/*.webm`, файлы пустые/невалидные или все per-track ASR вызовы упали → `transcribe.js` безопасно использует существующий mixed pipeline.
- Канал с успешным ASR, но пустым нормализованным `text`/`utterances`, считается `noSpeech`, а не ошибкой: он попадает в `track_diagnostics.noSpeech` и не мешает сохранить другие успешные каналы.
- Если ни один канал не дал речи (`noSpeech` для всех или комбинация `noSpeech` + ошибок без успехов), `transcribeTracks` возвращает `usedPerTrack:false`, чтобы внешний pipeline сделал mixed fallback.
- Частичный успех не теряется: успешные каналы попадают в transcript, а failed каналы записываются в `track_diagnostics.failures` и stderr.
- Mixed fallback сохраняет прежний контракт `transcript`, `utterances`, `speaker_count`, Mongo/wiki/Telegram output. Cycle 2 добавляет только диагностическое поле `track_transcription` в JSON output, если per-track путь был использован.

## Contracts

Не изменяются:

- `transcript.txt` — plain text transcript;
- Mongo `saveMeetingResult({ transcript, summary, transcriptionResult, ... })`;
- wiki raw ingest inputs;
- Telegram summary/files notification;
- top-level JSON fields (`transcript`, `summary`, `utterances`, `speaker_count`, `utterance_count`).

Per-track utterances добавляют диагностические поля (`trackId`, `speaker_provenance`, `speaker_confidence`, `track_recording_offset_ms`), но сохраняют базовые `speaker`, `text`, `start`, `end`.
