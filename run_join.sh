#!/bin/bash

# Аргументы из n8n: $1 - URL, $2 - Chat ID
JOIN_URL=$1
CHAT_ID=$2

if [ -z "$JOIN_URL" ]; then
  echo '{"error":"URL не указан"}'
  exit 1
fi

# Имя контейнера привязано к чату для поддержки параллельных записей
CONTAINER_NAME="telemost_$CHAT_ID"

# Чистим старые контейнеры с таким же именем (если зависли)
docker stop "$CONTAINER_NAME" 2>/dev/null
docker rm "$CONTAINER_NAME" 2>/dev/null

# Настройки вебхука и путей
WEBHOOK_URL="${N8N_WEBHOOK_URL:-https://stepan8nsky.casacam.net/webhook/telemost-recording-finished}"
HOST_PATH="${HOST_RECORDINGS_DIR:-/opt/telemost-recorder/recordings}"

# Запуск контейнера
docker run -d --init \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -e CHAT_ID="$CHAT_ID" \
  -e N8N_WEBHOOK_URL="$WEBHOOK_URL" \
  -v "$HOST_PATH":/app/recordings \
  --network="host" \
  stepansky-telemost-recorder:latest "$JOIN_URL"

echo "{\"status\":\"started\", \"chat_id\":\"$CHAT_ID\", \"container\":\"$CONTAINER_NAME\"}"
