/**
 * run.js — Главный оркестратор Zero Cost Телемост-Рекордера.
 * Управляет процессом записи, транскрибации и суммаризации.
 */

import { spawn } from "child_process";
import { resolve, join } from "path";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { transcribeAudio } from "./services/transcribe.js";
import { summarizeTranscript } from "./services/summarize.js";
import { uploadToS3 } from "./services/s3.js";
import dotenv from "dotenv";

dotenv.config();

const joinUrl = process.argv[2];
if (!joinUrl) {
    console.error("Пожалуйста, укажите URL встречи: node run.js <URL>");
    process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = resolve("./recordings", timestamp);
if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
}

const audioFile = join(outputDir, "meeting_audio.webm");
const transcriptFile = join(outputDir, "transcript.json");
const summaryFile = join(outputDir, "summary.md");

async function main() {
    console.log(`=== НАЧАЛО СЕССИИ: ${timestamp} ===`);
    
    // 1. ЗАПУСК ЗАПИСИ
    console.log("[step 1] Запуск процесса записи...");
    const recorder = spawn("node", ["recorder.js", joinUrl, audioFile], {
        stdio: "inherit",
        env: { 
            ...process.env, 
            MAX_IDLE_MINS: process.env.MAX_IDLE_MINS || "3",
            MAX_DURATION_MINS: process.env.MAX_DURATION_MINS || "180"
        }
    });

    recorder.on("close", async (code) => {
        console.log(`[step 1] Процесс записи завершен с кодом: ${code}`);
        
        if (!existsSync(audioFile)) {
            console.error("[error] Аудиофайл не был создан.");
            return;
        }

        try {
            // 1.5 ОБРАБОТКА АУДИО (VAD + Splitting)
            console.log("[step 1.5] Обработка аудио: удаление тишины и нарезка...");
            const cleanAudio = join(outputDir, "audio_clean.webm");
            
            // Удаление тишины
            const vadTask = spawn("ffmpeg", [
                "-i", audioFile,
                "-af", "silenceremove=stop_periods=-1:stop_duration=1:stop_threshold=-30dB",
                cleanAudio
            ]);
            await new Promise(r => vadTask.on("close", r));
            console.log("[step 1.5] Тишина удалена.");

            // Нарезка на чанки по 20 минут
            const chunkPattern = join(outputDir, "chunk_%03d.webm");
            const splitTask = spawn("ffmpeg", [
                "-i", cleanAudio,
                "-f", "segment",
                "-segment_time", "1200", // 20 минут
                "-c", "copy",
                chunkPattern
            ]);
            await new Promise(r => splitTask.on("close", r));
            console.log("[step 1.5] Аудио нарезано на части по 20 минут.");

            // Собираем список чанков
            const chunks = [];
            let i = 0;
            while (true) {
                const chunkPath = join(outputDir, `chunk_${String(i).padStart(3, '0')}.webm`);
                if (existsSync(chunkPath)) {
                    chunks.push(chunkPath);
                    i++;
                } else {
                    break;
                }
            }

            // 2. ТРАНСКРИБАЦИЯ
            console.log("[step 2] Начинаем расшифровку аудио (пакетная обработка)...");
            const transcript = await transcribeAudio(chunks.length > 0 ? chunks : [audioFile]);
            writeFileSync(transcriptFile, JSON.stringify(transcript, null, 2));
            console.log(`[step 2] Текст сохранен в: ${transcriptFile}`);

            // 3. СУММАРИЗАЦИЯ
            console.log("[step 3] Генерация итогов встречи (Summary)...");
            const summary = await summarizeTranscript(transcript.text);
            
            const finalReport = `# Итоги встречи от ${new Date().toLocaleString()}\n\n` +
                                `URL встречи: ${joinUrl}\n\n` +
                                `## Саммари\n${summary}\n\n` +
                                `--- \n*Записано и обработано автоматически через stepansky-telemost Core*`;

            writeFileSync(summaryFile, finalReport);
            console.log(`[step 3] Финальный отчет готов: ${summaryFile}`);

            // 4. ВЫГРУЗКА В S3 (Milestone 3)
            if (process.env.S3_BUCKET) {
                console.log("[step 4] Начинаем выгрузку в S3...");
                await uploadToS3(summaryFile, process.env.S3_BUCKET, `reports/${timestamp}_summary.md`);
                // Опционально: выгрузка тяжелого аудио
                // await uploadToS3(audioFile, process.env.S3_BUCKET, `audio/${timestamp}_meeting.webm`);
                console.log("[step 4] Выгрузка в S3 завершена.");
            }
            
            console.log("=== ВСЕ ЗАДАЧИ ВЫПОЛНЕНЫ УСПЕШНО ===");

        } catch (error) {
            console.error("[error] Ошибка на этапе обработки:", error.message);
        }
    });

    // Обработка прерывания (Ctrl+C)
    process.on("SIGINT", () => {
        console.log("\n[system] Получен сигнал прерывания. Останавливаем рекордер...");
        recorder.kill();
    });
}

main().catch(err => console.error("[fatal]", err));
