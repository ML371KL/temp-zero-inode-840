// Бумажные результаты вечерней схемы: журнал сборщика (ветка paper, data/paper/log/*.jsonl) + списки и
// открытия сборки -> блок `paper` в morning.json. Логика сделок и показателей — scripts/lib/evening.mjs,
// здесь только склейка: какие события в каких списках, чей D+1 закрыт, у кого полный набор котировок.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVENING, parseJournal, pickQuote, paperTrade, summarizePaper } from './evening.mjs';

// Все журналы каталога (по файлу на вечер) -> { events, quotes } (формат parseJournal)
export function readPaperJournal(dir) {
  const logDir = join(dir, 'log');
  if (!existsSync(logDir)) return { events: new Map(), quotes: new Map() };
  const text = readdirSync(logDir).filter(f => f.endsWith('.jsonl')).sort().map(f => readFileSync(join(logDir, f), 'utf8')).join('\n');
  return parseJournal(text);
}

const quantile = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

// ctx.rowOf(fdate, t) -> строка списка дня подачи ({ main, cost, ... }) или null — бумаги нет в списке (гейты, оборот
//   ≥$10 млн, цена ≥$5): такое событие в сравнение не входит, как и в основной счётчик;
// ctx.d1Of(fdate, t) -> { day, o, c, pc, io, ic } — день входа D+1 закрыт: бумага и IWM; null — торги ещё не прошли.
// Сравнение — на ОДНОМ наборе событий: только те, у кого есть полный набор котировок на 5, 15 и 30 минут
// (по бумаге и по IWM) и результат текущей схемы. Остальные считаются в покрытии, но в таблицу не идут.
export function buildPaper(journal, ctx, p = EVENING) {
  const events = [...journal.events.values()].sort((a, b) => (a.at < b.at ? -1 : 1));
  if (!events.length) return null;
  const cov = { events: events.length, dup: 0, listed: 0, closed: 0, complete: 0, est: 0, noBook: 0 };
  const main = [], all = [], delays = [], taken = new Set();
  for (const ev of events) {
    // Одна бумага в день — одна сделка, как в списке: несколько форм (разные инсайдеры) — берётся ПЕРВАЯ по времени приёма
    const key = `${ev.fdate}|${ev.t}`;
    if (taken.has(key)) { cov.dup++; continue; }
    taken.add(key);
    const row = ctx.rowOf(ev.fdate, ev.t);
    if (!row) continue;
    cov.listed++;
    const d1 = ctx.d1Of(ev.fdate, ev.t);
    if (!d1) continue;
    // Те же пропуски, что у текущей схемы: открытие есть, не «застывшее», цена ≥ минимума
    if (!(d1.o > 0) || !(d1.c > 0) || (d1.pc != null && d1.o === d1.pc) || d1.o < (ctx.minPx ?? 5)) continue;
    cov.closed++;
    const qs = {}, bs = {};
    for (const m of p.moments) {
      qs[m] = pickQuote(journal.quotes.get(`${ev.id}|${m}|${ev.t}`), p);
      bs[m] = pickQuote(journal.quotes.get(`${ev.id}|${m}|IWM`), p);
    }
    const t = paperTrade(qs, bs, { o: d1.o, c: d1.c }, { o: d1.io, c: d1.ic }, p);
    if (!t) { cov.noBook++; continue; }
    cov.complete++;
    cov.est += t.est;
    for (const m of p.moments) if (qs[m]?.late != null) delays.push(qs[m].late);
    const item = { day: d1.day, cur: t.cur, e: t.e, cost: row.cost };
    all.push(item);
    if (row.main) main.push(item);
  }
  return {
    from: events[0].fdate, upTo: events.at(-1).fdate,
    cov: { ...cov, estShare: cov.complete ? Math.round(cov.est / (cov.complete * p.moments.length) * 1000) / 1000 : null },
    late: { p50: quantile(delays, 0.5), p90: quantile(delays, 0.9) },
    cost: p.cost, stake: p.stake,
    main: summarizePaper(main, p), all: summarizePaper(all, p),
  };
}
