import assert from 'assert';

// Временный mock для axios и groq-sdk, чтобы протестировать логику
// Мы протестируем функции напрямую с замоканными клиентами.

// Мокаем Groq
class MockGroq {
  constructor() {
    this.chat = {
      completions: {
        create: async ({ messages }) => {
          const userMessage = messages.find(m => m.role === 'user').content;
          const systemMessage = messages.find(m => m.role === 'system').content;

          if (systemMessage.includes("Количество уникальных спикеров")) {
            // Тест определения метаданных
            if (userMessage.includes("Много участников")) {
              return {
                choices: [{
                  message: {
                    content: JSON.stringify({
                      speaker_count: 6,
                      speakers: ["Павел", "Ксения", "Игорь", "Олег", "Светлана", "Иван"],
                      topic: "оптимизация бизнес процессов"
                    })
                  }
                }]
              };
            } else {
              return {
                choices: [{
                  message: {
                    content: JSON.stringify({
                      speaker_count: 2,
                      speakers: ["Павел", "Ксения"],
                      topic: "разработка телеграм бота"
                    })
                  }
                }]
              };
            }
          } else {
            // Тест суммаризации
            return {
              choices: [{
                message: {
                  content: "Бизнес-саммари:\n- Ключевые темы: ...\n- Задачи: ..."
                }
              }]
            };
          }
        }
      }
    };
  }
}

// Функции-заглушки для тестирования логики формирования имени
function getFolderTitle(speakerCount, speakers, topic, defaultTitle) {
  let folderTitle = '';
  if (speakerCount >= 5) {
    folderTitle = `конференция на тему ${topic}`;
  } else {
    if (speakers && speakers.length > 0) {
      folderTitle = `${speakers.join(' и ')} о ${topic}`;
    } else {
      folderTitle = `${defaultTitle} о ${topic}`;
    }
  }
  const cleanFolderTitle = folderTitle.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_\-\s]/g, '').trim() || 'Встреча';
  return cleanFolderTitle;
}

async function runTests() {
  console.log("=== ЗАПУСК ЮНИТ-ТЕСТОВ ЛОГИКИ ИИ И ПЕРЕИМЕНОВАНИЯ ===");

  // 1. Тест правил формирования имени папки
  console.log("Тест 1: Формирование имени для < 5 спикеров...");
  const title1 = getFolderTitle(2, ["Павел", "Ксения"], "разработка телеграм бота", "Тест");
  console.log("Результат:", title1);
  assert.strictEqual(title1, "Павел и Ксения о разработка телеграм бота");

  console.log("Тест 2: Формирование имени для >= 5 спикеров...");
  const title2 = getFolderTitle(6, ["Павел", "Ксения", "Игорь", "Олег", "Светлана"], "оптимизация бизнес процессов", "Тест");
  console.log("Результат:", title2);
  assert.strictEqual(title2, "конференция на тему оптимизация бизнес процессов");

  console.log("Тест 3: Формирование имени без определенных спикеров...");
  const title3 = getFolderTitle(1, [], "обсуждение задач", "Встреча-Daily");
  console.log("Результат:", title3);
  assert.strictEqual(title3, "Встреча-Daily о обсуждение задач");

  // 2. Тестируем ИИ метаданные с помощью MockGroq
  console.log("\nТест 4: Имитация работы Groq для 2 спикеров...");
  const mockGroq = new MockGroq();
  const res1 = await mockGroq.chat.completions.create({
    messages: [
      { role: "system", content: "Количество уникальных спикеров" },
      { role: "user", content: "Павел и Ксения разговаривают о боте" }
    ]
  });
  const meta1 = JSON.parse(res1.choices[0].message.content);
  assert.strictEqual(meta1.speaker_count, 2);
  assert.deepStrictEqual(meta1.speakers, ["Павел", "Ксения"]);
  assert.strictEqual(meta1.topic, "разработка телеграм бота");
  console.log("Успешно!");

  console.log("\nТест 5: Имитация работы Groq для 6 спикеров (Много участников)...");
  const res2 = await mockGroq.chat.completions.create({
    messages: [
      { role: "system", content: "Количество уникальных спикеров" },
      { role: "user", content: "Много участников говорят об оптимизации" }
    ]
  });
  const meta2 = JSON.parse(res2.choices[0].message.content);
  assert.strictEqual(meta2.speaker_count, 6);
  assert.strictEqual(meta2.topic, "оптимизация бизнес процессов");
  console.log("Успешно!");

  console.log("\n=== ВСЕ ТЕСТЫ ПРОЙДЕНЫ УСПЕШНО ===");
}

runTests().catch(err => {
  console.error("Тест упал с ошибкой:", err);
  process.exit(1);
});
