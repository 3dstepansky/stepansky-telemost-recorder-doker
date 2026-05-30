#!/bin/bash

# Аргументы: $1 - Title, $2 - Chat ID
TITLE=$1
CHAT_ID=$2

# 1. Запускаем рекордер в режиме --create, чтобы получить URL
# Мы делаем это через изолированный Docker-контейнер, чтобы избежать появления зомби-процессов Chromium на хосте
CREATE_LOG=$(docker run --rm --init --entrypoint node stepansky-telemost-recorder:latest recorder.js --create 2>/dev/null)
JOIN_URL=$(echo "$CREATE_LOG" | grep -o 'https://telemost.yandex.ru/j/[0-9a-zA-Z]*' | head -n 1)

if [ -z "$JOIN_URL" ]; then
  echo "{\"error\":\"Не удалось создать встречу. Ответ: $CREATE_LOG\"}"
  exit 1
fi

# 2. Теперь запускаем полноценный процесс записи для этого URL
/bin/bash ./run_join.sh "$JOIN_URL" "$TITLE" "$CHAT_ID"
