#!/bin/bash

# Аргументы: $1 - Chat ID, $2 - Meeting ID (опционально)
CHAT_ID=$1
MEETING_ID=$2

if [ -z "$CHAT_ID" ]; then
  echo '{"error":"Chat ID не указан"}'
  exit 1
fi

if [ -n "$MEETING_ID" ]; then
  CONTAINER_NAME="telemost_${CHAT_ID}_${MEETING_ID}"
  CONTAINERS=$(docker ps -a --format '{{.Names}}' | grep "^${CONTAINER_NAME}$")
else
  # Ищем все контейнеры для этого chat_id (старый формат или новые с суффиксом ID встречи)
  CONTAINERS=$(docker ps -a --format '{{.Names}}' | grep -E "^telemost_${CHAT_ID}$|^telemost_${CHAT_ID}_")
fi

if [ -z "$CONTAINERS" ]; then
  echo "{\"error\":\"Запись для чата $CHAT_ID не найдена\"}"
  exit 1
fi

# Останавливаем все найденные контейнеры
for CONTAINER in $CONTAINERS; do
  docker stop -t 10 "$CONTAINER" > /dev/null
  docker rm "$CONTAINER" > /dev/null
  echo "{\"status\":\"stopped\", \"chat_id\":\"$CHAT_ID\", \"container\":\"$CONTAINER\"}"
done
