// Лента формы 4 на весь день (VPS): getcurrent EDGAR раз в 30–60 секунд с 06:00 до 22:00 по Нью-Йорку -> номера подач и разобранные формы дня
// в журнал JSONL (/var/lib/insider840-feed/ГГГГ-ММ-ДД.jsonl). В 22:03 сборка списка (morning-build.mjs) сверяет индекс EDGAR с лентой:
// второй, независимый путь к тем же подачам. Нет индекса к 23:30 ET — список собирается по ленте с пометкой источника.
//
//   node scripts/vps/feed-collector.mjs [--dir /var/lib/insider840-feed] [--from 06:00] [--until 22:00] [--interval 45] [--once] [--dry-run]
//
// Ограничения: SEC — только politeFetch с SEC_UA проекта, не чаще 2,5 запроса в секунду (запас до 10 в секунду, которые SEC разрешает
// с адреса: в 22:03 рядом работает сборка списка); лента — до 300 записей на такт (три страницы), глубже не идём:
// если все три страницы целиком новые, это «разрыв» (gap) и он виден в журнале — индекс подберёт пропущенное.
// Перезапуск безопасен: замеченные и разобранные подачи читаются из журнала дня. Сбой такта не роняет сборщик; 30 подряд — выход с ошибкой.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { politeFetch, SEC_UA } from '../lib/util.mjs';
import { parseForm4Txt, acceptedAt, edgarBase } from '../lib/edgar.mjs';
import { nyWall, nyToMs } from '../lib/nytime.mjs';
import { FEED, feedFile, parseFeedJournal, pruneFeed, parseAtom, filingPath } from '../lib/feed.mjs';

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DIR = argVal('--dir', process.env.FEED_DIR || '/var/lib/insider840-feed');
const FROM = argVal('--from', FEED.from);
const UNTIL = argVal('--until', FEED.until);
const INTERVAL_MS = Number(argVal('--interval', String(FEED.intervalSec))) * 1000;
const ONCE = args.includes('--once');
const DRY = args.includes('--dry-run');
const GAP_MS = 400;                                              // ≤ 2,5 запроса в секунду к SEC
const PAGES = 3, PAGE = 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[feed ${nyWall(Date.now()).slice(11)} ET]`, ...a);
const feedUrl = start => `${edgarBase()}/cgi-bin/browse-edgar?action=getcurrent&type=4&owner=only&count=${PAGE}&output=atom&start=${start}`;

if (!DRY) mkdirSync(DIR, { recursive: true });
const dayFile = () => feedFile(DIR, nyWall(Date.now()).slice(0, 10));
const write = rec => { if (!DRY) appendFileSync(dayFile(), JSON.stringify(rec) + '\n'); };

// Состояние дня — из журнала: замеченные, разобранные, попытки скачать
const seen = new Map(), forms = new Set(), tries = new Map();
{
  const f = dayFile();
  if (existsSync(f)) {
    const j = parseFeedJournal(readFileSync(f, 'utf8'));
    for (const [a, r] of j.seen) seen.set(a, r);
    for (const a of j.forms.keys()) forms.add(a);
  }
}
const pending = () => [...seen.values()].filter(s => !forms.has(s.acc) && (tries.get(s.acc) ?? 0) < FEED.maxTries);

async function get(url) {
  const { body } = await politeFetch(url, { ua: SEC_UA, as: 'text', retries: 2, intervalMs: GAP_MS });
  return body;
}

// Скачать и разобрать подачу; false — файла ещё нет (повторим на следующем такте)
async function fetchForm(s) {
  tries.set(s.acc, (tries.get(s.acc) ?? 0) + 1);
  // fetchFiling не передаёт свой интервал, а у хоста по умолчанию ~7 запросов в секунду: подачи качаются тем же полите-запросом, что и страницы ленты
  const txt = await get(`${edgarBase()}/Archives/${filingPath(s.cik, s.acc)}`);
  if (!txt) return false;
  const head = txt.slice(0, txt.indexOf('<XML>') >= 0 ? txt.indexOf('<XML>') : 4000);
  const at = acceptedAt(head);
  const filed = s.filed ?? (at ? at.slice(0, 10) : null);
  const parsed = parseForm4Txt(txt, s.acc, filed);
  write({ k: 'form', acc: s.acc, filed, at: at ?? null, trades: parsed.trades, amend: parsed.amend });
  forms.add(s.acc);
  return true;
}

async function tick(stat) {
  let gap = false;
  const backlog = stat.polls === 0;                                // первый такт запуска: накопившееся за ночь или простой — не разрыв
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
  let got = 0;
  for (const s of pending()) {
    try { if (await fetchForm(s)) got++; } catch (e) { stat.errors++; log(`подача ${s.acc}: ${e.message}`); }
  }
  stat.forms += got;
  if (gap) { stat.gaps++; log('РАЗРЫВ: три страницы ленты целиком новые — часть подач могла выпасть, их подберёт индекс'); }
  return got;
}

const stat = { polls: 0, errors: 0, forms: 0, gaps: 0 };
let failed = 0, lastStat = Date.now();
pruneFeed(DIR, nyWall(Date.now()).slice(0, 10));
write({ k: 'run', start: new Date().toISOString(), from: FROM, until: UNTIL, interval: INTERVAL_MS / 1000, v: 1 });
log(`старт: журнал ${DIR}, уже замечено ${seen.size}, разобрано ${forms.size}; окно ${FROM}–${UNTIL} ET`);
const wallDay = () => nyWall(Date.now()).slice(0, 10);
const startMs = nyToMs(`${wallDay()}T${FROM}`), endMs = nyToMs(`${wallDay()}T${UNTIL}`);
if (!ONCE && startMs && Date.now() < startMs) { log(`рано: ждём ${FROM} ET`); await sleep(startMs - Date.now()); }
for (;;) {
  try {
    const n = await tick(stat);
    failed = 0;
    if (n) log(`новых разобранных подач: ${n}; замечено ${seen.size}, разобрано ${forms.size}, ждут ${pending().length}`);
  } catch (e) {
    failed++; stat.errors++;
    log(`сбой такта (${failed} подряд): ${e.message}`);
    if (failed >= 30) { log('30 тактов подряд без ответа — выход с ошибкой'); process.exit(1); }
  }
  if (Date.now() - lastStat > 10 * 60e3 || ONCE) {
    write({ k: 'stat', t: new Date().toISOString(), seen: seen.size, forms: forms.size, pending: pending().length, ...stat });
    lastStat = Date.now();
  }
  if (ONCE || (endMs && Date.now() >= endMs)) break;
  await sleep(INTERVAL_MS);
}
write({ k: 'stat', t: new Date().toISOString(), seen: seen.size, forms: forms.size, pending: pending().length, ...stat, end: true });
log(`конец: замечено ${seen.size}, разобрано ${forms.size}, ошибок ${stat.errors}, разрывов ${stat.gaps}`);
