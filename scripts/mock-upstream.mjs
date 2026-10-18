// Поддельный OpenAI-совместимый API и поддельный Upstash Redis для проверки сайта без настоящих ключей.
// Запуск: npm run mock, затем в .env.local:
//   OPENAI_BASE_URL=http://localhost:4010/v1, OPENAI_API_KEY=test-key
//   KV_REST_API_URL=http://localhost:4010/redis, KV_REST_API_TOKEN=test-redis
import http from 'node:http';

const port = Number(process.env.MOCK_PORT) || 4010;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Минимальный Redis в памяти: только команды, которые использует сайт.
const strings = new Map();
const hashes = new Map();
function redisCommand([cmd, ...args]) {
  switch (String(cmd).toUpperCase()) {
    case 'SET': strings.set(args[0], String(args[1])); return 'OK';
    case 'GET': return strings.get(args[0]) ?? null;
    case 'MGET': return args.map((k) => strings.get(k) ?? null);
    case 'DEL': return args.reduce((n, k) => n + (strings.delete(k) || hashes.delete(k) ? 1 : 0), 0);
    case 'HSET': {
      const h = hashes.get(args[0]) || new Map();
      hashes.set(args[0], h);
      for (let i = 1; i < args.length; i += 2) h.set(args[i], String(args[i + 1]));
      return (args.length - 1) / 2;
    }
    case 'HGETALL': return [...(hashes.get(args[0]) || new Map())].flat();
    case 'HDEL': return args.slice(1).reduce((n, f) => n + (hashes.get(args[0])?.delete(f) ? 1 : 0), 0);
    default: throw new Error(`ERR unknown command '${cmd}'`);
  }
}

async function handleRedis(req, res) {
  if (req.headers.authorization !== 'Bearer test-redis') {
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const run = (c) => { try { return { result: redisCommand(c) }; } catch (e) { return { error: e.message }; } };
  const out = req.url === '/redis/pipeline' ? body.map(run) : run(body);
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
}

http.createServer(async (req, res) => {
  if (req.url.startsWith('/redis')) {
    await handleRedis(req, res);
    return;
  }
  if (req.headers.authorization !== 'Bearer test-key') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    return;
  }

  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-vision' }, { id: 'mock-text' }] }));
    return;
  }

  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const system = body.messages[0]?.content || '';
    const grade = system.match(/в (\d) классе/)?.[1];
    const last = body.messages[body.messages.length - 1];
    const images = Array.isArray(last.content) ? last.content.filter((p) => p.type === 'image_url').length : 0;
    const question = Array.isArray(last.content) ? last.content[0].text : last.content;
    if (question.includes('[429]')) {
      res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Rate limit' } }));
      return;
    }

    const lines = [
      `### Задание 1`,
      `Модель: **${body.model}**, класс: **${grade}**, фото в сообщении: **${images}**, сообщений в истории: ${body.messages.length - 1}.`,
      `Вопрос: ${question.slice(0, 60)}`,
      ``,
      `**Решение:**`,
      `1) $5 \\cdot 3 = 15$ (см²) — площадь прямоугольника.`,
      `$$S = a \\cdot b = 5 \\cdot 3 = 15\\ \\text{см}^2$$`,
      `**Ответ:** 15 см².`,
      ``,
      `#### 🧒 Как объяснить ребёнку`,
      `**💡 Суть:** площадь — это сколько квадратиков 1×1 см помещается внутри фигуры.`,
      `**🍎 Как в жизни:** плитка на полу ванной: 3 ряда по 5 плиток.`,
      '```',
      '🟦🟦🟦🟦🟦',
      '🟦🟦🟦🟦🟦',
      '🟦🟦🟦🟦🟦',
      '```',
      `**🗣 Разговор по шагам:**`,
      `1. Спросите: «Сколько квадратиков в одном ряду?» — Правильный ответ: 5.`,
      `2. Спросите: «Сколько рядов?» — Правильный ответ: 3.`,
      `3. Спросите: «Как быстро посчитать все?» — Правильный ответ: $5 \\cdot 3 = 15$.`,
      `**🪜 Если застрял:**`,
      `- 🔒 Подсказка 1: посчитай квадратики в верхнем ряду.`,
      `- 🔒 Подсказка 2: все ряды одинаковые — сколько раз по 5?`,
      `- 🔒 Подсказка 3: $5 + 5 + 5$ — это то же, что $5 \\cdot 3$.`,
      `**⚠️ Частые ошибки:**`,
      `- Путают с периметром и складывают $5 + 3 + 5 + 3$.`,
      `**✅ Как проверить:** $15 : 3 = 5$ — получили длину.`,
      `**✏️ Похожее задание:** найди площадь прямоугольника 4 см на 6 см.`,
      `- 🔒 Ответ: $4 \\cdot 6 = 24$ см².`,
    ];
    const brief = question.includes('[Только ответ]');
    const answer = (brief ? lines.slice(0, lines.indexOf('#### 🧒 Как объяснить ребёнку')) : lines).join('\n');

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of answer.match(/[\s\S]{1,12}/g)) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      await sleep(question.includes('[slow]') ? 300 : 25);
    }
    res.end('data: [DONE]\n\n');
    return;
  }

  res.writeHead(404).end();
}).listen(port, () => console.log(`Mock API: http://localhost:${port}/v1`));
