// Хранилище истории в Upstash Redis через REST API (используется, если заданы KV_REST_API_URL / KV_REST_API_TOKEN).
//
// Ключи:
//   hw:meta          hash  chatId -> JSON {id, title, grade, createdAt, updatedAt, photos}
//   hw:chat:<id>     string JSON {id, title, grade, createdAt, updatedAt, messages}
//   hw:img:<id>      string data:image/jpeg;base64,...

function config() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('База для истории не подключена (нет KV_REST_API_URL / KV_REST_API_TOKEN).');
  return { url: url.replace(/\/+$/, ''), token };
}

async function call(path, body) {
  const { url, token } = config();
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) throw new Error(`Ошибка базы: ${data?.error || res.status}`);
  return data;
}

export async function redis(...command) {
  return (await call('/', command)).result;
}

export async function pipeline(commands) {
  const results = await call('/pipeline', commands);
  for (const r of results) if (r.error) throw new Error(`Ошибка базы: ${r.error}`);
  return results.map((r) => r.result);
}

const metaKey = 'hw:meta';
const chatKey = (id) => `hw:chat:${id}`;
const imgKey = (id) => `hw:img:${id}`;

export async function listChats() {
  const flat = (await redis('HGETALL', metaKey)) || [];
  const list = [];
  for (let i = 1; i < flat.length; i += 2) {
    try { list.push(JSON.parse(flat[i])); } catch {}
  }
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getChat(id) {
  const raw = await redis('GET', chatKey(id));
  return raw ? JSON.parse(raw) : null;
}

function metaOf(chat) {
  const photos = chat.messages.reduce((n, m) => n + (m.images?.length || 0), 0);
  return { id: chat.id, title: chat.title, grade: chat.grade, createdAt: chat.createdAt, updatedAt: chat.updatedAt, photos };
}

export async function saveChat(chat) {
  await pipeline([
    ['SET', chatKey(chat.id), JSON.stringify(chat)],
    ['HSET', metaKey, chat.id, JSON.stringify(metaOf(chat))],
  ]);
}

export async function deleteChat(chat) {
  const imageIds = chat.messages.flatMap((m) => m.images || []);
  await pipeline([
    ['DEL', chatKey(chat.id), ...imageIds.map(imgKey)],
    ['HDEL', metaKey, chat.id],
  ]);
}

export async function putImage(id, dataUrl) {
  await redis('SET', imgKey(id), dataUrl);
}

export async function getImages(ids) {
  if (!ids.length) return [];
  return (await redis('MGET', ...ids.map(imgKey))) || [];
}
