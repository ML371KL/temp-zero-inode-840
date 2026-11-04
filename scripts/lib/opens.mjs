// Открытия и закрытия торгового дня для «утреннего списка» (покупка на открытии D+1,
// продажа на закрытии того же дня). Лежат отдельным файлом prices/_opens.json.gz, а НЕ
// колонкой основного кэша: на чтении кэша работает цепочка ремонта под болезни Yahoo
// (lib/prices.mjs), которая масштабирует колонки 1–3 вместе с ценой при пересчёте сплита, —
// пятая колонка осталась бы в старых единицах и дала бы тихую рассогласованность.
//
// Пара (открытие, закрытие) обязана приходить из ОДНОГО ответа Yahoo: после сплита источник
// пересчитывает всю историю, и открытие из одной выгрузки с закрытием из другой дало бы
// доходность в разы. Доходность дня r = close/open − 1 инвариантна к сплитам только внутри пары.
// Третье число — вчерашнее закрытие из того же ответа: открытие, ровно равное ему, означает
// «застывшую» котировку (торгов в день не было), а не настоящий аукцион.
//
// Хранятся только нужные дни, поэтому файл крошечный и растёт на сотни записей в месяц:
//  · у бумаги — первый торговый день ПОСЛЕ каждой даты подачи покупки (любой, до гейтов:
//    смена гейтов не должна требовать перекачки);
//  · у бенчмарков (IWM, SPY) — каждый день: по ним определяется сам календарь D+1.
// Старше OPENS_FROM не храним, моложе — не удаляем: счётчик результата копится с запуска
// и обязан воспроизводиться через год.
import { join } from 'node:path';
import { readJsonGz, writeJsonGz, addDaysIso } from './util.mjs';

export const OPENS_FROM = '2026-08-01';
export const OPENS_BENCH = ['IWM', 'SPY'];

export const opensPath = dataDir => join(dataDir, 'prices', '_opens.json.gz');

export function readOpens(dataDir) {
  const s = readJsonGz(opensPath(dataDir), null);
  return s && s.t ? s : { v: 1, from: OPENS_FROM, t: {} };
}
export function writeOpens(dataDir, store, updated) {
  writeJsonGz(opensPath(dataDir), { v: 1, from: OPENS_FROM, updated: updated ?? null, t: store.t });
}

// ohlc — [[iso, open|null, close|null], ...] по возрастанию даты, из одного ответа источника.
// fdates — даты подач покупок по этой бумаге; all — взять каждый день (бенчмарки).
// -> { [iso]: [open, close, prevClose|null] }
// vol — Map дата -> объём дня из того же ответа (ряд цен); запись становится [open, close, prevClose, volume].
// Объём нужен признаку «застывшей» котировки (lib/morning.mjs tradeResult): до 11.2026 им служило равенство
// открытия вчерашнему закрытию, и оно выбрасывало настоящие торги (6 из 316 сделок 08–10.2026).
// Старые записи без объёма читаются как раньше.
export function pickOpens(ohlc, fdates, { all = false, from = OPENS_FROM, vol = null } = {}) {
  const out = {};
  if (!ohlc?.length) return out;
  const put = i => {
    const [d, o, c] = ohlc[i];
    if (d < from || !(o > 0)) return;
    const v = vol?.get(d);
    const e = [o, c > 0 ? c : null, i > 0 && ohlc[i - 1][2] > 0 ? ohlc[i - 1][2] : null];
    if (Number.isFinite(v)) e.push(v);   // объём — только когда известен: старые записи остаются из трёх чисел
    out[d] = e;
  };
  if (all) {
    for (let i = 0; i < ohlc.length; i++) put(i);
    return out;
  }
  for (const f of new Set(fdates ?? [])) {
    if (f < from) continue;
    let lo = 0, hi = ohlc.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ohlc[m][0] <= f) lo = m + 1; else hi = m; }
    if (lo < ohlc.length) put(lo);                       // lo — первый бар строго после даты подачи
  }
  return out;
}

// Свежие записи замещают прежние по той же дате; всё прочее остаётся (дни, уже выпавшие из ответа).
export function mergeOpens(store, ticker, picked, from = OPENS_FROM) {
  const cur = store.t[ticker] ?? {};
  const merged = { ...cur, ...picked };
  for (const d of Object.keys(merged)) if (d < from) delete merged[d];
  if (Object.keys(merged).length) store.t[ticker] = merged; else delete store.t[ticker];
}

export const opensOf = (store, ticker, iso) => store?.t?.[ticker]?.[iso] ?? null;

// Объёмы дней из ряда цен того же ответа: [[iso, close, adjclose, volume], ...] -> Map iso -> volume
export const volumesOf = series => new Map((series ?? []).map(r => [r[0], r[3]]));

// Две последние даты подачи покупок — их бумаги нужны утреннему списку и счётчику D+1 первыми
export function latestFilingDays(trades, n = 2) {
  const s = new Set();
  for (const r of trades ?? []) if (r.code === 'P' && r.fdate) s.add(r.fdate);
  return [...s].sort().slice(-n);
}
// Очередь ежедневной загрузки: бенчмарки, бумаги последних дней подачи, остальные недавние (без повторов).
// all — Map тикер -> { recent, last } (last — последняя дата подачи покупки по бумаге).
export function dailyQueue(all, benchmarks, hotDays) {
  const hot = new Set(hotDays ?? []);
  const first = [], rest = [];
  for (const [t, v] of all) { if (!v.recent) continue; (hot.has(v.last) ? first : rest).push(t); }
  return [...new Set([...benchmarks, ...first.sort(), ...rest])];
}

// Первый торговый день бенчмарка строго после iso (календарь D+1 одинаков для всех бумаг).
// Дальше недели не ищем: в хранилище нет дней до OPENS_FROM и пропусков не бывает, поэтому день
// в неделе от подачи — настоящий D+1, а более далёкий означал бы «настоящий ещё не скачан».
export function nextTradingDay(store, iso, bench = 'IWM') {
  const days = Object.keys(store?.t?.[bench] ?? {}).sort();
  let lo = 0, hi = days.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (days[m] <= iso) lo = m + 1; else hi = m; }
  return lo < days.length && days[lo] <= addDaysIso(iso, 7) ? days[lo] : null;
}
