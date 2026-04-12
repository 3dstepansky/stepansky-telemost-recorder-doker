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
        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: "Ты — профессиональный бизнес-ассистент. Твоя задача — составить краткое и емкое саммари (итоги) рабочей встречи на основе предоставленного текста транскрибации. Выдели ключевые темы, принятые решения и список задач (Next Steps) с ответственными, если они упоминались."
                },
                {
                    role: "user",
                    content: `Вот текст транскрибации встречи:\n\n${transcriptText}`
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
