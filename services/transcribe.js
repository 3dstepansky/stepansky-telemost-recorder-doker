import fs from "fs";
import { AssemblyAI } from 'assemblyai';
import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

const ASSEMBLY_WORD_PAUSE_MS = 800;
const ASSEMBLY_WORD_MAX_CHARS = 240;
const ASSEMBLY_WORD_MAX_DURATION_MS = 15_000;

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function roundSecondsFromMs(value) {
    return Number((value / 1000).toFixed(2));
}

function safeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function formatAssemblySpeaker(speaker, { speakerLabels = true } = {}) {
    const safeSpeaker = safeText(speaker);
    if (!speakerLabels) return safeSpeaker ? `Спикер ${safeSpeaker}` : 'Спикер';
    return `Спикер ${safeSpeaker || 'unknown'}`;
}

function normalizeAssemblyUtterance(utterance, options = {}) {
    const text = safeText(utterance?.text);
    if (!text || !isFiniteNumber(utterance?.start) || !isFiniteNumber(utterance?.end)) return null;
    return {
        speaker: formatAssemblySpeaker(utterance.speaker, options),
        text,
        start: roundSecondsFromMs(utterance.start),
        end: roundSecondsFromMs(Math.max(utterance.end, utterance.start)),
    };
}

function normalizeAssemblyWord(word) {
    const text = safeText(word?.text);
    if (!text || !isFiniteNumber(word?.start) || !isFiniteNumber(word?.end)) return null;
    return {
        text,
        start: Math.max(0, word.start),
        end: Math.max(word.start, word.end),
        speaker: safeText(word.speaker),
    };
}

function wordsToUtterances(words = [], transcriptText = '', options = {}) {
    const normalizedWords = (Array.isArray(words) ? words : [])
        .map(normalizeAssemblyWord)
        .filter(Boolean)
        .sort((a, b) => (a.start - b.start) || (a.end - b.end));

    if (normalizedWords.length === 0) return [];

    const groups = [];
    let current = null;

    for (const word of normalizedWords) {
        const nextText = current ? `${current.text} ${word.text}` : word.text;
        const pauseMs = current ? word.start - current.end : 0;
        const durationMs = current ? word.end - current.start : word.end - word.start;
        const speakerChanged = Boolean(options.speakerLabels && current?.speaker && word.speaker && current.speaker !== word.speaker);
        const shouldSplit = Boolean(current) && (
            pauseMs > ASSEMBLY_WORD_PAUSE_MS ||
            nextText.length > ASSEMBLY_WORD_MAX_CHARS ||
            durationMs > ASSEMBLY_WORD_MAX_DURATION_MS ||
            speakerChanged
        );

        if (shouldSplit) {
            groups.push(current);
            current = null;
        }

        if (!current) {
            current = { text: word.text, start: word.start, end: word.end, speaker: word.speaker };
        } else {
            current.text = nextText;
            current.end = Math.max(current.end, word.end);
            if (!current.speaker && word.speaker) current.speaker = word.speaker;
        }
    }

    if (current) groups.push(current);

    const utterances = groups
        .map((group) => normalizeAssemblyUtterance(group, options))
        .filter(Boolean);

    if (utterances.length === 0 && safeText(transcriptText)) {
        const first = normalizedWords[0];
        const last = normalizedWords[normalizedWords.length - 1];
        return [{
            speaker: formatAssemblySpeaker(first.speaker, options),
            text: safeText(transcriptText),
            start: roundSecondsFromMs(first.start),
            end: roundSecondsFromMs(Math.max(last.end, first.start)),
        }];
    }

    return utterances;
}

function normalizeAssemblyAITranscript(transcript = {}, { speakerLabels = true } = {}) {
    const text = safeText(transcript.text);
    let utterances = (Array.isArray(transcript.utterances) ? transcript.utterances : [])
        .map((utterance) => normalizeAssemblyUtterance(utterance, { speakerLabels }))
        .filter(Boolean);

    if (utterances.length === 0 && !speakerLabels) {
        utterances = wordsToUtterances(transcript.words, text, { speakerLabels });
    }

    return {
        text,
        utterances,
    };
}

/**
 * Транскрибация аудио через AssemblyAI с разделением на спикеров.
 * Поддерживает файлы до 5 ГБ и 10 часов аудио.
 * 
 * @param {string} filePath - Путь к аудио-файлу
 */
export async function transcribeAudioAssemblyAI(filePath, { speakerLabels = true } = {}) {
    if (!process.env.ASSEMBLYAI_API_KEY) {
        throw new Error("ASSEMBLYAI_API_KEY не задан в .env файле");
    }

    const client = new AssemblyAI({ 
        apiKey: process.env.ASSEMBLYAI_API_KEY 
    });

    console.log(`[transcribe] Начинаем транскрибацию через AssemblyAI: ${filePath}`);

    const params = {
        audio: filePath,
        speech_models: ["universal-3-pro", "universal-2"],
        language_detection: true,
        speaker_labels: speakerLabels,
    };

    try {
        const transcript = await client.transcripts.transcribe(params);

        if (transcript.status === 'error') {
            throw new Error(`Ошибка AssemblyAI: ${transcript.error}`);
        }

        console.log("[transcribe] Транскрибация AssemblyAI завершена успешно");

        return normalizeAssemblyAITranscript(transcript, { speakerLabels });
    } catch (error) {
        console.error(`[transcribe] Ошибка во время транскрибации AssemblyAI:`, error.message);
        throw error;
    }
}

/**
 * Резервная транскрибация аудио через Groq (Whisper-large-v3) с поддержкой чанков.
 * 
 * @param {string[]} filePaths - Массив путей к аудио-файлам (исходный или чанки)
 * @param {number} segmentLengthSeconds - Размер сегмента нарезки в секундах
 */
export { normalizeAssemblyAITranscript, wordsToUtterances };

export async function transcribeAudioGroq(filePaths, segmentLengthSeconds = 600) {
    if (!process.env.GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY не задан в .env файле");
    }

    const groq = new Groq({ 
        apiKey: process.env.GROQ_API_KEY,
        maxRetries: 3, 
        timeout: 10 * 60 * 1000 // 10 minutes
    });
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    let fullText = "";
    let allUtterances = [];

    console.log(`[transcribe] Начинаем резервную (Groq) обработку файлов (${paths.length} шт.)`);

    for (const [index, filePath] of paths.entries()) {
        console.log(`[transcribe] (${index + 1}/${paths.length}) Обработка: ${filePath}`);
        
        let success = false;
        let attempts = 0;
        const maxAttempts = 3;

        while (!success && attempts < maxAttempts) {
            attempts++;
            try {
                const transcription = await groq.audio.transcriptions.create({
                    file: fs.createReadStream(filePath),
                    model: "whisper-large-v3",
                    response_format: "verbose_json",
                    language: "ru",
                });

                fullText += (fullText ? " " : "") + transcription.text;

                if (transcription.segments) {
                    const offset = index * segmentLengthSeconds;
                    const mappedSegments = transcription.segments.map(s => ({
                        speaker: "Спикер (Groq)",
                        text: s.text.trim(),
                        start: Number((s.start + offset).toFixed(2)),
                        end: Number((s.end + offset).toFixed(2))
                    }));
                    allUtterances.push(...mappedSegments);
                }
                success = true;
            } catch (error) {
                console.error(`[transcribe] Ошибка транскрибации чанка ${filePath} (попытка ${attempts}/${maxAttempts}):`, error.message);
                if (attempts >= maxAttempts) {
                    throw error;
                }
                console.log(`[transcribe] Повторная попытка через 5 секунд...`);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }

    console.log("[transcribe] Пакетная транскрибация Groq завершена успешно");
    return {
        text: fullText,
        utterances: allUtterances
    };
}
