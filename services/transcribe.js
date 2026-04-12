import fs from "fs";
import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

/**
 * Транскрибация аудио через Groq (Whisper-large-v3).
 * Бесплатно, быстро и качественно.
 */
export async function transcribeAudio(filePath) {
    if (!process.env.GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY не задан в .env файле");
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    console.log(`[transcribe] Начинаем транскрибацию файла: ${filePath}`);

    try {
        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(filePath),
            model: "whisper-large-v3",
            response_format: "verbose_json",
        });

        console.log("[transcribe] Транскрибация завершена успешно");
        return transcription;
    } catch (error) {
        console.error("[transcribe] Ошибка транскрибации:", error.message);
        throw error;
    }
}
