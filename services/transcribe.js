import fs from "fs";
import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

/**
 * Транскрибация аудио через Groq (Whisper-large-v3) с поддержкой чанков.
 * Выполняет пересчет временных меток реплик со смещением.
 * 
 * @param {string[]} filePaths - Массив путей к аудио-файлам (исходный или чанки)
 * @param {number} segmentLengthSeconds - Размер сегмента нарезки в секундах
 */
export async function transcribeAudio(filePaths, segmentLengthSeconds = 1200) {
    if (!process.env.GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY не задан в .env файле");
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    let fullText = "";
    let allUtterances = [];

    console.log(`[transcribe] Начинаем пакетную обработку файлов (${paths.length} шт.)`);

    for (const [index, filePath] of paths.entries()) {
        console.log(`[transcribe] (${index + 1}/${paths.length}) Обработка: ${filePath}`);
        
        try {
            const transcription = await groq.audio.transcriptions.create({
                file: fs.createReadStream(filePath),
                model: "whisper-large-v3",
                response_format: "verbose_json",
                language: "ru",
            });

            // Склеиваем текст
            fullText += (fullText ? " " : "") + transcription.text;

            // Обрабатываем и смещаем тайминги реплик
            if (transcription.segments) {
                const offset = index * segmentLengthSeconds;
                const mappedSegments = transcription.segments.map(s => ({
                    speaker: "Спикер", // В v1 используем общую заглушку
                    text: s.text.trim(),
                    start: Number((s.start + offset).toFixed(2)),
                    end: Number((s.end + offset).toFixed(2))
                }));
                allUtterances.push(...mappedSegments);
            }
        } catch (error) {
            console.error(`[transcribe] Ошибка транскрибации чанка ${filePath}:`, error.message);
            throw error; // Блокирующая ошибка
        }
    }

    console.log("[transcribe] Пакетная транскрибация завершена успешно");
    return {
        text: fullText,
        utterances: allUtterances
    };
}
