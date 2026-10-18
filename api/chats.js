import { ID_RE, checkPassword, json } from './_lib.js';
import { deleteChat, getChat, listChats, saveChat } from './_store.js';

// История чатов:
//   GET    /api/chats          список чатов (без сообщений)
//   GET    /api/chats?id=…     один чат целиком
//   PUT    /api/chats?id=…     сохранить чат целиком
//   PATCH  /api/chats?id=…     переименовать / сменить класс
//   DELETE /api/chats?id=…     удалить чат вместе с его фото

const MAX_MESSAGES = 300;
const MAX_TEXT = 50000;
// Кнопки под ответом ("Объясни проще" и т.д.) — см. ACTIONS в public/app.js.
const ACTIONS = new Set(['explain', 'simpler', 'deeper', 'practice', 'check']);

function cleanTitle(title) {
  return typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
}

function cleanGrade(grade) {
  const g = Number(grade);
  return g >= 4 && g <= 9 ? g : 6;
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return null;
  const out = [];
  for (const m of messages.slice(0, MAX_MESSAGES)) {
    if (m?.role !== 'user' && m?.role !== 'assistant') continue;
    const msg = { role: m.role, text: typeof m.text === 'string' ? m.text.slice(0, MAX_TEXT) : '' };
    if (m.role === 'user' && Array.isArray(m.images)) {
      const images = m.images.filter((id) => typeof id === 'string' && ID_RE.test(id)).slice(0, 6);
      if (images.length) msg.images = images;
    }
    if (m.role === 'user' && ACTIONS.has(m.action)) msg.action = m.action;
    if (m.role === 'user' && m.mode === 'brief') msg.mode = 'brief';
    if (m.role === 'assistant' && typeof m.error === 'string') msg.error = m.error.slice(0, 1000);
    out.push(msg);
  }
  return out;
}

async function handle(request, fn) {
  const auth = checkPassword(request);
  if (!auth.ok) return auth.response;
  try {
    return await fn(new URL(request.url).searchParams.get('id'));
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

export function GET(request) {
  return handle(request, async (id) => {
    if (!id) return json({ chats: await listChats() });
    if (!ID_RE.test(id)) return json({ error: 'Неверный id.' }, 400);
    const chat = await getChat(id);
    return chat ? json({ chat }) : json({ error: 'Чат не найден.' }, 404);
  });
}

export function PUT(request) {
  return handle(request, async (id) => {
    if (!id || !ID_RE.test(id)) return json({ error: 'Неверный id.' }, 400);
    const body = await request.json().catch(() => null);
    const messages = cleanMessages(body?.messages);
    if (!messages) return json({ error: 'Неверные данные чата.' }, 400);
    const old = await getChat(id);
    const now = Date.now();
    const chat = {
      id,
      title: cleanTitle(body.title) || old?.title || 'Новый чат',
      grade: cleanGrade(body.grade),
      createdAt: old?.createdAt || now,
      updatedAt: now,
      messages,
    };
    await saveChat(chat);
    return json({ ok: true, updatedAt: now });
  });
}

export function PATCH(request) {
  return handle(request, async (id) => {
    if (!id || !ID_RE.test(id)) return json({ error: 'Неверный id.' }, 400);
    const body = await request.json().catch(() => ({}));
    const chat = await getChat(id);
    if (!chat) return json({ error: 'Чат не найден.' }, 404);
    if (body.title !== undefined) chat.title = cleanTitle(body.title) || chat.title;
    if (body.grade !== undefined) chat.grade = cleanGrade(body.grade);
    await saveChat(chat);
    return json({ ok: true });
  });
}

export function DELETE(request) {
  return handle(request, async (id) => {
    if (!id || !ID_RE.test(id)) return json({ error: 'Неверный id.' }, 400);
    const chat = await getChat(id);
    if (chat) await deleteChat(chat);
    return json({ ok: true });
  });
}
