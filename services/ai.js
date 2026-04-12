import Groq from 'groq-sdk';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Транскрибирует аудио через Groq Whisper-v3
 * @param {string} filePath - Путь к аудио файлу
 */
export async function transcribe(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Файл не найден: ${filePath}`);
  }

  try {
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-large-v3",
      response_format: "verbose_json",
      language: "ru",
    });

    // Извлекаем utterances (фрагменты речи) если доступны
    const segments = transcription.segments || [];
    const utterances = segments.map(s => ({
      speaker: "Спикер", // Whisper не делает диаризацию сам, мы ставим заглушку
      text: s.text.trim(),
      start: s.start,
      end: s.end
    }));

    return {
      text: transcription.text,
      utterances: utterances,
      speaker_count: 1 // По умолчанию для Whisper
    };
  } catch (error) {
    console.error("Groq Transcribe Error:", error);
    throw error;
  }
}
