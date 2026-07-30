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
  return series.length ? { series, splits } : { missing: true };
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
  return series.length ? { series } : { missing: true };
}

// ---- Кэш на ветке data: prices/<T>.csv.gz строками "YYYY-MM-DD,adjclose" ----

export function priceCachePath(dataDir, ticker) {
  return join(dataDir, 'prices', ticker.replace(/[^A-Za-z0-9.-]/g, '_') + '.csv.gz');
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
  return series;
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

// Слияние: свежие данные замещают хвост кэша с точки перекрытия
// (adjclose пересчитывается задним числом после дивидендов — просто дописывать нельзя).
export function mergeSeries(cached, fresh) {
  if (!cached?.length) return fresh;
  if (!fresh?.length) return cached;
  const freshStart = fresh[0][0];
  const head = cached.filter(r => r[0] < freshStart);
  return [...head, ...fresh];
}
