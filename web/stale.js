// Счёт пропущенных дней для плашки «Данные EDGAR устарели» (web/app.js, checkStale). Чистая функция без DOM и сети:
// её проверяет самотест (scripts/selftest.mjs) без браузера.
//
// Индекс EDGAR за день D выходит около 22:00 по Нью-Йорку дня D. Его разбирают ночная сборка на VPS (22:03 ET, повтор
// до 23:30 ET), прогон GitHub около 03:25 UTC и запасной прогон по расписанию (cron 03:40 UTC вт–сб, на деле около
// 11:30–11:50 UTC; страница — к ~12:05 UTC). К 09:00 по Нью-Йорку следующего дня все они отработали в оба сезона:
// 12:05 UTC — это 07:05 зимой и 08:05 летом. Поэтому день D пропущен, только если одновременно:
//  · D — рабочий день SEC: не выходной и не федеральный праздник (календарь ./calendar.js — тот же модуль, что у сборки);
//  · D позже последнего обработанного дня (meta.liveLastDay; в выходные и праздники он законно стоит на месте или
//    встаёт на сам выходной);
//  · срок D прошёл: сейчас не раньше 09:00 по Нью-Йорку календарного дня, следующего за D.
// До 11.2026 счёт шёл по будням между liveLastDay и датой UTC без праздников, с порогом в два дня: вечером после
// буднего праздника SEC плашка загоралась при исправной сборке (12.11.2026, после Дня ветеранов).
import { isSecClosed } from './calendar.js';

export const DEADLINE_NY_HOUR = 9;   // срок дня D — 09:00 по Нью-Йорку дня D+1

// Стенные часы Нью-Йорка; зона зрителя на счёт не влияет, переход на летнее время учитывает Intl
const NY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
});
const closed = new Map();   // день -> SEC закрыта; календарь строит праздники года заново на каждый вызов
const secClosed = d => { let v = closed.get(d); if (v === undefined) closed.set(d, v = isSecClosed(d)); return v; };
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '') && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Сколько рабочих дней SEC после lastDay уже должны были быть обработаны к моменту nowMs (мс UTC).
// Нет lastDay, он не дата или момент не число — 0: плашки нет.
export function missedSecDays(lastDay, nowMs) {
  if (typeof lastDay !== 'string' || !Number.isFinite(nowMs) || Math.abs(nowMs) > 8.64e15) return 0;   // вне диапазона Date
  try { if (!isDay(lastDay)) return 0; } catch { return 0; }
  const p = Object.fromEntries(NY.formatToParts(new Date(nowMs)).map(x => [x.type, x.value]));
  // Последний день, чей срок прошёл: вчера по Нью-Йорку с 09:00, до 09:00 — позавчера
  const due = addDays(`${p.year}-${p.month}-${p.day}`, Number(p.hour) >= DEADLINE_NY_HOUR ? -1 : -2);
  let n = 0;
  for (let d = addDays(lastDay, 1); d <= due; d = addDays(d, 1)) if (!secClosed(d)) n++;
  return n;
}

// Плашка — с одного пропущенного дня: при точном календаре и сроке прощать нечего (до 11.2026 порог был два дня)
export const STALE_MIN_MISSED = 1;
export function staleState(lastDay, nowMs) {
  const missed = missedSecDays(lastDay, nowMs);
  return { missed, show: missed >= STALE_MIN_MISSED };
}
