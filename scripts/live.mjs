// Живой контур: дни, не покрытые квартальными датасетами (и ежедневное обновление).
// daily-index EDGAR -> полные .txt сабмишены Form 4/4A -> XML-парсер -> data/trades/live.json.gz.
// Резюмируемый: state/live.json { schema, from, lastDay }. Бюджет времени — для картриджных прогонов.
// Использование: node scripts/live.mjs [--data data] [--time-budget-min N]
import { readJson, writeJson, readJsonGz, writeJsonGz, isoToday, addDaysIso } from './lib/util.mjs';
import { fetchDayIndex, fetchFiling, parseForm4Txt, SHARD_VERSION } from './lib/edgar.mjs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const DATA = argVal('--data', 'data');
const BUDGET_MS = Number(argVal('--time-budget-min', '300')) * 60000;
const started = Date.now();

// Первый непокрытый датасетами день выводится из state/backfill.json
const backfillState = readJson(join(DATA, 'state', 'backfill.json'), { done: [] });
let defaultFrom = '2026-04-01';
{
  const done = (backfillState.done ?? []).slice().sort();
  if (done.length) {
    const last = done[done.length - 1]; // "2026q1"
    const y = Number(last.slice(0, 4)), q = Number(last.slice(5));
    defaultFrom = q === 4 ? `${y + 1}-01-01` : `${y}-${String(q * 3 + 1).padStart(2, '0')}-01`;
  }
}

const statePath = join(DATA, 'state', 'live.json');
const state = readJson(statePath, {});
const shardPath = join(DATA, 'trades', 'live.json.gz');

// Смена схемы парсера -> перечитываем хвост заново
const schemaChanged = state.schema !== SHARD_VERSION;
if (schemaChanged && state.lastDay) console.log(`[live] схема ${state.schema ?? 1} -> ${SHARD_VERSION}: перечитываю хвост`);

const from = (schemaChanged ? null : state.from) ?? defaultFrom;
const today = isoToday();

const rawShard = schemaChanged ? null : readJsonGz(shardPath, null);
const shard = rawShard && !Array.isArray(rawShard) ? rawShard : { v: SHARD_VERSION, trades: [], amend: [] };
// Строки, покрытые уже загруженными квартальными датасетами, из live-шарда вычищаются
const before = shard.trades.length;
shard.trades = shard.trades.filter(r => r.fdate >= from);
shard.amend = shard.amend.filter(a => a.orig >= '2000-01-01');
if (shard.trades.length !== before) console.log(`[live] вычищено ${before - shard.trades.length} строк, покрытых датасетами`);
const seen = new Set(shard.trades.map(r => `${r.acc}|${r.code}|${r.tdate}|${r.sec ?? ''}`));
const seenAmend = new Set(shard.amend.map(a => a.acc));

let day = (schemaChanged ? null : state.lastDay) ? addDaysIso(state.lastDay, 1) : from;
let lastCompleted = schemaChanged ? null : (state.lastDay ?? null);
let daysDone = 0, filingsDone = 0, added = 0;

function save() {
  writeJsonGz(shardPath, shard);
  writeJson(statePath, { schema: SHARD_VERSION, from, lastDay: lastCompleted, updated: isoToday() }, true);
}

outer:
while (day <= today) {
  const dow = new Date(day + 'T00:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) { lastCompleted = day; day = addDaysIso(day, 1); continue; }
  const { entries } = await fetchDayIndex(day);
  if (!entries) {
    // Индекса нет: за старые дни — праздник (идём дальше), за последние 2 дня — ещё не выложен
    if (addDaysIso(day, 2) >= today) { console.log(`[live] ${day}: индекс ещё не опубликован — стоп`); break; }
    lastCompleted = day; day = addDaysIso(day, 1); continue;
  }
  // Один филинг в индексе встречается несколько раз (эмитент + каждый инсайдер) — дедуп по пути
  const paths = [...new Set(entries.map(e => e.path))];
  for (const p of paths) {
    if (Date.now() - started > BUDGET_MS) {
      console.log(`[live] бюджет времени исчерпан на ${day} (${filingsDone} филингов)`);
      break outer;
    }
    const acc = /\/(\d{10}-\d{2}-\d{6})\.txt$/.exec(p)?.[1];
    let txt;
    try { txt = await fetchFiling(p); } catch (e) { console.log(`[live] пропуск ${p}: ${e.message}`); continue; }
    if (!txt) continue;
    filingsDone++;
    const parsed = parseForm4Txt(txt, acc ?? p, day);
    for (const r of parsed.trades) {
      const key = `${r.acc}|${r.code}|${r.tdate}|${r.sec ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      shard.trades.push(r);
      added++;
    }
    for (const a of parsed.amend) {
      if (seenAmend.has(a.acc)) continue;
      seenAmend.add(a.acc);
      shard.amend.push(a);
    }
  }
  lastCompleted = day;
  daysDone++;
  if (daysDone % 5 === 0) save();
  console.log(`[live] ${day}: ${paths.length} филингов, всего строк ${shard.trades.length}`);
  day = addDaysIso(day, 1);
}

save();
console.log(`[live] готово: дней ${daysDone}, филингов ${filingsDone}, новых строк ${added}, в шарде ${shard.trades.length}, lastDay=${lastCompleted}`);
