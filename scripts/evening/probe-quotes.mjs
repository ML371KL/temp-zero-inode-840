// Проба источников вечерних котировок и окружения сборщика. Запускать вечером по Нью-Йорку (16:05–19:55):
//   node scripts/evening/probe-quotes.mjs [AAPL,MGM,...] [--nasdaq] [--out probe.json]
//   node scripts/evening/probe-quotes.mjs --check        — проверка окружения (SEC, воркер без Origin, git push), без котировок
//
// Что показывает: для каждой бумаги и для IWM — что отдал воркер (bid/ask/вечерняя цена и её время, состояние
// рынка), годится ли книга (validBook: оба числа, ask ≥ bid, разрыв ≤ 1% от середины) и какая цена покупки
// получилась бы (ask или последняя сделка плюс оценка спреда, с пометкой). С --nasdaq — то же по api.nasdaq.com
// (обычный запрос с честным User-Agent проекта; если адрес закрыт — это видно по HTTP-коду).
//
// Вывод пригоден для решения «хватает ли вечернего bid/ask»: если у воркера книга годна у большинства форм,
// оценка спреда не нужна; если нет — смотреть nasdaq или принимать оценку (она помечена в журнале est).
import { writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { politeFetch, SEC_UA } from '../lib/util.mjs';
import { fromWorker, validBook, entryPx, benchPx, nyWall } from '../lib/evening.mjs';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const positional = args.find(a => !a.startsWith('--') && a !== val('--out'));
const SYMBOLS = (positional ?? 'AAPL,MSFT,MGM,LRN,SIRI').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const QUOTES_URL = process.env.QUOTES_URL ?? 'https://radar840-quotes.financehub.workers.dev/quotes';
const UA = 'InsiderRadar/1.0 (rodionkalmykov@gmail.com)';
const out = { at: new Date().toISOString(), ny: nyWall(Date.now()), symbols: SYMBOLS, checks: {}, quotes: {} };
const ok = (name, good, note = '') => { out.checks[name] = { ok: good, note }; console.log(`${good ? 'OK  ' : 'FAIL'} ${name}${note ? ' — ' + note : ''}`); };

// ---- окружение ----
if (flag('--check')) {
  try {
    const { body } = await politeFetch('https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&owner=only&count=10&output=atom', { ua: SEC_UA, as: 'text', retries: 1, intervalMs: 220 });
    ok('SEC getcurrent (SEC_UA)', /<feed/.test(body ?? ''), `${(body ?? '').length} байт`);
  } catch (e) { ok('SEC getcurrent (SEC_UA)', false, String(e.message)); }
  try {
    const r = await fetch(QUOTES_URL.replace(/\/quotes$/, '/health'), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    ok('воркер /health без заголовка Origin', r.ok, `HTTP ${r.status}`);
    const q = await fetch(`${QUOTES_URL}?symbols=IWM`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    const j = await q.json().catch(() => null);
    ok('воркер /quotes без заголовка Origin', q.ok && !!j?.quotes?.IWM, `HTTP ${q.status}, поля: ${Object.keys(j?.quotes?.IWM ?? {}).join(',')}`);
    ok('воркер отдаёт bid/ask и вечернюю цену (поля b, a, pp в ответе)', ['b', 'a', 'pp'].every(k => k in (j?.quotes?.IWM ?? {})), 'если нет — воркер ещё не выложен с этим PR');
  } catch (e) { ok('воркер', false, String(e.message)); }
  const dir = process.env.PAPER_DIR ?? '/var/lib/insider840-evening/paper';
  if (existsSync(dir + '/.git')) {
    try {
      const env = { ...process.env, GIT_SSH_COMMAND: process.env.PAPER_KEY ? `ssh -i ${process.env.PAPER_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${dir}/../known_hosts` : (process.env.GIT_SSH_COMMAND ?? 'ssh') };
      execFileSync('git', ['-C', dir, 'ls-remote', '--exit-code', 'origin', 'HEAD'], { env, stdio: 'pipe', timeout: 30000 });
      ok('git: доступ к origin по ключу paper', true);
    } catch (e) { ok('git: доступ к origin по ключу paper', false, String(e.stderr ?? e.message).split('\n')[0]); }
  } else ok('git: рабочая копия ветки paper', false, `${dir} не репозиторий — ops/insider840-evening/install.sh`);
  process.exit(Object.values(out.checks).every(c => c.ok) ? 0 : 1);
}

// ---- котировки ----
const list = [...new Set([...SYMBOLS, 'IWM'])];
console.log(`[probe] ${out.ny} ET · ${list.join(', ')}`);
const nowSec = Math.floor(Date.now() / 1000);
const show = (src, sym, q, http) => {
  const book = validBook(q), e = entryPx(q, nowSec), b = sym === 'IWM' ? benchPx(q) : null;
  const age = q?.lastT ? nowSec - q.lastT : null;
  out.quotes[`${src}:${sym}`] = { ...q, http, book, entry: e, bench: b, ageSec: age };
  console.log(`${src.padEnd(7)} ${sym.padEnd(5)} bid ${String(q?.bid ?? '—').padEnd(8)} ask ${String(q?.ask ?? '—').padEnd(8)} last ${String(q?.last ?? '—').padEnd(8)} `
    + `сделка ${age === null ? '—' : age + ' с назад'} · состояние ${q?.st ?? '—'} · книга ${book ? 'годна' : 'негодна'} · покупка ${e ? e.px.toFixed(4) + (e.est ? ' (оценка спреда)' : ' (ask)') : '—'}`);
};
try {
  const r = await fetch(`${QUOTES_URL}?symbols=${encodeURIComponent(list.join(','))}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  console.log(`воркер: HTTP ${r.status}, x-cache ${r.headers.get('x-cache')}, src ${j.src}, at ${j.at ? new Date(j.at * 1000).toISOString() : '—'}${j.stale ? ', ОТВЕТ УСТАРЕВШИЙ' : ''}`);
  for (const s of list) show('worker', s, j.quotes?.[s] ? fromWorker(j.quotes[s]) : null, r.status);
} catch (e) { console.log('воркер: сбой', String(e.message)); }

if (flag('--nasdaq')) {
  const n = s => { const v = Number(String(s ?? '').replace(/[$,]/g, '')); return Number.isFinite(v) && v > 0 ? v : null; };
  for (const s of list) {
    try {
      const r = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(s)}/info?assetclass=stocks`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      const pd = r.ok ? (await r.json())?.data?.primaryData : null;
      show('nasdaq', s, pd ? { bid: n(pd.bidPrice), ask: n(pd.askPrice), last: n(pd.lastSalePrice), lastT: null, st: pd.isRealTime ? 'realtime' : 'delayed' } : null, r.status);
      if (!pd) console.log(`nasdaq ${s}: HTTP ${r.status} — адрес закрыт или ответ без primaryData`);
    } catch (e) { console.log(`nasdaq ${s}: ${String(e.message).split('\n')[0]}`); }
    await new Promise(r => setTimeout(r, 700));
  }
}
const o = val('--out');
if (o) { writeFileSync(o, JSON.stringify(out, null, 1)); console.log('сохранено:', o); }
