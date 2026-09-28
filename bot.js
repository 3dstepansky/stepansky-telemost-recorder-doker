import { Telegraf, Markup } from 'telegraf';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { initDB, getUser, saveUser, getRecentMeetings } from './db.js';
import { checkYandexDiskConnection } from './services/webdav.js';
import { vectorizeMeeting } from './services/vectorize.js';
import { ensureMongoIndexes, getRecentMeetingsForChat, getMeetingForChat } from './services/mongoMemory.js';
import { formatMeetingList } from './services/meetingList.js';
import { escapeTelegramHtml, splitTelegramText } from './services/telegramFormat.js';
import { detectPlatform } from './services/platform-detector.js';
import { MeetingProcessRegistry } from './services/meeting-processes.js';

dotenv.config();

const activeMeetingProcesses = new MeetingProcessRegistry();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, {
    telegram: process.env.TELEGRAM_BOT_API_URL
        ? { apiRoot: process.env.TELEGRAM_BOT_API_URL }
        : undefined,
});
let botUsername = process.env.TELEGRAM_BOT_USERNAME || '';

async function downloadTelegramMedia(ctx, media, outputPath) {
    const file = await ctx.telegram.getFile(media.file_id);
    if (!file.file_path) throw new Error('Telegram не вернул путь к файлу');

    // В local mode Telegram Bot API возвращает абсолютный путь внутри своего
    // контейнера. Оба контейнера используют общий volume, поэтому копируем
    // файл напрямую, не пытаясь fetch() этот локальный путь как URL.
    if (path.isAbsolute(file.file_path)) {
        fs.copyFileSync(file.file_path, outputPath);
        return;
    }

    const fileLink = await ctx.telegram.getFileLink(media.file_id);
    const response = await fetch(fileLink.href);
    if (!response.ok) throw new Error(`Telegram вернул HTTP ${response.status}`);
    fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
}

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
        `<b>Meeting Recorder</b>\n\nЯ записываю звонки в <b>Яндекс.Телемосте</b>, <b>Google Meet</b> и <b>Zoom</b>, расшифровываю аудио по спикерам и делаю саммари.\nГотовые файлы я могу присылать прямо в чат или сохранять на ваш Диск.${statusText}\n\nВыберите команду в меню:`,
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
        `<b>Запись встреч</b>\n\nПришлите ссылку на встречу:\n🟣 <b>Яндекс.Телемост:</b> <code>https://telemost.yandex.ru/j/...</code>\n🟢 <b>Google Meet:</b> <code>https://meet.google.com/...</code>\n🔵 <b>Zoom:</b> <code>https://zoom.us/j/...</code>\n\nБот сам зайдет в звонок под именем <b>${user.bot_name || 'Бот-Ассистент'}</b> и начнет запись.${warning}`,
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
    const meetings = process.env.MONGODB_URI
        ? await getRecentMeetingsForChat(ctx.chat.id, 5)
        : await getRecentMeetings(ctx.chat.id, 5);
    
    if (meetings.length === 0) {
        return ctx.replyWithHTML(
            `В базе нет сохраненных встреч.`,
            AI_MENU
        );
    }

    await ctx.replyWithHTML(formatMeetingList(meetings), Markup.inlineKeyboard(
        meetings.map((meeting, index) => ([
            Markup.button.callback(`📄 ${index + 1}. Открыть транскрипт`, `transcript_${meeting._id}`)
        ]))
    ));
});

// 7. Сделать саммари (Заглушка)
bot.hears('💡 Сделать саммари', async (ctx) => {
    await ctx.replyWithHTML(
        `Эта функция пока не работает.`
    );
});

// 8. Транскрибировать загруженный аудио/видеофайл
bot.hears('📝 Транскрибировать', async (ctx) => {
    await saveUser(ctx.chat.id, { state: 'wait_for_media' });
    await ctx.replyWithHTML(
        `<b>Пришлите файл для транскрибации</b>\n\nПодойдут аудио, видео, голосовое сообщение или файл-документ. Я пришлю саммари и текстовый транскрипт ответом на исходный файл. Векторизация запускается отдельно кнопкой.`,
        BACK_MENU
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

    // Обработка ссылок на встречи (Телемост, Google Meet, Zoom)
    const detected = detectPlatform(text);
    if (detected.valid && detected.platform !== 'teams') {
        await saveUser(ctx.chat.id, { state: 'idle' });
        const meetingId = detected.meetingId || 'meeting';
        const botName = user.bot_name || 'Бот-Ассистент';
        
        await ctx.replyWithHTML(
            `<b>Начинаем запись (${detected.icon} ${detected.displayName})</b>\n\nБот <b>${botName}</b> подключается к встрече. Вы можете остановить запись кнопкой ниже.`,
            Markup.inlineKeyboard([
                Markup.button.callback('Остановить', `stop_${meetingId}`)
            ])
        );

        console.log(`[bot] Запуск run.js для ${detected.platform}: ${detected.normalizedUrl}`);
        const env = { ...process.env, BOT_DISPLAY_NAME: botName, CHAT_ID: String(ctx.chat.id) };
        if (user.yandex_user && user.yandex_pass) {
            env.YANDEX_USER = user.yandex_user;
            env.YANDEX_WEBDAV_PASSWORD = user.yandex_pass;
        }

        const child = spawn('node', ['run.js', detected.normalizedUrl], { env, stdio: 'inherit' });
        activeMeetingProcesses.register(ctx.chat.id, meetingId, child);
        child.on('error', (err) => {
            activeMeetingProcesses.unregister(ctx.chat.id, meetingId, child);
            ctx.replyWithHTML(
                `<b>Ошибка запуска</b>\nНе удалось запустить бота для записи: <code>${String(err.message)}</code>`
            );
        });
        child.on('exit', () => {
            activeMeetingProcesses.unregister(ctx.chat.id, meetingId, child);
        });
        return;
    }

    if (user.state === 'wait_for_link') {
        return ctx.replyWithHTML(
            `❌ <b>Неверная ссылка</b>\n\nСейчас поддерживаются ссылки Яндекс.Телемоста, Google Meet и Zoom.`,
            BACK_MENU
        );
    }

    ctx.replyWithHTML(
        `Я не понимаю эту команду. Выберите действие в меню.`,
        MAIN_MENU
    );
});

// Обработка загруженных аудио/видеофайлов
bot.on('message', async (ctx) => {
    if (ctx.message.text) return;

    const user = await getUser(ctx.chat.id);
    const media = ctx.message.document || ctx.message.audio || ctx.message.video || ctx.message.voice;

    if (user.state !== 'wait_for_media') {
        return ctx.replyWithHTML(
            `Чтобы обработать файл, сначала нажмите <b>📝 Транскрибировать</b>.`,
            AI_MENU
        );
    }

    if (!media?.file_id) {
        return ctx.replyWithHTML(
            `❌ Пришлите аудио, видео, голосовое сообщение или файл-документ.`,
            BACK_MENU
        );
    }

    const maxBytes = Number(process.env.TELEGRAM_UPLOAD_MAX_BYTES || 2000000000);
    if (media.file_size && media.file_size > maxBytes) {
        return ctx.replyWithHTML(
            `❌ Файл превышает настроенный лимит: <b>${Math.floor(maxBytes / 1000000)} МБ</b>.`,
            BACK_MENU
        );
    }

    await saveUser(ctx.chat.id, { state: 'processing_media' });
    const status = await ctx.replyWithHTML(`⏳ <b>Файл получен.</b> Загружаю и запускаю транскрибацию…`);

    const sourceName = media.file_name || `telegram-${media.file_unique_id || Date.now()}.${ctx.message.voice ? 'ogg' : (ctx.message.video ? 'mp4' : 'bin')}`;
    const safeBase = path.basename(sourceName).replace(/[^a-zA-Z0-9а-яА-ЯёЁ._-]+/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const targetDirName = `telegram-${ctx.chat.id}-${stamp}`;
    const recordingDir = path.resolve('recordings', targetDirName);
    const extension = path.extname(safeBase) || '.bin';
    const localPath = path.join(recordingDir, `meeting_audio${extension}`);
    fs.mkdirSync(recordingDir, { recursive: true });

    try {
        await downloadTelegramMedia(ctx, media, localPath);
        const actualSize = fs.statSync(localPath).size;
        if (actualSize > maxBytes) throw new Error(`Файл превышает лимит ${Math.floor(maxBytes / 1000000)} МБ`);

        const title = path.parse(safeBase).name || 'Загруженная запись';
        const env = { ...process.env };
        if (user.yandex_user && user.yandex_pass) {
            env.YANDEX_USER = user.yandex_user;
            env.YANDEX_WEBDAV_PASSWORD = user.yandex_pass;
        }

        const child = spawn('node', [
            'transcribe.js', localPath, targetDirName, title, String(ctx.chat.id),
            String(ctx.message.message_id), String(media.file_id)
        ], { env, stdio: 'inherit' });

        child.on('error', async (error) => {
            console.error('[file-transcribe] Ошибка запуска:', error.message);
            await saveUser(ctx.chat.id, { state: 'wait_for_media' });
            await ctx.replyWithHTML(`❌ <b>Не удалось запустить обработку файла.</b>\n<code>${String(error.message).replace(/[<>&]/g, '')}</code>`, BACK_MENU);
        });
        child.on('exit', async (code) => {
            await saveUser(ctx.chat.id, { state: code === 0 ? 'idle' : 'wait_for_media' });
            if (code !== 0) {
                await ctx.replyWithHTML(`❌ <b>Обработка файла завершилась с ошибкой.</b> Попробуйте другой файл.`, BACK_MENU);
            }
        });

        await ctx.telegram.editMessageText(
            ctx.chat.id,
            status.message_id,
            undefined,
            `✅ <b>Файл принят.</b> Транскрибация и саммари выполняются; результат придёт сюда автоматически.`,
            { parse_mode: 'HTML' }
        );
    } catch (error) {
        console.error('[file-upload] Ошибка:', error.message);
        await saveUser(ctx.chat.id, { state: 'wait_for_media' });
        fs.rmSync(recordingDir, { recursive: true, force: true });
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            status.message_id,
            undefined,
            `❌ <b>Не удалось загрузить файл.</b>\n<code>${String(error.message).replace(/[<>&]/g, '')}</code>`,
            { parse_mode: 'HTML' }
        );
    }
});

bot.action(/transcript_([a-f0-9]{24})/, async (ctx) => {
    const meetingId = ctx.match[1];
    const meeting = await getMeetingForChat(meetingId, ctx.chat.id);
    if (!meeting) return ctx.answerCbQuery('Транскрипт не найден', { show_alert: true });

    await ctx.answerCbQuery('Открываю транскрипт…');
    const header = `<b>${escapeTelegramHtml(meeting.title || 'Транскрипт')}</b>\n\n`;
    const chunks = splitTelegramText(escapeTelegramHtml(meeting.transcript || 'Транскрипт пуст.'), 3900 - header.length);
    for (let i = 0; i < chunks.length; i++) {
        await ctx.replyWithHTML(
            `${i === 0 ? header : '<b>Продолжение транскрипта:</b>\n'}${chunks[i]}`,
            {
                reply_to_message_id: meeting.sourceMessageId || undefined,
                allow_sending_without_reply: true,
                ...Markup.inlineKeyboard([[
                    Markup.button.callback(
                        meeting.vectorizationStatus === 'completed' ? '✅ Векторизовано' : '🧠 Векторизовать',
                        meeting.vectorizationStatus === 'completed' ? 'vectorized' : `vectorize_${meetingId}`
                    )
                ]])
            }
        );
    }
});

bot.action(/vectorize_([a-f0-9]{24})/, async (ctx) => {
    const meetingId = ctx.match[1];
    await ctx.answerCbQuery('Начинаю векторизацию…');
    await ctx.telegram.editMessageReplyMarkup(
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        undefined,
        { inline_keyboard: [[{ text: '⏳ Векторизация…', callback_data: 'vectorizing' }]] }
    );
    try {
        const result = await vectorizeMeeting(meetingId, ctx.chat.id);
        await ctx.telegram.editMessageReplyMarkup(
            ctx.chat.id,
            ctx.callbackQuery.message.message_id,
            undefined,
            { inline_keyboard: [[{ text: `✅ Векторизовано: ${result.count}`, callback_data: 'vectorized' }]] }
        );
        await ctx.replyWithHTML(
            `✅ <b>Разговор векторизован</b>\n\nФрагментов: <b>${result.count}</b>\nРазмерность: <b>${result.dimensions}</b>\nМодель: <code>${result.model}</code>`,
            MAIN_MENU
        );
    } catch (error) {
        console.error('[vectorize] Ошибка:', error.message);
        await ctx.telegram.editMessageReplyMarkup(
            ctx.chat.id,
            ctx.callbackQuery.message.message_id,
            undefined,
            { inline_keyboard: [[{ text: '🔄 Повторить векторизацию', callback_data: `vectorize_${meetingId}` }]] }
        );
        await ctx.replyWithHTML(`❌ <b>Не удалось векторизовать разговор.</b>\n<code>${String(error.message).replace(/[<>&]/g, '')}</code>`);
    }
});

bot.action(['vectorizing', 'vectorized'], async (ctx) => {
    await ctx.answerCbQuery(ctx.callbackQuery.data === 'vectorized' ? 'Разговор уже векторизован' : 'Векторизация уже выполняется');
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

    // Stop the exact run.js child immediately. The lock file remains as a
    // compatibility fallback for platform monitors and container restarts.
    const processStopped = activeMeetingProcesses.stop(ctx.chat.id, meetingId);
    const lockFile = path.join(process.cwd(), `stop_${meetingId}`);
    fs.writeFileSync(lockFile, 'stop');
    console.log(`[bot] Stop ${meetingId}: process=${processStopped ? 'signalled' : 'not-found'}, lock=${lockFile}`);

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
        if (process.env.MONGODB_URI) {
            await ensureMongoIndexes();
            console.log('MongoDB Atlas подключена, индексы готовы');
        }
        const me = await bot.telegram.getMe();
        botUsername = botUsername || me.username;
        bot.launch().then(() => console.log('Бот успешно запущен')).catch(e => console.error('Ошибка запуска бота', e));
    } catch (err) {
        console.error('Failed to initialize DB:', err);
    }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
