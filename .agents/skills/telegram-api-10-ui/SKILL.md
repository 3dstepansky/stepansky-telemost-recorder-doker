---
name: telegram-api-10-ui
description: >-
  Comprehensive guide and design system for building high-quality, professional Telegram Bot 
  user interfaces using Bot API 10.1 Rich Messages. Includes complete documentation for 
  sendRichMessage, Rich Blocks, and Rich Text formatting.
---

# Telegram Bot API 10.1: Rich Messages Design System

Этот навык содержит исчерпывающее руководство по проектированию пользовательских интерфейсов для Telegram-ботов с использованием **API 10.1 (июнь 2026)**. Новое API вводит концепцию **Rich Messages**, которая полностью заменяет устаревший подход с HTML/Markdown парсингом.

Используйте этот навык для безошибочного создания красивых, нативных интерфейсов.

---

## 1. Основные методы API

Вместо стандартного `sendMessage` с `parse_mode`, API 10.1 предоставляет два новых метода для отправки структурированного контента.

### `sendRichMessage`
Используется для отправки готового структурированного сообщения.
```javascript
// Пример вызова через Telegraf
await ctx.telegram.callApi('sendRichMessage', {
    chat_id: ctx.chat.id,
    rich_message: {
        blocks: [ ... ] // Массив объектов RichBlock
    },
    reply_markup: { ... } // (Опционально) Inline-клавиатура
});
```

### `sendRichMessageDraft`
Используется ИИ-агентами для потоковой передачи (streaming) генерируемого ответа в реальном времени. Обновляет сообщение по мере добавления новых блоков, не требуя ручного вызова `editMessageText`.
```javascript
await ctx.telegram.callApi('sendRichMessageDraft', {
    chat_id: ctx.chat.id,
    message_id: messageToEditId,
    rich_message: { blocks: [ ... ] }
});
```

---

## 2. Форматирование текста (RichText)

Внутри блоков контент определяется объектами `RichText`. В API 10.1 больше нет строковых тегов (`<b>`, `<i>`), вместо них используются типизированные объекты.

*   **`plain`**: Обычный текст. `{"type": "plain", "text": "Привет"}`
*   **`bold`**: Жирный текст. `{"type": "bold", "text": "Важно"}`
*   **`italic`**: Курсив. `{"type": "italic", "text": "Подсказка"}`
*   **`underline`**: Подчеркнутый. `{"type": "underline", "text": "Ссылка"}`
*   **`strikethrough`**: Зачеркнутый. `{"type": "strikethrough", "text": "Удалено"}`
*   **`code`**: Моноширинный (копируется по клику). `{"type": "code", "text": "ID-12345"}`
*   **`spoiler`**: Скрытый текст (спойлер). `{"type": "spoiler", "text": "Секрет"}`
*   **`subscript` / `superscript`**: Подстрочный и надстрочный текст. `{"type": "superscript", "text": "2"}`
*   **`math`**: Рендеринг LaTeX формул. `{"type": "math", "text": "E = mc^2"}`
*   **`custom_emoji`**: Анимированные эмодзи. `{"type": "custom_emoji", "document_id": "54321..."}`

**Комбинирование стилей (`RichTextArray`)**:
Если в одной строке нужны разные стили, используется массив текстов:
```json
{
  "type": "array", 
  "texts": [
    { "type": "plain", "text": "Имя: " },
    { "type": "bold", "text": "Иван" }
  ]
}
```

---

## 3. Структурные блоки (RichBlock)

Массив `blocks` внутри `rich_message` определяет вертикальную структуру сообщения. Ниже представлены все основные типы блоков.

### 📌 `section_heading` (Заголовок)
Нативный заголовок раздела. Отображается крупным системным шрифтом.
```json
{
  "type": "section_heading",
  "text": { "type": "bold", "text": "🤖 Главное меню" }
}
```

### 📌 `paragraph` (Абзац)
Стандартный текстовый блок.
```json
{
  "type": "paragraph",
  "text": { "type": "plain", "text": "Добро пожаловать в систему автоматизации." }
}
```

### 📌 `list` (Список)
Форматированный список с маркерами. Идеален для вывода логов, свойств и метаданных.
```json
{
  "type": "list",
  "style": "bulleted", // или "numbered"
  "items": [
    { "type": "plain", "text": "🆔 ID Встречи: 99999" },
    { "type": "bold", "text": "👤 Имя: Бот-Ассистент" }
  ]
}
```

### 📌 `table` (Таблица)
Нативная таблица для вывода аналитики.
```json
{
  "type": "table",
  "headers": [
    { "type": "bold", "text": "Спикер" },
    { "type": "bold", "text": "Время" }
  ],
  "rows": [
    [ { "type": "plain", "text": "Иван" }, { "type": "plain", "text": "45 мин" } ],
    [ { "type": "plain", "text": "Анна" }, { "type": "plain", "text": "12 мин" } ]
  ]
}
```

### 📌 `details` (Спойлер / Скрытая секция)
Сворачиваемый блок (аккордеон). Идеально подходит для длинных логов ошибок или полных транскриптов.
```json
{
  "type": "details",
  "title": { "type": "bold", "text": "Развернуть полный лог ошибки" },
  "blocks": [
    { "type": "paragraph", "text": { "type": "code", "text": "Error: Timeout at line 42" } }
  ]
}
```

### 📌 `thinking` (Статус загрузки)
Отображает нативную анимацию пульсации в клиенте ("Бот думает..."). **Обязательно к использованию для всех долгих асинхронных операций!**
```json
{
  "type": "thinking",
  "text": { "type": "plain", "text": "Подключение к комнате и запуск рекордера..." }
}
```

---

## 4. Архитектурный шаблон (Полный пример)

Используйте этот шаблон при создании информационных сводок или отчетов бота.

```javascript
await ctx.telegram.callApi('sendRichMessage', {
    chat_id: ctx.chat.id,
    rich_message: {
        blocks: [
            // Шапка
            { 
                "type": "section_heading", 
                "text": { "type": "bold", "text": "📝 ТРАНСКРИБАЦИЯ ЗАВЕРШЕНА" } 
            },
            // Описание
            { 
                "type": "paragraph", 
                "text": { "type": "plain", "text": "Анализ аудиофайла успешно выполнен. Ниже приведена статистика." } 
            },
            // Список метаданных
            { 
                "type": "list", 
                "style": "bulleted",
                "items": [
                    { "type": "plain", "text": "Длительность: 45:12" },
                    { "type": "plain", "text": "Спикеров: 3" }
                ]
            },
            // Свернутый полный текст (Details)
            {
                "type": "details",
                "title": { "type": "bold", "text": "Читать полный текст" },
                "blocks": [
                    { "type": "paragraph", "text": { "type": "plain", "text": "Спикер А: Всем привет...\nСпикер Б: Да, мы готовы." } }
                ]
            }
        ]
    },
    // Кнопки действий
    reply_markup: {
        inline_keyboard: [
            [ { text: "☁️ Открыть на Диске", url: "https://disk.yandex.ru/..." } ],
            [ { text: "🔙 В меню", callback_data: "menu_main" } ]
        ]
    }
});
```

## 5. Главные правила и ограничения (Anti-patterns)
1. **Не используйте `parse_mode: 'HTML'`**. Это устаревший и нестабильный метод, уязвимый к ошибкам экранирования спецсимволов.
2. **Всегда используйте `RichBlockThinking`** при ожидании ответа от внешних API (LLM, Транскрибация, Загрузка). Пользователь должен видеть, что процесс идет.
3. **Прячьте огромные массивы текста**. Больше никаких гигантских сообщений в чат! Транскрипты, логи сбоев и длинные списки оборачивайте в блок `RichBlockDetails`.
4. **Не передавайте строки в `text`**. В Rich Messages поле `text` всегда принимает объект `{"type": "...", "text": "..."}`, а не сырую строку.
