// DARK WOOD — приёмник для Google Таблицы «DARK WOOD — покупки» (Apps Script)
// Адрес веб-приложения знает только сервер (переменная SHEET_URL).
// Лист «Покупки» создаётся автоматически.

const HEAD = ['Дата', 'ID платежа', 'Тариф', 'Обратная связь', 'Сумма, ₽', 'Промокод', 'Откуда пришёл', 'Email', 'Telegram (указал)', 'TG ID', 'TG username', 'Доступ выдан', 'ДЗ сдано'];
const C = { date: 1, id: 2, plan: 3, feedback: 4, amount: 5, promo: 6, source: 7, email: 8, tg: 9, tg_id: 10, tg_user: 11, issued: 12, hw: 13 };

function setup() { sh_(); UrlFetchApp.fetch('https://api.telegram.org/'); MailApp.getRemainingDailyQuota(); }

function sh_() {
  const ss = SpreadsheetApp.openById('1HPk88z-x5Eisy0UqSvA77s1b7MeI3-YmMn-cBUMuUZg');
  let s = ss.getSheetByName('Покупки');
  if (!s) {
    s = ss.insertSheet('Покупки');
    s.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  return s;
}
function rows_() {
  const s = sh_();
  const n = s.getLastRow();
  return n < 2 ? [] : s.getRange(2, 1, n - 1, HEAD.length).getValues();
}
function find_(col, value) {
  const r = rows_();
  for (let i = r.length - 1; i >= 0; i--) if (String(r[i][col - 1]).toLowerCase() === String(value).toLowerCase()) return { row: i + 2, v: r[i] };
  return null;
}
const out_ = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);

function doPost(e) {
  const d = JSON.parse(e.postData.contents || '{}');
  if (d.action === 'tg') {                 // ретранслятор запросов к Telegram (из Yandex Cloud Telegram недоступен)
    if (!/^\d+:[\w-]+$/.test(d.token || '') || !/^\w+$/.test(d.method || '')) return out_({ ok: false, description: 'bad request' });
    const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + d.token + '/' + d.method, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(d.params || {}), muteHttpExceptions: true,
    });
    return ContentService.createTextOutput(r.getContentText()).setMimeType(ContentService.MimeType.JSON);
  }
  if (d.action === 'mail') {               // письмо покупателю со ссылкой на бота
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email || '') || !/^https:\/\/t\.me\//.test(d.link || '')) return out_({ ok: false });
    const plan = String(d.plan || '').replace(/[<>&]/g, '');
    const html =
      '<div style="background:#161a18;padding:36px 20px;font-family:Arial,Helvetica,sans-serif;color:#f0ede6">' +
      '<div style="max-width:520px;margin:0 auto">' +
      '<div style="letter-spacing:.28em;font-size:12px;color:#9a9f97">DARK WOOD ✦</div>' +
      '<h1 style="font-family:Georgia,serif;font-weight:normal;font-size:34px;line-height:1.1;margin:18px 0 18px">Добро пожаловать в лес 🖤</h1>' +
      '<p style="font-size:15px;line-height:1.6;color:#d9d5cc">Оплата прошла. Твой тариф: <b>' + plan + '</b>.</p>' +
      '<p style="font-size:15px;line-height:1.6;color:#d9d5cc">Последний шаг — открой бота курса. Он выдаст личную ссылку в закрытый канал.</p>' +
      '<p style="margin:26px 0"><a href="' + d.link + '" style="display:inline-block;background:#f0ede6;color:#161a18;text-decoration:none;padding:14px 26px;font-size:14px;letter-spacing:.08em">ПОЛУЧИТЬ ДОСТУП В TELEGRAM →</a></p>' +
      '<p style="font-size:13px;line-height:1.6;color:#9a9f97">Если кнопка не открывается: найди в Telegram бота @' + String(d.bot || '').replace(/[^\w]/g, '') + ', нажми «🔑 Доступ к курсу» и напиши этот email.</p>' +
      '<p style="font-size:13px;line-height:1.6;color:#9a9f97">Вопросы — прямо в боте или в Telegram @huli_juli.<br>Юля 🤍</p>' +
      '</div></div>';
    MailApp.sendEmail({ to: d.email, subject: 'DARK WOOD — твой доступ к курсу 🖤', name: 'DARK WOOD',
      htmlBody: html, body: 'Оплата прошла. Открой бота курса, чтобы получить доступ: ' + d.link });
    return out_({ ok: true });
  }
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const s = sh_();
    if (d.action === 'add') {
      if (find_(C.id, d.id)) return out_({ duplicate: true });
      s.appendRow([new Date(d.date || Date.now()), d.id, d.plan, d.feedback, Number(d.amount), d.promo, d.source, d.email, d.tg ? '@' + d.tg : '', '', '', '', 0]);
      return out_({ ok: true });
    }
    if (d.action === 'claim') {
      const f = find_(C.id, d.id); if (!f) return out_({ ok: true, unknown: true });
      const owner = String(f.v[C.tg_id - 1] || '');
      if (owner && owner !== String(d.tg_id)) return out_({ taken: true });
      if (owner) return out_({ ok: true, already: true });
      s.getRange(f.row, C.tg_id, 1, 3).setValues([[String(d.tg_id), d.tg_username ? '@' + d.tg_username : '', new Date()]]);
      return out_({ ok: true });
    }
    if (d.action === 'find_email') {
      const f = find_(C.email, d.email);
      return out_(f ? { id: f.v[C.id - 1] } : {});
    }
    if (d.action === 'student' || d.action === 'hw_inc') {
      const f = find_(C.tg_id, d.tg_id); if (!f) return out_({ found: false });
      const issued = f.v[C.issued - 1] ? new Date(f.v[C.issued - 1]) : new Date(f.v[C.date - 1]);
      let hw = Number(f.v[C.hw - 1] || 0);
      if (d.action === 'hw_inc') { hw += 1; s.getRange(f.row, C.hw).setValue(hw); }
      return out_({ found: true, plan: f.v[C.plan - 1], feedback: f.v[C.feedback - 1], hw, days: Math.floor((Date.now() - issued.getTime()) / 86400000) });
    }
    return out_({ error: 'unknown action' });
  } finally { lock.releaseLock(); }
}
