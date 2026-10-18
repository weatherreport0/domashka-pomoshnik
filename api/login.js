import { authCookie, clearAuthCookie, json, passwordMatches } from './_lib.js';

// Вход: проверяем пароль и ставим cookie на год.
export async function POST(request) {
  if (!process.env.SITE_PASSWORD) return json({ error: 'На сервере не задан SITE_PASSWORD.' }, 500);
  const body = await request.json().catch(() => ({}));
  if (!passwordMatches(body?.password)) return json({ error: 'Неверный пароль.' }, 401);
  return json({ ok: true }, 200, { 'set-cookie': authCookie(process.env.SITE_PASSWORD, request) });
}

// Выход.
export async function DELETE() {
  return json({ ok: true }, 200, { 'set-cookie': clearAuthCookie() });
}
