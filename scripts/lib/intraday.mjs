// Сигнал в торговые часы (контур B бота ibkr-bot-840): форма 4 с покупкой, принятая SEC днём, для скора от 3.
// Проверка рычага — audit-840-levers-2026-11-17/REPORT.md, разделы 3–6; схема — B-ВНЕДРЕНИЕ.md и B-ПОСЛЕ-АУДИТА-ФОРМ.md.
//
// Скор считает панель, бот его только читает — как с утренним списком. Здесь две половины, обе без ввода-вывода:
//
//  1. Справочник D−1 (buildIntradayRef). Его пишет compute.mjs с ключом --intraday-ref в отдельном ночном шаге сервера
//     (scripts/vps/intraday-ref.mjs) по закрытым барам: всё, что отсевам и скору нужно знать о бумаге и о прошлых сделках и что не
//     зависит от сегодняшней формы. Считают это те же функции compute, что и ночной список, — справочник только хранит ответы.
//  2. Расчёт события дня (evalEvent). Процесс рядом с лентой (scripts/vps/signal-watch.mjs) по каждой новой форме с покупкой
//     пересчитывает событие эмитента теми же applyGates и buildDayFull, что ночная сборка; контекст — из справочника. Сети нет.
//
// Отличия от ночного списка — только в том, какая цена известна в момент сигнала:
//  - цена ≥ $5, оборот и просадка — по последнему закрытому бару (asOf справочника, для дня сигнала это D−1), а не по бару D0;
//  - сделка, датированная днём сигнала (30% событий контура, лучшая их часть), сверяется с тем же последним баром: бара своего дня
//    у неё ещё нет. Так же поступает compute с любой сделкой, чья дата позже конца ряда. Итоговую сверку цены формы с котировкой
//    делает бот (поля td, fpx, same, units записи сигнала);
//  - порог оборота сигнала — $30 млн (у списка $10 млн): контур измерен только на таких бумагах.
import { applyGates, isPlanned, isNonCommon } from './gates.mjs';
import { isPersonOwner, isFundOnly, topRole } from './entity.mjs';
import { isRoutineCMP, isRegularSeries } from './routine.mjs';
import { MORNING, buildDayFull } from './morning.mjs';
import { resolveAmendments, rejoinOrphanAmendments, ownerKeyOf, plausibleTicker, issuerCategory } from './universe.mjs';
import { secKey } from './edgar.mjs';
import { nominalFactor, turnover20 } from './prices.mjs';
import { fpiVerdict, fpiStaleWarning } from './fpi.mjs';
import { addDaysIso } from './util.mjs';
import { nyToMs } from './nytime.mjs';
import { isMarketClosed, isSecClosed, marketCloseEt } from './calendar.mjs';

export const SIGNAL = {
  v: 1,                 // версия формата справочника и файла сигналов
  scoreMin: 2,          // порог скора записи сигнала (бот берёт от 3; скор 2 нужен приёмке механики — ступени 2 и 3 схемы)
  dvMin: 3e7,           // оборот бумаги на asOf, с которого событие даёт сигнал, $
  minPx: 5,             // закрытие asOf, $
  refDvMin: 2e7,        // оборот, с которого бумага попадает в справочник (запас к dvMin: причина пропуска видна в файле сигналов)
  refPxMin: 4,          // то же для цены
  tailBars: 14,         // сколько последних баров бумаги хранит справочник: сделка старше 10 рабочих дней отсеивается как поздняя
  recentDays: 30,       // покупки с датой сделки за столько дней до asOf: поправки 4/A, повторные подачи, синхронные подачи
  regularKeep: 12,      // последних покупок пары «владелец — эмитент» для отсева «регулярная серия»
  regularBackDays: 230, // пары, чья последняя покупка старше, серию дать не могут (шаг серии не больше 200 дней)
};

const rnd = (v, k = 4) => Math.round(v * 10 ** k) / 10 ** k;
const isoZ = ms => new Date(ms).toISOString().slice(0, 19) + 'Z';

// ---------- календарь дня сигнала ----------
// Последний торговый день, чей бар в момент nowMs закрыт (с запасом closedAtMs — lib/session.mjs, barClosedAtMs), и следующий
// торговый день после него — день, для которого строится справочник.
export function refDays(nowMs, nyDate, closedAtMs) {
  let asOf = nyDate;
  for (let k = 0; k < 15; k++, asOf = addDaysIso(asOf, -1)) {
    const at = closedAtMs(asOf);
    if (at !== null && nowMs >= at) break;
  }
  let forDay = addDaysIso(asOf, 1);
  while (isMarketClosed(forDay)) forDay = addDaysIso(forDay, 1);
  return { asOf, forDay };
}
// Последний рабочий день SEC раньше дня day: по этот день в справочнике должны лежать формы (поправки 4/A, повторные и синхронные
// подачи дня сигнала ищут в них исходные строки). Биржевой праздник при работающей SEC (Страстная пятница) — рабочий день SEC.
export function prevSecDay(day) {
  let d = addDaysIso(day, -1);
  while (isSecClosed(d)) d = addDaysIso(d, -1);
  return d;
}
// Предыдущий торговый день
export function prevMarketDay(day) {
  let d = addDaysIso(day, -1);
  while (isMarketClosed(d)) d = addDaysIso(d, -1);
  return d;
}
// Основная сессия дня day в момент nowMs: [09:30, закрытие), в сокращённый день закрытие 13:00
export function inSession(nowMs, day) {
  const close = marketCloseEt(day);
  if (!close) return false;
  return nowMs >= nyToMs(`${day}T09:30`) && nowMs < nyToMs(`${day}T${close}`);
}

// ---------- справочник D−1 ----------
// Вызывается из compute.mjs после фазы гейтов. Всё считается его же функциями и по его же данным:
//   forDay — день сигнала; spy — ряд SPY (его последний бар — asOf); universe — Set тикеров, чьи бары перекачаны (null — все);
//   ref — справочник тикеров SEC (Map cik -> {ticker, exchange, name}); symRanges — реестр символов; series(t) — ряд цен;
//   splits — prices/_splits.json; lowsMap — слой минимумов дня; unitsMismatch — Set тикеров с признаком «другие единицы»;
//   drawdownAt, dollarVolumeAt — функции compute; fpiRefs, fpiBefore — справочники иностранных эмитентов;
//   trades — все строки после разрешения поправок; history — buildOwnerHistory(trades); ownerGroups — buildOwnerGroups(trades);
//   formsThrough — по какой день в данных разобраны формы (state/live.json, lastDay): процесс сигналов требует, чтобы это был
//   последний рабочий день SEC перед днём сигнала, иначе день выключается (refProblem, причина stale_forms).
export function buildIntradayRef({ forDay, spy, universe = null, ref, symRanges, series, splits, lowsMap, unitsMismatch, drawdownAt, dollarVolumeAt,
  fpiRefs, fpiBefore, trades, history, ownerGroups, formsThrough = null }, p = SIGNAL) {
  const asOf = spy?.length ? spy[spy.length - 1][0] : null;
  const fpiWarn = [...(fpiRefs?.warn ?? [])];
  { const w = fpiStaleWarning(fpiRefs, forDay); if (w) fpiWarn.push(w); }
  const tickers = {};
  const skipped = { stale: 0, thin: 0, noCache: 0 };
  for (const [cik, v] of ref) {
    const T = String(v?.ticker ?? '').toUpperCase();
    if (!plausibleTicker(T) || (universe && !universe.has(T))) continue;
    if (issuerCategory({ cik, t: T, tdate: asOf }, ref, symRanges) === 'otc') continue;
    const s = series(T);
    if (!s?.length) { skipped.noCache++; continue; }
    const i = s.length - 1;
    if (s[i][0] !== asOf) { skipped.stale++; continue; }            // нужен бар именно asOf: по старому бару цена и оборот не считаются
    const sp = splits?.[T];
    const px = rnd(s[i][1] * nominalFactor(sp, asOf), 4), adv = turnover20(s, i);
    if (!(px >= p.refPxMin) || !(adv >= p.refDvMin)) { skipped.thin++; continue; }
    const bars = [];
    for (let k = Math.max(0, s.length - p.tailBars); k < s.length; k++) {
      const d = s[k][0];
      // дата, номинальное закрытие (как r._close в compute), просадка, оборот 60 баров, число баров до даты включительно
      bars.push([d, rnd(s[k][1] * nominalFactor(sp, d), 4), drawdownAt(s, d), dollarVolumeAt(s, d), k + 1]);
    }
    const fpi = fpiRefs?.first ? fpiVerdict({ cik, ticker: T, fdate: forDay, bar0: s[0][0] }, fpiRefs, { ranges: symRanges, before: fpiBefore }) : null;
    tickers[cik] = { t: T, name: v.name ?? T, px, adv, bars, ...(unitsMismatch?.has(T) ? { units: 1 } : {}), ...(fpi ? { fpi } : {}) };
  }
  // Рутинные по CMP владельцы для месяцев, на которые может прийтись дата сделки из формы дня сигнала (текущий и предыдущий
  // календарный): ответ зависит только от года и месяца сделки и от прошлых лет, сегодняшняя форма его не меняет. Предыдущий —
  // именно календарный: «день сигнала минус 31 день» после 30-дневного месяца и после февраля попадал в позапрошлый, и в первые
  // дни месяца сделки прошлого месяца проверку рутинности не проходили вовсе (независимое чтение 20.11.2026, С1).
  const months = [...new Set([addDaysIso(`${forDay.slice(0, 7)}-01`, -1).slice(0, 7), forDay.slice(0, 7)])];
  const routine = Object.fromEntries(months.map(m => [m, []]));
  // Последние покупки пары «владелец — эмитент» для отсева «регулярная серия» (isRegularSeries смотрит покупки строго до сделки).
  // Записи с одинаковой датой сохраняются все: нулевой шаг между покупками серию отменяет.
  const regular = {};
  const cutReg = addDaysIso(forDay, -p.regularBackDays);
  for (const [owner, hist] of history) {
    for (const m of months) if (isRoutineCMP(hist, `${m}-15`) === true) routine[m].push(owner);
    const byIssuer = new Map();
    for (const h of hist) if (h.code === 'P') (byIssuer.get(h.cik) ?? byIssuer.set(h.cik, []).get(h.cik)).push(h.tdate);
    for (const [issuer, dates] of byIssuer) {
      if (dates[dates.length - 1] < cutReg) continue;
      (regular[owner] ??= {})[issuer] = dates.slice(-p.regularKeep);
    }
  }
  // Группы связанных владельцев (совместные подачи): только те, у кого группа не совпадает с собственным номером
  const groups = {};
  for (const [o, g] of ownerGroups) if (g !== o) groups[o] = g;
  // Недавние покупки: по ним поправка 4/A находит исходную форму (и получает её дату подачи — событием дня сигнала она не станет),
  // повторная подача той же покупки отбрасывается, а отсев «синхронная подача» считает независимых подателей одной цены
  const recent = {};
  const cutRecent = addDaysIso(asOf ?? forDay, -p.recentDays);
  for (const r of trades) {
    // строки с датой подачи дня сигнала сюда не идут: они — событие дня, их приносит лента
    if (r.code !== 'P' || !(r.tdate >= cutRecent) || !(r.fdate < forDay)) continue;
    (recent[r.cik] ??= []).push({
      acc: r.acc, form: r.form, fdate: r.fdate, ...(r.fdate0 ? { fdate0: r.fdate0 } : {}), tdate: r.tdate, cik: r.cik, code: r.code,
      sec: r.sec ?? null, sh: r.sh, px: r.px, orig: r.orig ?? null, owners: (r.owners ?? []).map(o => ({ cik: o.cik, name: o.name })),
    });
  }
  // Минимумы дня за последние дни — как лежат в слое reference/lows.csv.gz: ключ «тикер ФОРМЫ | дата сделки» (у эмитента с двумя
  // классами акций тикер формы не совпадает с тикером справочника SEC, а отсев «скидка к рынку» ищет минимум по тикеру формы)
  const lows = {};
  for (const [k, v] of lowsMap ?? []) if (k.slice(k.indexOf('|') + 1) >= cutRecent) lows[k] = v;
  return {
    v: p.v, asOf, for: forDay, built: new Date().toISOString(), formsThrough: formsThrough ?? null, n: Object.keys(tickers).length, skipped,
    params: { refDvMin: p.refDvMin, refPxMin: p.refPxMin, tailBars: p.tailBars, recentDays: p.recentDays },
    fpiWarn, months, tickers, lows, routine, regular, groups, recent,
  };
}

// Справочник годится для дня day? -> null или { why, text } — причина записи off файла сигналов
export function refProblem(ref, day) {
  if (!ref) return { why: 'no_ref', text: `справочника D−1 на ${day} нет (ночной шаг insider840-signals-ref не отработал)` };
  if (ref.v !== SIGNAL.v || !ref.tickers || !ref.asOf) return { why: 'bad_ref', text: 'справочник D−1 не читается или другой версии' };
  if (ref.for !== day || ref.asOf !== prevMarketDay(day)) return { why: 'stale_ref', text: `справочник D−1 собран на ${ref.for} по барам ${ref.asOf}, а нужен на ${day} по барам ${prevMarketDay(day)}` };
  if (ref.fpiWarn?.length) return { why: 'fpi_warn', text: 'справочники иностранных эмитентов не готовы: ' + ref.fpiWarn.join('; ') };
  // Формы в справочнике старше последнего рабочего дня SEC: поправка 4/A к вчерашней форме стала бы событием дня, повторная подача —
  // новой покупкой, а «синхронная подача» не увидела бы вчерашних подателей той же цены — каждое из трёх даёт ложный сигнал
  const need = prevSecDay(day);
  if (!(ref.formsThrough >= need)) return { why: 'stale_forms', text: `в справочнике D−1 формы разобраны по ${ref.formsThrough ?? '—'}, а нужны по ${need} (ночной прогон данных опоздал)` };
  return null;
}

// ---------- расчёт события дня ----------
// Группы владельцев: справочник плюс совместные подачи сегодняшних форм (как buildOwnerGroups: юрлица и физлица склеиваются раздельно)
export class OwnerGroups {
  constructor(ref) { this.base = ref?.groups ?? {}; this.p = new Map(); }
  find(x) {
    let r = this.base[x] ?? x;
    while (this.p.has(r)) r = this.p.get(r);
    return r;
  }
  join(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
  addFiling(owners) {
    const os = (owners ?? []).filter(o => o?.cik);
    const ents = os.filter(o => !isPersonOwner(o)).map(o => o.cik), pers = os.filter(isPersonOwner).map(o => o.cik);
    for (let i = 1; i < ents.length; i++) this.join(ents[0], ents[i]);
    for (let i = 1; i < pers.length; i++) this.join(pers[0], pers[i]);
  }
}

// Строки дня после разрешения поправок — то же, что делает loadAllTrades со всеми строками: ключ «эмитент | лицо | дата сделки |
// код | класс», поправка замещает исходную строку и берёт её дату подачи, повтор исходной формы отбрасывается. prior — недавние
// строки справочника (уже разрешённые), today — строки сегодняшних форм. Возвращает строки с датой подачи day из сегодняшних форм.
export function resolveToday(prior, today, day) {
  const groups = new Map();
  for (const r of [...(prior ?? []), ...today]) {
    const k = `${r.cik}|${ownerKeyOf(r)}|${r.tdate}|${r.code}|${secKey(r.sec)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
  }
  rejoinOrphanAmendments(groups);
  const accs = new Set(today.map(r => r.acc)), mine = [], all = [];
  for (const g of groups.values()) {
    const rows = g.length === 1 ? g : resolveAmendments(g).rows;
    for (const r of rows) { all.push(r); if (r.fdate === day && accs.has(r.acc)) mine.push(r); }
  }
  // mine — строки события дня; all — все недавние покупки эмитента после разрешения (для отсева «синхронная подача»)
  return { mine, all };
}

// Рутинные владельцы месяца — множеством (в файле справочника это массив)
const routineMemo = new WeakMap();
function routineSet(ref, month) {
  let m = routineMemo.get(ref);
  if (!m) routineMemo.set(ref, m = new Map());
  if (!m.has(month)) m.set(month, new Set(ref.routine?.[month] ?? []));
  return m.get(month);
}

const barAt = (bars, tdate) => { let hit = null; for (const b of bars) if (b[0] <= tdate) hit = b; else break; return hit; };

// Событие эмитента cik за день day по покупкам сегодняшних форм rows (строки parseForm4Txt с кодом P, fdate = day).
// groups — OwnerGroups со всеми сегодняшними подачами. -> { kind: 'sig', … } | { kind: 'skip', why }
export function evalEvent(ref, day, cik, rows, groups, p = SIGNAL) {
  const tk = ref.tickers?.[cik];
  if (!tk) return { kind: 'skip', why: 'no_ref_ticker' };       // нет в справочнике SEC, нет свежего бара или оборот ниже запаса
  const prior = ref.recent?.[cik] ?? [];
  const resolved = resolveToday(prior, rows.filter(r => r.code === 'P'), day);
  const pool = resolved.all;
  // Поправка 4/A к форме, поданной раньше дня сигнала, чья сделка старше окна недавних покупок справочника: исходную строку ей
  // найти не в чем, хотя в полных данных она есть (compute отдаёт такой поправке дату исходной формы, и в событие дня она не
  // входит). Оставлять её нельзя: сама она отсеивается как поздняя, но «офицер» и просадка события берутся по всем строкам,
  // включая отсеянные, — поправка офицера к давней сделке давала событию лишний балл (независимое чтение 20.11.2026, Ср2).
  const cutRecent = addDaysIso(ref.asOf, -(ref.params?.recentDays ?? p.recentDays));
  const mine = resolved.mine.filter(r => !(r.form === '4/A' && r.orig && r.orig < day && r.tdate < cutRecent));
  if (!mine.length) return { kind: 'skip', why: 'amend' };      // поправки и повторы раньше поданных форм: событие не сегодняшнее
  const cands = mine.map(r => {
    const bar = barAt(tk.bars, r.tdate);
    const po = (r.owners ?? []).find(isPersonOwner) ?? r.owners?.[0] ?? null;
    let drop = null, dd = null;
    if (!bar) {
      // Сделка раньше хвоста ряда. Отсевы, которым цена не нужна (поздняя подача, вид бумаги, сноски), идут как обычно; прошла их —
      // сверять цену не с чем, строка в событие не входит
      const g = applyGates(r, { close: null, histDays: null, noPrice: true, planned: isPlanned(r), fundOnly: isFundOnly(r) });
      drop = g.ok ? 'nobar' : (g.drop ?? 'x');
    } else {
      dd = bar[2];
      const sync = new Set();
      if (r.px) for (const x of pool) if (x.tdate === r.tdate && x.px === r.px) for (const o of x.owners ?? []) sync.add(groups.find(o.cik));
      const hist = po ? [
        ...((ref.regular?.[po.cik]?.[cik]) ?? []).map(tdate => ({ tdate, cik, code: 'P' })),
        ...mine.filter(x => (x.owners ?? []).some(o => o.cik === po.cik)).map(x => ({ tdate: x.tdate, cik, code: 'P' })),
      ].sort((a, b) => (a.tdate < b.tdate ? -1 : a.tdate > b.tdate ? 1 : 0)) : [];
      const g = applyGates(r, {
        close: bar[1], reassigned: false, histDays: bar[4], noPrice: false,
        noLiquidity: bar[3] === null, dollarVolume: bar[3] ?? 0,
        syncFilers: r.px ? sync.size : 1,
        planned: isPlanned(r),
        routine: po && routineSet(ref, r.tdate.slice(0, 7)).has(po.cik) ? true : null,
        regular: isRegularSeries(hist, r.tdate, cik, 'P'),
        fundOnly: isFundOnly(r),
        unitsMismatch: !!tk.units,
        // слой минимумов ключуется тикером формы и точной датой сделки — как в compute
        lows: ref.lows?.[`${r.t}|${r.tdate}`] ?? null,
      });
      if (!g.ok) drop = g.drop ?? 'x';
    }
    return {
      cik, t: tk.t, name: tk.name, who: (r.owners ?? []).map(o => o.name),
      role: topRole((r.owners ?? []).filter(isPersonOwner).map(o => o.rel)), officer: (r.owners ?? []).some(o => /[CFO]/.test(o.rel ?? '')),
      common: !isNonCommon(r.sec), val: r.val, dd, adv: tk.adv, px: tk.px, at: r.at ?? null, drop, fpi: tk.fpi ?? null,
      _td: r.tdate, _fpx: r.px ?? null, _acc: r.acc,
    };
  });
  const built = buildDayFull(cands, MORNING, { fpiActive: day >= (p.fpiFrom ?? MORNING.fpiFrom) });   // p.fpiFrom — только для сверок на прошлых днях
  const row = built.rows[0];
  if (!row) {
    const ok = cands.filter(c => !c.drop && c.common !== false && c.val >= MORNING.minVal);
    if (!ok.length) return { kind: 'skip', why: 'gates:' + [...new Set(cands.map(c => (c.common === false ? 'security' : c.drop ?? 'minval')))].sort().join(',') };
    return { kind: 'skip', why: tk.px < MORNING.minPx ? 'px' : 'dv' };
  }
  if (row.fpi) return { kind: 'skip', why: 'fpi', score: row.score };
  if (!(row.px >= p.minPx)) return { kind: 'skip', why: 'px', score: row.score };
  if (!(row.dv >= p.dvMin)) return { kind: 'skip', why: 'dv', score: row.score };
  if (row.score < p.scoreMin) return { kind: 'skip', why: 'score', score: row.score };
  // ведущая строка — та же, что у buildDayFull: крупнейшая из прошедших отсевы
  const lead = cands.filter(c => !c.drop && c.common !== false && c.val >= MORNING.minVal).sort((a, b) => b.val - a.val)[0];
  return {
    kind: 'sig', cik, t: row.t, score: row.score,
    pts: { v100k: row.mx >= MORNING.scoreVal ? 1 : 0, v1m: row.mx >= MORNING.bigVal ? 1 : 0, off: row.tags.includes('off') ? 1 : 0, deep: row.tags.includes('deep') ? 1 : 0 },
    mx: row.mx, val: row.val, rows: row.n, dv: row.dv, px: row.px, asOf: ref.asOf, dd: row.dd, role: row.role,
    td: lead._td, fpx: lead._fpx, same: lead._td >= day, units: !!tk.units,
    accs: [...new Set(cands.filter(c => !c.drop).map(c => c._acc))], leadAcc: lead._acc,
  };
}

// ---------- состояние дня и записи файла сигналов ----------
// Время приёма формы SEC -> мс UTC: поле acs записи ленты (стенные часы Нью-Йорка с секундами), у старых записей — at строк (минуты)
export function acceptedMs(form) {
  const w = form?.acs ?? form?.at ?? form?.trades?.find(r => r.at)?.at ?? null;
  return w ? nyToMs(w) : null;
}

// Состояние процесса сигналов за день. restore — записи уже лежащего файла дня (перезапуск): повторно ничего не пишется.
export class DayState {
  constructor(ref, day, restore = []) {
    this.ref = ref; this.day = day;
    this.groups = new OwnerGroups(ref);
    this.forms = new Map();          // cik -> [записи form журнала ленты с покупками, в порядке прихода]
    this.accs = new Set();
    this.sigs = new Map();           // cik -> { n, score }
    this.skips = new Map();          // cik -> причина последней записи skip
    this.off = null;
    for (const r of restore) {
      if (r.k === 'sig') this.sigs.set(r.cik, { n: r.n, score: r.score });
      else if (r.k === 'skip') this.skips.set(r.cik, r.why);
      else if (r.k === 'off') this.off = r.why;
    }
  }
  // Новая запись form журнала ленты. seenAt — когда ленту увидела подачу (запись seen), nowMs — момент записи сигнала.
  // -> записи для файла сигналов (0 или 1)
  onForm(form, { seenAt = null, nowMs = Date.now() } = {}) {
    return this.onForms([form], { seenAtOf: () => seenAt, nowMs });
  }
  // Порция записей form, прочитанная из журнала за один раз (формы одного такта ленты). Сначала учитываются ВСЕ формы порции,
  // потом событие каждого затронутого эмитента считается один раз: три формы одной цены, принятые в одну минуту, — это
  // «синхронная подача» (признак размещения), и по первой из них сигнал уходить не должен (независимое чтение 20.11.2026, Ср1).
  // Формы, пришедшие разными тактами, по-прежнему считаются по мере прихода. seenAtOf(acc) — когда лента увидела подачу;
  // onError(cik, ошибка) — расчёт события одного эмитента не удался (остальные считаются). -> записи для файла сигналов
  onForms(forms, { seenAtOf = () => null, nowMs = Date.now(), onError = null } = {}) {
    return this.evalTouched(this.addForms(forms), { seenAtOf, nowMs, onError });
  }
  // Первая половина onForms: учесть формы порции, не считая событий. -> Map cik -> форма, принятая SEC позже остальных (причина
  // записи). Процесс сигналов держит событие (FormGate), пока пачка форм такта ленты не дочитана, и считает его evalTouched.
  addForms(forms) {
    const touched = new Map();       // cik -> форма порции, принятая SEC позже остальных: она и есть причина записи
    for (const form of forms ?? []) {
      if (!form || form.filed !== this.day || this.accs.has(form.acc)) continue;
      this.accs.add(form.acc);
      for (const r of form.trades ?? []) this.groups.addFiling(r.owners);
      const buys = (form.trades ?? []).filter(r => r.code === 'P');
      if (!buys.length) continue;
      const cik = buys[0].cik;
      (this.forms.get(cik) ?? this.forms.set(cik, []).get(cik)).push(form);
      const prev = touched.get(cik);
      if (!prev || (acceptedMs(form) ?? 0) >= (acceptedMs(prev) ?? 0)) touched.set(cik, form);
    }
    return touched;
  }
  // Вторая половина onForms: событие каждого эмитента из touched (cik -> форма-причина) считается один раз
  evalTouched(touched, { seenAtOf = () => null, nowMs = Date.now(), onError = null } = {}) {
    if (this.off) return [];
    const out = [];
    for (const [cik, form] of touched) {
      try { out.push(...this.evalIssuer(cik, form, { seenAt: seenAtOf(form.acc), nowMs })); }
      catch (e) { if (onError) onError(cik, e); else throw e; }
    }
    return out;
  }
  // Событие эмитента cik после формы form (она уже учтена) -> записи для файла сигналов (0 или 1)
  evalIssuer(cik, form, { seenAt = null, nowMs = Date.now() } = {}) {
    const buys = (form.trades ?? []).filter(r => r.code === 'P');
    const all = this.forms.get(cik);
    const res = evalEvent(this.ref, this.day, cik, all.flatMap(f => f.trades ?? []), this.groups);
    const t = isoZ(nowMs);
    if (res.kind === 'skip') {
      // причина пишется один раз на эмитента и снова — только когда она изменилась; после сигнала пропуски не пишутся
      if (this.sigs.has(cik) || this.skips.get(cik) === res.why) return [];
      this.skips.set(cik, res.why);
      return [{ k: 'skip', v: SIGNAL.v, t, day: this.day, cik, t_: this.ref.tickers?.[cik]?.t ?? String(buys[0].t ?? '').toUpperCase(), why: res.why, ...(res.score !== undefined ? { score: res.score } : {}), acc: form.acc }];
    }
    const prev = this.sigs.get(cik);
    if (prev && res.score <= prev.score) return [];              // одна запись на эмитента в день; повторная — только при росте скора
    const n = (prev?.n ?? 0) + 1;
    this.sigs.set(cik, { n, score: res.score });
    const at = acceptedMs(form);
    const times = all.filter(f => res.accs.includes(f.acc)).map(acceptedMs).filter(x => x !== null);
    // atmx — когда SEC приняла форму с крупнейшей покупкой события: в проверке рычага время события — именно оно, и бот входит,
    // только если эта форма свежая (а не одна лишь форма, добавившая событию балл)
    const lead = all.find(f => f.acc === res.leadAcc), atmx = lead ? acceptedMs(lead) : null;
    const { kind, accs, leadAcc, ...body } = res;
    return [{
      k: 'sig', v: SIGNAL.v, day: this.day, cik, t: body.t, n, acc: form.acc,
      at: at === null ? null : isoZ(at), at0: times.length ? isoZ(Math.min(...times)) : (at === null ? null : isoZ(at)),
      atmx: atmx === null ? null : isoZ(atmx), seen: seenAt ?? null, tw: t,
      score: body.score, pts: body.pts, mx: body.mx, val: body.val, rows: body.rows, dv: body.dv, px: body.px, asOf: body.asOf, dd: body.dd,
      role: body.role, td: body.td, fpx: body.fpx, same: body.same, units: body.units,
    }];
  }
}

// ---------- пачка форм такта ленты ----------
// Лента (feed-collector.mjs, tick) за такт сначала пишет записи seen по всем новым подачам, затем качает формы по одной и пишет
// запись form на каждую. Процесс сигналов читает журнал раз в 1,5 с и мог посчитать событие эмитента по части пачки: три формы
// размещения одной цены делились «две и одна», сигнал уходил по первым, а отсев «синхронная подача» видел бы только все три
// (независимая проверка 22.11.2026). Поэтому событие держится, пока у ленты есть замеченные и не скачанные подачи.
//
// Чьи это подачи, по записи seen не узнать: лента EDGAR даёт запись и на эмитента, и на каждого подавшего, а сборщик берёт первую
// (на журналах 05–17.11.2026 CIK записи seen совпадал с эмитентом формы у 15–20% подач). Поэтому ждать — любую незакрытую подачу,
// но недолго: подача, замеченная больше pendingSec назад и всё не скачанная (файла у SEC ещё нет, сеть), событие не держит, а одно
// событие держится не дольше maxSec (потолок — пока подачи всё прибывают). Формы разных тактов, между которыми пачка успела
// дочитаться, считаются по мере прихода, как раньше.
export const HOLD = { pendingSec: 20, maxSec: 30 };
export class FormGate {
  constructor(p = HOLD) { this.p = p; this.pending = new Map(); this.done = new Set(); this.held = new Map(); }
  // запись seen журнала ленты: подача замечена в seenMs
  seen(acc, seenMs) { if (acc && !this.done.has(acc) && Number.isFinite(seenMs)) this.pending.set(acc, seenMs); }
  // запись form: подача скачана
  formed(acc) { if (!acc) return; this.pending.delete(acc); this.done.add(acc); }
  // события, затронутые порцией форм (DayState.addForms), — держать до дочитки пачки
  hold(touched, nowMs) {
    for (const [cik, form] of touched) {
      const h = this.held.get(cik);
      if (!h) this.held.set(cik, { form, since: nowMs });
      else if ((acceptedMs(form) ?? 0) >= (acceptedMs(h.form) ?? 0)) h.form = form;
    }
  }
  // незакрытые подачи, которые сейчас держат события
  blockers(nowMs) {
    let n = 0;
    for (const ms of this.pending.values()) if (ms <= nowMs && nowMs - ms < this.p.pendingSec * 1000) n++;
    return n;
  }
  // события, которые пора считать: пачка дочитана, потолок ожидания вышел или force (конец работы).
  // -> [{ cik, form, held: секунд ожидания, cap: отпущено по потолку }]
  due(nowMs, { force = false } = {}) {
    const open = force ? 0 : this.blockers(nowMs), out = [];
    for (const [cik, h] of this.held) {
      const cap = open > 0 && nowMs - h.since >= this.p.maxSec * 1000;
      if (open > 0 && !cap && !force) continue;
      this.held.delete(cik);
      out.push({ cik, form: h.form, held: Math.max(0, Math.round((nowMs - h.since) / 100) / 10), cap });
    }
    // старые незакрытые подачи памяти не держат
    for (const [acc, ms] of this.pending) if (nowMs - ms >= this.p.pendingSec * 1000) this.pending.delete(acc);
    return out;
  }
}

// ---------- чтение дописываемого журнала ----------
// Разбор очередной порции файла: buf — остаток прошлого чтения плюс новые байты. Строка без завершающего \n — недописанная,
// остаётся в rest до следующего чтения. Нечитаемая строка пропускается.
export function splitLines(buf) {
  const text = typeof buf === 'string' ? buf : buf.toString('utf8');
  const cut = text.lastIndexOf('\n');
  if (cut < 0) return { recs: [], rest: text };
  const recs = [];
  for (const line of text.slice(0, cut).split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r === 'object') recs.push(r); } catch { /* оборванная запись */ }
  }
  return { recs, rest: text.slice(cut + 1) };
}

// ---------- задержка ленты и тревога контура ----------
export const LATENCY = { windowMin: 60, alarmSec: 120, minN: 5, okSec: 90, alarmEveryMin: 60 };
// samples — [{ t: мс записи формы в журнал, lat: секунд от приёма SEC }] -> сводка за окно до nowMs
export function latencyStat(samples, nowMs, p = LATENCY) {
  const xs = samples.filter(s => s.t > nowMs - p.windowMin * 60e3 && s.t <= nowMs).map(s => s.lat).sort((a, b) => a - b);
  const n = xs.length;
  if (!n) return { n: 0, med: null, p90: null, ok90: null, alarm: false };
  const q = f => xs[Math.min(n - 1, Math.floor(f * n))];
  const med = n % 2 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2;
  return { n, med: Math.round(med), p90: Math.round(q(0.9)), ok90: rnd(xs.filter(x => x <= p.okSec).length / n, 3), alarm: n >= p.minN && med > p.alarmSec };
}
