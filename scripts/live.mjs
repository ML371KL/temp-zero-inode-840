// Живой контур: хвост, не покрытый квартальными датасетами (и ежедневное обновление).
// Идёт по daily-index EDGAR день за днём, тянет полные .txt сабмишены Form 4/4A,
// парсит XML и складывает в data/trades/live.json.gz.
// Резюмируемый: state/live.json { from, lastDay }. Бюджет времени — для картриджных прогонов.
// Использование: node scripts/live.mjs [--data data] [--time-budget-min N]
import { readJson, writeJson, readJsonGz, writeJsonGz, isoToday, addDaysIso } from './lib/util.mjs';
import { fetchDayIndex, fetchFiling, parseForm4Txt } from './lib/edgar.mjs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const DATA = argVal('--data', 'data');
const BUDGET_MS = Number(argVal('--time-budget-min', '300')) * 60000;
const started = Date.now();

// Первый день, не покрытый квартальными датасетами, вычисляется из state/backfill.json
const backfillState = readJson(join(DATA, 'state', 'backfill.json'), { done: [] });
let defaultFrom = '2026-04-01';
{
  const done = backfillState.done.slice().sort();
  if (done.length) {
    const last = done[done.length - 1]; // например "2026q1"
    const y = Number(last.slice(0, 4)), q = Number(last.slice(5));
    const nextQStart = q === 4 ? `${y + 1}-01-01` : `${y}-${String(q * 3 + 1).padStart(2, '0')}-01`;
    defaultFrom = nextQStart;
  }
}

const statePath = join(DATA, 'state', 'live.json');
const state = readJson(statePath, {});
const from = state.from ?? defaultFrom;
const today = isoToday();

const shardPath = join(DATA, 'trades', 'live.json.gz');
let rows = readJsonGz(shardPath, []);
// Строки, попавшие в уже загруженные квартальные датасеты, из live-шарда вычищаются
const before = rows.length;
rows = rows.filter(r => r.fdate >= from);
if (rows.length !== before) console.log(`[live] вычищено ${before - rows.length} строк, покрытых датасетами`);
const seen = new Set(rows.map(r => `${r.acc}|${r.code}|${r.tdate}`));

let day = state.lastDay ? addDaysIso(state.lastDay, 1) : from;
let lastCompleted = state.lastDay ?? null;
let daysDone = 0, filingsDone = 0, added = 0;

function save() {
  writeJsonGz(shardPath, rows);
  writeJson(statePath, { from, lastDay: lastCompleted, updated: isoToday() }, true);
}

outer:
while (day <= today) {
  const dow = new Date(day + 'T00:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) { lastCompleted = day; day = addDaysIso(day, 1); continue; } // выходные — индекса нет
  const { entries } = await fetchDayIndex(day);
  if (!entries) {
    // Индекс за день ещё не опубликован (или праздник). За старые дни — праздник, идём дальше;
    // за последние 2 дня — вероятно ещё не выложен, останавливаемся до следующего запуска.
    if (addDaysIso(day, 2) >= today) { console.log(`[live] ${day}: индекс ещё не опубликован — стоп`); break; }
    lastCompleted = day; day = addDaysIso(day, 1); continue;
  }
  // Один филинг встречается в индексе несколько раз (эмитент + каждый инсайдер) — дедуп по пути
  const paths = [...new Set(entries.map(e => e.path))];
  for (const p of paths) {
    if (Date.now() - started > BUDGET_MS) {
      // Бюджет исчерпан посреди дня: день НЕ помечаем завершённым, дособерём в следующий запуск
      console.log(`[live] бюджет времени исчерпан на ${day} (${filingsDone} филингов)`);
      break outer;
    }
    const acc = /\/(\d{10}-\d{2}-\d{6})\.txt$/.exec(p)?.[1];
    let txt;
    try { txt = await fetchFiling(p); } catch (e) { console.log(`[live] пропуск ${p}: ${e.message}`); continue; }
    if (!txt) continue;
    filingsDone++;
    for (const r of parseForm4Txt(txt, acc ?? p, day)) {
      const key = `${r.acc}|${r.code}|${r.tdate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
      added++;
    }
  }
  lastCompleted = day;
  daysDone++;
  if (daysDone % 5 === 0) save(); // периодическая фиксация прогресса
  console.log(`[live] ${day}: ${paths.length} филингов, всего строк ${rows.length}`);
  day = addDaysIso(day, 1);
}

save();
console.log(`[live] готово: дней ${daysDone}, филингов ${filingsDone}, новых строк ${added}, в шарде ${rows.length}, lastDay=${lastCompleted}`);
