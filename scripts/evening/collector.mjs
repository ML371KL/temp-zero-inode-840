// Вечерний сборщик (VPS): новые формы 4 из ленты EDGAR getcurrent раз в минуту -> вечерние события
// (принятые 16:00–20:00 по Нью-Йорку, покупка P обыкновенных акций от $10 тыс.) -> котировка в момент
// обнаружения и через 5, 15 и 30 минут после времени приёма -> журнал JSONL, который уходит в воркер (R2) и читается ежедневной сборкой.
// Зачем и что с журналом делает сборка панели — scripts/lib/evening.mjs, docs/ВЕЧЕРНЯЯ-СХЕМА.md.
//
// Запуск по таймеру systemd в 15:55 по Нью-Йорку, будни (ops/insider840-evening). Работает до --until
// (20:35 ET); журнал отправляется в воркер каждые 5 минут и в конце. Перезапуск безопасен: состояние читается из журнала.
//
// Ограничения источников:
//  · SEC — только politeFetch с SEC_UA проекта, не чаще 5 запросов в секунду (intervalMs 220);
//  · котировки — НЕ напрямую из Yahoo: адрес VPS уже почти выбрал часовой лимит Yahoo из-за 839, поэтому
//    через воркер radar840-quotes (край Cloudflare, другой пул адресов), без заголовка Origin;
//  · api.nasdaq.com — необязательный второй источник (EVENING_NASDAQ=1), с честным User-Agent проекта;
//    если он закрыт для этого адреса, это видно в журнале (http, err), а запись идёт по воркеру.
//
// Использование: node scripts/evening/collector.mjs [--dir paper] [--until 20:35] [--once] [--dry-run]
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { politeFetch, SEC_UA } from '../lib/util.mjs';
import { fetchFiling, parseForm4Txt, acceptedAtSec } from '../lib/edgar.mjs';
import { isNonCommon } from '../lib/gates.mjs';
import {
  EVENING, nyWall, nyToMs, inEveningWindow, parseAtom, filingPath, buildEvent, fromWorker,
  planQuotes, parseJournal, MOMENTS_ALL,
} from '../lib/evening.mjs';

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DIR = argVal('--dir', process.env.PAPER_DIR ?? 'paper');          // каталог журнала (log/ГГГГ-ММ-ДД.jsonl)
const UNTIL = argVal('--until', '20:35');                                // конец работы по Нью-Йорку
const ONCE = args.includes('--once');                                    // один такт (для проб и тестов)
const DRY = args.includes('--dry-run');                                  // не писать журнал и не пушить
const QUOTES_URL = process.env.QUOTES_URL ?? 'https://radar840-quotes.financehub.workers.dev/quotes';
const PAPER_URL = (process.env.PAPER_URL ?? 'https://radar840-quotes.financehub.workers.dev').replace(/\/$/, '');   // воркер: приём журнала в R2
const PAPER_TOKEN = process.env.PAPER_TOKEN ?? '';                       // секрет приёма (только запись)
const SHIP_EVERY_MS = 5 * 60e3;
const USE_NASDAQ = process.env.EVENING_NASDAQ === '1';
const NASDAQ_UA = 'InsiderRadar/1.0 (rodionkalmykov@gmail.com)';
const FEED = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&owner=only&count=100&output=atom';
const SEC_GAP_MS = 220;                                                  // ≤ 5 запросов в секунду к SEC
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[evening ${nyWall(Date.now()).slice(11)} ET]`, ...a);

// ---------- журнал ----------
const logDir = join(DIR, 'log');
if (!DRY) mkdirSync(logDir, { recursive: true });
const dayFile = () => join(logDir, nyWall(Date.now()).slice(0, 10) + '.jsonl');
const write = rec => { if (!DRY) appendFileSync(dayFile(), JSON.stringify(rec) + '\n'); };
// Состояние текущего вечера — из журнала: события, снятые котировки, уже разобранные формы
function loadToday() {
  const f = dayFile();
  const j = parseJournal(existsSync(f) ? readFileSync(f, 'utf8') : '');
  const have = new Set();
  for (const [key, list] of j.quotes) { const [id, m, sym] = key.split('|'); if (sym !== 'IWM' && list.length) have.add(`${id}|${m}`); }
  return { events: j.events, have };
}
const seen = new Set();                    // формы, разобранные в этом запуске (прочие вечерние — в журнале)

// ---------- лента и формы ----------
async function secGet(url) {
  const { body } = await politeFetch(url, { ua: SEC_UA, as: 'text', retries: 2, intervalMs: SEC_GAP_MS });
  return body;
}
async function pollFeed(state) {
  let fresh = 0, fetched = 0;
  for (let start = 0; start < 300; start += 100) {
    const xml = await secGet(`${FEED}&start=${start}`);
    const entries = parseAtom(xml);
    if (!entries.length) break;
    const unseen = entries.filter(e => !seen.has(e.acc) && !state.events.has(e.acc));
    for (const e of unseen) {
      seen.add(e.acc);
      if (e.form && e.form !== '4') continue;                            // поправки 4/A приходят позже и вечернего потока не делают
      // Время из ленты — только для отбора: форма вне окна не стоит запроса. Истина — шапка самой формы.
      const fromFeed = e.updated ? nyWall(Date.parse(e.updated)) : null;
      if (fromFeed && !inEveningWindow(shiftMin(fromFeed, 2)) && !inEveningWindow(shiftMin(fromFeed, -2))) continue;
      let txt;
      try { txt = await fetchFiling(filingPath(e.cik, e.acc)); } catch (err) { log(`пропуск ${e.acc}: ${err.message}`); seen.delete(e.acc); continue; }
      fetched++;
      if (!txt) { seen.delete(e.acc); continue; }                       // форма ещё не доступна — следующий такт
      const at = acceptedAtSec(txt.slice(0, txt.indexOf('<XML>') >= 0 ? txt.indexOf('<XML>') : 4000));
      if (!at) continue;
      const parsed = parseForm4Txt(txt, e.acc, at.slice(0, 10));
      const ev = buildEvent(parsed.trades, { acc: e.acc, at, fdate: at.slice(0, 10), isCommon: r => !isNonCommon(r) });
      if (!ev) continue;
      ev.found = new Date().toISOString();
      state.events.set(ev.id, ev);
      write(ev);
      fresh++;
      log(`событие ${ev.t} $${ev.val} принято ${at.slice(11)}`);
    }
    if (!unseen.length) break;                                           // страница целиком знакома — глубже не идём
  }
  return { fresh, fetched };
}
// «ГГГГ-ММ-ДДTчч:мм:сс» ± минуты (для допуска при отборе по времени ленты)
const shiftMin = (wall, min) => nyWall(nyToMs(wall) + min * 60e3);

// ---------- котировки ----------
async function workerQuotes(symbols) {
  const out = new Map();
  for (let i = 0; i < symbols.length; i += 50) {
    const chunk = symbols.slice(i, i + 50);
    const r = await fetch(`${QUOTES_URL}?symbols=${encodeURIComponent(chunk.join(','))}`, { headers: { 'User-Agent': NASDAQ_UA }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`воркер HTTP ${r.status}`);
    const body = await r.json();
    for (const [sym, q] of Object.entries(body.quotes ?? {})) out.set(sym.replace(/-/g, '.'), { ...fromWorker(q), wat: body.at ?? null, stale: body.stale ? 1 : undefined });
  }
  return out;
}
// api.nasdaq.com/api/quote/{SYM}/info: primaryData держит bid/ask и последнюю сделку текущей сессии
async function nasdaqQuote(sym) {
  const r = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/info?assetclass=stocks`,
    { headers: { 'User-Agent': NASDAQ_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { src: 'nasdaq', http: r.status };
  const pd = (await r.json())?.data?.primaryData;
  if (!pd) return { src: 'nasdaq', http: r.status, err: 'нет primaryData' };
  const n = s => { const v = Number(String(s ?? '').replace(/[$,]/g, '')); return Number.isFinite(v) && v > 0 ? v : null; };
  const ts = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) (AM|PM)/.exec(pd.lastTradeTimestamp ?? '');
  let lastT = null;
  if (ts) {
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(ts[1]) + 1;
    const h = (Number(ts[4]) % 12) + (ts[6] === 'PM' ? 12 : 0);
    const ms = nyToMs(`${ts[3]}-${String(mon).padStart(2, '0')}-${String(ts[2]).padStart(2, '0')}T${String(h).padStart(2, '0')}:${ts[5]}`);
    lastT = ms === null ? null : Math.floor(ms / 1000);
  }
  return { src: 'nasdaq', http: r.status, bid: n(pd.bidPrice), ask: n(pd.askPrice), bidSize: n(pd.bidSize), askSize: n(pd.askSize),
    last: n(pd.lastSalePrice), lastT, realtime: pd.isRealTime === true ? 1 : 0 };
}
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

async function pollQuotes(state) {
  const due = planQuotes([...state.events.values()], state.have, Date.now());
  if (!due.length) return 0;
  const symbols = [...new Set([...due.map(d => d.t), 'IWM'])];
  let w = new Map(), werr = null;
  try { w = await workerQuotes(symbols); } catch (e) { werr = String(e.message || e); log('воркер:', werr); }
  const ns = new Map();
  if (USE_NASDAQ) for (const s of symbols) { try { ns.set(s, await nasdaqQuote(s)); } catch (e) { ns.set(s, { src: 'nasdaq', err: String(e.message || e) }); } await sleep(700); }
  const got = new Date().toISOString();
  let n = 0;
  for (const d of due) {
    const ev = state.events.get(d.id);
    const late = Math.round((Date.now() - d.due) / 1000);
    for (const sym of [d.t, 'IWM']) {
      const base = { k: 'q', id: d.id, m: d.m, sym, due: new Date(d.due).toISOString(), got, late };
      let wrote = false;
      for (const q of [w.get(sym) ?? (werr ? { src: 'worker', err: werr } : { src: 'worker', err: 'нет котировки' }), ns.get(sym)]) {
        if (!q) continue;
        write(clean({ ...base, ...q })); wrote = true;
      }
      if (!wrote) write({ ...base, err: 'нет источника' });
    }
    state.have.add(`${d.id}|${d.m}`); n++;
    if (d.m === 5 && ev) log(`котировка +5 ${ev.t}: ${w.get(d.t)?.ask ?? '—'}/${w.get(d.t)?.last ?? '—'} (запоздание ${late} с)`);
  }
  return n;
}

// ---------- отправка журнала в воркер (R2) ----------
// Журнал на диске — источник истины; в воркер он уходит ЦЕЛИКОМ (PUT на каждый файл за вечер, идемпотентно) каждые 5 минут и в конце
// вечера. Токен — только на запись; ежедневная сборка читает без него. Что уже отправлено и каким размером — в shipped.json рядом с
// журналом: неизменившиеся файлы не шлются повторно, недоставленные уходят при следующей отправке (хоть через сутки).
const shippedPath = join(DIR, '..', 'shipped.json');
const loadShipped = () => { try { return JSON.parse(readFileSync(shippedPath, 'utf8')); } catch { return {}; } };
async function shipJournal() {
  if (DRY) return true;
  if (!PAPER_TOKEN) { log('PAPER_TOKEN не задан — журнал остаётся на диске, в хранилище не уходит'); return false; }
  if (!existsSync(logDir)) return true;
  const shipped = loadShipped();
  let allOk = true;
  for (const name of readdirSync(logDir).filter(f => f.endsWith('.jsonl')).sort()) {
    const body = readFileSync(join(logDir, name));
    if (shipped[name] === body.length) continue;
    try {
      const r = await fetch(`${PAPER_URL}/paper/log/${name}`, {
        method: 'PUT', body, headers: { Authorization: `Bearer ${PAPER_TOKEN}`, 'Content-Type': 'application/x-ndjson', 'User-Agent': NASDAQ_UA },
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) { shipped[name] = body.length; log(`журнал ${name} отправлен (${body.length} байт)`); }
      else { allOk = false; log(`журнал ${name}: воркер ответил HTTP ${r.status} ${(await r.text()).slice(0, 160)}`); }
    } catch (e) { allOk = false; log(`журнал ${name}: ${String(e.message || e).split('\n')[0]}`); }
  }
  try { writeFileSync(shippedPath, JSON.stringify(shipped)); } catch (e) { log('shipped.json не записан:', String(e.message || e)); }
  return allOk;
}

// ---------- главный цикл ----------
const untilMs = (() => { const t = nyToMs(`${nyWall(Date.now()).slice(0, 10)}T${UNTIL}`); return t ?? Date.now(); })();
const state = loadToday();
write({ k: 'run', start: new Date().toISOString(), until: UNTIL, moments: MOMENTS_ALL, nasdaq: USE_NASDAQ ? 1 : 0, v: 1 });
log(`старт: событий в журнале ${state.events.size}, до ${UNTIL} ET${DRY ? ', пробный режим' : ''}`);
let ticks = 0, errs = 0, lastStat = 0, lastShip = Date.now();
for (;;) {
  try {
    // Сначала котировки, срок которых уже наступил (разбор ленты может занять десятки секунд — они не должны ждать),
    // затем лента, затем котировки момента обнаружения свежих событий.
    await pollQuotes(state);
    const f = await pollFeed(state);
    if (f.fresh) await pollQuotes(state);
    if (Date.now() - lastStat > 10 * 60e3) { lastStat = Date.now(); write({ k: 'stat', at: new Date().toISOString(), events: state.events.size, quotes: state.have.size, fetched: f.fetched, errs }); }
  } catch (e) { errs++; log('такт не удался:', String(e.message || e).split('\n')[0]); }
  if (Date.now() - lastShip > SHIP_EVERY_MS) { lastShip = Date.now(); await shipJournal(); }
  ticks++;
  if (ONCE || Date.now() >= untilMs) break;
  // следующий такт — в начале минуты +5 с: время приёма в форме с секундами, и 5/15/30 минут отсчитываются точно
  const now = Date.now();
  await sleep(Math.max(1000, 60000 - (now % 60000) + 5000));
}
const shippedOk = await shipJournal();
log(`готово: тактов ${ticks}, событий ${state.events.size}, ошибок ${errs}`);
if (!shippedOk && !DRY) process.exitCode = 1;       // недоставленный журнал — тревога; он останется на диске и уйдёт при следующей отправке
