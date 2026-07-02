import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';

let db;

export function initDB(dbPath = 'telemost_bot.sqlite') {
    return new Promise((resolve, reject) => {
        // Если передан :memory:, создаем БД в оперативной памяти (для тестов)
        const isMemory = dbPath === ':memory:';
        const targetPath = isMemory ? ':memory:' : path.resolve(dbPath);
        
        db = new sqlite3.Database(targetPath, (err) => {
            if (err) return reject(err);
            
            db.serialize(() => {
                db.run(`CREATE TABLE IF NOT EXISTS users (
                    chat_id TEXT PRIMARY KEY,
                    bot_name TEXT DEFAULT 'Бот-Ассистент',
                    yandex_user TEXT,
                    yandex_pass TEXT,
                    state TEXT
                )`);
                db.run(`CREATE TABLE IF NOT EXISTS meetings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id TEXT,
                    meeting_id TEXT,
                    title TEXT,
                    file_path TEXT,
                    transcribed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    speaker_count INTEGER,
                    utterance_count INTEGER
                )`, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });
    });
}

export function getUser(chatId) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not initialized. Call initDB first.'));
        db.get('SELECT * FROM users WHERE chat_id = ?', [chatId], (err, row) => {
            if (err) reject(err);
            else resolve(row || { chat_id: chatId, bot_name: 'Бот-Ассистент', state: 'idle' });
        });
    });
}

export function saveUser(chatId, data) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not initialized. Call initDB first.'));
        const keys = Object.keys(data);
        const values = Object.values(data);
        const setQuery = keys.map(k => `${k} = ?`).join(', ');
        
        db.run(`UPDATE users SET ${setQuery} WHERE chat_id = ?`, [...values, chatId], function (err) {
            if (err) return reject(err);
            if (this.changes === 0) {
                const insertQuery = `INSERT INTO users (chat_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`;
                db.run(insertQuery, [chatId, ...values], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            } else {
                resolve();
            }
        });
    });
}

export function getRecentMeetings(chatId, limit = 5) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('Database not initialized. Call initDB first.'));
        db.all(
            'SELECT * FROM meetings WHERE chat_id = ? ORDER BY transcribed_at DESC LIMIT ?',
            [chatId, limit],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
}

export function closeDB() {
    return new Promise((resolve, reject) => {
        if (db) {
            db.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        } else {
            resolve();
        }
    });
}
