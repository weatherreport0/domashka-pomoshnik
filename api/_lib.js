import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Общие помощники для серверных функций. Файлы с "_" Vercel не публикует как отдельные адреса.

const COOKIE = 'hw_auth';

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function sameText(a, b) {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Токен для cookie выводится из пароля: смена SITE_PASSWORD разлогинивает все устройства.
function authToken(password) {
  return createHmac('sha256', password).update('domashka-auth-v1').digest('hex');
}

function readCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

// Secure — когда сайт открыт по HTTPS (за прокси хостинга это видно по x-forwarded-proto).
function isHttps(request) {
  const proto = request.headers.get('x-forwarded-proto') || new URL(request.url).protocol.replace(':', '');
  return proto.split(',')[0].trim() === 'https';
}

export function authCookie(password, request) {
  const secure = isHttps(request) ? '; Secure' : '';
  return `${COOKIE}=${authToken(password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`;
}

export function clearAuthCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function passwordMatches(given) {
  const expected = process.env.SITE_PASSWORD;
  return Boolean(expected) && sameText(given || '', expected);
}

export function checkPassword(request) {
  const expected = process.env.SITE_PASSWORD;
  if (!expected) return { ok: false, response: json({ error: 'На сервере не задан SITE_PASSWORD.' }, 500) };

  const cookie = readCookie(request, COOKIE);
  if (cookie && sameText(cookie, authToken(expected))) return { ok: true };
  const header = request.headers.get('x-site-password');
  if (header && sameText(header, expected)) return { ok: true };
  return { ok: false, response: json({ error: 'Нужно войти.' }, 401) };
}

export function upstreamConfig() {
  const key = process.env.OPENAI_API_KEY;
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (!key) return { error: 'На сервере не задан OPENAI_API_KEY.' };
  return { key, base, defaultModel: process.env.OPENAI_MODEL || '' };
}

export async function upstreamError(res) {
  let text = '';
  try {
    text = await res.text();
    const data = JSON.parse(text);
    text = data?.error?.message || data?.message || text;
  } catch {}
  return `Ошибка API (${res.status}): ${String(text).slice(0, 500) || res.statusText}`;
}

export const ID_RE = /^[a-z0-9-]{8,40}$/;
