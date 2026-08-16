// Бэкфил квартальных датасетов SEC 2016q1..последний доступный.
// Резюмируемый: state/backfill.json хранит загруженные кварталы и версию схемы.
// При смене схемы шардов данные сделок пересобираются полностью (цены не трогаются —
// они дороже всего и от схемы сделок не зависят).
// Использование: node scripts/backfill.mjs [--data data] [--max-quarters N]
import { readJson, writeJson, readJsonGz, writeJsonGz, isoToday } from './lib/util.mjs';
import { fetchQuarter, quarterList, SHARD_VERSION } from './lib/edgar.mjs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const DATA = argVal('--data', 'data');
const MAX = Number(argVal('--max-quarters', '999'));
// С какого года тянуть кварталы. По умолчанию 2016 — как было; более ранний старт нужен
// слепой проверке на 2006–2015 (docs/ЗАМОРОЗКА-НАБОРА.md), которая живёт в отдельном
// каталоге данных и рабочую панель не трогает.
const FROM_YEAR = Number(argVal('--from-year', '2016'));

const statePath = join(DATA, 'state', 'backfill.json');
const state = readJson(statePath, { schema: SHARD_VERSION, done: [], missing: [] });

// Пересборка при смене схемы идёт БЕЗ удаления данных: строки замещаются на месте по
// тому же ключу. Раньше каталог сносился целиком, и до конца пересборки compute падал
// на «нет сделок» — прод останавливался на часы. Теперь частично пересобранный набор
// остаётся консистентным, потому что схема v3 не меняет состав строк, а только уточняет
// поля владения; версия помечается лишь когда пройдены все кварталы.
const rebuilding = state.schema !== SHARD_VERSION;
if (rebuilding) {
  if (!state.rebuildFrom) {
    console.log(`[backfill] схема шардов ${state.schema ?? 1} -> ${SHARD_VERSION}: перечитываю кварталы, данные не удаляю`);
    state.rebuildFrom = state.schema ?? 1;
    state.done = [];
    state.missing = [];
  }
  // Состояние живого контура НЕ трогаем. Раньше здесь оно затиралось на {schema: N} —
  // наследие разрушающей миграции, когда каталог сносился вместе с live-шардом. Теперь
  // это вредно: запись помечала живой контур уже перечитанным, он переставал замещать
  // строки и просто пропускал их как дубли. Из 21 272 строк хвоста новым парсером
  // оказались разобраны 6397, а 24 028 филингов скачаны впустую. live.mjs определяет
  // необходимость перечитывания сам, по содержимому шарда.
}

const today = isoToday();
const curYear = Number(today.slice(0, 4));
const curQ = Math.ceil(Number(today.slice(5, 7)) / 3);
const wanted = quarterList(FROM_YEAR, curYear, curQ);
// Нижняя граница года сделки: формы содержат опечатки вроде 1993 и «0013», и раньше
// всё до 2010 отбрасывалось как мусор. При раннем старте граница опускается вместе с ним,
// иначе бэкфил 2006–2009 молча терял бы все свои строки.
const MIN_TRADE_YEAR = String(Math.min(2010, FROM_YEAR));

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
    if (y < MIN_TRADE_YEAR || y > String(curYear + 1)) return null; // мусорные даты в формах
    let e = byYear.get(y);
    if (!e) { e = { trades: [], amend: [] }; byYear.set(y, e); }
    return e;
  };
  for (const r of data.trades) bucket(r.tdate.slice(0, 4))?.trades.push(r);
  for (const a of data.amend) bucket(a.orig.slice(0, 4))?.amend.push(a); // поправка живёт в году оригинала
  const rowKey = r => `${r.acc}|${r.code}|${r.tdate}|${r.sec ?? ''}`;
  for (const [y, add] of byYear) {
    const shard = readShard(y);
    const seenT = new Set(shard.trades.map(rowKey));
    const newT = add.trades.filter(r => !seenT.has(rowKey(r)));
    const seenA = new Set(shard.amend.map(a => a.acc));
    const newA = add.amend.filter(a => !seenA.has(a.acc));
    // При пересборке строка не пропускается как дубль, а ЗАМЕЩАЕТСЯ свежим разбором:
    // ключ строки от схемы не зависит, поэтому замена идемпотентна и безопасна на любом
    // шаге. Обычный прогон, как и раньше, только дописывает недостающее.
    let replaced = 0;
    if (rebuilding) {
      const byKey = new Map(shard.trades.map(r => [rowKey(r), r]));
      for (const r of add.trades) { if (byKey.has(rowKey(r))) replaced++; byKey.set(rowKey(r), r); }
      shard.trades = [...byKey.values()];
      const aByKey = new Map(shard.amend.map(a => [a.acc, a]));
      for (const a of add.amend) aByKey.set(a.acc, a);
      shard.amend = [...aByKey.values()];
      shard.v = SHARD_VERSION;
      writeJsonGz(shardPath(y), shard);
    } else if (newT.length || newA.length) {
      shard.v = SHARD_VERSION;
      shard.trades = shard.trades.concat(newT);
      shard.amend = shard.amend.concat(newA);
      writeJsonGz(shardPath(y), shard);
    }
    console.log(`[backfill] ${q} -> ${y}: +${newT.length} сделок${replaced ? `, перечитано ${replaced}` : ''}, +${newA.length} поправок (всего ${shard.trades.length})`);
  }
  state.done.push(q);
  state.missing = state.missing.filter(x => x !== q);
  state.updated = today;
  writeJson(statePath, state, true);
  processed++;
}
const remaining = wanted.filter(q => !state.done.includes(q) && !state.missing.includes(q));
// Версия схемы помечается только когда пройдены ВСЕ кварталы: до этого набор смешанный,
// и преждевременная отметка остановила бы пересборку на полпути.
if (rebuilding && !remaining.length) {
  state.schema = SHARD_VERSION;
  delete state.rebuildFrom;
  writeJson(statePath, state, true);
  console.log(`[backfill] пересборка схемы завершена: все ${wanted.length} кварталов перечитаны`);
}
console.log(`[backfill] готово: ${state.done.length}/${wanted.length} кварталов; осталось: ${remaining.join(', ') || 'нет'}`
  + (rebuilding && remaining.length ? ` (пересборка схемы ${state.rebuildFrom} -> ${SHARD_VERSION} не завершена)` : ''));
