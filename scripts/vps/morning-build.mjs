// Сборка утреннего списка на VPS сразу после индекса EDGAR (~22:03 по Нью-Йорку), вместо ожидания ежедневной сборки на GitHub
// (внешний cron 03:25 UTC, на деле 22:25–23:25 ET, GitHub schedule опаздывал на часы). Ежедневная сборка остаётся: она пересчитывает всё
// полностью и страхует эту; обе пишут один и тот же файл morning.json, расхождения видны (crossCheck) и исправляются письмом-уточнением.
//
//   node scripts/vps/morning-build.mjs [--state /var/lib/insider840-morning] [--until 23:30] [--interval 120]
//        [--date ГГГГ-ММ-ДД] [--once] [--dry-run] [--no-letter] [--no-sync] [--no-live] [--no-index-check] [--data DIR]
//
// Шаги одной попытки (завершённые шаги в повторе не повторяются; попытки каждые --interval секунд до --until по Нью-Йорку):
//   1. индекс EDGAR за день D опубликован (form.ГГГГММДД.idx)          — нет: ждём; D — праздник SEC: выходим без тревоги
//   2. ветка data (анонимный shallow-fetch открытого репозитория)      — в $STATE/repo, каждый раз чистое дерево
//   3. scripts/live.mjs: формы дня D                                   — SEC с VPS, ~0,2 с на форму
//   4. журнал вечерней схемы из воркера (необязательно)                 — как в daily.yml
//   5. бары SPY и IWM за D и открытия дня входа                         — через воркер /bars (Yahoo с адреса VPS не трогаем)
//   6. compute --only-morning --plan: у каких бумаг дня нет бара D0     — докачка через воркер /bars (бумаги без кэша — со всей историей)
//   7. compute --only-morning --builder vps                             — morning.json (листинг, счётчик, вечерняя схема)
//   8. PUT воркеру /morning                                             — панель берёт файл оттуда, если он свежее страницы
//   9. письмо (если в env есть TELEGRAM_*)                              — scripts/notify.mjs --sender vps; дубль исключает отметка в воркере
// В ветку data VPS ничего не пишет. Код берётся из клона репозитория (обновляет только install.sh).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson, writeJson, addDaysIso, SEC_UA } from '../lib/util.mjs';
import { nyWall, nyToMs } from '../lib/evening.mjs';
import { isSecClosed } from '../lib/calendar.mjs';
import { fetchBars, applyBars, barsFrom } from '../lib/bars.mjs';
import { OPENS_BENCH, readOpens, opensOf } from '../lib/opens.mjs';
import { readPriceCache } from '../lib/prices.mjs';

const CODE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[morning]', ...a);

// ---------- параметры ----------
export function parseArgs(argv, env = process.env) {
  const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const flag = n => argv.includes(n);
  const state = resolve(val('--state', env.MORNING_STATE || '/var/lib/insider840-morning'));
  return {
    state, data: resolve(val('--data', join(state, 'repo'))), site: resolve(val('--site', join(state, 'site'))),
    date: val('--date', null), until: val('--until', '23:30'), interval: Number(val('--interval', '120')),
    once: flag('--once'), dry: flag('--dry-run'), noLetter: flag('--no-letter'), noSync: flag('--no-sync'), noLive: flag('--no-live'),
    noIndexCheck: flag('--no-index-check'),
    repoUrl: env.DATA_REPO_URL || 'https://github.com/ML371KL/temp-zero-inode-840.git',
    workerUrl: (env.PAPER_URL || 'https://radar840-quotes.financehub.workers.dev').replace(/\/$/, ''),
    token: env.PAPER_TOKEN || '',
    letters: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    env,
  };
}

// ---------- процессы ----------
function run(cmd, args, { cwd, env, label }) {
  return new Promise(resolveP => {
    const p = spawn(cmd, args, { cwd, env, stdio: 'inherit' });
    p.on('error', e => { log(`${label}: не запустился — ${e.message}`); resolveP(127); });
    p.on('close', code => resolveP(code ?? 1));
  });
}
const node = (script, args, o) => run(process.execPath, ['--max-old-space-size=3072', join(CODE, script), ...args], { cwd: CODE, label: script, ...o });

// ---------- шаги ----------
export async function indexAvailable(day) {
  const ymd = day.replace(/-/g, ''), q = Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1;
  try {
    const r = await fetch(`https://www.sec.gov/Archives/edgar/daily-index/${day.slice(0, 4)}/QTR${q}/form.${ymd}.idx`,
      { method: 'HEAD', headers: { 'User-Agent': SEC_UA }, signal: AbortSignal.timeout(20000) });
    if (r.status === 200) return true;
    if (r.status === 404 || r.status === 403) return false;       // SEC отвечает 403 на то, чего нет
    return null;
  } catch { return null; }
}

async function git(args, o) { return run('git', args, { cwd: o.cwd, env: o.env, label: 'git ' + args[0] }); }
// Ветка data -> $STATE/repo (рабочее дерево = каталог data сборки). Репозиторий постоянный, поэтому ночная загрузка — только изменения;
// дерево каждый раз сбрасывается: предыдущая попытка могла дописать формы и бары.
async function syncData(opts) {
  const env = { ...process.env, HOME: opts.state, GIT_TERMINAL_PROMPT: '0' };
  mkdirSync(opts.data, { recursive: true });
  if (!existsSync(join(opts.data, '.git'))) {
    if (await git(['init', '-q', '.'], { cwd: opts.data, env })) return false;
    await git(['remote', 'add', 'origin', opts.repoUrl], { cwd: opts.data, env });
    await git(['config', 'gc.pruneExpire', 'now'], { cwd: opts.data, env });
  }
  if (await git(['fetch', '-q', '--depth', '1', '--no-tags', 'origin', 'data'], { cwd: opts.data, env })) return false;
  if (await git(['-c', 'advice.detachedHead=false', 'checkout', '-q', '-f', '--detach', 'FETCH_HEAD'], { cwd: opts.data, env })) return false;
  await git(['clean', '-fdq'], { cwd: opts.data, env });
  await git(['gc', '--auto', '-q'], { cwd: opts.data, env });
  return true;
}

async function fetchPaper(opts) {
  try {
    const dir = join(opts.data, 'paper', 'log');
    mkdirSync(dir, { recursive: true });
    const ix = await (await fetch(`${opts.workerUrl}/paper/index`, { signal: AbortSignal.timeout(20000) })).json();
    for (const f of ix.files ?? []) {
      const r = await fetch(`${opts.workerUrl}/paper/log/${f.name}`, { signal: AbortSignal.timeout(30000) });
      if (r.ok) writeFileSync(join(dir, f.name), await r.text());
    }
    log(`журнал вечерней схемы: ${(ix.files ?? []).length} файлов`);
  } catch (e) { log('журнал вечерней схемы недоступен (необязательно):', e.message); }
}

// Итог шага live.mjs для дня day: state/live.json (lastDay, coverage[day] от сборщика подач) и код выхода. Индекс разобран не до day или не
// вышел — повтор; разобран частично (часть форм ждёт добора: сеть, лимит SEC) — повтор подберёт остаток, на последней попытке идём как есть.
export function liveVerdict(live, day, code, lastChance = false) {
  const cov = live?.coverage?.[day] ?? null;
  if (code || !(live?.lastDay >= day)) return { ok: false, why: `формы разобраны не до ${day} (live.mjs код ${code}, lastDay=${live?.lastDay ?? '—'}${cov?.status ? ', ' + cov.status : ''})` };
  if (cov?.status === 'not-published' || cov?.status === 'holiday') return { ok: false, why: `индекс за ${day}: ${cov.status}` };
  if (cov?.status === 'partial' && !lastChance) return { ok: false, why: `индекс за ${day} разобран не полностью: ${cov.collected} из ${cov.indexed} форм, ждут добора ${cov.pending} (повтор)` };
  return { ok: true, partial: cov?.status === 'partial' };
}

const lastBar = (data, t) => { const s = readPriceCache(data, t); return s?.length ? s[s.length - 1][0] : null; };

// Одна попытка. Возвращает { ok, why?, retry? }. ctx.stage хранит завершённые шаги между попытками.
export async function attempt(opts, day, ctx) {
  const env = { ...process.env, ...opts.env, MORNING_SENDER: 'vps', MORNING_URL: opts.workerUrl };
  const st = ctx.stage;
  const fail = why => { log('✗', why); return { ok: false, why }; };

  if (!opts.noIndexCheck && !st.index) {
    const av = await indexAvailable(day);
    if (av === false) return fail(`индекс EDGAR за ${day} ещё не опубликован`);
    st.index = true;
  }
  if (!opts.noSync && !st.sync) {
    log('ветка data: загрузка…');
    if (!(await syncData(opts))) return fail('не удалось получить ветку data');
    st.sync = true;
  }
  if (!opts.noLive && !st.live) {
    log(`формы дня ${day} (live.mjs)…`);
    // Фоновое перечитывание окна (рост PARSER_REV) здесь не нужно: копия data каждый прогон свежая, прогресс всё равно пропадёт,
    // а список ждёт. Окно перечитывают прогоны на GitHub без нового дня.
    const code = await node('scripts/live.mjs', ['--data', opts.data, '--time-budget-min', '25', '--reread-budget-min', '0'], { env });
    const v = liveVerdict(readJson(join(opts.data, 'state', 'live.json'), {}), day, code, ctx.lastChance);
    if (!v.ok) return fail(v.why);
    if (v.partial) log('индекс разобран не полностью — последняя попытка, идём как есть (недобор виден в coverage)');
    st.live = true;
  }
  if (!st.paper) { await fetchPaper(opts); st.paper = true; }

  // Бары бенчмарков: по ним определяются D0 и день входа. Нужны, пока нет бара за D у SPY или открытий за D в хранилище.
  if (!st.bench) {
    const store = readOpens(opts.data);
    const need = (lastBar(opts.data, 'SPY') ?? '') < day || OPENS_BENCH.some(b => !opensOf(store, b, day));
    if (need) {
      const from = barsFrom(lastBar(opts.data, 'SPY'), day);
      const r = await fetchBars(opts.workerUrl, opts.token, OPENS_BENCH.map(sym => ({ sym, from })));
      const failed = Object.keys(r.failed);
      if (failed.length || r.limited) return fail(`бары бенчмарков не получены: ${failed.map(s => `${s} (${r.failed[s]})`).join(', ') || 'лимит'}`);
      log('бенчмарки:', JSON.stringify(applyBars(opts.data, r.got, { updated: day })));
    }
    st.bench = true;
  }

  // Что докачать: бары D0 у бумаг дня и открытия дня входа у строк прошедших дней
  const planFile = join(opts.state, 'plan.json');
  mkdirSync(opts.site, { recursive: true });
  const common = ['--data', opts.data, '--site', opts.site, '--only-morning', '--builder', 'vps'];
  if (!st.bars) {
    // Проход 1 — бары D0 у бумаг дня. Если у прошедшего дня были бумаги без баров, их открытия видны только теперь: проход 2.
    for (let pass = 1; pass <= 2; pass++) {
      if (await node('scripts/compute.mjs', [...common, '--plan', planFile], { env })) return fail('compute (план докачки) завершился с ошибкой');
      const plan = readJson(planFile, { bars: {}, opens: {} });
      const names = [...new Set([...Object.keys(plan.bars), ...Object.keys(plan.opens)])];
      const items = names.map(sym => ({ sym, from: barsFrom(plan.bars[sym] ? plan.bars[sym].last : lastBar(opts.data, sym), day, plan.opens[sym] ?? []) }));
      if (items.length) {
        log(`докачка баров (проход ${pass}): ${items.length} бумаг (${Object.keys(plan.bars).length} без бара D0, ${Object.keys(plan.opens).length} с открытиями)`);
        const r = await fetchBars(opts.workerUrl, opts.token, items);
        const stat = applyBars(opts.data, r.got, { opensNeeds: plan.opens, updated: day });
        // Бумага, которой у Yahoo нет вовсе (missing), — не сбой: повтор ничего не даст. Сбой — когда воркер или Yahoo не ответили.
        const transient = Object.keys(r.failed);
        log('бары:', JSON.stringify({ ...stat, missing: stat.missing.length, transient: transient.length, limited: r.limited }));
        if (transient.length && !ctx.lastChance) return fail(`бары не получены: ${transient.slice(0, 8).join(', ')}${transient.length > 8 ? '…' : ''}`);
      }
      if (pass === 1 && !plan.opensPending) break;
      if (pass === 2) break;
    }
    st.bars = true;
  }

  if (!st.built) {
    if (await node('scripts/compute.mjs', common, { env })) return fail('compute завершился с ошибкой');
    const m = readJson(join(opts.site, 'data', 'morning.json'), null);
    if (!m || m.listFor !== day || m.builder !== 'vps') return fail(`morning.json не тот: listFor=${m?.listFor}, builder=${m?.builder}`);
    const d0 = m.days?.[0];
    log(`список за ${m.listFor}: бумаг от $10 млн ${d0?.rows.length ?? 0}, в основном ${d0?.rows.filter(x => x.main).length ?? 0}, без цены на D0 ${d0?.unpriced?.length ?? 0}`);
    ctx.summary = { listFor: m.listFor, rows: d0?.rows.length ?? 0, main: d0?.rows.filter(x => x.main).length ?? 0, unpriced: d0?.unpriced?.length ?? 0 };
    st.built = true;
  }

  if (!st.published && !opts.dry) {
    if (!opts.token) return fail('PAPER_TOKEN не задан: список некуда отправить');
    const body = readFileSync(join(opts.site, 'data', 'morning.json'), 'utf8');
    try {
      const r = await fetch(`${opts.workerUrl}/morning`, { method: 'PUT', body, headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000) });
      if (r.status === 409) log('воркер хранит версию новее — наша не принята (это не сбой)');
      else if (!r.ok) return fail(`воркер /morning: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      else log('отправлено в воркер:', (await r.text()).slice(0, 200));
    } catch (e) { return fail(`воркер /morning: ${e.message}`); }
    st.published = true;
  }

  if (!st.letter && !opts.dry && !opts.noLetter && opts.letters) {
    const code = await node('scripts/notify.mjs', ['--data', opts.data, '--site', opts.site, '--sender', 'vps'], { env });
    if (code) return fail(`notify.mjs: код ${code} (письмо не доставлено, повтор)`);
    st.letter = true;
  }
  return { ok: true };
}

// ---------- основной цикл ----------
export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv, env);
  mkdirSync(opts.state, { recursive: true });
  const nowMs = Date.now();
  const day = opts.date ?? nyWall(nowMs).slice(0, 10);
  if (isSecClosed(day) && !opts.date) { log(`${day}: SEC закрыта (выходной или федеральный праздник) — индекса не будет`); return 0; }
  const doneFile = join(opts.state, 'done', `${day}.json`);
  if (existsSync(doneFile) && !opts.dry) { log(`${day}: уже собрано — выходим`, readFileSync(doneFile, 'utf8').trim()); return 0; }
  const untilMs = nyToMs(`${day}T${opts.until}`) ?? nowMs;
  const ctx = { stage: {}, lastChance: false, summary: null };
  log(`день подачи ${day}, ${nyWall(nowMs).slice(11, 16)} ET, до ${opts.until} ET; письма с VPS: ${opts.letters && !opts.noLetter ? 'да' : 'нет'}`);
  for (let n = 1; ; n++) {
    ctx.lastChance = Date.now() + opts.interval * 1000 >= untilMs;
    log(`попытка ${n}${ctx.lastChance ? ' (последняя)' : ''}`);
    const r = await attempt(opts, day, ctx);
    if (r.ok) {
      if (!opts.dry) writeJson(doneFile, { day, at: new Date().toISOString(), ...ctx.summary });
      log('готово');
      return 0;
    }
    if (opts.once || ctx.lastChance) { log(`НЕ СОБРАНО: ${r.why}`); return 1; }
    await sleep(opts.interval * 1000);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
