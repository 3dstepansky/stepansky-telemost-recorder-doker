import { spawn, spawnSync } from "child_process";
import { resolve, join } from "path";
import { existsSync, mkdirSync } from "fs";
import { uploadToS3 } from "./services/s3.js";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const joinUrl = process.argv[2];
if (!joinUrl) {
    console.error("Пожалуйста, укажите URL встречи: node run.js <URL>");
    process.exit(1);
}

const HOST_ROOT_PATH = "/opt/telemost-recorder";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = resolve("./recordings", timestamp);
if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
}

const audioFile = join(outputDir, "meeting_audio.webm");

async function main() {
    console.log(`=== НАЧАЛО СЕССИИ: ${timestamp} ===`);
    const startTime = Date.now();
    let isShuttingDown = false;

    const handleShutdown = async (signal) => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.log(`\n[system] Получен сигнал ${signal}. Завершаем запись...`);
        recorder.kill("SIGINT");
    };

    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
    process.on("SIGINT", () => handleShutdown("SIGINT"));
    
    console.log("[step 1] Запуск рекордера...");
    const recorder = spawn("node", ["recorder.js", joinUrl, audioFile], {
        stdio: "inherit",
        env: { 
            ...process.env, 
            MAX_IDLE_MINS: process.env.MAX_IDLE_MINS || "2",
            MAX_DURATION_MINS: process.env.MAX_DURATION_MINS || "180"
        }
    });

    recorder.on("close", async (code) => {
        console.log(`[system] Процесс рекордера закрыт с кодом ${code}`);
        
        const hostFilePath = audioFile.replace("/app", HOST_ROOT_PATH);

        // 1. Сначала пробуем загрузить в S3 (если настроено), чтобы избежать Race Condition с удалением локального файла при транскрибации
        if (process.env.S3_BUCKET && existsSync(audioFile)) {
            console.log("[step 4] Выгрузка в S3...");
            try {
                await uploadToS3(audioFile, process.env.S3_BUCKET, `audio/${timestamp}_meeting.webm`);
                console.log("[s3] Файл успешно загружен в S3.");
            } catch (e) {
                console.error("[s3] Ошибка выгрузки в S3:", e.message);
            }
        }

        // 1.5. Ранняя выгрузка исходного аудио на Яндекс.Диск (Шаг 4 гипотезы US-16)
        console.log("[step 4.5] Выгрузка оригинального аудио на Яндекс.Диск...");
        let targetDirName = timestamp; // fallback
        const meetingTitle = process.env.MEETING_TITLE || `Telemost ${timestamp}`;
        const chatId = process.env.CHAT_ID || 'manual_launch';

        const uploadResult = spawnSync("node", ["upload_audio.js", audioFile, meetingTitle, chatId], {
            encoding: "utf-8",
            env: process.env
        });

        if (uploadResult.status === 0) {
            try {
                const outLines = uploadResult.stdout.split('\n');
                const jsonLine = outLines.find(l => l.trim().startsWith('{'));
                if (jsonLine) {
                    const parsed = JSON.parse(jsonLine);
                    if (parsed.target_dir_name) {
                        targetDirName = parsed.target_dir_name;
                        console.log(`[system] Успешная ранняя выгрузка. Папка: ${targetDirName}`);
                    }
                }
                if (uploadResult.stderr) {
                    process.stderr.write(uploadResult.stderr);
                }
            } catch(e) {
                console.error("[system] Ошибка парсинга вывода upload_audio.js", e);
            }
        } else {
            console.error("[system] Ошибка выгрузки аудио на Яндекс.Диск:");
            console.error(uploadResult.stderr || uploadResult.stdout);
        }

        // 2. Затем локально запускаем транскрибацию (вместо n8n webhook)
        console.log("[step 5] Запуск локальной транскрибации...");
        const transcribeProcess = spawn("node", ["transcribe.js", audioFile, targetDirName, meetingTitle, chatId], {
            stdio: "inherit",
            env: process.env
        });

        transcribeProcess.on("close", (tCode) => {
            console.log(`[system] Транскрибация завершена с кодом ${tCode}`);
            console.log(`=== СЕССИЯ ЗАВЕРШЕНА ===`);
            process.exit(0);
        });

    });
}

main().catch(err => console.error("[fatal]", err));
