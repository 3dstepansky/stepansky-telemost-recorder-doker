# Руководство по локальному запуску и валидации (Quickstart & Validation)

Для запуска рекордера и транскрибатора локально на сервере выполните следующие действия.

## 1. Настройка переменных среды

Перед тестированием скопируйте `.env.example` в `.env` и заполните API ключи:
```bash
cp .env.example .env
```
Убедитесь, что заполнены `GROQ_API_KEY`, `ASSEMBLYAI_API_KEY` и данные `YANDEX_USER` / `YANDEX_WEBDAV_PASSWORD`.

---

## 2. Локальное тестирование рекордера

Сценарий записи `recorder.js` принимает на вход URL встречи и путь к файлу.

### Пример запуска (запись в фоновом режиме):
```bash
# Для Windows:
node recorder.js "https://telemost.yandex.ru/j/12345678901234" "./recordings/test/meeting_audio.webm"

# Для Linux:
HEADLESS=true node recorder.js "https://telemost.yandex.ru/j/12345678901234" "./recordings/test/meeting_audio.webm"
```

### Проверка результата записи:
1. Зайдите в ту же комнату Телемост с телефона или другого браузера.
2. Проверьте, что бот вошел в комнату под именем, указанным в `BOT_DISPLAY_NAME` (по умолчанию `Telemost Recorder`).
3. Поговорите в микрофон в течение 30-40 секунд.
4. Отправьте процессу Node.js сигнал завершения `SIGINT` (нажмите `Ctrl + C` в терминале).
5. Убедитесь, что в `./recordings/test/` появился файл `meeting_audio.webm` ненулевого размера.

---

## 3. Локальное тестирование транскрибации

Скрипт `transcribe.js` запускается со следующими параметрами:
`node transcribe.js <путь_к_аудио> <имя_папки_яндекс_диск> <название_встречи> <chat_id>`

### Пример запуска:
```bash
node transcribe.js "./recordings/test/meeting_audio.webm" "2026-06-20_TestMeeting" "Тестовая Встреча" "12345"
```

### Проверка результата транскрибации:
1. В консоли должны отображаться шаги отправки файла в AssemblyAI.
2. После завершения проверьте ваш Яндекс.Диск: в корневом каталоге должна появиться папка `Yandex.Telemost.Records/2026-06-20_TestMeeting/` с файлом `transcript.txt` и аудиозаписью.
3. Проверьте вывод stdout скрипта: он должен содержать JSON-строку с полями `step: "transcription"`, полным текстом транскрипции и массивом `utterances` со спикерами.
4. Убедитесь, что локальные файлы в каталоге `./recordings/test/` были автоматически удалены.

---

## 4. Запуск в Docker-контейнере

### Сборка образа:
```bash
docker build -t stepansky-telemost-recorder:latest .
```

### Запуск рекордера в контейнере:
```bash
docker run -d --name telemost_test \
  -v "$(pwd)/recordings:/app/recordings" \
  --env-file .env \
  stepansky-telemost-recorder:latest \
  node run.js "https://telemost.yandex.ru/j/12345678901234"
```

### Остановка контейнера (имитация нажатия стоп):
```bash
docker kill --signal=SIGINT telemost_test
```
После остановки проверьте отправку вебхука в n8n (если в `.env` указан `N8N_WEBHOOK_URL`).
