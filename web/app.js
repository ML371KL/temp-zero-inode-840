// Инсайдерский радар — логика интерфейса. ES-модуль, без зависимостей.
import { PriceChart, fmtPrice, fmtInt, fmtMoney, fmtPct, fmtDate } from './charts.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const trunc = (s, n) => String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? '');
const cls = v => v === null || v === undefined ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '';

const ROLE_LABEL = { F: 'CFO', C: 'CEO/През', O: 'Офицер', D: 'Директор', T: '10%', X: 'Прочее' };
// Признаки в Ленте обозначаются одно-двухбуквенными кодами, чтобы таблица не требовала
// горизонтальной прокрутки. Расшифровка — в легенде под фильтрами и в подсказке каждой метки.
// Формат: код -> [название, пояснение, стиль метки]. Коды не должны повторяться —
// проверяется самотестом (scripts/selftest.mjs, «легенда признаков без коллизий»).
export const FEAT = {
  // Число здесь обязано совпадать с SET_MAX_DD в scripts/compute.mjs — за этим следит
  // инвариант в scripts/selftest.mjs: легенда, разошедшаяся с правилом, хуже её отсутствия.
  // Метка нейтральная: набор «у максимума, 3 мес.» на ревизии 04.11.2026 альфы не дал.
  high:          ['М',  'У максимума', 'Акция не более чем на 7% ниже 52-недельного максимума: инсайдер платит высокую цену. Фильтр ленты, не рекомендация', 'gray'],
  'first-ever':  ['1',  'Первая покупка', 'Первая покупка этого инсайдера в наших данных. Лучше сопоставимых бумаг, но индекс не обгоняет', 'gray'],
  // Помечен нейтрально сознательно: на проверке вне выборки признак дал отрицательный
  // эффект (−2.4%) и в скоринг v3 не вошёл — зелёная метка вводила бы в заблуждение
  'first-in-3y': ['3г', 'Не покупал 3 года', 'Первая покупка за три года. Предсказательной силы не показала — метка справочная', 'gray'],
  pledge:        ['З',  'Залог', 'Акции инсайдера в залоге — риск принудительной продажи', 'gray'],
  trust:         ['Т',  'Траст', 'Покупка через траст или на супруга — деньги того же инсайдера', 'gray'],
  indirect:      ['Кс', 'Косвенное владение', 'Бумаги записаны не напрямую на инсайдера', 'gray'],
  'no-history':  ['Ни', 'Нет истории', 'Истории сделок меньше трёх лет — рутинность по CMP не определена', 'gray'],
  'no-price':    ['Нц', 'Нет котировок', 'Ценовые проверки (дисконт, единицы, старт торгов) провести было не на чем', 'gray'],
  // Единственный признак не из tags: гейты роняют плановую ПОКУПКУ раньше, чем доходят до
  // тегов, поэтому в Ленте кода «Пл» не бывает. Метку ставит карточка тикера по полю b5 —
  // там же и плановые продажи, у которых причины отсева нет вовсе (гейты считают покупки).
  'planned-mark': ['Пл', 'План 10b5-1', 'Сделка по заранее принятому плану — малоинформативна', 'warn'],
};
// Причины отсева — те же короткие коды; расшифровки берутся из meta.gates.labels
export const DROP_CODE = {
  offering: 'Рз', discount: 'Дк', sync: 'Сн', fund: 'Фн', planned: 'Пл', routine: 'Рт',
  regular: 'Рг', drip: 'Др', espp: 'Эс', forced: 'Пр', outlier: 'Вб', newlisting: 'Ст',
  noliq: 'Об', security: 'Пф', units: 'Ед', cancelled: 'Ан', capacity: 'Ём',
  // Порча данных, а не свойство сделки: тикер успел перейти к другой компании,
  // либо в форме стоят невозможные число акций или цена
  reassigned: 'Чж', badvalue: 'Нв',
};

// ---------- Тема ----------
// Тема уже стоит: её ставит ранний скрипт из <head>, вместе с вечерним правилом
// (с 20:00 до 07:00 — тёмная). Здесь только переключатель.
$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = cur;
  // Вечером выбор живёт до закрытия вкладки и не трогает постоянную память: иначе
  // один вечер сделал бы тёмную «последней темой» навсегда.
  if (window.__theme.remember(cur)) localStorage.setItem('ir-theme', cur);
  if (state.chart && state.tickerData) renderChart();
});

// ---------- Состояние ----------
const state = {
  feed: null, stats: null, meta: null,
  tickersIndex: null, tickerData: null, chart: null, feedShown: 100, sort: null,
  morning: null,       // morning.json: списки последних дней подачи и живой счётчик
};
async function fetchJson(path) {
  const res = await fetch('data/' + path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(path + ': HTTP ' + res.status);
  return res.json();
}

// ---------- Роутинг ----------
const tabs = document.querySelectorAll('.tabs a');
const TABS = ['morning', 'feed', 'ticker', 'stats'];
function route() {
  const hash = location.hash || '#morning';
  let [tab, arg] = hash.slice(1).split('/');
  if (tab === 'screener') tab = 'morning';                          // старые ссылки на «Скринер»
  if (!TABS.includes(tab)) { tab = 'morning'; arg = undefined; }  // неизвестный якорь — не белый экран
  for (const a of tabs) a.classList.toggle('active', a.dataset.tab === tab);
  for (const p of document.querySelectorAll('.tab-panel')) p.classList.toggle('active', p.id === 'tab-' + tab);
  if (tab === 'morning') loadMorning();
  if (tab === 'feed') loadFeed(arg);
  if (tab === 'stats') loadStats();
  if (tab === 'ticker') { loadTickerIndex(); if (arg) openTicker(decodeURIComponent(arg)); }
}
addEventListener('hashchange', route);

// ---------- Шапка ----------
(async () => {
  try {
    const m = state.meta = await fetchJson('meta.json');
    const okPct = m.trades?.buys ? Math.round(m.gates.ok / m.trades.buys * 100) : 0;
    $('#meta-badges').innerHTML = [
      `<span class="badge">EDGAR до <b>${esc(m.liveLastDay ?? '—')}</b></span>`,
      `<span class="badge">цены <b>${esc(m.pricesUpdated ?? '—')}</b></span>`,
      `<span class="badge" title="Покупок всего / прошли фильтры информативности">покупок <b>${fmtInt(m.trades?.buys)}</b> → <b>${fmtInt(m.gates?.ok)}</b> (${okPct}%)</span>`,
      m.universe?.noPrices > 200 ? `<span class="badge warn" title="Эмитенты без ценовых данных не входят в бэктест — остаточная ошибка выжившего">без цен: ${fmtInt(m.universe.noPrices)}</span>` : '',
    ].join('');
  } catch { $('#meta-badges').innerHTML = '<span class="badge warn">meta.json недоступен — данные ещё собираются</span>'; }
  checkStale();
  route();
})();

// Баннер устаревания рисуется на клиенте намеренно: если сломался сборочный цикл,
// он же и не сможет сообщить о своей поломке — а страница покажет это при любом сбое.
function checkStale() {
  const last = state.meta?.liveLastDay;
  if (!last) return;
  // Считаем ПРОПУЩЕННЫЕ рабочие дни: строго между последним обработанным и сегодня.
  // Сегодняшний день не в счёт — его индекс выходит только вечером (22:02 ET).
  const todayIso = new Date().toISOString().slice(0, 10);
  const d = new Date(last + 'T00:00:00Z');
  let gap = 0;
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.toISOString().slice(0, 10) < todayIso) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) gap++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  if (gap < 2) return;   // 0 — норма, 1 — праздник или прогон ещё не отработал
  const bar = document.createElement('div');
  bar.className = 'stale-bar';
  bar.innerHTML = `⚠ Данные EDGAR устарели: последний обработанный день — <b>${esc(last)}</b> ` +
    `(пропущено рабочих дней: ${gap}). Обновление не отработало — проверьте ` +
    `<a href="https://github.com/ML371KL/temp-zero-inode-840/actions" target="_blank" rel="noopener">журнал сборок</a>.`;
  document.body.prepend(bar);
}

// ---------- Общие компоненты ----------
// Сортировка по трём состояниям: убывание → возрастание → исходный порядок.
// Направление показывается стрелкой в заголовке.
function bindSort(sel, rerender) {
  for (const h of document.querySelectorAll(sel + ' th.sortable')) {
    const key = h.dataset.sort;
    if (state.sort?.[0] === key) {
      h.innerHTML = h.innerHTML.replace('⇅', state.sort[1] === -1 ? '↓' : '↑');
      h.classList.add('sorted');
    }
    h.addEventListener('click', () => {
      if (state.sort?.[0] !== key) state.sort = [key, -1];
      else if (state.sort[1] === -1) state.sort = [key, 1];
      else state.sort = null;
      rerender(true);
    });
  }
}
function sortRows(rows) {
  if (!state.sort) return rows;
  const [key, dir] = state.sort;
  return [...rows].sort((a, b) => ((a[key] ?? -1e18) - (b[key] ?? -1e18)) * dir);
}
// Метка признака по коду из FEAT
function featPill(key) {
  const f = FEAT[key];
  if (!f) return '';
  const [code, name, why, style] = f;
  return `<span class="pill ${style} feat" title="${esc(name + ' — ' + why)}">${esc(code)}</span>`;
}
// Полный набор признаков строки ленты в компактном виде
function featureCell(r) {
  const out = [];
  if (r.drop) {
    const code = DROP_CODE[r.drop] ?? r.drop.slice(0, 2);
    out.push(`<span class="pill warn feat" title="${esc('Отсеяна: ' + dropLabel(r.drop))}">${esc(code)}</span>`);
  }
  // Порог берётся из правила набора, а не зашивается: метка «у максимума» обещает читателю
  // ровно то условие, по которому сделка попадает в набор, и разъехаться с ним не может.
  if (r.dd !== null && r.dd >= (state.stats?.setDef?.maxDd ?? -0.07)) out.push(featPill('high'));
  if (r.inflect) out.push(featPill(r.inflect));
  for (const t of r.tags ?? []) out.push(featPill(t));
  return out.join(' ');
}
// Легенда собирается из тех же таблиц, что и метки, поэтому не может с ними разойтись.
// Но таблиц две, и рисуют они РАЗНЫЕ наборы: Лента — ценовой контекст, инфлексию и теги
// гейтов (featureCell), карточка тикера — плановость и косвенность (renderTickerTrades).
// Общий список обещал бы каждой из них чужие метки. Особенно «Пл»: в Ленте её не бывает
// вовсе — плановые сделки уходят в drop('planned') до блока с tags.push (lib/gates.mjs),
// и код «Пл» там означает причину отсева, а не признак сделки.
const FEAT_LEGEND = {
  // Названия групп честные: «сигнальным» осталось одно условие набора, остальное —
  // описание сделки, у которого предсказательной силы не нашлось
  'tab-feed': [
    ['Ценовой контекст и поведение:', ['high', 'first-ever', 'first-in-3y']],
    ['Описание сделки:', ['pledge', 'trust', 'indirect', 'no-history', 'no-price']],
  ],
  'tab-ticker': [
    ['Описание сделки:', ['planned-mark', 'indirect']],
  ],
};
function renderFeatLegend() {
  const boxes = document.querySelectorAll('.feat-legend');
  if (!boxes.length) return;
  const group = (title, items) => `<div class="legend-group"><b>${esc(title)}</b>${items.map(([code, name, why, style]) =>
    `<span class="legend-item" title="${esc(why)}"><i class="pill ${style ?? 'gray'} feat">${esc(code)}</i>${esc(name)}</span>`).join('')}</div>`;
  const labels = state.meta?.gates?.labels ?? {};
  const drops = Object.entries(DROP_CODE)
    .filter(([k]) => labels[k])
    .map(([k, code]) => [code, labels[k], labels[k], 'warn']);
  for (const b of boxes) {
    if (b.dataset.done === '1') continue;
    const groups = FEAT_LEGEND[b.closest('.tab-panel')?.id];
    if (!groups) continue;
    // Отсеянные строки в Ленте показываются по выбору фильтра, в карточке тикера — всегда
    const dropTitle = groups === FEAT_LEGEND['tab-feed']
      ? 'Причины отсева (видны при показе отсеянных):' : 'Причины отсева:';
    b.innerHTML = groups.map(([title, keys]) => group(title, keys.map(k => FEAT[k]))).join('') +
      (drops.length ? group(dropTitle, drops) : '');
    b.dataset.done = '1';
  }
}

// ---------- УТРЕННИЙ СПИСОК ----------
// Главный экран. Покупки инсайдеров по подачам одного дня: покупка на открытии следующего
// торгового дня (D+1), продажа на закрытии того же дня. Всё, что показано, считает сборка
// (scripts/compute.mjs -> morning.json, stats.breadth); страница только раскладывает и ни одной
// цифры о результатах не хранит.
// Русское склонение после числа: 1 бумага, 2-4 бумаги, 5+ бумаг (и 11-14 — бумаг).
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return n + ' ' + (a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many);
};
// Пометки строки: код из сборки -> [подпись, стиль, подсказка]
export const MTAG = {
  off:  ['офицер', 'buy', 'CEO, CFO или другой офицер: у офицеров эффект сильнее, чем у директоров'],
  deep: ['просадка >30%', 'warn', 'На дату сделки бумага ниже 52-недельного максимума больше чем на 30%'],
  big:  ['≥$1 млн', 'gray', 'Покупки дня на сумму от $1 млн: чем крупнее сумма, тем сильнее эффект'],
};
const SKIP = {
  noopen: 'нет открытия — сделка пропущена', noclose: 'нет закрытия — сделка пропущена', nobench: 'нет данных по IWM — сделка пропущена',
  frozen: 'открытие ровно равно вчерашнему закрытию — котировка застыла, сделка пропущена',
  px: 'открытие ниже $5 — сделка пропущена',
};
const MONTH_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const monthRu = ym => { const [y, m] = String(ym).split('-'); return `${MONTH_NOM[Number(m) - 1] ?? ym} ${y}`; };

let mLevel = 30, mDay = null;
async function loadMorning() {
  if (!state.morning) {
    try { state.morning = await fetchJson('morning.json'); }
    catch { $('#m-table').innerHTML = '<tr><td class="empty">Данные ещё не собраны.</td></tr>'; return; }
  }
  if (!state.stats) { try { state.stats = await fetchJson('stats.json'); } catch { /* плашка всплеска появится позже */ } }
  if (mDay === null || !state.morning.days.some(d => d.date === mDay)) mDay = state.morning.days[0]?.date ?? null;
  renderMorning();
}
for (const b of document.querySelectorAll('#m-level .chip')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('#m-level .chip')) x.classList.remove('active');
    b.classList.add('active');
    mLevel = Number(b.dataset.lvl);
    if (state.morning) renderMorning();
  });
}
$('#m-day').addEventListener('change', e => { mDay = e.target.value; if (state.morning) renderMorning(); });

const lvlRows = day => (day?.rows ?? []).filter(x => mLevel === 30 ? x.lvl === 30 : true);

// Полоса живого счётчика: те же числа, что в ревизии, но по спискам, опубликованным с запуска.
// Тест по дням — сделки одного дня не независимы (общий рынок), поэтому t считается по средним дням.
function renderCounter() {
  const c = state.morning.counter, s = mLevel === 30 ? c.l30 : c.l10;
  const head = `<div class="strip-head"><b>Живой счётчик</b> с ${esc(fmtDate(c.from))} · открытие → закрытие D+1, к IWM`
    + `${c.upTo ? ' · по ' + esc(fmtDate(c.upTo)) : ''}</div>`;
  if (!s?.n) {
    $('#m-counter').innerHTML = head + '<div class="strip-empty">Сделок пока нет — первый результат появится после первого торгового дня по спискам.</div>';
    return;
  }
  const cell = (v, lab, hint, klass = '') => `<div class="sc" title="${esc(hint)}"><b class="${klass}">${v}</b><span>${esc(lab)}</span></div>`;
  const tStrong = s.tDays !== null && s.tDays !== undefined && Math.abs(s.tDays) >= 2;
  $('#m-counter').innerHTML = head + '<div class="strip-cells">'
    + cell(String(s.n), 'сделок', `За ${plural(s.days, 'торговый день', 'торговых дня', 'торговых дней')}; одна сделка на бумагу в день`)
    + cell(fmtPct(s.mean, 2), 'среднее к IWM', 'Доходность открытие → закрытие минус внутридневная доходность IWM того же дня', cls(s.mean))
    + cell(fmtPct(s.median, 2), 'медиана', 'Медианная сделка: распределение скошено, среднее держат немногие крупные выигрыши', cls(s.median))
    + cell(Math.round(s.win * 100) + '%', 'в плюсе', 'Доля сделок, обогнавших IWM в тот же день')
    + cell(s.tDays === null || s.tDays === undefined ? '—' : String(s.tDays), 't по дням',
      'Среднее за день, затем t-статистика по дням. От нуля отличимо при |t| ≥ 2', tStrong ? cls(s.tDays) : 'muted')
    + cell(fmtPct(s.net, 2), `после ${pctPlain(c.cost, 1)} на круг`, 'Среднее за вычетом издержек на круг. Эффект исчезает при издержках около 0.2%', cls(s.net))
    + cell(fmtPct(s.cumNet, 1), 'сумма нетто', 'Сумма доходностей всех сделок после издержек, в долях одной позиции: столько заработала бы позиция равного размера на каждую сделку', cls(s.cumNet))
    + '</div>';
}

// Плашка всплеска: z-оценка числа покупающих эмитентов за три месяца к 36 прошлым. Это сигнал
// возврата в рынок для панели 837, а не повод покупать бумаги из списка. Справа — z за 60 месяцев.
function renderSurge() {
  const b = state.stats?.breadth, box = $('#m-surge');
  if (!b) { box.innerHTML = ''; box.className = 'surge'; return; }
  box.className = 'surge' + (b.surge ? ' on' : '');
  const pts = b.history.filter(x => x.z !== null && !x.p);
  const W = 150, H = 26, lo = -3, hi = 5, n = pts.length;
  const X = i => (n > 1 ? (i / (n - 1)) * (W - 4) : 0) + 2, Y = z => H - 2 - ((Math.max(lo, Math.min(hi, z)) - lo) / (hi - lo)) * (H - 4);
  const spark = n > 1 ? `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="z-оценка по месяцам">`
    + `<line x1="0" x2="${W}" y1="${Y(b.thr).toFixed(1)}" y2="${Y(b.thr).toFixed(1)}" class="spark-thr"/>`
    + `<polyline points="${pts.map((x, i) => X(i).toFixed(1) + ',' + Y(x.z).toFixed(1)).join(' ')}" class="spark-line"/>`
    + `<circle cx="${X(n - 1).toFixed(1)}" cy="${Y(pts[n - 1].z).toFixed(1)}" r="2.5" class="spark-dot"/></svg>` : '';
  box.innerHTML = `<span class="surge-main"><b>Всплеск покупок: ${b.surge ? 'есть' : 'нет'}</b>`
    + `<span class="surge-z" title="Число разных эмитентов с покупками от $10 тыс., прошедшими гейты, за 3 месяца против среднего за 36 прошлых месяцев. Порог всплеска z ≥ ${b.thr}.">`
    + ` z = ${b.z === null ? '—' : b.z} · ${esc(monthRu(b.asOf))}</span></span>` + spark;
}

function dayNote(day, rows) {
  if (!day) return '';
  if (!rows.length) return '';
  if (!day.done) return day.entry ? '' : 'торги D+1 ещё не прошли';
  const res = rows.filter(x => x.ex !== undefined);
  if (!res.length) return `торги ${fmtDate(day.entry)}: результатов нет`;
  const m = res.reduce((a, x) => a + x.ex, 0) / res.length;
  const up = res.filter(x => x.ex > 0).length;
  return `торги ${fmtDate(day.entry)}: среднее ${fmtPct(m, 2)} к IWM, в плюсе ${up} из ${res.length}`;
}

function renderMorning() {
  renderCounter();
  renderSurge();
  const days = state.morning.days;
  // Выбор даты: десять последних дат подачи, число бумаг уровня в подписи
  $('#m-day').innerHTML = days.map(d => `<option value="${esc(d.date)}"${d.date === mDay ? ' selected' : ''}>${esc(fmtDate(d.date))} · ${lvlRows(d).length}</option>`).join('');
  const day = days.find(d => d.date === mDay) ?? null;
  const rows = lvlRows(day);
  $('#m-note').textContent = dayNote(day, rows);
  const past = !!day?.done;
  // Классы c-* нужны узкому экрану: «Кто», «Оборот», «Открытие» и «Закрытие» там прячутся
  const th = `<tr><th>Бумага</th><th class="c-who">Кто</th>
    <th class="num" title="Сумма всех покупок бумаги в этот день подачи (покупки от $10 тыс., прошедшие гейты)">Сумма</th>
    <th class="num" title="Насколько ниже 52-недельного максимума была цена на дату сделки">От макс.</th>
    <th class="num c-dv" title="Медианный дневной долларовый оборот бумаги за 60 торговых дней до сделки">Оборот</th>
    <th class="c-marks">Пометки</th>${past ? `<th class="num c-open" title="Цена открытия следующего торгового дня — вход">Открытие</th>
    <th class="num c-close" title="Цена закрытия того же дня — выход">Закрытие</th>
    <th class="num" title="Доходность открытие → закрытие минус доходность IWM за тот же день">К IWM</th>` : ''}</tr>`;
  $('#m-table').innerHTML = th + (rows.length ? rows.map(x => {
    const who = x.nWho > 1 ? `${esc(trunc(x.who[0], 20))} <span class="sub2-inline">и ещё ${x.nWho - 1}</span>` : esc(trunc(x.who[0] ?? '—', 24));
    const marks = (x.tags ?? []).map(t => MTAG[t] ? `<span class="pill ${MTAG[t][1]}" title="${esc(MTAG[t][2])}">${esc(MTAG[t][0])}</span>` : '').join(' ');
    // Сделка пропущена — причина в подсказке; открытие и закрытие у такой строки пусты
    const result = !past ? '' : x.skip
      ? `<td class="num c-open muted">—</td><td class="num c-close muted">—</td>`
        + `<td class="num muted" title="${esc(SKIP[x.skip] ?? x.skip)}">пропуск</td>`
      : `<td class="num c-open">${fmtPrice(x.o)}</td><td class="num c-close">${fmtPrice(x.c)}</td>`
        + `<td class="num ${cls(x.ex)}" title="${esc(`Сделка ${fmtPct(x.r, 2)}, IWM ${fmtPct(x.b, 2)}`)}">${fmtPct(x.ex, 2)}</td>`;
    const roleLine = `${esc(ROLE_LABEL[x.role] ?? x.role)}${x.n > 1 ? ' · ' + plural(x.n, 'покупка', 'покупки', 'покупок') : ''}`;
    return `<tr>
      <td><a class="tick" href="#ticker/${encodeURIComponent(x.t)}">${esc(x.t)}</a>
        <span class="sub2 nm" title="${esc(x.name)}">${esc(trunc(x.name, 28))}</span>
        <span class="sub2 who-m">${esc(trunc(x.who[0] ?? '—', 18))}${x.nWho > 1 ? ' +' + (x.nWho - 1) : ''} · ${roleLine}</span>
        <span class="marks-m">${marks}</span></td>
      <td class="c-who">${who}<span class="sub2">${roleLine}</span></td>
      <td class="num">${fmtMoney(x.val)}</td>
      <td class="num ${cls(x.dd)}">${fmtPct(x.dd, 0)}</td>
      <td class="num c-dv">${fmtMoney(x.dv)}</td>
      <td class="marks c-marks">${marks}</td>${result}</tr>`;
  }).join('') : `<tr><td colspan="${past ? 9 : 6}" class="empty">${days.length
    ? 'В этот день подходящих покупок нет — список бывает пустым.' : 'Данные ещё не собраны.'}</td></tr>`);
  $('#m-foot').innerHTML = 'Покупка на открытии следующего торгового дня, продажа на закрытии того же дня; сумма на бумагу одинаковая. '
    + 'Почему так — на вкладке <a href="#stats">Статистика</a>.';
}

// ---------- ЛЕНТА ----------
const ff = {
  roles: new Set(), setOnly: false, gate: 'ok', q: '',
  // Диапазоны «от/до»: пустое поле = граница не задана. Подсказки в placeholder
  // показывают рекомендованные значения, но сами по себе не применяются.
  valMin: null, valMax: null, downMin: null, downMax: null,
};
// Значение поля диапазона: пусто или не число -> граница снята
const rngVal = id => {
  const raw = $(id).value.trim();
  if (raw === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
};
// Значение попадает в диапазон. null-граница означает «не задана»; строка без значения
// (например скор у отсеянной сделки) проходит только когда границы не заданы вовсе.
function inRange(v, min, max) {
  if (min === null && max === null) return true;
  if (v === null || v === undefined) return false;
  if (min !== null && v < min) return false;
  if (max !== null && v > max) return false;
  return true;
}
function bindRange(id, key, scale = 1) {
  let deb;
  $(id).addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => {
      const v = rngVal(id);
      ff[key] = v === null ? null : v * scale;
      renderFeed(true);
    }, 250);
  });
}
bindRange('#f-val-min', 'valMin');
bindRange('#f-val-max', 'valMax');
bindRange('#f-down-min', 'downMin', 0.01);   // проценты -> доля
bindRange('#f-down-max', 'downMax', 0.01);

// Флажок «у максимума, 3 мес.» — прежний рабочий набор (цена не ниже 7% от 52-недельного максимума,
// сумма от $50 тыс., оборот от $3 млн). На ревизии 04.11.2026 альфы не дал (вслепую +1.3%/год,
// вживую −8.7% против S&P), поэтому остался только фильтром ленты. Расчёт набора и его бэктест в
// сборке не тронуты — они нужны диагностике на вкладке «Статистика».
for (const b of document.querySelectorAll('#f-roles .chip')) {
  b.addEventListener('click', () => {
    b.classList.toggle('active');
    ff.roles = new Set([...document.querySelectorAll('#f-roles .chip.active')].map(x => x.dataset.role));
    renderFeed(true);
  });
}
$('#f-gate').addEventListener('change', e => { ff.gate = e.target.value; renderFeed(true); });
$('#f-set').addEventListener('change', e => { ff.setOnly = e.target.checked; renderFeed(true); });
{
  let deb;
  $('#f-search').addEventListener('input', e => {
    clearTimeout(deb);
    deb = setTimeout(() => { ff.q = e.target.value.trim().toLowerCase(); renderFeed(true); }, 200);
  });
}
$('#feed-more').addEventListener('click', () => { state.feedShown += 200; renderFeed(false); });

async function loadFeed() {
  if (!state.feed) {
    try { state.feed = await fetchJson('feed.json'); }
    catch { $('#feed-table').innerHTML = '<tr><td>Данные ленты ещё не собраны.</td></tr>'; return; }
  }
  // Лента тоже показывает метку «у максимума», а её порог живёт в stats.json: без него
  // при заходе сразу на #feed метка считалась бы по запасному значению, а не по правилу.
  if (!state.stats) { try { state.stats = await fetchJson('stats.json'); } catch { /* метка возьмёт запасной порог */ } }
  renderFeatLegend();
  renderFeed(true);
}
function feedFiltered() {
  return state.feed.filter(r =>
    (ff.gate === 'all' || (ff.gate === 'ok' ? !r.drop : !!r.drop)) &&
    (!ff.roles.size || ff.roles.has(r.role)) &&
    inRange(r.val, ff.valMin, ff.valMax) &&
    inRange(r.dOwn, ff.downMin, ff.downMax) &&
    (!ff.setOnly || r.set === 1) &&
    (!ff.q || r.t.toLowerCase().includes(ff.q) || r.name.toLowerCase().includes(ff.q) || r.who.toLowerCase().includes(ff.q)));
}
function renderFeed(reset) {
  if (reset) state.feedShown = 100;
  const rows = sortRows(feedFiltered());
  const shown = rows.slice(0, state.feedShown);
  const th = `<tr>
    <th>Подача</th><th title="Рабочих дней между сделкой и подачей формы">Лаг</th>
    <th>Тикер</th><th>Компания</th><th>Инсайдер</th><th>Роль</th>
    <th class="num">Акции</th><th class="num">Цена</th>
    <th class="num sortable" data-sort="chgT" title="Изменение цены с ДАТЫ СДЕЛКИ — результат самого инсайдера. При просроченной подаче отличается от колонки «с подачи»">с сделки ⇅</th>
    <th class="num sortable" data-sort="val">Сумма ⇅</th>
    <th class="num" title="Прирост позиции инсайдера">Δ поз.</th>
    <th title="Прежний набор «у максимума, 3 мес.» — фильтр ленты, не рекомендация">У макс.</th><th>Признаки</th>
    <th class="num" title="Через неделю после того, как сигнал стал публичным">1н</th>
    <th class="num" title="Через месяц">1м</th>
    <th class="num" title="Через 6 месяцев">6м</th>
    <th class="num">Тек.</th>
    <th class="num sortable" data-sort="chg" title="Изменение с первого торгового дня ПОСЛЕ ПОДАЧИ формы — то, что мог бы получить читатель сигнала. Только эта величина корректна для оценки стратегии">с подачи ⇅</th></tr>`;
  $('#feed-table').innerHTML = th + (shown.length ? shown.map(r => `<tr class="${r.drop ? 'dropped' : ''}">
    <td>${esc(r.fdate)}${r.form === '4/A' ? ' <span class="pill gray" title="поправка">A</span>' : ''}</td>
    <td class="num ${r.delay > 10 ? 'neg' : ''}">${r.delay}</td>
    <td><a class="tick" href="#ticker/${encodeURIComponent(r.t)}">${esc(r.t)}</a></td>
    <td title="${esc(r.name)}">${esc(trunc(r.name, 22))}</td>
    <td title="${esc(r.title)}">${esc(trunc(r.who, 24))}</td>
    <td>${esc(ROLE_LABEL[r.role] ?? r.role)}</td>
    <td class="num">${fmtInt(r.sh)}</td>
    <td class="num">${fmtPrice(r.px)}</td>
    <td class="num ${cls(r.chgT)}">${fmtPct(r.chgT)}</td>
    <td class="num">${fmtMoney(r.val)}</td>
    <td class="num">${r.dOwn === null ? '—' : (r.dOwn >= 9.99 ? 'новая' : fmtPct(r.dOwn, 0))}</td>
    <td>${r.set === 1 ? '<span class="pill gray" title="Прежний набор «у максимума, 3 мес.»">✓</span>' : ''}</td>
    <td>${featureCell(r)}</td>
    <td class="num ${cls(r.w1)}">${fmtPct(r.w1)}</td>
    <td class="num ${cls(r.m1)}">${fmtPct(r.m1)}</td>
    <td class="num ${cls(r.m6)}">${fmtPct(r.m6)}</td>
    <td class="num">${fmtPrice(r.cur)}</td>
    <td class="num ${cls(r.chg)}">${fmtPct(r.chg)}</td>
  </tr>`).join('') : '<tr><td colspan="18" class="muted">Ничего не найдено.</td></tr>');
  $('#feed-count').textContent = `${Math.min(state.feedShown, rows.length)} из ${rows.length}`;
  $('#feed-more').disabled = state.feedShown >= rows.length;
  bindSort('#feed-table', renderFeed);
}
const dropLabel = d => state.meta?.gates?.labels?.[d] ?? d;

// ---------- ТИКЕР ----------
let tickerRange = '5y';
async function loadTickerIndex() {
  if (state.tickersIndex) return;
  try {
    state.tickersIndex = await fetchJson('tickers-index.json');
    $('#ticker-list').innerHTML = state.tickersIndex.map(x => `<option value="${esc(x.t)}">${esc(x.name)}</option>`).join('');
  } catch { /* индекс появится после первой сборки */ }
}
$('#t-search').addEventListener('change', e => {
  const t = e.target.value.trim().toUpperCase();
  if (t) location.hash = '#ticker/' + encodeURIComponent(t);
});
for (const b of document.querySelectorAll('#t-range .chip')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('#t-range .chip')) x.classList.remove('active');
    b.classList.add('active');
    tickerRange = b.dataset.range;
    if (state.tickerData) renderChart();
  });
}
$('#tc-onlyp').addEventListener('change', () => state.tickerData && renderTickerTrades());

async function openTicker(t) {
  $('#t-search').value = t;
  let d;
  try { d = await fetchJson('tickers/' + encodeURIComponent(t.replace(/[^A-Za-z0-9.-]/g, '_')) + '.json'); }
  catch {
    $('#ticker-card').classList.add('hidden');
    $('#ticker-empty').textContent = `По тикеру ${t} нет данных: либо не было покупок инсайдеров с 2016 года, либо эмитент вне вселенной (OTC).`;
    return;
  }
  state.tickerData = d;
  $('#ticker-empty').textContent = '';
  $('#ticker-card').classList.remove('hidden');
  $('#tc-name').textContent = `${d.t} · ${d.name}`;
  $('#tc-badges').innerHTML = [
    d.exchange ? `<span class="pill gray">${esc(d.exchange)}</span>` : '',
    d.bucket ? `<span class="pill gray" title="Прокси размера по дневному обороту">${esc(d.bucket)}</span>` : '',
    d.setBuys ? `<span class="pill gray" title="Покупок этого эмитента, подходивших под прежний набор «у максимума, 3 мес.»">у макс.: ${d.setBuys}</span>` : '',
    d.nSells ? `<span class="pill gray" title="Продаж инсайдеров за всю историю. Показано как контекст: предсказательной силы у продаж не нашлось — портфель проданных бумаг неотличим от сопоставимых">продаж: ${fmtInt(d.nSells)}</span>` : '',
    d.cat === 'unknown' ? '<span class="pill warn" title="Эмитента нет в текущем справочнике SEC — возможен делистинг или смена структуры">возможен делистинг</span>' : '',
  ].join(' ');
  $('#tc-asof').textContent = d.asOf ? `цены до ${d.asOf} · покупок прошло фильтры: ${d.okBuys}` : 'цены недоступны';
  renderFeatLegend();
  if (!state.chart) state.chart = new PriceChart($('#tc-chart'));
  renderChart();
  renderTickerTrades();
}
function renderChart() {
  const d = state.tickerData;
  const cutoff = tickerRange === '1y' ? isoAgo(370) : tickerRange === '5y' ? isoAgo(365 * 5) : '0000';
  const series = (tickerRange === '1y' && d.daily.length ? d.daily : d.weekly).filter(r => r[0] >= cutoff);
  // На графике номинальные цены сделок приведены к той же шкале, что и котировки
  // (иначе после обратного сплита маркеры улетают за пределы графика)
  const markers = d.trades.filter(r => r.tdate >= cutoff).map(r => ({
    d: r.tdate, px: r.pxAdj ?? r.px, pxRaw: r.px, code: r.code, who: r.who, sh: r.sh, val: r.val, drop: r.drop,
  }));
  state.chart.set(series, markers);
}
function isoAgo(days) {
  const x = new Date();
  x.setUTCDate(x.getUTCDate() - days);
  return x.toISOString().slice(0, 10);
}
function renderTickerTrades() {
  const d = state.tickerData;
  const rows = d.trades.filter(r => !$('#tc-onlyp').checked || r.code === 'P');
  const th = `<tr>
    <th>Сделка</th><th>Подача</th><th>Тип</th><th>Инсайдер</th><th>Роль</th>
    <th class="num">Акции</th><th class="num">Цена</th><th class="num">Сумма</th>
    <th class="num">Δ поз.</th><th class="num">Остаток</th><th>Признаки</th><th title="Подходит под прежний набор «у максимума, 3 мес.»">У макс.</th></tr>`;
  $('#tc-trades').innerHTML = th + rows.map(r => `<tr class="${r.drop ? 'dropped' : ''}">
    <td>${esc(r.tdate)}</td>
    <td>${esc(r.fdate)}${r.form === '4/A' ? ' <span class="pill gray">A</span>' : ''}</td>
    <td>${r.code === 'P' ? '<span class="pill buy">▲ покупка</span>' : '<span class="pill sell">▼ продажа</span>'}</td>
    <td title="${esc(r.title)}">${esc(trunc(r.who, 28))}</td>
    <td>${esc(ROLE_LABEL[r.role] ?? r.role)}</td>
    <td class="num">${fmtInt(r.sh)}</td>
    <td class="num">${fmtPrice(r.px)}</td>
    <td class="num">${fmtMoney(r.val)}</td>
    <td class="num">${r.code !== 'P' || r.dOwn === null ? '—' : (r.dOwn >= 9.99 ? 'новая' : fmtPct(r.dOwn, 0))}</td>
    <td class="num">${fmtInt(r.own)}</td>
    <td>${r.drop ? `<span class="pill warn feat" title="${esc('Отсеяна: ' + dropLabel(r.drop))}">${esc(DROP_CODE[r.drop] ?? r.drop.slice(0, 2))}</span> ` : ''}${r.b5 ? featPill('planned-mark') : ''}${r.di === 'I' ? featPill('indirect') : ''}${r.sec && !/^common\b/i.test(r.sec) ? `<span class="pill gray feat" title="${esc('Класс бумаги: ' + r.sec)}">Пф</span> ` : ''}</td>
    <td>${r.set === 1 ? '<span class="pill gray">✓</span>' : ''}</td>
  </tr>`).join('');
}

// ---------- СТАТИСТИКА ----------
// Всё, что здесь показано, считает сборка (scripts/compute.mjs). Страница не хранит ни
// одной цифры о результатах: захардкоженные числа в разметке однажды уже разошлись с
// движком, и проверить их было нечем.
const pctPlain = (v, d = 0) => v === null || v === undefined || !Number.isFinite(v) ? '—' : (v * 100).toFixed(d) + '%';
const tCell = t => {
  if (t === null || t === undefined) return '<td class="num muted">—</td>';
  // Значимость показываем явно: без неё разница между ячейками выглядит осмысленной,
  // хотя на подставных данных |t|>2 не встречается вовсе.
  const strong = Math.abs(t) >= 2;
  return `<td class="num ${strong ? cls(t) : 'muted'}" title="${strong ? 'отличие от нуля устойчиво' : 'от нуля неотличимо'}">${t.toFixed(2)}</td>`;
};
const numCell = (v, warn) => `<td class="num ${v === null || v === undefined ? 'muted' : (warn && v < 0 ? 'warn-n' : cls(v))}">${fmtPct(v)}</td>`;

// Загрузка данных и разовая инициализация — разные вещи. Раньше обе жили в одном
// `if (!state.stats)`, и после того как Скринер начал подтягивать stats.json первым,
// инициализация Статистики не выполнялась вовсе: пояснение оставалось пустым, а
// обработчики селекторов не навешивались.
let statsInited = false;
async function loadStats() {
  if (!state.stats) {
    try { state.stats = await fetchJson('stats.json'); }
    catch { $('#stats-table').innerHTML = '<tr><td>Бэктест ещё не собран.</td></tr>'; return; }
  }
  if (!statsInited) {
    statsInited = true;
    const s = state.stats, m = s.method ?? {};
    $('#stats-note').innerHTML =
      `<b>Что здесь считается.</b> Не «сколько принесла средняя сделка», а <b>сколько принёс бы портфель</b>: ` +
      `на конец каждого месяца берутся все бумаги с подходящей покупкой за последние N месяцев, ` +
      `равный вес <b>по бумагам</b> (не по числу подач), держим месяц, повторяем с 2016 года. ` +
      `Учитываются только имена с дневным оборотом от ${fmtMoney(m.minDv ?? 3e6)} на момент покупки. ` +
      `В расчёте ${fmtInt(s.n)} покупок с котировками, из них ${fmtInt(s.nOk)} прошли фильтры. ` +
      `<b>Альфа считается к трём факторам</b> — рынок, размер и моментум.` + survivalNote();
    function survivalNote() {
      const sv = state.meta?.survival;
      if (!sv) return '';
      const years = Object.keys(sv).sort();
      if (years.length < 3) return '';
      const first = sv[years[0]], last = sv[years[years.length - 1]];
      return `<br><b>Чего здесь нет.</b> У части покупок ценового ряда не существует вовсе — ` +
        `бумага делистнута, а бесплатные источники её истории не отдают. Доля таких покупок ` +
        `падает с ${pctPlain(first.share)} в ${years[0]} году до ${pctPlain(last.share)} в ` +
        `${years[years.length - 1]}: чем старше год, тем больше пропущено, и пропущены именно ` +
        `компании, которых больше нет. Смещение от этого не устраняется, оно только сокращается ` +
        `по мере дозагрузки истории делистнутых бумаг.`;
    }
    // Срез «рабочий набор» — трёхмесячная конструкция: показывать его на двенадцати месяцах
    // значит показывать другой портфель под тем же именем.
    $('#s-dim').addEventListener('change', () => {
      if ($('#s-dim').value === 'set') $('#s-hold').value = '3';
      renderStats();
    });
    $('#s-hold').addEventListener('change', renderStats);
  }
  renderAvoid();
  renderStats();
}

// Чёрный список: срезы, которые системно хуже индекса (считает сборка). Итоги ревизии — статичный
// блок в разметке: они не пересчитываются, а фиксируют вывод.
function renderAvoid() {
  const av = state.stats?.avoid ?? [];
  $('#avoid-table').innerHTML = av.length
    ? `<tr><th>Срез</th><th class="num">Держать</th><th class="num">Бумаг</th><th class="num">CAGR</th>
       <th class="num">к SPY</th><th class="num">t</th><th class="num">α 3ф</th><th class="num">t</th></tr>` +
      av.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.hold} мес</td><td class="num">${r.n}</td>
        ${numCell(r.cagr)}${numCell(r.spy, true)}${tCell(r.spyT)}${numCell(r.a, true)}${tCell(r.t)}</tr>`).join('')
    : '<tr><td>Данных пока недостаточно.</td></tr>';
}

const GROUP_LABEL = { F: 'CFO', C: 'CEO/През', O: 'Офицер', D: 'Директор', T: '10%-владелец', X: 'Прочее' };
function renderStats() {
  const dim = $('#s-dim').value;
  const H = $('#s-hold').value;
  const port = state.stats.portfolio?.[dim];
  const m = state.stats.method ?? {};
  if (!port) { $('#stats-table').innerHTML = '<tr><td>Портфельная метрика ещё не собрана.</td></tr>'; return; }
  let html = '<tr><th>Группа</th>' +
    '<th class="num" title="средний состав портфеля, бумаг в месяц">Бумаг</th>' +
    '<th class="num" title="среднегодовая доходность самого портфеля">CAGR</th>' +
    '<th class="num" title="превышение над S&P 500 в год">к SPY</th>' +
    '<th class="num" title="t-статистика превышения с поправкой Ньюи–Уэста">t</th>' +
    '<th class="num" title="годовая альфа к рынку, размеру и моментуму">α 3ф</th>' +
    '<th class="num">t</th>' +
    '<th class="num" title="превышение над равновзвешенной вселенной той же ликвидности">к вселенной</th>' +
    '<th class="num">t</th>' +
    `<th class="num" title="до ${esc(m.split ?? '2021-01')}">1-я половина</th>` +
    '<th class="num">2-я половина</th></tr>';
  const rows = Object.entries(port).map(([g, cell]) => [g, cell['h' + H]]).filter(([, c]) => c);
  rows.sort((a, b) => (b[1].spy ?? -9) - (a[1].spy ?? -9));
  for (const [g, c] of rows) {
    html += `<tr><td>${esc(GROUP_LABEL[g] ?? g)}${c.thin ? ' <span class="pill warn" title="средний состав меньше 10 бумаг — оценка ненадёжна">тонкая</span>' : ''}</td>` +
      `<td class="num ${c.thin ? 'warn-n' : ''}">${c.n}</td>` +
      numCell(c.cagr) + numCell(c.spy, true) + tCell(c.spyT) + numCell(c.a, true) + tCell(c.t) +
      numCell(c.u, true) + tCell(c.ut) + numCell(c.aT) + numCell(c.aV) + '</tr>';
  }
  $('#stats-table').innerHTML = html;
  $('#stats-legend').innerHTML =
    `Ячейка считается, только если у среза набралось не меньше ${m.minMonths ?? 36} месяцев и ` +
    `${m.minNames ?? 5} бумаг в портфеле. «Тонкая» — средний состав меньше ${m.thin ?? 10} бумаг: ` +
    `такие числа держат один-два эмитента, и доверять им нельзя.`;
}
