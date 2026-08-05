// Инсайдерский радар — логика интерфейса. ES-модуль, без зависимостей.
import { PriceChart, MarketChart, fmtPrice, fmtInt, fmtMoney, fmtPct } from './charts.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const trunc = (s, n) => String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? '');
const cls = v => v === null || v === undefined ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '';

const ROLE_LABEL = { F: 'CFO', C: 'CEO/През', O: 'Офицер', D: 'Директор', T: '10%', X: 'Прочее' };
// Компоненты скора v4 (scripts/lib/scoring.mjs). Кластера, прироста позиции, трек-рекорда
// и штрафа за размер здесь больше нет — они не пережили портфельную проверку.
const PART_LABEL = {
  oppo: 'оппортунистическая, не рутина', near: 'у 52-недельного максимума',
  role: 'роль', small: 'малое имя', firstEver: 'первая покупка',
};
// Признаки в Ленте обозначаются одно-двухбуквенными кодами, чтобы таблица не требовала
// горизонтальной прокрутки. Расшифровка — в легенде под фильтрами и в подсказке каждой метки.
// Формат: код -> [название, пояснение, стиль метки]. Коды не должны повторяться —
// проверяется самотестом (scripts/selftest.mjs, «легенда признаков без коллизий»).
export const FEAT = {
  wo:            ['О',  'После отчёта', 'Покупка в первую неделю после публикации 10-Q/10-K — на свежей публичной информации', 'buy'],
  high:          ['М',  'У максимума', 'Акция не более чем на 5% ниже 52-недельного максимума: инсайдер платит высокую цену', 'buy'],
  'first-ever':  ['1',  'Первая покупка', 'Первая покупка этого инсайдера в наших данных', 'buy'],
  // Помечен нейтрально сознательно: на проверке вне выборки признак дал отрицательный
  // эффект (−2.4%) и в скоринг v3 не вошёл — зелёная метка вводила бы в заблуждение
  'first-in-3y': ['3г', 'Не покупал 3 года', 'Первая покупка за три года. Проверку вне выборки признак НЕ прошёл (−2.4%) и в скор не входит — показан справочно', 'gray'],
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
  feed: null, clusters: null, stats: null, meta: null, insiders: null,
  tickersIndex: null, tickerData: null, chart: null, feedShown: 100, sort: null, preset: 'all',
};
async function fetchJson(path) {
  const res = await fetch('data/' + path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(path + ': HTTP ' + res.status);
  return res.json();
}

// ---------- Роутинг ----------
const tabs = document.querySelectorAll('.tabs a');
const TABS = ['screener', 'feed', 'ticker', 'insiders', 'market', 'stats'];
function route() {
  const hash = location.hash || '#screener';
  let [tab, arg] = hash.slice(1).split('/');
  if (!TABS.includes(tab)) { tab = 'screener'; arg = undefined; }  // неизвестный якорь — не белый экран
  for (const a of tabs) a.classList.toggle('active', a.dataset.tab === tab);
  for (const p of document.querySelectorAll('.tab-panel')) p.classList.toggle('active', p.id === 'tab-' + tab);
  if (tab === 'screener') loadScreener();
  if (tab === 'feed') loadFeed(arg);
  if (tab === 'insiders') loadInsiders();
  if (tab === 'market') loadMarket();
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
      `<span class="badge">бэктест <b>${fmtInt(m.backtest?.rows)}</b></span>`,
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
function scoreCell(score, parts) {
  if (score === null || score === undefined) return '<span class="muted">—</span>';
  return `<span class="score" data-score="${score}" data-parts='${esc(JSON.stringify(parts ?? {}))}' title="Клик — разбор компонент, повторный клик — обратно">${score}</span>`;
}
// Разбор компонент разворачивается и сворачивается по клику: элемент не заменяется,
// а меняет содержимое, поэтому число всегда можно вернуть.
function bindScoreTips(sel) {
  for (const s of document.querySelectorAll(sel + ' .score')) {
    s.addEventListener('click', () => {
      if (s.dataset.open === '1') {
        s.textContent = s.dataset.score;
        s.classList.remove('score-open');
        s.dataset.open = '0';
        return;
      }
      const parts = JSON.parse(s.dataset.parts);
      const txt = Object.entries(parts).filter(([, v]) => v !== 0)
        .map(([k, v]) => `${PART_LABEL[k] ?? k} ${v > 0 ? '+' : ''}${v}`).join(' · ');
      s.textContent = txt || 'нет компонент';
      s.classList.add('score-open');
      s.dataset.open = '1';
    });
  }
}
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
  if (r.wo) out.push(featPill('wo'));
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
  const signal = ['wo', 'high', 'first-ever', 'first-in-3y'].map(k => FEAT[k]);
  const info = ['pledge', 'trust', 'indirect', 'planned-mark', 'no-history', 'no-price'].map(k => FEAT[k]);
  const labels = state.meta?.gates?.labels ?? {};
  const drops = Object.entries(DROP_CODE)
    .filter(([k]) => labels[k])
    .map(([k, code]) => [code, labels[k], labels[k], 'warn']);
  const html = group('Сигнальные:', signal) + group('Информационные:', info) +
    (drops.length ? group('Причины отсева (видны при показе отсеянных):', drops) : '');
  for (const b of boxes) if (b.dataset.done !== '1') { b.innerHTML = html; b.dataset.done = '1'; }
}

// ---------- СКРИНЕР ----------
const PRESETS = {
  all: { f: () => true, hint: 'Активные кластеры: ≥2 независимых инсайдера покупали в одной цепочке (разрыв ≤30 дней), последняя покупка за 90 дней. Участники склеены по совместным подачам, поэтому фонд с его партнёрами считается одним покупателем, а не тремя.' },
  strong: { f: c => c.dense >= 3, hint: 'Кластеры из ≥3 независимых инсайдеров в окне 14 дней — сильнейший из документированных паттернов (Alldredge, 2019).' },
  cfo: { f: c => c.role === 'F' || c.role === 'C', hint: 'Кластеры с участием CFO или CEO. Покупки CFO исторически информативнее покупок CEO (Wang, Shin, Francis, 2012).' },
  inflect: { f: c => c.inflect, hint: 'Кластеры, где хотя бы один инсайдер сломал собственный паттерн — первая покупка за три года или вообще первая.' },
  track: { f: c => c.track, hint: 'Кластеры с участием инсайдера, чьи прошлые покупки обгоняли бенчмарк в ≥60% случаев (трек-рекорд считается только по закрытым окнам до даты этой сделки).' },
  dip: { f: c => c.dd !== null && c.dd <= -0.3, hint: 'Покупки при просадке ≥30% от 52-недельного максимума — контрарианская ставка инсайдера против рынка.' },
  high: { f: c => c.dd !== null && c.dd >= -0.05, hint: 'Покупки вблизи 52-недельного максимума — инсайдер платит высокую цену, что редко бывает случайным (паттерн InsideArbitrage).' },
  small: { f: c => c.bucket === 'small' || c.bucket === 'micro', hint: 'Малоликвидные имена: исторически именно здесь эффект сильнее всего — но и проскальзывание выше, а ёмкость мала.' },
};
for (const b of document.querySelectorAll('#preset-group .chip')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('#preset-group .chip')) x.classList.remove('active');
    b.classList.add('active');
    state.preset = b.dataset.preset;
    state.sort = null;
    renderClusters();
  });
}
async function loadScreener() {
  if (!state.clusters) {
    try { state.clusters = await fetchJson('clusters.json'); }
    catch { $('#clusters-table').innerHTML = '<tr><td>Данные ещё не собраны.</td></tr>'; return; }
  }
  renderClusters();
}
function renderClusters() {
  const p = PRESETS[state.preset] ?? PRESETS.all;
  $('#screener-hint').textContent = p.hint;
  const rows = sortRows(state.clusters.filter(p.f));
  const th = `<tr>
    <th>Тикер</th><th>Компания</th><th class="num" title="Независимых физлиц в плотном окне 14 дней">Инсайдеров</th>
    <th class="num">Покупок</th><th>Период</th>
    <th class="num sortable" data-sort="totalVal">Объём ⇅</th><th class="num">Ср. цена</th>
    <th class="num">Тек. цена</th><th class="num sortable" data-sort="chg">Изм. ⇅</th>
    <th class="num sortable" data-sort="dd" title="Просадка от 52-недельного максимума на дату последней покупки">Контекст ⇅</th>
    <th>Ликвидность</th><th>Признаки</th>
    <th class="num sortable" data-sort="score" title="Скор сигнала; клик по значению раскрывает компоненты">Скор ⇅</th>
    <th>Покупатели</th></tr>`;
  $('#clusters-table').innerHTML = th + (rows.length ? rows.map(c => `<tr>
    <td><a class="tick" href="#ticker/${encodeURIComponent(c.t)}">${esc(c.t)}</a></td>
    <td title="${esc(c.name)}">${esc(trunc(c.name, 26))}</td>
    <td class="num"><span class="pill buy">×${c.dense}</span>${c.n > c.dense ? `<span class="muted"> /${c.n}</span>` : ''}</td>
    <td class="num">${c.nTrades}</td>
    <td>${esc(c.first)} → ${esc(c.last)}</td>
    <td class="num">${fmtMoney(c.totalVal)}</td>
    <td class="num">${fmtPrice(c.vwap)}</td>
    <td class="num">${fmtPrice(c.cur)}</td>
    <td class="num ${cls(c.chg)}">${fmtPct(c.chg)}</td>
    <td class="num ${cls(c.dd)}">${fmtPct(c.dd, 0)}</td>
    <td>${esc(c.bucket)}</td>
    <td>${c.inflect ? '<span class="pill buy" title="Инсайдер сломал собственный паттерн">слом</span> ' : ''}${c.track ? '<span class="pill buy" title="Среди покупателей — инсайдер с успешным трек-рекордом">трек</span>' : ''}</td>
    <td class="num">${scoreCell(c.score, c.parts)}</td>
    <td class="score-detail">${c.buyers.slice(0, 4).map(b => `${esc(b.name)} <span class="muted">(${esc(ROLE_LABEL[topRoleOf(b.rel)] ?? '')})</span>`).join('; ')}${c.buyers.length > 4 ? ' …' : ''}</td>
  </tr>`).join('') : '<tr><td colspan="14" class="muted">Под этот фильтр сейчас нет активных кластеров.</td></tr>');
  $('#screener-count').textContent = rows.length ? `${rows.length} активных кластеров` : '';
  bindSort('#clusters-table', renderClusters);
  bindScoreTips('#clusters-table');
}
function topRoleOf(rel) { for (const c of ['F', 'C', 'O', 'D', 'T', 'X']) if ((rel ?? '').includes(c)) return c; return 'X'; }

// ---------- ЛЕНТА ----------
const ff = {
  roles: new Set(), cluster: false, gate: 'ok', q: '', recipe: null,
  // Диапазоны «от/до»: пустое поле = граница не задана. Подсказки в placeholder
  // показывают рекомендованные значения, но сами по себе не применяются.
  valMin: null, valMax: null, scoreMin: null, scoreMax: null, downMin: null, downMax: null,
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
bindRange('#f-score-min', 'scoreMin');
bindRange('#f-score-max', 'scoreMax');
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
const RECIPE_MIN_DV = 3e6;
const liquid = r => r.dv !== null && r.dv >= RECIPE_MIN_DV;
const RECIPES = {
  // держать 3 месяца: +9.1% альфы (t=3.45), сверх момент-контроля +6.6% (t=2.67)
  high: r => liquid(r) && r.dd !== null && r.dd >= -0.05,
  // держать 12 месяцев: +5.1% (t=2.06), концентрированный вариант — около 83 бумаг
  score38: r => liquid(r) && r.score !== null && r.score >= 38,
  // держать 12 месяцев: +3.1% (t=2.14), широкий вариант — около 245 бумаг
  score28: r => liquid(r) && r.score !== null && r.score >= 28,
  // СРАВНИТЕЛЬНЫЙ: собственная альфа −0.9%, но это на 5.9 п.п. (t=2.27) лучше такой же
  // просевшей вселенной. Инструмент отбора внутри контрарианской корзины, не покупка.
  deep: r => liquid(r) && r.dd !== null && r.dd < -0.3,
};
for (const b of document.querySelectorAll('#f-recipes .chip')) {
  b.addEventListener('click', () => {
    const key = b.dataset.recipe;
    for (const x of document.querySelectorAll('#f-recipes .chip')) x.classList.remove('active');
    if (key === 'reset' || ff.recipe === key) ff.recipe = null;
    else { ff.recipe = key; b.classList.add('active'); }
    renderFeed(true);
  });
}
for (const b of document.querySelectorAll('#f-roles .chip')) {
  b.addEventListener('click', () => {
    b.classList.toggle('active');
    ff.roles = new Set([...document.querySelectorAll('#f-roles .chip.active')].map(x => x.dataset.role));
    renderFeed(true);
  });
}
$('#f-gate').addEventListener('change', e => { ff.gate = e.target.value; renderFeed(true); });
$('#f-cluster').addEventListener('change', e => { ff.cluster = e.target.checked; renderFeed(true); });
{
  let deb;
  $('#f-search').addEventListener('input', e => {
    clearTimeout(deb);
    deb = setTimeout(() => { ff.q = e.target.value.trim().toLowerCase(); renderFeed(true); }, 200);
  });
}
$('#feed-more').addEventListener('click', () => { state.feedShown += 200; renderFeed(false); });

async function loadFeed(arg) {
  if (!state.feed) {
    try { state.feed = await fetchJson('feed.json'); }
    catch { $('#feed-table').innerHTML = '<tr><td>Данные ленты ещё не собраны.</td></tr>'; return; }
  }
  // Подписи наборов живут в stats.json — подтягиваем их и на Ленте, не дожидаясь,
  // пока пользователь откроет Статистику. Ошибка загрузки не мешает ленте работать.
  if (!state.stats) {
    try { state.stats = await fetchJson('stats.json'); } catch { /* подписи останутся краткими */ }
  }
  renderRecipes();
  renderFeatLegend();
  if (arg) {   // переход из рейтинга инсайдеров: #feed/cik:12345
    const m = /^cik:(\d+)$/.exec(arg);
    if (m) { ff.cikFilter = Number(m[1]); ff.gate = 'all'; $('#f-gate').value = 'all'; }
  } else ff.cikFilter = null;
  renderFeed(true);
}
function feedFiltered() {
  const recipe = ff.recipe ? RECIPES[ff.recipe] : null;
  return state.feed.filter(r =>
    (!recipe || recipe(r)) &&
    (ff.gate === 'all' || (ff.gate === 'ok' ? !r.drop : !!r.drop)) &&
    (!ff.cikFilter || (r.ciks ?? []).includes(ff.cikFilter)) &&
    (!ff.roles.size || ff.roles.has(r.role)) &&
    inRange(r.val, ff.valMin, ff.valMax) &&
    inRange(r.score, ff.scoreMin, ff.scoreMax) &&
    inRange(r.dOwn, ff.downMin, ff.downMax) &&
    (!ff.cluster || r.cl >= 2) &&
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
    <th class="num">Класт.</th><th>Признаки</th>
    <th class="num sortable" data-sort="score" title="Клик по значению раскрывает компоненты">Скор ⇅</th>
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
    <td class="num">${r.cl >= 2 ? `<span class="pill buy">×${r.cl}</span>` : ''}</td>
    <td>${featureCell(r)}</td>
    <td class="num">${scoreCell(r.score, r.parts)}</td>
    <td class="num ${cls(r.w1)}">${fmtPct(r.w1)}</td>
    <td class="num ${cls(r.m1)}">${fmtPct(r.m1)}</td>
    <td class="num ${cls(r.m6)}">${fmtPct(r.m6)}</td>
    <td class="num">${fmtPrice(r.cur)}</td>
    <td class="num ${cls(r.chg)}">${fmtPct(r.chg)}</td>
  </tr>`).join('') : `<tr><td colspan="19" class="muted">${ff.cikFilter
      ? 'У этого инсайдера нет сделок за последние 200 дней — лента хранит только свежий период, а рейтинг считается по всей истории.'
      : 'Ничего не найдено.'}</td></tr>`);
  $('#feed-count').textContent = `${Math.min(state.feedShown, rows.length)} из ${rows.length}` + (ff.cikFilter ? ' · фильтр по инсайдеру' : '');
  $('#feed-more').disabled = state.feedShown >= rows.length;
  bindSort('#feed-table', renderFeed);
  bindScoreTips('#feed-table');
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
    d.sellRatio !== null ? `<span class="pill gray" title="Продаж на одну покупку у этого эмитента: показывает, где продажи — рутина, а где событие">продаж/покупок ${d.sellRatio}</span>` : '',
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
    <th class="num">Δ поз.</th><th class="num">Остаток</th><th>Признаки</th><th class="num">Скор</th></tr>`;
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
    <td>${r.drop ? `<span class="pill warn feat" title="${esc('Отсеяна: ' + dropLabel(r.drop))}">${esc(DROP_CODE[r.drop] ?? r.drop.slice(0, 2))}</span> ` : ''}${r.b5 ? featPill('planned-mark') : ''}${r.di === 'I' ? featPill('indirect') : ''}${r.sec && !/^common\b/i.test(r.sec) ? `<span class="pill gray feat" title="${esc('Класс бумаги: ' + r.sec)}">Пф</span> ` : ''}${r.cl >= 2 ? `<span class="pill buy" title="Независимых инсайдеров в плотном окне">×${r.cl}</span>` : ''}</td>
    <td class="num">${r.score ?? ''}</td>
  </tr>`).join('');
}

// ---------- ИНСАЙДЕРЫ ----------
async function loadInsiders() {
  if (!state.insiders) {
    try { state.insiders = await fetchJson('insiders.json'); }
    catch { $('#insiders-table').innerHTML = '<tr><td>Рейтинг ещё не собран.</td></tr>'; return; }
    let deb;
    $('#i-search').addEventListener('input', e => {
      clearTimeout(deb); deb = setTimeout(renderInsiders, 200);
    });
    $('#i-minclosed').addEventListener('change', renderInsiders);
  }
  renderInsiders();
}
function renderInsiders() {
  const q = $('#i-search').value.trim().toLowerCase();
  const minClosed = +$('#i-minclosed').value;
  const rows = sortRows(state.insiders.filter(r =>
    r.closed >= minClosed && (!q || r.name.toLowerCase().includes(q) || r.tickers.some(t => t.toLowerCase().includes(q)))));
  const th = `<tr>
    <th>Инсайдер</th><th>Роли</th><th class="num">Покупок</th><th class="num">Компаний</th>
    <th>Тикеры</th><th class="num">Объём</th>
    <th class="num sortable" data-sort="hit" title="Доля покупок, обогнавших бенчмарк за 6 месяцев">Доля удачных ⇅</th>
    <th class="num sortable" data-sort="med" title="Медианная избыточная доходность за 6 месяцев">Медиана 6м ⇅</th>
    <th class="num">Закрытых</th><th>Последняя</th></tr>`;
  $('#insiders-table').innerHTML = th + (rows.length ? rows.slice(0, 300).map(r => `<tr>
    <td><a class="tick" href="#feed/cik:${r.cik}" title="Показать сделки этого инсайдера">${esc(trunc(r.name, 30))}</a></td>
    <td>${r.roles.map(x => esc(ROLE_LABEL[x] ?? x)).join(', ')}</td>
    <td class="num">${r.n}</td>
    <td class="num">${r.nTickers}</td>
    <td class="score-detail">${r.tickers.map(t => `<a class="tick" href="#ticker/${encodeURIComponent(t)}">${esc(t)}</a>`).join(' ')}</td>
    <td class="num">${fmtMoney(r.val)}</td>
    <td class="num ${r.hit >= 0.6 ? 'pos' : r.hit <= 0.3 ? 'neg' : ''}">${Math.round(r.hit * 100)}%</td>
    <td class="num ${cls(r.med)}">${fmtPct(r.med)}</td>
    <td class="num">${r.closed}</td>
    <td>${esc(r.last)}</td>
  </tr>`).join('') : '<tr><td colspan="10" class="muted">Ничего не найдено.</td></tr>');
  bindSort('#insiders-table', renderInsiders);
}

// ---------- РЫНОК (агрегатный индикатор) ----------
const STATE_LABEL = {
  'вспышка': ['pill sell', 'Кластерная активность вышла за 3σ — единственная зона, где индикатор исторически давал заметное преимущество (SPY +28.5% за год против базовых +13.7%)'],
  'повышенная': ['pill buy', 'Активность 2–3σ: ранний сигнал. Сама по себе эта зона по средней доходности от базы не отличается — смотреть стоит на переход к «вспышке»'],
  'норма': ['pill gray', 'Активность в пределах двухлетней нормы — индикатор молчит'],
  'затишье': ['pill gray', 'Инсайдеры покупают меньше обычного. Это НЕ медвежий сигнал: доходность рынка после таких недель совпадала с базовой'],
  'н/д': ['pill gray', 'Недостаточно истории для нормировки'],
};
async function loadMarket() {
  if (!state.market) {
    try { state.market = await fetchJson('market.json'); }
    catch { $('#market-now').textContent = 'Индикатор ещё не собран.'; return; }
  }
  const m = state.market;
  const [cls, title] = STATE_LABEL[m.now.state] ?? STATE_LABEL['н/д'];
  const last = m.weeks.filter(w => w.z !== null).slice(-1)[0];
  $('#market-now').innerHTML =
    `<div class="card-head"><div><span class="tc-name">Инсайдеры сейчас:</span> ` +
    `<span class="${cls}" title="${esc(title)}" style="font-size:14px">${esc(m.now.state)}</span> ` +
    `<span class="muted">${m.now.z >= 0 ? '+' : ''}${m.now.z}σ от двухлетней нормы</span></div>` +
    `<div class="muted">неделя ${esc(last?.w ?? '—')} · порог сигнала ${m.thresholds.warn}σ</div></div>` +
    `<p class="hint">За неделю ${esc(last?.w ?? '')}: покупок, прошедших фильтры — <b>${fmtInt(last?.b)}</b>, ` +
    `эмитентов с кластером (≥2 независимых покупателя) — <b>${fmtInt(last?.ci)}</b>, ` +
    `очищенных продаж — <b>${fmtInt(last?.s)}</b>.</p>`;
  if (!state.mkChart) state.mkChart = new MarketChart($('#mk-chart'));
  state.mkChart.set(m.weeks, m.thresholds);
  renderMarketTable();
}
function renderMarketTable() {
  const v = state.market.validation;
  const t = state.market.thresholds;
  const rows = [
    ['Все недели (база)', v.all, 'безусловная доходность SPY за период данных'],
    ['Затишье (ниже −1σ)', v.quiet, 'индикатор молчит — это не медвежий сигнал'],
    ['Активность ≥1σ', v.z1, ''],
    [`Активность ${t.warn}–${t.strong}σ`, v.z23, 'зона «повышенная» отдельно: сама по себе не выделяется'],
    [`Активность ≥${t.strong}σ`, v.z3, 'зона «вспышка» — здесь весь эффект'],
    ['Просадка SPY ≥10% И активность ≥1.5σ', v.ddSurge, 'ключевое сравнение'],
    ['Просадка SPY ≥10% БЕЗ активности', v.ddOnly, 'контроль: одна просадка без инсайдеров'],
  ];
  let html = '<tr><th>Состояние на конец недели</th>' +
    [3, 6, 12].map(h => `<th class="num" colspan="3">SPY через ${h} мес</th>`).join('') + '</tr>';
  html += '<tr><th></th>' + [3, 6, 12].map(() =>
    '<th class="num" title="число наблюдений (недели перекрываются)">N</th>' +
    '<th class="num" title="средняя доходность SPY">сред.</th>' +
    '<th class="num" title="доля случаев с положительной доходностью">&gt;0</th>').join('') + '</tr>';
  for (const [label, cell, note] of rows) {
    if (!cell) continue;
    html += `<tr${note === 'ключевое сравнение' ? ' style="font-weight:600"' : ''}>` +
      `<td title="${esc(note)}">${esc(label)}${note ? ' <span class="muted">· ' + esc(note) + '</span>' : ''}</td>` +
      [3, 6, 12].map(h => {
        const c = cell['h' + h] ?? {};
        return `<td class="num muted">${fmtInt(c.n)}</td>` +
          `<td class="num ${cls(c.mean)}">${fmtPct(c.mean)}</td>` +
          `<td class="num">${c.pos === null || c.pos === undefined ? '—' : Math.round(c.pos * 100) + '%'}</td>`;
      }).join('') + '</tr>';
  }
  $('#mk-table').innerHTML = html;
}

// ---------- СТАТИСТИКА ----------
async function loadStats() {
  if (!state.stats) {
    try { state.stats = await fetchJson('stats.json'); }
    catch { $('#stats-table').innerHTML = '<tr><td>Бэктест ещё не собран.</td></tr>'; return; }
    const s = state.stats, m = s.method ?? {};
    $('#stats-note').innerHTML =
      `<b>Что здесь считается.</b> Не «сколько принесла средняя сделка», а <b>сколько принёс бы портфель</b>: ` +
      `на конец каждого месяца берутся все бумаги с подходящей покупкой за последние N месяцев, ` +
      `равный вес <b>по бумагам</b> (не по числу подач), держим месяц, повторяем с 2016 года. ` +
      `Учитываются только имена с дневным оборотом от ${fmtMoney(m.minDv ?? 3e6)} на момент покупки — ` +
      `остальное не торгуется в принципе. В расчёте ${fmtInt(s.n)} покупок, по которым есть котировки, ` +
      `из них ${fmtInt(s.nOk)} прошли фильтры информативности.` +
      (s.placebo ? `<br><b>Шумовой пол.</b> Если брать случайные бумаги той же ликвидности в те же даты, ` +
        `прежняя метрика «среднее по сделкам» показывает ${fmtPct(s.placebo.med)} ` +
        `(коридор ${fmtPct(s.placebo.lo)}…${fmtPct(s.placebo.hi)}) — <b>без всякого сигнала</b>. ` +
        `Поэтому она и вынесена вниз как справочная.` : '') + survivalNote();
    // Выживаемость — главное ограничение любого бэктеста по инсайдерам, и оно молчаливое:
    // ряды исчезают вместе с компаниями, которых больше нет. Показываем масштаб прямо здесь.
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
    $('#s-dim').addEventListener('change', renderStats);
    $('#s-hold').addEventListener('change', renderStats);
  }
  renderRecipes();
  renderStats();
}

// ---------- НАБОРЫ: всё считает сборка, страница только показывает ----------
// Раньше числа наборов стояли в index.html строками и считались скриптом вне репозитория.
// Они разошлись с движком (у «скор 38+» в подписи было +5.1% при t=2.06, движок на тех же
// данных давал +5.7% при t=2.64) и проверить их было нечем. Теперь единственный источник —
// stats.json, а страница не хранит ни одной цифры о результатах.
const RECIPE_HOLD = { 3: 'ДЕРЖАТЬ 3 МЕСЯЦА', 6: 'ДЕРЖАТЬ 6 МЕСЯЦЕВ', 12: 'ДЕРЖАТЬ 12 МЕСЯЦЕВ' };
// Оборот, издержки и доли — величины без знака: «+735% оборота» читается как рост оборота
const pctPlain = (v, d = 0) => v === null || v === undefined || !Number.isFinite(v) ? '—' : (v * 100).toFixed(d) + '%';
function recipeById(key) { return (state.stats?.recipes ?? []).find(r => r.key === key) ?? null; }
function recipeTitle(key) {
  const r = recipeById(key);
  if (!r) return '';
  const parts = [
    `${RECIPE_HOLD[r.hold] ?? `ДЕРЖАТЬ ${r.hold} МЕС`}.`,
    `Альфа ${fmtPct(r.a)} годовых (t=${r.t}), в половинах выборки ${fmtPct(r.aT)} до 2021 и ${fmtPct(r.aV)} после.`,
    `Средний состав ${r.n} бумаг, оборот ${pctPlain(r.turnover)} в год.`,
    `После издержек ${pctPlain(state.stats.roundTrip, 1)} на круг остаётся ${fmtPct(r.net)}.`,
  ];
  if (r.control) parts.push(`Сверх контроля «${r.control.name}»: ${fmtPct(r.control.ex)} (t=${r.control.t}) — столько добавляет сам факт покупки инсайдера.`);
  return parts.join(' ');
}
function renderRecipes() {
  const rs = state.stats?.recipes ?? [];
  const box = $('#recipes-table');
  if (box && rs.length) {
    const num = (v, warn) => `<td class="num ${v === null || v === undefined ? 'muted' : (warn && v < 0 ? 'warn-n' : cls(v))}">${fmtPct(v)}</td>`;
    box.innerHTML = '<tr><th>Набор</th><th class="num">Держать</th><th class="num" title="средний состав портфеля">Бумаг</th>' +
      '<th class="num" title="среднегодовая доходность самого портфеля">CAGR</th>' +
      '<th class="num" title="годовая альфа к рынку и наклону размера">Альфа</th><th class="num">t</th>' +
      '<th class="num">до 2021</th><th class="num">с 2021</th>' +
      '<th class="num" title="оборот портфеля в год">Оборот</th>' +
      `<th class="num" title="альфа за вычетом издержек ${pctPlain(state.stats.roundTrip, 1)} на круг">Нетто</th>` +
      '<th>Сверх контроля</th></tr>' +
      rs.map(r => `<tr><td><b>${esc(r.name)}</b></td><td class="num">${r.hold} мес</td>` +
        `<td class="num ${r.n < 15 ? 'warn-n' : ''}">${r.n}</td>` +
        num(r.cagr) + num(r.a, true) + tCell(r.t) + num(r.aT) + num(r.aV) +
        `<td class="num">${pctPlain(r.turnover)}</td>` + num(r.net, true) +
        `<td>${r.control ? `<b>${fmtPct(r.control.ex)}</b> (t=${r.control.t})<br><span class="muted">${esc(r.control.name)}</span>` : '—'}</td></tr>`).join('');
  }
  // числа внутри текста: <b data-rn="high.control.ex"></b>
  for (const el of document.querySelectorAll('[data-rn]')) {
    const [key, ...path] = el.dataset.rn.split('.');
    let v = key === 'bench' ? state.stats?.benchmarks
      : key === 'stats' ? state.stats
        : recipeById(key);
    for (const p of path) v = v?.[p];
    if (v === null || v === undefined) { el.textContent = '—'; continue; }
    el.textContent = el.dataset.rnFmt === 'raw' ? String(v)
      : el.dataset.rnFmt === 'int' ? fmtInt(v)
        : el.dataset.rnFmt === 'pct0' ? pctPlain(v) : fmtPct(v);
  }
  const lad = $('#recipe-ladder');
  const high = recipeById('high');
  if (lad && high?.ladder?.length) {
    lad.innerHTML = high.ladder.map(l =>
      `не ниже ${Math.round(Math.abs(l.th) * 100)}% от максимума — <b>${fmtPct(l.a)}</b> (t=${l.t}, ${l.n} бумаг)`).join('; ');
  }
  for (const b of document.querySelectorAll('#f-recipes .chip[data-recipe]')) {
    const t = recipeTitle(b.dataset.recipe);
    if (t) b.title = t;
  }
  // Лестница скора в подсказке фильтра — из той же сборки, что и экран статистики
  const sg = $('#f-score-group');
  const sc = state.stats?.portfolio?.score;
  if (sg && sc) {
    const parts = Object.entries(sc)
      .map(([g, c]) => [g, c.h12])
      .filter(([, c]) => c && c.a !== null)
      .sort((a, b) => (b[1].a ?? 0) - (a[1].a ?? 0))
      .map(([g, c]) => `${g}: ${fmtPct(c.a)} (t=${c.t})`);
    if (parts.length) sg.title = sg.title.split(' Лестница')[0] +
      ` Лестница на удержании 12 мес, годовая альфа — ${parts.join('; ')}.`;
  }
}
const GROUP_LABEL = { F: 'CFO', C: 'CEO/През', O: 'Офицер', D: 'Директор', T: '10%-владелец', X: 'Прочее' };
const tCell = t => {
  if (t === null || t === undefined) return '<td class="num muted">—</td>';
  // Значимость показываем явно: без неё разница между ячейками выглядит осмысленной,
  // хотя на подставных данных |t|>2 не встречается вовсе.
  const strong = Math.abs(t) >= 2;
  return `<td class="num ${strong ? cls(t) : 'muted'}" title="${strong ? 'отличие от нуля устойчиво' : 'от нуля неотличимо'}">${t.toFixed(2)}</td>`;
};
function renderStats() {
  const dim = $('#s-dim').value;
  const H = $('#s-hold').value;
  const port = state.stats.portfolio?.[dim];
  const m = state.stats.method ?? {};
  if (!port) { $('#stats-table').innerHTML = '<tr><td>Портфельная метрика ещё не собрана.</td></tr>'; return; }
  let html = '<tr><th>Группа</th>' +
    '<th class="num" title="средний состав портфеля, бумаг в месяц">Бумаг</th>' +
    '<th class="num" title="среднегодовая доходность самого портфеля">CAGR</th>' +
    '<th class="num" title="годовая альфа к двум факторам: рынок и наклон размера">Альфа</th>' +
    '<th class="num" title="t-статистика альфы с поправкой Ньюи–Уэста; |t|≥2 = устойчиво">t</th>' +
    `<th class="num" title="альфа на первой половине выборки">до ${(m.split ?? '2021-01').slice(0, 4)}</th>` +
    `<th class="num" title="альфа на второй половине: расхождение половин — мера доверия">с ${(m.split ?? '2021-01').slice(0, 4)}</th>` +
    '<th class="num" title="превышение над равновзвешенной вселенной той же ликвидности">vs вселенной</th>' +
    '<th class="num">t</th>' +
    '<th class="num" title="рыночная бета">β</th>' +
    '<th class="num" title="наклон на размер: 1 = ведёт себя как малая капитализация">размер</th></tr>';
  const entries = Object.entries(port)
    .map(([g, c]) => [g, c['h' + H]])
    .filter(([, c]) => c)
    .sort((a, b) => (b[1].n ?? 0) - (a[1].n ?? 0));
  if (!entries.length) html += '<tr><td colspan="11" class="muted">На этом горизонте ни одна группа не набирает трёх лет истории.</td></tr>';
  for (const [g, c] of entries) {
    html += `<tr${c.thin ? ' class="dropped"' : ''}><td>${esc(GROUP_LABEL[g] ?? g)}${c.thin ? ' <span class="pill warn" title="средний состав меньше десяти бумаг: числа неустойчивы по построению">тонкая</span>' : ''}</td>` +
      `<td class="num muted">${fmtInt(c.n)}</td>` +
      `<td class="num">${fmtPct(c.cagr)}</td>` +
      `<td class="num ${cls(c.a)}">${fmtPct(c.a)}</td>` + tCell(c.t) +
      `<td class="num muted">${fmtPct(c.aT)}</td><td class="num muted">${fmtPct(c.aV)}</td>` +
      `<td class="num ${cls(c.u)}">${fmtPct(c.u)}</td>` + tCell(c.ut) +
      `<td class="num muted">${c.beta ?? '—'}</td><td class="num muted">${c.size ?? '—'}</td></tr>`;
  }
  $('#stats-table').innerHTML = html;
  $('#stats-legend').innerHTML =
    `Альфа — годовая, после вычета рыночной беты и наклона на размер: без второго фактора микрокапный ` +
    `портфель показывал бы «мастерство» там, где это просто малая капитализация. ` +
    `<b>Две колонки по половинам выборки важнее одной общей цифры</b>: если они расходятся на порядок, ` +
    `общая оценка ничего не предсказывает. Порог значимости |t|≥2; на подставных данных такое не встречается ни разу. ` +
    `Ячейки со средним составом меньше ${m.thin ?? 10} бумаг помечены как тонкие.`;
  renderEventStats(dim);
}
// Прежняя метрика: оставлена, но понижена в статусе и снабжена честной подписью
function renderEventStats(dim) {
  const agg = state.stats.agg?.[dim] ?? {};
  const hs = state.stats.horizons;
  const p = state.stats.placebo;
  $('#stats-events-note').innerHTML =
    `Среднее и медиана избыточной доходности <b>по сделкам</b>. Отвечает на другой вопрос, чем таблица выше: ` +
    `имя с восемью подачами весит в восемь раз больше одного, окна перекрываются, ошибки нет. ` +
    (p ? `На случайном отборе той же ликвидности эта метрика даёт ${fmtPct(p.med)}, поэтому сравнивать её надо не с нулём, а с этим уровнем. ` : '') +
    `Сохранена для сопоставимости с прежними разборами.`;
  let html = '<tr><th>Группа</th><th class="num">Покупок</th>' +
    hs.map(h => `<th class="num" colspan="3">${h} мес</th>`).join('') + '</tr>' +
    '<tr><th></th><th></th>' + hs.map(() =>
      '<th class="num" title="закрытых окон">N</th><th class="num" title="среднее избыточное">сред.</th>' +
      '<th class="num" title="медиана">мед.</th>').join('') + '</tr>';
  for (const [g, cell] of Object.entries(agg).sort((a, b) => (b[1].total ?? 0) - (a[1].total ?? 0))) {
    html += `<tr><td>${esc(GROUP_LABEL[g] ?? g)}</td><td class="num">${fmtInt(cell.total)}</td>` +
      hs.map(h => {
        const c = cell['h' + h] ?? {};
        return `<td class="num muted">${fmtInt(c.n)}</td><td class="num ${cls(c.mean)}">${fmtPct(c.mean)}</td>` +
          `<td class="num ${cls(c.med)}">${fmtPct(c.med)}</td>`;
      }).join('') + '</tr>';
  }
  $('#stats-event-table').innerHTML = html;
}
