// «Утренний список»: покупки инсайдеров по подачам одного дня, которые имеет смысл купить на
// открытии следующего торгового дня (D+1) и продать на его закрытии. Чистые функции без
// ввода-вывода: сборка (compute.mjs) подаёт им строки и открытия, самотесты — синтетику.
//
// Почему так, а не набор «у максимума, 3 мес.»: сигнал покупки инсайдера отыгрывается за
// полтора дня вокруг подачи, и торгуема только часть после неё (ревизия 04.11.2026,
// docs/ЧТО-РАБОТАЕТ.md). Результат меряется от ОТКРЫТИЯ D+1 до ЗАКРЫТИЯ того же дня, фиксированной
// суммой на сделку, одна сделка на бумагу в день, за вычетом внутридневной доходности IWM.

export const MORNING = {
  minVal: 1e4,          // сумма покупки (строки), $
  minPx: 5,             // последнее закрытие на дату подачи / открытие D+1, $
  dvMain: 3e7,          // главный уровень: медианный дневной оборот, $
  dvWide: 1e7,          // широкий уровень (в файле с пометкой lvl:10)
  cost: 0.001,          // издержки на круг, доля
  liveFrom: '2026-11-05',   // списки с этой даты подачи идут в живой счётчик
  daysShown: 10,        // сколько последних дней подачи отдаёт файл витрине
  bigVal: 1e6,
  deepDd: -0.3,
};

// Лучшая роль: офицеры (C, F, O) сильнее директоров (+0,32% против +0,17% в ревизии).
const ROLE_RANK = { C: 0, F: 1, O: 2, D: 3, T: 4, X: 5 };
export const bestRole = roles => [...roles].filter(Boolean).sort((a, b) => (ROLE_RANK[a] ?? 9) - (ROLE_RANK[b] ?? 9))[0] ?? 'X';
export const isOfficer = role => role === 'C' || role === 'F' || role === 'O';

// Пометки — коды; подписи живут на витрине и в сообщении.
export function tagsOf({ role, dd, val }, p = MORNING) {
  const t = [];
  if (isOfficer(role)) t.push('off');
  if (dd !== null && dd !== undefined && dd < p.deepDd) t.push('deep');
  if (val >= p.bigVal) t.push('big');
  return t;
}

const rnd = (v, k = 4) => Math.round(v * 10 ** k) / 10 ** k;

// rows — покупки ОДНОГО дня подачи: { t, name, who, role, val, dd, dv, px, drop }.
// Отбор по строкам (прошла гейты, сумма, цена, оборот), затем одна строка на бумагу:
// сумма покупок дня, лучшая роль, показатели — по самой крупной покупке. Сортировка по сумме.
export function buildDay(rows, p = MORNING) {
  const byT = new Map();
  for (const r of rows) {
    if (r.drop) continue;
    if (!(r.val >= p.minVal)) continue;
    if (!(r.px >= p.minPx)) continue;
    if (!(r.dv >= p.dvWide)) continue;
    (byT.get(r.t) ?? byT.set(r.t, []).get(r.t)).push(r);
  }
  const out = [];
  for (const [t, list] of byT) {
    list.sort((a, b) => b.val - a.val);
    const lead = list[0];
    const val = list.reduce((s, x) => s + x.val, 0);
    const role = bestRole(list.map(x => x.role));
    const who = [...new Set(list.flatMap(x => x.who ?? []))];
    out.push({
      t, name: lead.name, who, role, val: Math.round(val), n: list.length,
      dd: lead.dd ?? null, dv: lead.dv, px: lead.px,
      lvl: lead.dv >= p.dvMain ? 30 : 10,
      tags: tagsOf({ role, dd: lead.dd ?? null, val }, p),
    });
  }
  return out.sort((a, b) => b.val - a.val || (a.t < b.t ? -1 : 1));
}

// Результат одной сделки. entry/bench — [открытие, закрытие, вчерашнее закрытие] из одного
// ответа источника (lib/opens.mjs). Пропуск — это причина, а не ноль: пропущенная сделка не
// должна ни улучшать, ни портить счётчик.
export function tradeResult(entry, bench, p = MORNING) {
  if (!entry || !(entry[0] > 0)) return { skip: 'noopen' };
  if (!(entry[1] > 0)) return { skip: 'noclose' };
  if (entry[2] !== null && entry[2] !== undefined && entry[0] === entry[2]) return { skip: 'frozen' };
  if (entry[0] < p.minPx) return { skip: 'px' };
  if (!bench || !(bench[0] > 0) || !(bench[1] > 0)) return { skip: 'nobench' };
  const r = entry[1] / entry[0] - 1;
  const b = bench[1] / bench[0] - 1;
  return { o: entry[0], c: entry[1], r: rnd(r), b: rnd(b), ex: rnd(r - b) };
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const median = a => {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

// trades — [{ day, ex }] (day — день D+1). t по дням: сначала среднее за каждый день, затем
// t-статистика среднего этих средних — сделки одного дня не независимы (общий рынок).
export function summarize(trades, p = MORNING) {
  const n = trades.length;
  if (!n) return { n: 0, days: 0 };
  const ex = trades.map(x => x.ex);
  const byDay = new Map();
  for (const x of trades) (byDay.get(x.day) ?? byDay.set(x.day, []).get(x.day)).push(x.ex);
  const dm = [...byDay.values()].map(mean);
  let tDays = null;
  if (dm.length >= 2) {
    const m = mean(dm);
    const sd = Math.sqrt(dm.reduce((s, x) => s + (x - m) ** 2, 0) / (dm.length - 1));
    if (sd > 0) tDays = rnd(m / (sd / Math.sqrt(dm.length)), 2);
  }
  const avg = mean(ex);
  return {
    n, days: byDay.size,
    mean: rnd(avg), median: rnd(median(ex)),
    win: rnd(ex.filter(x => x > 0).length / n, 3),
    tDays,
    net: rnd(avg - p.cost),
    cumNet: rnd(ex.reduce((s, x) => s + x - p.cost, 0)),
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
