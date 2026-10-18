'use strict';

const MAX_IMAGE_SIDE = 1600;
const IMAGE_QUALITY = 0.82;
const MAX_ATTACHMENTS = 6;

// Кнопки под последним ответом. label — что видно в чате, prompt — что уходит модели.
const ACTIONS = {
  explain: {
    label: '🧒 Как объяснить ребёнку',
    prompt: 'Как объяснить ребёнку. Для каждого задания из своего предыдущего ответа дай блок «#### 🧒 Как объяснить ребёнку» по шаблону. Решение не повторяй.',
  },
  simpler: {
    label: '🧒 Объясни проще',
    prompt: 'Объясни проще. Дай только новый блок «🧒 Как объяснить ребёнку» по тому же шаблону: ещё проще, другими словами, с другой аналогией из жизни, как для ребёнка на 2 года младше. Решение не повторяй.',
  },
  deeper: {
    label: '🔍 Подробнее',
    prompt: 'Подробнее. Разбери самый трудный шаг решения детально: почему делаем именно так, с промежуточными вычислениями или рассуждениями. Затем дай обновлённый «🗣 Разговор по шагам» с более мелкими шагами.',
  },
  practice: {
    label: '✏️ Ещё задания',
    prompt: 'Ещё задания. Дай 3 похожих задания по возрастающей сложности (легко, средне, чуть сложнее) под заголовком «### Задания для тренировки». Для каждого: условие, затем строки «- 🔒 Ответ: ...» и «- 🔒 Решение: ...».',
  },
  check: {
    label: '📷 Проверь решение ребёнка',
    prompt: 'Проверь решение. На фото — как ребёнок решил это задание сам. Проверь каждое действие. Не исправляй сразу: для каждой ошибки скажи мне, где она, и дай вопрос, который поможет ребёнку найти её самому; правильный вариант спрячь в строку с 🔒. Если всё верно — похвали конкретно, за что. Отметь оформление. Заголовок «### Проверка решения».',
    needsPhoto: true,
  },
};

const $ = (id) => document.getElementById(id);
const els = {
  loading: $('loading'),
  login: $('login'), loginForm: $('login-form'), loginPassword: $('login-password'), loginError: $('login-error'),
  app: $('app'), sidebar: $('sidebar'), backdrop: $('backdrop'), chatList: $('chat-list'),
  newChat: $('new-chat'), newChatTop: $('new-chat-top'), openSidebar: $('open-sidebar'), closeSidebar: $('close-sidebar'),
  openSettings: $('open-settings'), chatTitle: $('chat-title'), grade: $('grade'),
  messages: $('messages'), empty: $('empty'),
  attachments: $('attachments'), form: $('composer-form'), fileInput: $('file-input'), attach: $('attach'),
  input: $('input'), send: $('send'), sendBrief: $('send-brief'), stop: $('stop'),
  settings: $('settings'), model: $('model'), modelInfo: $('model-info'), logout: $('logout'),
};

// ---------- Хранилище браузера: только мелкие настройки (класс по умолчанию, модель) ----------

const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch {}
  },
};
// Старые ключи из версии без истории на сервере.
store.remove('hw_pass');
store.remove('hw_chat');

// ---------- Состояние ----------

let chats = [];      // список чатов для боковой панели: [{ id, title, grade, updatedAt, photos }]
let current = null;  // открытый чат: { id, title, grade, messages, saved }
let pending = [];    // фото для ещё не отправленного сообщения: [{ url }]
let controller = null;
let busy = false;
let modelsLoaded = false;
const localImages = new Map(); // id фото -> data URL (чтобы только что отправленное фото не грузить заново)

class AuthError extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    showLogin('Нужно войти заново.');
    throw new AuthError('Нужно войти.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
  return data;
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- Вход ----------

function showLogin(message = '') {
  els.loading.hidden = true;
  els.app.hidden = true;
  els.login.hidden = false;
  if (els.settings.open) els.settings.close();
  els.loginError.textContent = message;
  els.loginPassword.value = '';
  els.loginPassword.focus();
}

els.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.loginError.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: els.loginPassword.value }),
    });
    if (res.ok) {
      boot();
      return;
    }
    const data = await res.json().catch(() => ({}));
    els.loginError.textContent = data.error || `Ошибка ${res.status}`;
  } catch {
    els.loginError.textContent = 'Нет связи с сервером. Проверьте интернет.';
  }
  els.loginPassword.select();
});

async function logout() {
  try { await fetch('/api/login', { method: 'DELETE' }); } catch {}
  modelsLoaded = false;
  chats = [];
  current = null;
  showLogin();
}

// ---------- Отрисовка сообщений ----------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const MATH_RE = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?!\s)[^$\n]+?\$/g;

function renderMarkdown(el, text) {
  if (!window.marked || !window.DOMPurify) {
    el.textContent = text;
    el.style.whiteSpace = 'pre-wrap';
    return;
  }
  // Прячем формулы от markdown, чтобы он не испортил обратные слэши и подчёркивания.
  const math = [];
  const safe = text
    .replace(MATH_RE, (m) => { math.push(m); return `@@MATH${math.length - 1}@@`; })
    // Строка "**Подпись:** ..." всегда новый абзац, иначе markdown приклеит её к пункту списка выше.
    .replace(/\n(?=[ \t]*\*\*[^\n*]{1,40}\*\*)/g, '\n\n');
  let html = DOMPurify.sanitize(marked.parse(safe, { breaks: true }));
  html = html.replace(/@@MATH(\d+)@@/g, (_, i) => escapeHtml(math[Number(i)]));
  el.innerHTML = html;
  enhanceAnswer(el);
  if (window.renderMathInElement) {
    renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
    });
  }
}

// Оформление ответа по шаблону из api/_prompt.js:
// блок «🧒 Как объяснить ребёнку» -> карточка, строки с 🔒 -> спойлеры.
function enhanceAnswer(root) {
  const headingLevel = (node) => (/^H[1-6]$/.test(node?.tagName) ? Number(node.tagName[1]) : 0);

  for (const h of [...root.querySelectorAll('h2, h3, h4, h5')]) {
    if (!/как объяснить/i.test(h.textContent) || h.closest('.explain')) continue;
    const level = headingLevel(h);
    const card = document.createElement('section');
    card.className = 'explain';
    h.before(card);
    let node = h;
    while (node) {
      const next = node.nextElementSibling;
      card.append(node);
      if (!next || next.tagName === 'HR' || (headingLevel(next) && headingLevel(next) <= level)) break;
      node = next;
    }
    // Заголовок уже есть у задания выше — подпись в карточке делаем единообразной.
    h.className = 'explain-title';
  }

  for (const el of [...root.querySelectorAll('p, li')]) {
    if (!el.textContent.trim().startsWith('🔒') || el.querySelector('p, li')) continue;
    makeSpoiler(el);
  }
}

function makeSpoiler(el) {
  // Делим "🔒 Подсказка 1: текст" на подпись (до первого двоеточия) и скрытый текст.
  let content = null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const i = node.data.indexOf(':');
    if (i < 0) continue;
    const range = document.createRange();
    range.setStart(node, i + 1);
    range.setEnd(el, el.childNodes.length);
    content = range.extractContents();
    break;
  }
  let label;
  if (content) {
    label = el.textContent.replace('🔒', '').replace(/:\s*$/, '').trim() || 'Показать';
  } else {
    // Нет подписи — прячем всю строку под «Показать».
    content = document.createDocumentFragment();
    content.append(...el.childNodes);
    const first = document.createTreeWalker(content, NodeFilter.SHOW_TEXT).nextNode();
    if (first) first.data = first.data.replace('🔒', '').trimStart();
    label = 'Показать';
  }
  const details = document.createElement('details');
  details.className = 'spoiler';
  const summary = document.createElement('summary');
  summary.textContent = label;
  const body = document.createElement('div');
  body.className = 'spoiler-body';
  if (content) body.append(content);
  details.append(summary, body);
  if (el.tagName === 'LI') {
    el.replaceChildren(details);
    el.classList.add('spoiler-item');
  } else {
    el.replaceWith(details);
  }
}

function imageSrc(id) {
  return localImages.get(id) || `/api/images?id=${encodeURIComponent(id)}`;
}

function openLightbox(src) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  const img = document.createElement('img');
  img.src = src;
  box.append(img);
  box.addEventListener('click', () => box.remove());
  document.body.append(box);
}

function messageEl(m, index) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${m.role}`;

  if (m.role === 'user') {
    if (m.images?.length) {
      const imgs = document.createElement('div');
      imgs.className = 'msg-images';
      for (const id of m.images) {
        const img = document.createElement('img');
        img.src = imageSrc(id);
        img.alt = 'Фото задания';
        img.loading = 'lazy';
        img.addEventListener('click', () => openLightbox(img.src));
        imgs.append(img);
      }
      wrap.append(imgs);
    }
    if (m.text) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = m.text;
      wrap.append(bubble);
    }
    if (m.mode === 'brief') {
      const tag = document.createElement('div');
      tag.className = 'msg-mode';
      tag.textContent = '⚡ только ответ';
      wrap.append(tag);
    }
    return wrap;
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble md';
  wrap.append(bubble);
  fillAssistant(wrap, m, index);
  return wrap;
}

function actionsEl() {
  const row = document.createElement('div');
  row.className = 'quick-actions';
  // После сухого ответа предлагаем дописать объяснение, иначе — упростить или подробнее.
  const lastUser = [...current.messages].reverse().find((m) => m.role === 'user');
  const keys = lastUser?.mode === 'brief'
    ? ['explain', 'practice', 'check']
    : ['simpler', 'deeper', 'practice', 'check'];
  for (const key of keys) {
    const a = ACTIONS[key];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = a.label;
    btn.addEventListener('click', () => runAction(key));
    row.append(btn);
  }
  return row;
}

function fillAssistant(wrap, m, index) {
  const bubble = wrap.querySelector('.bubble');
  wrap.querySelector('.msg-tools')?.remove();
  wrap.querySelector('.quick-actions')?.remove();
  const isLast = index === current.messages.length - 1;

  if (m.error) {
    bubble.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'error-box';
    box.textContent = `⚠️ ${m.error}`;
    if (isLast && !busy) {
      const retry = document.createElement('button');
      retry.className = 'btn-ghost';
      retry.type = 'button';
      retry.textContent = '↻ Попробовать снова';
      retry.addEventListener('click', () => {
        current.messages.pop();
        runAssistant(current);
      });
      box.append(document.createElement('br'), retry);
    }
    bubble.append(box);
    return;
  }

  if (!m.text) {
    bubble.innerHTML = '<span class="thinking" aria-label="Думаю"><i></i><i></i><i></i></span>';
    return;
  }

  renderMarkdown(bubble, m.text);

  if (!(busy && isLast)) {
    if (isLast) wrap.append(actionsEl());
    const tools = document.createElement('div');
    tools.className = 'msg-tools';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '📋 Копировать';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(m.text);
        copy.textContent = '✓ Скопировано';
      } catch {
        copy.textContent = 'Не удалось';
      }
      setTimeout(() => { copy.textContent = '📋 Копировать'; }, 1500);
    });
    tools.append(copy);
    wrap.append(tools);
  }
}

function nearBottom() {
  const el = els.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderMessages() {
  els.messages.querySelectorAll('.msg').forEach((n) => n.remove());
  els.empty.hidden = current.messages.length > 0;
  current.messages.forEach((m, i) => els.messages.append(messageEl(m, i)));
  scrollToBottom();
}

function updateLast() {
  const stick = nearBottom();
  const last = els.messages.lastElementChild;
  const msgs = current.messages;
  if (last?.classList.contains('msg') && msgs.length) fillAssistant(last, msgs[msgs.length - 1], msgs.length - 1);
  if (stick) scrollToBottom();
}

let updateTimer = null;
function scheduleUpdate() {
  if (updateTimer) return;
  updateTimer = setTimeout(() => { updateTimer = null; updateLast(); }, 80);
}

function renderHeader() {
  els.chatTitle.textContent = current.title || 'Новый чат';
  els.grade.value = String(current.grade);
  document.title = current.title ? `${current.title} — Помощник с уроками` : 'Помощник с уроками';
}

// ---------- Боковая панель ----------

function dayStart(offsetDays = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return d.getTime();
}

function groupName(ts) {
  if (ts >= dayStart(0)) return 'Сегодня';
  if (ts >= dayStart(1)) return 'Вчера';
  if (ts >= dayStart(7)) return 'Последние 7 дней';
  return 'Ранее';
}

function renderChatList() {
  els.chatList.innerHTML = '';
  if (!chats.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-list-empty';
    empty.textContent = 'Здесь появятся ваши чаты.';
    els.chatList.append(empty);
    return;
  }
  let lastGroup = '';
  for (const chat of chats) {
    const group = groupName(chat.updatedAt);
    if (group !== lastGroup) {
      const h = document.createElement('div');
      h.className = 'chat-group';
      h.textContent = group;
      els.chatList.append(h);
      lastGroup = group;
    }
    const item = document.createElement('div');
    item.className = `chat-item${current?.id === chat.id ? ' active' : ''}`;

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'chat-open';
    open.textContent = chat.title || 'Новый чат';
    open.title = chat.title || '';
    open.addEventListener('click', () => openChat(chat.id));

    const actions = document.createElement('div');
    actions.className = 'chat-actions';
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.textContent = '✎';
    rename.title = 'Переименовать';
    rename.setAttribute('aria-label', 'Переименовать чат');
    rename.addEventListener('click', () => renameChat(chat.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '🗑';
    del.title = 'Удалить';
    del.setAttribute('aria-label', 'Удалить чат');
    del.addEventListener('click', () => removeChat(chat.id));
    actions.append(rename, del);

    item.append(open, actions);
    els.chatList.append(item);
  }
}

function setSidebar(open) {
  els.app.classList.toggle('sidebar-open', open);
}

els.openSidebar.addEventListener('click', () => setSidebar(true));
els.closeSidebar.addEventListener('click', () => setSidebar(false));
els.backdrop.addEventListener('click', () => setSidebar(false));

function touchChatMeta(chat) {
  const photos = chat.messages.reduce((n, m) => n + (m.images?.length || 0), 0);
  const meta = { id: chat.id, title: chat.title, grade: chat.grade, updatedAt: Date.now(), photos };
  chats = [meta, ...chats.filter((c) => c.id !== chat.id)];
  renderChatList();
}

// ---------- Чаты ----------

function setHash(id) {
  const target = id ? `#${id}` : '';
  if (location.hash !== target) history.replaceState(null, '', target || location.pathname);
}

function newChat() {
  if (busy) controller?.abort();
  current = { id: newId(), title: '', grade: store.get('hw_grade', 6), messages: [], saved: false };
  pending = [];
  setHash('');
  renderAttachments();
  renderHeader();
  renderMessages();
  renderChatList();
  updateSendState();
  setSidebar(false);
  if (!matchMedia('(pointer: coarse)').matches) els.input.focus();
}

async function openChat(id) {
  setSidebar(false);
  if (current?.id === id) return;
  if (busy) controller?.abort();
  try {
    const { chat } = await api(`/api/chats?id=${encodeURIComponent(id)}`);
    current = { ...chat, saved: true };
    pending = [];
    setHash(id);
    renderAttachments();
    renderHeader();
    renderMessages();
    renderChatList();
    updateSendState();
  } catch (err) {
    if (err instanceof AuthError) return;
    alert(`Не удалось открыть чат: ${err.message}`);
    chats = chats.filter((c) => c.id !== id);
    renderChatList();
  }
}

async function saveChat(chat) {
  const messages = chat.messages.map((m) => (m.role === 'user'
    ? {
      role: 'user', text: m.text, images: m.images || [],
      ...(m.action ? { action: m.action } : {}), ...(m.mode ? { mode: m.mode } : {}),
    }
    : { role: 'assistant', text: m.text, ...(m.error ? { error: m.error } : {}) }));
  try {
    await api(`/api/chats?id=${encodeURIComponent(chat.id)}`, {
      method: 'PUT',
      body: { title: chat.title, grade: chat.grade, messages },
    });
    chat.saved = true;
  } catch (err) {
    if (!(err instanceof AuthError)) console.warn('Не удалось сохранить чат', err);
  }
}

async function renameChat(id) {
  const meta = chats.find((c) => c.id === id);
  const title = prompt('Название чата:', meta?.title || '');
  if (title === null || !title.trim()) return;
  const clean = title.trim().slice(0, 120);
  if (meta) meta.title = clean;
  if (current?.id === id) {
    current.title = clean;
    renderHeader();
  }
  renderChatList();
  try {
    await api(`/api/chats?id=${encodeURIComponent(id)}`, { method: 'PATCH', body: { title: clean } });
  } catch (err) {
    if (!(err instanceof AuthError)) alert(`Не удалось переименовать: ${err.message}`);
  }
}

async function removeChat(id) {
  const meta = chats.find((c) => c.id === id);
  if (!confirm(`Удалить чат «${meta?.title || 'Новый чат'}»? Его нельзя будет вернуть.`)) return;
  try {
    await api(`/api/chats?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (err) {
    if (!(err instanceof AuthError)) alert(`Не удалось удалить: ${err.message}`);
    return;
  }
  chats = chats.filter((c) => c.id !== id);
  if (current?.id === id) newChat();
  else renderChatList();
}

function makeTitle(text, hasImages) {
  const line = (text || '').split('\n').find((l) => l.trim())?.trim() || '';
  if (line) return line.length > 50 ? `${line.slice(0, 50).trim()}…` : line;
  const date = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  return hasImages ? `📷 Задание по фото, ${date}` : `Чат от ${date}`;
}

// ---------- Фото ----------

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('bad image'));
    img.src = src;
  });
}

// Уменьшаем фото прямо в браузере: быстрее отправка и меньше места в базе.
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function addFiles(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  for (const file of images) {
    if (pending.length >= MAX_ATTACHMENTS) {
      alert(`Можно приложить не больше ${MAX_ATTACHMENTS} фото за раз.`);
      break;
    }
    try {
      pending.push({ url: await compressImage(file) });
    } catch {
      alert('Не удалось открыть это фото. Попробуйте сделать снимок ещё раз или выберите другой файл.');
    }
  }
  renderAttachments();
  updateSendState();
}

function renderAttachments() {
  els.attachments.innerHTML = '';
  els.attachments.hidden = pending.length === 0;
  pending.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'attachment';
    const img = document.createElement('img');
    img.src = p.url;
    img.alt = 'Фото';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Убрать фото');
    remove.addEventListener('click', () => {
      pending.splice(i, 1);
      renderAttachments();
      updateSendState();
    });
    item.append(img, remove);
    els.attachments.append(item);
  });
}

els.attach.addEventListener('click', () => {
  pendingAction = null;
  els.fileInput.click();
});
els.fileInput.addEventListener('change', async () => {
  await addFiles(els.fileInput.files);
  els.fileInput.value = '';
  const action = pendingAction;
  pendingAction = null;
  if (action && pending.length) sendMessage(action);
});

document.addEventListener('paste', (e) => {
  if (els.app.hidden) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

els.app.addEventListener('dragover', (e) => e.preventDefault());
els.app.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

// ---------- Отправка ----------

function toApiMessage(m) {
  if (m.role === 'assistant') return { role: 'assistant', content: m.text };
  let text = ACTIONS[m.action]?.prompt || m.text || 'Реши задание на фото.';
  if (m.mode === 'brief') text += '\n\n[Только ответ]';
  if (!m.images?.length) return { role: 'user', content: text };
  return { role: 'user', content: [{ type: 'text', text }, ...m.images.map((id) => ({ type: 'image_ref', id }))] };
}

async function readStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new Error(chunk.error.message || 'Ошибка модели');
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) onDelta(delta);
    }
  }
}

function setBusy(value) {
  busy = value;
  els.send.hidden = value;
  els.sendBrief.hidden = value;
  els.stop.hidden = !value;
  els.grade.disabled = value;
  updateSendState();
}

function updateSendState() {
  const disabled = busy || (!els.input.value.trim() && pending.length === 0);
  els.send.disabled = disabled;
  els.sendBrief.disabled = disabled;
}

async function runAssistant(chat) {
  const reply = { role: 'assistant', text: '' };
  const history = chat.messages.filter((m) => !m.error && (m.role === 'user' || m.text));
  const payload = { grade: chat.grade, model: store.get('hw_model', ''), messages: history.map(toApiMessage) };
  chat.messages.push(reply);
  setBusy(true);
  if (chat === current) renderMessages();

  const onScreen = () => chat === current;
  controller = new AbortController();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.status === 401) {
      chat.messages.pop();
      setBusy(false);
      showLogin('Нужно войти заново.');
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Ошибка сервера (${res.status})`);
    }
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      const data = await res.json();
      reply.text = data.choices?.[0]?.message?.content || '';
    } else {
      await readStream(res, (delta) => { reply.text += delta; if (onScreen()) scheduleUpdate(); });
    }
    if (!reply.text.trim()) throw new Error('Модель вернула пустой ответ. Попробуйте ещё раз или выберите другую модель в ⚙ Настройках.');
  } catch (err) {
    if (err.name === 'AbortError') {
      if (!reply.text) reply.text = '_Остановлено._';
    } else {
      reply.error = err.message === 'Failed to fetch' ? 'Нет связи с сервером. Проверьте интернет.' : err.message;
    }
  } finally {
    controller = null;
    clearTimeout(updateTimer);
    updateTimer = null;
    setBusy(false);
    if (onScreen()) updateLast();
    touchChatMeta(chat);
    saveChat(chat);
  }
}

async function uploadPending() {
  const ids = [];
  for (const p of pending) {
    const { id } = await api('/api/images', { method: 'POST', body: { dataUrl: p.url } });
    localImages.set(id, p.url);
    ids.push(id);
  }
  return ids;
}

let pendingAction = null; // действие, которое ждёт выбора фото (проверка решения ребёнка)

function runAction(key) {
  if (busy) return;
  if (ACTIONS[key].needsPhoto) {
    pendingAction = key;
    els.fileInput.click();
    return;
  }
  sendMessage(key);
}

// mode: 'full' — с объяснением, 'brief' — только решение и ответ.
async function sendMessage(action = null, mode = 'full') {
  if (busy) return;
  const text = action ? ACTIONS[action].label : els.input.value.trim();
  if (!text && pending.length === 0) return;
  const chat = current;

  let images = [];
  if (pending.length) {
    setBusy(true);
    els.attach.disabled = true;
    try {
      images = await uploadPending();
    } catch (err) {
      if (!(err instanceof AuthError)) alert(`Не удалось загрузить фото: ${err.message}`);
      setBusy(false);
      els.attach.disabled = false;
      return;
    }
    setBusy(false);
    els.attach.disabled = false;
  }

  chat.messages.push({
    role: 'user', text, images,
    ...(action ? { action } : {}), ...(mode === 'brief' && !action ? { mode } : {}),
  });
  if (!chat.title) chat.title = makeTitle(text, images.length > 0);
  if (chat === current) {
    pending = [];
    if (!action) els.input.value = '';
    autoGrow();
    renderAttachments();
    renderHeader();
    setHash(chat.id);
  }
  touchChatMeta(chat);
  saveChat(chat);
  runAssistant(chat);
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage(null, 'full');
});
els.sendBrief.addEventListener('click', () => sendMessage(null, 'brief'));

els.stop.addEventListener('click', () => controller?.abort());

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
}

els.input.addEventListener('input', () => {
  autoGrow();
  updateSendState();
});

els.input.addEventListener('keydown', (e) => {
  // На компьютере Enter отправляет, Shift+Enter — новая строка. На телефоне Enter — новая строка.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault();
    sendMessage();
  }
});

// ---------- Шапка ----------

els.grade.addEventListener('change', () => {
  const grade = Number(els.grade.value);
  store.set('hw_grade', grade);
  current.grade = grade;
  if (current.saved) {
    api(`/api/chats?id=${encodeURIComponent(current.id)}`, { method: 'PATCH', body: { grade } }).catch(() => {});
  }
});

els.newChat.addEventListener('click', newChat);
els.newChatTop.addEventListener('click', newChat);

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && id !== current?.id) openChat(id);
});

// ---------- Настройки ----------

async function loadModels() {
  els.model.innerHTML = '<option value="">Загрузка…</option>';
  els.modelInfo.textContent = '';
  try {
    const res = await fetch('/api/models');
    if (res.status === 401) { showLogin('Нужно войти заново.'); return; }
    const data = await res.json().catch(() => ({}));
    const saved = store.get('hw_model', '');
    const options = [`<option value="">По умолчанию${data.defaultModel ? ` (${escapeHtml(data.defaultModel)})` : ' — не задана'}</option>`];
    const list = data.models || [];
    if (saved && !list.includes(saved)) list.unshift(saved);
    for (const id of list) options.push(`<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`);
    els.model.innerHTML = options.join('');
    els.model.value = saved;
    els.modelInfo.textContent = data.error
      ? data.error
      : 'Для фото нужна модель, которая понимает изображения.';
    modelsLoaded = !data.error;
  } catch {
    els.model.innerHTML = '<option value="">По умолчанию</option>';
    els.modelInfo.textContent = 'Не удалось загрузить список моделей.';
  }
}

els.openSettings.addEventListener('click', () => {
  setSidebar(false);
  els.settings.showModal();
  if (!modelsLoaded) loadModels();
});
els.model.addEventListener('change', () => store.set('hw_model', els.model.value));
els.logout.addEventListener('click', logout);

// ---------- Старт ----------

async function boot() {
  try {
    const data = await api('/api/chats');
    chats = data.chats || [];
  } catch (err) {
    if (err instanceof AuthError) return;
    els.loading.textContent = `Не удалось загрузить историю: ${err.message}`;
    return;
  }
  els.loading.hidden = true;
  els.login.hidden = true;
  els.app.hidden = false;
  const id = location.hash.slice(1);
  current = null;
  if (id && chats.some((c) => c.id === id)) await openChat(id);
  if (!current) newChat();
}

boot();
