/**
 * services/voice-trigger.js
 * Модуль распознавания голосовых триггеров и команд внутри встречи.
 * Поддерживает:
 * 1. Команды корректного выхода (Graceful Exit): «Светочка, покинь встречу», «покинь звонок», «отключись»
 * 2. Активационные слова (Wake Words): «Светочка», «Ассистент», «Бот»
 * 3. Голосовой Q&A роутер для будущей интеграции Full-Duplex диалогов
 */

export const DEFAULT_EXIT_PHRASES = [
  'покинь встречу',
  'покинь звонок',
  'покинь чат',
  'отключись',
  'выйди из встречи',
  'выйди из звонка',
  'заверши запись',
  'закончи запись',
  'останови запись',
  'выходи',
  'leave meeting',
  'leave call',
  'stop recording',
  'exit meeting'
];

export const DEFAULT_WAKE_WORDS = [
  'светочка',
  'света',
  'ассистент',
  'бот',
  'гермес',
  'hermes',
  'assistant'
];

/**
 * Нормализация текста для устойчивого сопоставления команд
 */
export function normalizeSpokenText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'«»]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Анализ распознанной фразы на наличие команд и обращений
 */
export function parseVoiceTrigger(text, options = {}) {
  const exitPhrases = options.exitPhrases || DEFAULT_EXIT_PHRASES;
  const wakeWords = options.wakeWords || DEFAULT_WAKE_WORDS;

  const normalized = normalizeSpokenText(text);
  if (!normalized) {
    return {
      matched: false,
      isExitCommand: false,
      isWakeWord: false,
      command: null,
      wakeWord: null,
      query: null,
      rawText: text
    };
  }

  // 1. Проверка на команду выхода
  const matchedExit = exitPhrases.find(phrase => {
    const normPhrase = normalizeSpokenText(phrase);
    return normalized.includes(normPhrase);
  });

  if (matchedExit) {
    return {
      matched: true,
      isExitCommand: true,
      isWakeWord: false,
      command: 'leave_meeting',
      matchedPhrase: matchedExit,
      rawText: text
    };
  }

  // 2. Проверка на активационное обращение (Wake Word)
  const matchedWake = wakeWords.find(word => {
    const normWord = normalizeSpokenText(word);
    const regex = new RegExp(`\\b${normWord}\\b`, 'i');
    return regex.test(normalized);
  });

  if (matchedWake) {
    // Извлекаем суть вопроса после обращения
    const normWake = normalizeSpokenText(matchedWake);
    const parts = normalized.split(new RegExp(`\\b${normWake}\\b`, 'i'));
    const query = parts.slice(1).join(' ').trim();

    return {
      matched: true,
      isExitCommand: false,
      isWakeWord: true,
      command: 'assistant_query',
      wakeWord: matchedWake,
      query: query || null,
      rawText: text
    };
  }

  return {
    matched: false,
    isExitCommand: false,
    isWakeWord: false,
    command: null,
    rawText: text
  };
}
