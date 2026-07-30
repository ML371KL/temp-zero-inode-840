// Бэкфил квартальных датасетов SEC 2016q1..последний доступный.
// Резюмируемый: state/backfill.json хранит загруженные кварталы и версию схемы.
// При смене схемы шардов данные сделок пересобираются полностью (цены не трогаются —
// они дороже всего и от схемы сделок не зависят).
// Использование: node scripts/backfill.mjs [--data data] [--max-quarters N]
import { readJson, writeJson, readJsonGz, writeJsonGz, isoToday } from './lib/util.mjs';
import { fetchQuarter, quarterList, SHARD_VERSION } from './lib/edgar.mjs';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const DATA = argVal('--data', 'data');
const MAX = Number(argVal('--max-quarters', '999'));

const statePath = join(DATA, 'state', 'backfill.json');
const state = readJson(statePath, { schema: SHARD_VERSION, done: [], missing: [] });

if (state.schema !== SHARD_VERSION) {
  console.log(`[backfill] схема шардов ${state.schema ?? 1} -> ${SHARD_VERSION}: пересобираю сделки с нуля`);
  if (existsSync(join(DATA, 'trades'))) rmSync(join(DATA, 'trades'), { recursive: true, force: true });
  state.schema = SHARD_VERSION;
  state.done = [];
  state.missing = [];
  // Живой контур тоже парсит формы — его хвост нужно перечитать
  const liveState = readJson(join(DATA, 'state', 'live.json'), null);
  if (liveState) writeJson(join(DATA, 'state', 'live.json'), { schema: SHARD_VERSION }, true);
}

const today = isoToday();
const curYear = Number(today.slice(0, 4));
const curQ = Math.ceil(Number(today.slice(5, 7)) / 3);
const wanted = quarterList(2016, curYear, curQ);

function shardPath(y) { return join(DATA, 'trades', `${y}.json.gz`); }
function readShard(y) {
  const raw = readJsonGz(shardPath(y), null);
  if (!raw) return { v: SHARD_VERSION, trades: [], amend: [] };
  return Array.isArray(raw) ? { v: 1, trades: raw, amend: [] } : raw;
}

let processed = 0;
for (const q of wanted) {
  if (state.done.includes(q)) continue;
  if (processed >= MAX) break;
  const { status, data } = await fetchQuarter(q);
  if (!data) {
    // 403/404: датасет ещё не опубликован — этот период закроет живой контур
    if (!state.missing.includes(q)) state.missing.push(q);
    console.log(`[backfill] ${q}: недоступен (HTTP ${status})`);
    continue;
  }
  const byYear = new Map();
  const bucket = y => {
    if (y < '2010' || y > String(curYear + 1)) return null; // мусорные даты в формах
    let e = byYear.get(y);
    if (!e) { e = { trades: [], amend: [] }; byYear.set(y, e); }
    return e;
  };
  for (const r of data.trades) bucket(r.tdate.slice(0, 4))?.trades.push(r);
  for (const a of data.amend) bucket(a.orig.slice(0, 4))?.amend.push(a); // поправка живёт в году оригинала
  for (const [y, add] of byYear) {
    const shard = readShard(y);
    // Дедуп: повторная загрузка квартала идемпотентна
    const seenT = new Set(shard.trades.map(r => `${r.acc}|${r.code}|${r.tdate}|${r.sec ?? ''}`));
    const newT = add.trades.filter(r => !seenT.has(`${r.acc}|${r.code}|${r.tdate}|${r.sec ?? ''}`));
    const seenA = new Set(shard.amend.map(a => a.acc));
    const newA = add.amend.filter(a => !seenA.has(a.acc));
    if (newT.length || newA.length) {
      shard.v = SHARD_VERSION;
      shard.trades = shard.trades.concat(newT);
      shard.amend = shard.amend.concat(newA);
      writeJsonGz(shardPath(y), shard);
    }
    console.log(`[backfill] ${q} -> ${y}: +${newT.length} сделок, +${newA.length} поправок (всего ${shard.trades.length})`);
  }
  state.done.push(q);
  state.missing = state.missing.filter(x => x !== q);
  state.updated = today;
  writeJson(statePath, state, true);
  processed++;
}
const remaining = wanted.filter(q => !state.done.includes(q));
console.log(`[backfill] готово: ${state.done.length}/${wanted.length} кварталов; осталось: ${remaining.join(', ') || 'нет'}`);
