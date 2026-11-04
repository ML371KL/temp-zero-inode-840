// Дневные бары для сборки утреннего списка на VPS. Yahoo с адреса VPS не трогаем (адрес почти выбрал часовой лимит из-за 839,
// а api.nasdaq.com закрыт для запросов без браузера: HTTP/2 INTERNAL_ERROR за 50 мс, замер 05.11.2026), поэтому бары просятся у воркера
// (GET /bars, тот же токен приёма) и разбираются тем же кодом, что и в ежедневной сборке (parseYahooChart). Результат вливается в
// копию data/ на VPS: кэш цен, сплиты и открытия дня входа. В ветку data VPS ничего не пишет.
import { join } from 'node:path';
import { parseYahooChart, readPriceCache, writePriceCache, mergeSeries } from './prices.mjs';
import { readOpens, writeOpens, mergeOpens, pickOpens, OPENS_BENCH } from './opens.mjs';
import { readJson, writeJson, addDaysIso } from './util.mjs';

export const BARS_CHUNK = 20;            // тикеров за вызов воркера (у воркера потолок 25 подзапросов)
export const FULL_DAYS = 420;            // истории для бумаги без кэша: 52-недельный максимум плюс запас
export const BACK_DAYS = 3;              // перекрытие с кэшем: свежие данные замещают хвост с точки перекрытия
const UA = 'InsiderRadar/1.0 (rodionkalmykov@gmail.com)';

// С какой даты просить бары: есть кэш — с его последнего бара (с перекрытием), нет — полная история; для открытий — не позже
// первой даты подачи, чей день входа нужен.
export function barsFrom(last, listFor, fdates = []) {
  const base = last ? addDaysIso(last, -BACK_DAYS) : addDaysIso(listFor, -FULL_DAYS);
  const need = fdates.length ? addDaysIso([...fdates].sort()[0], -BACK_DAYS) : null;
  return need && need < base ? need : base;
}

// items — [{ sym, from }]. Возвращает { got: Map(sym -> результат parseYahooChart), failed: {sym: причина}, limited }.
// 429 у воркера прекращает следующие пачки: настаивать — значит ухудшить положение.
export async function fetchBars(base, token, items, { fetchImpl = fetch, pauseMs = 1000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const got = new Map(), failed = {};
  let limited = false;
  for (let i = 0; i < items.length && !limited; i += BARS_CHUNK) {
    if (i) await sleep(pauseMs);
    const chunk = items.slice(i, i + BARS_CHUNK);
    const qs = chunk.map(x => `${x.sym}:${x.from}`).join(',');
    let j;
    try {
      const r = await fetchImpl(`${base}/bars?symbols=${encodeURIComponent(qs)}`, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA }, signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      j = await r.json();
    } catch (e) {
      for (const x of chunk) failed[x.sym] = `воркер /bars: ${e.message || e}`;
      continue;
    }
    for (const [sym, why] of Object.entries(j.failed ?? {})) failed[sym] = why;
    if (j.limited) limited = true;
    for (const [sym, body] of Object.entries(j.bars ?? {})) got.set(sym, parseYahooChart(body));
    for (const x of chunk) if (!got.has(x.sym) && !failed[x.sym]) failed[x.sym] = 'нет в ответе воркера';
  }
  return { got, failed, limited };
}

// Влить ответы в копию data/. opensNeeds — { тикер: [даты подач] }: для них в хранилище открытий кладётся первый торговый день
// после подачи; бенчмарки (IWM, SPY) — каждый день. Возвращает счётчики для лога и проверок.
export function applyBars(dataDir, got, { opensNeeds = {}, bench = OPENS_BENCH, updated = null } = {}) {
  const store = readOpens(dataDir);
  const splitsPath = join(dataDir, 'prices', '_splits.json');
  const splits = readJson(splitsPath, {});
  const stat = { merged: 0, fresh: 0, opens: 0, missing: [] };
  let splitsChanged = false;
  for (const [sym, r] of got) {
    if (r.missing || !r.series?.length) { stat.missing.push(sym); continue; }
    const cached = readPriceCache(dataDir, sym);
    if (!cached?.length) stat.fresh++;
    writePriceCache(dataDir, sym, mergeSeries(cached ?? [], r.series));
    stat.merged++;
    if (r.splits?.length) {
      const have = new Set((splits[sym] ?? []).map(s => s[0]));
      const add = r.splits.filter(s => !have.has(s[0]));
      if (add.length) { splits[sym] = [...(splits[sym] ?? []), ...add].sort((a, b) => (a[0] < b[0] ? -1 : 1)); splitsChanged = true; }
    }
    if (bench.includes(sym)) { mergeOpens(store, sym, pickOpens(r.ohlc, [], { all: true })); stat.opens++; }
    else if (opensNeeds[sym]?.length) { mergeOpens(store, sym, pickOpens(r.ohlc, opensNeeds[sym])); stat.opens++; }
  }
  writeOpens(dataDir, store, updated);
  if (splitsChanged) writeJson(splitsPath, splits);
  return stat;
}
