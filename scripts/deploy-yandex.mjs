// Разворачивает сайт в Yandex Cloud (бесплатный уровень serverless). Можно запускать повторно — обновит.
//   node scripts/deploy-yandex.mjs
// Нужно: утилита yc, выполненный `yc init` (облако и каталог выбраны).
//
// Что создаётся (если ещё нет):
//   сервисный аккаунт domashka-sa (роли: storage.editor — нужна для удаления чатов и фото, storage.uploader, storage.viewer, functions.functionInvoker)
//   бакет domashka-site-<суффикс>  — страница сайта (public/)
//   бакет domashka-data-<суффикс>  — история чатов и фото (монтируется в функцию как /function/storage/data)
//   функция domashka-api           — обработчики /api/* (Node.js 22)
//   API Gateway domashka           — общий адрес: страница из бакета + /api/* в функцию
//
// Адрес API, ключ и пароль сайта (OPENAI_BASE_URL, OPENAI_API_KEY, SITE_PASSWORD) в коде не хранятся:
// их задаёт scripts/set-secrets-yandex.mjs, а при повторном развёртывании они переносятся
// из текущей версии функции и не выводятся на экран.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localYc = path.join(os.homedir(), 'yandex-cloud', 'bin', process.platform === 'win32' ? 'yc.exe' : 'yc');
const YC = fs.existsSync(localYc) ? localYc : 'yc';

const PUBLIC_ENV = {
  STORE: 'fs',
  DATA_DIR: '/function/storage/data',
  // Функция не умеет отдавать ответ по частям: собираем его целиком, но не дольше 4 минут.
  BUFFERED_RESPONSE: '1',
  UPSTREAM_DEADLINE_MS: '240000',
  // Журнал этапов запросов к модели (без текста переписки) — для диагностики, в бакете data/trace.
  TRACE_DIR: '/function/storage/data/trace',
  // kimi-k3 «рассуждает»; без ограничения на заданиях по русскому думает дольше 4 минут.
  REASONING_EFFORT: 'low',
  OPENAI_MODEL: 'kimi-k3',
};
// Не публикуются: берутся из окружения этого запуска или переносятся из текущей версии функции.
const SECRET_ENV = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'SITE_PASSWORD'];

function yc(args, { json = true, quiet = false } = {}) {
  const out = execFileSync(YC, [...args, ...(json ? ['--format', 'json'] : [])], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return json ? JSON.parse(out || 'null') : out;
}

function tryYc(args) {
  try {
    return yc(args, { quiet: true });
  } catch {
    return null;
  }
}

function step(text) {
  console.log(`\n▶ ${text}`);
}

// ---------- Каталог ----------

const folderId = yc(['config', 'get', 'folder-id'], { json: false }).trim();
if (!folderId) throw new Error('Не выбран каталог: выполните `yc init`.');
const suffix = folderId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-8);
const SITE_BUCKET = `domashka-site-${suffix}`;
const DATA_BUCKET = `domashka-data-${suffix}`;
console.log(`Каталог: ${folderId}`);

// ---------- Сервисный аккаунт ----------

step('Сервисный аккаунт');
let sa = tryYc(['iam', 'service-account', 'get', '--name', 'domashka-sa']);
if (!sa) sa = yc(['iam', 'service-account', 'create', '--name', 'domashka-sa', '--description', 'Сайт помощника с уроками']);
for (const role of ['storage.editor', 'storage.uploader', 'storage.viewer', 'functions.functionInvoker']) {
  tryYc(['resource-manager', 'folder', 'add-access-binding', folderId, '--role', role, '--subject', `serviceAccount:${sa.id}`]);
}
console.log(`domashka-sa: ${sa.id}`);

// ---------- Бакеты ----------

step('Бакеты');
for (const bucket of [SITE_BUCKET, DATA_BUCKET]) {
  if (!tryYc(['storage', 'bucket', 'get', '--name', bucket])) {
    yc(['storage', 'bucket', 'create', '--name', bucket, '--default-storage-class', 'standard', '--max-size', String(1024 ** 3)]);
  }
  console.log(bucket);
}

step('Загрузка страницы сайта');
// Загружаем по одному файлу: `yc storage s3 cp --recursive` на Windows пишет в ключи обратные слэши
// и угадывает тип CSS/JS как text/plain — браузер такой CSS не применит.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/plain; charset=utf-8',
  '': 'text/plain; charset=utf-8',
};
function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(full) : [full];
  });
}
yc(['storage', 's3', 'rm', '--recursive', '--only-show-errors', `s3://${SITE_BUCKET}/`], { json: false });
const publicDir = path.join(root, 'public');
for (const file of listFiles(publicDir)) {
  const key = path.relative(publicDir, file).split(path.sep).join('/');
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  const cache = key.startsWith('vendor/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  yc(['storage', 's3', 'cp', '--only-show-errors', '--no-guess-mime-type', '--content-type', type, '--cache-control', cache,
    file, `s3://${SITE_BUCKET}/${key}`], { json: false });
}
console.log('файлов загружено:', listFiles(publicDir).length);

// ---------- Функция ----------

step('Сборка и загрузка функции');
execFileSync(process.execPath, [path.join(root, 'scripts', 'build-yandex.mjs')], { stdio: 'inherit' });
let fn = tryYc(['serverless', 'function', 'get', '--name', 'domashka-api']);
if (!fn) fn = yc(['serverless', 'function', 'create', '--name', 'domashka-api']);

// Ключ и пароль: из окружения этого запуска (их передаёт scripts/set-secrets-yandex.mjs),
// иначе переносим из текущей версии функции. На экран не печатаются.
const current = tryYc(['serverless', 'function', 'version', 'get-by-tag', '--function-id', fn.id, '--tag', '$latest']);
const env = { ...PUBLIC_ENV };
for (const name of SECRET_ENV) {
  const value = process.env[name] || current?.environment?.[name];
  if (value) env[name] = value;
}
const missing = SECRET_ENV.filter((n) => !env[n]);

const envArg = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(',');
if (/,/.test(Object.values(env).join(''))) throw new Error('Значения переменных не должны содержать запятых.');
yc(['serverless', 'function', 'version', 'create',
  '--function-id', fn.id,
  '--runtime', 'nodejs22',
  '--entrypoint', 'index.handler',
  '--memory', '256MB',
  '--execution-timeout', '280s',
  '--service-account-id', sa.id,
  '--source-path', path.join(root, 'build', 'yc-function'),
  '--environment', envArg,
  '--mount', `type=object-storage,mount-point=data,bucket=${DATA_BUCKET}`,
], { quiet: true });
console.log(`domashka-api: ${fn.id}`);

// ---------- API Gateway ----------

step('API Gateway');
const fnIntegration = {
  'x-yc-apigateway-integration': {
    type: 'cloud_functions', function_id: fn.id, tag: '$latest', service_account_id: sa.id,
  },
  parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
};
const staticIntegration = (object) => ({
  'x-yc-apigateway-integration': {
    type: 'object_storage', bucket: SITE_BUCKET, object, service_account_id: sa.id,
  },
});
const spec = {
  openapi: '3.0.0',
  info: { title: 'domashka', version: '1.0.0' },
  paths: {
    '/': { get: staticIntegration('index.html') },
    '/api/{name}': Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((m) => [m, fnIntegration])),
    '/{file+}': {
      get: {
        ...staticIntegration('{file}'),
        parameters: [{ name: 'file', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
  },
};
const specFile = path.join(root, 'build', 'gateway.json');
fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));

let gw = tryYc(['serverless', 'api-gateway', 'get', '--name', 'domashka']);
gw = gw
  ? yc(['serverless', 'api-gateway', 'update', '--name', 'domashka', '--spec', specFile])
  : yc(['serverless', 'api-gateway', 'create', '--name', 'domashka', '--spec', specFile]);

console.log(`\n✅ Готово. Адрес сайта: https://${gw.domain}`);
if (missing.length) {
  console.log(`\n⚠ В функции ещё не заданы: ${missing.join(', ')}.`);
  console.log('  Консоль Yandex Cloud → Cloud Functions → domashka-api → Редактор → Переменные окружения →');
  console.log('  добавьте их и нажмите «Сохранить изменения».');
}
