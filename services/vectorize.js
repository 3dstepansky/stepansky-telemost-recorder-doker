import axios from 'axios';
import { getMeetingForChat, replaceMeetingChunks, setVectorizationStatus } from './mongoMemory.js';

const DEFAULT_MODEL = 'jina-embeddings-v5-omni-small';

export function chunkTranscript(text, maxChars = 2800, overlapChars = 300) {
  const clean = String(text || '').replace(/\r/g, '').trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\n{2,}/).map(x => x.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  const push = () => {
    if (!current.trim()) return;
    chunks.push(current.trim());
    current = current.slice(Math.max(0, current.length - overlapChars)).trim();
  };

  for (const paragraph of paragraphs) {
    const pieces = paragraph.length <= maxChars
      ? [paragraph]
      : paragraph.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, 'g')) || [];
    for (const piece of pieces) {
      if (current && current.length + piece.length + 2 > maxChars) push();
      current = current ? `${current}\n\n${piece}` : piece;
      if (current.length >= maxChars) push();
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return [...new Set(chunks)];
}

export async function embedTexts(texts, task = 'retrieval.passage') {
  if (!process.env.JINA_API_KEY) throw new Error('JINA_API_KEY не задан');
  const model = process.env.EMBEDDING_MODEL || DEFAULT_MODEL;
  const response = await axios.post('https://api.jina.ai/v1/embeddings', {
    model,
    task,
    normalized: true,
    input: texts.map(text => ({ text })),
  }, {
    headers: {
      Authorization: `Bearer ${process.env.JINA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: 180000,
  });
  const data = response.data?.data;
  if (!Array.isArray(data) || data.length !== texts.length) throw new Error('Jina вернула неполный набор векторов');
  return { model, vectors: data.map(item => item.embedding) };
}

export async function vectorizeMeeting(meetingId, chatId) {
  const meeting = await getMeetingForChat(meetingId, chatId);
  if (!meeting) throw new Error('Встреча не найдена или недоступна');
  const texts = chunkTranscript(meeting.transcript);
  if (!texts.length) throw new Error('Транскрипция встречи пуста');

  await setVectorizationStatus(meetingId, 'processing', { vectorizationError: null });
  try {
    const embedded = [];
    let model = DEFAULT_MODEL;
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16);
      const result = await embedTexts(batch, 'retrieval.passage');
      model = result.model;
      embedded.push(...batch.map((text, index) => ({ text, embedding: result.vectors[index], embeddingModel: model })));
    }
    const count = await replaceMeetingChunks(meetingId, chatId, embedded);
    await setVectorizationStatus(meetingId, 'completed', {
      vectorizedAt: new Date(),
      vectorChunkCount: count,
      embeddingModel: model,
      embeddingDimensions: embedded[0]?.embedding.length || null,
      vectorizationError: null,
    });
    return { count, model, dimensions: embedded[0]?.embedding.length || 0 };
  } catch (error) {
    await setVectorizationStatus(meetingId, 'failed', { vectorizationError: String(error.message).slice(0, 500) });
    throw error;
  }
}
