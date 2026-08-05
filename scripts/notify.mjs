// Telegram-уведомления. Присылаются ТОЛЬКО три вещи, каждая из которых прошла проверку
// рабочего набора (docs/ЧТО-РАБОТАЕТ.md):
//   1. новая сделка из набора «Сила после отчёта»;
//   2. новая сделка из набора «Кластер + докупка» со скором ≥55;
//   3. переход агрегатного индикатора в зону «вспышка» (≥3σ).
// Всё остальное (обычные кластеры, крупные покупки, зона 2–3σ) сознательно не шлётся:
// на данных эти события от базы не отличаются и создавали бы шум.
//
// Без секретов (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) скрипт тихо выходит — прод не блокирует.
// Состояние «что уже отправлено» — data/state/notify.json (живёт на ветке data).
import { readJson, writeJson, isoToday, addDaysIso } from './lib/util.mjs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const DATA = argVal('--data', 'data');
const SITE = argVal('--site', 'site');

const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;

// Копия каждого сигнала уходит в приватную ленту NEXUS. Канал best-effort:
// его отказ никогда не блокирует Telegram и ежедневную публикацию радара.
async function sendNexusEvent(text) {
  const url = process.env.NEXUS_EVENTS_URL;
  const nexusToken = process.env.NEXUS_INGEST_TOKEN;
  if (!url || !nexusToken) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${nexusToken}`,
      },
      body: JSON.stringify({ source: '840', text, occurredAt: new Date().toISOString() }),
    });
    if (!res.ok) console.error('[notify] NEXUS HTTP', res.status, (await res.text()).slice(0, 200));
  } catch (error) {
    console.error('[notify] NEXUS недоступен:', error?.message || error);
  }
}

// Режим проверки настройки: одно тестовое сообщение и выход.
if (args.includes('--test')) {
  if (!token || !chat) {
    console.error('[notify] ОШИБКА: не заданы TELEGRAM_BOT_TOKEN и/или TELEGRAM_CHAT_ID');
    console.error(`  токен: ${token ? 'задан (' + token.slice(0, 8) + '…)' : 'ОТСУТСТВУЕТ'}`);
    console.error(`  чат:   ${chat ? chat : 'ОТСУТСТВУЕТ'}`);
    process.exit(1);
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chat, parse_mode: 'HTML',
      text: '✅ <b>Инсайдерский радар</b>: связка с Telegram работает.\n\n' +
        'Сюда будут приходить сделки, попавшие в рабочий набор: покупка инсайдера ' +
        'у 52-недельного максимума на существенную сумму в торгуемой бумаге.',
    }),
  });
  const body = await res.text();
  if (res.ok) console.log('[notify] тестовое сообщение отправлено');
  else console.error(`[notify] ОШИБКА Telegram HTTP ${res.status}: ${body}`);
  process.exit(res.ok ? 0 : 1);
}

const feed = readJson(join(SITE, 'data', 'feed.json'), []);
const stats = readJson(join(SITE, 'data', 'stats.json'), null);
const statePath = join(DATA, 'state', 'notify.json');
const state = readJson(statePath, {});

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = v => v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + ' млн' : '$' + Math.round(v / 1e3) + ' тыс.';
const ROLE = { F: 'CFO', C: 'CEO', O: 'офицер', D: 'директор', T: '10%-владелец', X: 'инсайдер' };
const events = [];
const today = isoToday();

// Смотрим только свежие подачи: дашборд обновляется ежедневно, и всё, что старше недели,
// либо уже отправлялось, либо пропущено из-за простоя — заваливать историей смысла нет.
// --fresh-days N расширяет окно (после долгого простоя), --dry-run печатает вместо отправки.
const FRESH_DAYS = Number(argVal('--fresh-days', '7'));
const DRY = args.includes('--dry-run');
const freshCut = addDaysIso(today, -FRESH_DAYS);

// Единственный повод для уведомления — попадание сделки в РАБОЧИЙ НАБОР. Прежние поводы
// (кластер со скором, вспышка рыночного индикатора) убраны вместе с самими сущностями:
// ни один из них не пережил проверку. Признак `set` считает сборка, здесь он только читается —
// так условие письма не может разойтись с условием бэктеста.
// Ключ отправленного изменился вместе с логикой (был «набор|тикер|дата» для четырёх
// наборов, стал один). Старые ключи не совпадут с новыми, и без версии первая же сборка
// отправила бы недельную историю разом. Смена версии = молчаливый пересев состояния.
const NOTIFY_VERSION = 2;
const seeding = !state.sentTrades || state.version !== NOTIFY_VERSION;
const sent = new Set(state.version === NOTIFY_VERSION ? (state.sentTrades ?? []) : []);
state.version = NOTIFY_VERSION;

// Группируем по (тикер, дата подачи): несколько строк одной покупки — одно письмо
const groups = new Map();
for (const r of feed) {
  if (r.set !== 1 || r.fdate < freshCut) continue;
  const id = `set|${r.t}|${r.fdate}`;
  if (sent.has(id)) continue;
  const g = groups.get(id) ?? { t: r.t, name: r.name, fdate: r.fdate, rows: [] };
  g.rows.push(r);
  groups.set(id, g);
}

const setLine = stats?.set
  ? `Исторически набор давал ${(stats.set.spy * 100).toFixed(1)}% годовых сверх S&P 500 `
    + `(t=${stats.set.spyT}), после издержек ${(stats.set.net * 100).toFixed(1)}%. `
    + `Половина превышения приходится на несколько месяцев из ста двадцати.`
  : '';

for (const [id, g] of groups) {
  sent.add(id);
  if (seeding) continue;
  const total = g.rows.reduce((a, b) => a + b.val, 0);
  const best = g.rows.reduce((a, b) => (b.val ?? 0) > (a.val ?? 0) ? b : a, g.rows[0]);
  const who = [...new Set(g.rows.map(r => r.who))].slice(0, 3).join('; ');
  const lines = [
    `📈 <b>Рабочий набор</b>\n<b>${esc(g.t)}</b> — ${esc(g.name)}`,
    `${esc(who)} (${ROLE[best.role] ?? best.role})`,
    `Куплено на ${money(total)} по ~$${best.px >= 10 ? best.px.toFixed(2) : best.px.toFixed(3)}`,
    `До 52-нед. максимума ${Math.round((best.dd ?? 0) * 100)}% · оборот ${money(best.dv ?? 0)} в день`,
  ];
  if (best.cur) {
    lines.push(`Цена сейчас $${best.cur >= 10 ? best.cur.toFixed(2) : best.cur.toFixed(3)}`
      + (best.chg !== null ? ` (${best.chg >= 0 ? '+' : ''}${Math.round(best.chg * 100)}% с подачи)` : ''));
  }
  lines.push(`⏱ <b>Когда входить:</b> в течение месяца после подачи — дальше сигнала нет. `
    + `Держать три месяца${best.exit ? `, ориентир выхода ${best.exit}` : ''}.`);
  if (setLine) lines.push(setLine);
  lines.push(`<a href="https://ml371kl.github.io/temp-zero-inode-840/#ticker/${encodeURIComponent(g.t)}">Карточка тикера</a>`);
  events.push(lines.join('\n'));
}

state.sentTrades = [...sent].slice(-4000);
writeJson(statePath, state, true);

if (!events.length) { console.log('[notify] новых сигналов нет'); process.exit(0); }
console.log(`[notify] сигналов: ${events.length}`);
// --dry-run печатает то, что было бы отправлено: раньше флаг молча падал в ветку
// «секретов нет», и проверить текст письма было нечем
if (DRY) {
  for (const e of events) console.log('\n---\n' + e.replace(/<[^>]+>/g, ''));
  process.exit(0);
}
if (!token || !chat) { console.log('[notify] секреты Telegram не заданы — отправка пропущена'); process.exit(0); }

const chunks = [];
let cur = '';
for (const e of events) {
  if (cur.length + e.length > 3500) { chunks.push(cur); cur = ''; }
  cur += (cur ? '\n\n———\n\n' : '') + e;
}
if (cur) chunks.push(cur);
for (const text of chunks) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) console.error('[notify] Telegram HTTP', res.status, await res.text());
}
for (const event of events) await sendNexusEvent(event);
console.log('[notify] отправлено сообщений:', chunks.length);
