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
  if (tab === 'morning') loadMorning().then(startLive); else stopLive();
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
  big:  ['≥$1 млн', 'gray', 'Самая крупная покупка дня от $1 млн: чем крупнее сумма, тем сильнее эффект'],
};
const SKIP = {
  noopen: 'нет открытия — сделка пропущена', noclose: 'нет закрытия — сделка пропущена', nobench: 'нет данных по IWM или SPY — сделка пропущена',
  frozen: 'открытие ровно равно вчерашнему закрытию — котировка застыла, сделка пропущена',
  px: 'открытие ниже $5 — сделка пропущена',
};
const MONTH_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const monthRu = ym => { const [y, m] = String(ym).split('-'); return `${MONTH_NOM[Number(m) - 1] ?? ym} ${y}`; };

let mView = 'main', mDay = null;       // main — основной список (скор ≥2), all — все от $10 млн
// Список берётся из двух мест: страница (ежедневная сборка на GitHub) и воркер (сборка на VPS сразу после индекса EDGAR, на часы раньше).
// Показывается свежее: по дате подачи listFor, при равенстве — по времени сборки builtAt (полный пересчёт GitHub позже VPS и побеждает).
// Любой из двух может не ответить: тогда вторая; старые файлы без listFor уступают.
async function fetchMorning() {
  const fromWorker = async () => {
    const res = await fetch(QUOTES_BASE + '/morning', { cache: 'no-store' });
    if (!res.ok) throw new Error('worker /morning: HTTP ' + res.status);
    return res.json();
  };
  const got = (await Promise.allSettled([fetchJson('morning.json'), fromWorker()]))
    .filter(r => r.status === 'fulfilled' && Array.isArray(r.value?.days)).map(r => r.value);
  if (!got.length) throw new Error('morning: ни страница, ни воркер не ответили');
  return got.sort((a, b) => (b.listFor ?? '').localeCompare(a.listFor ?? '') || (b.builtAt ?? '').localeCompare(a.builtAt ?? ''))[0];
}
async function loadMorning() {
  if (!state.morning) {
    try { state.morning = await fetchMorning(); }
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
    mView = b.dataset.view;
    if (state.morning) renderMorning();
  });
}
$('#m-day').addEventListener('change', e => {
  mDay = e.target.value;
  state.live = null;                       // котировки предыдущей даты к этой не относятся
  if (state.morning) { renderMorning(); pollLive({ force: true }); }
});

// Основной вид — только скор ≥2, остальные от $10 млн уходят в свёрнутый блок ниже; «все» — одним списком по скору
const viewRows = day => (day?.rows ?? []).filter(x => mView === 'all' || x.main);
const restRows = day => mView === 'main' ? (day?.rows ?? []).filter(x => !x.main) : [];
// Денежная сумма со знаком: +$5.4 тыс. (в таблицах панели десятичная точка)
const sgnMoney = v => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const body = a >= 1e6 ? '$' + (a / 1e6).toFixed(2) + ' млн' : a >= 1e3 ? '$' + (a / 1e3).toFixed(1) + ' тыс.' : '$' + Math.round(a);
  return (v > 0 ? '+' : v < 0 ? '-' : '') + body;
};

// ---------- ЖИВЫЕ ЦЕНЫ ----------
// В день D+1 во время торгов утренний список показывает текущую цену и изменение от открытия.
// Yahoo не отдаёт CORS-заголовок, поэтому спросить цену напрямую браузер не может. Посредник — свой
// воркер на краю Cloudflare (worker/index.js): он держит ответ 30 секунд в кэше края, так что
// опрос отсюда не может разогнать обращения к источнику. Слой необязательный: если воркер молчит,
// экран тихо остаётся на снимке и работает целиком.
const QUOTES_BASE = 'https://radar840-quotes.financehub.workers.dev';
const QUOTES_URL = QUOTES_BASE + '/quotes';
const LIVE_PERIOD_MS = 30000;
const ySym = t => String(t).replace(/[./]/g, '-');   // BRK.B -> BRK-B, как в сборке
let liveTimer = null;
state.live = null;                                    // последний ответ воркера, null — живого слоя нет
const onMorning = () => { const h = location.hash; return h === '' || h.startsWith('#morning') || h.startsWith('#screener'); };
// Дата котировки по Нью-Йорку: цена принадлежит своей сессии, а не местному дню
const nyDate = sec => new Date(sec * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
// Следующий рабочий день после подачи — ожидаемый D+1 (праздники не знаем: в праздник живой слой просто не включится)
function nextBusinessDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}
// Выбранный день, торги D+1 которого ещё не закрыты в снимке: только по нему идёт опрос
const liveDay = () => { const d = state.morning?.days.find(x => x.date === mDay); return d && !d.done && d.rows.length ? d : null; };
// Котировка годится, только если она за сегодняшнюю сессию D+1 и идут торги (или уже закрылись):
// до начала сессии v7 отдаёт открытие и время прошлого дня, и «изменение от открытия» было бы чужим.
function liveOf(sym, d1) {
  const x = state.live?.quotes?.[ySym(sym)];
  if (!x || typeof x.p !== 'number' || typeof x.o !== 'number' || !(x.o > 0)) return null;
  if (x.st !== 'REGULAR' && x.st !== 'POST') return null;
  return x.t && nyDate(x.t) === d1 ? x : null;
}
const MARKET_STATE = { REGULAR: 'торги идут', POST: 'торги закрыты' };

// force — разовый опрос по явному поводу (экран только что отрисован, вкладка стала видимой).
// Требование видимости относится к ПОВТОРНОМУ опросу по таймеру: именно он в фоновой вкладке
// тянул бы источник сутками.
async function pollLive({ force = false } = {}) {
  if ((!force && document.visibilityState !== 'visible') || !onMorning()) return;
  const day = liveDay();
  if (!day) { if (state.live) { state.live = null; renderDay(); } return; }
  // Спрашиваем весь список выбранного дня и IWM для сравнения: один запрос, предел воркера — 50 тикеров
  const syms = [...new Set([...day.rows.map(r => r.t), 'IWM'])].slice(0, 50);
  try {
    const res = await fetch(`${QUOTES_URL}?symbols=${encodeURIComponent(syms.join(','))}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    if (!body?.quotes) throw new Error('пустой ответ');
    state.live = body;
  } catch (error) {
    // Тихо: снимок остаётся на месте. Единственный след — столбцы живых цен не появляются.
    state.live = null;
    console.warn('[live] котировки недоступны:', error?.message || error);
  }
  if (onMorning()) renderDay();
}
function startLive() {
  if (liveTimer) return;
  pollLive({ force: true });
  liveTimer = setInterval(pollLive, LIVE_PERIOD_MS);
}
function stopLive() { clearInterval(liveTimer); liveTimer = null; }
// Опрос идёт только у видимой вкладки: фоновая вкладка сутками тянула бы источник впустую.
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && onMorning()) startLive();
  else stopLive();
});

// Полоса живого счётчика: те же числа, что в проверке, но по спискам, опубликованным с запуска.
// Две строки — к IWM и к S&P: внутри дня IWM отстаёт от S&P, и в живом периоде разница доходит до
// половины перевеса, поэтому показываем оба эталона сразу. Тест по дням — сделки одного дня не
// независимы (общий рынок), поэтому t считается по средним дням. Издержки у каждой сделки свои.
function renderCounter() {
  const c = state.morning.counter, s = mView === 'main' ? c.main : c.all;
  const head = `<div class="strip-head"><b>Живой счётчик</b> с ${esc(fmtDate(c.from))} · ${mView === 'main' ? 'основной список' : 'все от $10 млн'}`
    + ` · открытие → закрытие D+1${c.upTo ? ' · по ' + esc(fmtDate(c.upTo)) : ''}`
    + `${s?.n ? ' · ' + plural(s.n, 'сделка', 'сделки', 'сделок') + ' за ' + plural(s.days, 'день', 'дня', 'дней') : ''}</div>`;
  if (!s?.n) {
    $('#m-counter').innerHTML = head + '<div class="strip-empty">Сделок пока нет — первый результат появится после первого торгового дня по спискам.</div>';
    return;
  }
  const stake = state.morning.params?.stake ?? 1e4;
  const co = c.costs ?? {};
  const costHint = `Среднее за вычетом издержек каждой сделки: ${pctPlain(co.hi, 2)} на круг при обороте от ${fmtMoney(co.split ?? 3e7)}, ${pctPlain(co.lo, 2)} при обороте $10–30 млн; в среднем по сделкам ${pctPlain(s.cost, 3)}`;
  const strong = t => (t !== null && t !== undefined && Math.abs(t) >= 2 ? cls(t) : 'muted');
  const row = (lab, m, hint) => `<tr><td class="lab" title="${esc(hint)}">${esc(lab)}</td>`
    + `<td class="${cls(m.mean)}">${fmtPct(m.mean, 2)}</td><td class="${cls(m.median)}">${fmtPct(m.median, 2)}</td>`
    + `<td>${Math.round(m.win * 100)}%</td><td class="c-t ${strong(m.tDays)}">${m.tDays === null || m.tDays === undefined ? '—' : m.tDays}</td>`
    + `<td class="${cls(m.net)}">${fmtPct(m.net, 2)}</td><td class="${cls(m.cumNet)}">${sgnMoney(m.cumNet * stake)}</td></tr>`;
  $('#m-counter').innerHTML = head + `<table class="strip-t"><tr><th></th>`
    + `<th title="Доходность открытие → закрытие минус внутридневная доходность эталона того же дня">среднее</th>`
    + `<th title="Медианная сделка: распределение скошено, среднее держат немногие крупные выигрыши">медиана</th>`
    + `<th title="Доля сделок, обогнавших эталон в тот же день">в плюсе</th>`
    + `<th class="c-t" title="Среднее за день, затем t-статистика по дням. От нуля отличимо при |t| ≥ 2">t по дням</th>`
    + `<th title="${esc(costHint)}">после издержек</th>`
    + `<th title="${esc(`Итог всех ${s.n} сделок после издержек, если в каждую вложено по ${fmtMoney(stake)}. Это не доходность портфеля: сделки идут в разные дни, и одни и те же деньги работают снова и снова`)}">на ${esc(fmtMoney(stake))} в сделке</th></tr>`
    + row('к IWM', s.iwm, 'Эталон хеджа: Russell 2000')
    + row('к S&P', s.spy, 'Эталон рынка: SPY')
    + '</table>';
}

// Плашка всплеска: z-оценка числа покупающих эмитентов за три месяца к 36 прошлым. Справка: проверка
// не доказала, что правило «возврат в рынок» выигрывает у 837 (просадка хуже, Шарп не растёт), и панель
// перевеса не обещает. Справа — z за 60 месяцев.
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

// Время котировки — по Нью-Йорку, как и сама сессия
function liveStamp() {
  const at = state.live?.at;
  if (!at) return null;
  const time = new Date(at * 1000).toLocaleTimeString('ru-RU', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
  const st = Object.values(state.live.quotes ?? {})[0]?.st;
  return `живые цены · ${time} Нью-Йорк${MARKET_STATE[st] ? ' · ' + MARKET_STATE[st] : ''}${state.live.stale ? ' · источник молчит, показано последнее' : ''}`;
}
function dayNote(day, rows, liveOn = false) {
  if (!day) return '';
  if (!rows.length) return '';
  if (liveOn) return liveStamp() ?? '';
  if (!day.done) return day.entry ? '' : 'торги D+1 ещё не прошли';
  const res = rows.filter(x => x.ex !== undefined);
  if (!res.length) return `торги ${fmtDate(day.entry)}: результатов нет`;
  const avg = k => res.reduce((a, x) => a + x[k], 0) / res.length;
  const up = res.filter(x => x.ex > 0).length;
  return `торги ${fmtDate(day.entry)}: среднее ${fmtPct(avg('ex'), 2)} к IWM, ${fmtPct(avg('exS'), 2)} к S&P, в плюсе ${up} из ${res.length}`;
}

// Вечерняя схема на бумаге против текущей. Формы, принятые EDGAR с 16:00 до 20:00 по Нью-Йорку, «покупаются» по ask
// через 5, 15 и 30 минут после времени приёма и «продаются» на открытии или закрытии D+1; рядом — текущая схема
// (открытие → закрытие D+1) на тех же событиях. Копится на бумаге 2–3 месяца (журнал с VPS, ветка paper), прежде чем
// строить настоящий контур. Всё считает сборка (scripts/lib/paper.mjs); страница только раскладывает.
function renderPaper() {
  const box = $('#m-paper'), pp = state.morning?.paper;
  if (!pp) { box.hidden = true; return; }
  box.hidden = false;
  const s = mView === 'main' ? pp.main : pp.all;
  const stake = pp.stake ?? 1e4;
  const cov = pp.cov ?? {};
  const head = '<div class="paper-head"><b>Вечерняя схема на бумаге против текущей</b> · с ' + esc(fmtDate(pp.from))
    + ' · ' + (mView === 'main' ? 'основной список' : 'все от $10 млн')
    + ' · к IWM, после издержек вечерней схемы ' + pctPlain(pp.cost, 2) + ' на круг, текущей — по уровню оборота'
    + (pp.main || pp.all ? ' · ' + plural(((mView === 'main' ? pp.main : pp.all)?.n) ?? 0, 'сделка', 'сделки', 'сделок') + ' на одном наборе событий' : '') + '</div>';
  const covTxt = 'Событий ' + cov.events + ' · в списках ' + cov.listed + ' · D+1 закрыт ' + cov.closed + ' · полный набор котировок ' + cov.complete
    + (cov.estShare ? ' · цена по оценке спреда в ' + Math.round(cov.estShare * 100) + '% моментов' : '');
  if (!s?.n) {
    box.innerHTML = head + '<div class="strip-empty">Первые результаты — когда закроется D+1 у событий с полным набором котировок. ' + esc(covTxt) + '</div>';
    return;
  }
  const row = (lab, m, hint, cur) => '<tr' + (cur ? ' class="cur"' : '') + '><td class="lab" title="' + esc(hint) + '">' + esc(lab) + '</td>'
    + '<td class="' + cls(m.mean) + '" title="До издержек ' + fmtPct(m.gross, 2) + '">' + fmtPct(m.mean, 2) + '</td>'
    + '<td class="' + cls(m.median) + '">' + fmtPct(m.median, 2) + '</td><td>' + Math.round(m.win * 100) + '%</td>'
    + '<td class="' + cls(m.cumNet) + '">' + sgnMoney(m.cumNet * stake) + '</td></tr>';
  let rows = row('Сейчас: открытие → закрытие', s.cur, 'Текущая схема на тех же событиях: покупка на открытии D+1, продажа на закрытии', true);
  for (const m of Object.keys(s.e)) rows += row('+' + m + ' мин → закрытие D+1', s.e[m].close, 'Покупка по ask через ' + m + ' минут после приёма формы, продажа на закрытии D+1', false);
  for (const m of Object.keys(s.e)) rows += row('+' + m + ' мин → открытие D+1', s.e[m].open, 'Покупка по ask через ' + m + ' минут после приёма формы, продажа на открытии D+1: сколько ночного скачка взято', false);
  box.innerHTML = head + '<table class="strip-t paper-t"><tr><th></th><th title="Доходность к IWM за то же окно после издержек">среднее</th><th>медиана</th><th>в плюсе</th>'
    + '<th title="Итог всех сделок после издержек при $' + (stake / 1000) + ' тыс. в каждой: не доходность портфеля">на ' + esc(fmtMoney(stake)) + ' в сделке</th></tr>' + rows + '</table>'
    + '<div class="paper-foot">' + esc(covTxt) + '. Сравнение — на одном наборе событий: только с полным набором котировок.</div>';
}

function renderMorning() {
  renderCounter();
  renderSurge();
  renderPaper();
  const days = state.morning.days;
  // Выбор даты: десять последних дат подачи, число бумаг выбранного списка в подписи
  $('#m-day').innerHTML = days.map(d => `<option value="${esc(d.date)}"${d.date === mDay ? ' selected' : ''}>${esc(fmtDate(d.date))} · ${viewRows(d).length}</option>`).join('');
  renderDay();
}

// Скор из четырёх баллов — в подсказке видно, из чего сложился
function scoreHint(x) {
  const p = state.morning.params ?? {};
  const parts = [
    (x.mx ?? x.val) >= (p.scoreVal ?? 1e5) && `крупнейшая покупка дня от ${fmtMoney(p.scoreVal ?? 1e5)}`,
    (x.mx ?? x.val) >= (p.bigVal ?? 1e6) && `от ${fmtMoney(p.bigVal ?? 1e6)}`,
    (x.tags ?? []).includes('off') && 'среди покупателей офицер',
    (x.tags ?? []).includes('deep') && 'просадка глубже 30%',
  ].filter(Boolean);
  return `Скор ${x.score} из 4: ${parts.join(' + ') || 'ни одного условия'}`;
}

// Таблица бумаг дня: основная и свёрнутая «остальные» строятся одной функцией. liveOn/past задают
// состав столбцов результата; d1 и bq — ожидаемый день входа и котировка IWM живого слоя.
function dayTable(rows, { past, liveOn, d1, bq }) {
  const cols = past || liveOn;
  // Классы c-* нужны узкому экрану: «Кто», «Оборот», «Открытие» и «Закрытие» там прячутся
  const th = `<tr><th>Бумага</th><th class="c-who">Кто</th>
    <th class="num c-score" title="Скор — сумма четырёх баллов: самая крупная покупка дня от $100 тыс.; от $1 млн; среди покупателей офицер (в том числе директор-офицер); просадка от 52-недельного максимума глубже 30% хотя бы в одной из покупок. Основной список — от 2">Скор</th>
    <th class="num c-sum" title="Сумма всех покупок бумаги в этот день подачи (покупки от $10 тыс., прошедшие гейты). Баллы за сумму — по самой крупной из них">Сумма</th>
    <th class="num c-dd" title="Насколько ниже 52-недельного максимума была цена на дату сделки">От макс.</th>
    <th class="num c-dv" title="Медиана дневного долларового оборота бумаги за 20 торговых дней, последний из которых — день подачи">Оборот</th>
    <th class="c-ses" title="Когда форма принята на EDGAR (время по Нью-Йорку): после закрытия — с 16:00. Ночью форм принимается больше всего (61%), и у них день D+1 сильнее: +0.34% против +0.21% у принятых в торги">Приём</th>
    <th class="c-marks">Пометки</th>${cols ? `<th class="num c-open" title="Цена открытия следующего торгового дня — вход">Открытие</th>
    <th class="num c-close" title="${liveOn ? 'Текущая цена и изменение от открытия; обновляется каждые 30 секунд, пока вкладка открыта' : 'Цена закрытия того же дня — выход'}">${liveOn ? 'Сейчас' : 'Закрытие'}</th>
    <th class="num" title="${liveOn ? 'Изменение от открытия минус изменение IWM от открытия' : 'Доходность открытие → закрытие минус доходность IWM за тот же день'}">К IWM</th>` : ''}</tr>`;
  return th + rows.map(x => {
    const who = x.nWho > 1 ? `${esc(trunc(x.who[0], 20))} <span class="sub2-inline">и ещё ${x.nWho - 1}</span>` : esc(trunc(x.who[0] ?? '—', 24));
    const marks = (x.tags ?? []).map(t => MTAG[t] ? `<span class="pill ${MTAG[t][1]}" title="${esc(MTAG[t][2])}">${esc(MTAG[t][0])}</span>` : '').join(' ');
    // Сделка пропущена — причина в подсказке; открытие и закрытие у такой строки пусты
    const lq = liveOn ? liveOf(x.t, d1) : null;
    const lchg = lq ? lq.p / lq.o - 1 : null;
    const lex = lq && bq ? lchg - (bq.p / bq.o - 1) : null;
    const result = liveOn ? (lq
      ? `<td class="num c-open">${fmtPrice(lq.o)}</td><td class="num c-close">${fmtPrice(lq.p)}<span class="sub2 ${cls(lchg)}">${fmtPct(lchg, 2)}</span></td>`
        + `<td class="num ${cls(lex)}" title="${esc(lex === null ? 'IWM сейчас недоступен' : `От открытия ${fmtPct(lchg, 2)}, IWM ${fmtPct(bq.p / bq.o - 1, 2)}`)}">${fmtPct(lex, 2)}</td>`
      : `<td class="num c-open muted">—</td><td class="num c-close muted">—</td><td class="num muted" title="Живой цены по этой бумаге сейчас нет">—</td>`)
    : !past ? '' : x.skip
      ? `<td class="num c-open muted">—</td><td class="num c-close muted">—</td>`
        + `<td class="num muted" title="${esc(SKIP[x.skip] ?? x.skip)}">пропуск</td>`
      : `<td class="num c-open">${fmtPrice(x.o)}</td><td class="num c-close">${fmtPrice(x.c)}</td>`
        + `<td class="num ${cls(x.ex)}" title="${esc(`Сделка ${fmtPct(x.r, 2)}, IWM ${fmtPct(x.b, 2)}, S&P ${fmtPct(x.bs, 2)} (к S&P ${fmtPct(x.exS, 2)})`)}">${fmtPct(x.ex, 2)}</td>`;
    const sesLab = { post: 'после закрытия', rth: 'в торги', pre: 'до открытия' }[x.ses] ?? null;
    const sesTitle = x.at ? `Форма принята на EDGAR ${x.at.replace('T', ' ')} по Нью-Йорку` : 'Время приёма неизвестно';
    const roleLine = `${esc(ROLE_LABEL[x.role] ?? x.role)}${x.n > 1 ? ' · ' + plural(x.n, 'покупка', 'покупки', 'покупок') : ''}`;
    return `<tr>
      <td><a class="tick" href="#ticker/${encodeURIComponent(x.t)}">${esc(x.t)}</a>
        <span class="sub2 nm" title="${esc(x.name)}">${esc(trunc(x.name, 28))}</span>
        <span class="sub2 who-m">${esc(trunc(x.who[0] ?? '—', 18))}${x.nWho > 1 ? ' +' + (x.nWho - 1) : ''} · ${roleLine}</span>
        <span class="marks-m">${marks}${sesLab ? ` <span class="pill gray" title="${esc(sesTitle)}">${esc(sesLab)}</span>` : ''}</span></td>
      <td class="c-who">${who}<span class="sub2">${roleLine}</span></td>
      <td class="num c-score" title="${esc(scoreHint(x))}"><b>${x.score}</b></td>
      <td class="num c-sum">${fmtMoney(x.val)}</td>
      <td class="num c-dd ${cls(x.dd)}">${fmtPct(x.dd, 0)}</td>
      <td class="num c-dv">${fmtMoney(x.dv)}</td>
      <td class="c-ses" title="${esc(sesTitle)}">${sesLab ? `${esc(x.at.slice(11, 16))}<span class="sub2">${esc(sesLab)}</span>` : '<span class="muted">—</span>'}</td>
      <td class="marks c-marks">${marks}</td>${result}</tr>`;
  }).join('');
}

// Таблица выбранного дня. Отдельно от renderMorning: опрос живых цен перерисовывает только её,
// не трогая выпадающий список даты (он закрывался бы под рукой).
function renderDay() {
  const days = state.morning.days;
  const day = days.find(d => d.date === mDay) ?? null;
  const rows = viewRows(day), rest = restRows(day);
  const d1 = day ? nextBusinessDay(day.date) : null;
  const liveOn = !!day && !day.done && [...rows, ...rest].some(x => liveOf(x.t, d1));
  const bq = liveOn ? liveOf('IWM', d1) : null;
  const ctx = { past: !!day?.done, liveOn, d1, bq };
  $('#m-note').textContent = dayNote(day, rows, liveOn);
  const live = liveOn ? ' live' : '';
  $('#m-table').className = 'morning' + live;
  const cols = ctx.past || liveOn;
  $('#m-table').innerHTML = rows.length ? dayTable(rows, ctx)
    : `<tr><td colspan="${cols ? 11 : 8}" class="empty">${days.length
      ? (mView === 'main' ? 'В этот день бумаг основного списка нет — он бывает пустым.' : 'В этот день подходящих покупок нет.') : 'Данные ещё не собраны.'}</td></tr>`;
  // Остальные бумаги от $10 млн (скор 0–1) — свёрнуты ниже: без других признаков покупки на $10–100 тыс. дают около нуля
  const box = $('#m-rest-box');
  box.hidden = !rest.length;
  if (rest.length) {
    $('#m-rest-sum').textContent = `Остальные бумаги от $10 млн, скор 0–1: ${rest.length}`;
    $('#m-rest').className = 'morning' + live;
    $('#m-rest').innerHTML = dayTable(rest, ctx);
  }
  $('#m-foot').innerHTML = 'Только заявки на аукционы: MOO до 9:28 и MOC до 15:50 по Нью-Йорку. Около 60% перевеса дня набирается в первые 5 минут — '
    + 'покупка по рынку после открытия его съедает. Сумма на бумагу одинаковая. Скор и итоги проверки — на вкладке <a href="#stats">Статистика</a>.';
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
