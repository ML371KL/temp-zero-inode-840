// Telegram-уведомления. Присылаются ТОЛЬКО три вещи, каждая из которых прошла проверку
// на расщеплённой выборке (docs/ЛУЧШИЕ-ФИЛЬТРЫ.md):
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
  const sitesToken = process.env.NEXUS_SITES_TOKEN;
  if (!url || !nexusToken || !sitesToken) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${nexusToken}`,
        'OAI-Sites-Authorization': `Bearer ${sitesToken}`,
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
        'Сюда будут приходить только проверенные сигналы: сделки из наборов ' +
        '«Сила после отчёта» и «Кластер + докупка» со скором ≥55, а также переход ' +
        'рыночного индикатора в зону вспышки.',
    }),
  });
  const body = await res.text();
  if (res.ok) console.log('[notify] тестовое сообщение отправлено');
  else console.error(`[notify] ОШИБКА Telegram HTTP ${res.status}: ${body}`);
  process.exit(res.ok ? 0 : 1);
}

const feed = readJson(join(SITE, 'data', 'feed.json'), []);
const market = readJson(join(SITE, 'data', 'market.json'), null);
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

// Наборы: условия буква в букву совпадают с проверенными в бэктесте
const RECIPES = {
  strength: {
    match: r => r.wo === 1 && r.dd !== null && r.dd >= -0.05 && r.role !== 'C' && r.bucket !== 'н/д',
    title: '📈 <b>Сила после отчёта</b>',
    // Замер затухания: 0 дн +10.5%, неделя +9.8%, две недели +7.6%, два месяца +4.8%
    when: '⏱ <b>Когда входить:</b> в первые 3 дня, максимум неделя. Через две недели теряется треть эффекта — паттерн живёт на свежести отчётной информации.',
    stat: 'Исторически: +10.5% к бенчмарку за 12 мес, медиана +2.2%, выше рынка 53% случаев, плюс в 9 годах из 10.',
  },
  conviction: {
    match: r => r.cl >= 3 && r.dOwn !== null && r.dOwn >= 0.2 && r.dOwn < 9 && r.score >= 55 && r.bucket !== 'н/д',
    title: '🔷 <b>Кластер + докупка, скор ≥55</b>',
    // Замер: 0 дн +39.8%, 5 дн +43.6%, 21 дн +36.1%, 42 дн +26.1%
    when: '⏱ <b>Когда входить:</b> в течение двух недель, максимум месяц. Спешить не нужно — на 3–10 день результат был даже чуть выше, кластер разворачивается неделями.',
    stat: 'Исторически: +39.8% к бенчмарку за 12 мес. Распределение лотерейное — выигрывает 48% сделок, поэтому нужно много позиций.',
  },
};

// Первый запуск после смены логики: запоминаем состояние молча, иначе прилетит вся неделя
const seeding = !state.sentTrades;
const sent = new Set(state.sentTrades ?? []);

// Группируем по (тикер, набор): несколько строк одной покупки не должны давать несколько писем
const groups = new Map();
for (const r of feed) {
  if (r.drop || r.fdate < freshCut) continue;
  for (const [key, def] of Object.entries(RECIPES)) {
    if (!def.match(r)) continue;
    const id = `${key}|${r.t}|${r.fdate}`;
    if (sent.has(id)) continue;
    const g = groups.get(id) ?? { key, t: r.t, name: r.name, fdate: r.fdate, rows: [] };
    g.rows.push(r);
    groups.set(id, g);
  }
}

for (const [id, g] of groups) {
  sent.add(id);
  if (seeding) continue;
  const def = RECIPES[g.key];
  const total = g.rows.reduce((a, b) => a + b.val, 0);
  const best = g.rows.reduce((a, b) => (b.score ?? 0) > (a.score ?? 0) ? b : a, g.rows[0]);
  const who = [...new Set(g.rows.map(r => r.who))].slice(0, 3).join('; ');
  const lines = [
    `${def.title}\n<b>${esc(g.t)}</b> — ${esc(g.name)}`,
    `${esc(who)} (${ROLE[best.role] ?? best.role})`,
    `Куплено на ${money(total)} по ~$${best.px >= 10 ? best.px.toFixed(2) : best.px.toFixed(3)}` +
      (best.dOwn !== null && best.dOwn < 9 ? `, позиция +${Math.round(best.dOwn * 100)}%` : ', позиция открыта с нуля'),
  ];
  if (best.cl >= 2) lines.push(`Независимых покупателей в кластере: ${best.cl}`);
  if (best.score !== null) lines.push(`Скор ${best.score}${best.dd !== null ? ` · до 52-нед. максимума ${Math.round(best.dd * 100)}%` : ''}`);
  if (best.cur) lines.push(`Цена сейчас $${best.cur >= 10 ? best.cur.toFixed(2) : best.cur.toFixed(3)}` +
    (best.chgT !== null ? ` (с даты сделки ${best.chgT > 0 ? '+' : ''}${(best.chgT * 100).toFixed(1)}%)` : ''));
  lines.push('', def.when, '', `<i>${def.stat}</i>`);
  events.push(lines.join('\n'));
}

// Рынок: только переход в зону вспышки (≥3σ). Зона 2–3σ не шлётся — на истории она
// от базовой доходности не отличается.
if (market?.now && market.now.z !== null) {
  const strong = market.thresholds?.strong ?? 3;
  const inFlash = market.now.z >= strong;
  if (inFlash && state.aggFlash !== true) {
    const v = market.validation?.z3?.h12;
    events.push([
      '🚨 <b>Рынок: вспышка инсайдерских покупок</b>',
      `Кластерная активность ${market.now.z >= 0 ? '+' : ''}${market.now.z}σ от двухлетней нормы — редкое состояние, случалось 8 раз за 10 лет.`,
      '',
      '⏱ <b>Когда входить:</b> в течение 1–2 месяцев, оптимально первые две недели. ' +
        'Спешка не нужна: доходность при входе через 1–2 недели была даже выше, чем сразу. ' +
        'После трёх месяцев преимущество исчезает.',
      '',
      v?.n ? `<i>Исторически после таких недель SPY через 12 мес: в среднем ${(v.mean * 100).toFixed(0)}%, ` +
        `положительных ${Math.round(v.pos * 100)}% из ${v.n} наблюдений (база рынка +13.7%).</i>` : '',
      '<i>Осторожно: эпизодов всего 8, окна доходностей перекрываются, порог подобран на этих же данных.</i>',
    ].filter(Boolean).join('\n'));
  }
  state.aggFlash = inFlash;
}

// Храним последние 3000 идентификаторов — с запасом на месяцы работы
if (!DRY) {
  state.sentTrades = [...sent].slice(-3000);
  delete state.clusters;   // наследие прежней логики уведомлений
  delete state.bigBuys;
  delete state.aggZone;
  writeJson(statePath, state, true);
}

if (DRY) {
  console.log(`[notify] СУХОЙ ПРОГОН: событий ${events.length}, состояние не изменено\n`);
  for (const e of events.slice(0, 4)) console.log('─'.repeat(60) + '\n' + e.replace(/<[^>]+>/g, '') + '\n');
  process.exit(0);
}
if (seeding) {
  console.log(`[notify] первый запуск новой логики: запомнено ${sent.size} сигналов без отправки`);
  process.exit(0);
}
if (!events.length) { console.log('[notify] новых сигналов нет'); process.exit(0); }
console.log(`[notify] сигналов: ${events.length}`);
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
