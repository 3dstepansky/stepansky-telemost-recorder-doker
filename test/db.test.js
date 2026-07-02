import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { initDB, getUser, saveUser, closeDB } from '../db.js';

describe('Database Module Tests', () => {
    before(async () => {
        // Инициализируем БД в оперативной памяти для тестов
        await initDB(':memory:');
    });

    after(async () => {
        await closeDB();
    });

    test('should return default user data for new chat_id', async () => {
        const chatId = '123456';
        const user = await getUser(chatId);
        
        assert.strictEqual(user.chat_id, chatId);
        assert.strictEqual(user.bot_name, 'Бот-Ассистент');
        assert.strictEqual(user.state, 'idle');
    });

    test('should save and retrieve user data correctly', async () => {
        const chatId = '654321';
        
        // Сначала сохраним новые данные
        await saveUser(chatId, { bot_name: 'Custom Bot', state: 'wait_for_link' });
        
        // Теперь получим и проверим
        const user = await getUser(chatId);
        
        assert.strictEqual(user.chat_id, chatId);
        assert.strictEqual(user.bot_name, 'Custom Bot');
        assert.strictEqual(user.state, 'wait_for_link');
    });
    
    test('should update existing user data correctly', async () => {
        const chatId = '654321';
        
        // Обновляем только state
        await saveUser(chatId, { state: 'idle' });
        
        // Получаем и проверяем, что bot_name не стерся
        const user = await getUser(chatId);
        
        assert.strictEqual(user.chat_id, chatId);
        assert.strictEqual(user.bot_name, 'Custom Bot');
        assert.strictEqual(user.state, 'idle');
    });
});
