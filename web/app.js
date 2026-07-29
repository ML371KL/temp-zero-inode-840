// Инсайдерский радар — логика интерфейса. ES-модуль, без зависимостей.
import { PriceChart, fmtPrice, fmtInt, fmtMoney, fmtPct } from './charts.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ROLE_LABEL = { C: 'CEO/През', F: 'CFO', O: 'Офицер', D: 'Директор', T: '10%', X: 'Прочее' };
const PART_LABEL = { cluster: 'кластер', role: 'роль', size: 'размер', conviction: 'докупка позиции', dip: 'покупка на просадке', b5: 'план 10b5-1' };

// ---------- Тема ----------
const savedTheme = localStorage.getItem('ir-theme');
const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = savedTheme ?? (prefersDark ? 'dark' : 'light');
$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = cur;
  localStorage.setItem('ir-theme', cur);
  if (state.chart && state.tickerData) renderChart(); // перерисовать в новых цветах
});

// ---------- Данные ----------
const state = { feed: null, clusters: null, stats: null, meta: null, tickersIndex: null, tickerData: null, chart: null, feedShown: 100, sort: null };
async function fetchJson(path) {
  const res = await fetch('data/' + path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(path + ': HTTP ' + res.status);
  return res.json();
}

// ---------- Роутинг ----------
const tabs = document.querySelectorAll('.tabs a');
function route() {
  const hash = location.hash || '#feed';
  const [tab, arg] = hash.slice(1).split('/');
  for (const a of tabs) a.classList.toggle('active', a.dataset.tab === tab);
  for (const p of document.querySelectorAll('.tab-panel')) p.classList.toggle('active', p.id === 'tab-' + tab);
  if (tab === 'feed') loadFeed();
  if (tab === 'clusters') loadClusters();
  if (tab === 'stats') loadStats();
  if (tab === 'ticker') { loadTickerIndex(); if (arg) openTicker(decodeURIComponent(arg)); }
}
addEventListener('hashchange', route);

// ---------- Шапка ----------
(async () => {
  try {
    const m = state.meta = await fetchJson('meta.json');
    const last = m.liveLastDay ?? '—';
    $('#meta-badges').innerHTML = [
      `<span class="badge">EDGAR до <b>${esc(last)}</b></span>`,
      `<span class="badge">цены <b>${esc(m.pricesUpdated ?? '—')}</b></span>`,
      `<span class="badge">покупок <b>${fmtInt(m.trades?.buys)}</b></span>`,
      `<span class="badge">бэктест <b>${fmtInt(m.backtest?.rows)}</b></span>`,
      m.universe?.noPrices > 200 ? `<span class="badge warn">без цен: ${fmtInt(m.universe.noPrices)} тикеров</span>` : '',
    ].join('');
  } catch { $('#meta-badges').innerHTML = '<span class="badge warn">meta.json недоступен — данные ещё собираются</span>'; }
  route();
})();

// ---------- ЛЕНТА ----------
const feedFilters = { roles: new Set(), minval: 0, minscore: 0, cluster: false, nob5: false, q: '' };
function bindFeedFilters() {
  for (const b of document.querySelectorAll('#f-roles .chip')) {
    b.addEventListener('click', () => {
      b.classList.toggle('active');
      feedFilters.roles.clear();
      for (const x of document.querySelectorAll('#f-roles .chip.active')) feedFilters.roles.add(x.dataset.role);
      renderFeed(true);
    });
  }
  $('#f-minval').addEventListener('change', e => { feedFilters.minval = +e.target.value; renderFeed(true); });
  $('#f-minscore').addEventListener('change', e => { feedFilters.minscore = +e.target.value; renderFeed(true); });
  $('#f-cluster').addEventListener('change', e => { feedFilters.cluster = e.target.checked; renderFeed(true); });
  $('#f-nob5').addEventListener('change', e => { feedFilters.nob5 = e.target.checked; renderFeed(true); });
  let deb;
  $('#f-search').addEventListener('input', e => {
    clearTimeout(deb);
    deb = setTimeout(() => { feedFilters.q = e.target.value.trim().toLowerCase(); renderFeed(true); }, 200);
  });
  $('#feed-more').addEventListener('click', () => { state.feedShown += 200; renderFeed(false); });
}
bindFeedFilters();

async function loadFeed() {
  if (!state.feed) {
    try { state.feed = await fetchJson('feed.json'); }
    catch { $('#feed-table').innerHTML = '<tr><td>Данные ленты ещё не собраны.</td></tr>'; return; }
  }
  renderFeed(false);
}
function feedFiltered() {
  const f = feedFilters;
  return state.feed.filter(r =>
    (!f.roles.size || f.roles.has(r.role)) &&
    r.val >= f.minval && r.score >= f.minscore &&
    (!f.cluster || r.cl >= 2) && (!f.nob5 || !r.b5) &&
    (!f.q || r.t.toLowerCase().includes(f.q) || r.name.toLowerCase().includes(f.q) || r.who.toLowerCase().includes(f.q)));
}
function sortRows(rows) {
  const s = state.sort;
  if (!s) return rows;
  const [key, dir] = s;
  return [...rows].sort((a, b) => ((a[key] ?? -1e18) - (b[key] ?? -1e18)) * dir);
}
function renderFeed(reset) {
  if (reset) state.feedShown = 100;
  const rows = sortRows(feedFiltered());
  const shown = rows.slice(0, state.feedShown);
  const th = `<tr>
    <th>Подача</th><th>Тикер</th><th>Компания</th><th>Инсайдер</th><th>Роль</th>
    <th class="num">Акции</th><th class="num">Цена</th><th class="num sortable" data-sort="val">Сумма ⇅</th>
    <th class="num" title="Прирост позиции инсайдера">Δ поз.</th><th>Кластер</th><th>10b5-1</th>
    <th class="num sortable" data-sort="score" title="Скор сигнала, клик по значению — разбор">Скор ⇅</th>
    <th class="num">Тек. цена</th><th class="num sortable" data-sort="chg" title="Изменение с первого дня после подачи, с учётом сплитов и дивидендов">Изм. ⇅</th>
  </tr>`;
  $('#feed-table').innerHTML = th + shown.map(r => `<tr>
    <td>${esc(r.fdate)}${r.form === '4/A' ? ' <span class="pill gray" title="поправка">A</span>' : ''}</td>
    <td><a class="tick" href="#ticker/${encodeURIComponent(r.t)}">${esc(r.t)}</a></td>
    <td title="${esc(r.name)}">${esc(trunc(r.name, 26))}</td>
    <td title="${esc(r.title)}">${esc(trunc(r.who, 28))}</td>
    <td>${esc(ROLE_LABEL[r.role] ?? r.role)}</td>
    <td class="num">${fmtInt(r.sh)}</td>
    <td class="num">${fmtPrice(r.px)}</td>
    <td class="num">${fmtMoney(r.val)}</td>
    <td class="num">${r.dOwn === null ? '—' : (r.dOwn >= 9.99 ? 'новая' : fmtPct(r.dOwn, 0))}</td>
    <td>${r.cl >= 2 ? `<span class="pill buy">×${r.cl}</span>` : ''}</td>
    <td>${r.b5 ? '<span class="pill warn">план</span>' : ''}</td>
    <td class="num"><span class="score" data-parts='${esc(JSON.stringify(r.parts))}'>${r.score}</span></td>
    <td class="num">${fmtPrice(r.cur)}</td>
    <td class="num ${cls(r.chg)}">${fmtPct(r.chg)}</td>
  </tr>`).join('');
  $('#feed-count').textContent = `${Math.min(state.feedShown, rows.length)} из ${rows.length}`;
  $('#feed-more').disabled = state.feedShown >= rows.length;
  bindSort('#feed-table', renderFeed);
  bindScoreTips('#feed-table');
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
function bindScoreTips(sel) {
  for (const s of document.querySelectorAll(sel + ' .score')) {
    s.addEventListener('click', () => {
      const parts = JSON.parse(s.dataset.parts);
      const txt = Object.entries(parts).filter(([, v]) => v !== 0)
        .map(([k, v]) => `${PART_LABEL[k] ?? k}: ${v > 0 ? '+' : ''}${v}`).join(' · ');
      s.outerHTML = `<span class="score-detail">${esc(txt || 'нет компонент')}</span>`;
    });
  }
}
const cls = v => v === null || v === undefined ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '';
const trunc = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

// ---------- КЛАСТЕРЫ ----------
async function loadClusters() {
  if (!state.clusters) {
    try { state.clusters = await fetchJson('clusters.json'); }
    catch { $('#clusters-table').innerHTML = '<tr><td>Данные ещё не собраны.</td></tr>'; return; }
  }
  const th = `<tr>
    <th>Тикер</th><th>Компания</th><th class="num">Инсайдеров</th><th class="num">Покупок</th>
    <th>Период</th><th class="num">Объём</th><th class="num">Ср. цена</th>
    <th class="num">Тек. цена</th><th class="num">Изм.</th>
    <th class="num" title="Просадка от 52-нед. максимума на момент последней покупки">Просадка</th>
    <th>10b5-1</th><th class="num">Скор</th><th>Покупатели</th>
  </tr>`;
  $('#clusters-table').innerHTML = th + state.clusters.map(c => `<tr>
    <td><a class="tick" href="#ticker/${encodeURIComponent(c.t)}">${esc(c.t)}</a></td>
    <td title="${esc(c.name)}">${esc(trunc(c.name, 28))}</td>
    <td class="num"><span class="pill buy">×${c.n}</span></td>
    <td class="num">${c.nTrades}</td>
    <td>${esc(c.first)} → ${esc(c.last)}</td>
    <td class="num">${fmtMoney(c.totalVal)}</td>
    <td class="num">${fmtPrice(c.vwap)}</td>
    <td class="num">${fmtPrice(c.cur)}</td>
    <td class="num ${cls(c.chg)}">${fmtPct(c.chg)}</td>
    <td class="num ${cls(c.dd)}">${fmtPct(c.dd, 0)}</td>
    <td>${c.b5 ? '<span class="pill warn">план</span>' : ''}</td>
    <td class="num"><span class="score" data-parts='${esc(JSON.stringify(c.parts))}'>${c.score}</span></td>
    <td class="score-detail">${c.buyers.slice(0, 5).map(b => `${esc(b.name)} (${esc(ROLE_LABEL[topRoleOf(b.rel)] ?? '')})`).join('; ')}${c.buyers.length > 5 ? '…' : ''}</td>
  </tr>`).join('');
  bindScoreTips('#clusters-table');
}
function topRoleOf(rel) { for (const c of ['C', 'F', 'O', 'D', 'T', 'X']) if (rel.includes(c)) return c; return 'X'; }

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
    d.cat === 'unknown' ? '<span class="pill warn" title="Эмитента нет в текущем справочнике SEC — возможен делистинг или смена структуры">возможен делистинг</span>' : '',
  ].join(' ');
  $('#tc-asof').textContent = d.asOf ? `цены до ${d.asOf}` : 'цены недоступны';
  if (!state.chart) state.chart = new PriceChart($('#tc-chart'));
  renderChart();
  renderTickerTrades();
}
function renderChart() {
  const d = state.tickerData;
  const cutoff = tickerRange === '1y' ? isoAgo(370) : tickerRange === '5y' ? isoAgo(365 * 5) : '0000';
  // Для года — дневной ряд, дальше недельный
  const series = (tickerRange === '1y' && d.daily.length ? d.daily : d.weekly).filter(r => r[0] >= cutoff);
  const markers = d.trades
    .filter(r => r.tdate >= cutoff)
    .map(r => ({ d: r.tdate, px: r.px, code: r.code, who: r.who, sh: r.sh, val: r.val }));
  state.chart.set(series, markers);
}
function isoAgo(days) {
  const x = new Date(); x.setUTCDate(x.getUTCDate() - days);
  return x.toISOString().slice(0, 10);
}
function renderTickerTrades() {
  const d = state.tickerData;
  const onlyP = $('#tc-onlyp').checked;
  const rows = d.trades.filter(r => !onlyP || r.code === 'P');
  const th = `<tr>
    <th>Сделка</th><th>Подача</th><th>Тип</th><th>Инсайдер</th><th>Роль</th>
    <th class="num">Акции</th><th class="num">Цена</th><th class="num">Сумма</th>
    <th class="num">Δ поз.</th><th class="num">Остаток</th><th>Влад.</th><th>Кластер</th><th>10b5-1</th>
  </tr>`;
  $('#tc-trades').innerHTML = th + rows.map(r => `<tr>
    <td>${esc(r.tdate)}</td>
    <td>${esc(r.fdate)}${r.form === '4/A' ? ' <span class="pill gray">A</span>' : ''}</td>
    <td>${r.code === 'P' ? '<span class="pill buy">▲ покупка</span>' : '<span class="pill sell">▼ продажа</span>'}</td>
    <td title="${esc(r.title)}">${esc(trunc(r.who, 30))}</td>
    <td>${esc(ROLE_LABEL[r.role] ?? r.role)}</td>
    <td class="num">${fmtInt(r.sh)}</td>
    <td class="num">${fmtPrice(r.px)}</td>
    <td class="num">${fmtMoney(r.val)}</td>
    <td class="num">${r.code !== 'P' || r.dOwn === null ? '—' : (r.dOwn >= 9.99 ? 'новая' : fmtPct(r.dOwn, 0))}</td>
    <td class="num">${fmtInt(r.own)}</td>
    <td>${r.di === 'I' ? '<span class="pill gray" title="косвенное владение">косв.</span>' : ''}</td>
    <td>${r.cl >= 2 ? `<span class="pill buy">×${r.cl}</span>` : ''}</td>
    <td>${r.b5 ? '<span class="pill warn">план</span>' : ''}</td>
  </tr>`).join('');
}

// ---------- СТАТИСТИКА ----------
async function loadStats() {
  if (!state.stats) {
    try { state.stats = await fetchJson('stats.json'); }
    catch { $('#stats-table').innerHTML = '<tr><td>Бэктест ещё не собран.</td></tr>'; return; }
    $('#stats-note').textContent =
      `Форвардные избыточные доходности (excess vs SPY) после ${fmtInt(state.stats.n)} покупок инсайдеров, ` +
      `подача с 2016 года. Вход — закрытие первого торгового дня после подачи Form 4.`;
    $('#s-dim').addEventListener('change', renderStats);
  }
  renderStats();
}
const GROUP_LABEL = {
  C: 'CEO/През', F: 'CFO', O: 'Офицер', D: 'Директор', T: '10%-владелец', X: 'Прочее',
  '1': 'Одиночная', '2': 'Кластер ×2', '3+': 'Кластер ×3+', 'все': 'Все покупки',
};
function renderStats() {
  const dim = $('#s-dim').value;
  const agg = state.stats.agg[dim];
  const hs = state.stats.horizons;
  let html = `<tr><th>Группа</th><th class="num">Покупок</th>` +
    hs.map(h => `<th class="num" colspan="4">${h} мес</th>`).join('') + '</tr>';
  html += `<tr><th></th><th></th>` +
    hs.map(() => `<th class="num" title="закрытых окон">N</th><th class="num" title="медианный excess vs SPY">мед.</th><th class="num" title="доля окон с excess>0">&gt;0</th><th class="num" title="медиана с учётом делистнутых / число делистингов">с делист.</th>`).join('') + '</tr>';
  for (const [g, cell] of Object.entries(agg)) {
    html += `<tr><td>${esc(GROUP_LABEL[g] ?? g)}</td><td class="num">${fmtInt(cell.total)}</td>` +
      hs.map(h => {
        const c = cell['h' + h];
        return `<td class="num muted">${fmtInt(c.n)}</td>` +
          `<td class="num ${cls(c.med)}">${fmtPct(c.med)}</td>` +
          `<td class="num">${c.pos === null ? '—' : Math.round(c.pos * 100) + '%'}</td>` +
          `<td class="num ${cls(c.medD)}">${fmtPct(c.medD)}<span class="muted">/${c.nd}</span></td>`;
      }).join('') + '</tr>';
  }
  $('#stats-table').innerHTML = html;
}
