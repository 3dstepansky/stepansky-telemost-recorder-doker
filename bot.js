import { Telegraf, Markup } from 'telegraf';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { initDB, getUser, saveUser, getRecentMeetings } from './db.js';
import { checkYandexDiskConnection } from './services/webdav.js';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const MAIN_MENU = Markup.keyboard([
    ['🔴 Запись встреч', '🧠 Аналитика и ИИ'],
    ['⚙️ Настройки', 'ℹ️ Помощь']
]).resize();

const AI_MENU = Markup.keyboard([
    ['📝 Транскрибировать', '💡 Сделать саммари'],
    ['📂 Список встреч', '🔙 Назад']
]).resize();

const SETTINGS_MENU = Markup.keyboard([
    ['👤 Имя бота', '📦 Настройка Яндекс Диска'],
    ['🔙 Назад']
]).resize();

const BACK_MENU = Markup.keyboard([
    ['🔙 Назад']
]).resize();

// 1. Главное меню
bot.hears(['/start', '/menu', '🔙 Назад', '/back'], async (ctx) => {
    await saveUser(ctx.chat.id, { state: 'idle' });
    const user = await getUser(ctx.chat.id);
    
    let statusText = '';
    if (!user.yandex_user) {
        statusText = `\n\n⚠️ <b>Яндекс.Диск не подключен.</b>\nЗаписи будут отправляться прямо в этот чат (до 50 МБ). Вы можете подключить Диск в меню «⚙️ Настройки» для больших файлов.`;
    }

    await ctx.replyWithHTML(
        `<b>Телемост Рекордер</b>\n\nЯ записываю звонки в Яндекс Телемосте, расшифровываю аудио и делаю саммари.\nГотовые файлы я могу присылать прямо в чат или сохранять на ваш Диск.${statusText}\n\nВыберите команду в меню:`,
        MAIN_MENU
    );
});

// 2. Запись встреч
bot.hears(['🔴 Запись встреч', '/record'], async (ctx) => {
    const user = await getUser(ctx.chat.id);
    
    let warning = '';
    if (!user.yandex_user || !user.yandex_pass) {
        warning = `\n\n⚠️ <i>Так как Диск не подключен, аудиозапись придет прямо в чат. Если она превысит 50 МБ (около 1.5ч), Telegram не позволит ее отправить (текст и саммари придут в любом случае).</i>`;
    }

    await saveUser(ctx.chat.id, { state: 'wait_for_link' });
    await ctx.replyWithHTML(
        `<b>Запись встреч</b>\n\nПришлите ссылку на встречу в формате: <code>https://telemost.yandex.ru/j/XXXXXXXXXXXXXX</code>\n\nБот сам зайдет в звонок под именем <b>${user.bot_name || 'Бот-Ассистент'}</b> и начнет запись.${warning}`,
        BACK_MENU
    );
});

// 3. Аналитика и ИИ
bot.hears(['🧠 Аналитика и ИИ', '/ai'], async (ctx) => {
    await saveUser(ctx.chat.id, { state: 'idle' });
    await ctx.replyWithHTML(
        `<b>Аналитика и ИИ</b>\n\nЗдесь можно посмотреть историю встреч, получить текст разговора или краткое саммари.`,
        AI_MENU
    );
});

// 4. Настройки
bot.hears(['⚙️ Настройки', '/settings'], async (ctx) => {
    await saveUser(ctx.chat.id, { state: 'idle' });
    await ctx.replyWithHTML(
        `<b>Настройки</b>\n\nЗдесь можно изменить имя бота для встреч и подключить Яндекс Диск.`,
        SETTINGS_MENU
    );
});

// 5. Помощь
bot.hears(['ℹ️ Помощь', '/help'], async (ctx) => {
    await saveUser(ctx.chat.id, { state: 'idle' });
    await ctx.replyWithHTML(
        `<b>Помощь</b>\n\nЧтобы начать запись, отправьте боту ссылку на встречу в Телемосте.`,
        MAIN_MENU
    );
});

// 6. Список встреч
bot.hears(['📂 Список встреч', '/meetings', '/list'], async (ctx) => {
    await saveUser(ctx.chat.id, { state: 'idle' });
    const meetings = await getRecentMeetings(ctx.chat.id, 5);
    
    if (meetings.length === 0) {
        return ctx.replyWithHTML(
            `В базе нет сохраненных встреч.`,
            AI_MENU
        );
    }

    let text = `<b>Последние встречи:</b>\n\n`;
    meetings.forEach((m, i) => {
        const d = new Date(m.transcribed_at).toLocaleString('ru-RU');
        text += `${i + 1}. <b>${m.title || 'Встреча'}</b> (${d})\nФайл: <code>${m.file_path || 'Нет файла'}</code>\n\n`;
    });

    await ctx.replyWithHTML(text, AI_MENU);
});

// 7. Сделать саммари (Заглушка)
bot.hears('💡 Сделать саммари', async (ctx) => {
    await ctx.replyWithHTML(
        `Эта функция пока не работает.`
    );
});

// 8. Транскрибировать (Заглушка)
bot.hears('📝 Транскрибировать', async (ctx) => {
    await ctx.replyWithHTML(
        `Запрос отправлен.`
    );
});

// 9. Настройка Имени
bot.hears(['👤 Имя бота', '/name'], async (ctx) => {
    const user = await getUser(ctx.chat.id);
    await saveUser(ctx.chat.id, { state: 'wait_for_name' });
    await ctx.replyWithHTML(
        `<b>Настройка имени</b>\n\nТекущее имя бота: <b>${user.bot_name || 'Бот-Ассистент'}</b>\n\nНапишите в чат новое имя.`,
        BACK_MENU
    );
});

// 10. Настройка Яндекс Диска
bot.hears(['📦 Настройка Яндекс Диска', '/yandex'], async (ctx) => {
    const user = await getUser(ctx.chat.id);
    await saveUser(ctx.chat.id, { state: 'wait_for_yandex' });
    
    let prefix = '';
    if (user.yandex_user) {
        prefix = `✅ <b>Яндекс.Диск уже подключен!</b>\nАккаунт: <code>${user.yandex_user}</code>\n\nЕсли вы хотите сменить аккаунт или обновить пароль, следуйте инструкции ниже. Если нет — просто нажмите «Назад».\n\n---\n\n`;
    }

    await ctx.replyWithHTML(
        prefix + `<b>Подключение Яндекс Диска</b>\n\nБоту нужен доступ к Диску, чтобы сохранять туда записи и тексты.\n\n⚠️ <b>Важно:</b> Ваш обычный пароль от почты не подойдет!\n\n1. Перейдите по ссылке: <a href="https://id.yandex.ru/security/app-passwords">Пароли приложений Яндекса</a>\n2. Нажмите <b>«Создать пароль приложения»</b> -> выберите тип <b>«Файлы (WebDAV)»</b>.\n3. Яндекс выдаст вам 16-значный пароль.\n4. Пришлите сюда вашу почту и этот 16-значный пароль через пробел:\n<code>username@yandex.ru пароль_из_16_букв</code>`,
        BACK_MENU
    );
});

// 11. Общий обработчик текста
bot.on('text', async (ctx) => {
    const user = await getUser(ctx.chat.id);
    const text = ctx.message.text;

    if (user.state === 'wait_for_name') {
        await saveUser(ctx.chat.id, { bot_name: text, state: 'idle' });
        return ctx.replyWithHTML(
            `Имя бота изменено на <b>${text}</b>.`,
            MAIN_MENU
        );
    }

    if (user.state === 'wait_for_yandex') {
        const parts = text.split(' ');
        if (parts.length < 2) {
            return ctx.replyWithHTML(
                `Неверный формат. Пришлите логин и пароль через пробел.\nПример: <code>username@yandex.ru пароль</code>`,
                BACK_MENU
            );
        }
        
        const username = parts[0].trim();
        const password = parts.slice(1).join('').replace(/\s/g, '');

        if (password.length !== 16) {
            return ctx.replyWithHTML(
                `❌ <b>Неверный формат пароля</b>\n\nВы ввели пароль длиной ${password.length} символов. <b>Пароль приложения</b> Яндекса всегда состоит ровно из 16 букв.\n\nПожалуйста, создайте именно «Пароль приложения» в настройках Яндекса и попробуйте снова.`,
                BACK_MENU
            );
        }

        const statusMsg = await ctx.replyWithHTML(`🔄 Проверяем подключение к Яндекс.Диску...`);

        try {
            const isConnected = await checkYandexDiskConnection(username, password);
            if (isConnected) {
                await saveUser(ctx.chat.id, { yandex_user: username, yandex_pass: password, state: 'idle' });
                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    statusMsg.message_id,
                    null,
                    `✅ <b>Яндекс.Диск успешно подключен!</b>\n\nБот готов автоматически сохранять туда записи ваших встреч.`,
                    { parse_mode: 'HTML' }
                );
                return ctx.replyWithHTML(`Выберите действие в меню:`, MAIN_MENU);
            } else {
                return ctx.telegram.editMessageText(
                    ctx.chat.id,
                    statusMsg.message_id,
                    null,
                    `❌ <b>Ошибка авторизации!</b>\n\nНе удалось войти в Яндекс.Диск. Обычно это означает, что вы ввели обычный пароль вместо <b>Пароля приложения</b>.\n\nУбедитесь, что вы создали специальный 16-значный пароль для WebDAV в настройках безопасности Яндекса (id.yandex.ru).\n\nПопробуйте ввести заново или нажмите «Назад»:`,
                    { parse_mode: 'HTML' }
                );
            }
        } catch (err) {
            console.error('[yandex-check-error]', err);
            return ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                null,
                `⚠️ <b>Ошибка соединения!</b>\n\nНе удалось связаться с сервером Яндекс.Диска (${err.message}). Пожалуйста, попробуйте позже.`,
                { parse_mode: 'HTML' }
            );
        }
    }

    // Обработка ссылки Телемоста
    const telemostMatch = text.match(/telemost\.yandex\.ru\/j\/(\d+)/);
    if (telemostMatch) {
        await saveUser(ctx.chat.id, { state: 'idle' });
        const meetingId = telemostMatch[1];
        const botName = user.bot_name || 'Бот-Ассистент';
        
        const msg = await ctx.replyWithHTML(
            `<b>Начинаем запись</b>\n\nБот заходит на встречу. Вы можете остановить запись кнопкой ниже.`,
            Markup.inlineKeyboard([
                Markup.button.callback('Остановить', `stop_${meetingId}`)
            ])
        );

        // Spawn run.js
        console.log(`Spawning run.js with URL ${text}`);
        const env = { ...process.env, BOT_DISPLAY_NAME: botName, CHAT_ID: String(ctx.chat.id) };
        if (user.yandex_user && user.yandex_pass) {
            env.YANDEX_USER = user.yandex_user;
            env.YANDEX_WEBDAV_PASSWORD = user.yandex_pass;
        }

        const child = spawn('node', ['run.js', text], { env, stdio: 'inherit' });
        child.on('error', (err) => {
            ctx.replyWithHTML(
                `<b>Ошибка запуска</b>\nНе удалось запустить бота для записи: <code>${String(err.message)}</code>`
            );
        });
        return;
    }

    if (user.state === 'wait_for_link') {
        return ctx.replyWithHTML(
            `❌ <b>Неверная ссылка</b>\n\nВы прислали текст, который не похож на ссылку Телемоста.\nПример правильной ссылки: <code>https://telemost.yandex.ru/j/12345678901234</code>`,
            BACK_MENU
        );
    }

    ctx.replyWithHTML(
        `Я не понимаю эту команду. Выберите действие в меню.`,
        MAIN_MENU
    );
});

// Обработка не-текстовых сообщений (фото, стикеры, голосовые)
bot.on('message', async (ctx) => {
    if (!ctx.message.text) {
        return ctx.replyWithHTML(
            `⚠️ Я понимаю только текстовые сообщения и ссылки.\nПожалуйста, используйте кнопки меню.`,
            MAIN_MENU
        );
    }
});

bot.action(/stop_(.+)/, async (ctx) => {
    const meetingId = ctx.match[1];
    await ctx.answerCbQuery('Останавливаем...');
    await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        null,
        `<b>Завершаем запись</b>\n\nБот выходит из звонка и сохраняет файлы. Это займет несколько секунд.`,
        { parse_mode: 'HTML' }
    );

    // Spawn stop script
    const lockFile = path.join(process.cwd(), `stop_${meetingId}`);
    fs.writeFileSync(lockFile, 'stop');

    // Сбрасываем состояние пользователя и возвращаем в главное меню
    await saveUser(ctx.chat.id, { state: 'idle' });
    await ctx.replyWithHTML(
        `Запись остановлена пользователем. Идет фоновая обработка и транскрибация. Вы вернетесь в главное меню.`,
        MAIN_MENU
    );
});

// Запуск бота
(async () => {
    try {
        await initDB('/app/data/telemost_bot.sqlite');
        bot.launch().then(() => console.log('Бот успешно запущен')).catch(e => console.error('Ошибка запуска бота', e));
    } catch (err) {
        console.error('Failed to initialize DB:', err);
    }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
