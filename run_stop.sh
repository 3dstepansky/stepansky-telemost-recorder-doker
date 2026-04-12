#!/bin/bash

# Аргументы: $1 - Chat ID
CHAT_ID=$1
CONTAINER_NAME="telemost_$CHAT_ID"

if [ -z "$CHAT_ID" ]; then
  echo '{"error":"Chat ID не указан"}'
  exit 1
fi

if docker ps -a --format '{{.Names}}' | grep -q "^$CONTAINER_NAME$"; then
  # Посылаем SIGTERM для корректного завершения (run.js поймает его и отправит вебхук)
  docker stop -t 10 "$CONTAINER_NAME" > /dev/null
  docker rm "$CONTAINER_NAME" > /dev/null
  echo "{\"status\":\"stopped\", \"chat_id\":\"$CHAT_ID\", \"container\":\"$CONTAINER_NAME\"}"
else
  echo "{\"error\":\"Запись для чата $CHAT_ID не найдена\"}"
  exit 1
fi
