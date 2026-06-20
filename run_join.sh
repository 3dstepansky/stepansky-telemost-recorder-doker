#!/bin/bash

# Аргументы: $1 - URL, $2 - Chat ID, $3 - Bot Display Name, $4 - Meeting Title
JOIN_URL=$1
CHAT_ID=$2
BOT_DISPLAY_NAME=$3
MEETING_TITLE=$4

if [ -z "$JOIN_URL" ]; then
  echo '{"error":"URL не указан"}'
  exit 1
fi

if [ -z "$CHAT_ID" ]; then
  echo '{"error":"Chat ID не указан"}'
  exit 1
fi

# Извлекаем ID встречи из URL (после /j/)
MEETING_ID=$(echo "$JOIN_URL" | sed -n 's|.*/j/\([a-zA-Z0-9]\{1,\}\).*|\1|p')

if [ -z "$MEETING_ID" ]; then
  echo '{"error":"Не удалось извлечь ID встречи из URL"}'
  exit 1
fi

# Проверяем, запущен ли уже активный контейнер для этой встречи
if docker ps --format '{{.Names}}' | grep -q "_${MEETING_ID}$"; then
  echo "{\"error\":\"Запись для встречи $MEETING_ID уже запущена\", \"meeting_id\":\"$MEETING_ID\"}"
  exit 1
fi

# Имя контейнера включает chat_id и meeting_id
CONTAINER_NAME="telemost_${CHAT_ID}_${MEETING_ID}"

# Чистим старый контейнер с таким же именем, если он существует (например, остановлен)
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  docker stop "$CONTAINER_NAME" 2>/dev/null
  docker rm "$CONTAINER_NAME" 2>/dev/null
fi

# Настройки вебхука и путей
WEBHOOK_URL="${N8N_WEBHOOK_URL:-https://stepan8nsky.casacam.net/webhook/telemost-recording-finished}"
HOST_PATH="${HOST_RECORDINGS_DIR:-/opt/telemost-recorder/recordings}"

# Настройка дополнительных параметров окружения
ENV_OPTS=()
if [ -n "$BOT_DISPLAY_NAME" ]; then
  ENV_OPTS+=("-e" "BOT_DISPLAY_NAME=$BOT_DISPLAY_NAME")
fi
if [ -n "$MEETING_TITLE" ]; then
  ENV_OPTS+=("-e" "MEETING_TITLE=$MEETING_TITLE")
fi

# Запуск контейнера
docker run -d --init \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -e CHAT_ID="$CHAT_ID" \
  -e N8N_WEBHOOK_URL="$WEBHOOK_URL" \
  "${ENV_OPTS[@]}" \
  -v "$HOST_PATH":/app/recordings \
  --network="host" \
  stepansky-telemost-recorder:latest "$JOIN_URL"

echo "{\"status\":\"started\", \"chat_id\":\"$CHAT_ID\", \"meeting_id\":\"$MEETING_ID\", \"container\":\"$CONTAINER_NAME\"}"
