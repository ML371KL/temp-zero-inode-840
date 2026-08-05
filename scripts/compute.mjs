// Вычислительное ядро: вселенная -> конвейер гейтов G1–G8 -> рабочий набор -> форварды и
// календарно-временные портфели -> payload. Чистая функция от data/: без сети.
//
// В августе 2026 ядро сокращено до того, что пережило независимую проверку. Убраны кластеры
// (альфы не дают ни в одном срезе, внутри рабочего набора мешают), скор (к индексу не
// выводит), рейтинг инсайдеров по трек-рекорду (≥60% и <40% успеха дают одинаковый
// результат) и агрегатный рыночный индикатор (за 10 лет ни одного месяца в сигнальной зоне).
// Обоснование с числами — docs/ЧТО-РАБОТАЕТ.md.
//
// Порядок фаз важен и продиктован памятью: ценовые ряды всех ~6 тыс. тикеров одновременно
// не помещаются в раннер, поэтому всё, что требует цен, сгруппировано по тикеру с вытеснением
// кэша, а фазы без цен (гейты, признаки) идут отдельными проходами.
// Использование: node scripts/compute.mjs [--data data] [--site site]
import { readJson, writeJson, readJsonGz, isoToday, addDaysIso, isIsoDate } from './lib/util.mjs';
import { readPriceCache, nominalFactor, readStats, listedThrough } from './lib/prices.mjs';
import { loadSymbolRanges, sameInstrumentAsLatest } from './lib/symbols.mjs';
import {
  Panel, monthlyFromDaily, portfolioSeries, universeSeries, pairedDiff, turnover,
  factorAlpha, factorSeries, vsBenchmark, pathStats, neweyWestT, annualize, rfOf,
} from './lib/portfolio.mjs';
import { loadAllTrades, loadTickerRef, resolveTicker, issuerCategory, plausibleTicker } from './lib/universe.mjs';
import { applyGates, isPlanned, DROP_LABELS } from './lib/gates.mjs';
import { buildOwnerGroups, isPersonOwner, isFundOnly, topRole, dOwnOf } from './lib/entity.mjs';
import { buildOwnerHistory, isRoutineCMP, isRegularSeries, inflection } from './lib/routine.mjs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const DATA = argVal('--data', 'data');
const SITE = argVal('--site', 'site');

const today = isoToday();
const HORIZONS = { 3: 63, 6: 126, 12: 252, 24: 504 };  // месяцы -> торговые дни
const PERF_COLS = { d1: 1, w1: 5, m1: 21, m6: 126 };   // короткие колонки ленты
const FEED_DAYS = 200;
// РАБОЧИЙ НАБОР. Единственная конфигурация, у которой альфа к S&P 500 пережила все проверки:
// покупка при цене не ниже 5% от 52-недельного максимума, на существенную сумму, в бумаге
// с торгуемым оборотом; удержание три месяца. Пороги не на ножевом крае — по близости к
// максимуму эффект монотонен (−1% → +9.3%, −5% → +7.4%, −20% → 0.0%), по сумме плато от
// $10 тыс. до $150 тыс. Подробности и проверки — docs/ЧТО-РАБОТАЕТ.md.
const SET_MAX_DD = -0.05;      // не ниже 5% от 52-недельного максимума
const SET_MIN_VAL = 5e4;       // сумма сделки
const SET_MIN_DV = 3e6;        // дневной долларовый оборот бумаги
const SET_HOLD_MONTHS = 3;     // срок удержания — часть набора, а не настройка
const SET_FRESH_DAYS = 45;     // после этого срока сигнал считается протухшим (см. ниже)
const STALE_PRICE_DAYS = 14;
const SERIES_CACHE_MAX = 150;   // ограничение памяти на ценовые ряды
const rnd = (v, k = 4) => Math.round(v * 10 ** k) / 10 ** k;

// ---------- Загрузка ----------
const ref = loadTickerRef(DATA);
if (!ref.size) throw new Error('reference/tickers.json пуст — сначала запустите prices.mjs');
const { trades: tradesAll, stats: loadStats } = loadAllTrades(DATA);
if (!tradesAll.length) throw new Error('нет сделок — сначала backfill/live');

const spy = readPriceCache(DATA, 'SPY');
if (!spy || spy.length < 500) throw new Error('нет ряда SPY — бенчмарк обязателен, compute остановлен');
const iwm = readPriceCache(DATA, 'IWM');
if (!iwm || iwm.length < 500) console.log('[compute] нет ряда IWM — size-бенчмарк недоступен, excess только vs SPY');

// ---------- Вселенная ----------
// Реестр биржевых символов с датами (lib/symbols.mjs). Без него у делистнутого эмитента
// площадку проверить нечем, и OTC-бумаги проходят фильтр вселенной наравне с биржевыми.
const symRanges = loadSymbolRanges(DATA);
if (!symRanges) console.log('[compute] реестра символов нет — площадка мёртвых эмитентов и принадлежность тикера не проверяются');

let cntOtc = 0, cntBadTicker = 0, cntBadDate = 0, cntOtcByRegistry = 0;
const trades = [];
for (const r of tradesAll) {
  // Даты из форм не валидируются на стороне SEC: опечатка вроде «2026-06-31» доходит
  // до арифметики и роняет сборку. Отбрасываем такие строки, но считаем их в meta.
  if (!isIsoDate(r.tdate) || !isIsoDate(r.fdate)) { cntBadDate++; continue; }
  const cat = issuerCategory(r, ref, symRanges);
  if (cat === 'otc') {
    cntOtc++;
    if (!ref.get(r.cik)?.exchange) cntOtcByRegistry++;  // отсечено благодаря реестру, а не справочнику SEC
    continue;
  }
  const t = resolveTicker(r, ref);
  if (!plausibleTicker(t)) { cntBadTicker++; continue; }
  trades.push({ ...r, T: t, cat });
}
if (cntBadDate) console.log(`[compute] отброшено строк с некорректной датой: ${cntBadDate}`);
trades.sort((a, b) => a.fdate < b.fdate ? -1 : a.fdate > b.fdate ? 1 : 0);
const buys = trades.filter(r => r.code === 'P');
const byTicker = new Map();
for (const r of trades) (byTicker.get(r.T) ?? byTicker.set(r.T, []).get(r.T)).push(r);

// ---------- Доступ к ценам (с вытеснением) ----------
const priceMap = new Map();
function series(t) {
  if (!priceMap.has(t)) {
    if (priceMap.size >= SERIES_CACHE_MAX) priceMap.clear();
    priceMap.set(t, readPriceCache(DATA, t));
  }
  return priceMap.get(t);
}
function datesOf(s) {
  if (!s._dates) Object.defineProperty(s, '_dates', { value: s.map(r => r[0]), enumerable: false });
  return s._dates;
}
function idxAtOrBefore(s, iso) {
  const d = datesOf(s);
  let lo = 0, hi = d.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (d[m] <= iso) lo = m + 1; else hi = m; }
  return lo - 1;
}
// Вход по сигналу: закрытие первого торгового дня ПОСЛЕ подачи формы (point-in-time).
// Если подача раньше начала ценового ряда, входа нет: первый бар может быть спустя месяцы
// (переиспользованный тикер, поздний листинг) — такая «сделка» не воспроизводима.
const ENTRY_MAX_GAP_DAYS = 10;
function idxFirstAfter(s, iso) {
  const i = idxAtOrBefore(s, iso);
  const next = i + 1;
  if (next >= s.length) return -1;
  if (i < 0 && s[next][0] > addDaysIso(iso, ENTRY_MAX_GAP_DAYS)) return -1;
  return next;
}
// Просадка от 52-недельного максимума считается по колонке close — она скорректирована на
// сплиты, но НЕ на дивиденды. Прежняя версия брала adjclose, и это систематически завышало
// близость к максимуму у дивидендных бумаг: прошлые бары в adjclose занижены на накопленные
// выплаты, максимум получается ниже настоящего. Замерено на десяти дивидендных именах —
// медиана расхождения 1.4 п.п., 90-й процентиль 3.7 п.п., то есть при пороге «не ниже 5% от
// максимума» состав набора заметно смещался в сторону плательщиков дивидендов.
function drawdownAt(s, iso) {
  const i = idxAtOrBefore(s, iso);
  if (i < 30) return null;
  const from = addDaysIso(iso, -365);
  let hi = 0;
  for (let k = i; k >= 0 && s[k][0] >= from; k--) hi = Math.max(hi, s[k][1]);
  return hi > 0 && s[i][1] > 0 ? rnd(s[i][1] / hi - 1) : null;
}
// Прокси размера компании: медианный дневной $-оборот за 60 торговых дней до сделки.
// Капитализации в бесплатных источниках нет; оборот с ней коррелирует и заодно отражает
// торгуемость сигнала (Cziraki & Gider 2021: альфа концентрирована в неликвидных именах).
function dollarVolumeAt(s, iso) {
  const i = idxAtOrBefore(s, iso);
  if (i < 20) return null;
  const vals = [];
  for (let k = Math.max(0, i - 59); k <= i; k++) {
    const v = s[k][3];
    if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) continue;
    vals.push(s[k][1] * v);
  }
  if (vals.length < 15) return null;
  vals.sort((a, b) => a - b);
  return Math.round(vals[(vals.length - 1) >> 1]);
}
function sizeBucket(dv) {
  if (dv === null) return 'н/д';
  if (dv < 3e6) return 'micro';
  if (dv < 3e7) return 'small';
  if (dv < 3e8) return 'mid';
  return 'large';
}
const benchFor = b => ((b === 'micro' || b === 'small') && iwm?.length ? iwm : spy);

// Делистинг или просто устаревший кэш? Раньше признаком было «последний бар старше двух
// недель», и этого хватало, чтобы принять за делистинг любой не обновлённый ряд: в режиме
// daily обновляются только тикеры с покупками за 25 месяцев, у остальных ряд обрывается
// там, где его последний раз качали. Такие «мёртвые» позиции движок закрывал по старой
// цене, превращая незрелое окно в закрытый результат. Измерено: 97 рядов из 454 оборванных
// на деле живы по реестру символов.
// Теперь делистинг требует подтверждения реестром: символ должен и в нём кончиться.
const stalePrices = new Set();
function isDelisted(t, s) {
  if (s[s.length - 1][0] >= addDaysIso(today, -STALE_PRICE_DAYS)) return false;
  const through = listedThrough(symRanges, t);
  if (through === null) return true;                 // реестр не знает символа — верим ряду
  if (through >= addDaysIso(today, -STALE_PRICE_DAYS)) { stalePrices.add(t); return false; }
  return true;
}

// ---------- Фаза A: всё, что требует цен (по тикерам, с вытеснением) ----------
function forward(row, s) {
  const out = {};
  const e = idxFirstAfter(s, row.fdate);
  if (e < 0) {
    for (const m of Object.keys(HORIZONS)) out['s' + m] = 'o';
    // Два разных случая под одним 'o'. Если бара до подачи нет вовсе, ряд начинается
    // ПОЗЖЕ сигнала: вход невозможен в принципе, окно никогда не дозреет. Раньше такие
    // строки молча растворялись среди «ещё не дозревших» — теперь их видно в meta.
    if (idxAtOrBefore(s, row.fdate) < 0) { out.noEntry = 1; quality.noEntry++; }
    return out;
  }
  const bench = benchFor(row._bucket);
  const dead = isDelisted(row.T, s);
  const entryAdj = s[e][2];
  const bE = idxAtOrBefore(bench, s[e][0]);
  const spyE = idxAtOrBefore(spy, s[e][0]);
  out.entry = s[e][0];
  for (const [m, days] of Object.entries(HORIZONS)) {
    const x = e + days;
    let exitIdx, status = 'c';
    if (x < s.length) exitIdx = x;
    // Делистинг: закрываем последней ценой, но только если она позже входа —
    // иначе получился бы фиктивный «закрытый» результат с нулевой доходностью
    else if (dead && s.length - 1 > e) { exitIdx = s.length - 1; status = 'd'; }
    else { out['s' + m] = 'o'; continue; }                     // окно ещё не дозрело
    const ret = s[exitIdx][2] / entryAdj - 1;
    const bX = idxAtOrBefore(bench, s[exitIdx][0]);
    const spyX = idxAtOrBefore(spy, s[exitIdx][0]);
    out['r' + m] = rnd(ret);
    out['e' + m] = rnd(ret - (bE >= 0 && bX > bE ? bench[bX][2] / bench[bE][2] - 1 : 0));
    out['x' + m] = rnd(ret - (spyE >= 0 && spyX > spyE ? spy[spyX][2] / spy[spyE][2] - 1 : 0));
    out['s' + m] = status;
    if (m === '6') out.mat6 = s[exitIdx][0];  // дата дозревания — для point-in-time трек-рекорда
  }
  // Короткие колонки ленты: только реально дозревшие окна. Для мёртвых тикеров хвост
  // не растягиваем — иначе 1д/1н/1м/6м показывали бы одно и то же число.
  for (const [k, days] of Object.entries(PERF_COLS)) {
    const x = e + days;
    if (x < s.length) out[k] = rnd(s[x][2] / entryAdj - 1);
  }
  return out;
}

const allSplits = readJson(join(DATA, 'prices', '_splits.json'), {});
const noPriceTickers = new Set(), pricedTickers = new Set();
const unitsMismatch = new Set();
// Счётчики честности ценового слоя (уходят в meta.json и на экран Статистики).
const quality = { reassigned: 0, reassignedTickers: new Set(), noEntry: 0, unknownSymbol: 0 };
// Месячная панель для календарно-временного портфеля (lib/portfolio.mjs). Собирается
// попутно, в том же проходе по ценам: второй проход стоил бы ещё одного чтения всего кэша.
const panel = new Panel();
panel.add('SPY', monthlyFromDaily(spy), true);
if (iwm?.length) panel.add('IWM', monthlyFromDaily(iwm), true);
for (const [t, rows] of byTicker) {
  const s = series(t);
  const n = s?.length ?? 0;
  // Различаем «ряда нет вовсе» и «ряд короткий». Раньше короткий ряд (только что
  // разместившаяся бумага) считался отсутствием цен — и гейт старта торгов не срабатывал,
  // потому что ему передавался null вместо реальной длины истории. Именно так участие
  // в IPO попадало в сигнал.
  const has = n > 0;
  if (has) panel.add(t, monthlyFromDaily(s));
  if (n > 100) pricedTickers.add(t); else noPriceTickers.add(t);
  const cur = has ? s[s.length - 1][1] : null;
  const lastAdj = has ? s[s.length - 1][2] : null;
  const sp = allSplits[t];
  for (const r of rows) {
    // Тикер в США переиспользуется, а котировки мы скачиваем сегодняшние. Если дата сделки
    // не попадает в тот же интервал реестра, что и нынешний владелец символа, ряд относится
    // к ДРУГОЙ компании: пользоваться им нельзя ни для входа, ни для ценовых гейтов.
    // Так, к покупкам Legacy Reserves (2017–2019) подставлялся ряд бумаги, занявшей LGCY в 2024-м.
    //
    // Проверка применима ТОЛЬКО когда тикер взят из старой формы, то есть эмитента нет в
    // справочнике SEC. Если справочник знает CIK, он же и даёт нынешний тикер — тогда ряд
    // принадлежит этому эмитенту по определению, а Yahoo отдаёт историю и под прежним именем.
    // Без этого ограничения переименования (TICC->OXSQ) выглядели бы подменой: ложно
    // помечались 345 живых эмитентов и 3917 покупок.
    const stale = !ref.get(r.cik)?.ticker;
    const same = has && stale ? sameInstrumentAsLatest(symRanges, t, r.tdate) : null;
    if (same === null && has && stale) quality.unknownSymbol++;
    if (same === false) {
      r._reassigned = 1;
      quality.reassigned++; quality.reassignedTickers.add(t);
    }
    // Без ценового ряда три ценовых гейта не могут отработать — помечаем это явно,
    // чтобы «прошла фильтры» не означало «проверена» там, где проверить было нечем
    if (!has || same === false) { r._dv = null; r._bucket = 'н/д'; r._dd = null; r._fw = null; r._close = null; r._histDays = null; r._noPrice = 1; continue; }
    const i = idxAtOrBefore(s, r.tdate);
    // Цена, которую инсайдер видел в момент сделки: котировка «раскручена» назад через сплиты
    r._split = nominalFactor(sp, r.tdate);
    r._close = i >= 0 ? rnd(s[i][1] * r._split, 4) : null;
    r._histDays = i + 1;   // сколько торговых дней бумага обращалась до сделки
    r._dd = drawdownAt(s, r.tdate);
    r._cur = cur;
    if (r.code !== 'P') continue;
    r._dv = dollarVolumeAt(s, r.tdate);
    r._bucket = sizeBucket(r._dv);
    r._fw = forward(r, s);
    const e = idxFirstAfter(s, r.fdate);
    // Две разные величины, и путать их нельзя:
    //  _chg  — от момента, когда сигнал стал публичным (вход по подаче). Это то, что мог бы
    //          получить подписчик, и только это корректно для бэктеста.
    //  _chgT — от даты самой сделки: результат ИНСАЙДЕРА. При просроченной подаче
    //          (медиана лага 1 день, но у 3% сделок он больше 60 дней) числа расходятся сильно.
    r._chg = e >= 0 ? rnd(lastAdj / s[e][2] - 1) : null;
    r._chgT = i >= 0 ? rnd(lastAdj / s[i][2] - 1) : null;
  }
  // Остаточное расхождение единиц по всему эмитенту (ADR-коэффициент, отчётность в другой
  // валюте): у настоящего размещения отклоняются отдельные сделки, а здесь — все и одинаково.
  // Порог по числу сделок высокий: у эмитента с несколькими PIPE подряд медиана тоже
  // «съезжает», а решение здесь принимается сразу по всему эмитенту.
  const ratios = rows.filter(r => r.code === 'P' && r.px > 0 && r._close > 0).map(r => r.px / r._close).sort((a, b) => a - b);
  if (ratios.length >= 5) {
    const q = p => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))];
    const med = q(0.5);
    if (Math.abs(med - 1) > 0.15 && (q(0.75) - q(0.25)) / med < 0.1) unitsMismatch.add(t);
  }
}

// ---------- Фаза B: контекст и гейты (без цен) ----------
const ownerGroups = buildOwnerGroups(trades);
const history = buildOwnerHistory(trades);
const primaryOwner = r => (r.owners ?? []).find(isPersonOwner) ?? r.owners?.[0] ?? null;

// Синхронные подачи: одна дата, один эмитент, ТОЧНО одна цена у нескольких независимых
// филеров — подпись закрытия размещения (фонд+GP+партнёр склеены в одну группу).
// Ценовой допуск здесь недопустим: несколько инсайдеров, покупающих в один день на открытом
// рынке, естественно попадают в интервал в доли процента — их кластер вырезать нельзя.
const syncCount = new Map();
for (const r of buys) {
  if (!r.px) continue;
  r._syncKey = `${r.cik}|${r.tdate}|${r.px}`;
  const set = syncCount.get(r._syncKey) ?? new Set();
  for (const o of r.owners ?? []) set.add(ownerGroups.get(o.cik) ?? o.cik);
  syncCount.set(r._syncKey, set);
}

for (const r of buys) {
  const po = primaryOwner(r);
  const hist = po ? (history.get(po.cik) ?? []) : [];
  r._routine = isRoutineCMP(hist, r.tdate);
  r._gate = applyGates(r, {
    close: r._close,
    reassigned: !!r._reassigned,
    histDays: r._histDays ?? null,
    noPrice: !!r._noPrice,
    // Ряд котировок есть, а оборота нет — остаточный признак размещения (см. gates.mjs)
    noLiquidity: !r._noPrice && r._bucket === 'н/д' && r._histDays !== null,
    dollarVolume: r._dv ?? 0,
    syncFilers: (syncCount.get(r._syncKey)?.size) ?? 1,
    planned: isPlanned(r),
    routine: r._routine,
    regular: isRegularSeries(hist, r.tdate, r.cik, 'P'),
    fundOnly: isFundOnly(r),
    unitsMismatch: unitsMismatch.has(r.T),
  });
}

// ---------- Признаки строки и рабочий набор ----------
// Роль, прирост позиции и инфлексия — это описание сделки, а не оценка: они показываются
// в ленте и участвуют в срезах Статистики, но ни во что не агрегируются. Скор убран.
for (const r of buys) {
  const po = primaryOwner(r);
  const hist = po ? (history.get(po.cik) ?? []) : [];
  r._role = topRole((r.owners ?? []).filter(isPersonOwner).map(o => o.rel));
  r._dOwn = dOwnOf(r);
  r._inflect = r._gate.ok ? inflection(hist, r.tdate) : null;
  // Принадлежность к рабочему набору. Все три условия известны на дату сделки, поэтому
  // «живой» и исторический признак совпадают — отдельной point-in-time версии не нужно.
  r._set = r._gate.ok && r._dd !== null && r._dd >= SET_MAX_DD
    && r.val >= SET_MIN_VAL && (r._dv ?? 0) >= SET_MIN_DV ? 1 : 0;
}

// ---------- Payload ----------
const dataOut = join(SITE, 'data');
mkdirSync(dataOut, { recursive: true });
const W = (p, obj) => writeJson(join(dataOut, p), obj);
const busDays = (a, b) => {
  let n = 0;
  for (let d = a; d < b; d = addDaysIso(d, 1)) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
};
const daysAgo = iso => Math.round((Date.parse(today) - Date.parse(iso)) / 86400000);

// Лента: показываем ВСЕ покупки, включая отсеянные, но с причиной отсева —
// пользователь видит и сигнал, и то, что именно было отфильтровано и почему.
const feedCut = addDaysIso(today, -FEED_DAYS);
const feedRows = buys.filter(r => r.fdate >= feedCut).map(r => ({
  t: r.T, name: ref.get(r.cik)?.name ?? r.t, fdate: r.fdate, tdate: r.tdate, form: r.form,
  who: (r.owners ?? []).map(o => o.name).join('; '),
  role: r._role, title: r.owners?.[0]?.title || '',
  sh: r.sh, px: r.px, val: r.val, own: r.own, dOwn: r._dOwn, di: r.di,
  delay: busDays(r.tdate, r.fdate),
  dd: r._dd, dv: r._dv ?? null, bucket: r._bucket,
  // Рабочий набор и его срок: подписчику нужны обе даты — когда покупать и когда выходить
  set: r._set, age: daysAgo(r.fdate),
  exit: r._fw?.entry ? addDaysIso(r._fw.entry, SET_HOLD_MONTHS * 30) : null,
  drop: r._gate.drop, tags: r._gate.tags,
  inflect: r._inflect ?? null,
  b5: isPlanned(r) ? 1 : 0, routine: r._routine,
  cur: r._cur ?? null, chg: r._chg ?? null, chgT: r._chgT ?? null,
  w1: r._fw?.w1 ?? null, m1: r._fw?.m1 ?? null, m6: r._fw?.m6 ?? null,
}));
// Сортировка: сначала свежие, внутри дня — крупные по сумме. Прежняя сортировка по скору
// исчезла вместе со скором, а «свежесть» и есть главное: сигнал живёт около месяца.
feedRows.sort((a, b) => (a.fdate < b.fdate ? 1 : a.fdate > b.fdate ? -1 : b.val - a.val));
W('feed.json', feedRows);

// Бэктест: ВСЕ покупки с ценами, включая отсеянные (с причиной) — экран «Статистика»
// проверяет на собственных данных, что гейты режут именно шум, а не сигнал.
// В бэктест идут ТОЛЬКО point-in-time версии кластера и скора (см. фазу C)
const backtestRows = buys.filter(r => r._fw).map(r => ({
  t: r.T, fdate: r.fdate, tdate: r.tdate, val: r.val, role: r._role,
  b5: isPlanned(r) ? 1 : 0, routine: r._routine, dd: r._dd, dOwn: r._dOwn,
  bucket: r._bucket, set: r._set,
  gate: r._gate.ok ? 'ok' : r._gate.drop,
  inflect: r._inflect ?? null,
  ...r._fw,
}));
const years = [...new Set(backtestRows.map(r => r.fdate.slice(0, 4)))].sort();
mkdirSync(join(dataOut, 'backtest'), { recursive: true });
for (const y of years) W(join('backtest', y + '.json'), backtestRows.filter(r => r.fdate.slice(0, 4) === y));
W('backtest/index.json', { years });

// Агрегаты
const bucketSizeLabel = v => v >= 1e6 ? '≥$1M' : v >= 2.5e5 ? '$250k–1M' : v >= 5e4 ? '$50–250k' : '<$50k';
const bucketDdLabel = d => d === null ? 'н/д' : d <= -0.30 ? 'просадка >30%' : d <= -0.15 ? 'просадка 15–30%' : d >= -0.05 ? 'у максимума' : 'просадка <15%';
// Срезы Статистики — это диагностика, а не меню наборов. Каждый отвечает на вопрос
// «что здесь на самом деле есть», и по каждому уже известен ответ (docs/ЧТО-РАБОТАЕТ.md).
// Срез «кластер» убран вместе с кластерами, срез «скор» — вместе со скором.
const DIMS = {
  set: r => r.set ? '✓ рабочий набор' : 'вне набора',
  gate: r => r.gate === 'ok' ? '✓ прошли гейты' : (DROP_LABELS[r.gate] ?? r.gate),
  all: () => 'прошедшие гейты',
  role: r => r.role,
  size: r => bucketSizeLabel(r.val),
  liquidity: r => r.bucket,
  routine: r => r.routine === true ? 'рутинная (CMP)' : r.routine === false ? 'оппортунистическая' : 'нет истории',
  inflect: r => r.inflect ?? 'обычная',
  dd: r => bucketDdLabel(r.dd),
  year: r => r.fdate.slice(0, 4),
};
// Срезы, кроме 'gate' и 'routine', считаются только по прошедшим гейты:
// иначе PIPE-размещения и плановые сделки размывают картину сигнала.
const ALL_ROWS_DIMS = new Set(['gate', 'routine']);
// ---------- Календарно-временной портфель: ЕДИНСТВЕННАЯ метрика Статистики ----------
// Обоснование замены и цифры шумового пола — в шапке lib/portfolio.mjs.
const PORT_MIN_DV = 3e6;      // ниже этого оборота портфель неторгуем, а сравнение бессмысленно
const PORT_HOLD = [3, 6, 12]; // месяцев удержания
const PORT_SPLIT = '2021-01'; // граница половин: расхождение оценки видно прямо на экране
const PORT_MIN_MONTHS = 36;   // меньше трёх лет — не оценка, а пересказ пары кварталов
const PORT_THIN = 10;         // средний состав ниже этого: ячейка помечается как тонкая
const retMap = t => {
  const m = new Map();
  for (const mm of panel.months) { const r = panel.ret(t, mm); if (r !== null) m.set(mm, r); }
  return m;
};
const spyRet = retMap('SPY');
const univRet = universeSeries(panel, { minDv: PORT_MIN_DV });
// Факторы размера и моментума строятся из той же вселенной. Моментум добавлен в августе
// 2026: без него набор «у 52-недельного максимума» показывал завышенную альфу — он по
// построению сидит в победителях моментума. С фактором альфа набора сохраняется, у широких
// инсайдерских срезов исчезает, и это ровно то, что метрика обязана различать.
const FACTORS = factorSeries(panel, { minDv: PORT_MIN_DV });
const FMODEL = { market: spyRet, size: FACTORS.size, mom: FACTORS.mom };

function portfolioCell(rows, H) {
  const byM = new Map();
  for (const r of rows) {
    const m = r.fdate.slice(0, 7);
    (byM.get(m) ?? byM.set(m, new Set()).get(m)).add(r.t);
  }
  const ser = portfolioSeries(panel, byM, { H, minDv: PORT_MIN_DV });
  // Три года — минимум, на котором альфа вообще имеет смысл; ниже это пересказ пары
  // удачных кварталов. Ячейки с малым составом не прячем, а помечаем: пусть видно, что
  // «+46.8 на train и −46.7 на valid» получены на семи бумагах.
  if (ser.length < PORT_MIN_MONTHS) return null;
  const a = factorAlpha(ser, FMODEL);
  const p = pathStats(ser);
  // ГЛАВНАЯ колонка экрана — превышение над S&P 500. Равновзвешенная вселенная ADV≥$3М
  // сама проигрывает индексу около 3%/год, поэтому «альфа к вселенной» и «альфа к индексу» —
  // это два РАЗНЫХ ответа, и путать их нельзя: сигналу нужно набрать 3–5% сверх вселенной
  // просто чтобы сравняться с SPY.
  const v = vsBenchmark(ser, spyRet);
  const ex = ser.filter(x => univRet.has(x.m)).map(x => x.r - univRet.get(x.m));
  const u = neweyWestT(ex);
  const half = w => {
    const s = ser.filter(w);
    const h = s.length >= 24 ? vsBenchmark(s, spyRet) : null;
    return h ? rnd(annualize(h.ex)) : null;
  };
  return {
    n: p.avgN, mo: ser.length, thin: p.avgN < PORT_THIN ? 1 : 0,
    cagr: rnd(p.cagr), vol: rnd(p.vol), dd: rnd(p.dd),
    spy: v ? rnd(annualize(v.ex)) : null,
    spyT: v?.t !== null && v?.t !== undefined ? rnd(v.t, 2) : null,
    ir: v?.ir !== null && v?.ir !== undefined ? rnd(v.ir, 2) : null,
    sharpe: v?.sharpe !== null && v?.sharpe !== undefined ? rnd(v.sharpe, 2) : null,
    a: a ? rnd(annualize(a.alpha)) : null,
    t: a?.t !== null && a?.t !== undefined ? rnd(a.t, 2) : null,
    beta: a ? rnd(a.betas[0], 2) : null, size: a ? rnd(a.betas[1], 2) : null, mom: a ? rnd(a.betas[2], 2) : null,
    aT: half(x => x.m < PORT_SPLIT), aV: half(x => x.m >= PORT_SPLIT),
    u: u.mean !== null ? rnd(annualize(u.mean)) : null,
    ut: u.t !== null && u.t !== undefined ? rnd(u.t, 2) : null,
  };
}
function portfolioAggregate(rows) {
  const out = {};
  for (const [dim, fn] of Object.entries(DIMS)) {
    const src = ALL_ROWS_DIMS.has(dim) ? rows : rows.filter(r => r.gate === 'ok');
    const groups = new Map();
    for (const r of src) (groups.get(fn(r)) ?? groups.set(fn(r), []).get(fn(r))).push(r);
    out[dim] = {};
    for (const [g, rs] of [...groups.entries()].sort()) {
      const cell = {};
      for (const H of PORT_HOLD) cell['h' + H] = portfolioCell(rs, H);
      if (cell.h12 || cell.h6 || cell.h3) out[dim][g] = cell;
    }
  }
  return out;
}

// ---------- РАБОЧИЙ НАБОР и ЧЁРНЫЙ СПИСОК ----------
// Один торговый набор вместо прежних четырёх: остальные проверку не прошли. Всё, что
// считается здесь, страница только показывает — числа в разметке не хранятся.
//
// Колонка «сверх контроля» обязательна для ценового набора: контроль — ВСЕ бумаги,
// побывавшие в том же ценовом контексте в том же месяце, собранные тем же способом и на
// тот же срок. Без него набор описывал бы моментум, а не инсайдера.
const ROUND_TRIP = 0.005;    // издержки на круг, доля
const liquidRow = r => r.bucket !== 'н/д' && r.bucket !== 'micro';
const SET_DEF = {
  key: 'set', name: 'Рабочий набор', H: SET_HOLD_MONTHS,
  f: r => r.set === 1,
  control: { name: 'все бумаги, побывавшие у максимума', pred: (t, m) => panel.wasNearHigh(t, m, SET_MAX_DD) },
  // Две лестницы — по близости к максимуму и по сумме сделки. Обе нужны как доказательство,
  // что пороги не подогнаны: эффект меняется плавно, а не скачком на выбранной отсечке.
  ladders: [
    {
      name: 'близость к 52-нед максимуму', vals: [-0.01, -0.02, -0.05, -0.10, -0.20, -0.35],
      lab: v => 'не ниже ' + Math.abs(Math.round(v * 100)) + '%',
      f: v => r => r.gate === 'ok' && r.dd !== null && r.dd >= v && r.val >= SET_MIN_VAL && liquidRow(r),
    },
    {
      name: 'сумма сделки', vals: [0, 1e4, 5e4, 1e5, 2.5e5, 5e5],
      lab: v => v ? 'от $' + Math.round(v / 1e3) + 'k' : 'любая',
      f: v => r => r.gate === 'ok' && r.dd !== null && r.dd >= SET_MAX_DD && r.val >= v && liquidRow(r),
    },
  ],
};
// Чёрный список: срезы, которые системно ХУЖЕ индекса. Показываются рядом с набором, потому
// что «чего не покупать» — такая же часть результата, как «что покупать».
const AVOID_DEFS = [
  { key: 'routine', name: 'рутинные по календарю (CMP)', H: 12, f: r => r.gate === 'routine' },
  { key: 'planned', name: 'плановые 10b5-1', H: 12, f: r => r.gate === 'planned' },
  { key: 'deep', name: 'покупки в просадке глубже 30%', H: 3, f: r => r.gate === 'ok' && r.dd !== null && r.dd < -0.3 },
  { key: 'roleX', name: 'роль «иное» (X)', H: 12, f: r => r.gate === 'ok' && r.role === 'X' },
  { key: 'roleO', name: 'офицер не CEO/CFO', H: 12, f: r => r.gate === 'ok' && r.role === 'O' },
  { key: 'dropped', name: 'всё, что отсеяли гейты', H: 12, f: r => r.gate !== 'ok' },
];
const signalMonths = f => {
  const byM = new Map();
  for (const r of backtestRows) {
    if (!f(r)) continue;
    const m = r.fdate.slice(0, 7);
    (byM.get(m) ?? byM.set(m, new Set()).get(m)).add(r.t);
  }
  return byM;
};
function setCell(def, { withExtras = false } = {}) {
  const byM = signalMonths(def.f);
  const ser = portfolioSeries(panel, byM, { H: def.H, minDv: PORT_MIN_DV });
  if (ser.length < PORT_MIN_MONTHS) return null;
  const a = factorAlpha(ser, FMODEL);
  const v = vsBenchmark(ser, spyRet);
  const p = pathStats(ser);
  const half = w => {
    const s = ser.filter(w);
    const h = s.length >= 24 ? vsBenchmark(s, spyRet) : null;
    return h ? rnd(annualize(h.ex)) : null;
  };
  const to = turnover(panel, byM, { H: def.H, minDv: PORT_MIN_DV });
  const cost = to === null ? null : (to / 2) * 12 * ROUND_TRIP;   // один круг на смену бумаги
  const cell = {
    key: def.key, name: def.name, hold: def.H, n: p.avgN, mo: ser.length,
    signals: backtestRows.filter(def.f).length,
    cagr: rnd(p.cagr), vol: rnd(p.vol), dd: rnd(p.dd),
    spy: v ? rnd(annualize(v.ex)) : null,
    spyT: v?.t !== null && v?.t !== undefined ? rnd(v.t, 2) : null,
    ir: v?.ir !== null && v?.ir !== undefined ? rnd(v.ir, 2) : null,
    sharpe: v?.sharpe !== null && v?.sharpe !== undefined ? rnd(v.sharpe, 2) : null,
    a: a ? rnd(annualize(a.alpha)) : null,
    t: a?.t !== null && a?.t !== undefined ? rnd(a.t, 2) : null,
    beta: a ? rnd(a.betas[0], 2) : null, mom: a ? rnd(a.betas[2], 2) : null,
    aT: half(x => x.m < PORT_SPLIT), aV: half(x => x.m >= PORT_SPLIT),
    turnover: to === null ? null : rnd(to * 12),
    cost: cost === null ? null : rnd(cost),
    net: v && cost !== null ? rnd(annualize(v.ex) - cost) : null,
  };
  if (!withExtras) return cell;
  if (def.control) {
    const ctrl = universeSeries(panel, { minDv: PORT_MIN_DV, pred: def.control.pred, H: def.H });
    const d = pairedDiff(ser, ctrl);
    if (d) cell.control = { name: def.control.name, ex: rnd(annualize(d.ex)), t: rnd(d.t, 2), mo: d.months };
  }
  // Год за годом против индекса: концентрация видна сразу, без пересказа
  const byY = new Map();
  for (const x of ser) {
    if (!spyRet.has(x.m)) continue;
    const y = x.m.slice(0, 4);
    (byY.get(y) ?? byY.set(y, []).get(y)).push(x.r - spyRet.get(x.m));
  }
  cell.years = [...byY.entries()].sort().map(([y, vs]) => ({ y, ex: rnd(vs.reduce((q, w) => q + w, 0)) }));
  if (def.ladders) {
    cell.ladders = def.ladders.map(L => ({
      name: L.name,
      rows: L.vals.map(val => {
        const sr = portfolioSeries(panel, signalMonths(L.f(val)), { H: def.H, minDv: PORT_MIN_DV });
        if (sr.length < PORT_MIN_MONTHS) return null;
        const vv = vsBenchmark(sr, spyRet);
        return { lab: L.lab(val), n: pathStats(sr).avgN, spy: vv ? rnd(annualize(vv.ex)) : null, t: vv ? rnd(vv.t, 2) : null };
      }).filter(Boolean),
    }));
  }
  // Задержка входа: сигнал живёт около месяца, и это надо показывать, а не описывать словами
  cell.lag = [0, 1, 2].map(lag => {
    const shifted = new Map();
    const ms = panel.months;
    for (const [m, set] of byM) {
      const i = panel.idx(m);
      if (i === undefined || !ms[i + lag]) continue;
      const k = ms[i + lag];
      shifted.set(k, new Set([...(shifted.get(k) ?? []), ...set]));
    }
    const sr = portfolioSeries(panel, shifted, { H: def.H, minDv: PORT_MIN_DV });
    if (sr.length < PORT_MIN_MONTHS) return null;
    const vv = vsBenchmark(sr, spyRet);
    return { lag, spy: vv ? rnd(annualize(vv.ex)) : null, t: vv ? rnd(vv.t, 2) : null };
  }).filter(Boolean);
  return cell;
}
const workingSet = setCell(SET_DEF, { withExtras: true });
const avoid = AVOID_DEFS.map(d => setCell(d)).filter(Boolean);
const reference = [setCell({ key: 'all', name: 'все покупки, прошедшие гейты', H: 12, f: r => r.gate === 'ok' })].filter(Boolean);
// Вселенная и индекс — эталоны, с которыми сравнивается всё остальное. Главное число
// панели: равновзвешенная вселенная ADV≥$3М сама проигрывает S&P 500, поэтому «лучше
// вселенной» и «лучше индекса» — разные утверждения.
{
  const all = new Map();
  for (const m of panel.months) {
    const set = new Set();
    for (const t of panel.names()) if ((panel.adv(t, m) ?? 0) >= PORT_MIN_DV) set.add(t);
    if (set.size) all.set(m, set);
  }
  const ser = portfolioSeries(panel, all, { H: 1, minDv: PORT_MIN_DV });
  const v = vsBenchmark(ser, spyRet), p = pathStats(ser), a = factorAlpha(ser, FMODEL);
  reference.push({
    key: 'universe', name: 'вся вселенная ADV≥$3М (равный вес)', hold: 1, n: p.avgN, mo: ser.length,
    cagr: rnd(p.cagr), vol: rnd(p.vol), dd: rnd(p.dd),
    spy: v ? rnd(annualize(v.ex)) : null, spyT: v ? rnd(v.t, 2) : null,
    ir: v?.ir ? rnd(v.ir, 2) : null, sharpe: v?.sharpe ? rnd(v.sharpe, 2) : null,
    a: a ? rnd(annualize(a.alpha)) : null, t: a ? rnd(a.t, 2) : null,
    beta: a ? rnd(a.betas[0], 2) : null, mom: a ? rnd(a.betas[2], 2) : null,
  });
  const spySer = [...spyRet.entries()].map(([m, r]) => ({ m, r, n: 1 }));
  const sp = pathStats(spySer);
  const sharpe = sp.vol > 0
    ? (spySer.reduce((q, x) => q + x.r - rfOf(x.m), 0) / spySer.length * 12) / sp.vol : null;
  reference.push({
    key: 'spy', name: 'S&P 500 (SPY)', hold: null, n: 1, mo: spySer.length,
    cagr: rnd(sp.cagr), vol: rnd(sp.vol), dd: rnd(sp.dd),
    spy: 0, spyT: null, ir: null, sharpe: sharpe === null ? null : rnd(sharpe, 2),
    a: 0, t: null, beta: 1, mom: 0,
  });
}

const portAgg = portfolioAggregate(backtestRows);
W('stats.json', {
  built: today,
  // Рабочий набор со всеми доказательствами: лестницы порогов, контроль, год за годом,
  // затухание при задержке входа. Страница показывает, но не считает.
  set: workingSet, avoid, reference, roundTrip: ROUND_TRIP,
  setDef: { maxDd: SET_MAX_DD, minVal: SET_MIN_VAL, minDv: SET_MIN_DV, hold: SET_HOLD_MONTHS, freshDays: SET_FRESH_DAYS },
  // Диагностические срезы: что на самом деле лежит в каждой группе сделок
  portfolio: portAgg,
  method: { minDv: PORT_MIN_DV, hold: PORT_HOLD, split: PORT_SPLIT, minNames: 5, minMonths: PORT_MIN_MONTHS, thin: PORT_THIN },
  n: backtestRows.length,
  nOk: backtestRows.filter(r => r.gate === 'ok').length,
  nSet: backtestRows.filter(r => r.set === 1).length,
});

// Карточки тикеров (второй проход по ценам — ряды уже вытеснены из кэша)
mkdirSync(join(dataOut, 'tickers'), { recursive: true });
function isoWeek(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const y = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(y, 0, 4));
  return `${y}-${1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)}`;
}
let tickerFiles = 0;
for (const [t, rows] of byTicker) {
  const buysHere = rows.filter(r => r.code === 'P');
  if (!buysHere.length) continue;
  const s = series(t);
  let weekly = [], daily = [];
  if (s?.length) {
    let lastWeek = '';
    for (const row of s) {
      if (row[0] < '2015-07-01') continue;
      const wk = isoWeek(row[0]);
      if (wk === lastWeek) weekly[weekly.length - 1] = [row[0], row[1]];
      else { weekly.push([row[0], row[1]]); lastWeek = wk; }
    }
    const dcut = addDaysIso(today, -380);
    daily = s.filter(r => r[0] >= dcut).map(r => [r[0], r[1]]);
  }
  const cik0 = rows[0].cik;
  const sells = rows.filter(r => r.code === 'S');
  W(join('tickers', t.replace(/[^A-Za-z0-9.-]/g, '_') + '.json'), {
    t, name: ref.get(cik0)?.name ?? rows[0].t, exchange: ref.get(cik0)?.exchange ?? null,
    cat: rows[0].cat, asOf: s?.length ? s[s.length - 1][0] : null,
    bucket: buysHere[buysHere.length - 1]._bucket ?? null,
    // Доля продаж НЕ показывается: проверено — продажи инсайдеров не несут информации
    // (портфель проданных бумаг даёт +0.1% к сопоставимым, t=0.19). Держим только счётчики.
    nSells: sells.length,
    okBuys: buysHere.filter(r => r._gate.ok).length,
    setBuys: buysHere.filter(r => r._set === 1).length,
    trades: rows.map(r => ({
      fdate: r.fdate, tdate: r.tdate, form: r.form, code: r.code,
      who: (r.owners ?? []).map(o => o.name).join('; '),
      role: r._role ?? topRole((r.owners ?? []).map(o => o.rel)), title: r.owners?.[0]?.title || '',
      sh: r.sh, px: r.px, val: r.val, own: r.own, dOwn: dOwnOf(r), di: r.di, sec: r.sec || '',
      // Цена сделки в той же системе координат, что и график: номинал / сплит-фактор
      pxAdj: r.px && r._split ? rnd(r.px / r._split, 4) : r.px,
      b5: isPlanned(r) ? 1 : 0,
      drop: r.code === 'P' ? (r._gate?.drop ?? null) : null,
      set: r.code === 'P' ? (r._set ?? 0) : null,
    })).sort((a, b) => a.tdate < b.tdate ? 1 : -1),
    weekly, daily,
  });
  tickerFiles++;
}
W('tickers-index.json', [...byTicker.entries()]
  .filter(([, rows]) => rows.some(r => r.code === 'P'))
  .map(([t, rows]) => ({ t, name: ref.get(rows[0].cik)?.name ?? rows[0].t }))
  .sort((a, b) => a.t < b.t ? -1 : 1));

// Выживаемость: доля покупок, по которым ценового ряда нет вовсе, ПО ГОДАМ. Это главный
// невидимый источник смещения — ряды исчезают не случайно, а вместе с компаниями, которых
// больше нет, и чем старше год, тем их больше. Одно суммарное число («без цен N тикеров»)
// эту зависимость прячет, поэтому в мете лежит разбивка.
const survival = {};
for (const r of buys) {
  const y = r.fdate.slice(0, 4);
  const e = survival[y] ?? (survival[y] = { buys: 0, noPrice: 0 });
  e.buys++;
  if (!r._fw) e.noPrice++;
}
for (const e of Object.values(survival)) e.share = rnd(e.noPrice / Math.max(1, e.buys), 3);

// Мета: честная статистика конвейера
const dropCounts = {};
for (const r of buys) if (r._gate.drop) dropCounts[r._gate.drop] = (dropCounts[r._gate.drop] ?? 0) + 1;
const okN = buys.filter(r => r._gate.ok).length;
const backfillState = readJson(join(DATA, 'state', 'backfill.json'), {});
const liveState = readJson(join(DATA, 'state', 'live.json'), {});
const priceState = readJson(join(DATA, 'prices', '_state.json'), {});
const priceQuality = readJson(join(DATA, 'prices', '_quality.json'), {});
W('meta.json', {
  built: new Date().toISOString(), v: 2,
  trades: { total: trades.length, buys: buys.length, otcExcluded: cntOtc, otcByRegistry: cntOtcByRegistry, badTicker: cntBadTicker, badDate: cntBadDate },
  load: loadStats,
  gates: { ok: okN, drops: dropCounts, labels: DROP_LABELS },
  universe: { priced: pricedTickers.size, noPrices: noPriceTickers.size },
  // Честность ценового слоя: что именно испорчено и в каком объёме. Без этих чисел
  // «прошло гейты N сделок» ничего не говорит о том, на каких данных они проверены.
  quality: {
    symbolsInRegistry: Object.keys(symRanges ?? {}).length,
    reassigned: quality.reassigned,
    reassignedTickers: quality.reassignedTickers.size,
    unknownSymbol: quality.unknownSymbol,
    noEntry: quality.noEntry,
    dirtySeriesOnRead: readStats.dirtySeries,
    droppedBarsOnRead: readStats.droppedBars,
    frozenSeries: readStats.frozenSeries,
    frozenBars: readStats.frozenBars,
    rejectedForeign: Object.keys(priceQuality.rejectedMeta ?? {}).length,
    // Ремонт ряда по внешним источникам истины (lib/prices.mjs)
    splitFixed: readStats.splitFixed,
    clippedSeries: readStats.clippedSeries, clippedBars: readStats.clippedBars,
    brokenSeries: readStats.brokenSeries, brokenBars: readStats.brokenBars,
    stalePrices: stalePrices.size,
  },
  survival,
  backtest: { rows: backtestRows.length, years },
  feed: { rows: feedRows.length, days: FEED_DAYS },
  set: { rows: backtestRows.filter(r => r.set === 1).length, live: feedRows.filter(r => r.set === 1).length },
  quartersDone: backfillState.done ?? [], liveLastDay: liveState.lastDay ?? null,
  pricesUpdated: priceState.updated ?? null, pricesMissing: Object.keys(priceState.missing ?? {}).length,
  spyLast: spy[spy.length - 1][0], iwm: !!iwm?.length,
});

console.log(`[compute] сделок ${trades.length}, покупок ${buys.length}, прошли гейты ${okN} (${Math.round(okN / Math.max(1, buys.length) * 100)}%)`);
console.log(`[compute] отсев: ${Object.entries(dropCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ') || 'нет'}`);
console.log(`[compute] бэктест ${backtestRows.length}, в рабочем наборе ${backtestRows.filter(r => r.set === 1).length}, карточек ${tickerFiles}`);
console.log(`[compute] без цен: ${noPriceTickers.size} тикеров; OTC отсечено строк: ${cntOtc} (из них по реестру символов: ${cntOtcByRegistry})`);
console.log(`[compute] качество: чужой тикер ${quality.reassigned} строк в ${quality.reassignedTickers.size} тикерах; символ вне реестра ${quality.unknownSymbol}; вход невозможен ${quality.noEntry}; снято выбросов ${readStats.droppedBars} в ${readStats.dirtySeries} рядах; обрезано замороженных хвостов ${readStats.frozenBars} баров в ${readStats.frozenSeries} рядах`);
console.log(`[compute] ремонт рядов: пересчитано по сплитам ${readStats.splitFixed}; обрезано по реестру ${readStats.clippedBars} баров в ${readStats.clippedSeries} рядах; срезано по разрыву данных ${readStats.brokenBars} баров в ${readStats.brokenSeries} рядах; устаревших рядов (не делистинг) ${stalePrices.size}`);
if (workingSet) {
  console.log(`[compute] рабочий набор: ${workingSet.n} бумаг, к SPY ${(workingSet.spy * 100).toFixed(1)}% (t=${workingSet.spyT}), `
    + `α к 3 факторам ${(workingSet.a * 100).toFixed(1)}% (t=${workingSet.t}), Шарп ${workingSet.sharpe}, `
    + `сверх контроля ${workingSet.control ? (workingSet.control.ex * 100).toFixed(1) + '% (t=' + workingSet.control.t + ')' : 'н/д'}, нетто ${(workingSet.net * 100).toFixed(1)}%`);
} else console.log('[compute] рабочий набор: недостаточно месяцев для оценки');
