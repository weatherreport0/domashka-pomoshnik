// Обёртка для Yandex Cloud Functions: HTTP-событие от API Gateway -> Web Request -> обработчик из api/ -> ответ.
// Облачные функции не умеют отдавать ответ по частям, поэтому ответ модели собирается целиком.

const apiDir = new URL('./api/', import.meta.url);
const TEXT_RE = /^(text\/|application\/(json|javascript))/;

function buildUrl(event, host) {
  // API Gateway кладёт фактический путь в event.url (иногда вместе с query), иначе — в event.path.
  const url = new URL(event.url || event.path || '/', `https://${host}`);
  const multi = event.multiValueQueryStringParameters || {};
  for (const [k, v] of Object.entries(event.queryStringParameters || {})) {
    if (url.searchParams.has(k)) continue;
    for (const value of multi[k] || [v]) url.searchParams.append(k, value);
  }
  return url;
}

function buildHeaders(event) {
  const headers = new Headers();
  const multi = event.multiValueHeaders || {};
  for (const [k, v] of Object.entries(event.headers || {})) {
    for (const value of multi[k] || [v]) headers.append(k, value);
  }
  // Сайт открыт через API Gateway по HTTPS — нужно для флага Secure у cookie.
  if (!headers.has('x-forwarded-proto')) headers.set('x-forwarded-proto', 'https');
  return headers;
}

function buildBody(event) {
  const { body } = event;
  if (body === undefined || body === null || body === '') return undefined;
  if (event.isBase64Encoded) return Buffer.from(body, 'base64');
  return typeof body === 'string' ? body : JSON.stringify(body);
}

export async function handle(event) {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const headers = buildHeaders(event);
  const url = buildUrl(event, headers.get('host') || 'localhost');
  const name = url.pathname.replace(/^\/api\//, '');

  if (!/^[a-z0-9-]+$/i.test(name)) return { statusCode: 404, body: 'Not found' };
  let mod;
  try {
    mod = await import(new URL(`${name}.js`, apiDir));
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') return { statusCode: 404, body: 'Not found' };
    throw err;
  }
  const handler = mod[method];
  if (!handler) return { statusCode: 405, body: 'Method not allowed' };

  const hasBody = method !== 'GET' && method !== 'HEAD';
  const request = new Request(url, { method, headers, body: hasBody ? buildBody(event) : undefined });
  const response = await handler(request);

  const outHeaders = { 'x-content-type-options': 'nosniff' };
  for (const [k, v] of response.headers) if (k !== 'set-cookie') outHeaders[k] = v;
  const cookies = response.headers.getSetCookie();
  const buf = Buffer.from(await response.arrayBuffer());
  const isText = TEXT_RE.test(response.headers.get('content-type') || 'text/plain');

  return {
    statusCode: response.status,
    headers: outHeaders,
    ...(cookies.length ? { multiValueHeaders: { 'set-cookie': cookies } } : {}),
    body: isText ? buf.toString('utf8') : buf.toString('base64'),
    isBase64Encoded: !isText,
  };
}
