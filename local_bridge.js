import http from 'http';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';

const PORT = 3000;
const CONTAINER_NAME = 'telemost_test_session';
const RECORDINGS_DIR = path.resolve('./recordings');

// Создаем папку recordings, если её нет
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  try {
    if (req.method === 'POST' && req.url === '/start') {
      const data = await parseJsonBody(req);
      const { url, title = 'Встреча', chat_id = 'default_chat' } = data;

      if (!url) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Параметр url обязателен' }));
      }

      console.log(`[Bridge] Starting container for: ${url} (Title: ${title})`);

      // 1. Останавливаем и удаляем старый контейнер, если он есть
      exec(`docker rm -f ${CONTAINER_NAME}`, (rmErr) => {
        // 2. Запускаем новый контейнер
        // Прокидываем необходимые ENV-переменные для отправки вебхуков обратно в n8n
        const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL || 'https://stepan8nsky.casacam.net/webhook/telemost-recording-finished';
        const groqKey = process.env.GROQ_API_KEY || '';
        
        const dockerCmd = `docker run -d --name ${CONTAINER_NAME} ` +
          `-e CHAT_ID="${chat_id}" ` +
          `-e MEETING_TITLE="${title}" ` +
          `-e N8N_WEBHOOK_URL="${n8nWebhookUrl}" ` +
          `-e GROQ_API_KEY="${groqKey}" ` +
          `-v "${RECORDINGS_DIR}:/app/recordings" ` +
          `stepansky-telemost-recorder:latest "${url}"`;

        console.log(`[Bridge] Executing: ${dockerCmd}`);

        exec(dockerCmd, (err, stdout, stderr) => {
          if (err) {
            console.error('[Bridge] Start error:', err);
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message, stderr }));
          } else {
            console.log('[Bridge] Container started successfully:', stdout.trim());
            res.writeHead(200);
            res.end(JSON.stringify({ status: 'started', container: CONTAINER_NAME, id: stdout.trim() }));
          }
        });
      });

    } else if (req.method === 'POST' && req.url === '/stop') {
      console.log('[Bridge] Received stop request. Sending SIGINT...');
      
      // Отправляем сигнал SIGINT в контейнер для graceful shutdown рекордера
      exec(`docker kill --signal=SIGINT ${CONTAINER_NAME}`, (err, stdout, stderr) => {
        if (err) {
          console.error('[Bridge] Stop error:', err);
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message, stderr }));
        } else {
          console.log('[Bridge] SIGINT signal sent to container:', stdout.trim());
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'stopping', info: stdout.trim() }));
        }
      });

    } else if (req.method === 'POST' && req.url === '/transcribe') {
      const data = await parseJsonBody(req);
      let { file, title = 'Встреча', chat_id = 'default_chat' } = data;

      if (!file) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Параметр file обязателен' }));
      }

      // Если передано 'latest', ищем самый свежий .webm файл в папке recordings
      if (file === 'latest') {
        try {
          const findLatestWebm = (dir) => {
            let latestFile = null;
            let latestMtime = 0;

            const traverse = (currentDir) => {
              const files = fs.readdirSync(currentDir);
              for (const f of files) {
                const fullPath = path.join(currentDir, f);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                  traverse(fullPath);
                } else if (f.endsWith('.webm')) {
                  if (stat.mtimeMs > latestMtime) {
                    latestMtime = stat.mtimeMs;
                    latestFile = fullPath;
                  }
                }
              }
            };

            traverse(dir);
            return latestFile;
          };

          const latestWebm = findLatestWebm(RECORDINGS_DIR);
          if (!latestWebm) {
            res.writeHead(404);
            return res.end(JSON.stringify({ error: 'В папке recordings не найдено записанных встреч (.webm файлов)' }));
          }
          file = latestWebm;
          console.log(`[Bridge] Auto-detected latest file: ${file}`);
        } catch (err) {
          console.error('[Bridge] Error finding latest file:', err);
          res.writeHead(500);
          return res.end(JSON.stringify({ error: 'Ошибка поиска последнего файла: ' + err.message }));
        }
      }

      console.log(`[Bridge] Starting transcription for file: ${file}`);
      
      // Запускаем transcribe.js на хосте
      // Аргументы: [filePath, title, chatId]
      const cmd = `node transcribe.js "${file}" "${title}" "${chat_id}"`;
      console.log(`[Bridge] Executing: ${cmd}`);

      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error('[Bridge] Transcription error:', err);
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message, stderr, stdout }));
        } else {
          try {
            // Пытаемся распарсить JSON, который вывел transcribe.js
            const lines = stdout.trim().split('\n');
            const lastLine = lines[lines.length - 1]; // Скрипт выводит JSON в самом конце
            const result = JSON.parse(lastLine);
            res.writeHead(200);
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Не удалось распарсить вывод транскрибатора', stdout, stderr }));
          }
        }
      });

    } else if (req.method === 'GET' && req.url === '/status') {
      exec('docker ps --filter name=telemost -a --format "{{.Names}}: {{.Status}}"', (err, stdout, stderr) => {
        res.writeHead(200);
        res.end(JSON.stringify({
          bridge: 'running',
          docker: err ? 'error' : 'ok',
          containers: stdout.trim().split('\n').filter(Boolean),
          recordings_dir: RECORDINGS_DIR
        }));
      });

    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not Found' }));
    }
  } catch (e) {
    console.error('[Bridge] Internal error:', e);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`[Bridge] Listening on port ${PORT}`);
});
