// Даты квартальных отчётов (10-Q/10-K) по эмитентам вселенной — из квартальных
// full-index EDGAR (один файл на квартал, без пер-эмитентных запросов).
// Зачем: (1) признак Ali–Hirshleifer — трек-рекорд инсайдера именно по покупкам
// ПЕРЕД отчётностью; (2) контекст blackout-окна — покупка сразу после отчёта это
// рутинный «window-open» поток, покупка глубоко в квартале — аномалия.
// Кэш: data/reference/reports.json.gz { cik: ["YYYY-MM-DD", ...] } (только CIKи вселенной).
// Резюмируемость: state/earnings.json { quartersDone: [...] }.
// Использование: node scripts/earnings.mjs [--data data] [--time-budget-min N]
import { readJson, writeJson, readJsonGz, writeJsonGz, isoToday } from './lib/util.mjs';
import { politeFetch } from './lib/util.mjs';
import { quarterList } from './lib/edgar.mjs';
import { loadAllTrades } from './lib/universe.mjs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const DATA = argVal('--data', 'data');
const BUDGET_MS = Number(argVal('--time-budget-min', '120')) * 60000;
const started = Date.now();

// Вселенная CIKов: эмитенты, по которым вообще есть сделки (без OTC-фильтра —
// он применяется позже в compute, а кэш дат безвреден и для лишних CIKов)
const { trades } = loadAllTrades(DATA);
const wanted = new Set(trades.map(r => r.cik));
console.log(`[earnings] эмитентов во вселенной: ${wanted.size}`);

const cachePath = join(DATA, 'reference', 'reports.json.gz');
const statePath = join(DATA, 'state', 'earnings.json');
const cache = readJsonGz(cachePath, {});
const state = readJson(statePath, { quartersDone: [] });

const today = isoToday();
const curYear = Number(today.slice(0, 4));
const curQ = Math.ceil(Number(today.slice(5, 7)) / 3);
// С 2015 года: чтобы у сделок начала 2016-го было «прошлое» отчётное окно
const quarters = quarterList(2015, curYear, curQ);

const seen = new Map(); // cik -> Set(dates) — сливаем с кэшем в конце
function addDate(cik, iso) {
  (seen.get(cik) ?? seen.set(cik, new Set()).get(cik)).add(iso);
}

// form.idx (full-index): "10-Q  Company  CIK  YYYY-MM-DD  path" — в отличие от
// daily-index, дата здесь с дефисами. Имена компаний содержат одиночные пробелы,
// колонки разделены двумя и более.
function parseReports(text) {
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('10-Q') && !line.startsWith('10-K')) continue;
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 5) continue;
    if (parts[0] !== '10-Q' && parts[0] !== '10-K') continue; // поправки /A и варианты 10-KSB — мимо
    const cik = Number(parts[2]);
    if (!wanted.has(cik)) continue;
    const d = parts[3].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    addDate(cik, d);
    n++;
  }
  return n;
}

let fetched = 0, budgetOut = false;
for (const q of quarters) {
  const isCurrent = q === `${curYear}q${curQ}`;
  if (state.quartersDone.includes(q) && !isCurrent) continue; // текущий квартал перечитывается всегда
  if (Date.now() - started > BUDGET_MS) { budgetOut = true; break; }
  const [y, qq] = q.split('q');
  const url = `https://www.sec.gov/Archives/edgar/full-index/${y}/QTR${qq}/form.idx`;
  const { status, body } = await politeFetch(url, { as: 'text', timeoutMs: 180000 });
  if (!body) { console.log(`[earnings] ${q}: HTTP ${status} — пропуск`); continue; }
  const n = parseReports(body);
  if (!state.quartersDone.includes(q)) state.quartersDone.push(q);
  fetched++;
  console.log(`[earnings] ${q}: отчётов по вселенной ${n}`);
  writeJson(statePath, state, true);
}

// Слияние с кэшем
for (const [cik, dates] of seen) {
  const prev = new Set(cache[cik] ?? []);
  for (const d of dates) prev.add(d);
  cache[cik] = [...prev].sort();
}
writeJsonGz(cachePath, cache);
console.log(`[earnings] готово: кварталов загружено ${fetched}, эмитентов в кэше ${Object.keys(cache).length}, бюджет ${budgetOut ? 'ИСЧЕРПАН' : 'ок'}`);
