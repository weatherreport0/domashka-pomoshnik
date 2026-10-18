// Хранилище истории чатов и фото. Выбор:
//   STORE=fs                    — файлы в DATA_DIR (Yandex Cloud Functions со смонтированным бакетом);
//   заданы KV_REST_API_URL/TOKEN — Upstash Redis (Vercel);
//   иначе                       — SQLite-файл на диске (Amvera, локальный запуск).

const useUpstash = Boolean(
  (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL)
  && (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN),
);

const file = process.env.STORE === 'fs' ? './_store_fs.js'
  : useUpstash ? './_store_upstash.js'
    : './_store_sqlite.js';
const backend = await import(file);

export const { listChats, getChat, saveChat, deleteChat, putImage, getImages } = backend;
