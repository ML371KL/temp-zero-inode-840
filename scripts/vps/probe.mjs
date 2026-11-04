// Проверка окружения сборки утреннего списка на VPS (install.sh вызывает её в конце; можно запускать вручную):
//   node scripts/vps/probe.mjs --check [--state /var/lib/insider840-morning]
// Только чтение: ничего не пишет в воркер и не шлёт писем. Код выхода ненулевой, если есть FAIL.
import { execFileSync } from 'node:child_process';
import { existsSync, statfsSync, accessSync, constants } from 'node:fs';
import { addDaysIso } from '../lib/util.mjs';
import { nyWall } from '../lib/evening.mjs';
import { isSecClosed } from '../lib/calendar.mjs';
import { indexAvailable, parseArgs } from './morning-build.mjs';
import { parseYahooChart } from '../lib/prices.mjs';

const argv = process.argv.slice(2);
const opts = parseArgs(argv);
const UA = 'InsiderRadar/1.0 (rodionkalmykov@gmail.com)';
let bad = 0;
const ok = (name, good, note = '') => { if (!good) bad++; console.log(`${good ? 'OK  ' : 'FAIL'} ${name}${note ? ' — ' + note : ''}`); };
const info = (name, note) => console.log(`INFO ${name} — ${note}`);

if (!argv.includes('--check')) { console.log('использование: node scripts/vps/probe.mjs --check [--state DIR]'); process.exit(2); }

ok('Node 20+', Number(process.versions.node.split('.')[0]) >= 20, process.version);
try { ok('git', true, execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()); } catch (e) { ok('git', false, String(e.message).split('\n')[0]); }

// каталог состояния и место: ветка data ~200 МБ (+ рабочее дерево), запас на загрузки
try {
  const dir = existsSync(opts.state) ? opts.state : '/var/lib';
  accessSync(dir, constants.W_OK);
  const fs = statfsSync(dir), freeGb = (fs.bavail * fs.bsize) / 1e9;
  ok(`каталог состояния ${opts.state} доступен на запись, свободно ≥ 2 ГБ`, freeGb >= 2, `${freeGb.toFixed(1)} ГБ`);
} catch (e) { ok(`каталог состояния ${opts.state}`, false, String(e.message).split('\n')[0]); }

// SEC: индекс последнего рабочего дня (HEAD), UA из проекта
{
  let d = addDaysIso(nyWall(Date.now()).slice(0, 10), -1);
  while (isSecClosed(d)) d = addDaysIso(d, -1);
  const av = await indexAvailable(d);
  ok(`SEC: индекс EDGAR за ${d} отдаётся`, av === true, av === null ? 'ответ неопределённый (сеть или лимит)' : '');
}

// GitHub: ветка data читается анонимно
try {
  const out = execFileSync('git', ['ls-remote', opts.repoUrl, 'data'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  ok('GitHub: ветка data читается анонимно', /refs\/heads\/data/.test(out), out.slice(0, 7));
} catch (e) { ok('GitHub: ветка data', false, String(e.message).split('\n')[0]); }

// воркер: список читается без токена (404 — списка ещё нет, это нормально до первой сборки); токен принят; бары идут
const base = opts.workerUrl;
try {
  const r = await fetch(base + '/morning', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (r.status === 200) { const j = await r.json(); ok('воркер: GET /morning', true, `listFor=${j.listFor}, builder=${j.builder}, builtAt=${j.builtAt}`); }
  else ok('воркер: GET /morning', r.status === 404, r.status === 404 ? 'списка ещё нет (до первой сборки так и должно быть)' : `HTTP ${r.status} — воркер не выложен с маршрутом /morning?`);
} catch (e) { ok('воркер: GET /morning', false, String(e.message).split('\n')[0]); }
if (opts.token) {
  try {
    const r = await fetch(base + '/paper/ping', { headers: { 'User-Agent': UA, Authorization: 'Bearer ' + opts.token }, signal: AbortSignal.timeout(15000) });
    ok('воркер: токен приёма принят', r.ok, `HTTP ${r.status}`);
  } catch (e) { ok('воркер: токен приёма', false, String(e.message).split('\n')[0]); }
  try {
    const from = addDaysIso(nyWall(Date.now()).slice(0, 10), -10);
    const r = await fetch(`${base}/bars?symbols=${encodeURIComponent('SPY:' + from)}`, { headers: { 'User-Agent': UA, Authorization: 'Bearer ' + opts.token }, signal: AbortSignal.timeout(40000) });
    const j = await r.json().catch(() => null);
    const p = j?.bars?.SPY ? parseYahooChart(j.bars.SPY) : null;
    ok('воркер: GET /bars отдаёт дневные бары SPY', r.ok && !!p?.series?.length, r.ok ? `${p?.series?.length ?? 0} баров, последний ${p?.series?.at(-1)?.[0] ?? '—'}` : `HTTP ${r.status}`);
  } catch (e) { ok('воркер: GET /bars', false, String(e.message).split('\n')[0]); }
} else ok('PAPER_TOKEN в env', false, 'не задан: список некуда отправить, бары запросить нельзя');
info('письма с VPS', opts.letters ? 'TELEGRAM_* заданы — письмо уйдёт отсюда' : 'TELEGRAM_* пусты — VPS только собирает и публикует, письмо шлёт GitHub');
process.exit(bad ? 1 : 0);
