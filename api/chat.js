import { ID_RE, checkPassword, json, upstreamConfig, upstreamError } from './_lib.js';
import { systemPrompt } from './_prompt.js';
import { getImages } from './_store.js';

const MAX_MESSAGES = 40;
const MAX_TEXT = 20000;
const MAX_IMAGES_PER_MESSAGE = 6;
// Сколько последних фото переписки отправлять модели; более старые заменяются пометкой.
const MAX_IMAGES_TOTAL = 12;

// Пропускаем только то, что действительно шлёт наша страница: текст и ссылки на фото из базы.
function cleanContent(content) {
  if (typeof content === 'string') return content.slice(0, MAX_TEXT);
  if (!Array.isArray(content)) return null;
  const parts = [];
  let images = 0;
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text.slice(0, MAX_TEXT) });
    } else if (part?.type === 'image_ref' && typeof part.id === 'string' && ID_RE.test(part.id)
      && images < MAX_IMAGES_PER_MESSAGE) {
      images++;
      parts.push({ type: 'image_ref', id: part.id });
    }
  }
  return parts.length ? parts : null;
}

// Заменяем ссылки на фото самими фото (data URL) из базы.
async function resolveImages(messages) {
  const refs = messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_ref') : []));
  const keep = new Set(refs.slice(-MAX_IMAGES_TOTAL).map((p) => p.id));
  const ids = [...keep];
  const urls = await getImages(ids);
  const byId = new Map(ids.map((id, i) => [id, urls[i]]));
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    m.content = m.content.map((p) => {
      if (p.type !== 'image_ref') return p;
      const url = byId.get(p.id);
      return typeof url === 'string'
        ? { type: 'image_url', image_url: { url } }
        : { type: 'text', text: '[фото было приложено раньше]' };
    });
  }
}

export async function POST(request) {
  const auth = checkPassword(request);
  if (!auth.ok) return auth.response;

  const cfg = upstreamConfig();
  if (cfg.error) return json({ error: cfg.error }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Не удалось прочитать запрос.' }, 400);
  }

  const grade = Number(body?.grade);
  const model = (typeof body?.model === 'string' && body.model.trim()) || cfg.defaultModel;
  if (!model) return json({ error: 'Не выбрана модель. Откройте ⚙ Настройки и выберите модель.' }, 400);

  const messages = [];
  for (const m of Array.isArray(body?.messages) ? body.messages.slice(-MAX_MESSAGES) : []) {
    if (m?.role !== 'user' && m?.role !== 'assistant') continue;
    const content = cleanContent(m.content);
    if (content) messages.push({ role: m.role, content });
  }
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return json({ error: 'Пустое сообщение.' }, 400);
  }

  try {
    await resolveImages(messages);
  } catch (err) {
    return json({ error: err.message }, 500);
  }

  const trace = tracer(model);
  trace('start', { grade, messages: messages.length });

  // Крайний срок ответа модели (на Yandex Cloud функция и API Gateway обрываются через ~5 минут).
  const abort = new AbortController();
  request.signal?.addEventListener('abort', () => abort.abort());
  const deadline = Number(process.env.UPSTREAM_DEADLINE_MS) || 0;
  let timedOut = false;
  const timer = deadline ? setTimeout(() => { timedOut = true; abort.abort(); }, deadline) : null;
  const started = Date.now();

  let upstream;
  try {
    upstream = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'system', content: systemPrompt(grade) }, ...messages],
        // «Рассуждающие» модели могут думать минутами (особенно на русском языке) — просим думать меньше.
        ...(process.env.REASONING_EFFORT ? { reasoning_effort: process.env.REASONING_EFFORT } : {}),
      }),
      signal: abort.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    trace('fetch-error', { timedOut, error: err.message });
    if (timedOut) return json({ error: TOO_SLOW }, 504);
    return json({ error: `Не удалось связаться с API: ${err.message}` }, 502);
  }
  trace('headers', { status: upstream.status });

  if (upstream.status === 429) {
    clearTimeout(timer);
    return json({ error: 'Слишком много запросов подряд (лимит API). Подождите минуту и нажмите «Попробовать снова».' }, 429);
  }
  if (!upstream.ok) {
    clearTimeout(timer);
    return json({ error: await upstreamError(upstream) }, 502);
  }

  if (process.env.BUFFERED_RESPONSE !== '1') {
    // Отдаём поток как есть (SSE в формате OpenAI), страница разбирает его сама.
    return new Response(upstream.body, {
      headers: {
        'content-type': upstream.headers.get('content-type') || 'text/event-stream',
        'cache-control': 'no-store',
      },
    });
  }

  // Хостинг без потоковой передачи (Yandex Cloud Functions): собираем ответ целиком
  // и, если модель не уложилась в срок, отдаём то, что успело прийти.
  const { text, error } = await collectStream(upstream.body, trace);
  clearTimeout(timer);
  trace('end', { chars: text.length, timedOut, error });
  console.log(`chat: model=${model} grade=${grade} chars=${text.length} secs=${Math.round((Date.now() - started) / 1000)}${timedOut ? ' TIMEOUT' : ''}`);
  if (!text) return json({ error: timedOut ? TOO_SLOW : (error || 'Модель вернула пустой ответ.') }, timedOut ? 504 : 502);
  const content = timedOut ? `${text}\n\n_⏱ Ответ обрезан: модель отвечала слишком долго. Нажмите «Попробовать снова» или «⚡ Только ответ»._` : text;
  return json({ choices: [{ message: { role: 'assistant', content } }] });
}

// Диагностика для хостинга без доступных логов: если задан TRACE_DIR, этапы запроса пишутся
// в файл <TRACE_DIR>/<время>-<модель>.json (перезаписывается на каждом этапе). Текст переписки не пишется.
function tracer(model) {
  const dir = process.env.TRACE_DIR;
  if (!dir) return () => {};
  const started = Date.now();
  const file = `${dir}/${new Date(started).toISOString().replace(/[:.]/g, '-')}-${model}.json`;
  const events = [];
  return (phase, info = {}) => {
    events.push({ phase, ms: Date.now() - started, ...info });
    import('node:fs/promises')
      .then((fs) => fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(file, JSON.stringify(events, null, 1))))
      .catch(() => {});
  };
}

const TOO_SLOW ='Модель отвечала слишком долго. Попробуйте ещё раз или нажмите «⚡ Только ответ» — он быстрее.';

// Читает SSE-поток OpenAI и собирает текст ответа. Обрыв потока (по сроку) не считается ошибкой.
async function collectStream(body, trace = () => {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let error = null;
  let bytes = 0;
  let reasoning = 0;
  let lastTrace = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (Date.now() - lastTrace > 15000) {
        lastTrace = Date.now();
        trace('progress', { bytes, chars: text.length, reasoning });
      }
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return { text, error };
        try {
          const chunk = JSON.parse(data);
          if (chunk.error) error = chunk.error.message || 'Ошибка модели';
          const delta = chunk.choices?.[0]?.delta || {};
          text += delta.content || '';
          reasoning += (delta.reasoning_content || delta.reasoning || '').length;
        } catch {}
      }
    }
  } catch {}
  return { text, error };
}
