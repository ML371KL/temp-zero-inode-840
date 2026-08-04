// Бэкфил котировок делистнутых бумаг через Tiingo — единственный источник выжившести,
// доступный бесплатно. Yahoo мёртвые тикеры не отдаёт (проверено: LGCY -> HTTP 400
// «data doesn't exist»), Stooq закрыт антибот-челленджем на всех эндпоинтах.
//
// Размер задачи (измерено на выборке 2026-08): у 26.9% покупок ценового ряда нет вовсе.
// Из них 14.9% — настоящая дыра: символ действительно торговался на NYSE/Nasdaq/AMEX
// в дату сделки, это 1512 тикеров. Остальное — внебиржевые бумаги, которые вселенная
// теперь отсекает сама (см. lib/symbols.mjs).
//
// Лимиты бесплатного тарифа: 500 УНИКАЛЬНЫХ символов в месяц, 50 запросов в час,
// 1000 в сутки. Поэтому очередь приоритетная (по экономическому весу пропущенного) и
// резюмируемая: месячный бюджет расходуется за ~11 прогонов, полное покрытие ~4 месяца.
//
// Без секрета TIINGO_TOKEN скрипт молча завершается успехом — сборка от него не зависит.
// Использование: node scripts/tiingo.mjs [--data data] [--time-budget-min N]
import { readJson, writeJson, isoToday } from './lib/util.mjs';
import { writePriceCache, normalizeTiingo } from './lib/prices.mjs';
import { loadSymbolRanges, exchangeAt } from './lib/symbols.mjs';
import { loadAllTrades, loadTickerRef, resolveTicker, issuerCategory, plausibleTicker } from './lib/universe.mjs';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DATA = argVal('--data', 'data');
const BUDGET_MS = Number(argVal('--time-budget-min', '25')) * 60000;
const started = Date.now();

const TOKEN = process.env.TIINGO_TOKEN;
if (!TOKEN) {
  console.log('[tiingo] TIINGO_TOKEN не задан — бэкфил делистнутых пропущен (это не ошибка)');
  process.exit(0);
}

// Запас к лимитам: 480 из 500 символов и 45 из 50 запросов в час. Упереться в лимит
// значит получить 429 и потратить прогон впустую, поэтому идём заведомо ниже.
const MONTH_SYMBOL_CAP = 480;
const REQ_PER_HOUR = 45;
const PACE_MS = Math.ceil(3600000 / REQ_PER_HOUR);
const FROM = '2014-01-01';
const CAP_VAL = 5e7;   // потолок правдоподобия одной сделки — см. gates.isImplausible

const statePath = join(DATA, 'prices', '_tiingo.json');
const state = readJson(statePath, { month: '', usedThisMonth: [], done: [], failed: {} });
const month = isoToday().slice(0, 7);
if (state.month !== month) { state.month = month; state.usedThisMonth = []; }
const used = new Set(state.usedThisMonth);
const done = new Set(state.done);

// ---------- очередь ----------
const ref = loadTickerRef(DATA);
const ranges = loadSymbolRanges(DATA);
if (!ranges) { console.log('[tiingo] нет реестра символов — сначала прогон prices.mjs'); process.exit(0); }
const { trades } = loadAllTrades(DATA);
// Наличие кэша определяется одним обходом каталога: проверять файл на каждую из 190 тыс.
// покупок значило бы распаковать гигабайты впустую.
const pdir = join(DATA, 'prices');
const cached = new Set(existsSync(pdir) ? readdirSync(pdir).filter(f => f.endsWith('.csv.gz')).map(f => f.slice(0, -7)) : []);
const cacheKey = t => t.replace(/[^A-Za-z0-9.-]/g, '_');

const cand = new Map();  // тикер -> вес и период сделок
for (const r of trades) {
  if (r.code !== 'P') continue;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.tdate ?? '')) continue;
  if (issuerCategory(r, ref, ranges) === 'otc') continue;
  const t = resolveTicker(r, ref);
  if (!plausibleTicker(t) || done.has(t)) continue;
  // Восстанавливаем только то, что действительно торговалось на бирже в дату сделки:
  // внебиржевые бумаги вне вселенной, и тратить на них месячный лимит нельзя.
  if (exchangeAt(ranges, t, r.tdate) !== 'listed') continue;
  if (cached.has(cacheKey(t))) continue;
  const e = cand.get(t) ?? { w: 0, big: 0, first: r.tdate, last: r.tdate };
  e.w += Math.min(CAP_VAL, r.val || 0);
  if ((r.val || 0) >= 2.5e5 && (r.val || 0) < CAP_VAL) e.big++;
  if (r.tdate < e.first) e.first = r.tdate;
  if (r.tdate > e.last) e.last = r.tdate;
  cand.set(t, e);
}
// Приоритет — экономический вес пропущенного: топ-500 по нему закрывает около 90%
// долларового объёма всех недостающих сделок.
const queue = [...cand.entries()]
  .filter(([t]) => (state.failed[t]?.tries ?? 0) < 3)
  .sort((a, b) => (b[1].w + b[1].big * 1e6) - (a[1].w + a[1].big * 1e6))
  .map(([t]) => t);
console.log(`[tiingo] кандидатов ${queue.length}; в этом месяце израсходовано символов ${used.size}/${MONTH_SYMBOL_CAP}`);

// ---------- загрузка ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const splitsPath = join(DATA, 'prices', '_splits.json');
const allSplits = readJson(splitsPath, {});
let ok = 0, empty = 0, fail = 0, budgetOut = false, rateLimited = false;

for (const t of queue) {
  if (used.size >= MONTH_SYMBOL_CAP) { console.log('[tiingo] месячный лимит символов исчерпан'); break; }
  if (Date.now() - started > BUDGET_MS) { budgetOut = true; break; }
  // Токен уходит заголовком, а не в строке запроса: URL попадает в тексты сетевых ошибок
  // и в отладочный вывод, а секрету там делать нечего.
  const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(t)}/prices?startDate=${FROM}&format=json`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${TOKEN}` },
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    fail++;
    const f = state.failed[t] ?? { tries: 0 };
    f.tries++; f.last = isoToday(); f.why = 'сеть';
    state.failed[t] = f;
    continue;
  }
  // Символ израсходован в момент запроса независимо от результата — так считает и Tiingo
  used.add(t);
  if (res.status === 429) { rateLimited = true; console.log('[tiingo] 429: лимит запросов — прогон остановлен'); break; }
  if (res.status === 404 || res.status === 400) {
    empty++;
    const f = state.failed[t] ?? { tries: 0 };
    f.tries = 3; f.last = isoToday(); f.why = `HTTP ${res.status}`;   // больше не пробуем
    state.failed[t] = f;
    await sleep(PACE_MS);
    continue;
  }
  if (!res.ok) {
    fail++;
    const f = state.failed[t] ?? { tries: 0 };
    f.tries++; f.last = isoToday(); f.why = `HTTP ${res.status}`;
    state.failed[t] = f;
    await sleep(PACE_MS);
    continue;
  }
  let rows;
  try { rows = await res.json(); } catch { rows = null; }
  if (!Array.isArray(rows) || rows.length < 20) {
    empty++;
    const f = state.failed[t] ?? { tries: 0 };
    f.tries = 3; f.last = isoToday(); f.why = 'пустой ряд';
    state.failed[t] = f;
  } else {
    const { series, splits } = normalizeTiingo(rows);
    if (series.length >= 20) {
      writePriceCache(DATA, t, series);
      if (splits.length) allSplits[t] = splits;
      done.add(t);
      delete state.failed[t];
      ok++;
      console.log(`[tiingo] ${t}: ${series.length} баров ${series[0][0]}..${series[series.length - 1][0]}`);
    } else { empty++; state.failed[t] = { tries: 3, last: isoToday(), why: 'ряд короче 20 баров' }; }
  }
  // Состояние пишется после каждого символа: прогон обрывается по бюджету раннера,
  // и потерять учёт израсходованных символов значит упереться в 429 на следующем.
  state.usedThisMonth = [...used];
  state.done = [...done];
  writeJson(statePath, state, true);
  writeJson(splitsPath, allSplits);
  await sleep(PACE_MS);
}

state.usedThisMonth = [...used];
state.done = [...done];
state.updated = isoToday();
writeJson(statePath, state, true);
writeJson(splitsPath, allSplits);
console.log(`[tiingo] готово: загружено ${ok}, пусто/нет данных ${empty}, сбоев ${fail}; `
  + `символов за месяц ${used.size}/${MONTH_SYMBOL_CAP}; осталось в очереди ${Math.max(0, queue.length - ok - empty)}; `
  + `${rateLimited ? 'ОСТАНОВЛЕН ПО 429' : budgetOut ? 'бюджет исчерпан' : 'очередь пройдена'}`);
