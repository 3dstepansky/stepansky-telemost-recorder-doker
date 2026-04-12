#!/bin/bash

# Аргументы из n8n: $1 - Путь, $2 - Заголовок, $3 - Chat ID
FILE_PATH=$1
TITLE=$2
CHAT_ID=$3

if [ ! -f "$FILE_PATH" ]; then
  echo "{\"error\":\"Файл $FILE_PATH не найден\"}"
  exit 1
fi

# Вызываем Node.js скрипт транскрибации
# Он возвращает JSON, который n8n распарсит в Parse Transcript
node transcribe.js "$FILE_PATH" "$TITLE" "$CHAT_ID"
