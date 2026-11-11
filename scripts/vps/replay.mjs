// Проверка сборки на VPS на прошлых днях: список, собранный «как вечером дня D» (бары D0 докачиваются через воркер, открытия дня входа
// тоже), должен совпасть со списком полного пересчёта на тех же данных (бары на месте с самого начала).
//
//   node scripts/vps/replay.mjs --full DATA --days 2026-10-26,2026-10-27 [--work DIR] [--keep]
//
// DATA — полная копия ветки data (как после «Восстановить данные» в daily.yml). Для каждого дня D рабочая копия приводится к виду на 22:03 ET:
// формы позже D убраны из шардов, state/live.json кончается на D, у SPY, IWM и бумаг с покупками дня D срезаны бары с D0, из хранилища
// открытий убраны даты с D0. Эталон — lean-compute на тех же формах, но с полными барами. Подставной воркер отдаёт бары из полного кэша
// (ответ Yahoo chart тем же видом, что у настоящего воркера). Сравниваются строки списка дня D (состав, скор, сумма, оборот, цена,
// издержки, пометки) и результаты дня D−1 (открытие, закрытие, к IWM и к SPY). Живой SEC и Yahoo не трогаются.
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readJson, writeJson, readJsonGz, writeJsonGz, addDaysIso } from '../lib/util.mjs';
import { readPriceCache, writePriceCache, priceCachePath } from '../lib/prices.mjs';
import { readOpens, writeOpens, opensOf } from '../lib/opens.mjs';
import { main as morningMain } from './morning-build.mjs';

const CODE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const val = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const FULL = resolve(val('--full', ''));
const DAYS = (val('--days', '') || '').split(',').filter(Boolean);
const WORK = resolve(val('--work', join(CODE, '..', '_replay-840')));
if (!existsSync(join(FULL, 'trades')) || !DAYS.length) { console.log('использование: node scripts/vps/replay.mjs --full DATA --days Д1,Д2 [--work DIR] [--keep]'); process.exit(2); }

const run = (script, args) => new Promise(r => {
  const p = spawn(process.execPath, ['--max-old-space-size=4096', join(CODE, script), ...args], { cwd: CODE, stdio: ['ignore', 'ignore', 'inherit'] });
  p.on('close', c => r(c ?? 1));
});
const data = join(WORK, 'data');
const mtimes = new Map();
const walk = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else mtimes.set(p, statSync(p).mtimeMs); } };
if (!existsSync(data)) {
  console.log('копирую данные…');
  for (const d of ['trades', 'reference', 'prices', 'state']) cpSync(join(FULL, d), join(data, d), { recursive: true });
}
walk(data);
const restore = () => {          // вернуть из полной копии всё, что прошлый день изменил
  let n = 0;
  for (const [p, m] of mtimes) {
    if (!existsSync(p) || statSync(p).mtimeMs !== m) { cpSync(join(FULL, p.slice(data.length + 1)), p); mtimes.set(p, statSync(p).mtimeMs); n++; }
  }
  return n;
};

// Подставной воркер: бары из полного кэша, открытия/закрытия дней входа из полного хранилища
const fullOpens = readOpens(FULL);
const chartFor = (sym, from) => {
  const s = readPriceCache(FULL, sym);
  if (!s?.length) return null;
  const rows = s.filter(r => r[0] >= from);
  const ov = d => { const o = opensOf(fullOpens, sym, d); return o ? [o[0], o[1]] : null; };
  return { chart: { result: [{
    meta: { gmtoffset: -18000, exchangeName: 'NYQ' },
    timestamp: rows.map(r => Math.floor(Date.parse(r[0] + 'T14:30:00Z') / 1000)),
    indicators: { quote: [{ open: rows.map(r => ov(r[0])?.[0] ?? r[1]), close: rows.map(r => ov(r[0])?.[1] ?? r[1]), volume: rows.map(r => r[3]) }], adjclose: [{ adjclose: rows.map(r => r[2]) }] },
    events: {},
  }] } };
};
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/bars') {
    const bars = {}, failed = {};
    for (const part of (u.searchParams.get('symbols') ?? '').split(',')) { const [sym, from] = part.split(':'); const c = chartFor(sym, from); if (c) bars[sym] = c; else failed[sym] = 'HTTP 404'; }
    return send(200, { ok: true, bars, failed, limited: false });
  }
  if (u.pathname === '/morning') { req.resume(); req.on('end', () => send(200, { ok: true })); return; }
  send(404, {});
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const pick = (r, keys) => Object.fromEntries(keys.map(k => [k, r?.[k] ?? null]));
const LIST = ['t', 'val', 'mx', 'n', 'score', 'main', 'dv', 'px', 'cost', 'tags', 'dd'];
const RES = ['o', 'c', 'r', 'b', 'bs', 'ex', 'exS', 'skip'];
const cmpDay = (a, b, keys, label, out) => {
  const ra = new Map((a?.rows ?? []).map(x => [x.t, x])), rb = new Map((b?.rows ?? []).map(x => [x.t, x]));
  let same = 0;
  for (const t of new Set([...ra.keys(), ...rb.keys()])) {
    const x = pick(ra.get(t), keys), y = pick(rb.get(t), keys);
    if (JSON.stringify(x) === JSON.stringify(y)) same++; else out.push(`${label} ${t}: VPS ${JSON.stringify(ra.get(t) ? x : null)} ≠ эталон ${JSON.stringify(rb.get(t) ? y : null)}`);
  }
  return { n: new Set([...ra.keys(), ...rb.keys()]).size, same };
};

let bad = 0;
const table = [];
for (const D of DAYS) {
  const t0 = Date.now();
  const rest = restore();
  // 1. формы позже D убираем; live.json кончается на D
  for (const f of readdirSync(join(data, 'trades')).filter(x => x.endsWith('.json.gz'))) {
    const p = join(data, 'trades', f), sh = readJsonGz(p, null);
    if (!sh?.trades || !sh.trades.some(r => r.fdate > D)) continue;
    sh.trades = sh.trades.filter(r => r.fdate <= D);
    writeJsonGz(p, sh);
  }
  const live = readJson(join(data, 'state', 'live.json'), {});
  writeJson(join(data, 'state', 'live.json'), { ...live, lastDay: D });
  // 2. эталон: бары на месте
  const refSite = join(WORK, 'ref-' + D);
  if (await run('scripts/compute.mjs', ['--data', data, '--site', refSite, '--only-morning', '--builder', 'github'])) { console.log(`${D}: эталон не собран`); bad++; continue; }
  const ref = readJson(join(refSite, 'data', 'morning.json'));
  // 3. вид на 22:03 ET: бары с D0 срезаны у SPY, IWM и бумаг с покупками дня D; открытия — только до D0
  const spy = readPriceCache(data, 'SPY');
  const d0 = spy.map(r => r[0]).filter(d => d <= D).at(-1);
  const tick = new Set(['SPY', 'IWM']);
  for (const f of readdirSync(join(data, 'trades')).filter(x => x.endsWith('.json.gz'))) for (const r of readJsonGz(join(data, 'trades', f), { trades: [] }).trades ?? []) if (r.fdate === D && r.t) tick.add(r.t);
  for (const t of tick) if (existsSync(priceCachePath(data, t))) { const s = readPriceCache(data, t); writePriceCache(data, t, s.filter(r => r[0] < d0)); }
  const st = readOpens(data);
  for (const t of Object.keys(st.t)) for (const d of Object.keys(st.t[t])) if (d >= d0) delete st.t[t][d];
  writeOpens(data, st, d0);
  // 4. сборка VPS
  const vpsSite = join(WORK, 'vps-' + D);
  const code = await morningMain(['--state', join(WORK, 'state-' + D), '--data', data, '--site', vpsSite, '--date', D, '--no-sync', '--no-live', '--no-index-check', '--once', '--dry-run', '--interval', '1'],
    { PAPER_URL: base, PAPER_TOKEN: 'replay' });
  if (code) { console.log(`${D}: сборка VPS не удалась`); bad++; continue; }
  const vps = readJson(join(vpsSite, 'data', 'morning.json'));
  const out = [];
  const a = cmpDay(vps.days[0], ref.days[0], LIST, `${D} список`, out);
  const b = cmpDay(vps.days[1], ref.days[1], [...LIST, ...RES], `${vps.days[1]?.date} результаты`, out);
  const ok = !out.length && vps.listFor === ref.listFor && vps.days[0].date === D;
  if (!ok) bad++;
  table.push({ D, rows: a.n, same: a.same, prevRows: b.n, prevSame: b.same, main: vps.days[0].rows.filter(x => x.main).length, unpriced: vps.days[0].unpriced?.length ?? 0, ok, sec: Math.round((Date.now() - t0) / 1000) });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${D}: строк списка ${a.same}/${a.n} совпало (основных ${vps.days[0].rows.filter(x => x.main).length}), результатов дня D−1 ${b.same}/${b.n}, без цены ${vps.days[0].unpriced?.length ?? 0}, ${Math.round((Date.now() - t0) / 1000)} с`);
  for (const l of out) console.log('     ' + l);
  rmSync(join(WORK, 'state-' + D), { recursive: true, force: true });
  void rest;
}
server.close();
console.log(`\nитого: ${table.filter(t => t.ok).length} из ${DAYS.length} дней совпали полностью`);
if (!argv.includes('--keep')) for (const D of DAYS) { rmSync(join(WORK, 'ref-' + D), { recursive: true, force: true }); rmSync(join(WORK, 'vps-' + D), { recursive: true, force: true }); }
process.exit(bad ? 1 : 0);
