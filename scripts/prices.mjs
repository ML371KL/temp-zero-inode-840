// Синхронизация цен. Yahoo — первичный, Stooq — резерв (без обхода антибота).
// Кэш замещается полной историей (adjclose пересчитывается задним числом после дивидендов —
// инкрементальная дозапись дала бы разрыв на стыке). При деградации свежего ответа
// (короче половины кэша) сохраняется старый кэш — защита от глюков и потери делистнутых.
// Режимы:
//   --mode daily     — SPY + тикеры с покупками P за последние 25 месяцев + повтор missing
//   --mode backfill  — все тикеры вселенной без кэша (резюмируемо, с бюджетом времени)
//   --opens-only     — только prices/_opens.json.gz (открытия дней входа D+1) для тикеров с
//                      покупками с даты --since (по умолчанию OPENS_FROM); кэш цен, справочники
//                      и состояние не трогаются — для локального прогона и разовой догрузки
// Открытия и закрытия дней входа пишутся в том же проходе из того же ответа Yahoo (lib/opens.mjs).
// Использование: node scripts/prices.mjs --mode daily|backfill [--data data] [--time-budget-min N]
import { readJson, writeJson, isoToday, addDaysIso } from './lib/util.mjs';
import { fetchTickerRef } from './lib/edgar.mjs';
import { OPENS_FROM, OPENS_BENCH, readOpens, writeOpens, pickOpens, mergeOpens, dailyQueue, latestFilingDays, volumesOf } from './lib/opens.mjs';
import { fetchYahooDaily, fetchStooqDaily, readPriceCache, writePriceCache, hasPriceCache, listedThrough } from './lib/prices.mjs';
import { fetchSymbolRanges, writeSymbolRanges, loadSymbolRanges } from './lib/symbols.mjs';
import { loadAllTrades, loadTickerRef, resolveTicker, issuerCategory, plausibleTicker, exchangeCounts } from './lib/universe.mjs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const DATA = argVal('--data', 'data');
const MODE = argVal('--mode', 'daily');
const BUDGET_MS = Number(argVal('--time-budget-min', '300')) * 60000;
const started = Date.now();
const FROM = '2014-01-01'; // запас в 2 года до 2016 — для просадки от 52-недельного максимума

const OPENS_ONLY = args.includes('--opens-only');
const OPENS_SINCE = argVal('--since', OPENS_FROM);

// Свежий справочник тикеров сохраняется для compute. В режиме --opens-only берётся имеющийся:
// локальный прогон ничего в каталоге данных, кроме файла открытий, менять не должен.
const ref = OPENS_ONLY ? loadTickerRef(DATA) : await fetchTickerRef();
if (!OPENS_ONLY) writeJson(join(DATA, 'reference', 'tickers.json'),
  Object.fromEntries([...ref.entries()]), false);

// Реестр биржевых символов с датами (lib/symbols.mjs). Справочник SEC знает только живые
// компании, поэтому у делистнутого эмитента ни биржу, ни принадлежность тикера проверить
// нечем — этим и пользуется подмена данных. Сбой загрузки не критичен: остаётся прежний кэш.
if (!OPENS_ONLY) try {
  const fresh = await fetchSymbolRanges();
  const n = Object.keys(fresh).length;
  if (n < 10000) throw new Error(`подозрительно мало символов (${n}) — кэш сохранён`);
  writeSymbolRanges(DATA, fresh);
  console.log(`[prices] реестр символов обновлён: ${n}`);
} catch (e) {
  console.log(`[prices] реестр символов не обновлён (${e.message})`);
}
const symRanges = loadSymbolRanges(DATA);
console.log(`[prices] символов в реестре: ${Object.keys(symRanges ?? {}).length}`);

const statePath = join(DATA, 'prices', '_state.json');
const state = readJson(statePath, { missing: {} });
const splitsPath = join(DATA, 'prices', '_splits.json');
const splits = readJson(splitsPath, {});
let stooqDown = false; // per-run: челлендж может исчезнуть, проверяем каждый прогон заново

const { trades } = loadAllTrades(DATA);
const today = isoToday();
const recentCut = addDaysIso(today, -760); // ~25 месяцев: открытые 24м окна бэктеста

// Кандидаты: тикеры эмитентов с покупками P (вся вселенная кроме OTC)
const all = new Map(); // ticker -> { recent: bool, fd: [даты подач покупок с OPENS_FROM] }
for (const r of trades) {
  if (r.code !== 'P') continue;
  if (issuerCategory(r, ref, symRanges) === 'otc') continue;
  const t = resolveTicker(r, ref);
  if (!plausibleTicker(t)) continue;
  const e = all.get(t) ?? { recent: false, fd: [], last: '' };
  if (r.fdate >= recentCut) e.recent = true;
  if (r.fdate > e.last) e.last = r.fdate;
  if (r.fdate >= OPENS_FROM) e.fd.push(r.fdate);   // для отбора дней входа D+1
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

// Ряд оборвался, а по реестру символ ещё торгуется — это не делистинг, а просто не
// обновлявшийся кэш: в режиме daily берутся только тикеры с покупками за 25 месяцев.
// Движок такие ряды принимал за делистнутые и закрывал по ним позиции по старой цене.
// Дозагружаем их порциями, начиная с самых устаревших.
const STALE_DAYS = 20;
const STALE_PER_RUN = 150;
function staleTickers() {
  const out = [];
  const cut = addDaysIso(today, -STALE_DAYS);
  for (const t of all.keys()) {
    if (!hasPriceCache(DATA, t)) continue;
    const c = readPriceCache(DATA, t);
    const last = c?.length ? c[c.length - 1][0] : null;
    if (!last || last >= cut) continue;
    const through = listedThrough(symRanges, t);
    if (through === null || through < cut) continue;   // реестр подтверждает делистинг
    out.push([t, last]);
  }
  out.sort((a, b) => a[1] < b[1] ? -1 : 1);
  return out.slice(0, STALE_PER_RUN).map(x => x[0]);
}

const opens = readOpens(DATA);
let list;
if (OPENS_ONLY) {
  list = [...OPENS_BENCH, ...[...all.entries()].filter(([, v]) => v.fd.some(d => d >= OPENS_SINCE)).map(([t]) => t).sort()];
} else if (MODE === 'daily') {
  // Очередь: бенчмарки, затем бумаги двух последних дней подачи (утренний список и счётчик D+1), затем остальные.
  // До 11.2026 новые тикеры шли в конце: при исчерпании бюджета (2 раза из 86 прогонов) у бумаги без ряда
  // не было оборота, и она молча выпадала из списка. Сканер устаревших рядов (9 мин 28.09.2026) — после основного прохода.
  list = dailyQueue(all, BENCHMARKS, latestFilingDays(trades));
  // Повторные попытки по missing: не чаще раза в 7 дней, не более 4 попыток
  for (const [t, m] of Object.entries(state.missing)) {
    if (all.has(t) && m.tries < 4 && (!m.last || m.last < addDaysIso(today, -7))) list.push(t);
  }
} else {
  // backfill: тикеры без кэша и кэши без объёма — в алфавитном порядке (детерминированный резюм)
  list = [...BENCHMARKS, ...[...all.keys()].sort()].filter(t => !hasPriceCache(DATA, t) || needsVolume(t));
}
list = [...new Set(list)];
const LIMIT = Number(argVal('--limit', '0'));
if (LIMIT > 0) list = list.slice(0, LIMIT); // дымовые прогоны
console.log(`[prices] режим ${MODE}: кандидатов ${list.length}`);

let ok = 0, kept = 0, miss = 0, budgetOut = false;
let staleQueued = MODE !== 'daily' || OPENS_ONLY;   // устаревшие ряды встают в очередь после основного прохода
// Гигиена ценового слоя: сколько рядов отвергнуто как чужой инструмент и сколько
// одиночных «залётных» баров снято фильтром. Числа уходят в _quality.json и в meta.json,
// чтобы порча данных была видна на панели, а не только в логе прогона.
const quality = { rejectedMeta: {}, droppedBars: 0, dirtySeries: 0, exchanges: {} };
for (let qi = 0; qi < list.length || !staleQueued; qi++) {
  if (qi >= list.length) {
    staleQueued = true;
    const queued = new Set(list);
    const stale = staleTickers().filter(t => !queued.has(t));
    if (!stale.length) break;
    console.log(`[prices] устаревших рядов при живом листинге: ${stale.length} — дозагружаем`);
    list.push(...stale);
  }
  const t = list[qi];
  if (Date.now() - started > BUDGET_MS) { budgetOut = true; break; }
  let res, fromYahoo = true;
  try { res = await fetchYahooDaily(t, FROM); }
  catch (e) { console.log(`[prices] ${t}: сеть (${e.message}) — пропуск`); continue; }
  if (res.rejected) {
    quality.rejectedMeta[t] = res.rejected;
    console.log(`[prices] ${t}: ответ не про американскую бумагу (${res.rejected}) — ряд отвергнут`);
  }
  if (OPENS_ONLY) {
    if (res.ohlc) { mergeOpens(opens, t, pickOpens(res.ohlc, all.get(t)?.fd, { all: OPENS_BENCH.includes(t), vol: volumesOf(res.series) })); ok++; }
    else miss++;
    continue;
  }
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
      if (res.dropped) { quality.droppedBars += res.dropped; quality.dirtySeries++; }
      if (res.exchange) quality.exchanges[res.exchange] = (quality.exchanges[res.exchange] ?? 0) + 1;
      writePriceCache(DATA, t, res.series);
      // Открытия дней входа — только из ответа Yahoo, из которого пришёл и сам ряд
      if (fromYahoo && res.ohlc) mergeOpens(opens, t, pickOpens(res.ohlc, all.get(t)?.fd, { all: OPENS_BENCH.includes(t), vol: volumesOf(res.series) }));
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

writeOpens(DATA, opens, today);
const nOpens = Object.values(opens.t).reduce((a, d) => a + Object.keys(d).length, 0);
console.log(`[prices] открытия: ${Object.keys(opens.t).length} тикеров, ${nOpens} записей`);
if (OPENS_ONLY) {
  console.log(`[prices] --opens-only: обработано ${ok}, нет данных ${miss}, бюджет ${budgetOut ? 'ИСЧЕРПАН' : 'ок'}`);
  process.exit(0);
}
state.updated = today;
if (MODE === 'backfill') state.backfillDone = !budgetOut;
writeJson(statePath, state, true);
writeJson(splitsPath, splits);
// Отчёт о гигиене накапливается между прогонами: в режиме daily обновляется лишь часть
// вселенной, и разовая цифра ничего не сказала бы о состоянии кэша целиком.
const qPath = join(DATA, 'prices', '_quality.json');
const prevQ = readJson(qPath, {});
writeJson(qPath, {
  updated: today,
  rejectedMeta: { ...(prevQ.rejectedMeta ?? {}), ...quality.rejectedMeta },
  droppedBarsLastRun: quality.droppedBars,
  dirtySeriesLastRun: quality.dirtySeries,
  exchangesLastRun: quality.exchanges,
  // Эмитенты справочника SEC по биржам: новая площадка (как TXSE в 2026) видна здесь сразу
  issuerExchanges: exchangeCounts(ref),
}, true);
console.log(`[prices] эмитенты справочника по биржам: ${Object.entries(exchangeCounts(ref)).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`[prices] готово: обновлено ${ok}, сохранён кэш ${kept}, нет данных ${miss}, бюджет ${budgetOut ? 'ИСЧЕРПАН (нужен ещё прогон)' : 'ок'}`);
console.log(`[prices] гигиена: отвергнуто как чужой инструмент ${Object.keys(quality.rejectedMeta).length}, снято выбросов ${quality.droppedBars} в ${quality.dirtySeries} рядах`);
