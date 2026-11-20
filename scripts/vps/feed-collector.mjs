// Лента формы 4 на весь день (VPS): getcurrent EDGAR раз в 30–60 секунд с 06:00 до 22:00 по Нью-Йорку -> номера подач и разобранные формы дня
// в журнал JSONL (/var/lib/insider840-feed/ГГГГ-ММ-ДД.jsonl). В 22:03 сборка списка (morning-build.mjs) сверяет индекс EDGAR с лентой:
// второй, независимый путь к тем же подачам. Нет индекса к 23:30 ET — список собирается по ленте с пометкой источника.
//
//   node scripts/vps/feed-collector.mjs [--dir /var/lib/insider840-feed] [--from 06:00] [--until 22:00] [--interval 45] [--rth-interval 15] [--once] [--dry-run]
// --rth-interval — шаг опроса в основную сессию биржи (по умолчанию FEED.rthIntervalSec; 0 — как --interval весь день).
//
// Ограничения: SEC — только politeFetch с SEC_UA проекта, не чаще 2,5 запроса в секунду (запас до 10 в секунду, которые SEC разрешает
// с адреса: в 22:03 рядом работает сборка списка); лента — до 300 записей на такт (три страницы), глубже не идём:
// если все три страницы целиком новые, это «разрыв» (gap) и он виден в журнале — индекс подберёт пропущенное.
// Перезапуск безопасен: замеченные и разобранные подачи читаются из журналов последних дней. Сбой такта не роняет сборщик; слепота
// дольше FEED.blindExitMin минут — выход с ошибкой (тревога юнита и перезапуск).
//
// Устойчивость (аудит форм 17.11.2026, находка 5: 16.11 шесть часов сбоев сети, слепые окна до 103 минут, ни одной тревоги):
//  - таймаут запроса 10 с и один повтор вместо 60 с и двух: зависший запрос держал такт до 230 с;
//  - сбой страницы ленты не отменяет скачивание уже замеченных форм (форма, замеченная за минуту до сбоя, ждала разбора 24 минуты);
//  - несдающиеся подряд формы не затягивают такт: после FORM_FAILS_MAX сбоев подряд остаток очереди ждёт следующего такта;
//  - первый такт дня не перекачивает вчерашние формы: замеченное и разобранное читается и из журналов прошлых дней;
//  - выход с ошибкой — по ВРЕМЕНИ слепоты, а не по числу сбоев: такт со сбоем длится от ~22 до ~90 с плюс 45 с паузы, и «30 сбоев
//    подряд» означало от 34 минут до полутора часов без тревоги (16.11 серия из 26 сбоев шла 103 минуты и до порога не дошла).
//    При пороге 15 минут юнит выходит не чаще четырёх раз в час (15 мин слепоты + 30 с RestartSec), предел перезапусков юнита
//    (StartLimitBurst=6 за час) не достигается — сборщик переживает сбой любой длины и возвращается сам.
import { appendFileSync, mkdirSync } from 'node:fs';
import { politeFetch, SEC_UA } from '../lib/util.mjs';
import { parseForm4Txt, acceptedAt, acceptedAtSec, edgarBase, PARSER_REV } from '../lib/edgar.mjs';
import { nyWall, nyToMs } from '../lib/nytime.mjs';
import { FEED, feedFile, loadFeed, pruneFeed, parseAtom, filingPath, formComplete, feedIntervalSec } from '../lib/feed.mjs';

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DIR = argVal('--dir', process.env.FEED_DIR || '/var/lib/insider840-feed');
const FROM = argVal('--from', FEED.from);
const UNTIL = argVal('--until', FEED.until);
const INTERVAL_MS = Number(argVal('--interval', String(FEED.intervalSec))) * 1000;
const RTH_INTERVAL_SEC = Number(argVal('--rth-interval', String(FEED.rthIntervalSec)));
const ONCE = args.includes('--once');
const DRY = args.includes('--dry-run');
const GAP_MS = 400;                                              // ≤ 2,5 запроса в секунду к SEC
const FORM_FAILS_MAX = 3;                                        // столько подач подряд не скачалось — остаток очереди до следующего такта
// Порог слепоты для выхода с ошибкой, минут (--blind-exit-min — только для самотестов)
const BLIND_EXIT_MIN = Number(argVal('--blind-exit-min', String(FEED.blindExitMin)));
const blindExit = (failedTicks, blindMin) => failedTicks >= FEED.blindMinTicks && blindMin >= BLIND_EXIT_MIN;
const PAGES = 3, PAGE = 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[feed ${nyWall(Date.now()).slice(11)} ET]`, ...a);
const feedUrl = start => `${edgarBase()}/cgi-bin/browse-edgar?action=getcurrent&type=4&owner=only&count=${PAGE}&output=atom&start=${start}`;

if (!DRY) mkdirSync(DIR, { recursive: true });
const dayFile = () => feedFile(DIR, nyWall(Date.now()).slice(0, 10));
const write = rec => { if (!DRY) appendFileSync(dayFile(), JSON.stringify(rec) + '\n'); };

// Состояние — из журналов сегодняшнего и предыдущих дней (FEED.backDays): замеченные, разобранные, попытки скачать. Прошлые дни нужны,
// чтобы первый такт в 06:00 не принимал вчерашние вечерние подачи, ещё стоящие в ленте, за новые (131–146 лишних скачиваний каждое
// утро). Замеченная вчера, но не разобранная подача остаётся в очереди и добирается сегодня.
const seen = new Map(), forms = new Set(), tries = new Map(), netFails = new Map();
// Запуск посреди дня после уже работавшего сегодня сборщика (перезапуск после слепоты, сбоя, перезагрузки): три целиком новые
// страницы на первом такте — настоящий разрыв, а не «накопившееся за ночь»
let restarted = false;
{
  const today = nyWall(Date.now()).slice(0, 10);
  const j = loadFeed(DIR, today, FEED.backDays);
  for (const [a, r] of j.seen) seen.set(a, r);
  for (const a of j.forms.keys()) forms.add(a);
  restarted = loadFeed(DIR, today, 0).runs.length > 0;
}
// Очередь на скачивание: подачи, по которым сеть уже сбоила, идут последними — несдающаяся подача не держит остальных
const pending = () => [...seen.values()]
  .filter(s => !forms.has(s.acc) && (tries.get(s.acc) ?? 0) < FEED.maxTries && (netFails.get(s.acc) ?? 0) < FEED.maxNetFails)
  .sort((a, b) => (netFails.get(a.acc) ?? 0) - (netFails.get(b.acc) ?? 0));

async function get(url) {
  const { body } = await politeFetch(url, { ua: SEC_UA, as: 'text', retries: FEED.retries, timeoutMs: FEED.timeoutMs, intervalMs: GAP_MS });
  return body;
}

// Скачать и разобрать подачу; false — файла ещё нет (повторим на следующем такте)
async function fetchForm(s) {
  // fetchFiling не передаёт свой интервал, а у хоста по умолчанию ~7 запросов в секунду: подачи качаются тем же полите-запросом, что и страницы ленты
  let txt;
  try { txt = await get(`${edgarBase()}/Archives/${filingPath(s.cik, s.acc)}`); }
  catch (e) { netFails.set(s.acc, (netFails.get(s.acc) ?? 0) + 1); throw e; }       // сбой сети: попытка не списывается, подача — в конец очереди
  tries.set(s.acc, (tries.get(s.acc) ?? 0) + 1);
  if (!txt) return false;
  // Оборванный файл в журнал не пишется: запись без сделок выглядела бы разобранной формой, и подачу больше никто бы не скачал
  if (!formComplete(txt)) throw new Error('файл подачи оборван — повтор на следующем такте');
  const head = txt.slice(0, txt.indexOf('<XML>') >= 0 ? txt.indexOf('<XML>') : 4000);
  const at = acceptedAt(head);
  const filed = s.filed ?? (at ? at.slice(0, 10) : null);
  const parsed = parseForm4Txt(txt, s.acc, filed);
  // rev — ревизия разбора, end — файл подачи скачан целиком: ночная сборка берёт из журнала только формы, разобранные её же
  // разбором и полные (live.mjs --feed-dir), остальные качает сама
  // acs и w — для процесса сигналов в торговые часы (scripts/vps/signal-watch.mjs): время приёма SEC с секундами и момент записи
  write({ k: 'form', acc: s.acc, filed, at: at ?? null, acs: acceptedAtSec(head), w: new Date().toISOString(), rev: PARSER_REV, end: true, trades: parsed.trades, amend: parsed.amend });
  forms.add(s.acc);
  return true;
}

async function tick(stat) {
  let gap = false, pageErr = null;
  const backlog = stat.polls === 0 && !restarted;                  // первый такт первого запуска дня: накопившееся за ночь — не разрыв
  try {
    for (let page = 0; page < PAGES; page++) {
      const entries = parseAtom(await get(feedUrl(page * PAGE)));
      stat.polls++;
      if (!entries.length) break;
      const fresh = entries.filter(e => !seen.has(e.acc) && (e.form == null || e.form === '4' || e.form === '4/A'));
      for (const e of fresh) {
        const rec = { k: 'seen', acc: e.acc, cik: e.cik, form: e.form, filed: e.filed, upd: e.updated, t: new Date().toISOString() };
        seen.set(e.acc, rec);
        write(rec);
      }
      if (!fresh.length) break;                                    // страница целиком знакома — глубже не идём
      if (page === PAGES - 1 && fresh.length === entries.length && !backlog) gap = true;
    }
  } catch (e) { pageErr = e; }                                    // страница не ответила: замеченные раньше формы всё равно качаем
  let got = 0, fails = 0;
  for (const s of pending()) {
    try { if (await fetchForm(s)) got++; fails = 0; }
    catch (e) {
      stat.errors++; log(`подача ${s.acc}: ${e.message}`);
      if (++fails >= FORM_FAILS_MAX) { log(`${fails} подачи подряд не скачались — остаток очереди ждёт следующего такта`); break; }
    }
  }
  stat.forms += got;
  if (gap) { stat.gaps++; log('РАЗРЫВ: три страницы ленты целиком новые — часть подач могла выпасть, их подберёт индекс'); }
  if (pageErr) throw pageErr;                                     // такт считается сбойным: ленту не прочитали
  return got;
}

const stat = { polls: 0, errors: 0, forms: 0, gaps: 0 };
let failed = 0, blindSince = null, lastStat = Date.now();
pruneFeed(DIR, nyWall(Date.now()).slice(0, 10));
write({ k: 'run', start: new Date().toISOString(), from: FROM, until: UNTIL, interval: INTERVAL_MS / 1000, rth: RTH_INTERVAL_SEC, v: 1, rev: PARSER_REV });
log(`старт: журнал ${DIR}, уже замечено ${seen.size}, разобрано ${forms.size}; окно ${FROM}–${UNTIL} ET`);
const wallDay = () => nyWall(Date.now()).slice(0, 10);
const startMs = nyToMs(`${wallDay()}T${FROM}`), endMs = nyToMs(`${wallDay()}T${UNTIL}`);
if (!ONCE && startMs && Date.now() < startMs) { log(`рано: ждём ${FROM} ET`); await sleep(startMs - Date.now()); }
for (;;) {
  try {
    const n = await tick(stat);
    failed = 0; blindSince = null;
    if (n) log(`новых разобранных подач: ${n}; замечено ${seen.size}, разобрано ${forms.size}, ждут ${pending().length}`);
  } catch (e) {
    failed++; stat.errors++;
    blindSince ??= Date.now();
    const blindMin = (Date.now() - blindSince) / 60e3;
    log(`сбой такта (${failed} подряд, лента не читается ${blindMin.toFixed(1)} мин): ${e.message}`);
    if (blindExit(failed, blindMin)) {
      write({ k: 'stat', t: new Date().toISOString(), seen: seen.size, forms: forms.size, pending: pending().length, ...stat, blind: Math.round(blindMin) });
      log(`лента не читается ${Math.round(blindMin)} мин (${failed} тактов подряд) — выход с ошибкой`);
      process.exit(1);
    }
  }
  if (Date.now() - lastStat > 10 * 60e3 || ONCE) {
    write({ k: 'stat', t: new Date().toISOString(), seen: seen.size, forms: forms.size, pending: pending().length, ...stat });
    lastStat = Date.now();
  }
  if (ONCE || (endMs && Date.now() >= endMs)) break;
  await sleep(feedIntervalSec(Date.now(), INTERVAL_MS / 1000, RTH_INTERVAL_SEC) * 1000);
}
write({ k: 'stat', t: new Date().toISOString(), seen: seen.size, forms: forms.size, pending: pending().length, ...stat, end: true });
log(`конец: замечено ${seen.size}, разобрано ${forms.size}, ошибок ${stat.errors}, разрывов ${stat.gaps}`);
