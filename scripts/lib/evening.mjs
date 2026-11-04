// Вечерняя схема на бумаге: формы, принятые EDGAR с 16:00 до 20:00 по Нью-Йорку, покупаются «на бумаге»
// по ask через 5, 15 и 30 минут после времени приёма и продаются на открытии или закрытии D+1 — рядом с
// текущей схемой (открытие D+1 → закрытие D+1) на тех же событиях. Здесь — чистые функции без ввода-вывода:
// их используют и сборщик на VPS (scripts/evening/collector.mjs), и сборка панели (compute.mjs), и самотесты.
//
// Откуда идея: ночной скачок у форм, принятых 16:00–20:00, +1,3%; через 5–30 минут после приёма до
// открытия D+1 остаётся ещё +0,35–0,45% (независимая проверка, 2,5 месяца данных — «перспективно, не
// доказано»). Бумажная проверка копится 2–3 месяца, прежде чем строить настоящий контур.
export const EVENING = {
  moments: [5, 15, 30],     // минуты после времени приёма формы
  windowFrom: '16:00',      // окно приёма формы по Нью-Йорку: [16:00, 20:00)
  windowTo: '20:00',
  minVal: 1e4,              // покупка P от $10 тыс. (сумма формы)
  cost: 0.0008,             // издержки бумажной вечерней сделки на круг: комиссии 0,04% + влияние аукциона продажи 0,04%
  spreadEst: 0.002,         // оценка полного спреда вечерней книги, если честного bid/ask нет (скачок между соседними сделками ~0,2%)
  maxSpread: 0.01,          // bid/ask шире 1% от середины — мусор (так Yahoo отвечает вне основной сессии), не используется
  staleSec: 600,            // последняя вечерняя сделка старше 10 минут — оценка цены помечается устаревшей
  stake: 1e4,
};

// ---------- время по Нью-Йорку ----------
const FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
// UTC-момент (мс) -> «ГГГГ-ММ-ДДTчч:мм:сс» по Нью-Йорку
export function nyWall(ms) {
  const o = Object.fromEntries(FMT.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}:${o.second}`;
}
// «ГГГГ-ММ-ДДTчч:мм[:сс]» по Нью-Йорку -> UTC-момент (мс); учитывает переход на зимнее время
export function nyToMs(wall) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wall ?? '');
  if (!m) return null;
  const want = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}`;
  const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  for (const hours of [5, 4]) {                          // EST = UTC−5, EDT = UTC−4
    const ms = base + hours * 3600e3;
    if (nyWall(ms) === want) return ms;
  }
  return null;
}
// Попадает ли время приёма в вечернее окно (16:00 включительно, 20:00 исключительно)
export function inEveningWindow(at, p = EVENING) {
  const hm = String(at ?? '').slice(11, 16);
  return /^\d\d:\d\d$/.test(hm) && hm >= p.windowFrom && hm < p.windowTo;
}
// Когда снимать котировку: время приёма + N минут
export const dueMs = (at, minutes) => { const ms = nyToMs(at); return ms === null ? null : ms + minutes * 60e3; };

// ---------- лента EDGAR getcurrent (atom) ----------
// -> [{ acc, cik, form, updated, filed }] по одному на форму: одна форма встречается в ленте несколько раз
// (эмитент и каждый инсайдер). updated — время из ленты, но ИСТИНА — <ACCEPTANCE-DATETIME> в самой форме.
export function parseAtom(xml) {
  const out = [], seen = new Set();
  for (const m of String(xml ?? '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const acc = /accession-number=(\d{10}-\d{2}-\d{6})/.exec(e)?.[1] ?? /\/(\d{10}-\d{2}-\d{6})-index\.htm/.exec(e)?.[1];
    const href = /<link[^>]*href="([^"]+)"/.exec(e)?.[1] ?? '';
    const cik = /\/data\/(\d+)\//.exec(href)?.[1];
    const form = /<category[^>]*term="([^"]+)"/.exec(e)?.[1] ?? /<title>\s*([^\s<]+)/.exec(e)?.[1] ?? null;
    if (!acc || !cik || seen.has(acc)) continue;
    seen.add(acc);
    // «Filed:» — дата подачи по правилам SEC (та же, что в дневном индексе); в ленте она лежит в экранированном описании записи
    const filed = /Filed:(?:&lt;\/b&gt;|<\/b>)?\s*(\d{4}-\d{2}-\d{2})/.exec(e)?.[1] ?? null;
    out.push({ acc, cik: Number(cik), form, updated: /<updated>([^<]+)<\/updated>/.exec(e)?.[1] ?? null, filed });
  }
  return out;
}
// Путь полного .txt формы под Archives/ (fetchFiling добавляет https://www.sec.gov/Archives/)
export const filingPath = (cik, acc) => `edgar/data/${cik}/${acc.replace(/-/g, '')}/${acc}.txt`;

// ---------- событие ----------
// rows — строки parseForm4Txt одной формы; берутся только покупки P обыкновенных акций; сумма формы —
// по всем таким строкам. null — формы нет в вечернем потоке (нет покупки, мала, вне окна).
export function buildEvent(rows, { acc, at, fdate, isCommon = () => true }, p = EVENING) {
  if (!inEveningWindow(at, p)) return null;
  const buys = (rows ?? []).filter(r => r.code === 'P' && isCommon(r) && r.val > 0);
  if (!buys.length) return null;
  const val = buys.reduce((s, r) => s + r.val, 0);
  if (val < p.minVal) return null;
  const lead = [...buys].sort((a, b) => b.val - a.val)[0];
  return { k: 'event', id: acc, acc, t: lead.t, cik: lead.cik, fdate, at, val: Math.round(val), n: buys.length };
}

// ---------- котировка ----------
const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
// Нормализация ответа воркера: bid/ask Yahoo и вечерняя цена — как пришли
export function fromWorker(q) {
  if (!q) return null;
  return {
    bid: num(q.b), ask: num(q.a), bidSize: num(q.bs), askSize: num(q.as),
    last: num(q.pp) ?? num(q.p), lastT: num(q.pp) ? (q.pt ?? null) : (q.t ?? null),
    st: q.st ?? null, src: 'worker',
  };
}
// bid/ask годятся, если оба есть, ask ≥ bid и разрыв не шире maxSpread от середины
export function validBook(q, p = EVENING) {
  if (!q || !q.bid || !q.ask || q.ask < q.bid) return false;
  const mid = (q.bid + q.ask) / 2;
  return (q.ask - q.bid) / mid <= p.maxSpread;
}
// Цена покупки на бумаге: ask, если книга честная; иначе последняя вечерняя сделка плюс оценка спреда —
// консервативно, как если бы последняя сделка прошла по bid. Честность пометки обязательна: est=true.
export function entryPx(q, nowSec = null, p = EVENING) {
  if (!q) return null;
  if (validBook(q, p)) return { px: q.ask, est: false };
  if (!q.last) return null;
  const stale = nowSec !== null && q.lastT ? nowSec - q.lastT > p.staleSec : false;
  return { px: q.last * (1 + p.spreadEst), est: true, ...(stale ? { stale: true } : {}) };
}
// Цена эталона (IWM) в момент: середина честной книги, иначе последняя сделка
export function benchPx(q, p = EVENING) {
  if (!q) return null;
  if (validBook(q, p)) return (q.bid + q.ask) / 2;
  return q.last ?? null;
}

// ---------- бумажные сделки ----------
const rnd = (v, k = 4) => Math.round(v * 10 ** k) / 10 ** k;
// ev — событие; qs — { 5: {sym, ...}, 15: ..., 30: ... } котировки бумаги по моментам; bs — то же по IWM;
// d1 — { o, c } бумаги в D+1, i1 — { o, c } IWM в D+1. Возврат: { cur, e: { 5: {close, open}, ... }, est } либо null,
// если не хватает данных хотя бы для одного момента (общий набор событий — только полные).
export function paperTrade(qs, bs, d1, i1, p = EVENING) {
  if (!d1?.o || !d1?.c || !i1?.o || !i1?.c) return null;
  const e = {}; let est = 0;
  for (const m of p.moments) {
    const a = entryPx(qs?.[m]), b = benchPx(bs?.[m]);
    if (!a || !b) return null;
    if (a.est) est++;
    e[m] = {
      close: rnd((d1.c / a.px - 1) - (i1.c / b - 1)),
      open: rnd((d1.o / a.px - 1) - (i1.o / b - 1)),
      px: rnd(a.px, 4), est: a.est,
    };
  }
  const cur = rnd((d1.c / d1.o - 1) - (i1.c / i1.o - 1));
  return { cur, e, est };
}

// Показатели ряда доходностей к IWM ПОСЛЕ издержек сделки: среднее, медиана, доля в плюсе, t по дням (среднее за день,
// затем t по дням — сделки одного дня не независимы), сумма результатов на сделку (в долях позиции) и среднее до издержек.
// Своя копия: схема живёт в отдельном модуле, а её числа обязаны быть сопоставимы с текущей схемой — та же методика.
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const median = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
export function paperMetrics(items) {
  // items — [{ day, ex, cost }]; ex — доходность к IWM до издержек
  const nx = items.map(x => x.ex - x.cost);
  const byDay = new Map();
  items.forEach((x, i) => (byDay.get(x.day) ?? byDay.set(x.day, []).get(x.day)).push(nx[i]));
  const dm = [...byDay.values()].map(mean);
  let tDays = null;
  if (dm.length >= 2) {
    const m = mean(dm), sd = Math.sqrt(dm.reduce((s, x) => s + (x - m) ** 2, 0) / (dm.length - 1));
    if (sd > 0) tDays = rnd(m / (sd / Math.sqrt(dm.length)), 2);
  }
  return {
    gross: rnd(mean(items.map(x => x.ex))), mean: rnd(mean(nx)), median: rnd(median(nx)),
    win: rnd(nx.filter(x => x > 0).length / nx.length, 3), tDays, cumNet: rnd(nx.reduce((s, x) => s + x, 0)),
  };
}

// trades — [{ day, cur, e, cost }] по общему набору; схемы считаются на нём одном.
// -> { n, days, cur, e: { 5: { close, open }, ... } } с показателями paperMetrics (после издержек и $ на сделку).
export function summarizePaper(trades, p = EVENING) {
  if (!trades.length) return { n: 0, days: 0 };
  const mk = (pick, cost) => paperMetrics(trades.map(t => ({ day: t.day, ex: pick(t), cost })));
  const out = { n: trades.length, days: new Set(trades.map(t => t.day)).size, e: {} };
  out.cur = paperMetrics(trades.map(t => ({ day: t.day, ex: t.cur, cost: t.cost })));
  for (const m of p.moments) {
    out.e[m] = { close: mk(t => t.e[m].close, p.cost), open: mk(t => t.e[m].open, p.cost) };
  }
  return out;
}

// ---------- план котировок ----------
export const MOMENTS_ALL = [0, ...EVENING.moments];          // 0 — момент обнаружения формы
// Момент, когда котировка должна быть снята: 0 — сразу после обнаружения (found), остальные — приём + N минут
export const dueOfMoment = (ev, m) => (m === 0 ? Date.parse(ev.found) : dueMs(ev.at, m));
// События × моменты, срок которых наступил и котировка ещё не снята. have — Set ключей `${id}|${m}`.
// -> [{ id, t, m, due }], упорядочено по сроку: самые просроченные первыми (их ценность падает быстрее всего)
export function planQuotes(events, have, nowMs) {
  const out = [];
  for (const ev of events) {
    for (const m of MOMENTS_ALL) {
      if (have.has(`${ev.id}|${m}`)) continue;
      const due = dueOfMoment(ev, m);
      if (due !== null && due <= nowMs) out.push({ id: ev.id, t: ev.t, m, due });
    }
  }
  return out.sort((a, b) => a.due - b.due);
}

// ---------- журнал (JSONL) ----------
// Строки: event — форма в вечернем окне; q — котировка бумаги или IWM в момент m; run/stat — служебные.
// Читается и сборщиком (чтобы после перезапуска не терять и не дублировать), и сборкой панели.
export function parseJournal(text) {
  const events = new Map(), quotes = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }       // оборванная запись не роняет чтение
    if (r.k === 'event' && r.id) events.set(r.id, r);
    else if (r.k === 'q' && r.id) {
      const key = `${r.id}|${r.m}|${r.sym}`;
      (quotes.get(key) ?? quotes.set(key, []).get(key)).push(r);
    }
  }
  return { events, quotes };
}
// Из нескольких котировок одного (форма, момент, инструмент) — лучшая: честная книга важнее, затем источник nasdaq
// (если включён), затем самая свежая. Возврат — нормализованная котировка для entryPx/benchPx.
export function pickQuote(list, p = EVENING) {
  if (!list?.length) return null;
  const score = q => (validBook(q, p) ? 2 : 0) + (q.src === 'nasdaq' ? 1 : 0);
  return [...list].sort((a, b) => score(b) - score(a) || (b.got ?? '').localeCompare(a.got ?? ''))[0];
}
