// Вычислительное ядро: вселенная -> кластеры -> скоринг -> форвардные доходности vs SPY
// -> payload для фронтенда (site/data). Чистая функция от data/: без сети.
// Использование: node scripts/compute.mjs [--data data] [--site site]
import { readJson, writeJson, isoToday, addDaysIso } from './lib/util.mjs';
import { readPriceCache } from './lib/prices.mjs';
import { loadAllTrades, loadTickerRef, resolveTicker, issuerCategory, plausibleTicker } from './lib/universe.mjs';
import { scoreBuy, topRole, dOwnOf } from './lib/scoring.mjs';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const DATA = argVal('--data', 'data');
const SITE = argVal('--site', 'site');

const today = isoToday();
const HORIZONS = { 3: 63, 6: 126, 12: 252, 24: 504 }; // месяцы -> торговые дни
const CLUSTER_GAP_DAYS = 30;   // максимальный разрыв между покупками одной цепочки
const ACTIVE_WINDOW_DAYS = 90; // кластер «активен», если последняя покупка свежее
const FEED_DAYS = 200;         // глубина живой ленты
const STALE_PRICE_DAYS = 14;   // ряд старше — считаем тикер мёртвым (делистинг)

// ---------- Загрузка ----------
const ref = loadTickerRef(DATA);
if (!ref.size) throw new Error('reference/tickers.json пуст — сначала запустите prices.mjs');
const tradesAll = loadAllTrades(DATA);
if (!tradesAll.length) throw new Error('нет сделок — сначала backfill/live');

const spy = readPriceCache(DATA, 'SPY');
if (!spy || spy.length < 500) throw new Error('нет ряда SPY — бенчмарк обязателен, compute остановлен');

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

// Цены: грузим лениво по требованию
const priceMap = new Map();
function series(t) {
  if (!priceMap.has(t)) priceMap.set(t, readPriceCache(DATA, t));
  return priceMap.get(t);
}
function datesOf(s) {
  if (!s._dates) Object.defineProperty(s, '_dates', { value: s.map(r => r[0]), enumerable: false });
  return s._dates;
}
function idxFirstAfter(s, iso) { // первый торговый день ПОСЛЕ даты (вход по подаче формы)
  const d = datesOf(s);
  let lo = 0, hi = d.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (d[m] <= iso) lo = m + 1; else hi = m; }
  return lo < d.length ? lo : -1;
}
function idxAtOrBefore(s, iso) {
  const d = datesOf(s);
  let lo = 0, hi = d.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (d[m] <= iso) lo = m + 1; else hi = m; }
  return lo - 1;
}
const rnd = (v, k = 4) => Math.round(v * 10 ** k) / 10 ** k;

// Просадка от 52-недельного максимума (по adjclose) на момент даты
function drawdownAt(s, iso) {
  const i = idxAtOrBefore(s, iso);
  if (i < 30) return null;
  const from = addDaysIso(iso, -365);
  let hi = 0;
  for (let k = i; k >= 0 && s[k][0] >= from; k--) hi = Math.max(hi, s[k][2]);
  return hi > 0 ? rnd(s[i][2] / hi - 1) : null;
}

// ---------- Группировка по тикерам, кластеры ----------
const byTicker = new Map();
for (const r of trades) (byTicker.get(r.T) ?? byTicker.set(r.T, []).get(r.T)).push(r);

// Кластеры: цепочки покупок P с разрывом <= 30 дней, >= 2 различных инсайдеров
const clustersByTicker = new Map();
for (const [t, rows] of byTicker) {
  const buys = rows.filter(r => r.code === 'P').sort((a, b) => a.tdate < b.tdate ? -1 : 1);
  const chains = [];
  let chain = [];
  for (const b of buys) {
    if (chain.length && addDaysIso(chain[chain.length - 1].tdate, CLUSTER_GAP_DAYS) < b.tdate) {
      chains.push(chain); chain = [];
    }
    chain.push(b);
  }
  if (chain.length) chains.push(chain);
  const clusters = [];
  for (const c of chains) {
    const owners = new Set(c.flatMap(r => r.owners.map(o => o.cik)));
    if (owners.size >= 2) clusters.push({ rows: c, nOwners: owners.size });
  }
  clustersByTicker.set(t, clusters);
}
function clusterOf(row) {
  for (const c of clustersByTicker.get(row.T) ?? [])
    if (c.rows.includes(row)) return c;
  return null;
}

// ---------- Форвардные доходности ----------
function forward(row, s) {
  const out = {};
  const e = idxFirstAfter(s, row.fdate);
  if (e < 0) { for (const m of Object.keys(HORIZONS)) out['s' + m] = 'o'; return out; }
  const lastIso = s[s.length - 1][0];
  const dead = lastIso < addDaysIso(today, -STALE_PRICE_DAYS);
  const entryAdj = s[e][2];
  const spyE = idxAtOrBefore(spy, s[e][0]);
  for (const [m, days] of Object.entries(HORIZONS)) {
    const x = e + days;
    let exitIdx = null, status = 'c';
    if (x < s.length) exitIdx = x;
    else if (dead) { exitIdx = s.length - 1; status = 'd'; } // делистинг: закрываем последней ценой
    else { out['s' + m] = 'o'; continue; }                    // окно ещё не дозрело
    const ret = s[exitIdx][2] / entryAdj - 1;
    const spyX = idxAtOrBefore(spy, s[exitIdx][0]);
    const spyRet = spyE >= 0 && spyX > spyE ? spy[spyX][2] / spy[spyE][2] - 1 : 0;
    out['r' + m] = rnd(ret);
    out['e' + m] = rnd(ret - spyRet);
    out['s' + m] = status;
  }
  return out;
}

// ---------- Основной проход по покупкам ----------
const buys = trades.filter(r => r.code === 'P');
const backtestRows = [];   // все покупки с форвардами (для stats + годовых файлов)
const feedRows = [];       // лента за FEED_DAYS
const feedCut = addDaysIso(today, -FEED_DAYS);
let noPriceTickers = new Set(), pricedTickers = new Set();

for (const r of buys) {
  const s = series(r.T);
  const hasPrices = !!(s && s.length > 100);
  if (hasPrices) pricedTickers.add(r.T); else noPriceTickers.add(r.T);
  // Эмитенты вне текущего справочника без ценовых данных не попадают в бэктест
  // (их нельзя ни посчитать, ни отследить) — но считаются в meta для честности.
  const cl = clusterOf(r);
  const clusterSize = cl ? cl.nOwners : 1;
  const role = topRole(r.owners.map(o => o.rel));
  const dOwn = dOwnOf(r);
  const dd = hasPrices ? drawdownAt(s, r.tdate) : null;
  const totalVal = cl ? cl.rows.reduce((a, b) => a + b.val, 0) : r.val;
  const allB5 = cl ? cl.rows.every(x => x.b5) : !!r.b5;
  const sc = scoreBuy({ clusterSize, role, totalVal, dOwn, dd, allB5 });
  const fw = hasPrices ? forward(r, s) : null;

  if (hasPrices) {
    backtestRows.push({
      t: r.T, fdate: r.fdate, tdate: r.tdate, val: r.val, role,
      cl: clusterSize, b5: r.b5, dd, dOwn, score: sc.total, cat: r.cat, ...fw,
    });
  }
  if (r.fdate >= feedCut) {
    let cur = null, curD = null, chg = null;
    if (hasPrices) {
      cur = s[s.length - 1][1]; curD = s[s.length - 1][0];
      const e = idxFirstAfter(s, r.fdate);
      if (e >= 0) chg = rnd(s[s.length - 1][2] / s[e][2] - 1);
    }
    feedRows.push({
      t: r.T, name: ref.get(r.cik)?.name ?? r.t, fdate: r.fdate, tdate: r.tdate, form: r.form,
      who: r.owners.map(o => o.name).join('; '), role, title: r.owners[0]?.title || '',
      sh: r.sh, px: r.px, val: r.val, own: r.own, dOwn, di: r.di, b5: r.b5,
      cl: clusterSize, dd, score: sc.total, parts: sc.parts, cur, curD, chg, cat: r.cat,
    });
  }
}
feedRows.sort((a, b) => b.fdate < a.fdate ? -1 : b.fdate > a.fdate ? 1 : b.score - a.score);

// ---------- Активные кластеры (скринер) ----------
const activeCut = addDaysIso(today, -ACTIVE_WINDOW_DAYS);
const activeClusters = [];
for (const [t, clusters] of clustersByTicker) {
  for (const c of clusters) {
    const last = c.rows[c.rows.length - 1];
    if (last.tdate < activeCut) continue;
    const s = series(t);
    const totalVal = c.rows.reduce((a, b) => a + b.val, 0);
    const totalSh = c.rows.reduce((a, b) => a + b.sh, 0);
    const vwap = totalSh > 0 ? rnd(totalVal / totalSh, 2) : null;
    const role = topRole(c.rows.flatMap(r => r.owners.map(o => o.rel)));
    const dOwnMax = Math.max(...c.rows.map(r => dOwnOf(r) ?? -1));
    const dd = s ? drawdownAt(s, last.tdate) : null;
    const allB5 = c.rows.every(x => x.b5);
    const sc = scoreBuy({ clusterSize: c.nOwners, role, totalVal, dOwn: dOwnMax < 0 ? null : dOwnMax, dd, allB5 });
    const ownersMap = new Map();
    for (const r of c.rows) for (const o of r.owners)
      if (!ownersMap.has(o.cik)) ownersMap.set(o.cik, { name: o.name, rel: o.rel, title: o.title });
    let cur = null, chg = null;
    if (s?.length) {
      cur = s[s.length - 1][1];
      const e = idxFirstAfter(s, c.rows[0].fdate);
      if (e >= 0) chg = rnd(s[s.length - 1][2] / s[e][2] - 1);
    }
    activeClusters.push({
      t, name: ref.get(c.rows[0].cik)?.name ?? c.rows[0].t,
      n: c.nOwners, buyers: [...ownersMap.values()],
      first: c.rows[0].tdate, last: last.tdate, nTrades: c.rows.length,
      totalVal: Math.round(totalVal), vwap, dd, b5: allB5 ? 1 : 0,
      score: sc.total, parts: sc.parts, cur, chg,
    });
  }
}
activeClusters.sort((a, b) => b.score - a.score || b.totalVal - a.totalVal);

// ---------- Агрегаты бэктеста ----------
function bucketSize(v) { return v >= 1e6 ? '1M+' : v >= 2.5e5 ? '250k-1M' : v >= 5e4 ? '50-250k' : '<50k'; }
function bucketDd(d) { return d === null ? 'н/д' : d <= -0.30 ? '>30%' : d <= -0.15 ? '15-30%' : '<15%'; }
function bucketCl(n) { return n >= 3 ? '3+' : n === 2 ? '2' : '1'; }
const DIMS = {
  all: () => 'все',
  cluster: r => bucketCl(r.cl),
  role: r => r.role,
  size: r => bucketSize(r.val),
  b5: r => r.b5 ? '10b5-1' : 'дискреционная',
  dd: r => bucketDd(r.dd),
  year: r => r.fdate.slice(0, 4),
  score: r => r.score >= 70 ? '70+' : r.score >= 50 ? '50-69' : r.score >= 30 ? '30-49' : '<30',
};
function aggregate(rows) {
  const out = {};
  for (const [dim, fn] of Object.entries(DIMS)) {
    const groups = new Map();
    for (const r of rows) {
      const g = fn(r);
      (groups.get(g) ?? groups.set(g, []).get(g)).push(r);
    }
    out[dim] = {};
    for (const [g, rs] of [...groups.entries()].sort()) {
      const cell = {};
      for (const m of Object.keys(HORIZONS)) {
        const done = rs.filter(x => x['s' + m] === 'c');
        const dead = rs.filter(x => x['s' + m] === 'd');
        const excs = done.map(x => x['e' + m]).sort((a, b) => a - b);
        const withDead = excs.concat(dead.map(x => x['e' + m])).sort((a, b) => a - b);
        const med = a => a.length ? a[(a.length - 1) >> 1] : null;
        cell['h' + m] = {
          n: done.length, nd: dead.length,
          med: med(excs) !== null ? rnd(med(excs)) : null,
          mean: excs.length ? rnd(excs.reduce((a, b) => a + b, 0) / excs.length) : null,
          pos: excs.length ? rnd(excs.filter(x => x > 0).length / excs.length) : null,
          medD: med(withDead) !== null ? rnd(med(withDead)) : null, // медиана с учётом делистнутых
        };
      }
      cell.total = rs.length;
      out[dim][g] = cell;
    }
  }
  return out;
}

// ---------- Запись payload ----------
const dataOut = join(SITE, 'data');
mkdirSync(dataOut, { recursive: true });
const W = (p, obj) => writeJson(join(dataOut, p), obj);

W('feed.json', feedRows);
W('clusters.json', activeClusters);
W('stats.json', {
  built: today,
  horizons: Object.keys(HORIZONS).map(Number),
  agg: aggregate(backtestRows),
  n: backtestRows.length,
});
const years = [...new Set(backtestRows.map(r => r.fdate.slice(0, 4)))].sort();
mkdirSync(join(dataOut, 'backtest'), { recursive: true });
for (const y of years)
  W(join('backtest', y + '.json'), backtestRows.filter(r => r.fdate.slice(0, 4) === y));
W('backtest/index.json', { years });

// Карточки тикеров: сделки + недельный ряд (номинальный close) + дневной хвост
mkdirSync(join(dataOut, 'tickers'), { recursive: true });
let tickerFiles = 0;
for (const [t, rows] of byTicker) {
  if (!rows.some(r => r.code === 'P')) continue; // карточка только там, где есть покупки
  const s = series(t);
  let weekly = [], daily = [];
  if (s) {
    let lastWeek = '';
    for (const [iso, close] of s) {
      if (iso < '2015-07-01') continue;
      const wk = isoWeek(iso);
      if (wk === lastWeek) weekly[weekly.length - 1] = [iso, close];
      else { weekly.push([iso, close]); lastWeek = wk; }
    }
    const dcut = addDaysIso(today, -380);
    daily = s.filter(r => r[0] >= dcut).map(r => [r[0], r[1]]);
  }
  const cik0 = rows[0].cik;
  W(join('tickers', t.replace(/[^A-Za-z0-9.-]/g, '_') + '.json'), {
    t, name: ref.get(cik0)?.name ?? rows[0].t, exchange: ref.get(cik0)?.exchange ?? null,
    cat: rows[0].cat, asOf: s?.length ? s[s.length - 1][0] : null,
    trades: rows.map(r => ({
      fdate: r.fdate, tdate: r.tdate, form: r.form, code: r.code,
      who: r.owners.map(o => o.name).join('; '), role: topRole(r.owners.map(o => o.rel)),
      title: r.owners[0]?.title || '', sh: r.sh, px: r.px, val: r.val,
      own: r.own, dOwn: dOwnOf(r), di: r.di, b5: r.b5, cl: r.code === 'P' ? (clusterOf(r)?.nOwners ?? 1) : null,
    })).sort((a, b) => a.tdate < b.tdate ? 1 : -1),
    weekly, daily,
  });
  tickerFiles++;
}
function isoWeek(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const y = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const week = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${y}-${week}`;
}

// Список тикеров для поиска на фронтенде
W('tickers-index.json', [...byTicker.entries()]
  .filter(([, rows]) => rows.some(r => r.code === 'P'))
  .map(([t, rows]) => ({ t, name: ref.get(rows[0].cik)?.name ?? rows[0].t }))
  .sort((a, b) => a.t < b.t ? -1 : 1));

const backfillState = readJson(join(DATA, 'state', 'backfill.json'), {});
const liveState = readJson(join(DATA, 'state', 'live.json'), {});
const priceState = readJson(join(DATA, 'prices', '_state.json'), {});
W('meta.json', {
  built: new Date().toISOString(),
  trades: { total: trades.length, buys: buys.length, otcExcluded: cntOtc, badTicker: cntBadTicker },
  universe: { priced: pricedTickers.size, noPrices: noPriceTickers.size },
  backtest: { rows: backtestRows.length, years },
  feed: { rows: feedRows.length, days: FEED_DAYS },
  clusters: { active: activeClusters.length },
  quartersDone: backfillState.done ?? [], liveLastDay: liveState.lastDay ?? null,
  pricesUpdated: priceState.updated ?? null, pricesMissing: Object.keys(priceState.missing ?? {}).length,
  spyLast: spy[spy.length - 1][0],
});

console.log(`[compute] сделок ${trades.length} (покупок ${buys.length}), бэктест ${backtestRows.length}, лента ${feedRows.length}, кластеров активных ${activeClusters.length}, карточек ${tickerFiles}`);
console.log(`[compute] без цен: ${noPriceTickers.size} тикеров; OTC отсечено строк: ${cntOtc}`);
