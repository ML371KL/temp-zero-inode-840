// Поддержание слоя внутридневных минимумов для гейта discount (docs/АУДИТ-ГЕЙТОВ.md).
//
// Зачем отдельный слой. Гейт «цена ниже рынка» сравнивал цену формы ТОЛЬКО с закрытием дня.
// У растущей бумаги любое исполнение в первой половине дня выглядит скидкой к закрытию:
// так был ошибочно отсеян CFO AbCellera, купивший по 10.32 при минимуме дня 10.47.
// Аудит на 290 строках с настоящим диапазоном: 44% срабатываний были ложными.
//
// Историю минимумов (129 тыс. дат, 81% всех покупок) залил разовый снимок Sharadar
// 16.08.2026, пока была подписка. Этот скрипт добирает НОВЫЕ даты из Yahoo, который
// отдаёт low бесплатно — иначе после истечения подписки свежие сделки снова остались бы
// без диапазона, а это ровно те сделки, которые смотрят живьём.
//
// Минимумы хранятся в НОМИНАЛЬНОЙ шкале (как цена в форме): Yahoo отдаёт котировки
// скорректированными на сплиты, поэтому раскручиваем их назад через nominalFactor().
// Использование: node scripts/lows.mjs [--data data] [--time-budget-min N]
import { readJson, isoToday } from './lib/util.mjs';
import { loadAllTrades } from './lib/universe.mjs';
import { nominalFactor } from './lib/prices.mjs';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DATA = argVal('--data', 'data');
const BUDGET_MS = Number(argVal('--time-budget-min', '10')) * 60000;
const started = Date.now();
// Дальше этого срока назад не ходим: старое закрыто снимком, а у делистнутых бумаг
// Yahoo всё равно ничего не отдаст.
const LOOKBACK_DAYS = 400;
const PACE_MS = 120;

const path = join(DATA, 'reference', 'lows.csv.gz');
const have = new Set();
let header = 'ticker,date,low,prevlow';
const lines = [];
if (existsSync(path)) {
  const text = gunzipSync(readFileSync(path)).toString('utf8').trim().split('\n');
  header = text[0];
  for (const l of text.slice(1)) { if (!l) continue; lines.push(l); have.add(l.slice(0, l.indexOf(',', l.indexOf(',') + 1))); }
}
console.log(`[lows] в слое уже ${lines.length} строк`);

const cut = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
const { trades } = loadAllTrades(DATA);
const need = new Map();     // ticker -> Set(date)
for (const r of trades) {
  if (r.code !== 'P' || !r.t) continue;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.tdate ?? '') || r.tdate < cut) continue;
  if (have.has(`${r.t},${r.tdate}`)) continue;
  (need.get(r.t) ?? need.set(r.t, new Set()).get(r.t)).add(r.tdate);
}
console.log(`[lows] не хватает: ${need.size} тикеров, ${[...need.values()].reduce((s, x) => s + x.size, 0)} дат`);
if (!need.size) { console.log('[lows] нечего добирать'); process.exit(0); }

const allSplits = readJson(join(DATA, 'prices', '_splits.json'), {});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
let hostIdx = 0, added = 0, missing = 0, budgetOut = false;

for (const [t, dates] of need) {
  if (Date.now() - started > BUDGET_MS) { budgetOut = true; break; }
  const ds = [...dates].sort();
  const p1 = Math.floor(new Date(ds[0] + 'T00:00:00Z').getTime() / 1000) - 10 * 86400;
  const p2 = Math.floor(new Date(ds[ds.length - 1] + 'T00:00:00Z').getTime() / 1000) + 5 * 86400;
  const host = HOSTS[hostIdx++ % HOSTS.length];
  const url = `https://${host}/v8/finance/chart/${encodeURIComponent(t)}?period1=${p1}&period2=${p2}&interval=1d`;
  let j = null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
    if (res.ok) j = await res.json();
  } catch { /* сеть — просто пропускаем, доберём в следующий прогон */ }
  await sleep(PACE_MS);
  const R = j?.chart?.result?.[0];
  if (!R?.timestamp?.length) { missing++; continue; }
  const low = R.indicators?.quote?.[0]?.low;
  if (!low) { missing++; continue; }
  const keys = [], bars = new Map();
  R.timestamp.forEach((ts, i) => {
    if (low[i] == null || !(low[i] > 0)) return;
    const d = new Date(ts * 1000).toISOString().slice(0, 10);
    keys.push(d); bars.set(d, low[i]);
  });
  const sp = allSplits[t];
  for (const d of ds) {
    const i = keys.indexOf(d);
    if (i < 0) continue;
    const k = nominalFactor(sp, d);
    const lo = bars.get(keys[i]) * k;
    const pv = i > 0 ? bars.get(keys[i - 1]) * k : null;
    lines.push(`${t},${d},${lo.toFixed(4)},${pv === null ? '' : pv.toFixed(4)}`);
    added++;
  }
}
writeFileSync(path, gzipSync(header + '\n' + lines.join('\n'), { level: 9 }));
console.log(`[lows] добавлено ${added} дат, без данных ${missing} тикеров, всего в слое ${lines.length}`
  + (budgetOut ? '; бюджет исчерпан, остальное в следующий прогон' : ''));
