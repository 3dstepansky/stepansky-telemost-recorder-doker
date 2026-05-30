-- SQL-скрипт для создания таблицы в базе данных Postgres / Supabase
-- Запустите этот скрипт в панели SQL-запросов вашей СУБД или через n8n.

CREATE TABLE IF NOT EXISTS public.meeting_transcripts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL, -- Относительный путь к аудиофайлу на Яндекс.Диске
    chat_id VARCHAR(100) NOT NULL, -- ID Telegram чата для отправки уведомлений
    transcript TEXT NOT NULL, -- Полный текст транскрибации
    summary TEXT, -- Саммари встречи от ИИ
    speaker_count INTEGER DEFAULT 1,
    utterance_count INTEGER NOT NULL,
    utterances JSONB NOT NULL, -- Детализированный массив фраз спикеров с таймингами
    transcribed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    operation_id VARCHAR(100) NOT NULL
);

-- Создаем индекс для быстрого поиска встреч по Chat ID
CREATE INDEX IF NOT EXISTS idx_meeting_transcripts_chat_id 
ON public.meeting_transcripts(chat_id);

-- Создаем индекс для уникального идентификатора операции (предотвращение дублирования записей)
CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_transcripts_operation_id 
ON public.meeting_transcripts(operation_id);

-- Таблица для хранения индивидуальных настроек пользователей (Яндекс.Диск WebDAV)
CREATE TABLE IF NOT EXISTS public.user_settings (
    chat_id VARCHAR(100) PRIMARY KEY,
    state VARCHAR(50) DEFAULT 'IDLE',
    yandex_user VARCHAR(255),
    yandex_webdav_password VARCHAR(255), -- Пароль приложения для WebDAV
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

