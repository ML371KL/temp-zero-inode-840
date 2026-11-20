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
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const MODES = ['off', 'shadow', 'on'];
const EPS = 2e-5;                              // бот округляет доли до 1e-6; сверка сумм — с запасом на округление

const isInt = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
const isFrac = (v, max) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;
const fracOrNull = (v, max) => v === null || isFrac(v, max);
const isDate = v => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v));

// Группа сделок: число, среднее на сделку (доля) и сумма долей. Пустая группа — net = null; сумма пустой группы может
// быть не нулём только у основного правила и итога (дни, когда хедж был, а сделок не было: loose = true).
function cleanGroup(g, loose = false) {
  if (!g || typeof g !== 'object' || !isInt(g.n, 1e5) || !fracOrNull(g.net, 1) || !isFrac(g.sum, 1e3)) return null;
  if ((g.n === 0) !== (g.net === null)) return null;
  if (g.n === 0 ? !loose && g.sum !== 0 : Math.abs(g.sum - g.n * g.net) > EPS * (g.n + 1)) return null;
  return { n: g.n, net: g.net, sum: g.sum };
}

// Сводка бота → объект только из известных полей, либо null (с причиной в why.text), если хоть одно поле не того вида
// или числа не сходятся между собой. Проверяется всё: частично верная сводка не показывается. Исключений не бросает.
export function cleanBotSplit(raw, why = {}) {
  const fail = text => { why.text = text; return null; };
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('не объект');
    if (raw.v !== BOT_SPLIT_VERSION) return fail('версия не ' + BOT_SPLIT_VERSION);
    if (raw.stage !== 'live') return fail('этап не live');
    if (typeof raw.built !== 'string' || !ISO_TIME.test(raw.built) || Number.isNaN(Date.parse(raw.built))) return fail('нет built');
    if (!isInt(raw.days, 1e4)) return fail('days');
    for (const k of ['since', 'upTo']) if (!(isDate(raw[k]) || (raw.days === 0 && raw[k] === null))) return fail(k);
    if (raw.days > 0 && raw.since > raw.upTo) return fail('since позже upTo');
    if (!isInt(raw.ruleScore, 4) || raw.ruleScore < 2) return fail('ruleScore');
    const main = cleanGroup(raw.main, true), total = cleanGroup(raw.total, true);
    if (!main || !isInt(raw.main.days, raw.days) || !fracOrNull(raw.main.stock, 1) || !fracOrNull(raw.main.hedge, 1)) return fail('main');
    if ((main.n === 0) !== (raw.main.stock === null) || (main.n === 0) !== (raw.main.hedge === null)) return fail('main');
    if (!total) return fail('total');
    const b = raw.b;
    if (!b || typeof b !== 'object' || Array.isArray(b) || !MODES.includes(b.mode) || typeof b.stopped !== 'boolean') return fail('b');
    for (const k of ['signals', 'would', 'orders', 'filled']) if (!isInt(b[k], 1e6)) return fail('b.' + k);
    if (b.filled > b.orders || b.would > b.signals) return fail('b: исполнено больше поставленного');
    if (!fracOrNull(b.slip, 0.2)) return fail('b.slip');
    if (!(b.delay === null || (typeof b.delay === 'number' && b.delay >= 0 && b.delay <= 3600))) return fail('b.delay');
    const rule = cleanGroup(b.rule), trial = cleanGroup(b.trial);
    if (!rule || !trial) return fail('b.rule / b.trial');
    if (total.n !== main.n + rule.n + trial.n) return fail('total.n не сумма групп');
    if (Math.abs(total.sum - (main.sum + rule.sum + trial.sum)) > EPS * (total.n + 3)) return fail('total.sum не сумма групп');
    return {
      v: BOT_SPLIT_VERSION, built: new Date(raw.built).toISOString(), stage: 'live',
      since: raw.since ?? null, upTo: raw.upTo ?? null, days: raw.days, ruleScore: raw.ruleScore,
      main: { ...main, days: raw.main.days, stock: raw.main.stock, hedge: raw.main.hedge },
      b: { mode: b.mode, stopped: b.stopped, signals: b.signals, would: b.would, orders: b.orders, filled: b.filled,
        slip: b.slip, delay: b.delay, rule, trial },
      total,
    };
  } catch (e) {
    return fail('сводка не разобрана: ' + (e?.message ?? e));
  }
}

// Не устарела ли сводка: бот пишет её каждый торговый день. Сводка «из будущего» (часы или порча) свежей не считается.
export function botSplitFresh(clean, nowMs) {
  if (!clean) return false;
  const age = nowMs - Date.parse(clean.built);
  return age <= BOT_SPLIT_MAX_AGE_DAYS * 86400e3 && age >= -86400e3;
}

// Из нескольких списков (страница, воркер) — самая свежая годная сводка либо null
export function pickBotSplit(lists, nowMs) {
  return (Array.isArray(lists) ? lists : []).map(m => cleanBotSplit(m?.bot)).filter(b => botSplitFresh(b, nowMs))
    .sort((a, b) => b.built.localeCompare(a.built))[0] ?? null;
}

// Строки блока. Строка без сделок несёт text — что написать вместо чисел. Итог в деньгах — sum × stake: «если в каждую
// сделку вложено по stake», как у живого счётчика панели; размеры позиций бота у контуров разные и сюда не входят.
export function botRows(bot, stake) {
  const money = g => (g.n || g.sum ? g.sum * stake : null);
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
    : b.trial.n ? `по правилу (скор от ${bot.ruleScore}) сделок пока нет`
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

// Строка под таблицей: исполнение контура (когда он ставил заявки) и его нынешнее состояние, если при сделках в таблице
// контур сейчас не работает
export function botExecLine(bot) {
  const b = bot.b, parts = [];
  if (b.rule.n) {
    if (b.stopped) parts.push('сейчас остановлен живой проверкой');
    else if (b.mode === 'off') parts.push('сейчас выключен');
    else if (b.mode === 'shadow') parts.push('сейчас в тени, заявок не ставит');
  }
  if (b.orders) {
    parts.push(`исполнено заявок ${b.filled} из ${b.orders}`);
    if (b.slip !== null) parts.push(`исполнение к цене продавца ${pct(b.slip, 3)}`);
    if (b.delay !== null) parts.push(`от приёма формы до заявки — медиана ${Math.round(b.delay)} с`);
  }
  return parts.length ? 'Контур B: ' + parts.join(' · ') : '';
}

// Разметка блока. Форматтеры страницы (esc, cls, fmtDate, fmtPct, fmtMoney, sgnMoney, plural) и адрес руководства
// приходят снаружи: модуль не тянет web/charts.js на сервер, а самотест исполняет разметку без браузера.
export function botBlockHtml(bot, stake, f) {
  const head = '<div class="strip-head"><b>Бот: что дал каждый контур</b>'
    + (bot.days ? ` с ${f.esc(f.fmtDate(bot.since))} · по ${f.esc(f.fmtDate(bot.upTo))} · ${f.esc(f.plural(bot.days, 'живой день', 'живых дня', 'живых дней'))}` : ' · живых дней пока нет')
    + ` · факт счёта, после комиссий · <a href="${f.esc(f.guideUrl)}#бот-что-дал-каждый-контур" target="_blank" rel="noopener">как считается</a></div>`;
  const row = r => `<tr${r.key === 'total' ? ' class="sum"' : ''}><td class="lab" title="${f.esc(r.hint)}">${f.esc(r.label)}</td>`
    + (r.text !== null
      ? (r.money === null ? `<td class="note" colspan="3">${f.esc(r.text)}</td>`
        : `<td class="note" colspan="2">${f.esc(r.text)}</td><td class="${f.cls(r.money)}">${f.esc(f.sgnMoney(r.money))}</td>`)
      : `<td>${Number(r.n)}</td><td class="${f.cls(r.net)}">${f.esc(f.fmtPct(r.net, 2))}</td><td class="${f.cls(r.money)}">${f.esc(f.sgnMoney(r.money))}</td>`)
    + '</tr>';
  const exec = botExecLine(bot);
  const moneyHint = `Итог всех сделок строки, если в каждую вложено по ${f.fmtMoney(stake)} — мера вклада, а не прибыль счёта: размер позиций бота у контуров разный и сюда не входит`;
  return head + '<table class="strip-t bot-t"><tr><th></th><th title="Закрытые сделки живого счёта">сделок</th>'
    + '<th title="Средний результат сделки после комиссий, в долях суммы сделки">на сделку</th>'
    + `<th title="${f.esc(moneyHint)}">на ${f.esc(f.fmtMoney(stake))} в сделке</th></tr>`
    + botRows(bot, stake).map(row).join('') + '</table>'
    + (exec ? `<div class="strip-empty">${f.esc(exec)}</div>` : '');
}

function pct(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + (v * 100).toFixed(digits) + '%';
}
