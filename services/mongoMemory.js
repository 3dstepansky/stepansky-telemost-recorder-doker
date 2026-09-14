import { MongoClient, ObjectId } from 'mongodb';

let client;
let database;

function requireConfig() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI не задан');
  return process.env.MONGODB_DB_NAME || 'telemost_memory';
}

export async function getMongoDb() {
  const dbName = requireConfig();
  if (!client) {
    client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 20000,
      maxPoolSize: 10,
    });
    await client.connect();
    database = client.db(dbName);
  }
  return database;
}

export async function ensureMongoIndexes() {
  const db = await getMongoDb();
  await Promise.all([
    db.collection('meetings').createIndex({ chatId: 1, createdAt: -1 }),
    db.collection('meetings').createIndex({ sourceMeetingId: 1, chatId: 1 }),
    db.collection('meetings').createIndex({ vectorizationStatus: 1, createdAt: -1 }),
    db.collection('people').createIndex({ normalizedName: 1 }, { unique: true, sparse: true }),
    db.collection('transcript_chunks').createIndex({ meetingId: 1, chunkIndex: 1 }, { unique: true }),
    db.collection('transcript_chunks').createIndex({ chatId: 1, createdAt: -1 }),
  ]);
  return true;
}

function collectSpeakers(transcriptionResult = {}) {
  const names = new Set();
  for (const utterance of transcriptionResult.utterances || []) {
    const name = String(utterance.speakerName || utterance.speaker || '').trim();
    if (name && !/^speaker\s*[a-z0-9]+$/i.test(name)) names.add(name);
  }
  return [...names];
}

export async function saveMeetingResult({
  chatId,
  sourceMeetingId,
  title,
  transcript,
  summary,
  transcriptionResult,
  recordingPath,
  folderName,
}) {
  const db = await getMongoDb();
  await ensureMongoIndexes();
  const now = new Date();
  const people = collectSpeakers(transcriptionResult);
  const document = {
    chatId: String(chatId),
    source: 'telemost',
    sourceMeetingId: String(sourceMeetingId || folderName || ''),
    title: String(title || 'Встреча'),
    transcript: String(transcript || ''),
    summary: String(summary || ''),
    people,
    speakerCount: transcriptionResult?.speakerCount ?? people.length,
    utteranceCount: transcriptionResult?.utteranceCount ?? transcriptionResult?.utterances?.length ?? 0,
    recordingPath: recordingPath || null,
    folderName: folderName || null,
    vectorizationStatus: 'not_requested',
    vectorizedAt: null,
    updatedAt: now,
  };

  const result = await db.collection('meetings').findOneAndUpdate(
    { chatId: document.chatId, sourceMeetingId: document.sourceMeetingId },
    { $set: document, $setOnInsert: { createdAt: now } },
    { upsert: true, returnDocument: 'after' },
  );

  for (const name of people) {
    await db.collection('people').updateOne(
      { normalizedName: name.toLocaleLowerCase('ru-RU') },
      {
        $set: { name, normalizedName: name.toLocaleLowerCase('ru-RU'), updatedAt: now },
        $setOnInsert: { createdAt: now },
        $addToSet: { meetingIds: result._id },
      },
      { upsert: true },
    );
  }
  return result;
}

export async function getMeetingForChat(meetingId, chatId) {
  if (!ObjectId.isValid(meetingId)) return null;
  const db = await getMongoDb();
  return db.collection('meetings').findOne({ _id: new ObjectId(meetingId), chatId: String(chatId) });
}

export async function setVectorizationStatus(meetingId, status, extra = {}) {
  const db = await getMongoDb();
  return db.collection('meetings').updateOne(
    { _id: new ObjectId(meetingId) },
    { $set: { vectorizationStatus: status, updatedAt: new Date(), ...extra } },
  );
}

export async function replaceMeetingChunks(meetingId, chatId, chunks) {
  const db = await getMongoDb();
  const objectId = new ObjectId(meetingId);
  await db.collection('transcript_chunks').deleteMany({ meetingId: objectId });
  if (chunks.length) {
    await db.collection('transcript_chunks').insertMany(chunks.map((chunk, index) => ({
      meetingId: objectId,
      chatId: String(chatId),
      chunkIndex: index,
      text: chunk.text,
      embedding: chunk.embedding,
      embeddingModel: chunk.embeddingModel,
      dimensions: chunk.embedding.length,
      createdAt: new Date(),
    })));
  }
  return chunks.length;
}

export async function closeMongo() {
  if (client) await client.close();
  client = null;
  database = null;
}
