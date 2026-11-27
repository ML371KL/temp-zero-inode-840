// Справочник D−1 для сигнала в торговые часы (контур B бота; scripts/lib/intraday.mjs): отдельный ночной шаг сервера, от сборки
// утреннего списка (morning-build.mjs, 22:03 ET) не зависит и её каталог не трогает.
//
//   node scripts/vps/intraday-ref.mjs [--state /var/lib/insider840-signals] [--max-min 90] [--interval 300] [--once] [--force]
//        [--no-sync] [--no-bars] [--data DIR] [--now ISO] [--min-tickers 300] [--forms-from DIR] [--no-forms-from]
//
// Что делает (попытки каждые --interval секунд, не дольше --max-min минут; завершённые шаги не повторяются):
//   1. asOf — последний торговый день с закрытым баром, день сигнала — следующий торговый день. Годный справочник на этот день
//      уже лежит (refReady: те же бары, формы по последний рабочий день SEC, справочники иностранных эмитентов готовы, вселенная
//      полная) — выход без работы; негодный или неполный — пересборка (таймеров два: 23:52 и 07:00 ET; утренний работает не
//      дольше 45 минут — до предполёта бота). Формы, которые справочник обязан нести (по последний рабочий день SEC перед днём
//      сигнала), ещё не полны — выход 0 без работы (tooEarly: только накануне Страстной пятницы, чт 23:52 и пт 07:00).
//   2. ветка data — своя копия в $STATE/build/repo (анонимный shallow-fetch, чистое дерево). Формы в ней должны быть разобраны по
//      последний рабочий день SEC перед днём сигнала (state/live.json, lastDay): по ним поправки 4/A и синхронные подачи дня
//      сигнала находят исходные строки. Ветку data пишет только прогон GitHub; если он опоздал, живой шард и его состояние берутся
//      из копии ночной сборки списка на этом же сервере (--forms-from, по умолчанию /var/lib/insider840-morning/repo: она разбирает
//      формы дня сама в 22:03). Свежих форм нет нигде — повтор; на последней попытке справочник собирается как есть, и процесс
//      сигналов выключит день (off, stale_forms).
//   3. вселенная: бумаги справочника SEC на биржах с кэшем цен, оборотом от $20 млн и ценой от $4 на последнем баре кэша
//      (запас к порогам сигнала $30 млн и $5), плюс SPY и IWM.
//   4. бары вселенной через воркер /bars (Yahoo с адреса VPS не трогаем) с перекрытием не меньше BARS_BACK_DAYS дней: в ветке data
//      свежий бар лежит только у половины бумаг от $30 млн (ежедневная сборка обновляет ряды бумаг с покупками за 25 месяцев,
//      остальные — по 150 за прогон). Бар незакрытого дня не берётся (lib/session.mjs). Тот же ответ несёт минимумы дня — они
//      дописываются в копию слоя reference/lows.csv.gz за последние дни (отсев «скидка к рынку»).
//   5. compute --only-morning --intraday-ref: справочник считает сам compute своими функциями (цена, оборот, просадка, признаки
//      отсевов, пометка иностранных эмитентов). Его morning.json остаётся в рабочем каталоге и никуда не уходит.
//   6. проверка и атомарная установка $STATE/ref/<день сигнала>.json (читает процесс сигналов signal-watch.mjs).
// Выход 0 — годный справочник на месте; 1 — не собран или собран негодным (формы устарели, справочники иностранных эмитентов не
// готовы) — тревога юнита: в такой день процесс сигналов запишет off, контур бота молчит.
// В ветку data и в воркер шаг ничего не пишет. Код берётся из клона репозитория (обновляет только install.sh).
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson, writeJson, addDaysIso } from '../lib/util.mjs';
import { nyWall, nyToMs } from '../lib/nytime.mjs';
import { barClosedAtMs, openBarDay, dropOpenBars } from '../lib/session.mjs';
import { fetchBars, applyBars, applyLows, BACK_DAYS } from '../lib/bars.mjs';
import { readPriceCache, turnover20 } from '../lib/prices.mjs';
import { loadTickerRef, plausibleTicker, ALLOWED_EXCHANGES } from '../lib/universe.mjs';
import { OPENS_BENCH } from '../lib/opens.mjs';
import { SIGNAL, refDays, refProblem, prevSecDay } from '../lib/intraday.mjs';

const CODE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[intraday-ref]', ...a);

export const REF = {
  barsBackDays: 24,        // запрос баров начинается не позже чем за столько дней до asOf: минимумы дня нужны за tailBars последних баров
  staleCacheDays: 60,      // кэш старше — бумага ушла с биржи или не обновляется: во вселенную не берётся
  minTickers: 300,         // справочник с меньшим числом бумаг — не справочник (сбой источника цен)
  freshShare: 0.97,        // доля вселенной, по которой источник цен ответил, с которой справочник считается полным
  freshShareLast: 0.8,     // на последней попытке хватит и этого (остальные бумаги сигнала не дадут)
  keepDays: 10,            // сколько справочников хранить
  morningMaxMin: 45,       // утренний повтор (запуск с 04:00 до 12:00 ET) работает не дольше: в 08:20 стартует торговый день бота
  // Жёсткий срок утреннего повтора: расчёт (compute, до 3 ГБ памяти) не начинается позже morningComputeBy и снимается, если идёт
  // дольше morningKillBy, — иначе медленный источник цен сдвинул бы его на старт дня бота (08:20), приём списка (08:30) и
  // постановку заявок. Не успел — выход с ошибкой (тревога dash-alert), процесс сигналов в этот день сам напишет off.
  morningComputeBy: '08:05',
  morningKillBy: '08:15',
  // Формы дня need (последний рабочий день SEC перед днём сигнала) полны только после его дневного индекса EDGAR (подачи до 22:00 ET).
  // Раньше справочник собрался бы негодным (stale_forms) и поднял тревогу юнита, хотя ничего не сломано (tooEarly ниже).
  formsReadyEt: '22:00',
  pauseMs: 1500,           // пауза между пачками по 20 бумаг у воркера: вселенная — около 85 пачек, спешить некуда
};

export function parseArgs(argv, env = process.env) {
  const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const flag = n => argv.includes(n);
  const state = resolve(val('--state', env.SIGNALS_STATE || '/var/lib/insider840-signals'));
  const build = join(state, 'build');
  return {
    state, build, refDir: join(state, 'ref'), data: resolve(val('--data', join(build, 'repo'))), site: join(build, 'site'),
    maxMin: Number(val('--max-min', '90')), interval: Number(val('--interval', '300')),
    once: flag('--once'), force: flag('--force'), noSync: flag('--no-sync'), noBars: flag('--no-bars'),
    now: val('--now', null), minTickers: Number(val('--min-tickers', String(REF.minTickers))),
    formsFrom: flag('--no-forms-from') ? null : resolve(val('--forms-from', join(env.MORNING_STATE || '/var/lib/insider840-morning', 'repo'))),
    repoUrl: env.DATA_REPO_URL || 'https://github.com/ML371KL/temp-zero-inode-840.git',
    workerUrl: (env.PAPER_URL || 'https://radar840-quotes.financehub.workers.dev').replace(/\/$/, ''),
    token: env.PAPER_TOKEN || '',
    env,
  };
}

// killAtMs — момент, после которого процесс снимается (SIGKILL: compute не держит ничего, что надо дописывать) и код — 124
export function run(cmd, args, { cwd, env, label, killAtMs = null }) {
  return new Promise(resolveP => {
    const p = spawn(cmd, args, { cwd, env, stdio: 'inherit' });
    let killed = false;
    const timer = killAtMs === null ? null : setTimeout(() => { killed = true; log(`${label}: срок вышел — снимаю`); p.kill('SIGKILL'); }, Math.max(0, killAtMs - Date.now()));
    p.on('error', e => { if (timer) clearTimeout(timer); log(`${label}: не запустился — ${e.message}`); resolveP(127); });
    p.on('close', code => { if (timer) clearTimeout(timer); resolveP(killed ? 124 : (code ?? 1)); });
  });
}
// Утренний срок расчёта в мс или null (ночной запуск). day — дата по Нью-Йорку
export function morningDeadlines(nowMs) {
  const w = nyWall(nowMs), hour = Number(w.slice(11, 13));
  if (!(hour >= 4 && hour < 12)) return null;
  const day = w.slice(0, 10);
  return { computeBy: nyToMs(`${day}T${REF.morningComputeBy}`), killBy: nyToMs(`${day}T${REF.morningKillBy}`) };
}
const git = (args, o) => run('git', args, { cwd: o.cwd, env: o.env, label: 'git ' + args[0] });
// Ветка data -> своя копия (как у сборки списка: постоянный репозиторий, каждый запуск — чистое дерево)
async function syncData(opts) {
  const env = { ...process.env, HOME: opts.build, GIT_TERMINAL_PROMPT: '0' };
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

// Вселенная справочника по кэшу цен копии данных: { T: дата последнего бара }. Порог — по последнему бару кэша (он может быть
// старше asOf на дни): с запасом к порогам сигнала, чтобы бумага у порога не выпала из-за устаревшего кэша.
export function pickUniverse(dataDir, asOf, p = SIGNAL, q = REF) {
  const ref = loadTickerRef(dataDir);
  const out = {}, stat = { ref: 0, noCache: 0, stale: 0, thin: 0 };
  const cut = addDaysIso(asOf, -q.staleCacheDays);
  for (const v of ref.values()) {
    const T = String(v?.ticker ?? '').toUpperCase();
    if (!plausibleTicker(T) || !ALLOWED_EXCHANGES.has(v.exchange) || out[T]) continue;
    stat.ref++;
    const s = readPriceCache(dataDir, T);
    if (!s?.length) { stat.noCache++; continue; }
    const i = s.length - 1;
    if (s[i][0] < cut) { stat.stale++; continue; }
    if (!(s[i][1] >= p.refPxMin) || !(turnover20(s, i) >= p.refDvMin)) { stat.thin++; continue; }
    out[T] = s[i][0];
  }
  return { universe: out, stat };
}

const lastBar = (data, t) => { const s = readPriceCache(data, t); return s?.length ? s[s.length - 1][0] : null; };
const minIso = (a, b) => (a < b ? a : b);

// Ответ источника без баров позже asOf и без бара незакрытого дня
export function closedOnly(res, asOf, nowMs) {
  let r = dropOpenBars(res, openBarDay(nowMs));
  if (r?.series?.length && r.series[r.series.length - 1][0] > asOf) {
    const keep = x => x[0] <= asOf;
    r = { ...r, series: r.series.filter(keep), ...(r.ohlc ? { ohlc: r.ohlc.filter(keep) } : {}), ...(r.lows ? { lows: r.lows.filter(keep) } : {}) };
  }
  return r;
}

// По какой день в копии данных разобраны формы; если ветка data отстала от последнего рабочего дня SEC, а копия ночной сборки
// списка на этом сервере свежее — её живой шард и состояние разбора кладутся в нашу копию. Возвращает день (или null).
export function freshForms(opts, need) {
  const lastOf = dir => readJson(join(dir, 'state', 'live.json'), null)?.lastDay ?? null;
  let last = lastOf(opts.data);
  if (opts.formsFrom && !(last >= need)) {
    try {
      const sl = lastOf(opts.formsFrom), shard = join(opts.formsFrom, 'trades', 'live.json.gz');
      if (sl && (!last || sl > last) && existsSync(shard)) {
        mkdirSync(join(opts.data, 'trades'), { recursive: true }); mkdirSync(join(opts.data, 'state'), { recursive: true });
        copyFileSync(shard, join(opts.data, 'trades', 'live.json.gz'));
        copyFileSync(join(opts.formsFrom, 'state', 'live.json'), join(opts.data, 'state', 'live.json'));
        log(`формы: в ветке data разобраны по ${last ?? '—'}, в копии ночной сборки списка — по ${sl}: взят её живой шард`);
        last = sl;
      }
    } catch (e) { log(`формы: копия ночной сборки списка не читается (${e.message})`); }
  }
  return last;
}
// Рано собирать: формы, которые обязан нести справочник на день сигнала (по prevSecDay — последний рабочий день SEC перед ним), ещё
// не полны — их день не наступил или его индекс не вышел. Так бывает только накануне Страстной пятницы (биржа закрыта, SEC работает):
// в чт 23:52 и пт 07:00 день сигнала — понедельник, а формы нужны по пятницу. До 27.11.2026 шаг в эти два запуска собирал справочник
// (compute, до 3 ГБ), получал stale_forms и выходил с кодом 1 — ложная тревога (ближайшая — 25–26.03.2027); годный справочник
// собирался только в пт 23:52. -> null или { need, text }
export function tooEarly(days, nowMs, p = REF) {
  const need = prevSecDay(days.forDay);
  const readyMs = nyToMs(`${need}T${p.formsReadyEt}`);
  return readyMs !== null && nowMs < readyMs
    ? { need, text: `рано: справочник на ${days.forDay} несёт формы по ${need}, а они полны только после ${p.formsReadyEt} ET ${need} — соберётся следующим запуском после этого` }
    : null;
}
// Готовый справочник пересобирать не нужно: тот же день и те же бары, день по нему не будет выключен, вселенная полная
export const refReady = (have, days) => !!have && have.v === SIGNAL.v && have.asOf === days.asOf && have.for === days.forDay
  && !have.partial && refProblem(have, days.forDay) === null;

// Одна попытка. ctx хранит завершённые шаги и вселенную между попытками.
export async function attempt(opts, days, ctx, { fetchBarsImpl = fetchBars, nowMs = () => Date.now() } = {}) {
  const st = ctx.stage;
  const fail = why => { log('✗', why); return { ok: false, why }; };
  const late = () => ({ ok: false, late: true, why: `утром расчёт справочника не начинается позже ${REF.morningComputeBy} ET (в 08:20 — старт дня бота), а сейчас ${nyWall(nowMs()).slice(11, 16)} ET` });
  const { asOf, forDay } = days;
  if (ctx.deadlines && !st.built && nowMs() >= ctx.deadlines.computeBy) return late();
  if (!opts.noSync && !st.sync) {
    log('ветка data: загрузка…');
    if (!(await syncData(opts))) return fail('не удалось получить ветку data');
    st.sync = true;
  }
  if (!st.forms) {
    const need = prevSecDay(forDay), last = freshForms(opts, need);
    if (!(last >= need)) {
      const why = `формы разобраны по ${last ?? '—'}, а нужны по ${need}: ночной прогон данных ещё не вышел`;
      // до последней попытки ждём свежий снимок ветки data (она скачивается заново); на последней собираем как есть — день будет выключен
      if (!ctx.lastChance) { st.sync = false; return fail(why); }
      log(`ВНИМАНИЕ (последняя попытка, идём как есть): ${why} — процесс сигналов выключит день`);
    }
    st.forms = true;
  }
  if (!ctx.universe) {
    const u = pickUniverse(opts.data, asOf);
    ctx.universe = u.universe;
    log(`вселенная: ${Object.keys(u.universe).length} бумаг (биржевых в справочнике SEC ${u.stat.ref}; без кэша цен ${u.stat.noCache}, кэш старше ${REF.staleCacheDays} дней ${u.stat.stale}, ниже запаса по цене и обороту ${u.stat.thin})`);
  }
  const names = Object.keys(ctx.universe);
  if (!opts.noBars && !st.bars) {
    if (!opts.token) return fail('PAPER_TOKEN не задан: бары взять негде');
    // Перекачивается всё, чего в этом запуске ещё не получали: и бумаги без бара asOf, и бумаги с ним (минимумы дня за последние дни
    // лежат только в ответе источника; бар из ветки data в обычную ночь закрытый, но перекачка этого не предполагает)
    const done = (ctx.got ??= new Set());
    const back = addDaysIso(asOf, -REF.barsBackDays);
    const want = [...OPENS_BENCH, ...names].filter(sym => !done.has(sym));
    const items = want.map(sym => {
      const last = sym in ctx.universe ? ctx.universe[sym] : lastBar(opts.data, sym);
      return { sym, from: minIso(last ? addDaysIso(minIso(last, asOf), -BACK_DAYS) : back, back) };
    });
    log(`бары: ${items.length} бумаг через воркер…`);
    const r = await fetchBarsImpl(opts.workerUrl, opts.token, items, { pauseMs: REF.pauseMs });
    const now = nowMs();
    const got = new Map([...r.got].map(([sym, res]) => [sym, closedOnly(res, asOf, now)]));
    const stat = applyBars(opts.data, got, { updated: asOf });
    // минимумы дня — по последним барам ответа каждой бумаги (ключ слоя — тикер и дата)
    const needs = {};
    for (const [sym, res] of got) if (res?.lows?.length) needs[sym] = res.lows.slice(-SIGNAL.tailBars).map(x => x[0]);
    const lows = applyLows(opts.data, got, needs);
    for (const sym of got.keys()) done.add(sym);
    const transient = Object.keys(r.failed).filter(sym => !got.has(sym));
    log('бары:', JSON.stringify({ merged: stat.merged, missing: stat.missing.length, failed: transient.length, limited: r.limited, lows }));
    for (const b of OPENS_BENCH) if (lastBar(opts.data, b) !== asOf) return fail(`у ${b} нет бара ${asOf} (последний ${lastBar(opts.data, b) ?? '—'}): источник цен не ответил или день ещё не закрыт`);
    // Полнота — по ответам источника: бумага, на которую он ответил, но бара asOf не дал (торги остановлены, ушла с биржи), в
    // справочник не попадёт и повтором не лечится; повтор нужен тем, на кого ответа не было (сбой, лимит воркера)
    const answered = names.filter(sym => done.has(sym)).length;
    const share = names.length ? answered / names.length : 0;
    ctx.fresh = names.filter(sym => lastBar(opts.data, sym) === asOf).length;
    log(`источник ответил по ${answered} из ${names.length} бумаг вселенной (${(share * 100).toFixed(1)}%); свежий бар ${asOf} у ${ctx.fresh}`);
    if (share < (ctx.lastChance ? REF.freshShareLast : REF.freshShare)) {
      return fail(`источник цен ответил только по ${(share * 100).toFixed(1)}% вселенной${r.limited ? ' (воркер ответил лимитом)' : ''}${transient.length ? `; не получены: ${transient.slice(0, 8).join(', ')}${transient.length > 8 ? '…' : ''}` : ''}`);
    }
    if (share < REF.freshShare) log('ВНИМАНИЕ (последняя попытка, идём как есть): бумаги без свежего бара в справочник не попадут и сигнала не дадут');
    ctx.partial = share < REF.freshShare;
    st.bars = true;
  }
  if (!st.built) {
    if (ctx.deadlines && nowMs() >= ctx.deadlines.computeBy) return late();
    mkdirSync(opts.site, { recursive: true });
    mkdirSync(opts.refDir, { recursive: true });
    const uniFile = join(opts.build, 'universe.json'), tmp = join(opts.refDir, `.${forDay}.json.tmp`);
    writeJson(uniFile, names);
    const code = await run(process.execPath, ['--max-old-space-size=3072', join(CODE, 'scripts/compute.mjs'), '--data', opts.data, '--site', opts.site,
      '--only-morning', '--builder', 'vps-ref', '--intraday-ref', tmp, '--intraday-for', forDay, '--intraday-universe', uniFile],
      { cwd: CODE, env: { ...process.env, ...opts.env }, label: 'compute', killAtMs: ctx.deadlines?.killBy ?? null });
    if (code === 124 && ctx.deadlines) return { ok: false, late: true, why: `расчёт справочника не успел к ${REF.morningKillBy} ET и снят` };
    if (code) return fail(`compute завершился с ошибкой (код ${code})`);
    const ref = readJson(tmp, null);
    const bad = !ref ? 'файл не записан' : ref.v !== SIGNAL.v ? `версия ${ref.v}` : ref.asOf !== asOf ? `бары по ${ref.asOf}, а нужен ${asOf}` : ref.for !== forDay ? `день ${ref.for}` : !(ref.n >= opts.minTickers) ? `бумаг ${ref.n}, меньше ${opts.minTickers}` : null;
    if (bad) { try { unlinkSync(tmp); } catch { /* нет файла */ } return fail(`справочник не годен: ${bad}`); }
    // неполная вселенная (источник цен ответил не по всем бумагам) — пометка: утренний повтор такой справочник пересоберёт
    if (ctx.partial) writeJson(tmp, { ...ref, partial: true });
    renameSync(tmp, join(opts.refDir, `${forDay}.json`));
    ctx.problem = refProblem(ref, forDay);
    ctx.summary = { for: forDay, asOf, n: ref.n, universe: names.length, formsThrough: ref.formsThrough ?? null, fpiWarn: ref.fpiWarn?.length ?? 0, ...(ctx.partial ? { partial: true } : {}) };
    log(`справочник на ${forDay} по барам ${asOf}: бумаг ${ref.n}${ref.fpiWarn?.length ? `; ВНИМАНИЕ, справочники иностранных эмитентов не готовы — сигналов в этот день не будет: ${ref.fpiWarn.join('; ')}` : ''}`);
    st.built = true;
  }
  return { ok: true };
}

export function pruneRefs(refDir, forDay, keepDays = REF.keepDays) {
  if (!existsSync(refDir)) return 0;
  const cut = addDaysIso(forDay, -keepDays);
  let n = 0;
  for (const f of readdirSync(refDir)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < cut) { unlinkSync(join(refDir, f)); n++; }
  return n;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv, env);
  mkdirSync(opts.build, { recursive: true });
  const fixed = opts.now ? Date.parse(opts.now) : null;
  if (opts.now && !Number.isFinite(fixed)) throw new Error('--now: нужен момент времени в ISO');
  const nowMs = () => fixed ?? Date.now();
  const days = refDays(nowMs(), nyWall(nowMs()).slice(0, 10), barClosedAtMs);
  const have = readJson(join(opts.refDir, `${days.forDay}.json`), null);
  if (refReady(have, days) && !opts.force) {
    log(`справочник на ${days.forDay} по барам ${days.asOf} уже есть (бумаг ${have.n}, формы по ${have.formsThrough}) — выходим`);
    return 0;
  }
  const early = tooEarly(days, nowMs());
  if (early && !opts.force) { log(early.text); return 0; }
  if (have && have.for === days.forDay) log(`справочник на ${days.forDay} есть, но не годен или неполон (${refProblem(have, days.forDay)?.text ?? (have.partial ? 'вселенная неполная' : 'другие бары')}) — пересборка`);
  // утренний повтор не должен дойти до торгового дня бота (08:20 ET): compute занимает до 3 ГБ памяти
  const hour = Number(nyWall(nowMs()).slice(11, 13));
  const maxMin = hour >= 4 && hour < 12 ? Math.min(opts.maxMin, REF.morningMaxMin) : opts.maxMin;
  log(`день сигнала ${days.forDay}, бары по ${days.asOf}; ${nyWall(nowMs()).slice(0, 16)} ET, не дольше ${maxMin} мин`);
  const untilMs = Date.now() + maxMin * 60e3;
  // утренний запуск: жёсткий срок расчёта (по часам --now, если они заданы)
  const ctx = { stage: {}, lastChance: false, summary: null, deadlines: morningDeadlines(nowMs()) };
  if (ctx.deadlines && fixed !== null) ctx.deadlines.killBy = Date.now() + (ctx.deadlines.killBy - fixed);
  for (let n = 1; ; n++) {
    ctx.lastChance = opts.once || Date.now() + opts.interval * 1000 >= untilMs;
    log(`попытка ${n}${ctx.lastChance ? ' (последняя)' : ''}`);
    const r = await attempt(opts, days, ctx, { nowMs });
    if (r.ok) {
      pruneRefs(opts.refDir, days.forDay);
      if (ctx.problem) {
        // справочник лежит, но день по нему будет выключен: тревога сейчас, а не в 09:25; утренний повтор пересоберёт
        log(`СОБРАН, НО НЕ ГОДЕН: ${ctx.problem.text} — сигналов ${days.forDay} не будет, если утренний повтор не исправит`, JSON.stringify(ctx.summary));
        return 1;
      }
      log('готово', JSON.stringify(ctx.summary));
      return 0;
    }
    if (r.late) { log(`НЕ СОБРАНО (поздно): ${r.why} — сигналов ${days.forDay} не будет, процесс сигналов запишет off`); return 1; }
    if (ctx.lastChance) { log(`НЕ СОБРАНО: ${r.why} — сигналов ${days.forDay} не будет`); return 1; }
    await sleep(opts.interval * 1000);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
