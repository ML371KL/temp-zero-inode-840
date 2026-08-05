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
// Дневной ряд [[iso, close, adjclose, volume], ...] -> помесячные закрытие и оборот.
// Оборот — медианный дневной долларовый за месяц: он же прокси размера компании.
export function monthlyFromDaily(series) {
  const px = {}, dv = {};
  if (!series?.length) return { px, dv };
  let cur = '', vols = [];
  const flush = () => { if (cur) dv[cur] = median(vols); };
  for (const r of series) {
    const m = r[0].slice(0, 7);
    if (m !== cur) { flush(); cur = m; vols = []; }
    px[m] = r[2];                                    // последний торговый день месяца
    if (r[1] > 0 && r[3] > 0) vols.push(r[1] * r[3]);
  }
  flush();
  return { px, dv };
}
function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return Math.round(s[(s.length - 1) >> 1]);
}

export class Panel {
  constructor() { this.px = new Map(); this.dv = new Map(); this._months = null; }
  add(ticker, monthly) {
    if (!monthly || !Object.keys(monthly.px).length) return;
    this.px.set(ticker, monthly.px);
    this.dv.set(ticker, monthly.dv);
    this._months = null;
  }
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
export function universeSeries(panel, { minDv = 3e6 } = {}) {
  const out = new Map();
  const months = panel.months;
  for (let i = 0; i < months.length - 1; i++) {
    const mForm = months[i], mHold = months[i + 1];
    const rs = [];
    for (const t of panel.px.keys()) {
      if ((panel.adv(t, mForm) ?? 0) < minDv) continue;
      const r = panel.ret(t, mHold);
      if (r !== null) rs.push(r);
    }
    if (rs.length) out.set(mHold, rs.reduce((a, b) => a + b, 0) / rs.length);
  }
  return out;
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

// Альфа к двум факторам: рынок (SPY) и наклон размера (IWM − SPY). Без второго фактора
// микрокапный портфель показывал бы «альфу» там, где это просто малая капитализация.
export function twoFactorAlpha(rows, spyByMonth, iwmByMonth) {
  const s = rows.filter(x => spyByMonth.has(x.m) && iwmByMonth.has(x.m));
  if (s.length < 24) return null;
  const y = s.map(x => x.r), mk = s.map(x => spyByMonth.get(x.m)), sz = s.map((x, i) => iwmByMonth.get(x.m) - mk[i]);
  const S = (a, b) => a.reduce((p, v, i) => p + v * b[i], 0);
  const my = mean(y), mm = mean(mk), ms = mean(sz);
  const cy = y.map(v => v - my), cm = mk.map(v => v - mm), cs = sz.map(v => v - ms);
  const a11 = S(cm, cm), a12 = S(cm, cs), a22 = S(cs, cs), b1 = S(cm, cy), b2 = S(cs, cy);
  const det = a11 * a22 - a12 * a12;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
  const beta = (b1 * a22 - b2 * a12) / det, size = (a11 * b2 - a12 * b1) / det;
  const resid = y.map((v, i) => v - beta * mk[i] - size * sz[i]);
  const t = neweyWestT(resid);
  return { alpha: t.mean, t: t.t, beta, size, months: s.length };
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
