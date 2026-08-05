// Telegram-уведомления. Повод ровно один: В РАБОЧЕМ НАБОРЕ ОТКРЫЛАСЬ НОВАЯ ПОЗИЦИЯ.
// Всё прежнее (кластеры, крупные покупки, зоны агрегатного индикатора) убрано вместе с
// самими сущностями — ни одна из них не пережила проверку на истории, а письма по ним
// были чистым шумом.
//
// Ключевое отличие от прошлой версии: единица уведомления — ПОЗИЦИЯ, а не форма.
// Повторная покупка в бумаге, по которой позиция уже открыта (другой инсайдер или тот же
// через неделю), второго письма не порождает: покупать второй раз не нужно, а срок выхода
// считается от первой покупки. Правило группировки повторяет скринер (web/app.js,
// groupPositions) — чтобы письмо не могло разойтись с дашбордом.
//
// Без секретов (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) скрипт тихо выходит — прод не блокирует.
// Состояние «что уже отправлено» — data/state/notify.json (живёт на ветке data).
import { readJson, writeJson, isoToday, addDaysIso } from './lib/util.mjs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const DATA = argVal('--data', 'data');
const SITE = argVal('--site', 'site');
const DRY = args.includes('--dry-run');
const PREVIEW = args.includes('--preview');   // показать последнюю позицию, не трогая состояние

const SITE_URL = 'https://ml371kl.github.io/temp-zero-inode-840/';
const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;

// ---------- отправка ----------
const plain = s => String(s).replace(/<[^>]+>/g, '');

async function tg(payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, parse_mode: 'HTML', disable_web_page_preview: true, ...payload }),
  });
  if (!res.ok) console.error(`[notify] Telegram HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.ok;
}

// Копия каждого сообщения уходит в приватную ленту NEXUS. Канал best-effort: его отказ
// никогда не блокирует Telegram и ежедневную публикацию радара. Молчать при этом нельзя —
// раньше ненастроенное зеркало не оставляло в логе ни строчки, и «почему на хабе пусто»
// было нечем ответить.
async function sendNexusEvent(text) {
  const url = process.env.NEXUS_EVENTS_URL;
  const nexusToken = process.env.NEXUS_INGEST_TOKEN;
  if (!url || !nexusToken) {
    console.log('[notify] NEXUS не настроен (нет NEXUS_EVENTS_URL или NEXUS_INGEST_TOKEN) — зеркало пропущено');
    return false;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${nexusToken}` },
      body: JSON.stringify({ source: '840', text: plain(text), occurredAt: new Date().toISOString() }),
    });
    if (!res.ok) { console.error('[notify] NEXUS HTTP', res.status, (await res.text()).slice(0, 200)); return false; }
    console.log('[notify] NEXUS: событие принято');
    return true;
  } catch (error) {
    console.error('[notify] NEXUS недоступен:', error?.message || error);
    return false;
  }
}

// Единственная дверь наружу. Всё, что бот показывает в Telegram, обязано попасть и в ленту
// NEXUS — иначе очередной путь (тест, предпросмотр, боевая рассылка) молча обойдёт зеркало.
// Ровно это и случилось: предпросмотр слал только в чат, и на хабе сообщения не было.
// Отсутствие секретов Telegram больше не отменяет зеркало: это два независимых канала.
async function send(text, markup) {
  let ok = false;
  if (token && chat) ok = await tg({ text, reply_markup: markup });
  else console.log('[notify] секреты Telegram не заданы — отправка в чат пропущена');
  await sendNexusEvent(text);
  return ok;
}

// ---------- форматирование ----------
const today = isoToday();
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function fmtDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso ?? '')) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}` + (String(y) === today.slice(0, 4) ? '' : ` ${y}`);
}
const money = v => v >= 1e6 ? '$' + (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + ' млн' : '$' + Math.round(v / 1e3) + ' тыс.';
const price = p => p == null ? '—' : '$' + (p >= 10 ? p.toFixed(2) : p.toFixed(3));
const signed = x => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1) + '%';
const ROLE = { F: 'CFO', C: 'CEO', O: 'топ-менеджер', D: 'директор', T: 'владелец 10%+', X: 'инсайдер' };
const ROMAN = /^(?:I{1,3}|IV|VI{0,3}|IX|X)$/;
const FORCE = { LTD: 'Ltd', LTDA: 'Ltda' };   // юрформы без гласных, которые всё же не аббревиатуры
// «EQUITY BANCSHARES INC» -> «Equity Bancshares Inc», но «CVB» и «LLC» остаются заглавными:
// сплошной капс в письме читается как крик, а обычный Title Case ломает аббревиатуры.
function nameCase(s) {
  return String(s ?? '').replace(/[A-Za-z][A-Za-z']*/g, w => {
    const u = w.toUpperCase();
    if (FORCE[u]) return FORCE[u];
    if (u.length <= 2 || ROMAN.test(u) || !/[AEIOUY]/.test(u)) return u;
    return u[0] + u.slice(1).toLowerCase();
  });
}
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return n + ' ' + (a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many);
};

// ---------- режим проверки связки ----------
if (args.includes('--test')) {
  if (!token || !chat) {
    console.error('[notify] ОШИБКА: не заданы TELEGRAM_BOT_TOKEN и/или TELEGRAM_CHAT_ID');
    console.error(`  токен: ${token ? 'задан (' + token.slice(0, 8) + '…)' : 'ОТСУТСТВУЕТ'}`);
    console.error(`  чат:   ${chat ? chat : 'ОТСУТСТВУЕТ'}`);
    process.exit(1);
  }
  const ok = await send(
    '✅ <b>Инсайдерский радар</b> — связка работает.\n\n'
    + 'Сюда приходит ровно одно событие: <b>в рабочем наборе открылась новая позиция</b> — '
    + 'инсайдер купил на существенную сумму у 52-недельного максимума в ликвидной бумаге.\n\n'
    + 'Повторные покупки в уже открытой позиции не присылаются: входить второй раз не нужно. '
    + 'В тихие недели писем не будет вовсе — набор даёт около восьми сигналов в месяц, '
    + 'а в отдельные месяцы не даёт ни одного.',
    { inline_keyboard: [[{ text: 'Открыть радар', url: SITE_URL }]] });
  if (ok) console.log('[notify] тестовое сообщение отправлено');
  process.exit(ok ? 0 : 1);
}

// ---------- данные ----------
const feed = readJson(join(SITE, 'data', 'feed.json'), []);
const stats = readJson(join(SITE, 'data', 'stats.json'), null);
const statePath = join(DATA, 'state', 'notify.json');
const state = readJson(statePath, {});

const HOLD = stats?.setDef?.hold ?? 3;             // месяцев удержания
const FRESH = stats?.setDef?.freshDays ?? 45;      // сколько дней после подачи вход ещё уместен

// Смотрим только свежие подачи: дашборд обновляется ежедневно, и всё, что старше недели,
// либо уже отправлялось, либо пропущено из-за простоя — заваливать историей смысла нет.
// --fresh-days N расширяет окно (после долгого простоя), --dry-run печатает вместо отправки.
const FRESH_DAYS = Number(argVal('--fresh-days', '7'));
const freshCut = addDaysIso(today, -FRESH_DAYS);

// Одна позиция = один вход. Новая позиция по бумаге начинается только тогда, когда прежняя
// уже закрыта к моменту сигнала. Ровно так же считают скринер и бэктест.
function groupPositions(rows, holdMonths) {
  const byTicker = new Map();
  for (const r of rows) {
    const a = byTicker.get(r.t) ?? [];
    a.push(r); byTicker.set(r.t, a);
  }
  const out = [];
  for (const [t, list] of byTicker) {
    list.sort((a, b) => a.fdate < b.fdate ? -1 : a.fdate > b.fdate ? 1 : 0);
    let pos = null;
    for (const r of list) {
      const closed = pos && (Date.parse(r.fdate) - Date.parse(pos.first)) / 864e5 > holdMonths * 30.5;
      if (!pos || closed) { pos = { t, name: r.name, first: r.fdate, exit: r.exit, rows: [] }; out.push(pos); }
      pos.rows.push(r);
    }
  }
  for (const p of out) {
    p.val = p.rows.reduce((a, b) => a + (b.val ?? 0), 0);
    p.sh = p.rows.reduce((a, b) => a + (b.sh ?? 0), 0);
    p.px = p.sh > 0 ? p.val / p.sh : p.rows[0].px;
    // Опорная строка — ПЕРВАЯ покупка позиции: от неё считаются и срок выхода, и изменение
    // цены «с подачи». Скринер берёт ту же строку, поэтому письмо и таблица не разойдутся.
    p.lead = p.rows[0];
    p.who = [...new Set(p.rows.map(r => r.who))];
    p.deadline = addDaysIso(p.first, FRESH);
  }
  return out.sort((a, b) => a.first < b.first ? 1 : a.first > b.first ? -1 : b.val - a.val);
}

// Группируем по ВСЕМУ набору, а не по свежему окну: иначе докупка в давно открытой позиции
// выглядела бы как первая покупка и порождала бы ложное письмо.
const allPositions = groupPositions(feed.filter(r => r.set === 1), HOLD);
const positions = allPositions.filter(p => p.first >= freshCut);

// ---------- карточка позиции ----------
// Устройство письма: первая строка самодостаточна (в пуше видно только её — тикер и повод),
// дальше по одному факту на строку в порядке убывания важности, в конце — что делать и когда.
// Постоянных пояснений про стратегию в письме нет: они не меняются от письма к письму и
// быстро превращаются в шум, их место — на дашборде.
function card(p) {
  const r = p.lead;
  const many = p.who.length > 1;
  const dd = Math.abs((r.dd ?? 0) * 100);
  const lines = [
    `📈 <b>${esc(p.t)}</b> — новая позиция`,
    `<i>${esc(nameCase(p.name))}</i>`,
    '',
    `${many ? 'Покупатели' : 'Покупатель'}: ${esc(nameCase(p.who[0] ?? '—'))}`
      + ` (${ROLE[r.role] ?? esc(r.role)})` + (many ? ` и ещё ${p.who.length - 1}` : ''),
    `Куплено на ${money(p.val)} по ${p.rows.length > 1 ? '~' : ''}${price(p.px)}`,
    `${dd < 0.5 ? 'Прямо на 52-недельном максимуме' : `На ${dd.toFixed(1)}% ниже 52-недельного максимума`}`
      + `, оборот ${money(r.dv ?? 0)} в день`,
  ];
  // «+0.0% с подачи» на свежем сигнале — шум: показываем изменение только когда оно есть
  if (r.cur) {
    lines.push(`Сейчас ${price(r.cur)}`
      + (r.chg != null && Math.abs(r.chg) >= 0.005 ? ` (${signed(r.chg)} с подачи)` : ''));
  }
  lines.push('');
  lines.push(`🗓 Подача ${fmtDate(p.first)} · вход до ${fmtDate(p.deadline)} · выход ${fmtDate(p.exit)}`);
  return lines.join('\n');
}

// Когда позиций много (после простоя или редкого «залпа»), пять карточек подряд — уже не
// сигнал, а лента. Тогда шлём одну сводку строками.
function digest(list) {
  const head = `📈 <b>Рабочий набор: ${plural(list.length, 'новая позиция', 'новые позиции', 'новых позиций')}</b>`;
  const rows = list.map(p => {
    const dd = Math.abs((p.lead.dd ?? 0) * 100);
    return `<b>${esc(p.t)}</b> · ${money(p.val)} · ${dd < 0.5 ? 'у максимума' : `−${dd.toFixed(1)}% от максимума`}`
      + ` · вход до ${fmtDate(p.deadline)}`;
  });
  return [head, '', ...rows, '', 'Держать три месяца от подачи, доли равные.'].join('\n');
}

const kb = p => ({
  inline_keyboard: [[
    { text: `Карточка ${p.t}`, url: `${SITE_URL}#ticker/${encodeURIComponent(p.t)}` },
    { text: 'Все позиции', url: SITE_URL },
  ]],
});

// ---------- предпросмотр формата: последняя позиция, состояние не трогаем ----------
if (PREVIEW) {
  if (!allPositions.length) { console.log('[notify] позиций в наборе нет'); process.exit(0); }
  const p = allPositions[0];
  // Оговорка обязательна в обоих каналах: карточка предпросмотра неотличима от боевой,
  // и без пометки она читается на хабе как новый сигнал.
  const text = card(p) + '\n\n<i>Это образец формата, а не новый сигнал.</i>';
  if (DRY) { console.log('\n' + plain(text)); process.exit(0); }
  const ok = await send(text, kb(p));
  console.log(ok ? '[notify] предпросмотр отправлен' : '[notify] предпросмотр в чат НЕ отправлен');
  process.exit(0);
}

// ---------- что уже отправляли ----------
// Ключ — позиция (бумага + дата её первой покупки), а не форма. Версия нужна, чтобы смена
// правила ключа не отправила разом всю неделю: первый прогон новой версии молча пересевает
// состояние.
const NOTIFY_VERSION = 3;
const seeding = !state.sentPositions || state.version !== NOTIFY_VERSION;
const sent = new Set(state.version === NOTIFY_VERSION ? (state.sentPositions ?? []) : []);
state.version = NOTIFY_VERSION;

const fresh = [];
for (const p of positions) {
  const id = `${p.t}|${p.first}`;
  if (sent.has(id)) continue;
  sent.add(id);
  fresh.push(p);
}
state.sentPositions = [...sent].slice(-2000);
delete state.sentTrades;      // ключи прежней схемы («набор|тикер|дата») больше не читаются
writeJson(statePath, state, true);

if (seeding) {
  console.log(`[notify] первый прогон схемы v${NOTIFY_VERSION}: состояние пересеяно (${sent.size} позиций), письма не шлём`);
  process.exit(0);
}
if (!fresh.length) { console.log('[notify] новых позиций нет'); process.exit(0); }
console.log(`[notify] новых позиций: ${fresh.length}`);

// ---------- отправка ----------
const MAX_CARDS = 4;
const messages = fresh.length > MAX_CARDS
  ? [{ text: digest(fresh), markup: { inline_keyboard: [[{ text: 'Открыть скринер', url: SITE_URL }]] } }]
  : fresh.map(p => ({ text: card(p), markup: kb(p) }));

if (DRY) {
  for (const m of messages) console.log('\n' + '─'.repeat(46) + '\n' + plain(m.text));
  process.exit(0);
}

let okCount = 0;
for (const [k, m] of messages.entries()) {
  // Telegram душит бота примерно на одном сообщении в секунду на чат; карточек бывает до
  // четырёх подряд, поэтому между ними пауза — иначе часть вернётся с 429.
  if (k) await new Promise(r => setTimeout(r, 1200));
  if (await send(m.text, m.markup)) okCount++;
}
console.log('[notify] отправлено в Telegram:', okCount, 'из', messages.length);
