// Хранилище истории в SQLite-файле (встроенный node:sqlite).
// На Amvera файл лежит на постоянном диске /data и переживает перезапуски и обновления.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let db = null;

function dataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (fs.existsSync('/data')) return '/data';
  return path.resolve('data');
}

function open() {
  if (db) return db;
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, 'domashka.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS chats (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      grade      INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      photos     INTEGER NOT NULL,
      data       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chats_updated ON chats (updated_at DESC);
    CREATE TABLE IF NOT EXISTS images (
      id   TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      data BLOB NOT NULL
    );
  `);
  return db;
}

export async function listChats() {
  return open()
    .prepare('SELECT id, title, grade, created_at, updated_at, photos FROM chats ORDER BY updated_at DESC')
    .all()
    .map((r) => ({ id: r.id, title: r.title, grade: r.grade, createdAt: r.created_at, updatedAt: r.updated_at, photos: r.photos }));
}

export async function getChat(id) {
  const row = open().prepare('SELECT data FROM chats WHERE id = ?').get(id);
  return row ? JSON.parse(row.data) : null;
}

export async function saveChat(chat) {
  const photos = chat.messages.reduce((n, m) => n + (m.images?.length || 0), 0);
  open().prepare(`
    INSERT INTO chats (id, title, grade, created_at, updated_at, photos, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, grade = excluded.grade, updated_at = excluded.updated_at,
      photos = excluded.photos, data = excluded.data
  `).run(chat.id, chat.title, chat.grade, chat.createdAt, chat.updatedAt, photos, JSON.stringify(chat));
}

export async function deleteChat(chat) {
  const d = open();
  const imageIds = chat.messages.flatMap((m) => m.images || []);
  d.exec('BEGIN');
  try {
    const del = d.prepare('DELETE FROM images WHERE id = ?');
    for (const id of imageIds) del.run(id);
    d.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

const DATA_URL_RE = /^data:(image\/[a-z]+);base64,(.+)$/;

export async function putImage(id, dataUrl) {
  const m = dataUrl.match(DATA_URL_RE);
  if (!m) throw new Error('Неверное фото.');
  open().prepare('INSERT OR REPLACE INTO images (id, mime, data) VALUES (?, ?, ?)').run(id, m[1], Buffer.from(m[2], 'base64'));
}

export async function getImages(ids) {
  const get = open().prepare('SELECT mime, data FROM images WHERE id = ?');
  return ids.map((id) => {
    const row = get.get(id);
    return row ? `data:${row.mime};base64,${Buffer.from(row.data).toString('base64')}` : null;
  });
}
