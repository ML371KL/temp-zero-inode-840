// Инсайдерский радар — логика интерфейса. ES-модуль, без зависимостей.
import { PriceChart, fmtPrice, fmtInt, fmtMoney, fmtPct } from './charts.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const trunc = (s, n) => String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? '');
const cls = v => v === null || v === undefined ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '';

const ROLE_LABEL = { F: 'CFO', C: 'CEO/През', O: 'Офицер', D: 'Директор', T: '10%', X: 'Прочее' };
const PART_LABEL = {
  cluster: 'кластер', role: 'роль', size: 'размер сделки', conviction: 'прирост позиции',
  track: 'трек-рекорд', inflect: 'слом паттерна', unusual: 'необычно крупная', price: 'ценовой контекст',
};
const TAG_LABEL = {
  pledge: ['залог', 'Акции инсайдера в залоге — риск принудительной продажи'],
  trust: ['траст', 'Покупка через траст или на супруга — деньги того же инсайдера'],
  indirect: ['косв.', 'Косвенное владение'],
  'no-history': ['нет истории', 'Истории сделок меньше трёх лет — рутинность по CMP не определена'],
  'no-price': ['нет цен', 'По этой бумаге нет котировок, поэтому ценовые проверки (дисконт к рынку, единицы, старт торгов) провести было не на чем'],
};
const INFLECT_LABEL = {
  'first-in-3y': ['не покупал 3 года', 'Первая покупка этого инсайдера за три года — слом собственного паттерна'],
  'first-ever': ['первая покупка', 'Первая покупка этого инсайдера в наших данных'],
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
const TABS = ['screener', 'feed', 'ticker', 'insiders', 'stats'];
function route() {
  const hash = location.hash || '#screener';
  let [tab, arg] = hash.slice(1).split('/');
  if (!TABS.includes(tab)) { tab = 'screener'; arg = undefined; }  // неизвестный якорь — не белый экран
  for (const a of tabs) a.classList.toggle('active', a.dataset.tab === tab);
  for (const p of document.querySelectorAll('.tab-panel')) p.classList.toggle('active', p.id === 'tab-' + tab);
  if (tab === 'screener') loadClusters();
  if (tab === 'feed') loadFeed(arg);
  if (tab === 'insiders') loadInsiders();
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
  route();
})();

// ---------- Общие компоненты ----------
function scoreCell(score, parts) {
  if (score === null || score === undefined) return '<span class="muted">—</span>';
  return `<span class="score" data-parts='${esc(JSON.stringify(parts ?? {}))}'>${score}</span>`;
}
function bindScoreTips(sel) {
  for (const s of document.querySelectorAll(sel + ' .score')) {
    s.addEventListener('click', () => {
      const parts = JSON.parse(s.dataset.parts);
      const txt = Object.entries(parts).filter(([, v]) => v !== 0)
        .map(([k, v]) => `${PART_LABEL[k] ?? k} ${v > 0 ? '+' : ''}${v}`).join(' · ');
      s.outerHTML = `<span class="score-detail">${esc(txt || 'нет компонент')}</span>`;
    });
  }
}
function bindSort(sel, rerender) {
  for (const h of document.querySelectorAll(sel + ' th.sortable')) {
    h.addEventListener('click', () => {
      const key = h.dataset.sort;
      state.sort = state.sort?.[0] === key ? [key, -state.sort[1]] : [key, -1];
      rerender(true);
    });
  }
}
function sortRows(rows) {
  if (!state.sort) return rows;
  const [key, dir] = state.sort;
  return [...rows].sort((a, b) => ((a[key] ?? -1e18) - (b[key] ?? -1e18)) * dir);
}
const tagsHtml = r => (r.tags ?? []).map(t => {
  const [label, title] = TAG_LABEL[t] ?? [t, ''];
  return `<span class="pill gray" title="${esc(title)}">${esc(label)}</span>`;
}).join(' ');

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
    renderClusters();
  });
}
async function loadClusters() {
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
  bindSort('#clusters-table', renderClusters);
  bindScoreTips('#clusters-table');
}
function topRoleOf(rel) { for (const c of ['F', 'C', 'O', 'D', 'T', 'X']) if ((rel ?? '').includes(c)) return c; return 'X'; }

// ---------- ЛЕНТА ----------
const ff = { roles: new Set(), minval: 0, minscore: 0, cluster: false, gate: 'ok', q: '' };
for (const b of document.querySelectorAll('#f-roles .chip')) {
  b.addEventListener('click', () => {
    b.classList.toggle('active');
    ff.roles = new Set([...document.querySelectorAll('#f-roles .chip.active')].map(x => x.dataset.role));
    renderFeed(true);
  });
}
$('#f-minval').addEventListener('change', e => { ff.minval = +e.target.value; renderFeed(true); });
$('#f-minscore').addEventListener('change', e => { ff.minscore = +e.target.value; renderFeed(true); });
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
  if (arg) {   // переход из рейтинга инсайдеров: #feed/cik:12345
    const m = /^cik:(\d+)$/.exec(arg);
    if (m) { ff.cikFilter = Number(m[1]); ff.gate = 'all'; $('#f-gate').value = 'all'; }
  } else ff.cikFilter = null;
  renderFeed(true);
}
function feedFiltered() {
  return state.feed.filter(r =>
    (ff.gate === 'all' || (ff.gate === 'ok' ? !r.drop : !!r.drop)) &&
    (!ff.cikFilter || (r.ciks ?? []).includes(ff.cikFilter)) &&
    (!ff.roles.size || ff.roles.has(r.role)) &&
    r.val >= ff.minval && (r.score ?? 0) >= ff.minscore &&
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
    <th class="num sortable" data-sort="val">Сумма ⇅</th>
    <th class="num" title="Прирост позиции инсайдера">Δ поз.</th>
    <th class="num">Класт.</th><th>Признаки</th>
    <th class="num sortable" data-sort="score" title="Клик по значению раскрывает компоненты">Скор ⇅</th>
    <th class="num" title="Через 1 торговый день после входа">1д</th>
    <th class="num" title="Через неделю">1н</th>
    <th class="num" title="Через месяц">1м</th>
    <th class="num" title="Через 6 месяцев">6м</th>
    <th class="num">Тек.</th>
    <th class="num sortable" data-sort="chg" title="Изменение с первого дня после подачи, с учётом сплитов и дивидендов">Изм. ⇅</th></tr>`;
  $('#feed-table').innerHTML = th + (shown.length ? shown.map(r => `<tr class="${r.drop ? 'dropped' : ''}">
    <td>${esc(r.fdate)}${r.form === '4/A' ? ' <span class="pill gray" title="поправка">A</span>' : ''}</td>
    <td class="num ${r.delay > 10 ? 'neg' : ''}">${r.delay}</td>
    <td><a class="tick" href="#ticker/${encodeURIComponent(r.t)}">${esc(r.t)}</a></td>
    <td title="${esc(r.name)}">${esc(trunc(r.name, 22))}</td>
    <td title="${esc(r.title)}">${esc(trunc(r.who, 24))}</td>
    <td>${esc(ROLE_LABEL[r.role] ?? r.role)}</td>
    <td class="num">${fmtInt(r.sh)}</td>
    <td class="num">${fmtPrice(r.px)}</td>
    <td class="num">${fmtMoney(r.val)}</td>
    <td class="num">${r.dOwn === null ? '—' : (r.dOwn >= 9.99 ? 'новая' : fmtPct(r.dOwn, 0))}</td>
    <td class="num">${r.cl >= 2 ? `<span class="pill buy">×${r.cl}</span>` : ''}</td>
    <td>${r.drop ? `<span class="pill warn" title="Отсеяна: ${esc(dropLabel(r.drop))}">${esc(dropShort(r.drop))}</span> ` : ''}${r.inflect ? `<span class="pill buy" title="${esc(INFLECT_LABEL[r.inflect]?.[1] ?? '')}">${esc(INFLECT_LABEL[r.inflect]?.[0] ?? r.inflect)}</span> ` : ''}${tagsHtml(r)}</td>
    <td class="num">${scoreCell(r.score, r.parts)}</td>
    <td class="num ${cls(r.d1)}">${fmtPct(r.d1)}</td>
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
const dropShort = d => ({
  offering: 'размещение', drip: 'DRIP', espp: 'ESPP', forced: 'принудит.', outlier: 'выброс',
  discount: 'дисконт', sync: 'синхрон', fund: 'фонд', planned: '10b5-1', routine: 'рутина',
  regular: 'регулярн.', cancelled: 'аннулир.',
}[d] ?? d);

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
    <td>${r.drop ? `<span class="pill warn" title="${esc(dropLabel(r.drop))}">${esc(dropShort(r.drop))}</span> ` : ''}${r.b5 ? '<span class="pill warn">10b5-1</span> ' : ''}${r.di === 'I' ? '<span class="pill gray" title="косвенное владение">косв.</span> ' : ''}${r.sec && !/^common\b/i.test(r.sec) ? `<span class="pill gray" title="${esc(r.sec)}">${esc(trunc(r.sec, 14))}</span> ` : ''}${r.cl >= 2 ? `<span class="pill buy">×${r.cl}</span>` : ''}</td>
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

// ---------- СТАТИСТИКА ----------
async function loadStats() {
  if (!state.stats) {
    try { state.stats = await fetchJson('stats.json'); }
    catch { $('#stats-table').innerHTML = '<tr><td>Бэктест ещё не собран.</td></tr>'; return; }
    $('#stats-note').innerHTML =
      `Форвардные избыточные доходности после покупок инсайдеров с 2016 года: всего ${fmtInt(state.stats.n)} покупок, ` +
      `из них ${fmtInt(state.stats.nOk)} прошли фильтры информативности. Вход — закрытие первого торгового дня после подачи Form 4. ` +
      `Бенчмарк ${state.stats.iwm ? 'подобран по размеру (IWM для small/micro, SPY для mid/large)' : '— SPY'}.`;
    $('#s-dim').addEventListener('change', renderStats);
    $('#s-spy').addEventListener('change', renderStats);
  }
  renderStats();
}
const GROUP_LABEL = { F: 'CFO', C: 'CEO/През', O: 'Офицер', D: 'Директор', T: '10%-владелец', X: 'Прочее' };
function renderStats() {
  const dim = $('#s-dim').value;
  const useSpy = $('#s-spy').checked;
  const agg = state.stats.agg[dim] ?? {};
  const hs = state.stats.horizons;
  let html = `<tr><th>Группа</th><th class="num">Покупок</th>` +
    hs.map(h => `<th class="num" colspan="4">${h} мес</th>`).join('') + '</tr>';
  html += '<tr><th></th><th></th>' + hs.map(() =>
    `<th class="num" title="закрытых окон">N</th>` +
    `<th class="num" title="медианная избыточная доходность">мед.</th>` +
    `<th class="num" title="доля окон с положительным результатом">&gt;0</th>` +
    `<th class="num" title="медиана с учётом делистнутых / их число">с делист.</th>`).join('') + '</tr>';
  const entries = Object.entries(agg).sort((a, b) => (b[1].total ?? 0) - (a[1].total ?? 0));
  for (const [g, cell] of entries) {
    html += `<tr><td>${esc(GROUP_LABEL[g] ?? g)}</td><td class="num">${fmtInt(cell.total)}</td>` +
      hs.map(h => {
        const c = cell['h' + h] ?? {};
        const med = useSpy ? c.medSpy : c.med;
        return `<td class="num muted">${fmtInt(c.n)}</td>` +
          `<td class="num ${cls(med)}">${fmtPct(med)}</td>` +
          `<td class="num">${c.pos === null || c.pos === undefined ? '—' : Math.round(c.pos * 100) + '%'}</td>` +
          `<td class="num ${cls(c.medD)}">${fmtPct(c.medD)}<span class="muted">/${c.nd ?? 0}</span></td>`;
      }).join('') + '</tr>';
  }
  $('#stats-table').innerHTML = html;
}
