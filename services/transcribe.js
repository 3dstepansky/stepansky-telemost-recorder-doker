import fs from "fs";
import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

/**
 * Транскрибация аудио через Groq (Whisper-large-v3).
 * Бесплатно, быстро и качественно.
 */
export async function transcribeAudio(filePaths) {
    if (!process.env.GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY не задан в .env файле");
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    let fullText = "";
    let allSegments = [];

    console.log(`[transcribe] Начинаем пакетную обработку файлов (${paths.length} шт.)`);

    for (const [index, filePath] of paths.entries()) {
        console.log(`[transcribe] (${index + 1}/${paths.length}) Обработка: ${filePath}`);
        
        try {
            const transcription = await groq.audio.transcriptions.create({
                file: fs.createReadStream(filePath),
                model: "whisper-large-v3",
                response_format: "verbose_json",
            });

            fullText += (fullText ? " " : "") + transcription.text;
            if (transcription.segments) {
                allSegments.push(...transcription.segments);
            }
        } catch (error) {
            console.error(`[transcribe] Ошибка транскрибации чанка ${filePath}:`, error.message);
            // Продолжаем с остальными, если один упал
        }
    }

    console.log("[transcribe] Пакетная транскрибация завершена успешно");
    return {
        text: fullText,
        segments: allSegments
    };
}
