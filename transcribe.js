import { transcribe } from './services/ai.js';

const filePath = process.argv[2];
const title = process.argv[3] || 'Без названия';

if (!filePath) {
  console.log(JSON.stringify({ error: "Путь к файлу не передан" }));
  process.exit(1);
}

async function run() {
  try {
    const result = await transcribe(filePath);
    
    // Формируем JSON ответ для n8n
    console.log(JSON.stringify({
      title: title,
      file_path: filePath,
      transcript: result.text,
      utterances: result.utterances,
      speaker_count: result.speaker_count,
      utterance_count: result.utterances.length,
      transcribed_at: new Date().toISOString(),
      operation_id: 'local_' + Date.now()
    }));
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
    process.exit(1);
  }
}

run();
