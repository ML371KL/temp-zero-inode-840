// Движок перебора конфигураций по протоколу docs/ПРОТОКОЛ-ПОИСКА.md.
//
// Считает ровно ту же метрику, что заморожена: календарно-временной портфель,
// равный вес по тикерам, вход в месяц после подачи, превышение над SPY с Ньюи–Уэстом.
// Отличие от compute.mjs одно — окно дат задаётся снаружи, чтобы отрезки
// (видимый-1, видимый-2, запечатанный) считались одной и той же машиной.
//
// Режимы:
//   --mode grid        перебор сетки на указанном окне
//   --mode noise       та же сетка на ПЕРЕМЕШАННЫХ метках — калибровка порога
// Использование: node scripts/search.mjs --data data-search --mode grid --from 2016-01 --to 2026-12
import { readPriceCache } from './lib/prices.mjs';
import { Panel, monthlyFromDaily, portfolioSeries, universeSeries, factorSeries, vsBenchmark, factorAlpha, annualize, turnover } from './lib/portfolio.mjs';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DATA = argVal('--data', 'data-search');
const SITE = argVal('--site', 'site-search');
const MODE = argVal('--mode', 'grid');
const FROM = argVal('--from', '2016-01');
const TO = argVal('--to', '2026-12');
const SEEDS = Number(argVal('--seeds', '200'));
const OUT = argVal('--out', '');
const ROUND_TRIP = 0.005;
const PORT_MIN_DV = 3e6;
const MIN_MONTHS = 24;

// ---------- строки бэктеста ----------
const rows = [];
for (const f of readdirSync(join(SITE, 'data', 'backtest'))) {
  if (!f.endsWith('.json') || f === 'index.json') continue;
  rows.push(...JSON.parse(readFileSync(join(SITE, 'data', 'backtest', f), 'utf8')));
}
const inWindow = r => { const m = r.fdate.slice(0, 7); return m >= FROM && m <= TO; };
const win = rows.filter(inWindow);
console.log(`[search] строк всего ${rows.length}, в окне ${FROM}..${TO}: ${win.length}`);

// ---------- панель ----------
const tickers = new Set(win.map(r => r.t));
const panel = new Panel();
for (const b of ['SPY', 'IWM']) {
  const s = readPriceCache(DATA, b);
  if (s?.length) panel.add(b, monthlyFromDaily(s), true);
}
let built = 0;
for (const t of tickers) {
  const s = readPriceCache(DATA, t);
  if (s?.length) { panel.add(t, monthlyFromDaily(s)); built++; }
}
console.log(`[search] панель: ${built} бумаг из ${tickers.size}`);
const spyRet = new Map();
{
  const s = readPriceCache(DATA, 'SPY');
  const m = monthlyFromDaily(s);
  const ms = Object.keys(m.px).sort();
  for (let i = 1; i < ms.length; i++) {
    const a = m.px[ms[i - 1]], b = m.px[ms[i]];
    if (a > 0 && b > 0) spyRet.set(ms[i], b / a - 1);
  }
}
const FACT = factorSeries(panel, { minDv: PORT_MIN_DV });
const FMODEL = { market: spyRet, size: FACT.size, mom: FACT.mom };

// Контроль «сопоставимые бумаги»: равновзвешенная вселенная той же ликвидности.
// Литература по инсайдерской торговле (Lakonishok–Lee, Jeng–Metrick–Zeckhauser,
// Cohen–Malloy–Pomorski) меряет эффект именно против него, а не против индекса:
// сам пул структурно проигрывает S&P 500 (~10% против ~14% годовых), и сравнение
// с индексом требует от сигнала сначала отыграть 3–5 п.п. гандикапа.
const UNI = new Map();
for (const dv of [3e6, 1e7, 3e7]) UNI.set(dv, universeSeries(panel, { minDv: dv }));

// ---------- сетка ----------
// Признаки только те, что известны на дату сделки. Режим рынка и календарные годы
// исключены протоколом: годовую разбивку на 2006–2015 мы уже видели.
const G = {
  dd: [null, -0.02, -0.05, -0.07, -0.10, -0.20, -0.35],   // близость к 52-нед максимуму
  val: [1e4, 5e4, 1e5, 2.5e5, 1e6],                        // сумма сделки
  dv: [3e6, 1e7, 3e7],                                     // оборот бумаги
  role: [null, 'FO', 'FOC', 'D'],                          // роль подателя
  dOwn: [null, 0.05, 0.20],                                // прирост позиции
  cl: [null, 2, 3],                                        // независимых покупателей
  hold: [3, 6, 12],                                        // срок удержания
};
const roleOk = (r, spec) => spec === null ? true
  : spec === 'FO' ? (r.role === 'F' || r.role === 'O')
  : spec === 'FOC' ? (r.role === 'F' || r.role === 'O' || r.role === 'C')
  : r.role === spec;

const configs = [];
for (const dd of G.dd) for (const val of G.val) for (const dv of G.dv)
  for (const role of G.role) for (const dOwn of G.dOwn) for (const cl of G.cl) for (const hold of G.hold)
    configs.push({ dd, val, dv, role, dOwn, cl, hold });
console.log(`[search] конфигураций в сетке: ${configs.length}`);

const passes = (r, c) =>
  r.gate === 'ok'
  && (c.dd === null || (r.dd !== null && r.dd >= c.dd))
  && r.val >= c.val
  && roleOk(r, c.role)
  && (c.dOwn === null || (r.dOwn !== null && r.dOwn >= c.dOwn && r.dOwn < 9))
  && (c.cl === null || (r.cl ?? 1) >= c.cl);

function evaluateBy(byM, hold, minDv, signals) {
  const ser = portfolioSeries(panel, byM, { H: hold, minDv }).filter(x => x.m >= FROM && x.m <= TO);
  if (ser.length < MIN_MONTHS) return null;
  const v = vsBenchmark(ser, spyRet);
  if (!v) return null;
  const a = factorAlpha(ser, FMODEL);
  const avgN = ser.reduce((s, x) => s + x.n, 0) / ser.length;
  const medN = [...ser.map(x => x.n)].sort((x, y) => x - y)[ser.length >> 1];
  const to = turnover(panel, byM, { H: hold, minDv });
  const cost = to === null ? null : (to / 2) * 12 * ROUND_TRIP;
  const ex = annualize(v.ex);
  // Превышение над сопоставимыми бумагами — метрика литературы
  const uni = UNI.get(minDv);
  const u = uni ? vsBenchmark(ser, uni) : null;
  return {
    ex, t: v.t, ir: v.ir, sharpe: v.sharpe, mo: ser.length, avgN, medN,
    a: a ? annualize(a.alpha) : null, at: a?.t ?? null,
    ux: u ? annualize(u.ex) : null, ut: u?.t ?? null,
    net: cost === null ? null : ex - cost, signals,
  };
}

// ---------- прогон ----------
// Подмножество строк зависит только от пяти признаков; оборот и срок удержания
// применяются уже внутри портфеля. Поэтому фильтруем 1260 раз, а не 11340 —
// без этого калибровка шума на сотнях прогонов считалась бы часами.
const SUBSETS = [];
for (const dd of G.dd) for (const val of G.val) for (const role of G.role)
  for (const dOwn of G.dOwn) for (const cl of G.cl) SUBSETS.push({ dd, val, role, dOwn, cl });

function runGrid(rowsUsed) {
  const out = [];
  for (const s of SUBSETS) {
    const subset = rowsUsed.filter(r => passes(r, s));
    if (subset.length < 200) continue;
    // месяцы сигналов считаем один раз на подмножество
    const byM = new Map();
    for (const r of subset) {
      const m = r.fdate.slice(0, 7);
      (byM.get(m) ?? byM.set(m, new Set()).get(m)).add(r.t);
    }
    for (const dv of G.dv) for (const hold of G.hold) {
      const m = evaluateBy(byM, hold, dv, subset.length);
      if (m) out.push({ ...s, dv, hold, ...m });
    }
  }
  return out;
}

if (MODE === 'grid') {
  const res = runGrid(win);
  res.sort((a, b) => b.t - a.t);
  console.log(`[search] посчитано конфигураций: ${res.length}`);
  console.log(`[search] максимум t = ${res[0]?.t?.toFixed(2)}, превышение ${(res[0]?.ex * 100).toFixed(1)}%`);
  if (OUT) { writeFileSync(OUT, JSON.stringify(res)); console.log(`[search] записано в ${OUT}`); }
} else if (MODE === 'noise') {
  // Перемешивание: даты подач остаются на месте, а бумага у сделки заменяется случайной
  // из того же месяца. Так рушится связь «этот инсайдер — эта бумага», но сохраняются
  // календарь, размер выборки и состав вселенной.
  const byMonth = new Map();
  for (const r of win) (byMonth.get(r.fdate.slice(0, 7)) ?? byMonth.set(r.fdate.slice(0, 7), []).get(r.fdate.slice(0, 7))).push(r.t);
  const maxT = [];
  let seed = 20260816;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let s = 0; s < SEEDS; s++) {
    const shuffled = win.map(r => {
      const pool = byMonth.get(r.fdate.slice(0, 7));
      return { ...r, t: pool[Math.floor(rnd() * pool.length)] };
    });
    const res = runGrid(shuffled);
    // ВАЖНО: калибруем по ЗНАКОВОМУ максимуму, а не по модулю. Перемешанные портфели —
    // это случайные корзины вселенной, а вселенная структурно проигрывает индексу
    // (равновзвешенный пул ADV≥$3 млн: ~10% годовых против ~14% у S&P 500). Поэтому
    // max|t| измеряет глубину ОТСТАВАНИЯ, а не высоту шума, и завышает порог.
    // Ищем мы превышение, значит и порог нужен по положительному хвосту.
    const mx = res.reduce((m, x) => Math.max(m, x.t), -Infinity);
    const mxAbs = res.reduce((m, x) => Math.max(m, Math.abs(x.t)), 0);
    const mxA = res.reduce((m, x) => Math.max(m, x.at ?? -Infinity), -Infinity);
    const mxU = res.reduce((m, x) => Math.max(m, x.ut ?? -Infinity), -Infinity);
    maxT.push({ t: mx, abs: mxAbs, at: mxA, ut: mxU });
    if ((s + 1) % 5 === 0) console.log(`  прогон ${s + 1}/${SEEDS}: SPY ${mx.toFixed(2)} | альфа ${mxA.toFixed(2)} | контроль ${mxU.toFixed(2)}`);
  }
  const q = (arr, p) => { const s2 = [...arr].sort((a, b) => a - b); return s2[Math.min(s2.length - 1, Math.floor(p * s2.length))]; };
  const cols = {
    'превышение над SPY (знаковое)': maxT.map(x => x.t),
    'превышение по модулю': maxT.map(x => x.abs),
    'альфа к 3 факторам': maxT.map(x => x.at),
    'сверх сопоставимых бумаг': maxT.map(x => x.ut),
  };
  console.log(`\n[search] КАЛИБРОВКА ШУМА на ${SEEDS} прогонах, сетка ${configs.length} конфигураций:`);
  for (const [name, arr] of Object.entries(cols))
    console.log(`  ${name.padEnd(30)} медиана ${q(arr, 0.5).toFixed(2)}  90-й ${q(arr, 0.9).toFixed(2)}  95-й ${q(arr, 0.95).toFixed(2)}  99-й ${q(arr, 0.99).toFixed(2)}`);
  if (OUT) writeFileSync(OUT, JSON.stringify({ seeds: SEEDS, configs: configs.length, maxT }));
}
