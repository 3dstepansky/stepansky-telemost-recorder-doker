#!/bin/bash

# Аргументы: $1 - Имя
NEW_NAME=$1

if [ -z "$NEW_NAME" ]; then
  echo '{"error":"Имя не указано"}'
  exit 1
fi

# Обновляем .env файл
if [ "$NEW_NAME" == "--reset" ]; then
  # Возвращаем дефолт
  sed -i "s/BOT_DISPLAY_NAME=.*/BOT_DISPLAY_NAME=Бот-Ассистент/" .env
  echo '{"display_name":"Бот-Ассистент", "message":"Сброшено к настройкам по умолчанию"}'
else
  # Записываем новое имя
  if grep -q "BOT_DISPLAY_NAME" .env; then
    sed -i "s/BOT_DISPLAY_NAME=.*/BOT_DISPLAY_NAME=$NEW_NAME/" .env
  else
    echo "BOT_DISPLAY_NAME=$NEW_NAME" >> .env
  fi
  echo "{\"display_name\":\"$NEW_NAME\"}"
fi
