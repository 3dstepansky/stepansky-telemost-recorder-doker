import { spawn } from "child_process";
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
        
        if (process.env.N8N_WEBHOOK_URL) {
            // Маппинг пути Docker -> Host
            const hostFilePath = audioFile.replace("/app", HOST_ROOT_PATH);
            
            try {
                await axios.post(process.env.N8N_WEBHOOK_URL, {
                    file: hostFilePath,
                    title: process.env.MEETING_TITLE || `Telemost ${timestamp}`,
                    chat_id: process.env.CHAT_ID || 'manual_launch'
                });
                console.log("[system] Вебхук успешно отправлен в n8n.");
            } catch (e) {
                console.error("[error] Ошибка вебхука:", e.message);
            }
        }
        
        recorder.kill("SIGINT");
    };

    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
    process.on("SIGINT", () => handleShutdown("SIGINT"));
    
    console.log("[step 1] Запуск рекордера...");
    const recorder = spawn("node", ["recorder.js", joinUrl, audioFile], {
        stdio: "inherit",
        env: { 
            ...process.env, 
            MAX_IDLE_MINS: process.env.MAX_IDLE_MINS || "3",
            MAX_DURATION_MINS: process.env.MAX_DURATION_MINS || "180"
        }
    });

    recorder.on("close", async (code) => {
        if (process.env.S3_BUCKET && existsSync(audioFile)) {
            console.log("[step 4] Выгрузка в S3...");
            try {
                await uploadToS3(audioFile, process.env.S3_BUCKET, `audio/${timestamp}_meeting.webm`);
            } catch (e) {
                console.error("[error] S3 upload failed:", e.message);
            }
        }
        process.exit(0);
    });
}

main().catch(err => console.error("[fatal]", err));
