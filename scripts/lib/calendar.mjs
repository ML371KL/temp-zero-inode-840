// Календарь для сборки утреннего списка на VPS: дни, когда SEC закрыта (федеральные праздники США) и индекса EDGAR не будет.
// Биржевые праздники сюда не входят: SEC в Страстную пятницу работает, индекс выходит, а бара нет — это решает сборка по SPY.
import { addDaysIso } from './util.mjs';

const dow = iso => new Date(iso + 'T00:00:00Z').getUTCDay();             // 0 — воскресенье
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
// n-й (1-й, 2-й…) понедельник/четверг месяца; n = -1 — последний
function nth(y, m, weekday, n) {
  if (n > 0) {
    let d = iso(y, m, 1);
    while (dow(d) !== weekday) d = addDaysIso(d, 1);
    return addDaysIso(d, 7 * (n - 1));
  }
  let d = iso(y, m, 31);
  while (new Date(d + 'T00:00:00Z').getUTCMonth() + 1 !== m) d = addDaysIso(d, -1);
  while (dow(d) !== weekday) d = addDaysIso(d, -1);
  return d;
}
// Правило OPM: праздник в субботу переносится на пятницу, в воскресенье — на понедельник
const observed = d => (dow(d) === 6 ? addDaysIso(d, -1) : dow(d) === 0 ? addDaysIso(d, 1) : d);

export function secHolidays(year) {
  const fixed = [[1, 1], [6, 19], [7, 4], [11, 11], [12, 25]].map(([m, d]) => observed(iso(year, m, d)));
  return new Set([
    ...fixed,
    nth(year, 1, 1, 3),     // День Мартина Лютера Кинга
    nth(year, 2, 1, 3),     // День президентов
    nth(year, 5, 1, -1),    // День памяти
    nth(year, 9, 1, 1),     // День труда
    nth(year, 10, 1, 2),    // День Колумба
    nth(year, 11, 4, 4),    // День благодарения
    observed(iso(year + 1, 1, 1)),   // Новый год следующего года, перенесённый на 31 декабря этого
  ]);
}
// Индекса EDGAR за этот день не будет: выходной или федеральный праздник
export function isSecClosed(day) {
  const w = dow(day);
  if (w === 0 || w === 6) return true;
  return secHolidays(Number(day.slice(0, 4))).has(day);
}
