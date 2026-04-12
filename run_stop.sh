#!/bin/bash

# Остановка контейнера сигналом SIGINT, чтобы Node.js успел выполнить финализацию (FFmpeg, сигналы n8n)
CONTAINER_NAME="telemost_recorder"

if docker ps | grep -q "$CONTAINER_NAME"; then
  # Получаем метаданные из логов перед остановкой (последний JSON_START)
  METADATA=$(docker logs "$CONTAINER_NAME" 2>&1 | grep -A 5 "---JSON_START---" | tail -n 6)
  
  docker stop -t 10 "$CONTAINER_NAME" > /dev/null
  docker rm "$CONTAINER_NAME" > /dev/null
  
  # Очищаем метаданные от маркеров
  JSON=$(echo "$METADATA" | sed 's/---JSON_START---//' | sed 's/---JSON_END---//')
  
  if [ -z "$JSON" ]; then
    echo '{"status":"stopped", "message":"Запись остановлена, но метаданные не получены"}'
  else
    echo "$JSON"
  fi
else
  echo '{"error":"Нет активной записи"}'
  exit 1
fi
