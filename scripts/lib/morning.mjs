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
};

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
//   { cik, t, name, who, role, officer, val, dd, adv, px, at, drop }, drop — причина отсева гейтами (null — прошла).
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
    });
  }
  out.sort((a, b) => b.score - a.score || b.val - a.val || (a.t < b.t ? -1 : 1));
  return { rows: out, unpriced };
}
export const buildDay = (rows, p = MORNING) => buildDayFull(rows, p).rows;

// Результат одной сделки. entry/iwm/spy — [открытие, закрытие, вчерашнее закрытие] из одного
// ответа источника (lib/opens.mjs). Пропуск — это причина, а не ноль: пропущенная сделка не
// должна ни улучшать, ни портить счётчик. Результат считается сразу к IWM (ex) и к SPY (exS):
// в живом периоде разница между ними доходит до половины перевеса (IWM внутри дня отстаёт от S&P).
export function tradeResult(entry, iwm, spy, p = MORNING) {
  if (!entry || !(entry[0] > 0)) return { skip: 'noopen' };
  if (!(entry[1] > 0)) return { skip: 'noclose' };
  if (entry[2] !== null && entry[2] !== undefined && entry[0] === entry[2]) return { skip: 'frozen' };
  if (entry[0] < p.minPx) return { skip: 'px' };
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
