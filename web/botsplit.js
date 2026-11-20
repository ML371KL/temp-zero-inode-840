// Блок «Бот: что дал каждый контур» — сводка живого счёта бота ib840 раздельно по основному правилу и контуру B.
// Числа считает бот (ib840 public-split → /var/lib/ib840-public/split.json): результат контура зависит от цены входа
// внутри дня, по дневным барам панель его не посчитает. Ночная сборка списка на VPS прикладывает сводку к списку
// (scripts/lib/botsplit.mjs), страница берёт её из ответа воркера /morning.
// Один модуль на сборку и страницу (как web/calendar.js): на страницу попадает только web/*, поэтому он лежит здесь и
// ничего не импортирует. Страница публичная — сводка проходит белый список: наружу идут только перечисленные здесь поля,
// только числа, даты и режим контура. Сумм счёта, тикеров и номеров в ней нет и появиться не может.

export const BOT_SPLIT_VERSION = 1;
export const BOT_SPLIT_MAX_AGE_DAYS = 10;      // сводка старше — бот её больше не пишет: блок не показывается
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MODES = ['off', 'shadow', 'on'];

const isInt = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
const isFrac = (v, max) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;
const fracOrNull = (v, max) => v === null || isFrac(v, max);

// Группа сделок: число, среднее нетто на сделку (доля) и сумма долей. Пустая группа — net = null.
function cleanGroup(g) {
  if (!g || typeof g !== 'object' || !isInt(g.n, 1e5) || !fracOrNull(g.net, 1) || !isFrac(g.sum, 1e3)) return null;
  if ((g.n === 0) !== (g.net === null)) return null;
  return { n: g.n, net: g.net, sum: g.sum };
}

// Сводка бота → объект только из известных полей, либо null (с причиной в why.text), если хоть одно поле не того вида.
// Проверяется всё: частично верная сводка не показывается.
export function cleanBotSplit(raw, why = {}) {
  const fail = text => { why.text = text; return null; };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('не объект');
  if (raw.v !== BOT_SPLIT_VERSION) return fail('версия не ' + BOT_SPLIT_VERSION);
  if (raw.stage !== 'live') return fail('этап не live');
  if (typeof raw.built !== 'string' || Number.isNaN(Date.parse(raw.built))) return fail('нет built');
  if (!isInt(raw.days, 1e4)) return fail('days');
  for (const k of ['since', 'upTo']) {
    if (raw.days === 0 ? raw[k] !== null && !ISO_DATE.test(raw[k] ?? '') : !ISO_DATE.test(raw[k] ?? '')) return fail(k);
  }
  if (!isInt(raw.ruleScore, 4) || raw.ruleScore < 2) return fail('ruleScore');
  const main = cleanGroup(raw.main), total = cleanGroup(raw.total);
  if (!main || !isInt(raw.main.days, 1e4) || !fracOrNull(raw.main.stock, 1) || !fracOrNull(raw.main.hedge, 1)) return fail('main');
  if (!total) return fail('total');
  const b = raw.b;
  if (!b || typeof b !== 'object' || !MODES.includes(b.mode) || typeof b.stopped !== 'boolean') return fail('b');
  for (const k of ['signals', 'would', 'orders', 'filled']) if (!isInt(b[k], 1e6)) return fail('b.' + k);
  if (!fracOrNull(b.slip, 0.2)) return fail('b.slip');
  if (!(b.delay === null || (typeof b.delay === 'number' && b.delay >= 0 && b.delay <= 3600))) return fail('b.delay');
  const rule = cleanGroup(b.rule), trial = cleanGroup(b.trial);
  if (!rule || !trial) return fail('b.rule / b.trial');
  if (total.n !== main.n + rule.n + trial.n) return fail('total.n не сумма групп');
  return {
    v: BOT_SPLIT_VERSION, built: new Date(raw.built).toISOString(), stage: 'live',
    since: raw.since ?? null, upTo: raw.upTo ?? null, days: raw.days, ruleScore: raw.ruleScore,
    main: { ...main, days: raw.main.days, stock: raw.main.stock, hedge: raw.main.hedge },
    b: { mode: b.mode, stopped: b.stopped, signals: b.signals, would: b.would, orders: b.orders, filled: b.filled,
      slip: b.slip, delay: b.delay, rule, trial },
    total,
  };
}

// Не устарела ли сводка: бот пишет её каждый торговый день
export function botSplitFresh(clean, nowMs) {
  return !!clean && nowMs - Date.parse(clean.built) <= BOT_SPLIT_MAX_AGE_DAYS * 86400e3;
}

// Из нескольких списков (страница, воркер) — самая свежая годная сводка либо null
export function pickBotSplit(lists, nowMs) {
  return (lists ?? []).map(m => cleanBotSplit(m?.bot)).filter(b => botSplitFresh(b, nowMs))
    .sort((a, b) => b.built.localeCompare(a.built))[0] ?? null;
}

// Строки блока. Строка с n = 0 несёт text — что написать вместо чисел. Итог в деньгах — sum × stake: «если в каждую
// сделку вложено по stake», как у живого счётчика панели; размеры позиций бота у контуров разные и сюда не входят.
export function botRows(bot, stake) {
  const money = g => (g.n ? g.sum * stake : null);
  const b = bot.b;
  const rows = [{
    key: 'main', label: 'Основное правило', n: bot.main.n, net: bot.main.net, money: money(bot.main),
    text: bot.main.n ? null : 'сделок пока нет',
    hint: 'Вход на аукционе открытия, выход на закрытии, шорт IWM на сумму покупок. На сделку: результат акции после комиссий'
      + (bot.main.n ? ` (${pct(bot.main.stock)})` : '') + ' плюс доля ноги хеджа того же дня'
      + (bot.main.n ? ` (${pct(bot.main.hedge)})` : ''),
  }];
  const idle = b.stopped ? 'остановлен живой проверкой'
    : b.mode === 'off' ? 'выключен'
    : b.mode === 'shadow' ? `в тени, заявок не ставит: сигналов ${b.signals}, к заявке ${b.would}`
    : 'сделок пока нет';
  rows.push({
    key: 'rule', label: 'Контур B', n: b.rule.n, net: b.rule.net, money: money(b.rule), text: b.rule.n ? null : idle,
    hint: `Вход в торговые часы по форме, принятой SEC днём, скор от ${bot.ruleScore}; покупка по цене продавца, выход на закрытии, без хеджа`,
  });
  if (b.trial.n) {
    rows.push({
      key: 'trial', label: 'Контур B · приёмка', n: b.trial.n, net: b.trial.net, money: money(b.trial), text: null,
      hint: `Сделки со скором ниже ${bot.ruleScore}: их пускали на время приёмки ради проверки механики, правило по ним не судят`,
    });
  }
  rows.push({
    key: 'total', label: 'Итого', n: bot.total.n, net: bot.total.net, money: money(bot.total),
    text: bot.total.n ? null : 'сделок пока нет', hint: 'Все сделки бота вместе',
  });
  return rows;
}

// Строка об исполнении контура: показывается, когда контур ставил заявки
export function botExecLine(bot) {
  const b = bot.b;
  if (!b.orders) return '';
  return `Контур B: исполнено заявок ${b.filled} из ${b.orders}`
    + (b.slip === null ? '' : ` · исполнение к цене продавца ${pct(b.slip, 3)}`)
    + (b.delay === null ? '' : ` · от приёма формы до заявки — медиана ${Math.round(b.delay)} с`);
}

function pct(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + (v * 100).toFixed(digits) + '%';
}
