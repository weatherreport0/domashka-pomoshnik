// Собирает папку build/yc-function для загрузки в Yandex Cloud Functions:
//   index.js            — точка входа (CommonJS)
//   package.json        — без "type", чтобы index.js считался CommonJS
//   app/package.json    — "type": "module" для кода сайта
//   app/handler.mjs     — обёртка HTTP-событие -> обработчик
//   app/api/*.js        — обработчики сайта
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'yc-function');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'app', 'api'), { recursive: true });

fs.copyFileSync(path.join(root, 'yandex', 'index.js'), path.join(out, 'index.js'));
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'domashka-function', private: true }, null, 2));
fs.writeFileSync(path.join(out, 'app', 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
fs.copyFileSync(path.join(root, 'yandex', 'handler.mjs'), path.join(out, 'app', 'handler.mjs'));

for (const file of fs.readdirSync(path.join(root, 'api'))) {
  // SQLite и Upstash в облачной функции не нужны — там хранилище на файлах (STORE=fs).
  if (!file.endsWith('.js') || file === '_store_sqlite.js' || file === '_store_upstash.js') continue;
  fs.copyFileSync(path.join(root, 'api', file), path.join(out, 'app', 'api', file));
}

console.log(`Собрано: ${path.relative(root, out)}`);
