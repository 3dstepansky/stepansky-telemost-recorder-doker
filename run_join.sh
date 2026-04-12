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

# Запуск контейнера. 
# Пробрасываем CHAT_ID и монтируем папку с записями
# Используем --network="host" для доступа к локальному n8n (если нужно)
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -e CHAT_ID="$CHAT_ID" \
  -v /opt/telemost-recorder/recordings:/app/recordings \
  --network="host" \
  telemost-recorder-recorder node run.js "$JOIN_URL"

echo "{\"status\":\"started\", \"chat_id\":\"$CHAT_ID\", \"container\":\"$CONTAINER_NAME\"}"
