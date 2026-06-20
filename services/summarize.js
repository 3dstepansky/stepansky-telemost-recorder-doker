import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

/**
 * Суммаризация текста через OpenRouter или Groq.
 * Для Zero Cost используем Llama-3-70b на Groq (бесплатно) 
 * или бесплатные модели на OpenRouter (Qwen-2.5-72b).
 */
export async function summarizeTranscript(transcriptText) {
    const apiKey = process.env.GROQ_API_KEY; // Для простоты используем тот же Groq
    if (!apiKey) {
        throw new Error("GROQ_API_KEY не задан");
    }

    const groq = new Groq({ apiKey });

    console.log("[summarize] Начинаем генерацию бизнес-саммари...");

    try {
        // Ограничиваем длину текста транскрибации для стабильности и предотвращения переполнения контекста
        const safeTranscriptText = transcriptText ? transcriptText.substring(0, 25000) : "";

        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: "Ты — профессиональный бизнес-ассистент. Твоя задача — составить краткое и емкое саммари (итоги) рабочей встречи на основе предоставленного текста транскрибации. Выдели ключевые темы, принятые решения и список задач (Next Steps) с ответственными, если они упоминались."
                },
                {
                    role: "user",
                    content: `Вот текст транскрибации встречи:\n\n${safeTranscriptText}`
                }
            ],
            model: "llama-3.3-70b-versatile",
        });

        console.log("[summarize] Саммари успешно сгенерировано");
        return completion.choices[0].message.content;
    } catch (error) {
        console.error("[summarize] Ошибка суммаризации:", error.message);
        throw error;
    }
}

/**
 * Извлекает количество спикеров, их имена и краткую тему встречи для формирования названия папки.
 * Использует JSON-режим Groq API.
 * 
 * @param {string} transcriptText - Текст расшифровки
 * @returns {Promise<{speaker_count: number, speakers: string[], topic: string}>} Метаданные встречи
 */
export async function generateFolderMeta(transcriptText) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        throw new Error("GROQ_API_KEY не задан");
    }

    const groq = new Groq({ apiKey });

    console.log("[summarize] Извлечение метаданных встречи из стенограммы для переименования папки...");

    const prompt = `Ты анализируешь текст саммари (краткого содержания) встречи. Твоя задача — извлечь:
1. Количество уникальных спикеров, упомянутых или подразумеваемых.
2. Имена ключевых спикеров (если их меньше 5, например, ["Павел", "Ксения"]). Если имена не упоминались напрямую, укажи пустой список.
3. Краткую суть/тему разговора (максимум 4-5 слов на русском, например: "разработка телеграм бота", "оптимизация бизнес процессов").
Верни результат СТРОГО в формате JSON с полями:
{
  "speaker_count": number,
  "speakers": string[],
  "topic": string
}`;

    try {
        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: prompt
                },
                {
                    role: "user",
                    content: transcriptText ? transcriptText.substring(0, 12000) : "" // Ограничим длину текста для стабильности контекста
                }
            ],
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" }
        });

        const result = JSON.parse(completion.choices[0].message.content);
        console.log("[summarize] Метаданные встречи успешно извлечены:", result);
        return {
            speaker_count: typeof result.speaker_count === 'number' ? result.speaker_count : 1,
            speakers: Array.isArray(result.speakers) ? result.speakers : [],
            topic: typeof result.topic === 'string' ? result.topic.trim() : "тема встречи"
        };
    } catch (error) {
        console.error("[summarize] Ошибка извлечения метаданных встречи:", error.message);
        // Возвращаем фоллбэк значения при любой ошибке, чтобы не ломать основной пайплайн
        return {
            speaker_count: 1,
            speakers: [],
            topic: "встреча"
        };
    }
}

