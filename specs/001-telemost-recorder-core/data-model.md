# Модель данных и Контракты взаимодействия (Data Model & Contracts)

## 1. Конфигурация окружения (.env)

Система конфигурируется через переменные окружения. Пример структуры:

```ini
# Отображаемое имя бота в конференции Яндекс.Телемост
BOT_DISPLAY_NAME="Бот-Ассистент"

# API Ключи для транскрибации
GROQ_API_KEY="gsk_..."
ASSEMBLYAI_API_KEY="your_assemblyai_key"

# Лимиты и настройки записи
MAX_IDLE_MINS=3          # Таймаут нахождения в пустой комнате (минуты)
MAX_DURATION_MINS=180    # Максимальное время записи одной встречи (минуты)
HEADLESS=true            # Запускать ли Puppeteer без графического окна (true/false)

# Настройки интеграции
N8N_WEBHOOK_URL="https://n8n.your-domain.ru/webhook/..." # Адрес обратного вызова n8n

# Настройки опционального S3-хранилища
S3_ACCESS_KEY="s3_key"
S3_SECRET_KEY="s3_secret"
S3_BUCKET="telemost-audio-bucket"
S3_REGION="ru-central1"
S3_ENDPOINT="https://storage.yandexcloud.net"

# Учетные данные Яндекс.Диска по умолчанию (для отладки)
YANDEX_USER="your_yandex_login"
YANDEX_WEBDAV_PASSWORD="yandex_app_password"
```

---

## 2. Структура директорий записи

При старте встречи в каталоге `./recordings` создается временная изолированная папка сессии:

```text
recordings/
└── 2026-06-20T07-15-45-123Z/        # Метка времени старта (ISO с заменой двоеточий)
    ├── meeting_audio.webm           # Полный записанный аудиофайл встречи
    ├── transcript.txt               # Сгенерированный текстовый транскрипт (до выгрузки)
    └── chunks/                      # Каталог временных сегментов (только при фоллбэке на Groq)
        ├── meeting_audio_000.webm   # Чанк 1 (10 минут)
        ├── meeting_audio_001.webm   # Чанк 2 (10 минут)
        └── meeting_audio_002.webm   # Чанк 3 (остаток)
```

---

## 3. Выходная папка на Яндекс.Диске

WebDAV клиент создает следующую структуру в корневом облачном пространстве пользователя:

```text
Yandex.Telemost.Records/
└── [targetDirName]/                 # Название папки (например: 2026-06-20_DailySync)
    ├── meeting_audio.webm           # Копия аудиофайла встречи
    ├── transcript.txt               # Итоговый текстовый файл расшифровки встречи
    └── summary.txt                  # Файл краткого ИИ-саммари по шаблону
```

---

## 4. Контракт webhook-вызова n8n по окончании записи

Скрипт `run.js` после завершения рекордера делает POST-запрос на `N8N_WEBHOOK_URL` со следующим JSON-телом:

```json
{
  "file": "/opt/telemost-recorder/recordings/2026-06-20T07-15-45-123Z/meeting_audio.webm",
  "title": "Telemost 2026-06-20T07-15-45-123Z",
  "chat_id": "123456789"
}
```

---

## 5. Выходной формат stdout скрипта `transcribe.js`

По завершении шага транскрибации на stdout выводится JSON-строка, парсируемая оркестратором n8n:

```json
{
  "step": "transcription",
  "title": "Название встречи",
  "chat_id": "123456789",
  "target_dir_name": "2026-06-20_Павел и Ксения о разработке бота",
  "audio_file": "Yandex.Telemost.Records/2026-06-20_Павел и Ксения о разработке бота/meeting_audio.webm",
  "transcript_file": "Yandex.Telemost.Records/2026-06-20_Павел и Ксения о разработке бота/transcript.txt",
  "summary_file": "Yandex.Telemost.Records/2026-06-20_Павел и Ксения о разработке бота/summary.txt",
  "transcript": "Полный текст расшифровки всей встречи...",
  "summary": "Бизнес-саммари встречи:\n- Ключевые темы: ...\n- Принятые решения: ...\n- Задачи: ...",
  "utterances": [
    {
      "speaker": "Спикер 0",
      "text": "Приветствую всех на ежедневном созвоне.",
      "start": 0.12,
      "end": 2.54
    },
    {
      "speaker": "Спикер 1",
      "text": "Привет! Начнем с отчета по стабилизации контейнера.",
      "start": 3.1,
      "end": 6.85
    }
  ],
  "speaker_count": 2,
  "utterance_count": 2,
  "transcribed_at": "2026-06-20T07:18:22.045Z"
}
```
> При работе через резервный пайплайн Groq поле `speaker` заполняется значением `"Спикер (Groq)"`, так как модель Groq Whisper-large-v3 не поддерживает автоматическую диаризацию.
