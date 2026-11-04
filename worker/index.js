// Живые котировки утреннего списка (и прежнего скринера). Единственная причина существования этого воркера —
// Yahoo не отдаёт CORS-заголовок, поэтому браузер не может спросить цену сам.
//
// ГЛАВНОЕ ОГРАНИЧЕНИЕ, РАДИ КОТОРОГО ВСЁ УСТРОЕНО ИМЕННО ТАК.
// Yahoo считает запросы в час НА IP-АДРЕС. На VPS 46.62.207.91 уже живёт `portfolio-quotes`
// — источник живых котировок дашборда IBKR (tzi-839), и он держит около 84 запросов в час
// при потолке ~90; там уже ловили 429. Поэтому:
//   1. воркер ходит в Yahoo С КРАЯ CLOUDFLARE, а не с VPS: это другой пул адресов и другой
//      счётчик, и никакой опрос отсюда не может съесть квоту 839;
//   2. воркер не читает ни R2, ни VPS, ни код 839 — общих деталей нет вовсе;
//   3. свой расход ограничен сверху жёстко, см. ниже.
//
// ПОТОЛОК СОБСТВЕННОГО РАСХОДА. Один запрос наверх отдаёт ВСЕ тикеры сразу (v7 принимает
// список), ответ лежит в кэше края TTL секунд, и сколько бы вкладок ни опрашивало воркер,
// наверх уходит не чаще одного запроса в TTL. При TTL=30 с это 120 запросов в час в самом
// худшем случае и около 60 при обычном опросе раз в 30 секунд с одной вкладки. Ответ 429
// включает паузу COOLDOWN и отдачу последнего удачного снимка — то есть на давление сверху
// воркер отвечает молчанием, а не долблением.
//
// v7 без cookie+crumb отвечает 401 (проверено), поэтому пара добывается и живёт в кэше края
// вместе с ответами; при 401 добывается заново один раз.
//
// РЕЗЕРВ — ВТОРОЙ ЭНДПОИНТ YAHOO, А НЕ ВТОРОЙ ПОСТАВЩИК. Хрупкое место основного пути ровно
// одно: стена crumb. `v8/finance/chart` crumb не требует вовсе и переживает именно этот отказ.
// Finnhub сюда сознательно НЕ взят: (1) ключ у пользователя один и он уже занят живым
// источником 839, а падение Yahoo увело бы туда оба дашборда разом — это и есть та самая
// связанность, которой мы избегаем; (2) на бесплатном тарифе Finnhub отвечает по ОДНОМУ
// тикеру на запрос, то есть обход стоит 24 запроса вместо одного при потолке 60 в минуту;
// (3) защищает он только колонки «Сейчас» и «Изм.», которые ни на одно решение не влияют:
// без живого слоя страница честно возвращается к ценам снимка.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TTL = 30;              // сколько секунд ответ считается свежим
const CHART_TTL = 300;       // то же для запасного пути: он стоит запрос НА КАЖДЫЙ тикер
const STALE_TTL = 1800;      // сколько держим последний удачный ответ на случай отказа Yahoo
const COOLDOWN = 300;        // пауза после 429 — не долбим источник
const CRUMB_TTL = 2700;      // crumb живёт дольше, но обновить его дешевле, чем поймать 401
// Предел пачки у Yahoo не документирован, и СВЕРХ НЕГО ОТВЕТ МОЛЧА ОБРЕЗАЕТСЯ — это выглядит
// как «у части бумаг нет котировки», а не как ошибка. 50 — величина, проверенная на практике
// живым источником дашборда IBKR; выше не поднимать.
const MAX_SYMBOLS = 50;
// Доля тикеров, ниже которой ответ считается негодным. Ноль котировок при HTTP 200 — самый
// коварный отказ Yahoo: у соседнего проекта он восемь тактов подряд засчитывался за здоровье,
// и резервный источник не включался. Пустой и куцый ответ обязаны вести себя как ошибка.
const MIN_COVERAGE = 0.5;
const ALLOWED_ORIGINS = new Set([
  'https://ml371kl.github.io',
  'http://localhost:8843',
  'http://localhost:8641',
]);

const KEY = p => 'https://radar840-quotes.internal/' + p;

function cors(origin) {
  const h = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://ml371kl.github.io',
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
  return h;
}

const json = (body, status, origin, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin), ...extra },
});

// Тикеры SEC -> Yahoo: классы акций через дефис (BRK.B -> BRK-B). Ровно то же преобразование
// делает сборка (scripts/lib/prices.mjs), иначе живая цена пришла бы не по той бумаге.
const yahooSymbol = t => t.replace(/[./]/g, '-');

async function getCrumb(cache, force) {
  if (!force) {
    const hit = await cache.match(KEY('crumb'));
    if (hit) return hit.json();
  }
  // Ответ 404, но куку ставит — статус здесь не показатель, важна только кука.
  const c = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const set = typeof c.headers.getSetCookie === 'function'
    ? c.headers.getSetCookie()
    : [c.headers.get('set-cookie')].filter(Boolean);
  const cookie = set.map(s => String(s).split(';')[0]).join('; ');
  if (!cookie) throw new Error('Yahoo не отдал куку');
  const r = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': cookie },
  });
  const crumb = (await r.text()).trim();
  // Пустой или html-ответ, записанный как crumb, отравил бы все последующие запросы:
  // они уходили бы с мусором в параметре до перезапуска изолята.
  if (!crumb || crumb.length > 64 || crumb.includes('<')) throw new Error('Yahoo не отдал crumb');
  const pair = { cookie, crumb };
  await cache.put(KEY('crumb'), new Response(JSON.stringify(pair), {
    headers: { 'Cache-Control': `max-age=${CRUMB_TTL}`, 'Content-Type': 'application/json' },
  }));
  return pair;
}

// Основной путь: одна пачка на все тикеры. Требует cookie+crumb — без них v7 отвечает 401.
async function fetchBatch(cache, symbols) {
  let pair = await getCrumb(cache, false);
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols='
      + encodeURIComponent(symbols.join(',')) + '&crumb=' + encodeURIComponent(pair.crumb);
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Cookie': pair.cookie, 'Accept': 'application/json' } });
    if (r.status === 401 && attempt === 0) { pair = await getCrumb(cache, true); continue; }
    if (r.status === 429) { const e = new Error('429'); e.rateLimited = true; throw e; }
    if (!r.ok) throw new Error('Yahoo HTTP ' + r.status);
    const j = await r.json();
    return (j?.quoteResponse?.result ?? []).filter(q => q?.symbol);
  }
  const e = new Error('Yahoo отверг crumb дважды');
  e.crumbWall = true;
  throw e;
}

// Запасной путь: график вместо котировки. Crumb ему не нужен вовсе, поэтому он переживает
// ровно тот отказ, который для v7 смертелен — когда Yahoo закрывает выдачу crumb. Плата:
// один запрос НА КАЖДЫЙ тикер, поэтому ответ этого пути живёт в кэше впятеро дольше,
// и включается он только после провала основного.
async function fetchChart(symbols) {
  const out = [];
  const got = await Promise.allSettled(symbols.map(async s => {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=1d`,
      { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (r.status === 429) { const e = new Error('429'); e.rateLimited = true; throw e; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const res = (await r.json())?.chart?.result?.[0];
    const m = res?.meta;
    if (!m || typeof m.regularMarketPrice !== 'number') throw new Error('нет цены');
    // Открытие дня — из того же запроса (бар range=1d). До начала сегодняшней регулярной сессии
    // единственный бар вчерашний, и его открытие выдавало бы себя за сегодняшнее: отдаём его,
    // только если бар начался не раньше текущей сессии.
    const open = res?.indicators?.quote?.[0]?.open?.[0];
    const sessionStart = m.currentTradingPeriod?.regular?.start;
    const barStart = res?.timestamp?.[0];
    const openOk = typeof open === 'number' && open > 0 && (typeof sessionStart !== 'number' || barStart >= sessionStart);
    return {
      symbol: m.symbol ?? s,
      regularMarketPrice: m.regularMarketPrice,
      regularMarketTime: m.regularMarketTime ?? null,
      marketState: m.marketState ?? null,
      regularMarketPreviousClose: m.chartPreviousClose ?? null,
      regularMarketOpen: openOk ? open : null,
    };
  }));
  for (const g of got) if (g.status === 'fulfilled') out.push(g.value);
  if (got.some(g => g.status === 'rejected' && g.reason?.rateLimited)) {
    const e = new Error('429 на запасном пути');
    e.rateLimited = true;
    throw e;
  }
  return out;
}

// HTTP 200 с пустым или куцым списком — это отказ, а не здоровье. Проверка стоит здесь, а не
// у вызывающего, чтобы её нельзя было забыть ни на одном из двух путей.
function assertCoverage(result, symbols, source) {
  const n = result.filter(q => typeof q?.regularMarketPrice === 'number').length;
  if (n === 0) throw new Error(`${source}: ответ без котировок (запрошено ${symbols.length})`);
  if (n < Math.ceil(symbols.length * MIN_COVERAGE)) {
    throw new Error(`${source}: ответ обрезан — ${n} котировок из ${symbols.length}`);
  }
  return result;
}

async function fetchQuotes(cache, symbols, forceChart) {
  try {
    if (forceChart) throw new Error('запасной путь запрошен явно');
    return { source: 'quote', ttl: TTL, result: assertCoverage(await fetchBatch(cache, symbols), symbols, 'quote') };
  } catch (error) {
    if (error?.rateLimited) throw error;         // на 429 запасной путь только усугубит
    const result = assertCoverage(await fetchChart(symbols), symbols, 'chart');
    return { source: 'chart', ttl: CHART_TTL, result, degraded: String(error.message || error) };
  }
}

// Число строго больше нуля, иначе null: у Yahoo «нет данных» приходит нулём
const pos = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);


// ---------- журнал вечерней схемы (R2) ----------
// Сборщик на VPS (scripts/evening/collector.mjs) присылает журнал ЦЕЛИКОМ за вечер: PUT /paper/log/ГГГГ-ММ-ДД.jsonl с
// токеном; ежедневная сборка панели читает его без токена (GET /paper/index и GET /paper/log/...). Журнал открытый, как и сам
// репозиторий: в нём формы EDGAR и котировки, секретов нет — токен защищает только запись.
// Привязка R2 называется PAPER (wrangler.toml), секрет — PAPER_TOKEN (wrangler secret put PAPER_TOKEN). Нет привязки или
// токена — приём закрыт (503), а не открыт всем.
const PAPER_FILE = /^\/paper\/log\/(\d{4}-\d{2}-\d{2})\.jsonl$/;
const PAPER_MAX_BYTES = 2 * 1024 * 1024;               // вечерний журнал — сотни килобайт; больше — ошибка отправителя
const PAPER_KINDS = new Set(['event', 'q', 'run', 'stat']);

// Сравнение токена за постоянное время
function sameToken(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}
// Каждая непустая строка — JSON-объект известного вида: в хранилище не должен лечь произвольный текст
function checkJournal(text) {
  let lines = 0;
  const all = text.split('\n');
  for (let i = 0; i < all.length; i++) {
    if (!all[i].trim()) continue;
    let r;
    try { r = JSON.parse(all[i]); } catch { return { ok: false, line: i + 1, why: 'не JSON' }; }
    if (!r || typeof r !== 'object' || !PAPER_KINDS.has(r.k)) return { ok: false, line: i + 1, why: 'неизвестный вид записи' };
    lines++;
  }
  return { ok: true, lines };
}
function authorized(request, env) {
  const m = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '');
  return !!m && sameToken(m[1], env.PAPER_TOKEN);
}
async function handlePaper(request, env, url, origin) {
  if (!env.PAPER) return json({ error: 'хранилище журнала не подключено' }, 503, origin);
  const path = url.pathname, file = PAPER_FILE.exec(path);
  const get = request.method === 'GET', put = request.method === 'PUT';
  if (get && path === '/paper/index') {
    const list = await env.PAPER.list({ prefix: 'log/' });
    const files = (list.objects ?? []).map(o => ({ name: o.key.slice(4), size: o.size, uploaded: o.uploaded ? new Date(o.uploaded).toISOString() : null }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return json({ files }, 200, origin, { 'Cache-Control': 'no-store' });
  }
  if (get && file) {
    const obj = await env.PAPER.get('log/' + file[1] + '.jsonl');
    if (!obj) return json({ error: 'нет журнала за эту дату' }, 404, origin);
    return new Response(obj.body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', ...cors(origin) } });
  }
  if ((get && path === '/paper/ping') || (put && file)) {
    if (!env.PAPER_TOKEN) return json({ error: 'приём журнала не настроен (нет секрета PAPER_TOKEN)' }, 503, origin);
    if (!authorized(request, env)) return json({ error: 'нужен токен' }, 401, origin);
    if (get) return json({ ok: true }, 200, origin);
    if (Number(request.headers.get('Content-Length') ?? 0) > PAPER_MAX_BYTES) return json({ error: 'журнал слишком велик' }, 413, origin);
    const text = await request.text();
    if (text.length > PAPER_MAX_BYTES) return json({ error: 'журнал слишком велик' }, 413, origin);
    const check = checkJournal(text);
    if (!check.ok) return json({ error: 'строка ' + check.line + ': ' + check.why }, 400, origin);
    // Журнал только растёт: более короткая версия — порча на стороне отправителя (пустой или усечённый файл), её не принимаем
    const key = 'log/' + file[1] + '.jsonl';
    const prev = await env.PAPER.head(key);
    if (prev && Number(prev.customMetadata?.lines ?? 0) > check.lines) {
      return json({ error: 'в хранилище записей больше, чем в присланном журнале', stored: Number(prev.customMetadata.lines), sent: check.lines }, 409, origin);
    }
    await env.PAPER.put(key, text, { httpMetadata: { contentType: 'application/x-ndjson' }, customMetadata: { lines: String(check.lines) } });
    return json({ ok: true, key, lines: check.lines, bytes: text.length }, 200, origin);
  }
  return json({ error: 'not found' }, 404, origin);
}

// ---------- утренний список (R2) ----------
// Сборка на VPS (scripts/vps/morning-build.mjs) кладёт готовый morning.json сюда: PUT /morning с тем же токеном приёма (PAPER_TOKEN);
// панель и сторож читают GET /morning без токена (no-store; Last-Modified — момент записи в R2). Хранится одна, самая свежая версия:
// более старая (по listFor, затем по builtAt) не принимается (409) — запоздавший повтор не откатит список.
// /morning/letter/ГГГГ-ММ-ДД — отметка «письмо за этот день отправлено» (кем и когда). GitHub читает её перед своей рассылкой,
// чтобы не продублировать письмо VPS; пишет её отправитель после того, как Telegram принял сообщение. Первая запись остаётся.
const MORNING_KEY = 'morning/latest.json';
const MORNING_MAX_BYTES = 4 * 1024 * 1024;               // файл — десятки килобайт; больше — ошибка отправителя
const LETTER_MAX_BYTES = 1024;
const LETTER = /^\/morning\/letter\/(\d{4}-\d{2}-\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function checkMorning(text) {
  let m;
  try { m = JSON.parse(text); } catch { return { ok: false, why: 'не JSON' }; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, why: 'не объект' };
  if (!ISO_DATE.test(m.listFor ?? '')) return { ok: false, why: 'нет listFor' };
  if (typeof m.builtAt !== 'string' || Number.isNaN(Date.parse(m.builtAt))) return { ok: false, why: 'нет builtAt' };
  if (m.builder !== 'github' && m.builder !== 'vps') return { ok: false, why: 'builder не github и не vps' };
  if (!Array.isArray(m.days) || m.days.length > 60) return { ok: false, why: 'нет days' };
  if (!m.counter || typeof m.counter !== 'object') return { ok: false, why: 'нет counter' };
  return { ok: true, listFor: m.listFor, builtAt: new Date(m.builtAt).toISOString(), builder: m.builder };
}
// Тело запроса с пределом по размеру (Content-Length может отсутствовать или лгать)
async function bodyText(request, max) {
  if (Number(request.headers.get('Content-Length') ?? 0) > max) return null;
  const text = await request.text();
  return text.length > max ? null : text;
}
async function handleMorning(request, env, url, origin) {
  if (!env.PAPER) return json({ error: 'хранилище не подключено' }, 503, origin);
  const path = url.pathname, letter = LETTER.exec(path);
  const get = request.method === 'GET', put = request.method === 'PUT';
  if (get && path === '/morning') {
    const obj = await env.PAPER.get(MORNING_KEY);
    if (!obj) return json({ error: 'списка ещё нет' }, 404, origin, { 'Cache-Control': 'no-store' });
    return new Response(obj.body, { status: 200, headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(origin),
      ...(obj.uploaded ? { 'Last-Modified': new Date(obj.uploaded).toUTCString() } : {}),
    } });
  }
  if (get && letter) {
    const obj = await env.PAPER.get('morning/letter/' + letter[1] + '.json');
    if (!obj) return json({ error: 'письмо за эту дату не отмечено' }, 404, origin, { 'Cache-Control': 'no-store' });
    return new Response(obj.body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(origin) } });
  }
  if (put && (path === '/morning' || letter)) {
    if (!env.PAPER_TOKEN) return json({ error: 'приём не настроен (нет секрета PAPER_TOKEN)' }, 503, origin);
    if (!authorized(request, env)) return json({ error: 'нужен токен' }, 401, origin);
    const text = await bodyText(request, letter ? LETTER_MAX_BYTES : MORNING_MAX_BYTES);
    if (text === null) return json({ error: 'тело слишком велико' }, 413, origin);
    if (letter) {
      let m;
      try { m = JSON.parse(text); } catch { return json({ error: 'не JSON' }, 400, origin); }
      if (!m || (m.by !== 'vps' && m.by !== 'github') || Number.isNaN(Date.parse(m.at))) return json({ error: 'нужны by (vps|github) и at' }, 400, origin);
      const key = 'morning/letter/' + letter[1] + '.json';
      const prev = await env.PAPER.get(key);
      if (prev) return json({ ok: true, existed: true, marker: await new Response(prev.body).json() }, 200, origin);
      const marker = { by: m.by, at: new Date(m.at).toISOString(), ok: true };
      await env.PAPER.put(key, JSON.stringify(marker), { httpMetadata: { contentType: 'application/json' } });
      return json({ ok: true, existed: false, marker }, 200, origin);
    }
    const check = checkMorning(text);
    if (!check.ok) return json({ error: check.why }, 400, origin);
    const prev = await env.PAPER.head(MORNING_KEY);
    const pm = prev?.customMetadata;
    if (pm?.listFor) {
      const older = check.listFor < pm.listFor || (check.listFor === pm.listFor && Date.parse(check.builtAt) < Date.parse(pm.builtAt));
      if (older) return json({ error: 'в хранилище версия новее', stored: { listFor: pm.listFor, builtAt: pm.builtAt }, sent: { listFor: check.listFor, builtAt: check.builtAt } }, 409, origin);
    }
    await env.PAPER.put(MORNING_KEY, text, { httpMetadata: { contentType: 'application/json' }, customMetadata: { listFor: check.listFor, builtAt: check.builtAt, builder: check.builder } });
    return json({ ok: true, listFor: check.listFor, builtAt: check.builtAt, bytes: text.length }, 200, origin);
  }
  return json({ error: 'not found' }, 404, origin);
}

// ---------- дневные бары для сборки на VPS ----------
// Сборка утреннего списка на VPS не ходит в Yahoo напрямую (адрес VPS почти выбрал часовой лимит из-за 839), а просит бары у воркера:
// GET /bars?symbols=AAPL,MGM:2025-09-01&from=2026-10-20 с тем же токеном. Для тикера можно задать свою дату начала после двоеточия.
// Отдаёт ответ Yahoo chart как есть (разбирает его сборка тем же кодом, что и ежедневная): бары, сплиты, открытия.
const BARS_MAX_SYMBOLS = 25;                              // подзапросов у воркера на вызов ограничено
async function handleBars(request, env, url, origin) {
  if (request.method !== 'GET') return json({ error: 'method' }, 405, origin);
  if (!env.PAPER_TOKEN) return json({ error: 'не настроен (нет секрета PAPER_TOKEN)' }, 503, origin);
  if (!authorized(request, env)) return json({ error: 'нужен токен' }, 401, origin);
  const dflt = url.searchParams.get('from') ?? '';
  const items = [];
  for (const part of (url.searchParams.get('symbols') ?? '').toUpperCase().split(',')) {
    const [sym, from = dflt] = part.trim().split(':');
    if (!/^[A-Z0-9.\-]{1,12}$/.test(sym ?? '') || !ISO_DATE.test(from) || from < '2015-01-01') continue;
    if (!items.some(x => x.sym === sym)) items.push({ sym, from });
  }
  if (!items.length) return json({ error: 'нужны symbols и from (ГГГГ-ММ-ДД)' }, 400, origin);
  if (items.length > BARS_MAX_SYMBOLS) return json({ error: 'не больше ' + BARS_MAX_SYMBOLS + ' тикеров за вызов' }, 400, origin);
  // Ответы Yahoo не разбираются и не пересериализуются: на бесплатном плане у воркера 10 мс процессорного времени, а ответ по двадцати тикерам с историей — сотни килобайт.
  // Текст вставляется в общий ответ как есть; не похожее на JSON-объект считается сбоем тикера.
  const bars = {}, failed = {};
  let limited = false;
  const p2 = Math.floor(Date.now() / 1000) + 86400;
  await Promise.all(items.map(async ({ sym, from }) => {
    try {
      const p1 = Math.floor(Date.parse(from + 'T00:00:00Z') / 1000);
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(sym))}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplits`,
        { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (r.status === 429) { limited = true; failed[sym] = 'HTTP 429'; return; }
      if (!r.ok) { failed[sym] = 'HTTP ' + r.status; return; }
      const text = (await r.text()).trim();
      if (text[0] !== '{') { failed[sym] = 'ответ не JSON'; return; }
      bars[sym] = text;
    } catch (e) { failed[sym] = String(e?.message || e); }
  }));
  const body = '{"ok":true,"limited":' + limited + ',"failed":' + JSON.stringify(failed) + ',"bars":{'
    + Object.entries(bars).map(([sym, text]) => JSON.stringify(sym) + ':' + text).join(',') + '}}';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(origin) } });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') ?? '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    const url = new URL(request.url);
    // Журнал вечерней схемы живёт на своих путях и принимает PUT; котировки — только GET, как и раньше
    if (url.pathname.startsWith('/paper/')) return handlePaper(request, env, url, origin);
    if (url.pathname === '/morning' || url.pathname.startsWith('/morning/')) return handleMorning(request, env, url, origin);
    if (url.pathname === '/bars') return handleBars(request, env, url, origin);
    if (request.method !== 'GET') return json({ error: 'method' }, 405, origin);

    if (url.pathname === '/health') return json({ ok: true, ttl: TTL }, 200, origin);
    if (url.pathname !== '/quotes') return json({ error: 'not found' }, 404, origin);

    const raw = (url.searchParams.get('symbols') ?? '').toUpperCase();
    const symbols = [...new Set(raw.split(',').map(s => s.trim()).filter(s => /^[A-Z0-9.\-]{1,12}$/.test(s)))]
      .sort().slice(0, MAX_SYMBOLS).map(yahooSymbol);
    if (!symbols.length) return json({ error: 'нужен параметр symbols' }, 400, origin);

    // Явный вызов запасного пути — чтобы его можно было проверить, а не надеяться на него.
    const forceChart = url.searchParams.get('src') === 'chart';
    const cache = caches.default;
    const key = KEY((forceChart ? 'c/' : 'q/') + symbols.join(','));
    const staleKey = KEY('stale/' + symbols.join(','));

    const fresh = await cache.match(key);
    if (fresh) {
      const body = await fresh.json();
      return json(body, 200, origin, { 'X-Cache': 'hit' });
    }

    // Пауза после 429: наверх не идём вовсе, отдаём последний удачный снимок.
    const cooling = await cache.match(KEY('cooldown'));
    if (cooling) {
      const stale = await cache.match(staleKey);
      if (stale) return json({ ...(await stale.json()), stale: true, reason: 'rate-limit' }, 200, origin, { 'X-Cache': 'stale' });
      return json({ error: 'источник ограничил доступ, попробуйте позже' }, 503, origin);
    }

    try {
      const { source, ttl, result, degraded } = await fetchQuotes(cache, symbols, forceChart);
      const quotes = {};
      for (const q of result) {
        if (typeof q.regularMarketPrice !== 'number') continue;
        quotes[q.symbol] = {
          p: q.regularMarketPrice,
          t: q.regularMarketTime ?? null,
          st: q.marketState ?? null,
          prev: typeof q.regularMarketPreviousClose === 'number' ? q.regularMarketPreviousClose : null,
          // Открытие дня: утренний список считает изменение от него. Клиент сверяет дату t и
          // состояние st: до начала сессии v7 отдаёт открытие прошлого дня.
          o: typeof q.regularMarketOpen === 'number' && q.regularMarketOpen > 0 ? q.regularMarketOpen : null,
          // Вечерняя схема на бумаге (VPS, scripts/evening/collector.mjs): bid/ask с размерами и цена вечерней
          // (post) и утренней (pre) сессии со временем сделки. Отдаются КАК ПРИШЛИ, без интерпретации: вне
          // основной сессии bid/ask Yahoo бывают пустыми, нулевыми или в разы шире настоящего спреда (AAPL
          // 323.80/337.35 при цене 337) — честность книги проверяет сборщик (evening.mjs, validBook).
          b: pos(q.bid), a: pos(q.ask), bs: pos(q.bidSize), as: pos(q.askSize),
          pp: pos(q.postMarketPrice), pt: pos(q.postMarketTime), pre: pos(q.preMarketPrice), prt: pos(q.preMarketTime),
        };
      }
      const missing = symbols.filter(s => !quotes[s]);
      const body = {
        at: Math.floor(Date.now() / 1000), n: Object.keys(quotes).length,
        src: source, quotes,
        // Недостача называется вслух: молча отданный неполный набор выглядел бы так,
        // будто у части бумаг просто нет цены.
        ...(missing.length ? { missing } : {}),
        ...(degraded ? { degraded } : {}),
      };
      // Свежая копия живёт ttl, запасная — STALE_TTL: вторая нужна ровно на случай,
      // когда источник замолчал, и отдаётся с признаком stale, а не молча.
      ctx.waitUntil(cache.put(key, new Response(JSON.stringify(body), {
        headers: { 'Cache-Control': `max-age=${ttl}`, 'Content-Type': 'application/json' },
      })));
      ctx.waitUntil(cache.put(staleKey, new Response(JSON.stringify(body), {
        headers: { 'Cache-Control': `max-age=${STALE_TTL}`, 'Content-Type': 'application/json' },
      })));
      return json(body, 200, origin, { 'X-Cache': 'miss' });
    } catch (error) {
      if (error?.rateLimited) {
        ctx.waitUntil(cache.put(KEY('cooldown'), new Response('1', {
          headers: { 'Cache-Control': `max-age=${COOLDOWN}` },
        })));
      }
      const stale = await cache.match(staleKey);
      if (stale) return json({ ...(await stale.json()), stale: true, reason: String(error.message || error) }, 200, origin, { 'X-Cache': 'stale' });
      return json({ error: String(error.message || error) }, 502, origin);
    }
  },
};
