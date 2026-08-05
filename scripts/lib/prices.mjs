// Цены: Yahoo chart API (первичный, adjclose = сплиты+дивиденды),
// Stooq — резерв (без обхода антибот-челленджа: если отдаёт HTML — источник помечается недоступным).
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { politeFetch, BROWSER_UA, addDaysIso, readJson } from './util.mjs';
import { loadSymbolRanges, mergeRanges } from './symbols.mjs';

// Тикеры SEC -> Yahoo: классы акций через дефис (BRK.B -> BRK-B)
export function yahooSymbol(t) { return t.replace(/\./g, '-').replace(/\//g, '-'); }
export function stooqSymbol(t) { return t.replace(/\./g, '-').toLowerCase() + '.us'; }

const Y_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
let yHostIdx = 0;

// Бумага должна быть американской и котироваться в долларах. Проверка нужна потому, что
// у Yahoo один и тот же символ может обслуживать инструмент другой страны, и в ответ
// приходит смесь: у ITC к настоящим барам ITC Holdings ($40) подмешивались чужие бары
// по $7800, что давало в бэктесте избыточную доходность +42 000% на одной сделке.
const ALLOWED_CURRENCY = 'USD';
const ALLOWED_INSTRUMENT = new Set(['EQUITY', 'ETF']);
export function metaAcceptable(meta) {
  if (!meta) return { ok: true, reason: null };   // меты нет — не повод отвергать ряд
  if (meta.currency && meta.currency !== ALLOWED_CURRENCY) return { ok: false, reason: `валюта ${meta.currency}` };
  if (meta.instrumentType && !ALLOWED_INSTRUMENT.has(meta.instrumentType)) return { ok: false, reason: `тип ${meta.instrumentType}` };
  return { ok: true, reason: null };
}

// Изолированный выброс — бар, который отличается более чем втрое от медианы соседей
// (окно ±30) И ПРИ ЭТОМ соседи слева и справа согласны между собой. Второе условие
// обязательно: без него на настоящем скачке цены (10 -> 60) удалялся бы последний бар
// ПЕРЕД скачком — он тоже далёк от медианы окна. Уровневый сдвиг не трогаем: удалить
// настоящий бар хуже, чем оставить подозрительный.
// Ловит склейку двух инструментов под одним символом — у ITC настоящие бары по $40 шли
// вперемешку с чужими по $7800, и это давало в бэктесте +42 000% на одной сделке.
//
// Окно расширено с ±7 до ±30 (аудит 08.2026): чужие бары приходят не по одному, а блоками.
// У ITC блок из 16 баров по $15 000 в июне-июле 2021 старое окно не перекрывало, и ряд
// оставался грязным — месячная доходность бумаги в панели доходила до +540 000%.
// Проверено на всём кэше: расширение снимает 3428 баров в 257 рядах и не трогает
// настоящие скачки (AMRN +315%, KRTX +443%, MCRB +389% остаются на месте).
const SPIKE_RATIO = 3;
const WIN = 30;
const VOL_CONFIRM = 1.5;   // во сколько раз объём бара должен превышать медианный, чтобы верить цене
const EXTREME_DEV = 10;   // отклонение, при котором объём уже не оправдание: такого движения за день не бывает
const medOf = a => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
// Точная проверка стоит две сортировки окна на бар; с окном ±30 это полторы минуты на
// 5300 рядах, а compute читает кэш дважды. Поэтому сначала дешёвый отбор кандидатов за
// O(n) по среднему логарифму окна (префиксные суммы, без сортировок), и лишь для них —
// точное правило. Порог отбора (25%) много мягче рабочего (3x), поэтому кандидатом
// становится практически всё, что точное правило могло бы снять: сверено на всём кэше —
// 5838 снятых баров против 5847 у точной реализации, расходятся 3 ряда из 5275.
// Цена вопроса: 4 секунды на полный кэш вместо 80.
const CAND_LOG = Math.log(1.25);
// Проход повторяется, пока что-то снимается (не более трёх раз). Одного прохода мало:
// у блока чужих баров крайние бары защищены тем же условием «стороны расходятся», что и
// настоящий сдвиг уровня, — их видно только после того, как убрана середина блока.
export function sanitizeSeries(series) {
  let cur = series, total = 0;
  for (let pass = 0; pass < 3; pass++) {
    const r = sanitizePass(cur);
    if (!r.dropped) break;
    cur = r.series; total += r.dropped;
  }
  return total ? { series: cur, dropped: total } : { series: series ?? [], dropped: 0 };
}
// Края ряда не проверяем: с одной стороны нет соседей, и условие «стороны согласны»
// проверить не на чем — на первом баре ряда, начинающегося сразу после настоящего скачка,
// это давало ложное срабатывание.
const MIN_SIDE = 3;
function sanitizePass(series) {
  const n = series?.length ?? 0;
  if (n < 5) return { series: series ?? [], dropped: 0 };
  const L = new Float64Array(n), S = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { L[i] = series[i][2] > 0 ? Math.log(series[i][2]) : 0; S[i + 1] = S[i] + L[i]; }
  const keep = new Array(n).fill(true);
  let dropped = 0;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - WIN), hi = Math.min(n - 1, i + WIN);
    const cnt = hi - lo;                                   // без самого бара
    if (cnt < 2 || i - lo < MIN_SIDE || hi - i < MIN_SIDE) continue;
    const mean = (S[hi + 1] - S[lo] - L[i]) / cnt;
    if (Math.abs(L[i] - mean) < CAND_LOG) continue;        // заведомо не выброс
    const before = [], after = [];
    for (let k = lo; k < i; k++) before.push(series[k][2]);
    for (let k = i + 1; k <= hi; k++) after.push(series[k][2]);
    const mb = medOf(before), ma = medOf(after);
    // Уровень до и после бара расходится сам по себе — это настоящий сдвиг цены
    // (поглощение, обвал, крупная новость), а не выброс. Не трогаем.
    if (mb > 0 && ma > 0 && Math.max(mb, ma) / Math.min(mb, ma) > SPIKE_RATIO) continue;
    const m = medOf(before.concat(after));
    if (!(m > 0 && (series[i][2] / m > SPIKE_RATIO || series[i][2] / m < 1 / SPIKE_RATIO))) continue;
    // ОБЪЁМ решает, настоящий ли это бар. Всплеск цены без сделок не бывает: у чужого
    // инструмента объём свой и обычно низкий (у ITC 30–80 тыс. против миллиона у настоящих
    // баров), а у настоящего движения он взрывается (GME 29.01.2021: цена ×17, объём ×10).
    // Без этой проверки расширенное окно съедало реальные всплески: короткое сжатие
    // выглядит для медианного фильтра ровно как выброс.
    // ...но у объёма есть предел доверия: отклонение в десятки раз с возвратом на прежний
    // уровень за один день бумагой не бывает, каким бы ни был объём. У ITC чужой бар
    // $10 500 против $37 пришёл с объёмом выше медианного и одной проверкой объёма
    // защищался. Поэтому крайние отклонения снимаем безусловно.
    const dev = Math.max(series[i][2] / m, m / series[i][2]);
    if (dev < EXTREME_DEV) {
      const vols = [];
      for (let k = lo; k <= hi; k++) if (k !== i && series[k][3] > 0) vols.push(series[k][3]);
      const mv = medOf(vols);
      if (mv > 0 && series[i][3] > mv * VOL_CONFIRM) continue;   // объём подтверждает движение
    }
    keep[i] = false; dropped++;
  }
  return dropped ? { series: series.filter((_, i) => keep[i]), dropped } : { series, dropped: 0 };
}

// Замороженный хвост: Tiingo не обрывает ряд делистнутой бумаги, а достраивает его
// последней ценой с нулевым объёмом — у SGEN сделка с Pfizer закрылась 2023-12-14 по
// $228.74, и дальше идут ещё 660 баров с той же ценой. Для движка это яд: ряд выглядит
// живым, детектор делистинга (последний бар старше двух недель) не срабатывает, а
// двухмесячная доходность превращается в «двенадцатимесячную», добитую нулями.
// Обрезаем до первого бара постоянной цены — он и есть последний торговый день.
const FROZEN_MIN = 5;
export function trimFrozenTail(series) {
  if (!series || series.length < FROZEN_MIN + 20) return { series: series ?? [], trimmed: 0 };
  const last = series[series.length - 1][2];
  let i = series.length - 1;
  while (i > 0 && series[i - 1][2] === last) i--;
  const runLen = series.length - i;
  if (runLen < FROZEN_MIN) return { series, trimmed: 0 };
  // Настоящая торговля на постоянной цене оставляет объём; замороженный хвост — почти нет.
  const before = series.slice(Math.max(0, i - 60), i).map(r => r[3]).filter(v => v > 0).sort((a, b) => a - b);
  if (!before.length) return { series, trimmed: 0 };
  const medVol = before[(before.length - 1) >> 1];
  const tailVol = series.slice(i + 1).reduce((s, r) => s + (r[3] > 0 ? r[3] : 0), 0);
  if (tailVol > medVol * 0.01 * runLen) return { series, trimmed: 0 };
  return { series: series.slice(0, i + 1), trimmed: runLen - 1 };
}

// ---- Ремонт ряда по внешним источникам истины (аудит 08.2026) ----
// Три разные болезни, три разных лекарства. Порядок важен: сначала чиним известное
// (сплиты), потом режем чужое (реестр), и только потом бьём эвристикой по остатку —
// иначе эвристика срабатывала бы на том, что чинится точно.

// 1. НЕСКОРРЕКТИРОВАННЫЙ СПЛИТ. Yahoo отдаёт событие сплита в events.splits, но сам ряд
// иногда оставляет в номинале: у TTOO 12.10.2022 цена $5.60, 13.10.2022 (обратный сплит
// 1:50) — $255, и это не рост, а смена номинала. Проверено на свежем ответе Yahoo в
// августе 2026: дело не в устаревшем кэше, источник отдаёт так сегодня.
// Признак однозначный: скачок в точности равен 1/k. Тогда бары ДО даты сплита переводим
// в посплитовые единицы (цена /k, объём *k) — долларовый оборот при этом инвариантен.
// Дата события у источника гуляет на день-два относительно фактического пересчёта, а сам
// коэффициент бывает неточным: у FFAI в реестре записан 1:150 на 24.07.2026, а цена
// пересчиталась 23-го и примерно в 100 раз. Поэтому ищем скачок в окне ±3 бара и, если
// он лишь приблизительно совпадает с коэффициентом, берём ЗА ИСТИНУ САМ СКАЧОК: цена —
// прямое свидетельство смены номинала, а поле реестра — пересказ.
const SPLIT_TOL = 0.25;          // точное совпадение: пересчитываем строго по коэффициенту
const SPLIT_NEAR = Math.log(2);  // приблизительное: пересчитываем по наблюдённому скачку
const SPLIT_WIN = 3;
// В ряду обязана быть СТУПЕНЬ. Без этого условия правило ломало уже скорректированные
// ряды: у сплита 1:2 скорректированный ряд не прыгает вовсе, а |log k| = 0.69 само по себе
// укладывалось в допуск — и вся история делилась пополам. Проверено: без ступени правило
// «чинило» 292 ряда вместо двух настоящих.
const SPLIT_MIN_STEP = Math.log(1.8);
export function repairUnadjustedSplits(series, splits) {
  if (!series?.length || !splits?.length) return { series, fixed: 0 };
  const dates = series.map(r => r[0]);
  let fixed = 0;
  const out = series.map(r => r.slice());
  for (const [d, k] of [...splits].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    if (!(k > 0) || (k > 0.5 && k < 2)) continue;   // дробления вроде 1.02 — это дивиденд акциями
    let at = dates.findIndex(x => x >= d);
    if (at <= 0) continue;
    // самый крупный скачок в окне вокруг даты события
    let best = null;
    for (let i = Math.max(1, at - SPLIT_WIN); i <= Math.min(out.length - 1, at + SPLIT_WIN); i++) {
      const jump = out[i][2] / out[i - 1][2];
      if (!(jump > 0)) continue;
      const err = Math.abs(Math.log(jump * k));
      if (!best || err < best.err) best = { i, jump, err };
    }
    // Ступень должна быть и по величине, и по направлению совпадать с коэффициентом
    if (!best || best.err > SPLIT_NEAR || Math.abs(Math.log(best.jump)) < SPLIT_MIN_STEP) continue;
    const f = best.err <= SPLIT_TOL ? k : 1 / best.jump;
    for (let j = 0; j < best.i; j++) {
      out[j][1] = Math.round((out[j][1] / f) * 1e4) / 1e4;
      out[j][2] = Math.round((out[j][2] / f) * 1e4) / 1e4;
      out[j][3] = Math.round(out[j][3] * f);
    }
    fixed++;
  }
  return fixed ? { series: out, fixed } : { series, fixed: 0 };
}

// 2. ЧУЖОЙ ИНСТРУМЕНТ ПОД ТЕМ ЖЕ СИМВОЛОМ. Котировки скачиваются сегодняшние, значит ряд
// принадлежит нынешнему владельцу тикера. Реестр символов даёт интервалы листинга, и всё,
// что вне последнего непрерывного интервала, — другая бумага: у ITC листинг кончился
// 24.10.2016, а в кэше бары до 2022 года; у CHRD интервалы 2001–2010 и с 20.11.2020, и
// ровно на этой границе ряд прыгает с $0.12 на $31 (старый капитал погашен в банкротстве).
//
// ОСТОРОЖНО с переименованиями: реестр ключуется тикером, поэтому TICC->OXSQ выглядит как
// «символ начался в 2018-м», хотя бумага та же и ряд непрерывен. Поэтому режем только там,
// где на границе есть РАЗРЫВ: пауза в торгах ≥30 дней или скачок цены вдвое. Без этого
// условия правило снимало бы 213 строк одного только OXSQ.
const CLIP_GAP_DAYS = 30;
const CLIP_JUMP = 2;
const TAIL_OVERHANG_DAYS = 90;  // хвост режем, только если реестр кончился заведомо давно
export function clipToInstrument(series, merged) {
  if (!series?.length || !merged?.length) return { series, head: 0, tail: 0 };
  const [lo, hi] = merged[merged.length - 1];
  let out = series, head = 0, tail = 0;
  // хвост: бары после конца листинга (запас — на устаревший снимок реестра)
  const last = out[out.length - 1][0];
  if (hi < addDaysIso(last, -TAIL_OVERHANG_DAYS)) {
    const keep = out.filter(r => r[0] <= hi);
    tail = out.length - keep.length;
    out = keep;
  }
  if (!out.length) return { series: out, head, tail };
  // голова: бары до начала последнего интервала — но только при настоящем разрыве
  const b = out.findIndex(r => r[0] >= lo);
  if (b > 0) {
    const gap = (Date.parse(out[b][0]) - Date.parse(out[b - 1][0])) / 86400000;
    const a = out[b - 1][2], c = out[b][2];
    const jump = a > 0 && c > 0 ? Math.max(a / c, c / a) : 1;
    if (gap >= CLIP_GAP_DAYS || jump >= CLIP_JUMP) { head = b; out = out.slice(b); }
  }
  return { series: out, head, tail };
}

// 3. ОСТАТОК: сдвиг уровня впятеро, которого нет ни в реестре сплитов, ни в реестре
// символов. Так выглядит обратный сплит, о котором источник не сообщил (COSM 16.12.2022:
// $0.33 -> $23.01), и склейка после реорганизации. Коэффициент восстановить не из чего,
// поэтому НЕ пересчитываем, а обрезаем: потерять историю честнее, чем выдумать доходность.
//
// Отличаем от настоящего скачка по объёму: у новости объём взрывается (KRTX +443% в 2019-м),
// у смены номинала — падает во столько же раз, во сколько выросла цена. Поэтому режем
// только когда объём НЕ вырос.
//
// Режем ТОЛЬКО скачки ВВЕРХ. Обвал впятеро — это чаще всего настоящий обвал (банкротство,
// раскрытие мошенничества), и вырезать его значило бы стереть из бэктеста реальный убыток,
// то есть добавить выживаемости там, где мы с ней и так боремся. Проверено: у TTOO правило
// без этого ограничения срезало 2904 бара на падении суб-пенни бумаги 0.0022 -> 0.0004.
// Незамеченный прямой сплит даёт фиктивный убыток — направление консервативное.
const BREAK_RATIO = 5;
const BREAK_LEVEL = 4;
const BREAK_VOL_MAX = 1.5;
export function cutAtDataBreak(series, splits) {
  if (!series || series.length < 60) return { series: series ?? [], cut: 0 };
  const spDates = new Set((splits ?? []).map(x => x[0]));
  const med = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
  let from = 0;
  for (let i = 30; i < series.length - 10; i++) {
    const r = series[i][2] / series[i - 1][2];
    if (!(r >= BREAK_RATIO)) continue;
    if (spDates.has(series[i][0])) continue;                 // известный сплит — им занимается шаг 1
    const before = series.slice(Math.max(from, i - 30), i).map(x => x[2]);
    const after = series.slice(i, i + 30).map(x => x[2]);
    // После разрыва достаточно пяти баров: свежий разрыв в хвосте ряда иначе не ловился
    // бы до тех пор, пока не накопится две недели торгов, а payload собирается ежедневно.
    if (before.length < 10 || after.length < 5) continue;
    const mb = med(before), ma = med(after);
    if (!(mb > 0 && ma > 0)) continue;
    const lvl = ma / mb;
    if (!(lvl >= BREAK_LEVEL)) continue;                     // уровень не сдвинулся — это выброс
    const vb = med(series.slice(Math.max(from, i - 30), i).map(x => x[3]).filter(v => v > 0));
    const va = med(series.slice(i, i + 30).map(x => x[3]).filter(v => v > 0));
    if (vb > 0 && va > 0 && va / vb > BREAK_VOL_MAX) continue;       // объём взорвался — это новость
    from = i;
  }
  return from ? { series: series.slice(from), cut: from } : { series, cut: 0 };
}

// Ряд: [[iso, close, adjclose, volume], ...]. close — для графиков (номинал),
// adjclose (сплиты+дивиденды) — для доходностей, volume — для прокси ликвидности/размера
// (капитализации в бесплатных источниках нет, а $-оборот доступен и хорошо с ней коррелирует).
// -> { series } | { missing: true } | throws при сетевом сбое
export async function fetchYahooDaily(ticker, fromIso) {
  const p1 = Math.floor(new Date(fromIso + 'T00:00:00Z').getTime() / 1000);
  const p2 = Math.floor(Date.now() / 1000) + 86400;
  const host = Y_HOSTS[yHostIdx++ % Y_HOSTS.length];
  const url = `https://${host}/v8/finance/chart/${encodeURIComponent(yahooSymbol(ticker))}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplits`;
  const { status, body } = await politeFetch(url, { ua: BROWSER_UA, as: 'text', retries: 3 });
  if (status === 404 || status === 403 || !body) return { missing: true };
  let j;
  try { j = JSON.parse(body); } catch { return { missing: true }; }
  const r = j?.chart?.result?.[0];
  if (!r || !r.timestamp?.length) return { missing: true };
  // Ряд чужого инструмента хуже отсутствия ряда: он выглядит правдоподобно и молча
  // попадает в бэктест. Отвергаем до разбора баров, кэш при этом сохраняется как был.
  const mOk = metaAcceptable(r.meta);
  if (!mOk.ok) return { missing: true, rejected: mOk.reason };
  const close = r.indicators?.quote?.[0]?.close;
  const vol = r.indicators?.quote?.[0]?.volume;
  const adj = r.indicators?.adjclose?.[0]?.adjclose ?? close;
  if (!adj || !close) return { missing: true };
  const rnd = v => Math.round(v * 10000) / 10000;
  const series = [];
  let prevIso = '';
  for (let i = 0; i < r.timestamp.length; i++) {
    const a = adj[i], c = close[i] ?? adj[i];
    if (a === null || a === undefined || !Number.isFinite(a) || a <= 0) continue;
    // Таймстемпы Yahoo — открытие сессии в бирже; день берём по Нью-Йорку через offset меты
    const iso = new Date((r.timestamp[i] + (r.meta?.gmtoffset ?? -14400)) * 1000).toISOString().slice(0, 10);
    const v = vol?.[i];
    const row = [iso, rnd(Number.isFinite(c) && c > 0 ? c : a), rnd(a), Number.isFinite(v) ? v : 0];
    if (iso === prevIso) { series[series.length - 1] = row; continue; }
    series.push(row);
    prevIso = iso;
  }
  // Сплиты: колонка close у Yahoo пересчитана задним числом, а инсайдер платил номинальную
  // цену своего времени. Без коэффициентов сравнение цены сделки с котировкой ломается
  // (обратный сплит 1:20 делает историческую цену в 20 раз выше фактической).
  const splits = [];
  for (const s of Object.values(r.events?.splits ?? {})) {
    const num = Number(s.numerator), den = Number(s.denominator);
    if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) continue;
    splits.push([new Date((s.date + (r.meta?.gmtoffset ?? -14400)) * 1000).toISOString().slice(0, 10), rnd(num / den, 6)]);
  }
  splits.sort((a, b) => a[0] < b[0] ? -1 : 1);
  const clean = sanitizeSeries(series);
  return clean.series.length
    ? { series: clean.series, splits, dropped: clean.dropped, exchange: r.meta?.exchangeName ?? null }
    : { missing: true };
}

// Резерв: Stooq. НЕ обходим антибот — HTML-ответ означает «источник закрыт», честно возвращаем down.
export async function fetchStooqDaily(ticker, fromIso) {
  const d1 = fromIso.replace(/-/g, '');
  const url = `https://stooq.com/q/d/l/?s=${stooqSymbol(ticker)}&d1=${d1}&d2=20991231&i=d`;
  const { body } = await politeFetch(url, { ua: BROWSER_UA, as: 'text', retries: 1 });
  if (!body || body.startsWith('<')) return { down: true };
  const lines = body.trim().split('\n');
  if (lines.length < 2 || !lines[0].startsWith('Date,')) return { missing: true };
  const series = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const close = Number(c[4]);
    // У Stooq только сплит-коррекция — close и adjclose совпадают (резерв, честно ниже качеством)
    const v = Number(c[5]);
    if (c[0] && Number.isFinite(close) && close > 0) series.push([c[0], close, close, Number.isFinite(v) ? v : 0]);
  }
  const clean = sanitizeSeries(series);
  return clean.series.length ? { series: clean.series, dropped: clean.dropped } : { missing: true };
}

// ---- Кэш на ветке data: prices/<T>.csv.gz строками "YYYY-MM-DD,adjclose" ----

export function priceCachePath(dataDir, ticker) {
  return join(dataDir, 'prices', ticker.replace(/[^A-Za-z0-9.-]/g, '_') + '.csv.gz');
}

// Счётчик выброшенных при чтении баров: кэш на ветке data писался до появления фильтра,
// а в режиме daily перезагружаются только недавние тикеры — остальные ряды очищаются
// именно здесь, на чтении. Учёт ведётся по тикеру, а не по вызову: compute читает один и
// тот же ряд дважды (фаза цен и карточки), и без дедупликации счётчик врал бы вдвое.
export const readStats = {
  droppedBars: 0, dirtySeries: 0, frozenBars: 0, frozenSeries: 0,
  splitFixed: 0, clippedBars: 0, clippedSeries: 0, brokenBars: 0, brokenSeries: 0,
  _seen: new Set(),
};

// Источники истины для ремонта читаются один раз на каталог данных: _splits.json (61 КБ)
// и реестр символов (374 КБ) грузить на каждый из 5300 тикеров было бы разорительно.
const repairCtx = new Map();
function ctxFor(dataDir) {
  let c = repairCtx.get(dataDir);
  if (!c) {
    const ranges = loadSymbolRanges(dataDir);
    c = { splits: readJson(join(dataDir, 'prices', '_splits.json'), {}), ranges, merged: new Map() };
    repairCtx.set(dataDir, c);
  }
  return c;
}
function mergedFor(ctx, ticker) {
  const key = String(ticker ?? '').toUpperCase();
  if (!ctx.merged.has(key)) {
    const list = ctx.ranges?.[key];
    ctx.merged.set(key, list?.length ? mergeRanges(list) : null);
  }
  return ctx.merged.get(key);
}

// Последний день, когда символ по реестру ещё числился на бирже (null — реестр не знает).
// Нужен, чтобы отличить делистинг от устаревшего кэша: в режиме daily обновляются только
// тикеры с недавними покупками, и у остальных ряд обрывается там, где его последний раз
// качали. Движок раньше принимал это за делистинг и закрывал позицию по старой цене.
export function listedThrough(ranges, ticker) {
  const list = ranges?.[String(ticker ?? '').toUpperCase()];
  if (!list?.length) return null;
  const m = mergeRanges(list);
  return m[m.length - 1][1];
}

// Дешёвая проверка наличия: распаковывать и чистить весь ряд ради «есть или нет»
// значило бы прогнать 100 МБ кэша впустую (режим backfill делает это для всей вселенной).
export function hasPriceCache(dataDir, ticker) {
  return existsSync(priceCachePath(dataDir, ticker));
}

export function readPriceCache(dataDir, ticker) {
  const p = priceCachePath(dataDir, ticker);
  if (!existsSync(p)) return null;
  const text = gunzipSync(readFileSync(p)).toString('utf8');
  const series = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const c = line.split(',');
    // Старый кэш (3 колонки) читается как ряд без объёма — прокси ликвидности будет null
    series.push([c[0], Number(c[1]), Number(c[2] ?? c[1]), c[3] === undefined ? null : Number(c[3])]);
  }
  // Весь ремонт делается на ЧТЕНИИ, а не разово по кэшу: источник отдаёт часть болезней
  // прямо сейчас (нескорректированный сплит TTOO приходит таким от Yahoo и сегодня),
  // поэтому починенный однажды файл был бы снова испорчен ближайшей ежедневной выкачкой.
  const ctx = ctxFor(dataDir);
  const clean = sanitizeSeries(series);
  const sp = ctx.splits[ticker];
  const fixed = repairUnadjustedSplits(clean.series, sp);
  const clip = clipToInstrument(fixed.series, mergedFor(ctx, ticker));
  const brk = cutAtDataBreak(clip.series, sp);
  // Обрезка замороженного хвоста делается и на чтении: ряды, скачанные до появления
  // правила, лежат на ветке data и повторно не загружаются (месячный лимит символов).
  const trim = trimFrozenTail(brk.series);
  const touched = clean.dropped || trim.trimmed || fixed.fixed || clip.head || clip.tail || brk.cut;
  if (touched && !readStats._seen.has(p)) {
    readStats._seen.add(p);
    readStats.droppedBars += clean.dropped;
    readStats.frozenBars += trim.trimmed;
    readStats.splitFixed += fixed.fixed;
    readStats.clippedBars += clip.head + clip.tail;
    readStats.brokenBars += brk.cut;
    if (clean.dropped) readStats.dirtySeries++;
    if (trim.trimmed) readStats.frozenSeries++;
    if (clip.head || clip.tail) readStats.clippedSeries++;
    if (brk.cut) readStats.brokenSeries++;
  }
  return trim.series;
}

export function writePriceCache(dataDir, ticker, series) {
  const p = priceCachePath(dataDir, ticker);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, gzipSync(series.map(r => r.slice(0, 4).join(',')).join('\n'), { level: 9 }));
}

// Номинальная цена бумаги на дату iso: котировка Yahoo, «раскрученная» назад через все
// сплиты, случившиеся ПОСЛЕ этой даты. Именно её видел инсайдер в момент сделки.
export function nominalFactor(splits, iso) {
  let f = 1;
  for (const [d, ratio] of splits ?? []) if (d > iso) f *= ratio;
  return f;
}

// Ответ Tiingo -> наш формат. У Tiingo close номинальный, а adjClose с поправкой на сплиты
// и дивиденды. Кэш же хранит close в конвенции Yahoo — пересчитанным по сплитам задним
// числом, иначе nominalFactor() восстанавливал бы «номинал» из номинала и сравнение цены
// формы с котировкой ломалось бы ровно так, как ломалось на обратном сплите 1:20.
// Поэтому идём с конца ряда, накапливая сплит-фактор.
export function normalizeTiingo(rows) {
  const asc = rows.slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const out = new Array(asc.length);
  const splits = [];
  const rnd = v => Math.round(v * 10000) / 10000;
  let cum = 1;
  for (let i = asc.length - 1; i >= 0; i--) {
    const r = asc[i];
    const iso = String(r.date ?? '').slice(0, 10);
    const close = Number(r.close), adj = Number(r.adjClose);
    // Объём берём скорректированный на сплиты: прокси ликвидности считается как
    // close * volume, а close мы здесь тоже приводим к сплит-конвенции. Смешать сырой
    // объём со сплит-скорректированной ценой значило бы ошибиться в разы на любой бумаге,
    // пережившей сплит. У Yahoo обе величины уже согласованы, у Tiingo — нет.
    const vol = Number(r.adjVolume ?? r.volume);
    out[i] = /^\d{4}-\d{2}-\d{2}$/.test(iso) && Number.isFinite(close) && close > 0 && Number.isFinite(adj) && adj > 0
      ? [iso, rnd(close / cum), rnd(adj), Number.isFinite(vol) && vol > 0 ? Math.round(vol) : 0]
      : null;
    const sf = Number(r.splitFactor);
    if (Number.isFinite(sf) && sf > 0 && sf !== 1) { splits.push([iso, Math.round(sf * 1e6) / 1e6]); cum *= sf; }
  }
  splits.sort((a, b) => a[0] < b[0] ? -1 : 1);
  const clean = sanitizeSeries(out.filter(Boolean));
  const trim = trimFrozenTail(clean.series);
  return { series: trim.series, splits, dropped: clean.dropped, frozen: trim.trimmed };
}

// Слияние: свежие данные замещают хвост кэша с точки перекрытия
// (adjclose пересчитывается задним числом после дивидендов — просто дописывать нельзя).
export function mergeSeries(cached, fresh) {
  if (!cached?.length) return fresh;
  if (!fresh?.length) return cached;
  const freshStart = fresh[0][0];
  const head = cached.filter(r => r[0] < freshStart);
  return [...head, ...fresh];
}
