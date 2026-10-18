import { randomUUID } from 'node:crypto';
import { ID_RE, checkPassword, json } from './_lib.js';
import { getImages, putImage } from './_store.js';

// Фото заданий:
//   POST /api/images        { dataUrl } -> { id }
//   GET  /api/images?id=…   сама картинка (для <img src>)

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
const MAX_DATA_URL = 4 * 1024 * 1024;

export async function POST(request) {
  const auth = checkPassword(request);
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  const dataUrl = body?.dataUrl;
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_DATA_URL || !DATA_URL_RE.test(dataUrl)) {
    return json({ error: 'Неверное или слишком большое фото.' }, 400);
  }
  const id = randomUUID();
  try {
    await putImage(id, dataUrl);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
  return json({ id });
}

export async function GET(request) {
  const auth = checkPassword(request);
  if (!auth.ok) return auth.response;
  const id = new URL(request.url).searchParams.get('id');
  if (!id || !ID_RE.test(id)) return json({ error: 'Неверный id.' }, 400);
  let dataUrl;
  try {
    [dataUrl] = await getImages([id]);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
  const m = typeof dataUrl === 'string' && dataUrl.match(DATA_URL_RE);
  if (!m) return json({ error: 'Фото не найдено.' }, 404);
  return new Response(Buffer.from(m[2], 'base64'), {
    headers: { 'content-type': m[1], 'cache-control': 'private, max-age=31536000, immutable' },
  });
}
