import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

function getLlmConfig() {
    const baseUrl = (process.env.SUMMARY_LLM_BASE_URL || "http://host.docker.internal:20128/v1").replace(/\/$/, "");
    const apiKey = process.env.SUMMARY_LLM_API_KEY;
    const model = process.env.SUMMARY_LLM_MODEL || "auto/best-coding";

    if (!apiKey) throw new Error("SUMMARY_LLM_API_KEY не задан");
    return { baseUrl, apiKey, model };
}

async function createChatCompletion(messages, options = {}) {
    const { baseUrl, apiKey, model } = getLlmConfig();
    const response = await axios.post(`${baseUrl}/chat/completions`, {
        model,
        messages,
        temperature: 0.2,
        ...options,
    }, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        timeout: 180000,
    });

    const content = response.data?.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("LLM вернул пустой ответ");
    return content;
}

export async function summarizeTranscript(transcriptText) {
    console.log("[summarize] Начинаем генерацию бизнес-саммари...");

    try {
        const safeTranscriptText = transcriptText ? transcriptText.substring(0, 25000) : "";
        const content = await createChatCompletion([
            {
                role: "system",
                content: "Ты — профессиональный бизнес-ассистент. Составь краткое и ёмкое саммари рабочей встречи на русском языке. Структура: ключевые темы, принятые решения, задачи и следующие шаги с ответственными, если они упоминались. Не выдумывай факты."
            },
            {
                role: "user",
                content: `Вот текст транскрибации встречи:\n\n${safeTranscriptText}`
            }
        ]);

        console.log("[summarize] Саммари успешно сгенерировано");
        return content;
    } catch (error) {
        const message = error.response?.data?.error?.message || error.message;
        console.error("[summarize] Ошибка суммаризации:", message);
        throw new Error(message);
    }
}

export async function generateFolderMeta(transcriptText) {
    console.log("[summarize] Извлечение метаданных встречи для переименования папки...");

    const prompt = `Извлеки из текста встречи:
1. Количество уникальных спикеров.
2. Имена ключевых спикеров, если они названы.
3. Краткую тему разговора, максимум 4–5 слов на русском.
Верни СТРОГО JSON:
{"speaker_count": number, "speakers": string[], "topic": string}`;

    try {
        const content = await createChatCompletion([
            { role: "system", content: prompt },
            { role: "user", content: transcriptText ? transcriptText.substring(0, 12000) : "" }
        ], { response_format: { type: "json_object" } });

        const result = JSON.parse(content.replace(/^```json\s*|\s*```$/g, ""));
        return {
            speaker_count: Number(result.speaker_count) || 1,
            speakers: Array.isArray(result.speakers) ? result.speakers : [],
            topic: String(result.topic || "встреча")
        };
    } catch (error) {
        const message = error.response?.data?.error?.message || error.message;
        console.error("[summarize] Ошибка извлечения метаданных:", message);
        throw new Error(message);
    }
}
