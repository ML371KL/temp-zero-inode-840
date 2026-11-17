// «Утренний список»: покупки инсайдеров по подачам одного дня, которые имеет смысл купить на
// открытии следующего торгового дня (D+1) и продать на его закрытии. Чистые функции без
// ввода-вывода: сборка (compute.mjs) подаёт им строки и открытия, самотесты — синтетику.
//
// Почему так, а не набор «у максимума, 3 мес.»: сигнал покупки инсайдера отыгрывается за
// полтора дня вокруг подачи, и торгуема только часть после неё (ревизия 04.11.2026 и независимая
// проверка docs/ЧТО-РАБОТАЕТ.md). Результат меряется от ОТКРЫТИЯ D+1 до ЗАКРЫТИЯ того же дня,
// фиксированной суммой на сделку, одна сделка на бумагу в день, за вычетом внутридневной
// доходности IWM (и, рядом, SPY).
//
// ОСНОВНОЙ СПИСОК — оборот ≥$10 млн и скор ≥2 (лучший вариант проверки: 2016–26 +0,344% брутто,
// +0,225% после издержек, Шарп 1,21, вживую +0,46% к IWM). Скор бумаги за день подачи — сумма
// четырёх баллов: самая крупная покупка дня ≥$100 тыс.; ≥$1 млн; среди покупателей есть офицер
// (C/F/O); просадка от 52-недельного максимума глубже −30%. Остальные бумаги от $10 млн (скор 0–1)
// остаются свёрнутыми ниже: покупки на $10–100 тыс. без других признаков в 2016–26 дают −0,04%.
//
// ОПРЕДЕЛЕНИЯ — те же, что в проверенной стратегии (скрипты ревизии r1_events, r10_oos, r14_rank), иначе
// панель торговала бы не то, что измерено (ревизия данных 04.11.2026, П11):
//  - событие — эмитент × дата подачи по обыкновенным акциям; пороги суммы — по САМОЙ КРУПНОЙ строке,
//    прошедшей гейты (а не по сумме дня);
//  - офицер — у любого владельца любой строки события в rel есть C, F или O (директор-офицер DO — офицер);
//  - просадка — минимум по строкам события (на дату каждой сделки);
//  - цена ≥$5 — закрытие дня подачи D0, оборот — медиана close×volume за 20 баров, заканчивающихся D0
//    включительно (не меньше 10 баров); D0 — последний торговый день не позже даты подачи.

export const MORNING = {
  minVal: 1e4,          // сумма покупки (строки), $
  minPx: 5,             // закрытие дня подачи D0 / открытие D+1, $
  dvMin: 1e7,           // нижняя граница оборота списка (медиана $-оборота за 20 баров до D0 включительно), $
  dvCost: 3e7,          // оборот, с которого издержки ниже
  costHi: 0.001,        // издержки на круг при обороте ≥$30 млн, доля
  costLo: 0.0015,       // издержки на круг при обороте $10–30 млн, доля
  scoreMin: 2,          // порог скора основного списка
  scoreVal: 1e5,        // балл за самую крупную покупку дня, $
  bigVal: 1e6,          // второй балл за сумму, $
  deepDd: -0.3,         // балл за просадку глубже
  liveFrom: '2026-11-05',   // списки с этой даты подачи идут в живой счётчик
  daysShown: 10,        // сколько последних дней подачи отдаёт файл витрине
  stake: 1e4,          // сумма в сделке, на которую витрина пересчитывает «сумму нетто» счётчика, $
  prevMax: 365,         // окно поля prev (повтор), календарных дней
};

// ЗДОРОВЬЕ СИГНАЛА (audit-840-health-2026-11-17/REPORT.md, раздел 3; согласовано 17.11.2026). Один показатель — сглаженный перевес
// дня D+1 основного списка: сделка — остаток к IWM с бетой 1,17, обрезанный на −6% и +15%; день весит не больше пяти сделок;
// экспоненциальное сглаживание с полупериодом 125 дней от первого D+1 после подачи 14.08.2026; статус — по отставанию от исторических
// +0,37% в единицах ошибки (z) с гистерезисом. limit — лимит заявки LOO бота (+10% к закрытию дня подачи): сделка выше него пропускается
// и в счётчике, и здесь. spreadDays — окно справочной строки «скор различает».
export const HEALTH = {
  from: '2026-08-14', beta: 1.17, lo: -0.06, hi: 0.15, kcap: 5, half: 125, mu0: 0.0037, sig: 0.03,
  zWatch: -1.55, zAlarm: -2.25, zBack: -1.0, minW: 100, limit: 0.10, spreadDays: 250,
};

// Повтор (ревизия 10.11.2026, раздел 4, audit-840-fresh-2026-11-10): если у бумаги уже была покупка инсайдера за последние 14 дней,
// перевес D+1 вдвое меньше (+0,23…0,26% против +0,44…0,51% в обеих половинах истории). Отбор списка от этого НЕ зависит: поле prev
// строки читает теневой вариант бота (ibkr-bot-840, [shadow]), который понижает повторы в очереди дня внутри того же скора.
// prev — календарных дней от дня подачи fd до предыдущего дня подачи того же эмитента (cik), в котором была хотя бы одна покупка
// обыкновенных акций от $10 тыс., прошедшая гейты (то есть день, когда у эмитента было бы событие списка, без порогов цены и оборота);
// null — такого дня не было за последние prevMax дней. dates — возрастающий массив ISO-дат таких дней этого эмитента (повторы допустимы).
export function prevDays(dates, fd, p = MORNING) {
  if (!dates?.length) return null;
  let lo = 0, hi = dates.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] < fd) lo = m + 1; else hi = m; }
  if (lo === 0) return null;
  const d = Math.round((Date.parse(fd) - Date.parse(dates[lo - 1])) / 864e5);
  return d <= p.prevMax ? d : null;
}

// Лучшая роль: офицеры (C, F, O) сильнее директоров (+0,32% против +0,17% в ревизии).
const ROLE_RANK = { C: 0, F: 1, O: 2, D: 3, T: 4, X: 5 };
export const bestRole = roles => [...roles].filter(Boolean).sort((a, b) => (ROLE_RANK[a] ?? 9) - (ROLE_RANK[b] ?? 9))[0] ?? 'X';
export const isOfficer = role => role === 'C' || role === 'F' || role === 'O';

// Скор: число выполненных условий из четырёх. val — самая крупная покупка дня (строка, прошедшая гейты);
// officer — среди покупателей есть офицер (без него — по лучшей роли role, как в старых вызовах).
export function scoreOf({ val, role, officer, dd }, p = MORNING) {
  return (val >= p.scoreVal ? 1 : 0) + (val >= p.bigVal ? 1 : 0) + ((officer ?? isOfficer(role)) ? 1 : 0)
    + (dd !== null && dd !== undefined && dd < p.deepDd ? 1 : 0);
}
// Издержки на круг по обороту бумаги
export const costOf = (dv, p = MORNING) => (dv >= p.dvCost ? p.costHi : p.costLo);

// Пометки — коды; подписи живут на витрине и в сообщении.
export function tagsOf({ role, officer, dd, val }, p = MORNING) {
  const t = [];
  if (officer ?? isOfficer(role)) t.push('off');
  if (dd !== null && dd !== undefined && dd < p.deepDd) t.push('deep');
  if (val >= p.bigVal) t.push('big');
  return t;
}

// Когда принята форма (время по Нью-Йорку, «ГГГГ-ММ-ДДTчч:мм»): после закрытия (16:00 и позже), в торги
// (9:30–16:00) или до открытия. Эффект у «ночных» форм сидит в разрыве до открытия D+1, у «дневных» часть
// реакции уже в цене (ревизия: 61% форм принимаются после закрытия, их D+1 +0.34%; в торги — +0.21%).
// Нет времени (строки квартальных датасетов, старые строки живого шарда) — null.
export function sessionOf(at) {
  if (!at) return null;
  const hm = String(at).slice(11, 16);
  return hm >= '16:00' ? 'post' : hm >= '09:30' ? 'rth' : 'pre';
}

const rnd = (v, k = 4) => Math.round(v * 10 ** k) / 10 ** k;

// rows — ВСЕ покупки одного дня подачи (кроме не-обыкновенных бумаг: common === false):
//   { cik, t, name, who, role, officer, val, dd, adv, px, at, drop, prev }, drop — причина отсева гейтами (null — прошла);
//   prev — у события одно на все строки (prevDays), в строку списка переносится как есть; нет поля во входе — нет и в выходе.
// Событие — эмитент (cik) × день подачи; определения — в шапке файла. Строки, не прошедшие гейты, в сумму и в
// самую крупную покупку не входят, но офицер и просадка берутся по всем строкам события — как в проверке.
// Цена D0 и оборот — у ведущей (самой крупной из прошедших гейты) строки. Событие, у которого нет цены или
// оборота на D0 (ряд не дотянул до D0 или бар младше 10), в список не попадает и считается в unpriced.
// Возвращает { rows, unpriced }: rows — по скору, затем по сумме дня (основной список сверху); main — скор ≥ порога.
export function buildDayFull(rows, p = MORNING) {
  const byE = new Map();
  for (const r of rows) {
    if (r.common === false) continue;
    const k = r.cik ?? r.t;
    (byE.get(k) ?? byE.set(k, []).get(k)).push(r);
  }
  const out = [], unpriced = [];
  for (const all of byE.values()) {
    const ok = all.filter(r => !r.drop && r.val >= p.minVal).sort((a, b) => b.val - a.val);
    if (!ok.length) continue;
    const lead = ok[0];
    const adv = lead.adv ?? lead.dv ?? null;
    if (!(lead.px > 0) || !(adv > 0)) { unpriced.push(lead.t); continue; }
    if (!(lead.px >= p.minPx)) continue;
    if (!(adv >= p.dvMin)) continue;
    const mx = lead.val;
    const val = ok.reduce((s, x) => s + x.val, 0);
    const officer = all.some(x => x.officer ?? isOfficer(x.role));
    const dds = all.map(x => x.dd).filter(Number.isFinite);
    const dd = dds.length ? Math.min(...dds) : null;
    const best = bestRole(ok.map(x => x.role));
    const role = officer && !isOfficer(best) ? 'O' : best;   // директор-офицер показывается офицером: так он и считается
    const who = [...new Set(ok.flatMap(x => x.who ?? []))];
    // Бумага узнаётся рынком по ПЕРВОЙ форме дня: время приёма — самое раннее
    const at = ok.map(x => x.at).filter(Boolean).sort()[0] ?? null;
    const score = scoreOf({ val: mx, officer, dd }, p);
    out.push({
      t: lead.t, name: lead.name, who, role, val: Math.round(val), mx: Math.round(mx), n: ok.length, at, ses: sessionOf(at),
      dd, dv: adv, px: lead.px,
      score, main: score >= p.scoreMin, cost: costOf(adv, p),
      tags: tagsOf({ role, officer, dd, val: mx }, p),
      ...(lead.prev !== undefined ? { prev: lead.prev } : {}),
    });
  }
  out.sort((a, b) => b.score - a.score || b.val - a.val || (a.t < b.t ? -1 : 1));
  return { rows: out, unpriced };
}
export const buildDay = (rows, p = MORNING) => buildDayFull(rows, p).rows;

// Лимит заявки LOO по закрытию D0 — как у бота: × (1 + limit), вниз до цента
export const looLimit = (px, h = HEALTH) => Math.floor(px * (1 + h.limit) * 100 + 1e-9) / 100;

// Результат одной сделки. entry/iwm/spy — [открытие, закрытие, вчерашнее закрытие] из одного
// ответа источника (lib/opens.mjs). Пропуск — это причина, а не ноль: пропущенная сделка не
// должна ни улучшать, ни портить счётчик. Результат считается сразу к IWM (ex) и к SPY (exS):
// в живом периоде разница между ними доходит до половины перевеса (IWM внутри дня отстаёт от S&P).
export function tradeResult(entry, iwm, spy, p = MORNING) {
  if (!entry || !(entry[0] > 0)) return { skip: 'noopen' };
  if (!(entry[1] > 0)) return { skip: 'noclose' };
  // Застывшая котировка (торгов в день не было). Записи с объёмом: признак — нулевой объём; равенство
  // открытия вчерашнему закрытию само по себе бывает и на настоящих торгах (CBU 31.08, BJRI 01.09, MATW 16.09,
  // BPRE 01.10 и 20.10, DYN 07.10.2026 — обычные дни с объёмом 0,2–4,1 млн акций). Старые записи без объёма — прежнее правило.
  const vol = entry[3];
  if (vol !== null && vol !== undefined ? !(vol > 0) : (entry[2] !== null && entry[2] !== undefined && entry[0] === entry[2])) return { skip: 'frozen' };
  if (entry[0] < p.minPx) return { skip: 'px' };
  // Лимит LOO: бот покупает на аукционе открытия с лимитом «закрытие D0 × 1,10, вниз до цента» (ibkr-bot-840, plan.loo_limit) и бумагу,
  // открывшуюся выше лимита, не получает. entry[2] — вчерашнее закрытие из того же ответа, то есть закрытие D0. Счётчик и здоровье сигнала
  // считают ровно то, что бот может купить (audit-840-health-2026-11-17, раздел 2.6: с 05.11 это GLXY и TTMI 06.11). Нет закрытия D0 — не проверяется.
  if (entry[2] > 0 && entry[0] > looLimit(entry[2]) + 1e-9) return { skip: 'limit' };
  const ok = b => b && b[0] > 0 && b[1] > 0;
  if (!ok(iwm) || !ok(spy)) return { skip: 'nobench' };
  const r = entry[1] / entry[0] - 1;
  const b = iwm[1] / iwm[0] - 1, bs = spy[1] / spy[0] - 1;
  return { o: entry[0], c: entry[1], r: rnd(r), b: rnd(b), bs: rnd(bs), ex: rnd(r - b), exS: rnd(r - bs) };
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const median = a => {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

// Показатели по одному эталону. t по дням: сначала среднее за каждый день, затем t-статистика
// среднего этих средних — сделки одного дня не независимы (общий рынок). Нетто — за вычетом
// издержек КАЖДОЙ сделки (у неё свой уровень: 0,10% или 0,15% на круг).
function metrics(trades, key, p) {
  const ex = trades.map(x => x[key]);
  const cost = trades.map(x => x.cost ?? p.costHi);
  const byDay = new Map();
  for (const x of trades) (byDay.get(x.day) ?? byDay.set(x.day, []).get(x.day)).push(x[key]);
  const dm = [...byDay.values()].map(mean);
  let tDays = null;
  if (dm.length >= 2) {
    const m = mean(dm);
    const sd = Math.sqrt(dm.reduce((s, x) => s + (x - m) ** 2, 0) / (dm.length - 1));
    if (sd > 0) tDays = rnd(m / (sd / Math.sqrt(dm.length)), 2);
  }
  const avg = mean(ex);
  return {
    mean: rnd(avg), median: rnd(median(ex)),
    win: rnd(ex.filter(x => x > 0).length / ex.length, 3),
    tDays,
    net: rnd(avg - mean(cost)),
    cumNet: rnd(ex.reduce((s, x, i) => s + x - cost[i], 0)),
  };
}

// trades — [{ day, ex, exS, cost }] (day — день D+1).
export function summarize(trades, p = MORNING) {
  const n = trades.length;
  if (!n) return { n: 0, days: 0 };
  return {
    n, days: new Set(trades.map(x => x.day)).size,
    cost: rnd(mean(trades.map(x => x.cost ?? p.costHi)), 5),
    iwm: metrics(trades, 'ex', p),
    spy: metrics(trades, 'exS', p),
  };
}

// ---------- Здоровье сигнала ----------
// Спецификация — audit-840-health-2026-11-17/REPORT.md, разделы 3.1–3.9; методика для владельца — docs/ЧТО-РАБОТАЕТ.md, «Здоровье сигнала».
// Статус пересчитывается от первого D+1 целиком при каждой сборке: одинаковые данные дают одинаковый статус и одинаковые смены.
const rn = (v, k) => (v === null || v === undefined || !Number.isFinite(v) ? null : rnd(v, k));
// Мера сделки (3.2): y = clip(r − β·b, lo, hi); r и b — открытие → закрытие D+1 бумаги и IWM
export const healthY = (r, b, h = HEALTH) => Math.min(h.hi, Math.max(h.lo, r - h.beta * b));
// Мера дня (3.2): ys — меры сделок основного списка за день. Вес дня — число сделок, но не больше kcap; нет сделок — вес 0.
export function healthDay(ys, h = HEALTH) {
  const n = ys.length;
  return { n, W: Math.min(n, h.kcap), ybar: n ? ys.reduce((s, y) => s + y, 0) / n : null };
}
// Шаг сглаживания (3.3). s — { sw, sy, sw2 } прошлого дня (нули на старте). День с весом 0 только затухает.
export function healthStep(s, W, ybar, h = HEALTH) {
  const lam = 0.5 ** (1 / h.half);
  const sw = lam * s.sw + W, sy = lam * s.sy + (W ? W * ybar : 0), sw2 = lam * lam * s.sw2 + W;
  if (!(sw > 0)) return { sw, sy, sw2, m: null, se: null, z: null };
  const m = sy / sw, se = h.sig * Math.sqrt(sw2) / sw;
  return { sw, sy, sw2, m, se, z: (m - h.mu0) / se };
}
// Автомат статусов (3.4): normal | watch | alarm. Тревога — из любого состояния при z ≤ zAlarm; наблюдение — из нормы при z ≤ zWatch;
// из наблюдения в норму — при z > zBack; из тревоги — в норму при z > zBack, в наблюдение при zWatch < z ≤ zBack. Нет z — без изменений.
export function nextStatus(st, z, h = HEALTH) {
  if (z === null || z === undefined || !Number.isFinite(z)) return st;
  if (z <= h.zAlarm) return 'alarm';
  if (st === 'normal') return z <= h.zWatch ? 'watch' : 'normal';
  if (st === 'watch') return z > h.zBack ? 'normal' : 'watch';
  if (st === 'alarm') return z > h.zBack ? 'normal' : z > h.zWatch ? 'watch' : 'alarm';
  return st;
}
// Ход показателя по дням. trades — сделки списка от $10 млн (скор любой) с результатом, с подачи h.from: [{ day, main, r, b }],
// day — D+1. День — D+1 хотя бы с одной такой сделкой (3.1). Автомат работает с первого дня; пока sw < minW, показывается nodata.
export function healthTrace(trades, h = HEALTH) {
  const byDay = new Map();
  for (const x of trades) (byDay.get(x.day) ?? byDay.set(x.day, []).get(x.day)).push(x);
  let s = { sw: 0, sy: 0, sw2: 0 }, st = 'normal';
  return [...byDay.keys()].sort().map(d => {
    const day = healthDay(byDay.get(d).filter(x => x.main).map(x => healthY(x.r, x.b, h)), h);
    s = healthStep(s, day.W, day.ybar, h);
    st = nextStatus(st, s.z, h);
    return { d, ...day, ...s, st, s: s.sw < h.minW ? 'nodata' : st };
  });
}
// Поле morning.json → health (3.9). trades — как у healthTrace, плюс score, ex, cost (справочные строки 3.5). Нет сделок — null.
// series — последние keep дней { d, m, z, s }, changes — все смены показанного статуса { d, from, to, z }, since — день последней смены.
export function signalHealth(trades, h = HEALTH, { keep = 250 } = {}) {
  const rows = healthTrace(trades, h);
  if (!rows.length) return null;
  const last = rows.at(-1), changes = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].s !== rows[i - 1].s) changes.push({ d: rows[i].d, from: rows[i - 1].s, to: rows[i].s, z: rn(rows[i].z, 3) });
  }
  // Справочные строки (3.5): различение скором за последние spreadDays дней показателя (пока их меньше — с первого) и живые данные
  const win = new Set(rows.slice(-h.spreadDays).map(x => x.d));
  const ym = [], yr = [];
  for (const x of trades) if (win.has(x.day)) (x.main ? ym : yr).push(healthY(x.r, x.b, h));
  const avg = a => (a.length ? mean(a) : null);
  const sMain = avg(ym), sRest = avg(yr);
  const main = trades.filter(x => x.main);
  const sum = summarize(main);
  return {
    from: rows[0].d, asOf: last.d, n: main.length, days: rows.length,
    sw: rn(last.sw, 3), m: rn(last.m, 6), se: rn(last.se, 6), z: rn(last.z, 3), status: last.s,
    since: changes.length ? changes.at(-1).d : rows[0].d,
    thrWatch: last.se === null ? null : rn(h.mu0 + h.zWatch * last.se, 6), thrAlarm: last.se === null ? null : rn(h.mu0 + h.zAlarm * last.se, 6),
    params: { mu0: h.mu0, sig: h.sig, beta: h.beta, lo: h.lo, hi: h.hi, kcap: h.kcap, half: h.half, zWatch: h.zWatch, zAlarm: h.zAlarm, zBack: h.zBack, minW: h.minW, spreadDays: h.spreadDays },
    spread: {
      days: win.size, main: rn(sMain, 6), rest: rn(sRest, 6), diff: sMain === null || sRest === null ? null : rn(sMain - sRest, 6),
      nMain: ym.length, nRest: yr.length,
    },
    live: { n: sum.n, days: sum.days, mean: sum.iwm?.mean ?? null, net: sum.iwm?.net ?? null, tDays: sum.iwm?.tDays ?? null },
    series: rows.slice(-keep).map(x => ({ d: x.d, m: rn(x.m, 6), z: rn(x.z, 3), s: x.s })),
    changes,
  };
}

// ---------- Всплеск покупок ----------
// B_m — число разных эмитентов с прошедшими гейты покупками за месяц (по дате подачи),
// B3 — сумма трёх последних месяцев, z — отклонение B3 от среднего B3 за прошлые 36 месяцев
// (выборочное стандартное отклонение). Всплеск: z ≥ 2. Меньше 24 месяцев истории — z нет.
// Эпизоды ревизии: 2008-12, 2015-08…10, 2018-12…2019-01, 2020-03…05.
export const BREADTH = { win: 36, need: 24, zThr: 2, keep: 60 };

const monthAdd = (m, k) => {
  const [y, mo] = m.split('-').map(Number);
  const i = y * 12 + (mo - 1) + k;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};

// counts — Map 'YYYY-MM' -> число эмитентов; partialFrom — месяц, начиная с которого данные
// неполны (текущий). Возвращает { asOf, b, b3, z, mean, sd, surge, history } или null.
export function breadth(counts, { partialFrom = null, p = BREADTH } = {}) {
  const months = [...counts.keys()].sort();
  if (!months.length) return null;
  const all = [];
  for (let m = months[0]; m <= months.at(-1); m = monthAdd(m, 1)) all.push({ m, b: counts.get(m) ?? 0 });
  all.forEach((x, i) => { x.b3 = i >= 2 ? all[i].b + all[i - 1].b + all[i - 2].b : null; });
  all.forEach((x, i) => {
    x.z = null;
    if (x.b3 === null) return;
    const prior = all.slice(Math.max(0, i - p.win), i).map(y => y.b3).filter(v => v !== null);
    if (prior.length < p.need) return;
    const m = mean(prior);
    const sd = Math.sqrt(prior.reduce((s, v) => s + (v - m) ** 2, 0) / (prior.length - 1));
    x.mean = m; x.sd = sd;
    x.z = sd > 0 ? (x.b3 - m) / sd : null;
  });
  const done = all.filter(x => !partialFrom || x.m < partialFrom);
  const last = done.at(-1);
  if (!last) return null;
  return {
    asOf: last.m, b: last.b, b3: last.b3,
    z: last.z === null ? null : rnd(last.z, 2),
    mean: last.mean === undefined ? null : rnd(last.mean, 1),
    sd: last.sd === undefined ? null : rnd(last.sd, 1),
    surge: last.z !== null && last.z >= p.zThr,
    thr: p.zThr,
    history: all.slice(-p.keep).map(x => ({
      m: x.m, b: x.b, b3: x.b3, z: x.z === null ? null : rnd(x.z, 2),
      ...(partialFrom && x.m >= partialFrom ? { p: 1 } : {}),
    })),
  };
}

// Сверка основных списков двух сборок одного дня (VPS и полный пересчёт на GitHub): состав и скор. a — «было» (VPS), b — «стало» (GitHub).
// Бумаги вне основного списка (скор 0–1) не сравниваются: на письмо они не влияют. diff — по убыванию скора; was/now — скор или null (нет в списке).
export function compareMain(a, b) {
  const ma = new Map((a ?? []).filter(x => x.main).map(x => [x.t, x])), mb = new Map((b ?? []).filter(x => x.main).map(x => [x.t, x]));
  const diff = [];
  for (const [t, x] of mb) {
    const y = ma.get(t);
    if (!y || y.score !== x.score) diff.push({ t, name: x.name, was: y ? y.score : null, now: x.score, val: x.val });
  }
  for (const [t, y] of ma) if (!mb.has(t)) diff.push({ t, name: y.name, was: y.score, now: null, val: y.val });
  diff.sort((p, q) => (q.now ?? q.was) - (p.now ?? p.was) || q.val - p.val || (p.t < q.t ? -1 : 1));
  return { same: diff.length === 0, diff, vps: ma.size, github: mb.size };
}
