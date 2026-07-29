// Бэкфил квартальных датасетов SEC 2016q1..последний доступный.
// Резюмируемый: state/backfill.json хранит список загруженных кварталов.
// Хранение: годовые шарды data/trades/YYYY.json.gz (год = год даты сделки).
// Использование: node scripts/backfill.mjs [--data data] [--max-quarters N]
import { readJson, writeJson, readJsonGz, writeJsonGz, isoToday } from './lib/util.mjs';
import { fetchQuarter, quarterList } from './lib/edgar.mjs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
const DATA = argVal('--data', 'data');
const MAX = Number(argVal('--max-quarters', '999'));

const statePath = join(DATA, 'state', 'backfill.json');
const state = readJson(statePath, { done: [], missing: [] });

const today = isoToday();
const curYear = Number(today.slice(0, 4));
const curQ = Math.ceil(Number(today.slice(5, 7)) / 3);
const wanted = quarterList(2016, curYear, curQ);

let processed = 0;
for (const q of wanted) {
  if (state.done.includes(q)) continue;
  if (processed >= MAX) break;
  const { status, rows } = await fetchQuarter(q);
  if (!rows) {
    // 403/404: датасет ещё не опубликован (нормально для последних кварталов)
    if (!state.missing.includes(q)) state.missing.push(q);
    console.log(`[backfill] ${q}: недоступен (HTTP ${status}) — этот период закроет живой контур`);
    continue;
  }
  // Раскладка по годам даты сделки
  const byYear = new Map();
  for (const r of rows) {
    const y = r.tdate.slice(0, 4);
    // Мусорные даты сделок (опечатки в формах) не тащим в шарды
    if (y < '2010' || y > String(curYear + 1)) continue;
    (byYear.get(y) ?? byYear.set(y, []).get(y)).push(r);
  }
  for (const [y, newRows] of byYear) {
    const shardPath = join(DATA, 'trades', `${y}.json.gz`);
    const existing = readJsonGz(shardPath, []);
    // Дедуп по (accession|code|tdate) — повторная загрузка квартала идемпотентна
    const seen = new Set(existing.map(r => `${r.acc}|${r.code}|${r.tdate}`));
    const add = newRows.filter(r => !seen.has(`${r.acc}|${r.code}|${r.tdate}`));
    if (add.length) writeJsonGz(shardPath, existing.concat(add));
    console.log(`[backfill] ${q} -> ${y}: +${add.length} (всего ${existing.length + add.length})`);
  }
  state.done.push(q);
  state.missing = state.missing.filter(x => x !== q);
  state.updated = today;
  writeJson(statePath, state, true);
  processed++;
}
const remaining = wanted.filter(q => !state.done.includes(q));
console.log(`[backfill] готово: ${state.done.length}/${wanted.length} кварталов; осталось: ${remaining.join(', ') || 'нет'}`);
