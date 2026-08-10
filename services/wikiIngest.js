import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'meeting';
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function parseAllowedChatIds(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function isWikiRawIngestEnabled(chatId, env = process.env) {
  if (String(env.WIKI_RAW_INGEST_ENABLED || '').toLowerCase() !== 'true') return false;

  const allowed = parseAllowedChatIds(env.WIKI_RAW_INGEST_CHAT_IDS);
  if (allowed.size === 0) return false;

  return allowed.has(String(chatId));
}

function buildRawNote({ title, kind, body, sourceUrl, chatId, yandexDirName, createdAt }) {
  const ingested = createdAt.toISOString().slice(0, 10);
  const contentBody = String(body || '').trim() + '\n';
  const digest = sha256(contentBody);
  const label = kind === 'summary' ? 'ИИ-саммари' : 'Транскрипция';

  return `---\n` +
    `source_url: ${yamlString(sourceUrl)}\n` +
    `ingested: ${ingested}\n` +
    `sha256: ${digest}\n` +
    `title: ${yamlString(`${title} — ${label}`)}\n` +
    `source: telemost-recorder\n` +
    `telegram_chat_id: ${yamlString(chatId)}\n` +
    `yandex_dir: ${yamlString(yandexDirName)}\n` +
    `kind: ${kind}\n` +
    `---\n\n` +
    `# ${title} — ${label}\n\n` +
    `**Источник:** Telemost Recorder  \n` +
    `**Папка:** \`${yandexDirName}\`  \n` +
    `**Telegram chat_id:** \`${chatId}\`\n\n` +
    contentBody;
}

function appendLog(wikiPath, title, files, createdAt) {
  const logPath = path.join(wikiPath, 'log.md');
  if (!fs.existsSync(logPath)) return;

  const date = createdAt.toISOString().slice(0, 10);
  const relFiles = files.map((file) => path.relative(wikiPath, file));
  const entry = `\n## [${date}] ingest | Telemost raw transcript — ${title}\n` +
    relFiles.map((file) => `- Saved raw source: ${file}`).join('\n') +
    '\n';

  fs.appendFileSync(logPath, entry, 'utf8');
}

export function ingestTelemostToWikiRaw({
  chatId,
  title,
  targetDirName,
  activeDirName,
  transcriptText,
  summaryText,
  createdAt = new Date(),
  env = process.env,
}) {
  if (!isWikiRawIngestEnabled(chatId, env)) {
    return { skipped: true, reason: 'disabled-or-chat-not-allowed' };
  }

  const wikiPath = env.WIKI_PATH || env.OBSIDIAN_VAULT_PATH || '/home/ubuntu/baza';
  const rawDir = path.join(wikiPath, 'raw', 'transcripts');
  fs.mkdirSync(rawDir, { recursive: true });

  const safeTitle = String(title || 'Telemost meeting').trim();
  const date = createdAt.toISOString().slice(0, 10);
  const time = createdAt.toISOString().slice(11, 19).replace(/:/g, '-');
  const baseName = `telemost-${date}-${time}-${slugify(safeTitle)}`;
  const yandexDirName = activeDirName || targetDirName || '';
  const sourceUrl = `yandex-disk:Yandex.Telemost.Records/${yandexDirName}`;

  const transcriptPath = path.join(rawDir, `${baseName}-transcript.md`);
  const summaryPath = path.join(rawDir, `${baseName}-summary.md`);

  fs.writeFileSync(transcriptPath, buildRawNote({
    title: safeTitle,
    kind: 'transcript',
    body: transcriptText,
    sourceUrl,
    chatId,
    yandexDirName,
    createdAt,
  }), 'utf8');

  fs.writeFileSync(summaryPath, buildRawNote({
    title: safeTitle,
    kind: 'summary',
    body: summaryText,
    sourceUrl,
    chatId,
    yandexDirName,
    createdAt,
  }), 'utf8');

  appendLog(wikiPath, safeTitle, [transcriptPath, summaryPath], createdAt);

  return {
    skipped: false,
    files: [transcriptPath, summaryPath],
  };
}

export const __private__ = {
  buildRawNote,
  isWikiRawIngestEnabled,
  parseAllowedChatIds,
  sha256,
  slugify,
};
