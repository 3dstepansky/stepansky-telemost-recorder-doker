#!/bin/bash

# Аргументы: $1 - Путь к файлу, $2 - Заголовок
FILE_PATH=$1
TITLE=$2

if [ ! -f "$FILE_PATH" ]; then
  echo "{\"error\":\"Файл $FILE_PATH не найден\"}"
  exit 1
fi

# Вызываем Node.js скрипт транскрибации (ZeroPay Whisper)
# Он возвращает JSON, который n8n распарсит в Parse Transcript
node transcribe.js "$FILE_PATH" "$TITLE"
