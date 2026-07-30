// Синхронизация цен. Yahoo — первичный, Stooq — резерв (без обхода антибота).
// Кэш замещается полной историей (adjclose пересчитывается задним числом после дивидендов —
// инкрементальная дозапись дала бы разрыв на стыке). При деградации свежего ответа
// (короче половины кэша) сохраняется старый кэш — защита от глюков и потери делистнутых.
// Режимы:
//   --mode daily     — SPY + тикеры с покупками P за последние 25 месяцев + повтор missing
//   --mode backfill  — все тикеры вселенной без кэша (резюмируемо, с бюджетом времени)
// Использование: node scripts/prices.mjs --mode daily|backfill [--data data] [--time-budget-min N]
import { readJson, writeJson, isoToday, addDaysIso } from './lib/util.mjs';
import { fetchTickerRef } from './lib/edgar.mjs';
import { fetchYahooDaily, fetchStooqDaily, readPriceCache, writePriceCache } from './lib/prices.mjs';
import { loadAllTrades, resolveTicker, issuerCategory, plausibleTicker } from './lib/universe.mjs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const DATA = argVal('--data', 'data');
const MODE = argVal('--mode', 'daily');
const BUDGET_MS = Number(argVal('--time-budget-min', '300')) * 60000;
const started = Date.now();
const FROM = '2014-01-01'; // запас в 2 года до 2016 — для просадки от 52-недельного максимума

// Свежий справочник тикеров сохраняется для compute
const ref = await fetchTickerRef();
writeJson(join(DATA, 'reference', 'tickers.json'),
  Object.fromEntries([...ref.entries()]), false);

const statePath = join(DATA, 'prices', '_state.json');
const state = readJson(statePath, { missing: {} });
const splitsPath = join(DATA, 'prices', '_splits.json');
const splits = readJson(splitsPath, {});
let stooqDown = false; // per-run: челлендж может исчезнуть, проверяем каждый прогон заново

const { trades } = loadAllTrades(DATA);
const today = isoToday();
const recentCut = addDaysIso(today, -760); // ~25 месяцев: открытые 24м окна бэктеста

// Кандидаты: тикеры эмитентов с покупками P (вся вселенная кроме OTC)
const all = new Map(); // ticker -> { recent: bool }
for (const r of trades) {
  if (r.code !== 'P') continue;
  if (issuerCategory(r, ref) === 'otc') continue;
  const t = resolveTicker(r, ref);
  if (!plausibleTicker(t)) continue;
  const e = all.get(t) ?? { recent: false };
  if (r.fdate >= recentCut) e.recent = true;
  all.set(t, e);
}

// SPY — общий бенчмарк, IWM — бенчмарк для small/micro (без него альфа завышается почти
// вдвое: Lakonishok & Lee 2001, 7.8% -> 4.8% после контроля размера)
const BENCHMARKS = ['SPY', 'IWM'];

// Ряд без колонки объёма — наследие схемы v1; объём нужен для прокси размера компании
const needsVolume = t => {
  const c = readPriceCache(DATA, t);
  return c && (c.length === 0 || c[c.length - 1][3] === null || c[c.length - 1][3] === undefined);
};

let list;
if (MODE === 'daily') {
  list = [...BENCHMARKS, ...[...all.entries()].filter(([, v]) => v.recent).map(([t]) => t)];
  // Повторные попытки по missing: не чаще раза в 7 дней, не более 4 попыток
  for (const [t, m] of Object.entries(state.missing)) {
    if (all.has(t) && m.tries < 4 && (!m.last || m.last < addDaysIso(today, -7))) list.push(t);
  }
} else {
  // backfill: тикеры без кэша и кэши без объёма — в алфавитном порядке (детерминированный резюм)
  list = [...BENCHMARKS, ...[...all.keys()].sort()].filter(t => !readPriceCache(DATA, t) || needsVolume(t));
}
list = [...new Set(list)];
const LIMIT = Number(argVal('--limit', '0'));
if (LIMIT > 0) list = list.slice(0, LIMIT); // дымовые прогоны
console.log(`[prices] режим ${MODE}: кандидатов ${list.length}`);

let ok = 0, kept = 0, miss = 0, budgetOut = false;
for (const t of list) {
  if (Date.now() - started > BUDGET_MS) { budgetOut = true; break; }
  let res, fromYahoo = true;
  try { res = await fetchYahooDaily(t, FROM); }
  catch (e) { console.log(`[prices] ${t}: сеть (${e.message}) — пропуск`); continue; }
  if (res.missing && !stooqDown) {
    fromYahoo = false;
    // Резерв Stooq: пробуем; HTML-челлендж = источник закрыт, больше не трогаем в этом прогоне
    try {
      const s = await fetchStooqDaily(t, FROM);
      if (s.down) { stooqDown = true; console.log('[prices] stooq: антибот-челлендж, резерв недоступен'); }
      else if (s.series) res = s;
    } catch { /* резерв необязателен */ }
  }
  if (res.series) {
    const cached = readPriceCache(DATA, t);
    if (cached && res.series.length < cached.length * 0.5) {
      kept++;
      console.log(`[prices] ${t}: свежий ряд подозрительно короткий (${res.series.length} < ${cached.length}/2) — кэш сохранён`);
    } else {
      writePriceCache(DATA, t, res.series);
      // Сплиты обновляются только по ответу Yahoo: у резервного источника их нет, и «пусто»
      // от него стёрло бы известные коэффициенты, сломав сопоставление цен сделок
      if (fromYahoo) {
        if (res.splits?.length) splits[t] = res.splits;
        else delete splits[t];
      }
      ok++;
    }
    delete state.missing[t];
  } else {
    miss++;
    const m = state.missing[t] ?? { tries: 0 };
    m.tries++; m.last = today;
    state.missing[t] = m;
  }
}

state.updated = today;
if (MODE === 'backfill') state.backfillDone = !budgetOut;
writeJson(statePath, state, true);
writeJson(splitsPath, splits);
console.log(`[prices] готово: обновлено ${ok}, сохранён кэш ${kept}, нет данных ${miss}, бюджет ${budgetOut ? 'ИСЧЕРПАН (нужен ещё прогон)' : 'ок'}`);
