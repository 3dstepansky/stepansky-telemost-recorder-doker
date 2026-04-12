import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

/**
 * Универсальный сервис выгрузки файлов в S3-хранилище (MinIO, Yandex, AWS).
 */
export async function uploadToS3(filePath, bucketName, remoteKey = null) {
    if (!process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY) {
        console.error("[s3] Пропуск выгрузки: S3_ACCESS_KEY или S3_SECRET_KEY не заданы.");
        return null;
    }

    const s3Client = new S3Client({
        region: process.env.S3_REGION || "ru-central1",
        endpoint: process.env.S3_ENDPOINT || "https://storage.yandexcloud.net",
        credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY,
            secretAccessKey: process.env.S3_SECRET_KEY,
        },
    });

    const fileName = remoteKey || path.basename(filePath);
    const fileStream = fs.createReadStream(filePath);

    console.log(`[s3] Начинаем выгрузку ${fileName} в бакет ${bucketName}...`);

    try {
        const command = new PutObjectCommand({
            Bucket: bucketName,
            Key: fileName,
            Body: fileStream,
        });

        await s3Client.send(command);
        console.log(`[s3] Файл успешно выгружен: ${fileName}`);
        return fileName;
    } catch (error) {
        console.error("[s3] Ошибка выгрузки в S3:", error.message);
        throw error;
    }
}
