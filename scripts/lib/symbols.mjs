// Реестр биржевых символов с датами: тикер -> на какой бирже и в какие годы он торговался.
//
// Зачем это нужно. Тикер в США переиспользуется. Справочник SEC содержит только ЖИВЫЕ
// компании, поэтому для делистнутого эмитента тикер берётся из самой формы 4 — а котировки
// по нему запрашиваются СЕГОДНЯШНИЕ. Если символ успел перейти к другой компании, к сделкам
// подставляется чужой ценовой ряд, и это не «нет данных», а правдоподобно выглядящая ложь.
// Измерено на нашей выборке: 4360 покупок в 192 тикерах. Примеры:
//   LGCY  NASDAQ 2007-01-12..2019-06-28 (Legacy Reserves)  +  AMEX 2024-09-26..сейчас
//   MNR   NYSE   1990-03-26..2022-02-25 (Monmouth)         +  NYSE 2023-10-25..сейчас
//   DAVE  NASDAQ 2021-04-26..сейчас — сделок Famous Dave's 2016-2019 не покрывает вовсе
//
// Второе применение: биржа на дату сделки. У живого эмитента её даёт справочник SEC,
// у мёртвого — взять было неоткуда, поэтому OTC-бумаги проходили фильтр вселенной
// (issuerCategory возвращал 'unknown'). Это 1392 тикера и 26 тыс. покупок.
//
// Источник: открытый реестр Tiingo supported_tickers.zip — 105 тыс. символов,
// поля ticker,exchange,assetType,priceCurrency,startDate,endDate. Ключ НЕ нужен.
import { politeFetch, BROWSER_UA, readJsonGz, writeJsonGz, addDaysIso } from './util.mjs';
import { zipExtract } from './zip.mjs';
import { join } from 'node:path';

const URL = 'https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip';

// Биржи, которые для нас «настоящий листинг». BATS — это CBOE BZX; AMEX и NYSE MKT —
// нынешняя NYSE American (справочник SEC их не выделяет, относя к NYSE).
export const MAJOR = new Set(['NYSE', 'NASDAQ', 'BATS', 'NYSE ARCA', 'AMEX', 'NYSE MKT', 'NYSE American']);
// Внебиржевые площадки — по решению пользователя вне вселенной.
const OTC = new Set(['PINK', 'OTCMKTS', 'OTCGREY', 'OTCBB', 'OTCQB', 'OTCQX', 'OTCCE', 'OTCD', 'EXPM']);

export function classifyExchange(exch) {
  if (MAJOR.has(exch)) return 'listed';
  if (OTC.has(exch)) return 'otc';
  return null;   // NMFQS (взаимные фонды), SHE/SHG (Китай) и прочее — не наша вселенная
}

// zip -> { ticker: [[kind, start, end], ...] }, kind: 1 = биржевой листинг, 0 = OTC.
// Оставляем только акции и ETF в долларах: взаимные фонды и иностранные площадки
// раздули бы файл втрое, не давая ничего.
export function parseRegistry(csvText) {
  const out = {};
  const lines = csvText.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 6) continue;
    const ticker = c[0].trim().toUpperCase();
    if (!ticker) continue;
    const exch = c[1].trim(), type = c[2].trim(), cur = c[3].trim();
    if (cur !== 'USD') continue;
    if (type !== 'Stock' && type !== 'ETF') continue;
    const kind = classifyExchange(exch);
    if (kind === null) continue;
    const start = c[4].trim(), end = c[5].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) continue;
    (out[ticker] ??= []).push([kind === 'listed' ? 1 : 0, start, end]);
  }
  for (const list of Object.values(out)) list.sort((a, b) => a[1] < b[1] ? -1 : 1);
  return out;
}

export async function fetchSymbolRanges() {
  const { status, body } = await politeFetch(URL, { ua: BROWSER_UA, retries: 2, timeoutMs: 120000 });
  if (!body) throw new Error(`реестр символов недоступен: HTTP ${status}`);
  const csv = zipExtract(body, 'supported_tickers.csv');
  if (!csv) throw new Error('в архиве нет supported_tickers.csv');
  return parseRegistry(csv.toString('utf8'));
}

const PATH = d => join(d, 'reference', 'symbol-ranges.json.gz');
export const loadSymbolRanges = dataDir => readJsonGz(PATH(dataDir), null);
export const writeSymbolRanges = (dataDir, obj) => writeJsonGz(PATH(dataDir), obj);

// Чем был символ в эту дату: 'listed' | 'otc' | null (реестр не знает).
// Если на дату попадает несколько записей, биржевой листинг приоритетнее.
export function exchangeAt(ranges, ticker, iso) {
  const list = ranges?.[String(ticker ?? '').toUpperCase()];
  if (!list) return null;
  let seen = null;
  for (const [kind, start, end] of list) {
    if (iso < start || iso > end) continue;
    if (kind === 1) return 'listed';
    seen = 'otc';
  }
  return seen;
}

// Можно ли доверять сегодняшнему ценовому ряду символа для сделок периода [from, to].
// Требуем ОДНУ запись реестра, накрывающую весь период: если период приходится на стык
// двух разных инструментов, ряд принадлежит уже не тому эмитенту.
// null = реестр символа не знает (решение принимает вызывающий).
export function seriesCovers(ranges, ticker, from, to) {
  const list = ranges?.[String(ticker ?? '').toUpperCase()];
  if (!list?.length) return null;
  return list.some(([, start, end]) => start <= from && end >= to);
}

// Одна и та же бумага даёт в реестре НЕСКОЛЬКО записей: перевод листинга с Nasdaq на NYSE,
// уход с биржи на внебиржевую площадку, двойные записи по классам. Все они идут встык или
// внахлёст. Смена же владельца символа всегда оставляет зазор в месяцы или годы, потому что
// биржи выдерживают карантин. Поэтому склеиваем интервалы с зазором до 30 дней: без этого
// обычный перевод листинга выглядел бы как подмена компании.
const MERGE_GAP_DAYS = 30;
export function mergeRanges(list) {
  const sorted = list.map(r => [r[1], r[2]]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= addDaysIso(last[1], MERGE_GAP_DAYS)) { if (e > last[1]) last[1] = e; }
    else out.push([s, e]);
  }
  return out;
}

// Главная проверка привязки. Котировки мы скачиваем СЕГОДНЯ, значит ряд принадлежит
// нынешнему владельцу символа. Сделка сопоставима с этим рядом только если её дата
// попадает в тот же непрерывный интервал, что и последняя запись символа.
// true — ряд про ту же бумагу; false — про другую; null — реестр символа не знает.
const mergedCache = new Map();
export function sameInstrumentAsLatest(ranges, ticker, iso) {
  const key = String(ticker ?? '').toUpperCase();
  const list = ranges?.[key];
  if (!list?.length) return null;
  let merged = mergedCache.get(key);
  if (!merged) { merged = mergeRanges(list); mergedCache.set(key, merged); }
  const latest = merged[merged.length - 1];
  return iso >= latest[0] && iso <= latest[1];
}
