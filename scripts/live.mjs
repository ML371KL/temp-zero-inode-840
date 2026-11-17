// Живой контур: дни, не покрытые квартальными датасетами (и ежедневное обновление).
// daily-index EDGAR -> полные .txt сабмишены Form 4/4A -> XML-парсер -> data/trades/live.json.gz.
// Резюмируемый: state/live.json { schema, from, lastDay, coverage, pending, ... }. Бюджет времени — для картриджных прогонов.
// Использование: node scripts/live.mjs [--data data] [--time-budget-min N] [--reread-budget-min N] [--today ГГГГ-ММ-ДД] [--retries N]
//
// Покрытие (контракт для витрины, письма и сторожа — менять только вместе с ними):
//   state.coverage = { "ГГГГ-ММ-ДД": { status, indexed, collected, pending, at } } за последние 40 дней подачи;
//   status ∈ complete | partial | holiday | not-published; indexed — уникальные подачи Form 4/4A в form.idx,
//   collected — разобранные, pending — ждут добора, at — когда день закрыт (UTC). Необязательные: gone, error.
//
// Сбои сети не роняют прогон (до 11.2026 исключение на пробе индекса следующего дня роняло весь
// daily.yml до сборки и письма — 28.10.2026): день ≥ сегодня−1 — «ещё не вышел», стоп; прошлый день —
// шард сохраняется, код выхода 0, ошибка — в покрытие и state.lastError. Подача, которую не удалось
// скачать (сеть, 5xx, лимит SEC), не теряется: она ложится в state.pending и добирается следующими прогонами.
import { readJson, writeJson, readJsonGz, writeJsonGz, isoToday, addDaysIso, isIsoDate, politeFetch } from './lib/util.mjs';
import { fetchDayIndex, fetchFiling, parseForm4Txt, uniqueFilings, secKey, edgarBase, SHARD_VERSION, PARSER_REV } from './lib/edgar.mjs';
import { fpiFormsPath, emptyFpiForms, absorbFpiForms, parseFpiIdx, fillQuartersFor, fullIndexUrl, fullIndexText } from './lib/fpi.mjs';
import { isWeekend, nextWeekday, missingIndexVerdict, shouldProbeNext, coverageEntry, pruneCoverage, firstUncoveredDay, windowStart } from './lib/livecal.mjs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const DATA = argVal('--data', 'data');
const BUDGET_MS = Number(argVal('--time-budget-min', '300')) * 60000;
const REREAD_BUDGET_MS = Number(argVal('--reread-budget-min', '25')) * 60000;
const RETRIES = Number(argVal('--retries', '4'));
// Фоновое перечитывание качает в несколько потоков: общий троттлинг по хосту (lib/util.mjs) всё равно
// держит не больше ~7 запросов в секунду к SEC, а очередь окна — десятки тысяч подач.
const REREAD_CONCURRENCY = Number(argVal('--reread-concurrency', '4'));
const today = argVal('--today', isoToday());   // --today — только для самотестов и ручной проверки
// Начальное наполнение справочника отчётов иностранных эмитентов (lib/fpi.mjs) из квартальных полных индексов SEC. Флаг передаёт
// только ежедневная сборка GitHub: ночная сборка на сервере полные индексы не качает (её ждёт список), а дни подачи дописывают обе.
const FPI_FILL = args.includes('--fpi-fill');
const started = Date.now();
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const overBudget = () => Date.now() - started > BUDGET_MS;

// Первый непокрытый датасетами день выводится из state/backfill.json
const backfillState = readJson(join(DATA, 'state', 'backfill.json'), { done: [] });
const defaultFrom = firstUncoveredDay(backfillState.done);

const statePath = join(DATA, 'state', 'live.json');
const state = readJson(statePath, {});
const shardPath = join(DATA, 'trades', 'live.json.gz');
const from = windowStart(state.from, backfillState.done);

const rawShard = readJsonGz(shardPath, null);
const shard = rawShard && !Array.isArray(rawShard) ? rawShard : { v: SHARD_VERSION, trades: [], amend: [] };
// Нужно ли перечитывать, решаем по СОДЕРЖИМОМУ шарда, а не по метке в состоянии (см. историю в памяти проекта):
// признак разбора новым парсером — наличие поля ownD. Поле at (время приёма) сюда НЕ входит.
const staleDates = shard.trades.filter(r => !('ownD' in r)).map(r => r.fdate);
const staleRows = staleDates.length;
// Неустранимый остаток строк старой схемы (филинга нет в индексе, поправка другим днём) — пол,
// иначе самовосстанавливающаяся проверка зациклилась бы.
const staleFloor = state.staleFloor ?? 0;
const needReread = staleRows > staleFloor;
const firstStale = needReread ? staleDates.reduce((a, b) => b < a ? b : a) : null;
const schemaChanged = state.schema !== SHARD_VERSION || needReread;
if (schemaChanged && shard.trades.length) {
  console.log(`[live] перечитываю хвост с ${firstStale ?? from}: строк старой схемы ${staleRows} из ${shard.trades.length}, накопленное сохраняю`);
}
// Строки, покрытые уже загруженными квартальными датасетами, из live-шарда вычищаются
const before = shard.trades.length;
shard.trades = shard.trades.filter(r => r.fdate >= from);
shard.amend = shard.amend.filter(a => a.orig >= '2000-01-01');
if (shard.trades.length !== before) console.log(`[live] вычищено ${before - shard.trades.length} строк, покрытых датасетами`);

// Кто подаёт отчёты иностранного частного эмитента (20-F, 40-F, 6-K): строки того же дневного индекса, из которого берутся формы 4
const fpiPath = fpiFormsPath(DATA);
const fpiRef = readJson(fpiPath, emptyFpiForms());
let fpiDirty = false;

const rowKey = r => `${r.acc}|${r.code}|${r.tdate}|${secKey(r.sec)}`;
const byKey = new Map(shard.trades.map(r => [rowKey(r), r]));
const keysByAcc = new Map();
for (const k of byKey.keys()) { const acc = k.slice(0, k.indexOf('|')); (keysByAcc.get(acc) ?? keysByAcc.set(acc, new Set()).get(acc)).add(k); }
const amendByAcc = new Map(shard.amend.map(a => [a.acc, a]));

// Строки одной подачи: добавить недостающие или (replace) заменить все строки подачи свежим разбором.
// replace нужен там, где подачу перечитывают ради исправленного парсера: иначе старая строка с прежним
// ключом (например, с датой «2026-06-16-05:00») осталась бы рядом с новой.
let added = 0;
function ingest(txt, acc, fdate, { replace = false } = {}) {
  const parsed = parseForm4Txt(txt, acc, fdate);
  if (replace) {
    for (const k of keysByAcc.get(acc) ?? []) byKey.delete(k);
    keysByAcc.delete(acc);
    amendByAcc.delete(acc);
  }
  for (const r of parsed.trades) {
    const key = rowKey(r);
    // При перечитывании после смены схемы строка замещается свежим разбором, при обычном прогоне добавляется недостающая
    if (!byKey.has(key)) added++;
    else if (!schemaChanged && !replace) continue;
    byKey.set(key, r);
    (keysByAcc.get(acc) ?? keysByAcc.set(acc, new Set()).get(acc)).add(key);
  }
  for (const a of parsed.amend) if (replace || !amendByAcc.has(a.acc)) amendByAcc.set(a.acc, a);
  return parsed.trades.length;
}

// Простой пул: fn по элементам, не больше n одновременно; stop() — прекратить выдачу новых.
async function pool(items, n, fn, stop = () => false) {
  let i = 0;
  const worker = async () => { while (i < items.length && !stop()) { const k = i++; await fn(items[k]); } };
  await Promise.all(Array.from({ length: Math.max(1, n) }, worker));
  return i >= items.length;
}

// Скачать подачу по любому из её путей (под CIK эмитента и под CIK каждого подателя).
// -> { txt } | { gone: true } (404 по всем путям) | { error }
// Предохранитель: несколько подач подряд упёрлись в лимит SEC (403 с HTML) после всех повторов — значит, SEC
// режет этот адрес. Блок снимается после ~10 минут тишины, а каждая следующая подача ещё ~90 с повторяла бы
// запрос впустую. Дальше в этом прогоне SEC не трогаем: остаток дня — в добор без попытки, следующие дни —
// следующему прогону.
const RL_STREAK_MAX = Number(argVal('--ratelimit-streak', '3'));
let rlStreak = 0, secBlocked = false;
async function download(paths) {
  let lastErr = null;
  for (const p of paths) {
    try {
      const txt = await fetchFiling(p, { retries: RETRIES });
      if (txt) { rlStreak = 0; return { txt }; }
    } catch (e) { lastErr = e; }
  }
  if (!lastErr) { rlStreak = 0; return { gone: true }; }      // 404 по всем адресам; что это значит — решает isFreshDay ниже
  const msg = String(lastErr.message ?? lastErr);
  if (/лимит SEC/.test(msg) && ++rlStreak >= RL_STREAK_MAX && !secBlocked) {
    secBlocked = true;
    lastError = { at: nowIso(), day, msg: `лимит SEC: ${rlStreak} подачи подряд — дальше в этом прогоне не запрашиваем` };
    console.log(`[live] SEC режет запросы (${rlStreak} подачи подряд с 403 лимита) — остаток в добор, дальше в этом прогоне SEC не трогаем`);
  }
  return { error: msg };
}

// «Нет файла» по подаче из индекса СВЕЖЕГО дня — не «подачу сняли». В ночь 06.11.2026 SEC в 22:03–22:06 ET ответила 404 по всем
// адресам 31 подачи из 515; сборка на сервере сочла их снятыми, пометила день полным и потеряла 14 строк сделок, а через полчаса
// сборка GitHub тем же кодом скачала все 515 (аудит форм 17.11.2026, находка 3). Поэтому у дня индекса не старше суток (сегодня
// или вчера по UTC — ночная сборка идёт в 03:0x UTC следующих суток) такая подача ложится в добор: повтор в конце прохода и в
// следующих прогонах, день — partial. Снятой подача считается только у дня старше суток.
const NO_FILE = 'нет файла (404)';
const isFreshDay = d => addDaysIso(d, 1) >= today;

// ---------- состояние покрытия и добора ----------
const coverage = { ...(state.coverage ?? {}) };
const pending = {};          // день -> { acc: { paths, tries, err } }
for (const [d, m] of Object.entries(state.pending ?? {})) pending[d] = { ...m };
let lastError = state.lastError ?? null;
const pendingCount = d => Object.keys(pending[d] ?? {}).length;
function pend(day, acc, paths, err, bumpTry = true) {
  const m = pending[day] ?? (pending[day] = {});
  const prev = m[acc];
  m[acc] = { paths, tries: (prev?.tries ?? 0) + (bumpTry ? 1 : 0), err: err ? String(err).slice(0, 160) : (prev?.err ?? null) };
}
function settle(day) {
  const c = coverage[day];
  if (!c || c.status === 'holiday' || c.status === 'not-published') return;
  const p = pendingCount(day);
  Object.assign(c, coverageEntry({ indexed: c.indexed, collected: c.collected, pending: p, gone: c.gone ?? 0, at: c.at, error: p ? c.error : null }));
  if (!p) { delete pending[day]; if (c.status === 'complete') delete c.error; }
}

// Перечитывание после смены схемы начинается с первого устаревшего дня и резюмируется: прогресс в lastDay,
// метка migrating не даёт следующему прогону начать всё заново.
const startingMigration = schemaChanged && !state.migrating;
const cursor = startingMigration
  ? (firstStale ? addDaysIso(firstStale, -1) : null)
  : (state.lastDay ?? null);
let day = cursor ? addDaysIso(cursor, 1) : from;
let lastCompleted = cursor;
let daysDone = 0, filingsDone = 0;

// Начальное наполнение справочника отчётов: полные индексы текущего и четырёх предыдущих кварталов (по ~5 МБ). Квартал, который не
// скачался, повторится следующим прогоном; пока наполнение не закончено (fillDone), сборка пометку по отчётам не ставит.
async function fillFpiForms() {
  const want = fillQuartersFor(today);
  for (const { y, q, key } of want) {
    if (fpiRef.filled?.includes(key)) continue;
    if (overBudget() || secBlocked) break;
    try {
      const { body } = await politeFetch(fullIndexUrl(edgarBase(), y, q), { retries: RETRIES, timeoutMs: 120000 });
      if (!body) { console.log(`[live] справочник отчётов иностранных эмитентов: полного индекса ${key} нет — повтор в следующем прогоне`); continue; }
      const rows = parseFpiIdx(fullIndexText(body));
      absorbFpiForms(fpiRef, rows, rows.reduce((m, x) => (x.date > m ? x.date : m), ''));
      (fpiRef.filled ??= []).push(key);
      fpiDirty = true;
      console.log(`[live] справочник отчётов иностранных эмитентов: ${key} — строк ${rows.length}, эмитентов всего ${Object.keys(fpiRef.ciks).length}`);
    } catch (e) { console.log(`[live] справочник отчётов иностранных эмитентов: ${key} не скачан (${e.message}) — повтор в следующем прогоне`); }
  }
  if (!fpiRef.fillDone && want.every(x => fpiRef.filled?.includes(x.key))) { fpiRef.fillDone = true; fpiDirty = true; console.log('[live] справочник отчётов иностранных эмитентов наполнен'); }
}

function save() {
  if (fpiDirty) { writeJson(fpiPath, fpiRef); fpiDirty = false; }
  shard.trades = [...byKey.values()];
  shard.amend = [...amendByAcc.values()];
  shard.v = SHARD_VERSION;
  writeJsonGz(shardPath, shard);
  // Версия помечается только когда хвост перечитан до конца
  const caughtUp = lastCompleted && addDaysIso(lastCompleted, 4) >= today;
  const done = !schemaChanged || caughtUp;
  const staleNow = shard.trades.filter(r => !('ownD' in r)).length;
  const floor = done && schemaChanged ? staleNow : Math.min(staleFloor, staleNow);
  const pendOut = {};
  for (const [d, m] of Object.entries(pending)) if (Object.keys(m).length && d >= addDaysIso(today, -40)) pendOut[d] = m;
  writeJson(statePath, {
    schema: done ? SHARD_VERSION : (state.schema ?? 1),
    migrating: done ? undefined : true,
    staleFloor: floor || undefined,
    parserRev: state.parserRev ?? undefined,
    reread: state.reread ?? undefined,
    from, lastDay: lastCompleted, updated: isoToday(),
    coverage: pruneCoverage(coverage, today),
    pending: Object.keys(pendOut).length ? pendOut : undefined,
    lastError: lastError ?? undefined,
  }, true);
}

async function run() {
  if (FPI_FILL && !fpiRef.fillDone) await fillFpiForms();

  // ---------- 1. добор отложенных подач прошлых прогонов ----------
  let picked = 0, still = 0;
  for (const d of Object.keys(pending).sort()) {
    if (d < addDaysIso(today, -40)) { delete pending[d]; continue; }
    for (const [acc, p] of Object.entries(pending[d])) {
      if (overBudget() || secBlocked) break;
      const res = await download(p.paths);
      if (res.txt) {
        ingest(res.txt, acc, d); filingsDone++; picked++;
        delete pending[d][acc];
        if (coverage[d]) coverage[d].collected = (coverage[d].collected ?? 0) + 1;
      } else if (res.gone && isFreshDay(d)) {
        pend(d, acc, p.paths, NO_FILE); still++;       // файла всё ещё нет, а день свежий — ждём дальше
      } else if (res.gone) {
        delete pending[d][acc];
        if (coverage[d]) coverage[d].gone = (coverage[d].gone ?? 0) + 1;
      } else { pend(d, acc, p.paths, res.error); still++; }
    }
    settle(d);
  }
  if (picked || still) console.log(`[live] добор отложенных: собрано ${picked}, ещё ждут ${still}`);

  // ---------- 2. починка строк с датой сделки в поясе («2026-06-16-05:00») ----------
  // Определяется по содержимому шарда; подача перечитывается по пути эмитента и замещает свои строки.
  const badAcc = new Map();
  for (const r of byKey.values()) if (!isIsoDate(String(r.tdate))) badAcc.set(r.acc, r);
  if (badAcc.size) {
    let fixed = 0, failed = 0;
    for (const [acc, r] of badAcc) {
      if (overBudget() || secBlocked) break;
      const path = `edgar/data/${r.cik}/${acc.replace(/-/g, '')}/${acc}.txt`;
      const res = await download([path]);
      if (res.txt) { ingest(res.txt, acc, r.fdate, { replace: true }); fixed++; filingsDone++; } else failed++;
    }
    console.log(`[live] перечитаны подачи с датой в поясе: ${fixed} из ${badAcc.size}${failed ? `, не удалось ${failed}` : ''}`);
  }

  // ---------- 3. новые дни ----------
  outer:
  while (day <= today && !secBlocked) {
    if (isWeekend(day)) { lastCompleted = day; day = addDaysIso(day, 1); continue; }
    let entries, fpi;
    try {
      ({ entries, fpi } = await fetchDayIndex(day, { retries: RETRIES }));
    } catch (e) {
      // Индекс не скачался после всех повторов. Прошлый день не помечаем пройденным — следующий прогон
      // спросит снова; что собрано до этого, сохраняется.
      const msg = String(e.message ?? e);
      const verdict = addDaysIso(day, 1) >= today ? 'not-published' : 'partial';
      coverage[day] = { ...(coverage[day] ?? {}), status: verdict, error: msg.slice(0, 200), at: nowIso() };
      lastError = { at: nowIso(), day, msg: msg.slice(0, 300) };
      console.log(`[live] ${day}: индекс не скачался (${msg}) — стоп, день не пройден`);
      break;
    }
    if (!entries) {
      let nextHas = null;
      if (shouldProbeNext(day, today)) {
        try { nextHas = !!(await fetchDayIndex(nextWeekday(day), { retries: RETRIES })).entries; } catch { nextHas = null; }
      }
      const verdict = missingIndexVerdict(day, today, nextHas);
      if (verdict === 'not-published') {
        coverage[day] = { status: 'not-published', at: nowIso() };
        console.log(`[live] ${day}: индекс ещё не опубликован — стоп`);
        break;
      }
      coverage[day] = { status: 'holiday', at: nowIso() };
      console.log(`[live] ${day}: индекса нет, следующий рабочий день его уже не ждёт — праздник SEC`);
      lastCompleted = day; day = addDaysIso(day, 1);
      continue;
    }
    if (absorbFpiForms(fpiRef, fpi, day)) fpiDirty = true;
    // Одна подача — по строке на эмитента и каждого подателя: качаем один раз, остальные пути — запасные
    const paths = new Map();
    for (const e of entries) (paths.get(e.acc) ?? paths.set(e.acc, []).get(e.acc)).push(e.path);
    const filings = uniqueFilings(entries);
    const prevPending = pending[day] ?? {};
    let collected = 0, gone = 0, budgetHit = false;
    const noFile = [];          // подачи свежего дня с ответом «нет файла»: повтор в конце прохода
    for (const f of filings) {
      const ps = paths.get(f.acc);
      if (budgetHit || overBudget() || secBlocked) {
        // Бюджет кончился или SEC режет запросы посреди дня: остаток не теряется — уходит в добор следующего прогона
        if (!budgetHit && !secBlocked) console.log(`[live] бюджет времени исчерпан на ${day} (${filingsDone} подач) — остаток дня в добор`);
        budgetHit = true;
        if (!prevPending[f.acc]) pend(day, f.acc, ps, secBlocked ? 'лимит SEC' : 'бюджет времени', false);
        continue;
      }
      const res = await download(ps);
      if (res.txt) {
        ingest(res.txt, f.acc, day); filingsDone++; collected++;
        if (pending[day]) delete pending[day][f.acc];
      } else if (res.gone && isFreshDay(day)) { pend(day, f.acc, ps, NO_FILE); noFile.push(f); }
      else if (res.gone) gone++;
      else { pend(day, f.acc, ps, res.error); console.log(`[live] ${day}: ${f.acc} отложена (${res.error})`); }
    }
    if (noFile.length) {
      let back = 0;
      for (const f of noFile) {
        if (budgetHit || overBudget() || secBlocked) break;
        const res = await download(paths.get(f.acc));
        if (res.txt) { ingest(res.txt, f.acc, day); filingsDone++; collected++; back++; delete pending[day][f.acc]; }
      }
      console.log(`[live] ${day}: «нет файла» по ${noFile.length} подачам индекса — повтор в конце прохода вернул ${back}, в доборе ${noFile.length - back}`);
    }
    coverage[day] = { indexed: filings.length, collected, ...(gone ? { gone } : {}), at: nowIso(), ...(secBlocked ? { error: 'лимит SEC' } : {}) };
    settle(day);
    lastCompleted = day;
    daysDone++;
    if (daysDone % 5 === 0) save();
    console.log(`[live] ${day}: ${filings.length} подач (${entries.length} строк индекса), собрано ${collected}, ждут ${pendingCount(day)}, всего строк ${byKey.size}`);
    if (budgetHit) break outer;
    day = addDaysIso(day, 1);
  }

  // ---------- 4. фоновое перечитывание после исправления парсера ----------
  // PARSER_REV растёт, когда меняется разбор уже собранных строк (сноски, даты). Окно [from, lastDay]
  // перечитывается в остаток бюджета, НЕ задерживая сегодняшний день: он уже собран выше. Идём от свежих
  // дней к старым: торговое окно (утренний список, счётчик) получает новый разбор первым.
  // cursor — последний ещё НЕ перечитанный день; окно пройдено, когда он раньше from.
  if ((state.parserRev ?? 1) < PARSER_REV && !state.reread) {
    state.reread = { rev: PARSER_REV, to: lastCompleted ?? from, cursor: lastCompleted ?? from };
    console.log(`[live] парсер ${state.parserRev ?? 1} → ${PARSER_REV}: перечитываю ${from}…${state.reread.to} в фоне`);
  }
  // Прогон, собравший новый день, окно не перечитывает: его ждут список, письмо и сборка (03:25 UTC на GitHub,
  // 22:03 ET на VPS), а перечитывание — до 25 минут. Окно перечитывают прогоны без нового дня (расписание
  // GitHub после утреннего, повторные запуски); ночная сборка на VPS к тому же передаёт --reread-budget-min 0.
  if (state.reread && daysDone > 0) console.log('[live] перечитывание окна отложено: в этом прогоне собран новый день');
  else if (state.reread) {
    const rr = state.reread;
    const rStart = Date.now();
    let d = rr.cursor, n = 0;
    // окно могло сдвинуться вперёд после загрузки квартала: дни раньше from не перечитываем
    while (d >= from && Date.now() - rStart < REREAD_BUDGET_MS && !overBudget() && !secBlocked) {
      if (isWeekend(d)) { d = addDaysIso(d, -1); rr.cursor = d; continue; }
      let entries = null, fpi = null;
      try { ({ entries, fpi } = await fetchDayIndex(d, { retries: RETRIES })); } catch (e) { console.log(`[live] перечитывание: ${d} — ${e.message}, продолжу позже`); break; }
      if (entries) {
        if (absorbFpiForms(fpiRef, fpi, d)) fpiDirty = true;
        const paths = new Map();
        for (const e of entries) (paths.get(e.acc) ?? paths.set(e.acc, []).get(e.acc)).push(e.path);
        const stopNow = () => Date.now() - rStart >= REREAD_BUDGET_MS || overBudget() || secBlocked;
        const ok = await pool(uniqueFilings(entries), REREAD_CONCURRENCY, async f => {
          const res = await download(paths.get(f.acc));
          if (res.txt) { ingest(res.txt, f.acc, d, { replace: true }); n++; }
        }, stopNow);
        if (!ok) break;   // день не дочитан — продолжим с него
      }
      d = addDaysIso(d, -1); rr.cursor = d;
    }
    if (rr.cursor < from) { state.parserRev = rr.rev; delete state.reread; console.log(`[live] перечитывание окна закончено, парсер ${rr.rev}`); }
    else console.log(`[live] перечитано подач ${n}, осталось ${from}…${rr.cursor} (окно до ${rr.to})`);
  }
}

try {
  await run();
} catch (e) {
  // Любой непредвиденный сбой: собранное сохраняется, сборка и письмо идут дальше; сторож видит покрытие
  lastError = { at: nowIso(), day, msg: String(e.stack ?? e).slice(0, 300) };
  console.log(`::error::[live] сбой: ${e.message ?? e}`);
}
save();
const pendTotal = Object.values(pending).reduce((s, m) => s + Object.keys(m).length, 0);
console.log(`[live] готово: дней ${daysDone}, подач ${filingsDone}, новых строк ${added}, в шарде ${byKey.size}, lastDay=${lastCompleted}, ждут добора ${pendTotal}`);
