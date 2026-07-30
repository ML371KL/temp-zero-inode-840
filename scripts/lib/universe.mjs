// Загрузка и дедупликация сделок; вселенная эмитентов.
import { readJsonGz, readJson } from './util.mjs';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const ALLOWED_EXCHANGES = new Set(['NYSE', 'Nasdaq', 'CBOE']);

function readShard(path) {
  const raw = readJsonGz(path, null);
  if (!raw) return { trades: [], amend: [] };
  return Array.isArray(raw) ? { trades: raw, amend: [] } : { trades: raw.trades ?? [], amend: raw.amend ?? [] };
}

// Все сделки из шардов с дедупликацией и разрешением поправок 4/A.
// Возвращает { trades, stats } — stats нужен для честного meta.json.
export function loadAllTrades(dataDir) {
  const dir = join(dataDir, 'trades');
  if (!existsSync(dir)) return { trades: [], stats: {} };
  const files = readdirSync(dir).filter(f => f.endsWith('.json.gz')).sort();

  // Ключ строки включает класс бумаги: одна подача может содержать покупки нескольких
  // классов (Class A + Class C), и без этого вторая строка молча затирала бы первую.
  const rowKey = r => `${r.acc}|${r.code}|${r.tdate}|${r.sec ?? ''}`;
  const byKey = new Map();
  const amend = [];
  // Датасетные строки приоритетнее live: они прошли нормализацию SEC
  for (const f of files.filter(x => x !== 'live.json.gz')) {
    const s = readShard(join(dir, f));
    for (const r of s.trades) byKey.set(rowKey(r), r);
    amend.push(...s.amend);
  }
  {
    const s = readShard(join(dir, 'live.json.gz'));
    for (const r of s.trades) if (!byKey.has(rowKey(r))) byKey.set(rowKey(r), r);
    amend.push(...s.amend);
  }

  // Поправки 4/A замещают оригинал по содержательному ключу. Количество акций в ключ НЕ
  // входит: поправки чаще всего правят именно его, и тогда оригинал с ошибочным числом
  // (встречались строки на сотни миллиардов долларов) остался бы в выборке вторым экземпляром.
  const byContent = new Map();
  let replaced = 0;
  for (const r of byKey.values()) {
    const k = `${r.cik}|${r.owners[0]?.cik ?? 0}|${r.tdate}|${r.code}|${r.sec ?? ''}`;
    const prev = byContent.get(k);
    if (!prev) { byContent.set(k, r); continue; }
    replaced++;
    const better = (r.form === '4/A') !== (prev.form === '4/A')
      ? (r.form === '4/A' ? r : prev)
      : (r.fdate > prev.fdate ? r : prev);
    byContent.set(k, better);
  }

  // Аннулирующие поправки НЕ детектируются намеренно. Признак «4/A без строк P/S» выглядит
  // логично, но на реальных данных таких поправок 84% (правки грантов, деривативов, адреса),
  // а инсайдеры регулярно подают несколько форм за день — сопоставление по дате подачи
  // гасило настоящие покупки, включая целые кластеры. Отличить «поправка убрала сделку» от
  // «поправка касается другой строки» можно только сохраняя ВСЕ строки формы, а не только
  // P/S. Пока этого нет, безопаснее не гасить ничего: маркеры поправок лежат в shard.amend.
  return {
    trades: [...byContent.values()],
    stats: { raw: byKey.size, replacedByAmendment: replaced, amendments: amend.length },
  };
}

// Справочник тикеров: { cik: {ticker, exchange, name} }
export function loadTickerRef(dataDir) {
  const raw = readJson(join(dataDir, 'reference', 'tickers.json'), {});
  return new Map(Object.entries(raw).map(([cik, v]) => [Number(cik), v]));
}

// Текущий тикер по CIK (переименования FB->META); иначе — тикер из самой формы
export function resolveTicker(row, ref) {
  const cur = ref.get(row.cik);
  if (cur?.ticker) return cur.ticker.toUpperCase();
  return row.t || null;
}

// 'listed' — NYSE/Nasdaq/CBOE сейчас; 'otc' — исключаем; 'unknown' — нет в справочнике
// (кандидат в делистинг: включаем в бэктест только при наличии ценового ряда)
export function issuerCategory(row, ref) {
  const cur = ref.get(row.cik);
  if (!cur || !cur.exchange) return 'unknown';
  return ALLOWED_EXCHANGES.has(cur.exchange) ? 'listed' : 'otc';
}

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
export function plausibleTicker(t) {
  return !!t && TICKER_RE.test(t) && t !== 'NONE' && t !== 'N/A' && t !== 'NA';
}
