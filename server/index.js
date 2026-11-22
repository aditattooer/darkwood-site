// DARK WOOD — сервер оплаты и бот ученика (Yandex Cloud Functions, Node.js 18+)
// Один обработчик, маршрут задаётся параметром ?r=
//   ?r=pay   — сайт создаёт платёж ЮKassa (POST JSON: plan, promo, email, tg, source)
//   ?r=yk    — HTTP-уведомления ЮKassa (payment.succeeded)
//   ?r=tg    — вебхук Telegram-бота
//
// Переменные окружения:
//   YK_SHOP_ID, YK_SECRET           — магазин ЮKassa (секретный ключ вводится только в консоли)
//   RECEIPT                         — "npd" (чеки самозанятого от ЮKassa) или "none"
//   TG_TOKEN                        — токен бота от @BotFather
//   TG_SECRET                       — любая длинная строка, защищает вебхук бота
//   BOT_USERNAME                    — имя бота без @
//   ADMIN_CHAT_ID                   — чат Юли (куда приходят покупки, ДЗ и вопросы)
//   CHANNEL_MAIN                    — id закрытого канала курса (-100...)
//   SHEET_URL, SHEET_KEY            — веб-приложение Google Apps Script и его ключ
//   SITE_URL                        — https://hulijuli.com

const E = process.env;
const SITE = E.SITE_URL || 'https://hulijuli.com';

const PLANS = {
  self:     { name: 'SELF',     price: 2890,  feedback: false },
  feedback: { name: 'FEEDBACK', price: 5990,  feedback: true  },
  mentor:   { name: 'MENTOR',   price: 14900, feedback: true  },
};
const PROMOS = { 'СОСНА': 15, 'БЕРЕЗА': 20, 'ЕЛЬ': 30 };
const HW_LIMIT = 3;
const SUPPORT_DAYS = 30;

const LAT = { A:'А', B:'В', C:'С', E:'Е', H:'Н', K:'К', M:'М', O:'О', P:'Р', T:'Т', X:'Х', Y:'У' };
function normPromo(s) {
  return String(s || '').trim().toUpperCase().replace(/[ABCEHKMOPTXY]/g, c => LAT[c]).replace(/Ё/g, 'Е');
}
const money = v => (Math.round(v * 100) / 100).toFixed(2);

// ---------- HTTP helpers ----------
const CORS = {
  'Access-Control-Allow-Origin': SITE,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const reply = (code, obj, extra = {}) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
  body: JSON.stringify(obj),
});
function parseBody(event) {
  let b = event.body || '';
  if (event.isBase64Encoded) b = Buffer.from(b, 'base64').toString('utf8');
  try { return JSON.parse(b || '{}'); } catch { return {}; }
}

// ---------- ЮKassa ----------
async function yk(path, method = 'GET', body) {
  const auth = Buffer.from(`${E.YK_SHOP_ID}:${E.YK_SECRET}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' };
  if (method === 'POST') headers['Idempotence-Key'] = cryptoId();
  const r = await fetch(`https://api.yookassa.ru/v3${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.description || `YooKassa ${r.status}`), { status: r.status, data: j });
  return j;
}
function cryptoId() { return require('crypto').randomUUID(); }

// ---------- Telegram ----------
async function tg(method, params) {
  const r = await fetch(`https://api.telegram.org/bot${E.TG_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
  });
  return r.json().catch(() => ({}));
}
const send = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ---------- Google Таблица (Apps Script) ----------
async function sheet(action, data = {}) {
  if (!E.SHEET_URL) return {};
  try {
    const r = await fetch(E.SHEET_URL, {
      method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: E.SHEET_KEY, action, ...data }),
    });
    return await r.json();
  } catch (e) { console.log('sheet error', action, e.message); return { error: e.message }; }
}

// ---------- 1. Создание платежа ----------
async function createPayment(event) {
  const b = parseBody(event);
  const plan = PLANS[b.plan];
  const email = String(b.email || '').trim();
  if (!plan) return reply(400, { error: 'Неизвестный тариф' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: 'Укажи корректный email — на него придёт чек' });
  const promoCode = normPromo(b.promo);
  const pct = PROMOS[promoCode] || 0;
  const amount = money(Math.round(plan.price * (1 - pct / 100)));
  const tgUser = String(b.tg || '').trim().replace(/^@/, '').slice(0, 64);
  const source = String(b.source || '').slice(0, 120);

  const payload = {
    amount: { value: amount, currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: `${SITE}/spasibo/` },
    description: `Онлайн-курс DARK WOOD, тариф ${plan.name}`,
    metadata: { plan: b.plan, promo: pct ? promoCode : '', email, tg: tgUser, source },
  };
  if ((E.RECEIPT || 'npd') === 'npd') {
    payload.receipt = {
      customer: { email },
      items: [{ description: `Онлайн-курс DARK WOOD, тариф ${plan.name}`, quantity: 1, amount: { value: amount, currency: 'RUB' }, vat_code: 1 }],
    };
  }
  try {
    let p;
    try { p = await yk('/payments', 'POST', payload); }
    catch (e) {
      if (payload.receipt && e.status === 400) {           // если чеки не включены в ЛК — пробуем без чека
        delete payload.receipt; p = await yk('/payments', 'POST', payload);
        if (E.ADMIN_CHAT_ID) send(E.ADMIN_CHAT_ID, '⚠️ ЮKassa не приняла данные для чека. Проверь, включены ли «Чеки от ЮKassa». Чек по этой оплате пробей в «Мой налог» вручную.');
      } else throw e;
    }
    return reply(200, { id: p.id, url: p.confirmation.confirmation_url, amount });
  } catch (e) {
    console.log('create payment error', e.message, JSON.stringify(e.data || {}));
    return reply(502, { error: 'Не получилось создать платёж. Попробуй ещё раз через минуту.' });
  }
}

// ---------- 2. Уведомление ЮKassa ----------
async function yookassaHook(event) {
  const b = parseBody(event);
  if (b.event !== 'payment.succeeded' || !b.object?.id) return reply(200, { ok: true });
  let p;
  try { p = await yk(`/payments/${encodeURIComponent(b.object.id)}`); } catch { return reply(200, { ok: true }); }
  if (p.status !== 'succeeded') return reply(200, { ok: true });          // проверяем у ЮKassa, а не верим телу запроса
  const m = p.metadata || {};
  const plan = PLANS[m.plan] || { name: m.plan || '?', feedback: false };
  const row = {
    id: p.id, date: p.captured_at || p.created_at, plan: plan.name, feedback: plan.feedback ? 'да' : 'нет',
    amount: p.amount.value, promo: m.promo || '', source: m.source || '', email: m.email || '', tg: m.tg || '',
  };
  const res = await sheet('add', row);
  if (res.duplicate) return reply(200, { ok: true });                     // повторное уведомление
  if (E.ADMIN_CHAT_ID) {
    await send(E.ADMIN_CHAT_ID,
      `🖤 <b>Новая покупка DARK WOOD</b>\n\n` +
      `Тариф: <b>${esc(plan.name)}</b>${plan.feedback ? ' (с обратной связью)' : ''}\n` +
      `Сумма: ${esc(p.amount.value)} ₽${m.promo ? ` · промокод ${esc(m.promo)}` : ''}\n` +
      `Откуда: ${esc(m.source || 'не определено')}\n` +
      `Email: ${esc(m.email)}${m.tg ? `\nTelegram: @${esc(m.tg)}` : ''}`);
  }
  return reply(200, { ok: true });
}

// ---------- 3. Бот ученика ----------
const MENU = { keyboard: [[{ text: '🔑 Доступ к курсу' }], [{ text: '📝 Сдать домашнее задание' }, { text: '❓ Вопрос по обучению' }], [{ text: '📖 Как устроено обучение' }]], resize_keyboard: true };
const ASK_HW = 'Отправь домашнее задание ответом на это сообщение — видео, фото или текст 🤍';
const ASK_Q = 'Напиши свой вопрос ответом на это сообщение 🤍';
const ASK_EMAIL = 'Напиши email, который указывал(а) при оплате, — я найду покупку.';

async function issueAccess(chatId, from, pid) {
  let p;
  try { p = await yk(`/payments/${encodeURIComponent(pid)}`); } catch { return send(chatId, 'Не нашла такую оплату. Проверь ссылку или напиши email, который указывал(а) при оплате.', { reply_markup: MENU }); }
  if (p.status !== 'succeeded') return send(chatId, 'Оплата ещё не подтверждена. Если ты только что оплатил(а), подожди минуту и нажми «🔑 Доступ к курсу» ещё раз.', { reply_markup: MENU });
  const claim = await sheet('claim', { id: p.id, tg_id: String(from.id), tg_username: from.username || '' });
  if (claim.taken) return send(chatId, 'Доступ по этой оплате уже выдан другому аккаунту Telegram. Если это ошибка — нажми «❓ Вопрос по обучению».', { reply_markup: MENU });
  const plan = PLANS[p.metadata?.plan] || PLANS.self;
  const expire = Math.floor(Date.now() / 1000) + 24 * 3600;
  const links = [];
  for (const [ch, title] of [[E.CHANNEL_MAIN, 'Закрытый канал DARK WOOD']]) {
    if (!ch) continue;
    const r = await tg('createChatInviteLink', { chat_id: ch, member_limit: 1, expire_date: expire, name: `${plan.name} ${from.id}`.slice(0, 32) });
    if (r.ok) links.push(`<a href="${r.result.invite_link}">${title}</a>`);
  }
  let text = `Добро пожаловать в DARK WOOD 🖤\nТвой тариф: <b>${plan.name}</b>\n\n`;
  text += links.length ? `Твоя личная ссылка (действует 24 часа, только для тебя):\n${links.join('\n')}` : 'Ссылка на канал сейчас недоступна — Юля пришлёт её вручную.';
  if (plan.feedback) text += `\n\nВ твоём тарифе есть ${HW_LIMIT} проверки домашних заданий и ${SUPPORT_DAYS} дней обратной связи. Задание сдаётся кнопкой «📝 Сдать домашнее задание».`;
  if (p.metadata?.plan === 'mentor') text += '\n\nДва созвона в Zoom Юля согласует с тобой отдельно.';
  await send(chatId, text, { reply_markup: MENU });
  if (E.ADMIN_CHAT_ID && !claim.already) send(E.ADMIN_CHAT_ID, `🔑 Доступ выдан: ${plan.name} · ${esc(from.first_name || '')} ${from.username ? '@' + esc(from.username) : ''} [id:${from.id}]`);
}

async function telegramHook(event) {
  if (E.TG_SECRET && (event.headers?.['X-Telegram-Bot-Api-Secret-Token'] || event.headers?.['x-telegram-bot-api-secret-token']) !== E.TG_SECRET) return reply(403, {});
  const u = parseBody(event);
  const msg = u.message;
  if (!msg) return reply(200, {});
  const chatId = msg.chat.id, from = msg.from || {}, text = (msg.text || '').trim();
  const isAdmin = String(chatId) === String(E.ADMIN_CHAT_ID);

  // служебное: id чата и id канала из пересланного поста
  if (text === '/id') { await send(chatId, `chat id: <code>${chatId}</code>`); return reply(200, {}); }
  if (msg.forward_from_chat && (isAdmin || !E.ADMIN_CHAT_ID)) { await send(chatId, `id канала «${esc(msg.forward_from_chat.title)}»: <code>${msg.forward_from_chat.id}</code>`); return reply(200, {}); }

  // Юля отвечает ученику: reply на сообщение бота с [id:123]
  if (isAdmin && msg.reply_to_message) {
    const src = (msg.reply_to_message.text || msg.reply_to_message.caption || '');
    const m = src.match(/\[id:(\d+)\]/);
    const target = m ? m[1] : msg.reply_to_message.forward_from?.id;
    if (target) {
      await tg('sendMessage', { chat_id: target, text: '🖤 Ответ от Юли:' });
      await tg('copyMessage', { chat_id: target, from_chat_id: chatId, message_id: msg.message_id });
      await send(chatId, '✓ Отправлено ученику');
      return reply(200, {});
    }
  }

  if (text.startsWith('/start')) {
    const pid = text.split(/\s+/)[1];
    if (pid) await issueAccess(chatId, from, pid);
    else await send(chatId, 'Привет, это бот курса DARK WOOD 🖤\n\nЗдесь можно получить доступ к курсу после оплаты, сдать домашнее задание и задать вопрос по обучению.', { reply_markup: MENU });
    return reply(200, {});
  }
  if (text === '🔑 Доступ к курсу') { await send(chatId, ASK_EMAIL, { reply_markup: { force_reply: true } }); return reply(200, {}); }
  if (text === '📝 Сдать домашнее задание') {
    const st = await sheet('student', { tg_id: String(from.id) });
    if (!st.found) { await send(chatId, 'Не нашла твою покупку. Сначала получи доступ кнопкой «🔑 Доступ к курсу».', { reply_markup: MENU }); return reply(200, {}); }
    if (st.feedback !== 'да') { await send(chatId, 'В тарифе SELF нет проверок домашних заданий. Проверки есть в тарифах FEEDBACK и MENTOR.', { reply_markup: MENU }); return reply(200, {}); }
    if (st.days > SUPPORT_DAYS) { await send(chatId, `${SUPPORT_DAYS} дней обратной связи уже закончились.`, { reply_markup: MENU }); return reply(200, {}); }
    if (st.hw >= HW_LIMIT) { await send(chatId, `Ты уже сдал(а) все ${HW_LIMIT} задания на проверку 🤍`, { reply_markup: MENU }); return reply(200, {}); }
    await send(chatId, `${ASK_HW}\nОсталось проверок: ${HW_LIMIT - st.hw}`, { reply_markup: { force_reply: true } });
    return reply(200, {});
  }
  if (text === '❓ Вопрос по обучению') { await send(chatId, ASK_Q, { reply_markup: { force_reply: true } }); return reply(200, {}); }
  if (text === '📖 Как устроено обучение') {
    await send(chatId, 'Как всё устроено 🖤\n\n1. Все 22 темы — в закрытом канале курса, учишься в своём ритме.\n2. Канал пополняется новыми материалами каждый месяц.\n3. Доступ бессрочный.\n4. В FEEDBACK и MENTOR — 3 проверки ДЗ и 30 дней обратной связи. ДЗ сдаётся здесь, кнопкой «📝 Сдать домашнее задание».\n5. В MENTOR — 2 созвона в Zoom по 45 минут.', { reply_markup: MENU });
    return reply(200, {});
  }

  // ответы на наши «force_reply»-вопросы
  const asked = msg.reply_to_message?.from?.is_bot ? (msg.reply_to_message.text || '') : '';
  const who = `${esc(from.first_name || '')} ${from.username ? '@' + esc(from.username) : ''} [id:${from.id}]`;
  if (asked.startsWith(ASK_EMAIL.slice(0, 20)) && text) {
    const r = await sheet('find_email', { email: text.toLowerCase() });
    if (r.id) await issueAccess(chatId, from, r.id);
    else await send(chatId, 'Не нашла оплату с таким email. Проверь написание или нажми «❓ Вопрос по обучению» — Юля поможет.', { reply_markup: MENU });
    return reply(200, {});
  }
  if (asked.startsWith(ASK_HW.slice(0, 20))) {
    const st = await sheet('hw_inc', { tg_id: String(from.id) });
    await send(E.ADMIN_CHAT_ID, `📝 <b>Домашнее задание №${st.hw || '?'}</b> · ${esc(st.plan || '')}\n${who}\n\nОтветь на это сообщение — ответ уйдёт ученику.`);
    await tg('forwardMessage', { chat_id: E.ADMIN_CHAT_ID, from_chat_id: chatId, message_id: msg.message_id });
    await send(chatId, 'Задание у Юли 🤍 Ответ придёт сюда, в этот чат.', { reply_markup: MENU });
    return reply(200, {});
  }
  if (asked.startsWith(ASK_Q.slice(0, 20)) || (!isAdmin && (text || msg.photo || msg.video || msg.document))) {
    await send(E.ADMIN_CHAT_ID, `❓ <b>Вопрос от ученика</b>\n${who}\n\nОтветь на это сообщение — ответ уйдёт ученику.`);
    await tg('forwardMessage', { chat_id: E.ADMIN_CHAT_ID, from_chat_id: chatId, message_id: msg.message_id });
    await send(chatId, 'Передала Юле 🤍 Ответ придёт сюда.', { reply_markup: MENU });
    return reply(200, {});
  }
  return reply(200, {});
}

// ---------- роутер ----------
module.exports.handler = async function (event) {
  const r = event.queryStringParameters?.r;
  if (event.httpMethod === 'OPTIONS') return reply(204, {});
  try {
    if (r === 'pay' && event.httpMethod === 'POST') return await createPayment(event);
    if (r === 'yk') return await yookassaHook(event);
    if (r === 'tg') return await telegramHook(event);
    return reply(200, { ok: true, service: 'darkwood' });
  } catch (e) {
    console.log('fatal', e.stack || e.message);
    return reply(r === 'pay' ? 500 : 200, { error: 'server error' });
  }
};

// для локальных тестов
module.exports._t = { normPromo, PLANS, PROMOS };
