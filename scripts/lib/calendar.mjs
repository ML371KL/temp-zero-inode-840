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

// Биржа (NYSE) закрыта: выходные и биржевые праздники. От календаря SEC отличается: Страстная пятница — биржа закрыта, а SEC работает и индекс выходит;
// День Колумба и День ветеранов — биржа открыта, SEC закрыта. Нужна сборке на VPS, чтобы отличить «нет бара D0, потому что биржа не торговала» от «бары не догружены».
function easter(y) {   // григорианская Пасха (алгоритм Meeus/Jones/Butcher)
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}
export function nyseHolidays(year) {
  const set = new Set([
    ...[[6, 19], [7, 4], [12, 25]].map(([m, d]) => observed(iso(year, m, d))),
    nth(year, 1, 1, 3), nth(year, 2, 1, 3), nth(year, 5, 1, -1), nth(year, 9, 1, 1), nth(year, 11, 4, 4),
    addDaysIso(easter(year), -2),                       // Страстная пятница
  ]);
  const ny = iso(year, 1, 1);                           // Новый год: на субботу не переносится (в пятницу 31 декабря биржа открыта), с воскресенья — на понедельник
  if (dow(ny) !== 6) set.add(dow(ny) === 0 ? addDaysIso(ny, 1) : ny);
  return set;
}
export function isMarketClosed(day) {
  const w = dow(day);
  return w === 0 || w === 6 || nyseHolidays(Number(day.slice(0, 4))).has(day);
}
