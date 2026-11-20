// Дневные бары для сборки утреннего списка на VPS. Yahoo с адреса VPS не трогаем (адрес почти выбрал часовой лимит из-за 839,
// а api.nasdaq.com закрыт для запросов без браузера: HTTP/2 INTERNAL_ERROR за 50 мс, замер 05.11.2026), поэтому бары просятся у воркера
// (GET /bars, тот же токен приёма) и разбираются тем же кодом, что и в ежедневной сборке (parseYahooChart). Результат вливается в
// копию data/ на VPS: кэш цен, сплиты и открытия дня входа. В ветку data VPS ничего не пишет.
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseYahooChart, readPriceCache, writePriceCache, mergeSeries, cachedTail, nominalFactor } from './prices.mjs';
import { readOpens, writeOpens, mergeOpens, pickOpens, volumesOf, OPENS_BENCH } from './opens.mjs';
import { readJson, writeJson, addDaysIso } from './util.mjs';
import { FPI } from './fpi.mjs';

export const BARS_CHUNK = 20;            // тикеров за вызов воркера (у воркера потолок 25 подзапросов)
export const FULL_DAYS = 420;            // истории для бумаги без кэша: 52-недельный максимум плюс запас
export const BACK_DAYS = 3;              // перекрытие с кэшем: свежие данные замещают хвост с точки перекрытия
const UA = 'InsiderRadar/1.0 (rodionkalmykov@gmail.com)';

// С какой даты просить бары: есть кэш — с его последнего бара (с перекрытием), нет — полная история; для открытий — не позже
// первой даты подачи, чей день входа нужен.
// Бумага без кэша — обычно новый податель: признак «давний листинг» (lib/fpi.mjs) смотрит, есть ли у ряда бары раньше
// FPI.listedBefore. Полная сборка качает ряд с 2014 года, и чтобы сборка на сервере видела то же самое, история для бумаги без кэша
// начинается не позже чем за месяц до этой даты (со временем 420 дней от дня списка перестанут до неё доставать).
const LISTED_ANCHOR = addDaysIso(FPI.listedBefore, -31);
export function barsFrom(last, listFor, fdates = []) {
  const full = addDaysIso(listFor, -FULL_DAYS);
  const base = last ? addDaysIso(last, -BACK_DAYS) : (full < LISTED_ANCHOR ? full : LISTED_ANCHOR);
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

// Минимумы дня для гейта «скидка к рынку» (lib/gates.mjs, belowDayRange). Слой reference/lows.csv.gz пополняет только ежедневная
// сборка GitHub (scripts/lows.mjs), поэтому на сервере в 22:03 у сделок из сегодняшних форм минимумов не было, и покупка дешевле
// закрытия дня сделки на 8% отсеивалась без проверки диапазона: 12.11.2026 у COHR и EQPT крупнейшая покупка события на сервере
// оказалась $223 тыс. и $250 тыс. вместо $997 тыс. и $554 тыс., вечерний план бота разошёлся с утренним (аудит форм 17.11.2026,
// находка 4). Ответ источника цен, который сборка и так получает через воркер, несёт минимум дня: дописываем его в свою копию слоя
// в том же виде, что lows.mjs, — строка «тикер формы, дата сделки, минимум дня, минимум предыдущего бара» в номинальной шкале.
// needs — { тикер формы: [даты сделок] } (план сборки, compute --plan). Возвращает число дописанных строк.
export const LOWS_BACK_DAYS = 7;          // запрос начинается за неделю до первой даты сделки: нужен и предыдущий торговый день
export function applyLows(dataDir, got, needs = {}) {
  const path = join(dataDir, 'reference', 'lows.csv.gz');
  const text = existsSync(path) ? gunzipSync(readFileSync(path)).toString('utf8').replace(/\n+$/, '') : 'ticker,date,low,prevlow';
  const have = new Set();
  for (const l of text.split('\n').slice(1)) have.add(l.slice(0, l.indexOf(',', l.indexOf(',') + 1)));
  const known = readJson(join(dataDir, 'prices', '_splits.json'), {});
  const add = [];
  for (const [sym, dates] of Object.entries(needs)) {
    const r = got.get(sym);
    if (!r?.lows?.length) continue;
    const days = r.lows.map(x => x[0]);
    const splits = [...new Map([...(known[sym] ?? []), ...(r.splits ?? [])].map(s => [s[0], s])).values()];
    for (const d of new Set(dates)) {
      if (have.has(`${sym},${d}`)) continue;
      const i = days.indexOf(d);
      if (i < 0) continue;
      const k = nominalFactor(splits, d);
      add.push(`${sym},${d},${(r.lows[i][1] * k).toFixed(4)},${i > 0 ? (r.lows[i - 1][1] * k).toFixed(4) : ''}`);
      have.add(`${sym},${d}`);
    }
  }
  if (add.length) { mkdirSync(join(dataDir, 'reference'), { recursive: true }); writeFileSync(path, gzipSync(text + '\n' + add.join('\n'), { level: 9 })); }
  return add.length;
}

// Влить ответы в копию data/. opensNeeds — { тикер: [даты подач] }: для них в хранилище открытий кладётся первый торговый день
// после подачи; бенчмарки (IWM, SPY) — каждый день. Возвращает счётчики для лога и проверок; tail — бумаги, чей ответ кончился раньше
// копии данных: их последние бары остались из ветки data, а не стёрты (lib/prices.mjs, cachedTail).
export function applyBars(dataDir, got, { opensNeeds = {}, bench = OPENS_BENCH, updated = null } = {}) {
  const store = readOpens(dataDir);
  const splitsPath = join(dataDir, 'prices', '_splits.json');
  const splits = readJson(splitsPath, {});
  const stat = { merged: 0, fresh: 0, opens: 0, missing: [], tail: [] };
  let splitsChanged = false;
  for (const [sym, r] of got) {
    if (r.missing || !r.series?.length) { stat.missing.push(sym); continue; }
    const cached = readPriceCache(dataDir, sym);
    if (!cached?.length) stat.fresh++;
    if (cachedTail(cached, r.series).length) stat.tail.push(sym);
    writePriceCache(dataDir, sym, mergeSeries(cached ?? [], r.series));
    stat.merged++;
    if (r.splits?.length) {
      const have = new Set((splits[sym] ?? []).map(s => s[0]));
      const add = r.splits.filter(s => !have.has(s[0]));
      if (add.length) { splits[sym] = [...(splits[sym] ?? []), ...add].sort((a, b) => (a[0] < b[0] ? -1 : 1)); splitsChanged = true; }
    }
    // Объём дня — в запись открытия, как у ежедневной загрузки (prices.mjs): по нему tradeResult узнаёт застывшую котировку (П9)
    const vol = volumesOf(r.series);
    if (bench.includes(sym)) { mergeOpens(store, sym, pickOpens(r.ohlc, [], { all: true, vol })); stat.opens++; }
    else if (opensNeeds[sym]?.length) { mergeOpens(store, sym, pickOpens(r.ohlc, opensNeeds[sym], { vol })); stat.opens++; }
  }
  writeOpens(dataDir, store, updated);
  if (splitsChanged) writeJson(splitsPath, splits);
  return stat;
}
