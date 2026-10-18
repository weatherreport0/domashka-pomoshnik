// Хранилище истории обычными файлами в папке DATA_DIR.
// В Yandex Cloud Functions эта папка — смонтированный бакет Object Storage (/function/storage/<точка>).
//
//   meta.json            список чатов для боковой панели: { <id>: {id, title, grade, createdAt, updatedAt, photos} }
//   chats/<id>.json      чат целиком
//   images/<id>          фото (первая строка файла — mime, дальше base64) — без лишних зависимостей

import fs from 'node:fs/promises';
import path from 'node:path';

function dir(...parts) {
  const base = process.env.DATA_DIR || path.resolve('data');
  return path.join(base, ...parts);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeFile(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}

async function updateMeta(fn) {
  const file = dir('meta.json');
  const meta = await readJson(file, {});
  fn(meta);
  await writeFile(file, JSON.stringify(meta));
}

export async function listChats() {
  const meta = await readJson(dir('meta.json'), {});
  return Object.values(meta).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getChat(id) {
  return readJson(dir('chats', `${id}.json`), null);
}

export async function saveChat(chat) {
  const photos = chat.messages.reduce((n, m) => n + (m.images?.length || 0), 0);
  await writeFile(dir('chats', `${chat.id}.json`), JSON.stringify(chat));
  await updateMeta((meta) => {
    meta[chat.id] = { id: chat.id, title: chat.title, grade: chat.grade, createdAt: chat.createdAt, updatedAt: chat.updatedAt, photos };
  });
}

export async function deleteChat(chat) {
  const imageIds = chat.messages.flatMap((m) => m.images || []);
  await Promise.all(imageIds.map((id) => fs.rm(dir('images', id), { force: true })));
  await fs.rm(dir('chats', `${chat.id}.json`), { force: true });
  await updateMeta((meta) => { delete meta[chat.id]; });
}

const DATA_URL_RE = /^data:(image\/[a-z]+);base64,(.+)$/;

export async function putImage(id, dataUrl) {
  const m = dataUrl.match(DATA_URL_RE);
  if (!m) throw new Error('Неверное фото.');
  await writeFile(dir('images', id), `${m[1]}\n${m[2]}`);
}

export async function getImages(ids) {
  return Promise.all(ids.map(async (id) => {
    try {
      const raw = await fs.readFile(dir('images', id), 'utf8');
      const nl = raw.indexOf('\n');
      return `data:${raw.slice(0, nl)};base64,${raw.slice(nl + 1)}`;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }));
}
