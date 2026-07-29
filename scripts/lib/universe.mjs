// Вселенная и загрузка сделок — общий код prices.mjs и compute.mjs.
import { readJsonGz, readJson } from './util.mjs';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const ALLOWED_EXCHANGES = new Set(['NYSE', 'Nasdaq', 'CBOE']);

// Все нормализованные сделки из шардов; датасетные строки имеют приоритет над live при дедупе
export function loadAllTrades(dataDir) {
  const dir = join(dataDir, 'trades');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.endsWith('.json.gz')).sort();
  const byKey = new Map();
  for (const f of files.filter(x => x !== 'live.json.gz')) {
    for (const r of readJsonGz(join(dir, f), [])) byKey.set(`${r.acc}|${r.code}|${r.tdate}`, r);
  }
  for (const r of readJsonGz(join(dir, 'live.json.gz'), [])) {
    const k = `${r.acc}|${r.code}|${r.tdate}`;
    if (!byKey.has(k)) byKey.set(k, r);
  }
  // Поправки 4/A замещают исходники: ключ содержимого (эмитент|инсайдер|дата|код|акции)
  const byContent = new Map();
  for (const r of byKey.values()) {
    const k = `${r.cik}|${r.owners[0]?.cik ?? 0}|${r.tdate}|${r.code}|${r.sh}`;
    const prev = byContent.get(k);
    if (!prev) { byContent.set(k, r); continue; }
    // Предпочитаем 4/A, при равенстве — более позднюю подачу
    const better = (r.form === '4/A') !== (prev.form === '4/A') ? (r.form === '4/A' ? r : prev)
      : (r.fdate > prev.fdate ? r : prev);
    byContent.set(k, better);
  }
  return [...byContent.values()];
}

// Справочник тикеров, сохранённый prices.mjs (reference/tickers.json): { cik: {ticker, exchange, name} }
export function loadTickerRef(dataDir) {
  const raw = readJson(join(dataDir, 'reference', 'tickers.json'), {});
  return new Map(Object.entries(raw).map(([cik, v]) => [Number(cik), v]));
}

// Отображаемый тикер: текущий из справочника (переименования FB->META), иначе из формы
export function resolveTicker(row, ref) {
  const cur = ref.get(row.cik);
  if (cur?.ticker) return cur.ticker.toUpperCase();
  return row.t || null;
}

// В какой категории эмитент: 'listed' (NYSE/Nasdaq/CBOE сейчас), 'otc' (исключаем),
// 'unknown' (нет в текущем справочнике — кандидат в делистинг, судьбу решают ценовые данные)
export function issuerCategory(row, ref) {
  const cur = ref.get(row.cik);
  if (!cur || !cur.exchange) return 'unknown';
  return ALLOWED_EXCHANGES.has(cur.exchange) ? 'listed' : 'otc';
}

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
export function plausibleTicker(t) {
  return !!t && TICKER_RE.test(t) && t !== 'NONE' && t !== 'N/A' && t !== 'NA';
}
