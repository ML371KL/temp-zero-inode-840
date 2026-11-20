// Сигнал в торговые часы (VPS, контур B бота): процесс рядом с лентой формы 4. Читает дописываемый журнал ленты
// (/var/lib/insider840-feed/ГГГГ-ММ-ДД.jsonl), по каждой новой форме с покупкой пересчитывает событие эмитента (scripts/lib/intraday.mjs:
// те же отсевы и тот же скор, что у ночного списка, цены — из справочника D−1) и пишет файл сигналов дня
// /var/lib/insider840-signals/ГГГГ-ММ-ДД.jsonl — его читает бот (пользователь ib840; каталог ленты для него закрыт).
//
//   node scripts/vps/signal-watch.mjs [--dir /var/lib/insider840-signals] [--feed-dir /var/lib/insider840-feed]
//        [--from 09:25] [--until 16:05] [--poll 1.5] [--once] [--replay] [--day ГГГГ-ММ-ДД] [--dry-run]
//
// Записи файла сигналов (одна JSON в строке, файл только дописывается): run — старт; off — сигналов сегодня не будет (справочника
// D−1 нет или он не на этот день, справочники иностранных эмитентов не готовы) — после неё записей sig не бывает; sig — событие
// эмитента получило скор от SIGNAL.scoreMin (одна на эмитента в день, повторная — только при росте скора); skip — событие сигнала
// не дало (для разбора); stat — задержка «принято SEC → запись формы в журнале ленты» за час.
//
// Сеть процессу не нужна. Журнал ленты он только читает и формата его не меняет; ошибка расчёта по одной форме пишется в журнал
// процесса и не останавливает остальные. Перезапуск безопасен: уже записанные сигналы и пропуски читаются из файла дня, формы дня —
// из журнала ленты заново, повторно ничего не пишется; формы, накопившиеся к старту, в замер задержки не идут.
//
// День выключен (запись off) — выход с кодом 3: тревога юнита, перезапуска нет.
// Тревога контура: медиана задержки за последний час торговых часов выше двух минут (LATENCY) — запись stat с alarm: true и выход
// с ошибкой (тревога юнита, systemd перезапускает процесс), не чаще раза в час — отметка $DIR/state/alarm.json.
// --once — обработать то, что уже лежит в журнале, и выйти; --replay — считать лежащие формы пришедшими «сейчас по их же часам»
// (поля w и acs записи): замер задержки и тревога на прошлых журналах, выхода с ошибкой нет.
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, fstatSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../lib/util.mjs';
import { nyWall, nyToMs } from '../lib/nytime.mjs';
import { isMarketClosed } from '../lib/calendar.mjs';
import { FEED, feedFile, loadFeed } from '../lib/feed.mjs';
import { SIGNAL, LATENCY, DayState, refProblem, splitLines, latencyStat, acceptedMs, inSession } from '../lib/intraday.mjs';

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DIR = argVal('--dir', process.env.SIGNALS_DIR || '/var/lib/insider840-signals');
const FEED_DIR = argVal('--feed-dir', process.env.FEED_DIR || '/var/lib/insider840-feed');
const FROM = argVal('--from', '09:25'), UNTIL = argVal('--until', '16:05');
const POLL_MS = Number(argVal('--poll', '1.5')) * 1000;
const ONCE = args.includes('--once'), REPLAY = args.includes('--replay'), DRY = args.includes('--dry-run');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[signals ${nyWall(Date.now()).slice(11)} ET]`, ...a);
const isoZ = ms => new Date(ms).toISOString().slice(0, 19) + 'Z';

const DAY = argVal('--day', nyWall(Date.now()).slice(0, 10));
if (isMarketClosed(DAY)) { log(`${DAY}: биржа не торгует — сигналов нет`); process.exit(0); }
const OUT = join(DIR, `${DAY}.jsonl`), REF_FILE = join(DIR, 'ref', `${DAY}.json`), ALARM_FILE = join(DIR, 'state', 'alarm.json');
if (!DRY) { mkdirSync(DIR, { recursive: true }); mkdirSync(join(DIR, 'state'), { recursive: true }); }
// Файл читает другой пользователь (ib840): права выставляются явно, от umask юнита не зависят
const write = rec => {
  if (DRY) { console.log(JSON.stringify(rec)); return; }
  const fresh = !existsSync(OUT);
  appendFileSync(OUT, JSON.stringify(rec) + '\n');
  if (fresh) { try { chmodSync(OUT, 0o644); } catch { /* не наш файл */ } }
};

// ---------- справочник и состояние дня ----------
let ref = null, refErr = null;
try { ref = readJson(REF_FILE, null); } catch (e) { refErr = e.message; }
const problem = refErr ? { why: 'bad_ref', text: `справочник D−1 не читается: ${String(refErr).slice(0, 120)}` } : refProblem(ref, DAY);
const restore = existsSync(OUT) ? splitLines(readFileSync(OUT, 'utf8')).recs : [];
const state = new DayState(problem ? { tickers: {} } : ref, DAY, restore);
write({ k: 'run', v: SIGNAL.v, t: isoZ(Date.now()), day: DAY, ref: ref && !refErr ? { asOf: ref.asOf ?? null, for: ref.for ?? null, built: ref.built ?? null, n: ref.n ?? null } : null, poll: FEED.rthIntervalSec });
if (problem) {
  if (!state.off) write({ k: 'off', v: SIGNAL.v, t: isoZ(Date.now()), day: DAY, why: problem.why, text: problem.text });
  state.off = problem.why;
  log(`СИГНАЛОВ СЕГОДНЯ НЕТ: ${problem.text}`);
  // Код 3 — «день выключен»: тревога юнита уходит один раз, перезапуска нет (RestartPreventExitStatus=3). Бот прочитает запись off.
  if (!ONCE && !REPLAY) process.exit(3);
} else if (state.off) {
  log(`сигналы сегодня уже выключены записью off (${state.off}) — до конца дня`);
} else log(`старт: день ${DAY}, справочник по барам ${ref.asOf} (бумаг ${ref.n}); записано раньше: сигналов ${state.sigs.size}, пропусков ${state.skips.size}`);

// ---------- обработка формы ----------
const seenAt = new Map();          // acc -> запись seen ленты: t — когда увидела подачу, upd — время приёма из самой ленты
const samples = [];                // задержка по формам, пришедшим при работающем процессе
let lastStat = null, alarmSaid = 0;
function onRecord(r, { live, nowMs }) {
  if (r.k === 'seen') { seenAt.set(r.acc, { t: r.t ?? null, upd: r.upd ?? null }); return; }
  if (r.k !== 'form') return;
  const seen = seenAt.get(r.acc);
  // Момент записи формы в журнал: поле w; у записей прежнего сборщика его нет — берётся время, когда лента увидела подачу
  const wMs = Date.parse(r.w ?? '') || Date.parse(seen?.t ?? '') || nowMs;
  if (live) {
    // Время приёма SEC: поле acs (с секундами); у прежних записей — время из ленты (upd), иначе минутное at
    const at = r.acs ? acceptedMs(r) : (Date.parse(seen?.upd ?? '') || acceptedMs(r));
    // в замер — формы, принятые сегодня в основную сессию
    if (at !== null && inSession(at, DAY)) samples.push({ t: wMs, lat: Math.max(0, (wMs - at) / 1000) });
  }
  let out = [];
  try { out = state.onForm(r, { seenAt: seen?.t ? isoZ(Date.parse(seen.t)) : null, nowMs: REPLAY ? wMs : nowMs }); }
  catch (e) { log(`форма ${r.acc}: расчёт не удался — ${e.message}`); }
  for (const rec of out) {
    write(rec);
    if (rec.k === 'sig') log(`СИГНАЛ ${rec.t} · скор ${rec.score} · №${rec.n} · покупка $${rec.mx} · оборот $${Math.round(rec.dv / 1e6)} млн · принята ${rec.at ?? '—'}${live ? '' : ' (накопившаяся форма)'}`);
  }
}
function stat(nowMs, { force = false } = {}) {
  const s = latencyStat(samples, nowMs);
  if (s.alarm) {
    const last = DRY ? alarmSaid : (readJson(ALARM_FILE, {})?.t ?? 0);
    if (nowMs - Math.max(last, alarmSaid) >= LATENCY.alarmEveryMin * 60e3) {
      alarmSaid = nowMs;
      write({ k: 'stat', v: SIGNAL.v, t: isoZ(nowMs), n: s.n, med: s.med, p90: s.p90, ok90: s.ok90, alarm: true });
      log(`ТРЕВОГА: медиана задержки ленты за час ${s.med} с (форм ${s.n}) — выше ${LATENCY.alarmSec} с: сигналы приходят с опозданием`);
      if (!DRY) writeFileSync(ALARM_FILE, JSON.stringify({ t: nowMs, med: s.med, n: s.n }));
      if (!REPLAY && !ONCE) process.exit(1);
    }
  }
  lastStat ??= nowMs;
  if (force || nowMs - lastStat >= 60 * 60e3) {
    lastStat = nowMs;
    if (s.n) write({ k: 'stat', v: SIGNAL.v, t: isoZ(nowMs), n: s.n, med: s.med, p90: s.p90, ok90: s.ok90, alarm: false });
  }
}

// ---------- накопившееся к старту ----------
// Формы с датой подачи DAY лежат и в журналах прошлых дней: принятая вчера после 17:30 получает сегодняшнюю дату подачи
{
  const j = loadFeed(FEED_DIR, DAY, FEED.backDays);
  for (const [a, r] of j.seen) seenAt.set(a, { t: r.t ?? null, upd: r.upd ?? null });
  const today = existsSync(feedFile(FEED_DIR, DAY)) ? splitLines(readFileSync(feedFile(FEED_DIR, DAY))).recs.filter(r => r.k === 'form').map(r => r.acc) : [];
  const inToday = new Set(today);
  // прошлые дни — сейчас; сегодняшний файл читается ниже с начала (в режиме --replay его формы идут как «живые»)
  for (const r of j.forms.values()) if (!inToday.has(r.acc)) onRecord(r, { live: false, nowMs: Date.now() });
}

// ---------- хвост сегодняшнего журнала ----------
const TODAY_FILE = feedFile(FEED_DIR, DAY);
let offset = 0, rest = '', first = true;
function readNew() {
  if (!existsSync(TODAY_FILE)) return 0;
  const fd = openSync(TODAY_FILE, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < offset) { offset = 0; rest = ''; }                 // файл заменён — читаем заново (состояние повторов не допустит)
    if (size === offset) return 0;
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    // остаток режется по байтам: недописанная строка может кончаться посреди многобайтного символа
    const all = Buffer.concat([Buffer.from(rest, 'latin1'), buf]);
    const cut = all.lastIndexOf(0x0a);
    offset = size;
    if (cut < 0) { rest = all.toString('latin1'); return 0; }
    rest = all.subarray(cut + 1).toString('latin1');
    const { recs } = splitLines(all.subarray(0, cut + 1));
    const live = !first || REPLAY;
    for (const r of recs) {
      const nowMs = REPLAY ? (Date.parse(r.w ?? r.t ?? '') || Date.parse(seenAt.get(r.acc)?.t ?? '') || Date.now()) : Date.now();
      onRecord(r, { live, nowMs });
      if (REPLAY && r.k === 'form') stat(nowMs);
    }
    return recs.length;
  } finally { closeSync(fd); first = false; }
}

const endMs = nyToMs(`${DAY}T${UNTIL}`), startMs = nyToMs(`${DAY}T${FROM}`);
if (!ONCE && startMs && Date.now() < startMs) { log(`рано: ждём ${FROM} ET`); await sleep(startMs - Date.now()); }
for (;;) {
  try { readNew(); } catch (e) { log(`журнал ленты не читается: ${e.message}`); }
  if (!REPLAY) stat(Date.now());
  if (ONCE || (endMs && Date.now() >= endMs)) break;
  await sleep(POLL_MS);
}
if (!REPLAY) stat(Date.now(), { force: true });
else { const s = latencyStat(samples, Math.max(0, ...samples.map(x => x.t)), { ...LATENCY, windowMin: 1e7 }); log(`повтор журнала: форм торговых часов ${s.n}, медиана ${s.med} с, 90% — ${s.p90} с, не позже ${LATENCY.okSec} с — ${s.ok90 === null ? '—' : (s.ok90 * 100).toFixed(1) + '%'}`); }
log(`конец: сигналов ${state.sigs.size}, пропусков ${state.skips.size}${state.off ? `, день выключен (${state.off})` : ''}`);
