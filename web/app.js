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
  high:          ['М',  'У максимума', 'Акция не более чем на 5% ниже 52-недельного максимума: инсайдер платит высокую цену. Ключевое условие рабочего набора', 'buy'],
  'first-ever':  ['1',  'Первая покупка', 'Первая покупка этого инсайдера в наших данных. Лучше сопоставимых бумаг, но индекс не обгоняет', 'gray'],
  // Помечен нейтрально сознательно: на проверке вне выборки признак дал отрицательный
  // эффект (−2.4%) и в скоринг v3 не вошёл — зелёная метка вводила бы в заблуждение
  'first-in-3y': ['3г', 'Не покупал 3 года', 'Первая покупка за три года. Предсказательной силы не показала — метка справочная', 'gray'],
  pledge:        ['З',  'Залог', 'Акции инсайдера в залоге — риск принудительной продажи', 'gray'],
  trust:         ['Т',  'Траст', 'Покупка через траст или на супруга — деньги того же инсайдера', 'gray'],
  indirect:      ['Кс', 'Косвенное владение', 'Бумаги записаны не напрямую на инсайдера', 'gray'],
  'no-history':  ['Ни', 'Нет истории', 'Истории сделок меньше трёх лет — рутинность по CMP не определена', 'gray'],
  'no-price':    ['Нц', 'Нет котировок', 'Ценовые проверки (дисконт, единицы, старт торгов) провести было не на чем', 'gray'],
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
document.documentElement.dataset.theme = localStorage.getItem('ir-theme')
  ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = cur;
  localStorage.setItem('ir-theme', cur);
  if (state.chart && state.tickerData) renderChart();
});

// ---------- Состояние ----------
const state = {
  feed: null, stats: null, meta: null,
  tickersIndex: null, tickerData: null, chart: null, feedShown: 100, sort: null,
  live: null,          // последний ответ воркера котировок, null — живого слоя нет
};
async function fetchJson(path) {
  const res = await fetch('data/' + path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(path + ': HTTP ' + res.status);
  return res.json();
}

// ---------- Роутинг ----------
const tabs = document.querySelectorAll('.tabs a');
const TABS = ['screener', 'feed', 'ticker', 'stats'];
function route() {
  const hash = location.hash || '#screener';
  let [tab, arg] = hash.slice(1).split('/');
  if (!TABS.includes(tab)) { tab = 'screener'; arg = undefined; }  // неизвестный якорь — не белый экран
  for (const a of tabs) a.classList.toggle('active', a.dataset.tab === tab);
  for (const p of document.querySelectorAll('.tab-panel')) p.classList.toggle('active', p.id === 'tab-' + tab);
  if (tab === 'screener') { loadScreener(); startLive(); } else stopLive();
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
      m.set ? `<span class="badge" title="Сделок в рабочем наборе за всю историю / из них действующих прямо сейчас">набор <b>${fmtInt(m.set.rows)}</b> · сейчас <b>${fmtInt(m.set.live)}</b></span>` : '',
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
  if (r.dd !== null && r.dd >= -0.05) out.push(featPill('high'));
  if (r.inflect) out.push(featPill(r.inflect));
  for (const t of r.tags ?? []) out.push(featPill(t));
  return out.join(' ');
}
// Легенда собирается из тех же таблиц, что и метки, поэтому не может с ними разойтись
function renderFeatLegend() {
  const boxes = document.querySelectorAll('.feat-legend');
  if (!boxes.length) return;
  const group = (title, items) => `<div class="legend-group"><b>${esc(title)}</b>${items.map(([code, name, why, style]) =>
    `<span class="legend-item" title="${esc(why)}"><i class="pill ${style ?? 'gray'} feat">${esc(code)}</i>${esc(name)}</span>`).join('')}</div>`;
  const signal = ['high', 'first-ever', 'first-in-3y'].map(k => FEAT[k]);
  const info = ['pledge', 'trust', 'indirect', 'planned-mark', 'no-history', 'no-price'].map(k => FEAT[k]);
  // Названия групп честные: «сигнальным» осталось одно условие набора, остальное —
  // описание сделки, у которого предсказательной силы не нашлось
  const labels = state.meta?.gates?.labels ?? {};
  const drops = Object.entries(DROP_CODE)
    .filter(([k]) => labels[k])
    .map(([k, code]) => [code, labels[k], labels[k], 'warn']);
  const html = group('Ценовой контекст и поведение:', signal) + group('Описание сделки:', info) +
    (drops.length ? group('Причины отсева (видны при показе отсеянных):', drops) : '');
  for (const b of boxes) if (b.dataset.done !== '1') { b.innerHTML = html; b.dataset.done = '1'; }
}

// ---------- СКРИНЕР: рабочий набор ----------
// Единственный торговый экран. Показывает сделки, попавшие в набор, и главное для решения:
// сколько дней сигналу и когда выходить. Сигнал живёт около месяца — после этого позиция
// уже не окупается, поэтому возраст вынесен в отдельную колонку со статусом.
let setAge = 'fresh';
async function loadScreener() {
  if (!state.feed) {
    try { state.feed = await fetchJson('feed.json'); }
    catch { $('#set-table').innerHTML = '<tr><td>Данные ещё не собраны.</td></tr>'; return; }
  }
  if (!state.stats) { try { state.stats = await fetchJson('stats.json'); } catch { /* числа появятся позже */ } }
  renderSetHeader();
  renderSet();
  pollLive({ force: true });   // первый опрос сразу после данных, а не через период таймера
}
for (const b of document.querySelectorAll('#set-age .chip')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('#set-age .chip')) x.classList.remove('active');
    b.classList.add('active');
    setAge = b.dataset.age;
    renderSet();
  });
}
function renderSetHeader() {
  const d = state.stats?.setDef, s = state.stats?.set;
  if (d) {
    // Правило — не абзац, а список условий: его читают глазами перед каждой сделкой,
    // и в такой форме видно, что условий ровно четыре.
    $('#set-rule').innerHTML = [
      ['цена', `не ниже ${Math.abs(Math.round(d.maxDd * 100))}% от 52-нед. максимума`],
      ['сумма', `от ${fmtMoney(d.minVal)}`],
      ['оборот', `от ${fmtMoney(d.minDv)} в день`],
      ['держать', `${d.hold} месяца`],
    ].map(([k, v]) => `<li><span>${esc(k)}</span>${esc(v)}</li>`).join('') +
      `<li class="rule-warn"><span>входить</span>в течение месяца после подачи</li>`;
  }
  if (!s) return;
  $('#set-headline').innerHTML =
    `<div class="figure-val ${cls(s.spy)}">${fmtPct(s.spy)}</div>` +
    `<div class="figure-lab">к S&P 500 в год</div>` +
    `<div class="figure-note">t = ${s.spyT} · после издержек ${fmtPct(s.net)}</div>`;
  const ref = (state.stats.reference ?? []).find(r => r.key === 'spy');
  const m = (v, lab, hint) => `<div class="hm" title="${esc(hint)}"><b>${v}</b><span>${esc(lab)}</span></div>`;
  $('#set-numbers').innerHTML =
    m(String(s.sharpe), `коэффициент Шарпа${ref ? ` · у индекса ${ref.sharpe}` : ''}`,
      'Доходность сверх безрисковой на единицу волатильности. Выше, чем у индекса, — значит набор лучше не только по доходности, но и по риску.') +
    m(fmtPct(s.a), 'альфа к трём факторам',
      `Рынок, размер и моментум. t = ${s.t}. Моментум обязателен: набор отбирает бумаги у максимума и по построению сидит в победителях моментума.`) +
    (s.control ? m(fmtPct(s.control.ex), 'сверх бумаг у максимума',
      `t = ${s.control.t}. Контроль — ${s.control.name}, собранные тем же способом. Столько добавляет сам факт покупки инсайдера.`) : '') +
    m(String(s.n), 'бумаг в портфеле', `В среднем за ${s.mo} месяцев наблюдений.`) +
    m(pctPlain(s.cagr, 1), `среднегодовая доходность${ref ? ` · индекс ${pctPlain(ref.cagr, 1)}` : ''}`,
      `Волатильность ${pctPlain(s.vol, 1)}, максимальная просадка ${pctPlain(s.dd, 1)}.`);
}
// Две РАЗНЫЕ вещи, которые прежний статус путал:
//   успеваю ли я войти — сигнал живёт около месяца после подачи (проверено: вход через
//     два месяца превращает +7.4% к индексу в +1.6%);
//   держится ли позиция — три месяца от первой покупки независимо от того, поздно я
//     узнал о сигнале или нет.
// Позиция, открытая 60 дней назад, для нового участника закрыта, но у того, кто вошёл
// вовремя, она ещё живёт — раньше такая строка помечалась «протух» и путала.
function setStatus(age, fresh, holdDays) {
  if (age <= fresh * 0.7) return ['ok', 'можно входить'];
  if (age <= fresh) return ['warn', 'поздно входить'];
  if (age <= holdDays) return ['hold', 'держим'];
  return ['dead', 'окно закрыто'];
}
// Русское склонение после числа: 1 покупка, 2-4 покупки, 5+ покупок (и 11-14 — покупок).
// Без этого в таблице появлялось «17 покупки».
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return n + ' ' + (a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many);
};

// Одна строка таблицы = одна ПОЗИЦИЯ, а не одна форма. Повторная покупка в той же бумаге
// (другой инсайдер или тот же на следующей неделе) не требует второй покупки: позиция уже
// открыта, и срок выхода отсчитывается от ПЕРВОГО сигнала. Проверено на истории — вариант
// «входить только на первый сигнал» даёт тот же результат (+7.3% против +7.4% к индексу),
// то есть повторные сигналы ничего не добавляют и покупать по ним второй раз незачем.
function groupPositions(rows, holdMonths) {
  const byTicker = new Map();
  for (const r of rows) (byTicker.get(r.t) ?? byTicker.set(r.t, []).get(r.t)).push(r);
  const out = [];
  for (const [t, list] of byTicker) {
    list.sort((a, b) => a.fdate < b.fdate ? -1 : 1);       // от старых к свежим
    let pos = null;
    for (const r of list) {
      // Новая позиция начинается, если прежняя уже закрыта к моменту этого сигнала
      const closed = pos && (Date.parse(r.fdate) - Date.parse(pos.first)) / 86400000 > holdMonths * 30.5;
      if (!pos || closed) {
        pos = { t, name: r.name, first: r.fdate, age: r.age, exit: r.exit, rows: [] };
        out.push(pos);
      }
      pos.rows.push(r);
      pos.last = r.fdate;
    }
  }
  for (const p of out) {
    p.val = p.rows.reduce((a, b) => a + (b.val ?? 0), 0);
    p.n = p.rows.length;
    p.who = [...new Set(p.rows.map(x => x.who))];
    p.px = p.rows[0].px; p.cur = p.rows[0].cur;
    p.entryPx = p.rows[0].entryPx; p.entryDate = p.rows[0].entryDate;
    p.chg = p.rows[0].chg; p.dd = p.rows[0].dd; p.dv = p.rows[0].dv;
    p.role = p.rows[0].role; p.title = p.rows[0].title;
  }
  return out.sort((a, b) => a.first < b.first ? 1 : a.first > b.first ? -1 : b.val - a.val);
}

// ---------- ЖИВЫЕ ЦЕНЫ ----------
// Yahoo не отдаёт CORS-заголовок, поэтому спросить цену напрямую браузер не может.
// Посредник — свой воркер на краю Cloudflare (worker/index.js): он держит ответ 30 секунд
// в кэше края, так что опрос отсюда не может разогнать обращения к источнику.
// Слой необязательный: если воркер молчит, страница остаётся на ценах снимка и работает
// целиком — живой слой ничего не добавляет к решению, только к наблюдению.
const QUOTES_URL = 'https://radar840-quotes.financehub.workers.dev/quotes';
const LIVE_PERIOD_MS = 30000;
const ySym = t => String(t).replace(/[./]/g, '-');   // BRK.B -> BRK-B, как в сборке
let liveTimer = null;

const onScreener = () => location.hash === '' || location.hash.startsWith('#screener');

// force — разовый опрос по явному поводу (экран только что отрисован, вкладка стала видимой).
// Требование видимости относится к ПОВТОРНОМУ опросу по таймеру: именно он в фоновой вкладке
// тянул бы источник сутками. Один запрос на отрисовку не стоит того, чтобы им рисковать.
async function pollLive({ force = false } = {}) {
  if ((!force && document.visibilityState !== 'visible') || !onScreener()) return;
  const today = new Date().toISOString().slice(0, 10);
  // Спрашиваем только по открытым позициям: закрытые живая цена не меняет, а список
  // короче — значит и ответ меньше, и в потолок воркера по числу тикеров не упираемся.
  const syms = [...new Set((state.feed ?? [])
    .filter(r => r.set === 1 && (!r.exit || r.exit >= today)).map(r => r.t))].slice(0, 60);
  if (!syms.length) return;
  try {
    const res = await fetch(`${QUOTES_URL}?symbols=${encodeURIComponent(syms.join(','))}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    if (!body?.quotes) throw new Error('пустой ответ');
    state.live = body;
  } catch (error) {
    // Тихо: снимок остаётся на месте. Единственный след — колонка не назовётся живой.
    state.live = null;
    console.warn('[live] котировки недоступны:', error?.message || error);
  }
  if (onScreener()) renderSet();
}

function startLive() {
  if (liveTimer) return;
  pollLive({ force: true });
  liveTimer = setInterval(pollLive, LIVE_PERIOD_MS);
}
function stopLive() { clearInterval(liveTimer); liveTimer = null; }
// Опрос идёт только у видимой вкладки: фоновая вкладка сутками тянула бы источник впустую.
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && onScreener()) startLive();
  else stopLive();
});

// Живая цена подменяет снимок, а «изм.» пересчитывается так, чтобы НЕ потерять дивиденды:
// снимочное изменение уже полное (adjClose), поэтому его достаточно домножить на отношение
// живой цены к цене снимка. Прямое «живая ÷ вход» дало бы ценовую доходность и разошлось
// бы с бэктестом. Снимочные значения сохраняются: из них считается сам множитель.
function applyLive(pos) {
  const q = state.live?.quotes;
  for (const p of pos) {
    p.curSnap = p.cur; p.chgSnap = p.chg; p.live = null;
    const x = q?.[ySym(p.t)];
    if (!x || typeof x.p !== 'number' || !p.curSnap) continue;
    p.live = x;
    p.cur = x.p;
    p.chg = p.chgSnap === null || p.chgSnap === undefined
      ? (p.entryPx ? x.p / p.entryPx - 1 : null)
      : (1 + p.chgSnap) * (x.p / p.curSnap) - 1;
  }
}

const MARKET_STATE = {
  REGULAR: 'торги идут', PRE: 'предторги', POST: 'постторги',
  PREPRE: 'до предторгов', POSTPOST: 'после постторгов', CLOSED: 'рынок закрыт',
};
// Время котировки — в нью-йоркском, а не в местном: цена принадлежит своей сессии,
// и «16:45» в Куала-Лумпуре ничего не говорит о том, открыт ли рынок.
function liveStamp() {
  const at = state.live?.at;
  if (!at) return null;
  const time = new Date(at * 1000).toLocaleTimeString('ru-RU', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit',
  });
  const st = Object.values(state.live.quotes ?? {})[0]?.st;
  return `живые цены · ${time} Нью-Йорк${st && MARKET_STATE[st] ? ` · ${MARKET_STATE[st]}` : ''}`
    + (state.live.stale ? ' · источник молчит, показано последнее' : '');
}

// «Сейчас» — это закрытие последнего дня снимка, а не текущая цена: сборка идёт раз в сутки
// после закрытия рынка. Когда живого слоя нет, дата снимка должна стоять на виду — иначе
// колонка выдаёт себя за настоящее время и вводит в заблуждение тем сильнее, чем дольше
// не было сборки.
function pricesAsOfHint() {
  if (state.live?.at) return liveStamp() + ' — цена обновляется каждые 30 секунд, пока вкладка открыта';
  const d = state.stats?.pricesAsOf;
  if (!d) return 'Последняя цена в снимке';
  const days = Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(d)) / 864e5);
  return `Закрытие ${fmtDate(d)}` + (days > 0 ? ` — снимок обновляется раз в сутки после закрытия рынка, сейчас ему ${plural(days, 'день', 'дня', 'дней')}` : '');
}

// «Ждём» — неверное слово для позиции, у которой день входа наступил ПРЯМО СЕЙЧАС.
// Форма подана после последнего закрытия в снимке, значит вход по правилу — на ближайшем
// закрытии рынка; если торги идут, это сегодняшнее. Прежняя надпись читалась как «пока
// нельзя, ждите следующего дня» и откладывала вход ровно на сутки, которых правило
// не требует: затухание сигнала считается днями, а не неделями.
const marketOpenNow = () => {
  const st = Object.values(state.live?.quotes ?? {})[0]?.st;
  return st === 'REGULAR' || st === 'PRE';
};
const entryDueLabel = () => marketOpenNow() ? 'сегодня на закрытии' : 'ближайшее закрытие';
const entryDueHint = () => 'Форма подана после последнего закрытия в данных. Вход по правилу набора — '
  + 'на ближайшем закрытии рынка'
  + (marketOpenNow() ? ' — то есть сегодня.' : '.')
  + ' Цена входа появится здесь, как только этот день закроется; до тех пор считать «изм.» не от чего.';

// Тонкая бумага печатается раз в несколько минут, и неподвижная цена выглядит как
// сломанный живой слой. Время последней печати снимает вопрос.
function curHint(p) {
  if (!p.live) {
    const d = state.stats?.pricesAsOf;
    return d ? `Закрытие ${fmtDate(d)} — живой цены по этой бумаге сейчас нет` : 'Цена из последнего снимка';
  }
  const t = p.live.t
    ? new Date(p.live.t * 1000).toLocaleTimeString('ru-RU', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })
    : null;
  // Пояснение про тонкую бумагу нужно только там, где печать реально застарела:
  // на ликвидной бумаге оно сбивало бы с толку, а не помогало.
  const ageMin = p.live.t ? Math.floor((Date.now() / 1000 - p.live.t) / 60) : 0;
  return (t ? `Последняя печать ${t} Нью-Йорк` : 'Живая цена')
    + (typeof p.live.prev === 'number' ? ` · вчерашнее закрытие ${fmtPrice(p.live.prev)}` : '')
    + (ageMin >= 2 ? `. Сделок нет уже ${plural(ageMin, 'минуту', 'минуты', 'минут')} — у малоликвидной бумаги цена стоит между сделками, это не сбой` : '');
}

// Насколько доступный вход отличался от цены инсайдера. У большинства сделок разрыв мелкий,
// у просроченных подач — огромный; именно он и объяснял, почему «изм.» не сходилась
// с делением цены сделки на текущую.
function insiderPxHint(p) {
  const gap = p.entryPx && p.px ? p.entryPx / p.px - 1 : null;
  if (gap === null || Math.abs(gap) < 0.005) return 'Цена, по которой купил инсайдер';
  return `Цена, по которой купил инсайдер: вход по правилу оказался `
    + `${gap > 0 ? 'дороже' : 'дешевле'} на ${(Math.abs(gap) * 100).toFixed(1)}%`;
}

// Число в колонке «Изм.» — полная доходность (с дивидендами), как в бэктесте. Деление
// видимых на экране цен даёт чуть меньше у дивидендных бумаг (у AAT за 85 дней +11.6%
// по ценам против +13.2% с дивидендами). Показываем обе величины, чтобы расхождение
// не выглядело ошибкой счёта.
function chgHint(p) {
  if (p.chg === null || p.chg === undefined) {
    return p.entryPx ? 'Позиция открылась в последний торговый день данных — измерять пока нечего'
      : 'Первый торговый день после подачи ещё не закрылся — считать не от чего';
  }
  const base = `Вход ${fmtPrice(p.entryPx)} → ${p.live ? 'живая цена' : 'закрытие'} ${fmtPrice(p.cur)}`;
  const byPrice = p.entryPx && p.cur ? p.cur / p.entryPx - 1 : null;
  return byPrice !== null && Math.abs(byPrice - p.chg) >= 0.002
    ? `${base}: по ценам ${fmtPct(byPrice)}, с дивидендами ${fmtPct(p.chg)}`
    : `${base} = ${fmtPct(p.chg)}`;
}

function renderSet() {
  const fresh = state.stats?.setDef?.freshDays ?? 45;
  const hold = state.stats?.setDef?.hold ?? 3;
  const holdDays = Math.round(hold * 30.5);
  const today = new Date().toISOString().slice(0, 10);
  let pos = groupPositions(state.feed.filter(r => r.set === 1), hold);
  // Открыта ли позиция — решает ДАТА ВЫХОДА, которую считает сборка, а не приблизительный
  // возраст в днях: иначе строка с уже прошедшей датой выхода оставалась в списке.
  if (setAge === 'fresh') pos = pos.filter(p => !p.exit || p.exit >= today);
  applyLive(pos);          // до сортировки: сортировать надо по тому, что видно
  pos = sortRows(pos);
  const sig = pos.reduce((a, p) => a + p.n, 0);
  const canEnter = pos.filter(p => p.age <= fresh).length;
  $('#set-count').textContent = pos.length
    ? (setAge === 'fresh'
      ? `${plural(pos.length, 'открытая позиция', 'открытые позиции', 'открытых позиций')} · войти ещё можно в ${canEnter}`
      : `${plural(pos.length, 'позиция', 'позиции', 'позиций')} за 200 дней`) +
      (sig > pos.length ? ` · ${plural(sig, 'сигнал', 'сигнала', 'сигналов')}, повторные покупки второй позиции не требуют` : '') +
      // В режиме «все за 200 дней» живыми будут только открытые позиции: по закрытым
      // текущая цена ничего не значит, их и не спрашиваем. Подпись обязана это назвать,
      // иначе «живые цены» над таблицей, где половина строк из снимка, — неправда.
      (liveStamp() ? ` · ${liveStamp()}${setAge === 'fresh' ? '' : ' (по открытым позициям)'}`
        : state.stats?.pricesAsOf ? ` · цены на закрытие ${fmtDate(state.stats.pricesAsOf)}` : '')
    : '';
  const th = `<tr>
    <th>Бумага</th><th>Покупали</th>
    <th class="num sortable" data-sort="age" title="Дата первой покупки в позиции и сколько дней прошло">Открыта ⇅</th>
    <th title="Успеваю ли я войти и держится ли позиция — это разные вещи">Статус</th>
    <th class="num sortable" data-sort="val" title="Сумма всех покупок инсайдеров в этой позиции">Куплено ⇅</th>
    <th class="num" title="Цена, по которой можно было войти по правилу набора: закрытие первого торгового дня после подачи формы. Мелким — цена самого инсайдера; при просроченной подаче она бывает намного ниже, и считать изменение от неё нельзя">Вход</th>
    <th class="num" title="${esc(pricesAsOfHint())}">Сейчас</th>
    <th class="num sortable" data-sort="chg" title="Изменение от ЦЕНЫ ВХОДА, а не от цены инсайдера: инсайдерская цена подписчику недоступна. Считается полная доходность — с дивидендами, как в бэктесте, поэтому у дивидендных бумаг число чуть выше, чем даёт деление цен на экране (в подсказке к числу видно обе величины)">Изм. ⇅</th>
    <th class="num sortable" data-sort="dd" title="Насколько ниже 52-недельного максимума была цена на дату сделки">До макс. ⇅</th>
    <th class="num" title="Медианный дневной долларовый оборот бумаги">Оборот</th>
    <th title="Три месяца от первой покупки">Выход</th></tr>`;
  $('#set-table').innerHTML = th + (pos.length ? pos.map(p => {
    const [st, lab] = setStatus(p.age, fresh, holdDays);
    const who = p.who.length === 1 ? esc(trunc(p.who[0], 24))
      : `${esc(trunc(p.who[0], 20))} <span class="sub2-inline">и ещё ${p.who.length - 1}</span>`;
    return `<tr class="${st === 'dead' ? 'row-dead' : st === 'hold' ? 'row-hold' : ''}">
      <td><a class="tick" href="#ticker/${encodeURIComponent(p.t)}">${esc(p.t)}</a>
        <span class="sub2" title="${esc(p.name)}">${esc(trunc(p.name, 30))}</span></td>
      <td>${who}<span class="sub2">${esc(ROLE_LABEL[p.role] ?? p.role)}${p.n > 1 ? ' · ' + plural(p.n, 'покупка', 'покупки', 'покупок') : ''}</span></td>
      <td class="num">${esc(fmtDate(p.first))}<span class="sub2">${p.age} дн. назад</span></td>
      <td><span class="pill ${st === 'ok' ? 'buy' : st === 'warn' ? 'warn' : 'gray'}" title="${esc(
        st === 'ok' ? 'Сигнал свежий — вход по правилу набора ещё уместен'
          : st === 'warn' ? 'Месяц почти вышел: входить уже поздно, эффект затухает'
            : st === 'hold' ? 'Входить поздно, но открытая позиция держится до даты выхода'
              : 'Три месяца истекли — позиция закрыта')}">${lab}</span></td>
      <td class="num">${fmtMoney(p.val)}</td>
      <td class="num">${p.entryPx ? fmtPrice(p.entryPx)
        : `<span class="pending" title="${esc(entryDueHint())}">${entryDueLabel()}</span>`}
        <span class="sub2" title="${esc(insiderPxHint(p))}">сделка ${fmtPrice(p.px)}</span></td>
      <td class="num" title="${esc(curHint(p))}">${fmtPrice(p.cur)}</td>
      <td class="num ${cls(p.chg)}" title="${esc(chgHint(p))}">${fmtPct(p.chg)}</td>
      <td class="num ${cls(p.dd)}">${fmtPct(p.dd, 0)}</td>
      <td class="num">${fmtMoney(p.dv)}</td>
      <td class="muted">${esc(fmtDate(p.exit))}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="11" class="empty">${setAge === 'fresh'
      ? 'Открытых позиций сейчас нет — и это нормально: набор даёт около восьми сигналов в месяц, а в отдельные месяцы не даёт ни одного. Нажмите «Все за 200 дней», чтобы увидеть недавние.'
      : 'За последние 200 дней в набор не попало ни одной сделки.'}</td></tr>`);
  bindSort('#set-table', renderSet);
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

// Набор, переживший портфельную проверку (2026-08). Условия совпадают с проверенными
// буква в букву, включая порог оборота: без него в набор попадают неторгуемые имена,
// на которых он не проверялся.
//
// Что проверялось и почему выжил только один набор. Критерии объявлены ДО отбора: плюс
// в обеих половинах выборки, |t|>=2 на всём периоде, средний состав от 15 бумаг и —
// для ценовых наборов — обязательное превышение над контролем из ВСЕХ бумаг в том же
// ценовом контексте. Последнее и отсеяло почти всё: набор, который не обгоняет «просто
// акции у максимума», описывает моментум, а не инсайдера.
//   · «У 52-нед максимума», удержание 3 мес: альфа +9.1% (t=2.99), половины +6.2/+11.6,
//     сверх контроля +6.1% (t=2.30) — ПРОШЁЛ;
//   · прежний «Сила после отчёта» (+ неделя после отчёта, + не CEO): условие отчёта
//     сжимает состав до 13 бумаг, а превышение над контролем теряет значимость (t=1.72);
//   · прежний «Кластер + докупка»: альфа отрицательна на всех горизонтах (−0.6% при H=3,
//     −1.0% при H=12) и минусует на первой половине — снят.
// Отдельная находка, сознательно НЕ вынесенная в чип: покупка при просадке >30% обгоняет
// такие же просевшие бумаги на +5.6% (t=2.30), но её собственная альфа отрицательна
// (−1.2%). Это фильтр внутри контрарианской корзины, а не повод покупать.
// Каждый пресет включает СВОЙ порог оборота и подразумевает СВОЙ срок удержания —
// вне этой конфигурации его числа не воспроизводятся. Сроки указаны в подписях чипов
// и в блоке «Наборы» на вкладке Статистика.
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
    <th title="Попала ли сделка в рабочий набор">Набор</th><th>Признаки</th>
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
    <td>${r.set === 1 ? '<span class="pill buy" title="Входит в рабочий набор">✓</span>' : ''}</td>
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
    d.setBuys ? `<span class="pill buy" title="Покупок этого эмитента, попавших в рабочий набор">в наборе: ${d.setBuys}</span>` : '',
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
    <th class="num">Δ поз.</th><th class="num">Остаток</th><th>Признаки</th><th title="Сделка прошла все условия рабочего набора">Набор</th></tr>`;
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
    <td>${r.set === 1 ? '<span class="pill buy">✓</span>' : ''}</td>
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
      `В расчёте ${fmtInt(s.n)} покупок с котировками, из них ${fmtInt(s.nOk)} прошли фильтры ` +
      `и ${fmtInt(s.nSet)} попали в рабочий набор.` +
      `<br><b>Альфа считается к трём факторам</b> — рынок, размер и моментум. Моментум обязателен: ` +
      `набор отбирает бумаги у 52-недельного максимума, то есть по построению сидит в победителях ` +
      `моментума, и без этого фактора его результат был бы завышен.` + survivalNote();
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
  renderSetBlock();
  renderStats();
}

// Главная таблица: рабочий набор рядом с эталонами. Строки эталонов нужны, чтобы «+7%»
// читалось в контексте — сама вселенная инсайдерских имён проигрывает индексу.
function mainRow(r, strong) {
  return `<tr class="${strong ? 'row-strong' : 'muted-row'}">
    <td>${strong ? '<b>' + esc(r.name) + '</b>' : esc(r.name)}</td>
    <td class="num">${r.hold ? r.hold + ' мес' : '—'}</td>
    <td class="num ${r.n < 15 ? 'warn-n' : ''}">${r.n}</td>
    ${numCell(r.cagr)}<td class="num">${pctPlain(r.vol, 1)}</td>${numCell(r.dd)}
    <td class="num">${r.sharpe ?? '—'}</td>
    ${numCell(r.spy, true)}${tCell(r.spyT)}<td class="num">${r.ir ?? '—'}</td>
    ${numCell(r.a, true)}${tCell(r.t)}
    <td class="num">${r.beta ?? '—'}</td><td class="num">${r.mom ?? '—'}</td>
    <td class="num">${r.turnover === null || r.turnover === undefined ? '—' : pctPlain(r.turnover)}</td>
    ${numCell(r.net, true)}</tr>`;
}
function renderSetBlock() {
  const s = state.stats;
  const set = s?.set;
  const head = `<tr><th>Портфель</th><th class="num">Держать</th><th class="num" title="средний состав">Бумаг</th>
    <th class="num">CAGR</th><th class="num">Вол.</th><th class="num">Просадка</th><th class="num" title="доходность сверх безрисковой на единицу волатильности">Шарп</th>
    <th class="num" title="превышение над S&P 500 в год">к SPY</th><th class="num">t</th>
    <th class="num" title="информационный коэффициент: превышение на единицу ошибки следования">IR</th>
    <th class="num" title="альфа к рынку, размеру и моментуму">α 3ф</th><th class="num">t</th>
    <th class="num">β</th><th class="num" title="нагрузка на моментум">мом.</th>
    <th class="num">Оборот</th><th class="num" title="к SPY за вычетом издержек">Нетто</th></tr>`;
  const rows = (set ? mainRow(set, true) : '') + (s?.reference ?? []).map(r => mainRow(r, false)).join('');
  $('#set-main').innerHTML = head + rows;

  if (s?.setDef) {
    const d = s.setDef;
    $('#set-def-note').innerHTML =
      `Правило: покупка не ниже <b>${Math.abs(Math.round(d.maxDd * 100))}%</b> от 52-недельного максимума, ` +
      `сумма <b>от ${fmtMoney(d.minVal)}</b>, оборот бумаги <b>от ${fmtMoney(d.minDv)}</b> в день, ` +
      `удержание <b>${d.hold} месяца</b>, равный вес по бумагам. Издержки в колонке «нетто» — ` +
      `${pctPlain(s.roundTrip, 1)} на круг.`;
  }
  if (!set) { $('#set-proof').innerHTML = ''; return; }

  // Доказательства: лестницы порогов, год за годом, затухание при задержке входа
  let html = '';
  if (set.control) {
    html += `<p class="hint"><b>Сверх собственного ценового контекста: ${fmtPct(set.control.ex)} (t=${set.control.t}).</b> ` +
      `Контроль — ${esc(set.control.name)}, собранные тем же способом и на тот же срок. Это и есть ответ на вопрос, ` +
      `добавляет ли инсайдер что-то сверх моментума.</p>`;
  }
  for (const L of set.ladders ?? []) {
    html += `<h4>Порог не подогнан: ${esc(L.name)}</h4><div class="table-wrap"><table class="mini"><tr>` +
      L.rows.map(x => `<th>${esc(x.lab)}</th>`).join('') + '</tr><tr>' +
      L.rows.map(x => `<td class="${cls(x.spy)}">${fmtPct(x.spy)}<br><span class="muted">t=${x.t}, ${x.n} бум.</span></td>`).join('') +
      '</tr></table></div>';
  }
  if (set.lag?.length) {
    html += `<h4>Сигнал живёт около месяца</h4><div class="table-wrap"><table class="mini"><tr>` +
      set.lag.map(x => `<th>вход через ${x.lag} мес</th>`).join('') + '</tr><tr>' +
      set.lag.map(x => `<td class="${cls(x.spy)}">${fmtPct(x.spy)}<br><span class="muted">t=${x.t}</span></td>`).join('') +
      '</tr></table></div>';
  }
  if (set.years?.length) {
    const pos = set.years.filter(y => y.ex > 0).length;
    html += `<h4>Год за годом против индекса — в плюсе ${pos} из ${set.years.length}</h4>` +
      '<div class="table-wrap"><table class="mini"><tr>' +
      set.years.map(y => `<th>${esc(y.y)}</th>`).join('') + '</tr><tr>' +
      set.years.map(y => `<td class="${cls(y.ex)}">${fmtPct(y.ex, 0)}</td>`).join('') + '</tr></table></div>';
  }
  $('#set-proof').innerHTML = html;

  const av = s.avoid ?? [];
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
