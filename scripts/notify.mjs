// Telegram-уведомления: новые кластерные покупки и крупные одиночные покупки.
// Без секретов (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) тихо выходит — прод не блокирует.
// Состояние «что уже показано» — data/state/notify.json (переживает прогоны на ветке data).
import { readJson, writeJson, isoToday, addDaysIso } from './lib/util.mjs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const DATA = argVal('--data', 'data');
const SITE = argVal('--site', 'site');

const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;

const clusters = readJson(join(SITE, 'data', 'clusters.json'), []);
const feed = readJson(join(SITE, 'data', 'feed.json'), []);
const market = readJson(join(SITE, 'data', 'market.json'), null);
const statePath = join(DATA, 'state', 'notify.json');
const state = readJson(statePath, { clusters: {}, bigBuys: [] });

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = v => v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + ' млн' : '$' + Math.round(v / 1e3) + ' тыс.';
const events = [];

// Агрегатный индикатор: самое ценное событие по результатам проверки на истории —
// вход в зону, где индикатор исторически что-то значил. Сообщаем только о ПЕРЕХОДЕ,
// чтобы не повторять одно и то же каждую сборку.
if (market?.now && market.now.z !== null) {
  const z = market.now.z, thr = market.thresholds ?? { warn: 2, strong: 3 };
  const zone = z >= thr.strong ? 'strong' : z >= thr.warn ? 'warn' : 'none';
  if (zone !== 'none' && state.aggZone !== zone) {
    const v = market.validation?.[zone === 'strong' ? 'z3' : 'z2']?.h12;
    events.push(`📈 <b>Агрегат инсайдеров: ${zone === 'strong' ? 'ВСПЫШКА' : 'повышенная активность'}</b>\n` +
      `Кластерная активность ${z >= 0 ? '+' : ''}${z}σ от двухлетней нормы.\n` +
      (v?.n ? `Исторически после таких недель SPY через 12 мес: в среднем ${(v.mean * 100).toFixed(0)}% ` +
        `(положительных ${Math.round(v.pos * 100)}% из ${v.n} наблюдений).\n` : '') +
      `Осторожно: эпизодов мало, окна перекрываются, пороги подобраны на этих же данных.`);
  }
  state.aggZone = zone;
}

// Новые/выросшие кластеры
for (const c of clusters) {
  const id = `${c.t}|${c.first}`;
  const prev = state.clusters[id];
  if (!prev) {
    events.push(`🟢 <b>Новый кластер: ${esc(c.t)}</b> (${esc(c.name)})\n` +
      `${c.n} инсайдеров, ${c.nTrades} покупок на ${money(c.totalVal)} с ${c.first}, ` +
      `ср. цена $${c.vwap}${c.cur ? `, сейчас $${c.cur}` : ''}. Скор ${c.score}.`);
  } else if (c.n > prev.n) {
    events.push(`🟢 <b>Кластер растёт: ${esc(c.t)}</b> — уже ${c.n} инсайдеров (было ${prev.n}), объём ${money(c.totalVal)}. Скор ${c.score}.`);
  }
  state.clusters[id] = { n: c.n, val: c.totalVal, seen: isoToday() };
}
// Обрезка записей о кластерах старше года
const pruneCut = addDaysIso(isoToday(), -365);
for (const [id, v] of Object.entries(state.clusters))
  if (v.seen < pruneCut) delete state.clusters[id];

// Крупные одиночные покупки: >= $1 млн, или >= $250 тыс. от CEO/CFO
const known = new Set(state.bigBuys);
for (const r of feed.slice(0, 400)) {
  const big = r.val >= 1e6 || (r.val >= 2.5e5 && (r.role === 'C' || r.role === 'F'));
  if (!big || r.b5) continue;
  const key = `${r.t}|${r.fdate}|${r.who}|${r.val}`;
  if (known.has(key)) continue;
  known.add(key);
  const roleTxt = r.role === 'C' ? 'CEO' : r.role === 'F' ? 'CFO' : r.role === 'O' ? 'офицер' : r.role === 'D' ? 'директор' : 'инсайдер';
  events.push(`🔷 <b>${esc(r.t)}</b>: ${roleTxt} ${esc(r.who)} купил ${money(r.val)} @ $${r.px}` +
    `${r.dOwn !== null && r.dOwn < 9 ? ` (+${Math.round(r.dOwn * 100)}% к позиции)` : ''} · подача ${r.fdate}`);
}
state.bigBuys = [...known].slice(-2000);
writeJson(statePath, state, true);

if (!events.length) { console.log('[notify] новых событий нет'); process.exit(0); }
console.log(`[notify] событий: ${events.length}`);
if (!token || !chat) { console.log('[notify] секреты Telegram не заданы — отправка пропущена'); process.exit(0); }

// Telegram лимит 4096 символов — режем на части
const chunks = [];
let cur = `📡 <b>Инсайдерский радар</b> · ${isoToday()}\n\n`;
for (const e of events) {
  if (cur.length + e.length > 3800) { chunks.push(cur); cur = ''; }
  cur += e + '\n\n';
}
chunks.push(cur);
for (const text of chunks) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) console.error('[notify] Telegram HTTP', res.status, await res.text());
}
console.log('[notify] отправлено сообщений:', chunks.length);
