import fs from "fs";
import { AssemblyAI } from 'assemblyai';
import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

/**
 * Транскрибация аудио через AssemblyAI с разделением на спикеров.
 * Поддерживает файлы до 5 ГБ и 10 часов аудио.
 * 
 * @param {string} filePath - Путь к аудио-файлу
 */
export async function transcribeAudioAssemblyAI(filePath) {
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
        speaker_labels: true,
        language_code: "ru"
    };

    try {
        const transcript = await client.transcripts.transcribe(params);

        if (transcript.status === 'error') {
            throw new Error(`Ошибка AssemblyAI: ${transcript.error}`);
        }

        console.log("[transcribe] Транскрибация AssemblyAI завершена успешно");

        const allUtterances = (transcript.utterances || []).map(u => ({
            speaker: `Спикер ${u.speaker}`,
            text: u.text,
            start: Number((u.start / 1000).toFixed(2)),
            end: Number((u.end / 1000).toFixed(2))
        }));

        return {
            text: transcript.text,
            utterances: allUtterances
        };
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
