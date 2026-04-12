#!/bin/bash

# Аргументы: $1 - URL, $2 - Title, $3 - Chat ID
JOIN_URL=$1
TITLE=$2
CHAT_ID=$3

if [ -z "$JOIN_URL" ]; then
  echo '{"error":"URL не указан"}'
  exit 1
fi

# Упаковываем параметры в .env или передаем напрямую в docker-compose
# Мы используем временный файл для передачи метаданных текущей сессии
MEETING_TITLE="${TITLE:-Встреча $(date +'%d.%m.%Y %H:%M')}"
export MEETING_URL="$JOIN_URL"
export MEETING_TITLE="$MEETING_TITLE"
export TELEGRAM_CHAT_ID="$CHAT_ID"

# Запуск контейнера в фоне
# Мы используем уникальное имя проекта, чтобы n8n мог отслеживать статус
docker-compose run -d --name "telemost_recorder" recorder node run.js "$JOIN_URL"

echo "{\"status\":\"started\", \"join_url\":\"$JOIN_URL\", \"title\":\"$MEETING_TITLE\", \"chat_id\":\"$CHAT_ID\"}"
