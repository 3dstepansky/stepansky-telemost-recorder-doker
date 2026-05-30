#!/bin/bash

# Аргументы из n8n
FILE_PATH=$1
TARGET_DIR_NAME=$2
TITLE=$3
CHAT_ID=$4
YANDEX_USER=$5
YANDEX_PASS=$6

if [ ! -f "$FILE_PATH" ]; then
  echo "{\"error\":\"Файл $FILE_PATH не найден\"}"
  exit 1
fi

# Вызываем Node.js скрипт (Этап 2)
node transcribe.js "$FILE_PATH" "$TARGET_DIR_NAME" "$TITLE" "$CHAT_ID" "$YANDEX_USER" "$YANDEX_PASS"
