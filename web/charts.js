// График цены с отметками сделок инсайдеров. Canvas 2D, без зависимостей.
// Один ряд (цена закрытия) + маркеры: ▲ покупка, ▼ продажа (форма + цвет — двойное кодирование).

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Имена инсайдеров приходят из подаваемых в EDGAR форм — это неподконтрольный нам текст,
// который попадает в разметку тултипа. Экранируем на месте вставки.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class PriceChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    canvas.parentElement.appendChild(this.tip);
    this.data = null;
    canvas.addEventListener('mousemove', e => this.onMove(e));
    canvas.addEventListener('mouseleave', () => { this.tip.style.display = 'none'; this.hoverX = null; this.draw(); });
    new ResizeObserver(() => this.draw()).observe(canvas.parentElement);
  }

  // series: [[iso, close]], markers: [{d, px, code, who, sh, val}]
  set(series, markers) {
    this.data = { series, markers };
    this.hoverX = null;
    this.draw();
  }

  layout() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.parentElement.clientWidth;
    const h = 360;
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h, padL: 56, padR: 14, padT: 14, padB: 26 };
  }

  draw() {
    // Экземпляр графика переиспользуется между тикерами: при переходе на бумагу без цен
    // холст надо очистить, иначе на экране останется график предыдущей компании
    if (!this.data?.series?.length) {
      const { w, h } = this.layout();
      this.ctx.clearRect(0, 0, w, h);
      return;
    }
    const { series, markers } = this.data;
    const { w, h, padL, padR, padT, padB } = this.layout();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    const iw = w - padL - padR, ih = h - padT - padB;

    const xs = series.map(r => Date.parse(r[0]));
    const ys = series.map(r => r[1]);
    const x0 = xs[0], x1 = xs[xs.length - 1];
    let yMin = Math.min(...ys, ...markers.filter(m => m.px > 0).map(m => m.px));
    let yMax = Math.max(...ys, ...markers.filter(m => m.px > 0).map(m => m.px));
    const yPad = (yMax - yMin) * 0.08 || yMax * 0.05 || 1;
    yMin = Math.max(0, yMin - yPad); yMax += yPad;
    const X = t => padL + (t - x0) / (x1 - x0 || 1) * iw;
    const Y = v => padT + (1 - (v - yMin) / (yMax - yMin || 1)) * ih;
    this.X = X; this.Y = Y; this.xs = xs; this.ys = ys;
    this.geom = { padL, padR, padT, padB, w, h };

    // Сетка и оси — рецессивные
    ctx.strokeStyle = cssVar('--grid'); ctx.lineWidth = 1;
    ctx.fillStyle = cssVar('--ink-3'); ctx.font = '11px system-ui, sans-serif';
    const ticks = niceTicks(yMin, yMax, 5);
    for (const v of ticks) {
      const y = Y(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtPrice(v), padL - 7, y);
    }
    // Метки времени: годы или месяцы в зависимости от диапазона
    const spanDays = (x1 - x0) / 86400000;
    const dateTicks = timeTicks(x0, x1, spanDays);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const [t, label] of dateTicks) {
      const x = X(t);
      if (x < padL - 2 || x > w - padR + 2) continue;
      ctx.fillText(label, x, h - padB + 7);
    }

    // Линия цены
    ctx.strokeStyle = cssVar('--c-line'); ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < xs.length; i++) {
      const x = X(xs[i]), y = Y(ys[i]);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();

    // Маркеры сделок (с кольцом цвета поверхности — разделитель при наложении).
    // Отсеянные конвейером покупки рисуются полыми: видно, что сделка была, но сигналом не считается.
    const surface = cssVar('--surface');
    for (const m of markers) {
      const t = Date.parse(m.d);
      if (t < x0 || t > x1) continue;
      const x = X(t);
      const y = m.px > 0 ? Y(m.px) : Y(nearestY(xs, ys, t));
      const color = m.code === 'P' ? cssVar('--c-buy') : cssVar('--c-sell');
      triangle(ctx, x, y, 6.5, m.code === 'P', color, surface, !!m.drop);
    }

    // Ховер-перекрестие
    if (this.hoverX !== null) {
      const i = nearestIdx(xs, this.hoverX);
      const x = X(xs[i]);
      ctx.strokeStyle = cssVar('--ink-3'); ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cssVar('--c-line');
      ctx.beginPath(); ctx.arc(x, Y(ys[i]), 3.5, 0, 7); ctx.fill();
    }
  }

  onMove(e) {
    if (!this.data?.series?.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const t = this.xs[0] + (mx - this.geom.padL) / (this.geom.w - this.geom.padL - this.geom.padR) * (this.xs[this.xs.length - 1] - this.xs[0]);
    this.hoverX = t;
    this.draw();
    const i = nearestIdx(this.xs, t);
    const iso = this.data.series[i][0];
    // Маркеры в радиусе 10px по X от курсора
    const near = this.data.markers.filter(m => Math.abs(this.X(Date.parse(m.d)) - mx) < 10);
    let html = `<b>${esc(iso)}</b> · ${fmtPrice(this.ys[i])}`;
    for (const m of near.slice(0, 4)) {
      const cls = m.code === 'P' ? 'pos' : 'neg';
      html += `<br><span class="${cls}">${m.code === 'P' ? '▲ покупка' : '▼ продажа'}</span> ${esc(m.d)} · ${fmtInt(m.sh)} акц. @ ${fmtPrice(m.pxRaw ?? m.px)} · ${esc(m.who)}` +
        (m.drop ? ' <i>(отсеяна фильтрами)</i>' : '');
    }
    this.tip.innerHTML = html;
    this.tip.style.display = 'block';
    const tw = this.tip.offsetWidth;
    this.tip.style.left = Math.min(mx + 14, this.geom.w - tw - 6) + 'px';
    this.tip.style.top = Math.max(4, my - 40) + 'px';
  }
}

function triangle(ctx, x, y, r, up, color, ring, hollow) {
  ctx.beginPath();
  if (up) { ctx.moveTo(x, y - r); ctx.lineTo(x - r, y + r * 0.85); ctx.lineTo(x + r, y + r * 0.85); }
  else { ctx.moveTo(x, y + r); ctx.lineTo(x - r, y - r * 0.85); ctx.lineTo(x + r, y - r * 0.85); }
  ctx.closePath();
  if (hollow) {
    ctx.fillStyle = ring; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  } else {
    ctx.fillStyle = color; ctx.strokeStyle = ring; ctx.lineWidth = 2;
    ctx.stroke(); ctx.fill();
  }
}

function nearestIdx(xs, t) {
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; xs[m] < t ? lo = m : hi = m; }
  return t - xs[lo] < xs[hi] - t ? lo : hi;
}
function nearestY(xs, ys, t) { return ys[nearestIdx(xs, t)]; }

function niceTicks(min, max, n) {
  const span = max - min || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => span / s <= n + 1) ?? mag * 10;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

const MONTH_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function timeTicks(x0, x1, spanDays) {
  const out = [];
  const d0 = new Date(x0), d1 = new Date(x1);
  if (spanDays > 900) { // годы
    for (let y = d0.getUTCFullYear() + 1; y <= d1.getUTCFullYear(); y++) out.push([Date.UTC(y, 0, 1), String(y)]);
  } else if (spanDays > 150) { // кварталы
    for (let y = d0.getUTCFullYear(); y <= d1.getUTCFullYear(); y++)
      for (const m of [0, 3, 6, 9]) {
        const t = Date.UTC(y, m, 1);
        if (t >= x0 && t <= x1) out.push([t, `${MONTH_RU[m]} ${String(y).slice(2)}`]);
      }
  } else { // месяцы
    for (let y = d0.getUTCFullYear(); y <= d1.getUTCFullYear(); y++)
      for (let m = 0; m < 12; m++) {
        const t = Date.UTC(y, m, 1);
        if (t >= x0 && t <= x1) out.push([t, MONTH_RU[m]]);
      }
  }
  return out;
}

// Агрегатный рыночный индикатор: две панели с ОБЩЕЙ осью времени вместо двух шкал
// на одной оси (столбики нормированной активности сверху, индекс SPY снизу).
export function fmtPrice(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return '$' + (v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(2));
}
export function fmtInt(v) { return v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-US'); }
// Круглые суммы печатаются без хвоста нулей: «$3 млн» вместо «$3.00 млн». Порог набора
// и оборот бумаги стоят рядом в одном предложении, и лишние нули там читаются как точность,
// которой нет.
// Разделитель — точка: цены и проценты на панели уже с точкой, смешивать нельзя
const trim = n => String(Number(n.toFixed(2)));
export function fmtMoney(v) {
  if (v === null || v === undefined) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return '$' + trim(v / 1e9) + ' млрд';
  if (a >= 1e6) return '$' + trim(v / 1e6) + ' млн';
  if (a >= 1e3) return '$' + (v / 1e3).toFixed(0) + ' тыс.';
  return '$' + Math.round(v);
}
// Короткая дата для таблиц: «3 авг» вместо «2026-08-03». Год добавляется, только если он
// не текущий — иначе колонка растёт на четыре знака ради очевидного.
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export function fmtDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '—';
  const [y, m, d] = iso.split('-');
  const cur = String(new Date().getUTCFullYear());
  return `${Number(d)} ${MONTHS_SHORT[Number(m) - 1]}${y === cur ? '' : ' ' + y}`;
}
export function fmtPct(v, digits = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = (v * 100).toFixed(digits);
  return (v > 0 ? '+' : '') + s + '%';
}
