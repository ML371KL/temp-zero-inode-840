// Календарно-временной портфель — главная метрика экрана «Статистика».
//
// ЗАЧЕМ ЗАМЕНА. Прежняя метрика — среднее избыточной доходности ПО СДЕЛКАМ. Она отвечает
// на вопрос «сколько в среднем принесла одна подача», а не «сколько принёс бы портфель»,
// и три её свойства измерены на наших же данных:
//   · вес по числу подач: имя с восемью формами весит в восемь раз больше одного;
//   · перекрытые 12-месячные окна: наблюдения сильно коррелированы, ошибки нет вовсе;
//   · СМЕЩЕНИЕ ВВЕРХ. На 100 подставных выборках (даты сигналов сохранены, тикеры взяты
//     случайно из той же вселенной той же ликвидности) сырое среднее даёт медиану +5.0%
//     при коридоре 5–95% [+2.7 .. +8.6]. То есть «сигнал» +8% стоит на три пункта выше
//     собственного шумового пола. Винзоризация смещение убирает (+0.5%), но вопрос
//     остаётся прежним — «на сделку», а не «на портфель».
//
// Метрика по Jeng–Metrick–Zeckhauser: на конец месяца берём все бумаги с квалифицирующей
// подачей за последние H месяцев, равный вес ПО ТИКЕРАМ (не по сделкам), держим месяц.
// На тех же подставных выборках она даёт медиану −0.2% при коридоре [−0.9 .. +0.4], а
// |t|>2 не встречается ни разу — то есть не выдумывает значимость там, где её нет.
// Расхождение оценки между половинами выборки: 3.2 п.п. против 15.3 п.п. у сырого среднего.

// ---------- месячная панель ----------
// Дневной ряд [[iso, close, adjclose, volume], ...] -> помесячные закрытие, оборот и
// просадка от 52-недельного максимума на конец месяца.
// Оборот — медианный дневной долларовый за месяц: он же прокси размера компании.
// Просадка нужна для КОНТРОЛЬНЫХ портфелей («все бумаги у максимума», «все просевшие»):
// без них про ценовой набор нельзя сказать, добавляет ли инсайдер что-то сверх моментума.
// Считается по колонке close (скорректирована на сплиты, но НЕ на дивиденды) — ровно так
// же, как признак сделки в compute.drawdownAt, иначе сигнал и контроль мерялись бы разными
// линейками.
//
// Кроме просадки на конец месяца пишем ЛУЧШУЮ и ХУДШУЮ за месяц (ddHi/ddLo). Это не
// украшение: признак сделки меряется на ДАТУ СДЕЛКИ, то есть в произвольный день месяца,
// и контроль «все бумаги у максимума» обязан отбираться тем же правилом — «побывала у
// максимума в этом месяце», а не «стоит у максимума в последний день». Разница не
// косметическая: на конце месяца превышение над контролем получается +6.8%, при
// согласованном измерении — вдвое меньше.
// Моментум 12-1 (доходность за год без последнего месяца) нужен как ФАКТОР. Без него
// любой набор, отбирающий по цене, показывает «альфу», которой нет: набор «у 52-недельного
// максимума» по построению сидит в победителях моментума. Проверено — с фактором альфа
// набора сохраняется, а у широких инсайдерских срезов исчезает.
const YEAR_BARS = 252, MONTH_BARS = 21;
export function monthlyFromDaily(series) {
  const px = {}, dv = {}, dd = {}, ddHi = {}, ddLo = {}, mom = {};
  if (!series?.length) return { px, dv, dd, ddHi, ddLo, mom };
  let cur = '', vols = [];
  const flush = () => { if (cur) dv[cur] = median(vols); };
  // Максимум скользящего окна — монотонной очередью за O(n): перебор 252 баров на каждый
  // бар каждого из 5300 рядов стоил бы миллиарды операций на прогон.
  const dq = [];
  for (let i = 0; i < series.length; i++) {
    const r = series[i];
    const m = r[0].slice(0, 7);
    if (m !== cur) { flush(); cur = m; vols = []; }
    px[m] = r[2];                                    // последний торговый день месяца
    if (r[1] > 0 && r[3] > 0) vols.push(r[1] * r[3]);
    while (dq.length && series[dq[dq.length - 1]][1] <= r[1]) dq.pop();
    dq.push(i);
    while (dq[0] <= i - YEAR_BARS) dq.shift();
    if (i >= 30) {
      const hi = series[dq[0]][1];
      const v = hi > 0 && r[1] > 0 ? Math.round((r[1] / hi - 1) * 1e4) / 1e4 : null;
      dd[m] = v;
      if (v !== null) {
        ddHi[m] = ddHi[m] === undefined ? v : Math.max(ddHi[m], v);
        ddLo[m] = ddLo[m] === undefined ? v : Math.min(ddLo[m], v);
      }
    }
    if (i >= YEAR_BARS) {
      const a = series[i - YEAR_BARS][2], b = series[i - MONTH_BARS][2];
      mom[m] = a > 0 && b > 0 ? Math.round((b / a - 1) * 1e4) / 1e4 : null;
    }
  }
  flush();
  return { px, dv, dd, ddHi, ddLo, mom };
}
function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return Math.round(s[(s.length - 1) >> 1]);
}

export class Panel {
  constructor() {
    this.px = new Map(); this.dv = new Map(); this.dd = new Map();
    this.ddHi = new Map(); this.ddLo = new Map(); this.mom = new Map();
    // ETF-бенчмарки лежат в панели ради месячных доходностей, но во вселенную «все бумаги
    // той же ликвидности» они входить не должны: это не акции, а корзины.
    this.bench = new Set();
    this._months = null;
  }
  add(ticker, monthly, isBench = false) {
    if (!monthly || !Object.keys(monthly.px).length) return;
    this.px.set(ticker, monthly.px);
    this.dv.set(ticker, monthly.dv);
    if (monthly.dd) this.dd.set(ticker, monthly.dd);
    if (monthly.ddHi) this.ddHi.set(ticker, monthly.ddHi);
    if (monthly.ddLo) this.ddLo.set(ticker, monthly.ddLo);
    if (monthly.mom) this.mom.set(ticker, monthly.mom);
    if (isBench) this.bench.add(ticker);
    this._months = null;
  }
  // Тикеры вселенной: всё, кроме бенчмарков
  *names() { for (const t of this.px.keys()) if (!this.bench.has(t)) yield t; }
  get months() {
    if (!this._months) {
      const s = new Set();
      for (const o of this.px.values()) for (const m of Object.keys(o)) s.add(m);
      this._months = [...s].sort();
      this._idx = new Map(this._months.map((m, i) => [m, i]));
    }
    return this._months;
  }
  idx(m) { this.months; return this._idx.get(m); }
  at(i) { return this.months[i]; }
  adv(t, m) { return this.dv.get(t)?.[m] ?? null; }
  drawdown(t, m) { const v = this.dd.get(t)?.[m]; return v === undefined ? null : v; }
  // Побывала ли бумага в этом месяце ближе/дальше указанной просадки. Именно так меряется
  // признак сделки (на дату сделки, то есть в произвольный день месяца).
  wasNearHigh(t, m, th) { const v = this.ddHi.get(t)?.[m]; return v !== undefined && v >= th; }
  wasBelow(t, m, th) { const v = this.ddLo.get(t)?.[m]; return v !== undefined && v < th; }
  // Доходность ЗА месяц m: от закрытия m-1 к закрытию m
  ret(t, m) {
    const i = this.idx(m);
    if (i === undefined || i === 0) return null;
    const o = this.px.get(t);
    if (!o) return null;
    const a = o[this.months[i - 1]], b = o[m];
    return a > 0 && b > 0 ? b / a - 1 : null;
  }
}

// ---------- портфель ----------
// signalsByMonth: Map<'YYYY-MM', Set<ticker>> — в каком месяце по какому тикеру был сигнал.
// Возвращает помесячный ряд { m, n, r } — доходность равновзвешенного портфеля за месяц.
export function portfolioSeries(panel, signalsByMonth, { H = 12, minDv = 3e6, minNames = 5 } = {}) {
  const out = [];
  const months = panel.months;
  for (let i = 0; i < months.length - 1; i++) {
    const mForm = months[i], mHold = months[i + 1];
    const set = new Set();
    for (let k = 0; k < H; k++) {
      const mm = months[i - k];
      if (!mm) break;
      const s = signalsByMonth.get(mm);
      if (s) for (const t of s) set.add(t);
    }
    if (!set.size) continue;
    const rs = [];
    for (const t of set) {
      // Ликвидность проверяется НА МОМЕНТ ФОРМИРОВАНИЯ: иначе портфель набирался бы
      // по знанию о будущем обороте, а заодно тянул бы неторгуемые имена.
      if ((panel.adv(t, mForm) ?? 0) < minDv) continue;
      const r = panel.ret(t, mHold);
      if (r !== null) rs.push(r);
    }
    if (rs.length < minNames) continue;
    out.push({ m: mHold, n: rs.length, r: rs.reduce((a, b) => a + b, 0) / rs.length });
  }
  return out;
}

// Равновзвешенная вселенная той же ликвидности — эталон «а если брать всё подряд».
// pred — необязательный фильтр контекста (t, mForm) => bool: так строится контроль
// «все бумаги у 52-недельного максимума» или «все просевшие глубже 30%».
export function universeSeries(panel, { minDv = 3e6, pred = null, H = 1 } = {}) {
  const out = new Map();
  const months = panel.months;
  const hist = [];   // для H>1: множества квалифицировавшихся в прошлые месяцы
  for (let i = 0; i < months.length - 1; i++) {
    const mForm = months[i], mHold = months[i + 1];
    const cur = new Set();
    for (const t of panel.names()) {
      if ((panel.adv(t, mForm) ?? 0) < minDv) continue;
      if (pred && !pred(t, mForm)) continue;
      cur.add(t);
    }
    hist.push(cur);
    // Контроль должен формироваться так же, как сигнальный портфель: если тот держит
    // бумагу H месяцев, то и «все бумаги в том же контексте» держатся H месяцев, иначе
    // сравниваются портфели разного возраста и разность ничего не значит.
    const hold = new Set();
    for (let k = 0; k < H && i - k >= 0; k++) for (const t of hist[i - k]) hold.add(t);
    const rs = [];
    for (const t of hold) {
      if ((panel.adv(t, mForm) ?? 0) < minDv) continue;
      const r = panel.ret(t, mHold);
      if (r !== null) rs.push(r);
    }
    if (rs.length) out.set(mHold, rs.reduce((a, b) => a + b, 0) / rs.length);
  }
  return out;
}

// Факторы размера и моментума строятся ИЗ ТОЙ ЖЕ вселенной, что и портфели: внешние ETF
// мерили бы другую совокупность. Треть/треть, равный вес, ежемесячная пересборка.
export function factorSeries(panel, { minDv = 3e6 } = {}) {
  const size = new Map(), mom = new Map();
  const months = panel.months;
  for (let i = 0; i < months.length - 1; i++) {
    const mForm = months[i], mHold = months[i + 1];
    const bySize = [], byMom = [];
    for (const t of panel.names()) {
      if ((panel.adv(t, mForm) ?? 0) < minDv) continue;
      const dv = panel.adv(t, mForm), mo = panel.mom.get(t)?.[mForm];
      if (dv > 0) bySize.push([t, dv]);
      if (mo !== undefined && mo !== null) byMom.push([t, mo]);
    }
    const cut = (arr, lowFirst) => {
      arr.sort((a, b) => a[1] - b[1]);
      const k = Math.floor(arr.length / 3);
      if (k < 5) return null;
      const lo = arr.slice(0, k).map(x => x[0]), hi = arr.slice(-k).map(x => x[0]);
      const ew = list => {
        const rs = [];
        for (const t of list) { const r = panel.ret(t, mHold); if (r !== null) rs.push(r); }
        return rs.length >= 5 ? mean(rs) : null;
      };
      const a = ew(lo), b = ew(hi);
      return a === null || b === null ? null : (lowFirst ? a - b : b - a);
    };
    const sz = cut(bySize, true);      // малые минус крупные
    const mm = cut(byMom, false);      // победители минус проигравшие
    if (sz !== null) size.set(mHold, sz);
    if (mm !== null) mom.set(mHold, mm);
  }
  return { size, mom };
}

// Разность двух помесячных рядов по общим месяцам + значимость по Ньюи–Уэсту.
// Это и есть ответ на вопрос «добавляет ли инсайдер что-то сверх самого контекста».
export function pairedDiff(rows, byMonth) {
  const d = [];
  for (const x of rows) { const y = byMonth.get(x.m); if (y !== undefined) d.push(x.r - y); }
  if (d.length < 24) return null;
  const t = neweyWestT(d);
  return { ex: t.mean, t: t.t, months: d.length };
}

// Оборачиваемость портфеля: доля состава, меняющаяся за месяц. Нужна, чтобы издержки
// считались из состава, а не назначались на глаз: у трёхмесячного набора оборот втрое выше.
export function turnover(panel, signalsByMonth, { H = 12, minDv = 3e6 } = {}) {
  const months = panel.months;
  let prev = null, sum = 0, n = 0;
  for (let i = 0; i < months.length - 1; i++) {
    const mForm = months[i];
    const hold = new Set();
    for (let k = 0; k < H; k++) {
      const s = signalsByMonth.get(months[i - k]);
      if (s) for (const t of s) if ((panel.adv(t, mForm) ?? 0) >= minDv) hold.add(t);
    }
    if (!hold.size) { prev = null; continue; }
    if (prev) {
      let ch = 0;
      for (const t of hold) if (!prev.has(t)) ch++;
      for (const t of prev) if (!hold.has(t)) ch++;
      sum += ch / Math.max(hold.size, prev.size); n++;
    }
    prev = hold;
  }
  return n ? sum / n : null;
}

// ---------- статистика ----------
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

// Ньюи–Уэст: месячные доходности автокоррелированы (окно удержания перекрывается),
// и обычная ошибка среднего завысила бы значимость в разы.
export function neweyWestT(x, lag = 3) {
  const n = x.length;
  if (n < 12) return { mean: n ? mean(x) : null, t: null, n };
  const m = mean(x), e = x.map(v => v - m);
  let v = e.reduce((s, q) => s + q * q, 0) / n;
  for (let l = 1; l <= lag; l++) {
    let g = 0;
    for (let i = l; i < n; i++) g += e[i] * e[i - l];
    v += 2 * (1 - l / (lag + 1)) * (g / n);
  }
  const se = Math.sqrt(Math.max(v, 1e-15) / n);
  return { mean: m, t: m / se, n };
}
export const annualize = m => (1 + m) ** 12 - 1;

// Безрисковая ставка (3-мес. векселя, годовая по годам). Без неё CAPM-альфа портфеля с
// бетой 1.3 систематически занижена на rf*(β−1) — а у равновзвешенных малых имён бета
// именно такая. Регрессия ведётся в ИЗБЫТОЧНЫХ доходностях, как положено.
const RF_YEAR = {
  2014: 0.0003, 2015: 0.0005, 2016: 0.003, 2017: 0.0095, 2018: 0.0195, 2019: 0.021,
  2020: 0.0035, 2021: 0.0005, 2022: 0.02, 2023: 0.05, 2024: 0.05, 2025: 0.04, 2026: 0.035,
};
export const rfOf = m => (RF_YEAR[Number(String(m).slice(0, 4))] ?? 0.03) / 12;

// МНК с константой. X — массив колонок-факторов.
function ols(y, X) {
  const n = y.length, k = X.length;
  const A = Array.from({ length: k + 1 }, () => new Array(k + 1).fill(0));
  const B = new Array(k + 1).fill(0);
  const col = j => j === 0 ? new Array(n).fill(1) : X[j - 1];
  for (let a = 0; a <= k; a++) {
    const ca = col(a);
    for (let b = 0; b <= k; b++) { const cb = col(b); let s = 0; for (let i = 0; i < n; i++) s += ca[i] * cb[i]; A[a][b] = s; }
    let s = 0; for (let i = 0; i < n; i++) s += ca[i] * y[i]; B[a] = s;
  }
  for (let c = 0; c <= k; c++) {
    let p = c;
    for (let r = c + 1; r <= k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (!Number.isFinite(A[p][c]) || Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]]; [B[c], B[p]] = [B[p], B[c]];
    for (let r = 0; r <= k; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let q = c; q <= k; q++) A[r][q] -= f * A[c][q];
      B[r] -= f * B[c];
    }
  }
  const b = B.map((v, i) => v / A[i][i]);
  const resid = y.map((v, i) => { let p = b[0]; for (let j = 0; j < k; j++) p += b[j + 1] * X[j][i]; return v - p; });
  return { b, resid };
}

// Альфа к трём факторам: рынок, размер и МОМЕНТУМ. Моментум обязателен: главный рабочий
// набор отбирает бумаги у 52-недельного максимума, то есть по построению сидит в
// победителях моментума, и без этого фактора его «альфа» была бы завышена. Факторы
// приходят помесячными картами: market (SPY), size (мал−круп), mom (победители−проигравшие).
export function factorAlpha(rows, { market, size, mom } = {}) {
  const fs = [market, size, mom].filter(Boolean);
  const s = rows.filter(x => fs.every(f => f.has(x.m)));
  if (s.length < 30) return null;
  const y = s.map(x => x.r - rfOf(x.m));
  const X = fs.map((f, j) => s.map(x => j === 0 ? f.get(x.m) - rfOf(x.m) : f.get(x.m)));
  const o = ols(y, X);
  if (!o) return null;
  const t = neweyWestT(o.resid.map(v => v + o.b[0]));
  return { alpha: t.mean, t: t.t, betas: o.b.slice(1), months: s.length };
}

// Риск и торговые характеристики против индекса: без них «альфа» не отвечает на вопрос,
// стоит ли менять SPY на этот портфель.
export function vsBenchmark(rows, benchByMonth) {
  const s = rows.filter(x => benchByMonth.has(x.m));
  if (s.length < 24) return null;
  const ex = s.map(x => x.r - benchByMonth.get(x.m));
  const t = neweyWestT(ex);
  const m = mean(ex);
  const te = Math.sqrt(12 * mean(ex.map(v => (v - m) ** 2)));
  const r = s.map(x => x.r), mr = mean(r);
  const vol = Math.sqrt(12 * mean(r.map(v => (v - mr) ** 2)));
  const sharpe = vol > 0 ? (mean(s.map(x => x.r - rfOf(x.m))) * 12) / vol : null;
  return { ex: t.mean, t: t.t, ir: te > 0 ? (m * 12) / te : null, sharpe, months: s.length };
}

export function pathStats(rows) {
  const r = rows.map(x => x.r);
  if (!r.length) return { cagr: null, vol: null, dd: null, avgN: null };
  let eq = 1, peak = 1, dd = 0;
  for (const x of r) { eq *= 1 + x; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); }
  const m = mean(r);
  const sd = r.length > 1 ? Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)) : 0;
  return {
    cagr: eq ** (12 / r.length) - 1,
    vol: sd * Math.sqrt(12),
    dd,
    avgN: Math.round(mean(rows.map(x => x.n))),
  };
}
