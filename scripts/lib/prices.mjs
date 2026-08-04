// Цены: Yahoo chart API (первичный, adjclose = сплиты+дивиденды),
// Stooq — резерв (без обхода антибот-челленджа: если отдаёт HTML — источник помечается недоступным).
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { politeFetch, BROWSER_UA } from './util.mjs';

// Тикеры SEC -> Yahoo: классы акций через дефис (BRK.B -> BRK-B)
export function yahooSymbol(t) { return t.replace(/\./g, '-').replace(/\//g, '-'); }
export function stooqSymbol(t) { return t.replace(/\./g, '-').toLowerCase() + '.us'; }

const Y_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
let yHostIdx = 0;

// Бумага должна быть американской и котироваться в долларах. Проверка нужна потому, что
// у Yahoo один и тот же символ может обслуживать инструмент другой страны, и в ответ
// приходит смесь: у ITC к настоящим барам ITC Holdings ($40) подмешивались чужие бары
// по $7800, что давало в бэктесте избыточную доходность +42 000% на одной сделке.
const ALLOWED_CURRENCY = 'USD';
const ALLOWED_INSTRUMENT = new Set(['EQUITY', 'ETF']);
export function metaAcceptable(meta) {
  if (!meta) return { ok: true, reason: null };   // меты нет — не повод отвергать ряд
  if (meta.currency && meta.currency !== ALLOWED_CURRENCY) return { ok: false, reason: `валюта ${meta.currency}` };
  if (meta.instrumentType && !ALLOWED_INSTRUMENT.has(meta.instrumentType)) return { ok: false, reason: `тип ${meta.instrumentType}` };
  return { ok: true, reason: null };
}

// Изолированный выброс — бар, который отличается более чем втрое от медианы соседей
// (окно ±7) И ПРИ ЭТОМ соседи слева и справа согласны между собой. Второе условие
// обязательно: без него на настоящем скачке цены (10 -> 60) удалялся бы последний бар
// ПЕРЕД скачком — он тоже далёк от медианы окна. Уровневый сдвиг не трогаем: удалить
// настоящий бар хуже, чем оставить подозрительный.
// Ловит склейку двух инструментов под одним символом — у ITC настоящие бары по $40 шли
// вперемешку с чужими по $7800, и это давало в бэктесте +42 000% на одной сделке.
const SPIKE_RATIO = 3;
const WIN = 7;   // окно должно быть шире серии чужих баров: у ITC они идут блоками по 2-3
const medOf = a => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
export function sanitizeSeries(series) {
  if (!series || series.length < 5) return { series: series ?? [], dropped: 0 };
  const keep = new Array(series.length).fill(true);
  let dropped = 0;
  for (let i = 0; i < series.length; i++) {
    const before = [], after = [];
    for (let k = Math.max(0, i - WIN); k < i; k++) before.push(series[k][2]);
    for (let k = i + 1; k <= Math.min(series.length - 1, i + WIN); k++) after.push(series[k][2]);
    const mb = medOf(before), ma = medOf(after);
    // Уровень до и после бара расходится сам по себе — это настоящий сдвиг цены
    // (поглощение, обвал, крупная новость), а не выброс. Не трогаем.
    if (mb > 0 && ma > 0 && Math.max(mb, ma) / Math.min(mb, ma) > SPIKE_RATIO) continue;
    const m = medOf(before.concat(after));
    if (m > 0 && (series[i][2] / m > SPIKE_RATIO || series[i][2] / m < 1 / SPIKE_RATIO)) { keep[i] = false; dropped++; }
  }
  return dropped ? { series: series.filter((_, i) => keep[i]), dropped } : { series, dropped: 0 };
}

// Ряд: [[iso, close, adjclose, volume], ...]. close — для графиков (номинал),
// adjclose (сплиты+дивиденды) — для доходностей, volume — для прокси ликвидности/размера
// (капитализации в бесплатных источниках нет, а $-оборот доступен и хорошо с ней коррелирует).
// -> { series } | { missing: true } | throws при сетевом сбое
export async function fetchYahooDaily(ticker, fromIso) {
  const p1 = Math.floor(new Date(fromIso + 'T00:00:00Z').getTime() / 1000);
  const p2 = Math.floor(Date.now() / 1000) + 86400;
  const host = Y_HOSTS[yHostIdx++ % Y_HOSTS.length];
  const url = `https://${host}/v8/finance/chart/${encodeURIComponent(yahooSymbol(ticker))}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplits`;
  const { status, body } = await politeFetch(url, { ua: BROWSER_UA, as: 'text', retries: 3 });
  if (status === 404 || status === 403 || !body) return { missing: true };
  let j;
  try { j = JSON.parse(body); } catch { return { missing: true }; }
  const r = j?.chart?.result?.[0];
  if (!r || !r.timestamp?.length) return { missing: true };
  // Ряд чужого инструмента хуже отсутствия ряда: он выглядит правдоподобно и молча
  // попадает в бэктест. Отвергаем до разбора баров, кэш при этом сохраняется как был.
  const mOk = metaAcceptable(r.meta);
  if (!mOk.ok) return { missing: true, rejected: mOk.reason };
  const close = r.indicators?.quote?.[0]?.close;
  const vol = r.indicators?.quote?.[0]?.volume;
  const adj = r.indicators?.adjclose?.[0]?.adjclose ?? close;
  if (!adj || !close) return { missing: true };
  const rnd = v => Math.round(v * 10000) / 10000;
  const series = [];
  let prevIso = '';
  for (let i = 0; i < r.timestamp.length; i++) {
    const a = adj[i], c = close[i] ?? adj[i];
    if (a === null || a === undefined || !Number.isFinite(a) || a <= 0) continue;
    // Таймстемпы Yahoo — открытие сессии в бирже; день берём по Нью-Йорку через offset меты
    const iso = new Date((r.timestamp[i] + (r.meta?.gmtoffset ?? -14400)) * 1000).toISOString().slice(0, 10);
    const v = vol?.[i];
    const row = [iso, rnd(Number.isFinite(c) && c > 0 ? c : a), rnd(a), Number.isFinite(v) ? v : 0];
    if (iso === prevIso) { series[series.length - 1] = row; continue; }
    series.push(row);
    prevIso = iso;
  }
  // Сплиты: колонка close у Yahoo пересчитана задним числом, а инсайдер платил номинальную
  // цену своего времени. Без коэффициентов сравнение цены сделки с котировкой ломается
  // (обратный сплит 1:20 делает историческую цену в 20 раз выше фактической).
  const splits = [];
  for (const s of Object.values(r.events?.splits ?? {})) {
    const num = Number(s.numerator), den = Number(s.denominator);
    if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) continue;
    splits.push([new Date((s.date + (r.meta?.gmtoffset ?? -14400)) * 1000).toISOString().slice(0, 10), rnd(num / den, 6)]);
  }
  splits.sort((a, b) => a[0] < b[0] ? -1 : 1);
  const clean = sanitizeSeries(series);
  return clean.series.length
    ? { series: clean.series, splits, dropped: clean.dropped, exchange: r.meta?.exchangeName ?? null }
    : { missing: true };
}

// Резерв: Stooq. НЕ обходим антибот — HTML-ответ означает «источник закрыт», честно возвращаем down.
export async function fetchStooqDaily(ticker, fromIso) {
  const d1 = fromIso.replace(/-/g, '');
  const url = `https://stooq.com/q/d/l/?s=${stooqSymbol(ticker)}&d1=${d1}&d2=20991231&i=d`;
  const { body } = await politeFetch(url, { ua: BROWSER_UA, as: 'text', retries: 1 });
  if (!body || body.startsWith('<')) return { down: true };
  const lines = body.trim().split('\n');
  if (lines.length < 2 || !lines[0].startsWith('Date,')) return { missing: true };
  const series = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const close = Number(c[4]);
    // У Stooq только сплит-коррекция — close и adjclose совпадают (резерв, честно ниже качеством)
    const v = Number(c[5]);
    if (c[0] && Number.isFinite(close) && close > 0) series.push([c[0], close, close, Number.isFinite(v) ? v : 0]);
  }
  const clean = sanitizeSeries(series);
  return clean.series.length ? { series: clean.series, dropped: clean.dropped } : { missing: true };
}

// ---- Кэш на ветке data: prices/<T>.csv.gz строками "YYYY-MM-DD,adjclose" ----

export function priceCachePath(dataDir, ticker) {
  return join(dataDir, 'prices', ticker.replace(/[^A-Za-z0-9.-]/g, '_') + '.csv.gz');
}

// Счётчик выброшенных при чтении баров: кэш на ветке data писался до появления фильтра,
// а в режиме daily перезагружаются только недавние тикеры — остальные ряды очищаются
// именно здесь, на чтении. Учёт ведётся по тикеру, а не по вызову: compute читает один и
// тот же ряд дважды (фаза цен и карточки), и без дедупликации счётчик врал бы вдвое.
export const readStats = { droppedBars: 0, dirtySeries: 0, _seen: new Set() };

// Дешёвая проверка наличия: распаковывать и чистить весь ряд ради «есть или нет»
// значило бы прогнать 100 МБ кэша впустую (режим backfill делает это для всей вселенной).
export function hasPriceCache(dataDir, ticker) {
  return existsSync(priceCachePath(dataDir, ticker));
}

export function readPriceCache(dataDir, ticker) {
  const p = priceCachePath(dataDir, ticker);
  if (!existsSync(p)) return null;
  const text = gunzipSync(readFileSync(p)).toString('utf8');
  const series = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const c = line.split(',');
    // Старый кэш (3 колонки) читается как ряд без объёма — прокси ликвидности будет null
    series.push([c[0], Number(c[1]), Number(c[2] ?? c[1]), c[3] === undefined ? null : Number(c[3])]);
  }
  const clean = sanitizeSeries(series);
  if (clean.dropped && !readStats._seen.has(p)) {
    readStats._seen.add(p);
    readStats.droppedBars += clean.dropped;
    readStats.dirtySeries++;
  }
  return clean.series;
}

export function writePriceCache(dataDir, ticker, series) {
  const p = priceCachePath(dataDir, ticker);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, gzipSync(series.map(r => r.slice(0, 4).join(',')).join('\n'), { level: 9 }));
}

// Номинальная цена бумаги на дату iso: котировка Yahoo, «раскрученная» назад через все
// сплиты, случившиеся ПОСЛЕ этой даты. Именно её видел инсайдер в момент сделки.
export function nominalFactor(splits, iso) {
  let f = 1;
  for (const [d, ratio] of splits ?? []) if (d > iso) f *= ratio;
  return f;
}

// Ответ Tiingo -> наш формат. У Tiingo close номинальный, а adjClose с поправкой на сплиты
// и дивиденды. Кэш же хранит close в конвенции Yahoo — пересчитанным по сплитам задним
// числом, иначе nominalFactor() восстанавливал бы «номинал» из номинала и сравнение цены
// формы с котировкой ломалось бы ровно так, как ломалось на обратном сплите 1:20.
// Поэтому идём с конца ряда, накапливая сплит-фактор.
export function normalizeTiingo(rows) {
  const asc = rows.slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const out = new Array(asc.length);
  const splits = [];
  const rnd = v => Math.round(v * 10000) / 10000;
  let cum = 1;
  for (let i = asc.length - 1; i >= 0; i--) {
    const r = asc[i];
    const iso = String(r.date ?? '').slice(0, 10);
    const close = Number(r.close), adj = Number(r.adjClose);
    // Объём берём скорректированный на сплиты: прокси ликвидности считается как
    // close * volume, а close мы здесь тоже приводим к сплит-конвенции. Смешать сырой
    // объём со сплит-скорректированной ценой значило бы ошибиться в разы на любой бумаге,
    // пережившей сплит. У Yahoo обе величины уже согласованы, у Tiingo — нет.
    const vol = Number(r.adjVolume ?? r.volume);
    out[i] = /^\d{4}-\d{2}-\d{2}$/.test(iso) && Number.isFinite(close) && close > 0 && Number.isFinite(adj) && adj > 0
      ? [iso, rnd(close / cum), rnd(adj), Number.isFinite(vol) && vol > 0 ? Math.round(vol) : 0]
      : null;
    const sf = Number(r.splitFactor);
    if (Number.isFinite(sf) && sf > 0 && sf !== 1) { splits.push([iso, Math.round(sf * 1e6) / 1e6]); cum *= sf; }
  }
  splits.sort((a, b) => a[0] < b[0] ? -1 : 1);
  const clean = sanitizeSeries(out.filter(Boolean));
  return { series: clean.series, splits, dropped: clean.dropped };
}

// Слияние: свежие данные замещают хвост кэша с точки перекрытия
// (adjclose пересчитывается задним числом после дивидендов — просто дописывать нельзя).
export function mergeSeries(cached, fresh) {
  if (!cached?.length) return fresh;
  if (!fresh?.length) return cached;
  const freshStart = fresh[0][0];
  const head = cached.filter(r => r[0] < freshStart);
  return [...head, ...fresh];
}
