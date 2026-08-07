// Живые котировки рабочего набора. Единственная причина существования этого воркера —
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
    const m = (await r.json())?.chart?.result?.[0]?.meta;
    if (!m || typeof m.regularMarketPrice !== 'number') throw new Error('нет цены');
    return {
      symbol: m.symbol ?? s,
      regularMarketPrice: m.regularMarketPrice,
      regularMarketTime: m.regularMarketTime ?? null,
      marketState: m.marketState ?? null,
      regularMarketPreviousClose: m.chartPreviousClose ?? null,
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

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') ?? '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'GET') return json({ error: 'method' }, 405, origin);

    const url = new URL(request.url);
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
