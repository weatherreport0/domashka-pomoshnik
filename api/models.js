import { checkPassword, json, upstreamConfig, upstreamError } from './_lib.js';

// Список моделей, доступных по ключу, — для выбора в настройках.
export async function GET(request) {
  const auth = checkPassword(request);
  if (!auth.ok) return auth.response;

  const cfg = upstreamConfig();
  if (cfg.error) return json({ error: cfg.error }, 500);

  try {
    const res = await fetch(`${cfg.base}/models`, { headers: { authorization: `Bearer ${cfg.key}` } });
    if (!res.ok) return json({ error: await upstreamError(res), defaultModel: cfg.defaultModel, models: [] }, 502);
    const data = await res.json();
    const models = (Array.isArray(data?.data) ? data.data : [])
      .map((m) => m?.id)
      .filter((id) => typeof id === 'string')
      .sort();
    return json({ defaultModel: cfg.defaultModel, models });
  } catch (err) {
    return json({ error: `Не удалось получить список моделей: ${err.message}`, defaultModel: cfg.defaultModel, models: [] }, 502);
  }
}
