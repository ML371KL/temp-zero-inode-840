// Вычислительное ядро v2: вселенная -> конвейер гейтов G1–G8 -> честные кластеры ->
// трек-рекорд (point-in-time) -> скоринг -> форварды vs SPY и size-бенчмарка -> payload.
// Чистая функция от data/: без сети.
//
// Порядок фаз важен и продиктован памятью: ценовые ряды всех ~6 тыс. тикеров одновременно
// не помещаются в раннер, поэтому всё, что требует цен, сгруппировано по тикеру с вытеснением
// кэша, а фазы без цен (гейты, кластеры, скоринг) идут отдельными проходами.
// Использование: node scripts/compute.mjs [--data data] [--site site]
import { readJson, writeJson, isoToday, addDaysIso } from './lib/util.mjs';
import { readPriceCache, nominalFactor } from './lib/prices.mjs';
import { loadAllTrades, loadTickerRef, resolveTicker, issuerCategory, plausibleTicker } from './lib/universe.mjs';
import { scoreBuy, topRole, dOwnOf, freshness } from './lib/scoring.mjs';
import { applyGates, isPlanned, DROP_LABELS } from './lib/gates.mjs';
import { buildOwnerGroups, isPersonOwner, isFundOnly, countIndependentPersons } from './lib/entity.mjs';
import { buildOwnerHistory, isRoutineCMP, isRegularSeries, inflection, typicalBuyValue } from './lib/routine.mjs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const DATA = argVal('--data', 'data');
const SITE = argVal('--site', 'site');

const today = isoToday();
const HORIZONS = { 3: 63, 6: 126, 12: 252, 24: 504 };  // месяцы -> торговые дни
const PERF_COLS = { d1: 1, w1: 5, m1: 21, m6: 126 };   // короткие колонки ленты
const CLUSTER_GAP_DAYS = 30;    // разрыв внутри цепочки покупок
const CLUSTER_DENSE_DAYS = 14;  // плотное ядро — именно оно даёт документированный эффект
const ACTIVE_WINDOW_DAYS = 90;
const FEED_DAYS = 200;
const STALE_PRICE_DAYS = 14;
const SERIES_CACHE_MAX = 150;   // ограничение памяти на ценовые ряды
const rnd = (v, k = 4) => Math.round(v * 10 ** k) / 10 ** k;

// ---------- Загрузка ----------
const ref = loadTickerRef(DATA);
if (!ref.size) throw new Error('reference/tickers.json пуст — сначала запустите prices.mjs');
const { trades: tradesAll, stats: loadStats } = loadAllTrades(DATA);
if (!tradesAll.length) throw new Error('нет сделок — сначала backfill/live');

const spy = readPriceCache(DATA, 'SPY');
if (!spy || spy.length < 500) throw new Error('нет ряда SPY — бенчмарк обязателен, compute остановлен');
const iwm = readPriceCache(DATA, 'IWM');
if (!iwm || iwm.length < 500) console.log('[compute] нет ряда IWM — size-бенчмарк недоступен, excess только vs SPY');

// ---------- Вселенная ----------
let cntOtc = 0, cntBadTicker = 0;
const trades = [];
for (const r of tradesAll) {
  const cat = issuerCategory(r, ref);
  if (cat === 'otc') { cntOtc++; continue; }
  const t = resolveTicker(r, ref);
  if (!plausibleTicker(t)) { cntBadTicker++; continue; }
  trades.push({ ...r, T: t, cat });
}
trades.sort((a, b) => a.fdate < b.fdate ? -1 : a.fdate > b.fdate ? 1 : 0);
const buys = trades.filter(r => r.code === 'P');
const byTicker = new Map();
for (const r of trades) (byTicker.get(r.T) ?? byTicker.set(r.T, []).get(r.T)).push(r);

// ---------- Доступ к ценам (с вытеснением) ----------
const priceMap = new Map();
function series(t) {
  if (!priceMap.has(t)) {
    if (priceMap.size >= SERIES_CACHE_MAX) priceMap.clear();
    priceMap.set(t, readPriceCache(DATA, t));
  }
  return priceMap.get(t);
}
function datesOf(s) {
  if (!s._dates) Object.defineProperty(s, '_dates', { value: s.map(r => r[0]), enumerable: false });
  return s._dates;
}
function idxAtOrBefore(s, iso) {
  const d = datesOf(s);
  let lo = 0, hi = d.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (d[m] <= iso) lo = m + 1; else hi = m; }
  return lo - 1;
}
// Вход по сигналу: закрытие первого торгового дня ПОСЛЕ подачи формы (point-in-time).
// Если подача раньше начала ценового ряда, входа нет: первый бар может быть спустя месяцы
// (переиспользованный тикер, поздний листинг) — такая «сделка» не воспроизводима.
const ENTRY_MAX_GAP_DAYS = 10;
function idxFirstAfter(s, iso) {
  const i = idxAtOrBefore(s, iso);
  const next = i + 1;
  if (next >= s.length) return -1;
  if (i < 0 && s[next][0] > addDaysIso(iso, ENTRY_MAX_GAP_DAYS)) return -1;
  return next;
}
function drawdownAt(s, iso) {
  const i = idxAtOrBefore(s, iso);
  if (i < 30) return null;
  const from = addDaysIso(iso, -365);
  let hi = 0;
  for (let k = i; k >= 0 && s[k][0] >= from; k--) hi = Math.max(hi, s[k][2]);
  return hi > 0 ? rnd(s[i][2] / hi - 1) : null;
}
// Прокси размера компании: медианный дневной $-оборот за 60 торговых дней до сделки.
// Капитализации в бесплатных источниках нет; оборот с ней коррелирует и заодно отражает
// торгуемость сигнала (Cziraki & Gider 2021: альфа концентрирована в неликвидных именах).
function dollarVolumeAt(s, iso) {
  const i = idxAtOrBefore(s, iso);
  if (i < 20) return null;
  const vals = [];
  for (let k = Math.max(0, i - 59); k <= i; k++) {
    const v = s[k][3];
    if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) continue;
    vals.push(s[k][1] * v);
  }
  if (vals.length < 15) return null;
  vals.sort((a, b) => a - b);
  return Math.round(vals[(vals.length - 1) >> 1]);
}
function sizeBucket(dv) {
  if (dv === null) return 'н/д';
  if (dv < 3e6) return 'micro';
  if (dv < 3e7) return 'small';
  if (dv < 3e8) return 'mid';
  return 'large';
}
const benchFor = b => ((b === 'micro' || b === 'small') && iwm?.length ? iwm : spy);

// ---------- Фаза A: всё, что требует цен (по тикерам, с вытеснением) ----------
function forward(row, s) {
  const out = {};
  const e = idxFirstAfter(s, row.fdate);
  if (e < 0) { for (const m of Object.keys(HORIZONS)) out['s' + m] = 'o'; return out; }
  const bench = benchFor(row._bucket);
  const dead = s[s.length - 1][0] < addDaysIso(today, -STALE_PRICE_DAYS);
  const entryAdj = s[e][2];
  const bE = idxAtOrBefore(bench, s[e][0]);
  const spyE = idxAtOrBefore(spy, s[e][0]);
  out.entry = s[e][0];
  for (const [m, days] of Object.entries(HORIZONS)) {
    const x = e + days;
    let exitIdx, status = 'c';
    if (x < s.length) exitIdx = x;
    // Делистинг: закрываем последней ценой, но только если она позже входа —
    // иначе получился бы фиктивный «закрытый» результат с нулевой доходностью
    else if (dead && s.length - 1 > e) { exitIdx = s.length - 1; status = 'd'; }
    else { out['s' + m] = 'o'; continue; }                     // окно ещё не дозрело
    const ret = s[exitIdx][2] / entryAdj - 1;
    const bX = idxAtOrBefore(bench, s[exitIdx][0]);
    const spyX = idxAtOrBefore(spy, s[exitIdx][0]);
    out['r' + m] = rnd(ret);
    out['e' + m] = rnd(ret - (bE >= 0 && bX > bE ? bench[bX][2] / bench[bE][2] - 1 : 0));
    out['x' + m] = rnd(ret - (spyE >= 0 && spyX > spyE ? spy[spyX][2] / spy[spyE][2] - 1 : 0));
    out['s' + m] = status;
    if (m === '6') out.mat6 = s[exitIdx][0];  // дата дозревания — для point-in-time трек-рекорда
  }
  // Короткие колонки ленты: только реально дозревшие окна. Для мёртвых тикеров хвост
  // не растягиваем — иначе 1д/1н/1м/6м показывали бы одно и то же число.
  for (const [k, days] of Object.entries(PERF_COLS)) {
    const x = e + days;
    if (x < s.length) out[k] = rnd(s[x][2] / entryAdj - 1);
  }
  return out;
}

const allSplits = readJson(join(DATA, 'prices', '_splits.json'), {});
const noPriceTickers = new Set(), pricedTickers = new Set();
const unitsMismatch = new Set();
for (const [t, rows] of byTicker) {
  const s = series(t);
  const has = !!(s && s.length > 100);
  if (has) pricedTickers.add(t); else noPriceTickers.add(t);
  const cur = has ? s[s.length - 1][1] : null;
  const lastAdj = has ? s[s.length - 1][2] : null;
  const sp = allSplits[t];
  for (const r of rows) {
    if (!has) { r._dv = null; r._bucket = 'н/д'; r._dd = null; r._fw = null; r._close = null; continue; }
    const i = idxAtOrBefore(s, r.tdate);
    // Цена, которую инсайдер видел в момент сделки: котировка «раскручена» назад через сплиты
    r._split = nominalFactor(sp, r.tdate);
    r._close = i >= 0 ? rnd(s[i][1] * r._split, 4) : null;
    r._dd = drawdownAt(s, r.tdate);
    r._cur = cur;
    if (r.code !== 'P') continue;
    r._dv = dollarVolumeAt(s, r.tdate);
    r._bucket = sizeBucket(r._dv);
    r._fw = forward(r, s);
    const e = idxFirstAfter(s, r.fdate);
    r._chg = e >= 0 ? rnd(lastAdj / s[e][2] - 1) : null;
  }
  // Остаточное расхождение единиц по всему эмитенту (ADR-коэффициент, отчётность в другой
  // валюте): у настоящего размещения отклоняются отдельные сделки, а здесь — все и одинаково.
  // Порог по числу сделок высокий: у эмитента с несколькими PIPE подряд медиана тоже
  // «съезжает», а решение здесь принимается сразу по всему эмитенту.
  const ratios = rows.filter(r => r.code === 'P' && r.px > 0 && r._close > 0).map(r => r.px / r._close).sort((a, b) => a - b);
  if (ratios.length >= 5) {
    const q = p => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))];
    const med = q(0.5);
    if (Math.abs(med - 1) > 0.15 && (q(0.75) - q(0.25)) / med < 0.1) unitsMismatch.add(t);
  }
}

// ---------- Фаза B: контекст и гейты (без цен) ----------
const ownerGroups = buildOwnerGroups(trades);
const history = buildOwnerHistory(trades);
const primaryOwner = r => (r.owners ?? []).find(isPersonOwner) ?? r.owners?.[0] ?? null;

// Синхронные подачи: одна дата, один эмитент, ТОЧНО одна цена у нескольких независимых
// филеров — подпись закрытия размещения (фонд+GP+партнёр склеены в одну группу).
// Ценовой допуск здесь недопустим: несколько инсайдеров, покупающих в один день на открытом
// рынке, естественно попадают в интервал в доли процента — их кластер вырезать нельзя.
const syncCount = new Map();
for (const r of buys) {
  if (!r.px) continue;
  r._syncKey = `${r.cik}|${r.tdate}|${r.px}`;
  const set = syncCount.get(r._syncKey) ?? new Set();
  for (const o of r.owners ?? []) set.add(ownerGroups.get(o.cik) ?? o.cik);
  syncCount.set(r._syncKey, set);
}

for (const r of buys) {
  const po = primaryOwner(r);
  const hist = po ? (history.get(po.cik) ?? []) : [];
  r._routine = isRoutineCMP(hist, r.tdate);
  r._gate = applyGates(r, {
    close: r._close,
    syncFilers: (syncCount.get(r._syncKey)?.size) ?? 1,
    planned: isPlanned(r),
    routine: r._routine,
    regular: isRegularSeries(hist, r.tdate, r.cik, 'P'),
    fundOnly: isFundOnly(r),
    unitsMismatch: unitsMismatch.has(r.T),
  });
}

// ---------- Фаза C: честные кластеры (только по прошедшим гейты) ----------
const clustersByTicker = new Map();
const clusterOfRow = new Map();
for (const [t, rows] of byTicker) {
  const ok = rows.filter(r => r.code === 'P' && r._gate.ok).sort((a, b) => a.tdate < b.tdate ? -1 : 1);
  const chains = [];
  let chain = [];
  for (const b of ok) {
    if (chain.length && addDaysIso(chain[chain.length - 1].tdate, CLUSTER_GAP_DAYS) < b.tdate) { chains.push(chain); chain = []; }
    chain.push(b);
  }
  if (chain.length) chains.push(chain);
  const clusters = [];
  for (const c of chains) {
    const persons = countIndependentPersons(c, ownerGroups);
    if (persons < 2) continue;
    // Плотное ядро: максимум независимых физлиц в скользящем окне 14 дней
    let dense = 1;
    for (let i = 0; i < c.length; i++) {
      const end = addDaysIso(c[i].tdate, CLUSTER_DENSE_DAYS);
      const win = c.filter(x => x.tdate >= c[i].tdate && x.tdate <= end);
      dense = Math.max(dense, countIndependentPersons(win, ownerGroups));
    }
    const cl = { rows: c, persons, dense };
    clusters.push(cl);
    for (const r of c) clusterOfRow.set(r, cl);
  }
  if (clusters.length) clustersByTicker.set(t, clusters);

  // Point-in-time размер кластера: сколько независимых физлиц было ВИДНО на момент подачи
  // именно этой формы. Полный размер цепочки включает покупки, поданные позже, и годится
  // для живого скринера («что известно сегодня»), но в бэктесте это утечка будущего.
  for (const r of ok) {
    const from = addDaysIso(r.tdate, -CLUSTER_DENSE_DAYS);
    const known = ok.filter(x => x.fdate <= r.fdate && x.tdate <= r.tdate && x.tdate >= from);
    r._clPit = countIndependentPersons(known, ownerGroups);
  }
}

// ---------- Фаза D: трек-рекорд (point-in-time) и скоринг ----------
// Для сделки, поданной в момент F, используются только прошлые покупки того же лица,
// чей 6-месячный горизонт УЖЕ закрылся до F. Иначе скоринг знал бы будущее.
const ownerBuys = new Map();
for (const r of buys) {
  if (!r._fw?.mat6 || r._fw.e6 === undefined) continue;
  for (const o of (r.owners ?? []).filter(isPersonOwner)) {
    const g = ownerGroups.get(o.cik) ?? o.cik;
    (ownerBuys.get(g) ?? ownerBuys.set(g, []).get(g)).push({ mat: r._fw.mat6, e: r._fw.e6 });
  }
}
for (const list of ownerBuys.values()) list.sort((a, b) => a.mat < b.mat ? -1 : 1);

function trackRecord(row) {
  let n = 0, hits = 0;
  const seen = new Set();
  for (const o of (row.owners ?? []).filter(isPersonOwner)) {
    const g = ownerGroups.get(o.cik) ?? o.cik;
    if (seen.has(g)) continue;
    seen.add(g);
    for (const p of ownerBuys.get(g) ?? []) {
      if (p.mat >= row.fdate) break;   // список отсортирован — дальше только будущее
      n++; if (p.e > 0) hits++;
    }
  }
  return n ? { n, hit: rnd(hits / n, 3) } : null;
}

for (const r of buys) {
  const po = primaryOwner(r);
  const hist = po ? (history.get(po.cik) ?? []) : [];
  r._role = topRole((r.owners ?? []).filter(isPersonOwner).map(o => o.rel));
  r._dOwn = dOwnOf(r);
  if (!r._gate.ok) { r._score = null; continue; }
  const cl = clusterOfRow.get(r);
  const typical = typicalBuyValue(hist, r.tdate);
  r._track = trackRecord(r);
  r._inflect = inflection(hist, r.tdate);
  const common = {
    role: r._role, dOwn: r._dOwn, dd: r._dd, track: r._track, inflect: r._inflect,
    sizeVsTypical: typical > 0 ? rnd(r.val / typical, 2) : null,
  };
  // Скор «на сегодня» — для ленты и скринера (полный кластер уже известен)
  r._score = scoreBuy({
    ...common,
    persons: cl ? cl.dense : 1,
    totalVal: cl ? cl.rows.reduce((a, b) => a + b.val, 0) : r.val,
  });
  // Скор «на момент подачи» — только он идёт в бэктест
  const pitRows = cl ? cl.rows.filter(x => x.fdate <= r.fdate && x.tdate <= r.tdate) : [];
  r._scorePit = scoreBuy({
    ...common,
    persons: r._clPit ?? 1,
    totalVal: pitRows.length ? pitRows.reduce((a, b) => a + b.val, 0) : r.val,
  });
}

// ---------- Payload ----------
const dataOut = join(SITE, 'data');
mkdirSync(dataOut, { recursive: true });
const W = (p, obj) => writeJson(join(dataOut, p), obj);
const busDays = (a, b) => {
  let n = 0;
  for (let d = a; d < b; d = addDaysIso(d, 1)) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
};
const daysAgo = iso => Math.round((Date.parse(today) - Date.parse(iso)) / 86400000);

// Лента: показываем ВСЕ покупки, включая отсеянные, но с причиной отсева —
// пользователь видит и сигнал, и то, что именно было отфильтровано и почему.
const feedCut = addDaysIso(today, -FEED_DAYS);
const feedRows = buys.filter(r => r.fdate >= feedCut).map(r => {
  const cl = clusterOfRow.get(r);
  return {
    t: r.T, name: ref.get(r.cik)?.name ?? r.t, fdate: r.fdate, tdate: r.tdate, form: r.form,
    who: (r.owners ?? []).map(o => o.name).join('; '),
    ciks: (r.owners ?? []).filter(isPersonOwner).map(o => ownerGroups.get(o.cik) ?? o.cik),
    role: r._role, title: r.owners?.[0]?.title || '',
    sh: r.sh, px: r.px, val: r.val, own: r.own, dOwn: r._dOwn, di: r.di,
    delay: busDays(r.tdate, r.fdate),
    cl: cl ? cl.dense : 1, dd: r._dd, dv: r._dv ?? null, bucket: r._bucket,
    score: r._score?.total ?? null, parts: r._score?.parts ?? null,
    fresh: freshness(daysAgo(r.fdate)),
    drop: r._gate.drop, tags: r._gate.tags,
    track: r._track ?? null, inflect: r._inflect ?? null,
    b5: isPlanned(r) ? 1 : 0, routine: r._routine,
    cur: r._cur ?? null, chg: r._chg ?? null,
    d1: r._fw?.d1 ?? null, w1: r._fw?.w1 ?? null, m1: r._fw?.m1 ?? null, m6: r._fw?.m6 ?? null,
  };
});
feedRows.sort((a, b) => b.fdate < a.fdate ? -1 : b.fdate > a.fdate ? 1 : (b.score ?? -1) - (a.score ?? -1));
W('feed.json', feedRows);

// Активные кластеры
const activeCut = addDaysIso(today, -ACTIVE_WINDOW_DAYS);
const activeClusters = [];
for (const [t, clusters] of clustersByTicker) {
  for (const c of clusters) {
    const last = c.rows[c.rows.length - 1];
    if (last.tdate < activeCut) continue;
    const totalVal = c.rows.reduce((a, b) => a + b.val, 0);
    const totalSh = c.rows.reduce((a, b) => a + b.sh, 0);
    const best = c.rows.reduce((a, b) => (b._score?.total ?? 0) > (a._score?.total ?? 0) ? b : a, c.rows[0]);
    const ownersMap = new Map();
    for (const r of c.rows)
      for (const o of (r.owners ?? []).filter(isPersonOwner)) {
        const g = ownerGroups.get(o.cik) ?? o.cik;
        if (!ownersMap.has(g)) ownersMap.set(g, { cik: g, name: o.name, rel: o.rel, title: o.title });
      }
    activeClusters.push({
      t, name: ref.get(c.rows[0].cik)?.name ?? c.rows[0].t,
      n: c.persons, dense: c.dense, buyers: [...ownersMap.values()],
      first: c.rows[0].tdate, last: last.tdate, nTrades: c.rows.length,
      totalVal: Math.round(totalVal), vwap: totalSh > 0 ? rnd(totalVal / totalSh, 2) : null,
      dd: last._dd, bucket: last._bucket, role: topRole(c.rows.map(r => r._role)),
      score: best._score?.total ?? 0, parts: best._score?.parts ?? {},
      fresh: freshness(daysAgo(last.fdate)),
      cur: last._cur ?? null, chg: c.rows[0]._chg ?? null,
      inflect: c.rows.some(r => r._inflect) ? 1 : 0,
      track: Math.max(...c.rows.map(r => r._track?.hit ?? -1)) >= 0.6 ? 1 : 0,
    });
  }
}
activeClusters.sort((a, b) => (b.score * b.fresh) - (a.score * a.fresh) || b.totalVal - a.totalVal);
W('clusters.json', activeClusters);

// Бэктест: ВСЕ покупки с ценами, включая отсеянные (с причиной) — экран «Статистика»
// проверяет на собственных данных, что гейты режут именно шум, а не сигнал.
// В бэктест идут ТОЛЬКО point-in-time версии кластера и скора (см. фазу C)
const backtestRows = buys.filter(r => r._fw).map(r => ({
  t: r.T, fdate: r.fdate, tdate: r.tdate, val: r.val, role: r._role,
  cl: r._clPit ?? 1,
  b5: isPlanned(r) ? 1 : 0, routine: r._routine, dd: r._dd, dOwn: r._dOwn,
  score: r._scorePit?.total ?? null, bucket: r._bucket,
  gate: r._gate.ok ? 'ok' : r._gate.drop,
  inflect: r._inflect ?? null, track: r._track?.hit ?? null,
  ...r._fw,
}));
const years = [...new Set(backtestRows.map(r => r.fdate.slice(0, 4)))].sort();
mkdirSync(join(dataOut, 'backtest'), { recursive: true });
for (const y of years) W(join('backtest', y + '.json'), backtestRows.filter(r => r.fdate.slice(0, 4) === y));
W('backtest/index.json', { years });

// Агрегаты
const bucketSizeLabel = v => v >= 1e6 ? '≥$1M' : v >= 2.5e5 ? '$250k–1M' : v >= 5e4 ? '$50–250k' : '<$50k';
const bucketDdLabel = d => d === null ? 'н/д' : d <= -0.30 ? 'просадка >30%' : d <= -0.15 ? 'просадка 15–30%' : d >= -0.05 ? 'у максимума' : 'просадка <15%';
const DIMS = {
  gate: r => r.gate === 'ok' ? '✓ прошли гейты' : (DROP_LABELS[r.gate] ?? r.gate),
  all: () => 'прошедшие гейты',
  cluster: r => r.cl >= 3 ? 'кластер ≥3' : r.cl === 2 ? 'кластер 2' : 'одиночная',
  role: r => r.role,
  size: r => bucketSizeLabel(r.val),
  liquidity: r => r.bucket,
  routine: r => r.routine === true ? 'рутинная (CMP)' : r.routine === false ? 'оппортунистическая' : 'нет истории',
  inflect: r => r.inflect ?? 'обычная',
  dd: r => bucketDdLabel(r.dd),
  score: r => r.score === null ? 'отсеяна' : r.score >= 70 ? 'скор 70+' : r.score >= 50 ? 'скор 50–69' : r.score >= 30 ? 'скор 30–49' : 'скор <30',
  year: r => r.fdate.slice(0, 4),
};
// Срезы, кроме 'gate' и 'routine', считаются только по прошедшим гейты:
// иначе PIPE-размещения и плановые сделки размывают картину сигнала.
const ALL_ROWS_DIMS = new Set(['gate', 'routine']);
function aggregate(rows) {
  const out = {};
  for (const [dim, fn] of Object.entries(DIMS)) {
    const src = ALL_ROWS_DIMS.has(dim) ? rows : rows.filter(r => r.gate === 'ok');
    const groups = new Map();
    for (const r of src) (groups.get(fn(r)) ?? groups.set(fn(r), []).get(fn(r))).push(r);
    out[dim] = {};
    for (const [g, rs] of [...groups.entries()].sort()) {
      const cell = { total: rs.length };
      for (const m of Object.keys(HORIZONS)) {
        const done = rs.filter(x => x['s' + m] === 'c');
        const dead = rs.filter(x => x['s' + m] === 'd');
        const exc = done.map(x => x['e' + m]).filter(v => v !== undefined).sort((a, b) => a - b);
        const excSpy = done.map(x => x['x' + m]).filter(v => v !== undefined).sort((a, b) => a - b);
        const withDead = exc.concat(dead.map(x => x['e' + m]).filter(v => v !== undefined)).sort((a, b) => a - b);
        const med = a => a.length ? a[(a.length - 1) >> 1] : null;
        cell['h' + m] = {
          n: done.length, nd: dead.length,
          med: med(exc) !== null ? rnd(med(exc)) : null,
          medSpy: med(excSpy) !== null ? rnd(med(excSpy)) : null,
          mean: exc.length ? rnd(exc.reduce((a, b) => a + b, 0) / exc.length) : null,
          pos: exc.length ? rnd(exc.filter(x => x > 0).length / exc.length) : null,
          medD: med(withDead) !== null ? rnd(med(withDead)) : null,
        };
      }
      out[dim][g] = cell;
    }
  }
  return out;
}
W('stats.json', {
  built: today, horizons: Object.keys(HORIZONS).map(Number),
  agg: aggregate(backtestRows), n: backtestRows.length,
  nOk: backtestRows.filter(r => r.gate === 'ok').length,
  iwm: !!iwm?.length,
});

// Рейтинг инсайдеров: у бесплатных инструментов отсутствует, у платных — ключевая фича.
// Считается по закрытым 6-месячным окнам прошедших гейты покупок.
const insiderAgg = new Map();
for (const r of buys) {
  if (!r._gate.ok) continue;
  for (const o of (r.owners ?? []).filter(isPersonOwner)) {
    const g = ownerGroups.get(o.cik) ?? o.cik;
    let e = insiderAgg.get(g);
    if (!e) { e = { cik: g, name: o.name, roles: new Set(), tickers: new Set(), n: 0, val: 0, last: '', wins: 0, closed: 0, exc: [] }; insiderAgg.set(g, e); }
    if (o.name) e.name = o.name;
    e.roles.add(topRole([o.rel]));
    e.tickers.add(r.T);
    e.n++; e.val += r.val;
    if (r.fdate > e.last) e.last = r.fdate;
    if ((r._fw?.s6 === 'c' || r._fw?.s6 === 'd') && r._fw.e6 !== undefined) {
      e.closed++; if (r._fw.e6 > 0) e.wins++; e.exc.push(r._fw.e6);
    }
  }
}
const insiders = [...insiderAgg.values()]
  .filter(e => e.n >= 3 && e.closed >= 3)
  .map(e => {
    const sorted = e.exc.slice().sort((a, b) => a - b);
    return {
      cik: e.cik, name: e.name, roles: [...e.roles], nTickers: e.tickers.size,
      tickers: [...e.tickers].slice(0, 6), n: e.n, val: Math.round(e.val), last: e.last,
      closed: e.closed, hit: rnd(e.wins / e.closed, 3),
      med: sorted.length ? rnd(sorted[(sorted.length - 1) >> 1]) : null,
    };
  })
  .sort((a, b) => (b.hit - a.hit) || (b.closed - a.closed))
  .slice(0, 1500);
W('insiders.json', insiders);

// Карточки тикеров (второй проход по ценам — ряды уже вытеснены из кэша)
mkdirSync(join(dataOut, 'tickers'), { recursive: true });
function isoWeek(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const y = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(y, 0, 4));
  return `${y}-${1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)}`;
}
let tickerFiles = 0;
for (const [t, rows] of byTicker) {
  const buysHere = rows.filter(r => r.code === 'P');
  if (!buysHere.length) continue;
  const s = series(t);
  let weekly = [], daily = [];
  if (s?.length) {
    let lastWeek = '';
    for (const row of s) {
      if (row[0] < '2015-07-01') continue;
      const wk = isoWeek(row[0]);
      if (wk === lastWeek) weekly[weekly.length - 1] = [row[0], row[1]];
      else { weekly.push([row[0], row[1]]); lastWeek = wk; }
    }
    const dcut = addDaysIso(today, -380);
    daily = s.filter(r => r[0] >= dcut).map(r => [r[0], r[1]]);
  }
  const cik0 = rows[0].cik;
  const sells = rows.filter(r => r.code === 'S');
  W(join('tickers', t.replace(/[^A-Za-z0-9.-]/g, '_') + '.json'), {
    t, name: ref.get(cik0)?.name ?? rows[0].t, exchange: ref.get(cik0)?.exchange ?? null,
    cat: rows[0].cat, asOf: s?.length ? s[s.length - 1][0] : null,
    bucket: buysHere[buysHere.length - 1]._bucket ?? null,
    // «Культура продаж» эмитента (паттерн VerityData): где продажи — рутина, а где событие
    sellRatio: rnd(sells.length / buysHere.length, 2),
    okBuys: buysHere.filter(r => r._gate.ok).length,
    trades: rows.map(r => ({
      fdate: r.fdate, tdate: r.tdate, form: r.form, code: r.code,
      who: (r.owners ?? []).map(o => o.name).join('; '),
      role: r._role ?? topRole((r.owners ?? []).map(o => o.rel)), title: r.owners?.[0]?.title || '',
      sh: r.sh, px: r.px, val: r.val, own: r.own, dOwn: dOwnOf(r), di: r.di, sec: r.sec || '',
      // Цена сделки в той же системе координат, что и график: номинал / сплит-фактор
      pxAdj: r.px && r._split ? rnd(r.px / r._split, 4) : r.px,
      b5: isPlanned(r) ? 1 : 0,
      cl: r.code === 'P' ? (clusterOfRow.get(r)?.dense ?? 1) : null,
      drop: r.code === 'P' ? (r._gate?.drop ?? null) : null,
      score: r._score?.total ?? null,
    })).sort((a, b) => a.tdate < b.tdate ? 1 : -1),
    weekly, daily,
  });
  tickerFiles++;
}
W('tickers-index.json', [...byTicker.entries()]
  .filter(([, rows]) => rows.some(r => r.code === 'P'))
  .map(([t, rows]) => ({ t, name: ref.get(rows[0].cik)?.name ?? rows[0].t }))
  .sort((a, b) => a.t < b.t ? -1 : 1));

// Мета: честная статистика конвейера
const dropCounts = {};
for (const r of buys) if (r._gate.drop) dropCounts[r._gate.drop] = (dropCounts[r._gate.drop] ?? 0) + 1;
const okN = buys.filter(r => r._gate.ok).length;
const backfillState = readJson(join(DATA, 'state', 'backfill.json'), {});
const liveState = readJson(join(DATA, 'state', 'live.json'), {});
const priceState = readJson(join(DATA, 'prices', '_state.json'), {});
W('meta.json', {
  built: new Date().toISOString(), v: 2,
  trades: { total: trades.length, buys: buys.length, otcExcluded: cntOtc, badTicker: cntBadTicker },
  load: loadStats,
  gates: { ok: okN, drops: dropCounts, labels: DROP_LABELS },
  universe: { priced: pricedTickers.size, noPrices: noPriceTickers.size },
  backtest: { rows: backtestRows.length, years },
  feed: { rows: feedRows.length, days: FEED_DAYS },
  clusters: { active: activeClusters.length },
  insiders: { ranked: insiders.length },
  quartersDone: backfillState.done ?? [], liveLastDay: liveState.lastDay ?? null,
  pricesUpdated: priceState.updated ?? null, pricesMissing: Object.keys(priceState.missing ?? {}).length,
  spyLast: spy[spy.length - 1][0], iwm: !!iwm?.length,
});

console.log(`[compute] сделок ${trades.length}, покупок ${buys.length}, прошли гейты ${okN} (${Math.round(okN / Math.max(1, buys.length) * 100)}%)`);
console.log(`[compute] отсев: ${Object.entries(dropCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ') || 'нет'}`);
console.log(`[compute] кластеров активных ${activeClusters.length}, бэктест ${backtestRows.length}, инсайдеров ${insiders.length}, карточек ${tickerFiles}`);
console.log(`[compute] без цен: ${noPriceTickers.size} тикеров; OTC отсечено строк: ${cntOtc}`);
