# Используем официальный образ Node.js (slim версия для уменьшения размера)
FROM node:20-slim

# Установка зависимостей системных библиотек для работы Chromium в Docker
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ffmpeg \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Настройка переменных окружения для Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Создание рабочей директории
WORKDIR /app

# Копирование файлов зависимостей
COPY package*.json ./

# Установка npm-пакетов
RUN npm install --production

# Копирование остального исходного кода
COPY . .

# Создание папки для записей
RUN mkdir -p recordings

# Запуск по умолчанию (ожидается передача URL в аргументах)
ENTRYPOINT ["node", "run.js"]
