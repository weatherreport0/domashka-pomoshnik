// Сервер сайта: отдаёт public/ и вызывает обработчики из api/ (формат Web Request -> Response, как на Vercel).
// Запуск: npm start  (локально настройки берутся из .env.local, на хостинге — из переменных окружения)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT) || 3000;
// Самый большой запрос — одно фото (~1–3 МБ в base64); с запасом.
const MAX_BODY = 8 * 1024 * 1024;

const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

// Ограничиваем размер тела запроса, чтобы огромный запрос не съел память сервера.
function limitedBody(req) {
  let size = 0;
  return Readable.toWeb(req).pipeThrough(new TransformStream({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > MAX_BODY) controller.error(new Error('Body too large'));
      else controller.enqueue(chunk);
    },
  }));
}

async function handleApi(req, res, pathname) {
  const name = pathname.slice('/api/'.length);
  const file = path.join(root, 'api', `${name}.js`);
  if (!/^[a-z0-9-]+$/i.test(name) || !fs.existsSync(file)) {
    res.writeHead(404, BASE_HEADERS).end('Not found');
    return;
  }
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) {
    res.writeHead(413, BASE_HEADERS).end('Payload too large');
    return;
  }
  const mod = await import(pathToFileURL(file).href);
  const handler = mod[req.method];
  if (!handler) {
    res.writeHead(405, BASE_HEADERS).end('Method not allowed');
    return;
  }

  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? limitedBody(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
    signal: abort.signal,
  });

  const response = await handler(request);
  const headers = { ...BASE_HEADERS };
  for (const [k, v] of response.headers) if (k !== 'set-cookie') headers[k] = v;
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (response.body) {
    try {
      for await (const chunk of response.body) res.write(chunk);
    } catch {}
  }
  res.end();
}

function handleStatic(req, res, pathname) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  } catch {
    res.writeHead(400, BASE_HEADERS).end('Bad request');
    return;
  }
  const file = path.join(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, BASE_HEADERS).end('Not found');
    return;
  }
  // Библиотеки в vendor/ не меняются (версия в пути) — кэшируем надолго; свои файлы — всегда проверяем свежесть.
  const cache = rel.startsWith('vendor/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, {
    ...BASE_HEADERS,
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': cache,
  });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else handleStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, BASE_HEADERS);
    res.end('Server error');
  }
});

server.listen(port, () => {
  console.log(`Сайт запущен: http://localhost:${port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
