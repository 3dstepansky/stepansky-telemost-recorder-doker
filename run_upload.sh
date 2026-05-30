#!/bin/bash

# Аргументы из n8n
FILE_PATH=$1
TITLE=$2
CHAT_ID=$3
YANDEX_USER=$4
YANDEX_PASS=$5

if [ ! -f "$FILE_PATH" ]; then
  echo "{\"error\":\"Файл $FILE_PATH не найден\"}"
  exit 1
fi

# Вызываем Node.js скрипт (Этап 1)
node upload_audio.js "$FILE_PATH" "$TITLE" "$CHAT_ID" "$YANDEX_USER" "$YANDEX_PASS"
