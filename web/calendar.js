// Календарь для сборки утреннего списка на VPS: дни, когда SEC закрыта (федеральные праздники США) и индекса EDGAR не будет.
// Биржевые праздники сюда не входят: SEC в Страстную пятницу работает, индекс выходит, а бара нет — это решает сборка по SPY.
// Один модуль на сборку и страницу: сборка берёт его через scripts/lib/calendar.mjs, страница — напрямую (плашка
// «Данные EDGAR устарели», web/stale.js). На страницу попадает только web/*, поэтому модуль лежит здесь и не импортирует
// ничего: в браузере нет node:fs и node:zlib, которые тянет scripts/lib/util.mjs.
const addDaysIso = (iso, days) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

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
// Внеплановые закрытия SEC (EDGAR не принимает подач) указом президента о закрытии ведомств; биржа при этом могла работать.
// Сверено с sec.gov 27.11.2026: 24.12.2024 (EO 14129), 09.01.2025 (EO 14133, траур; биржа тоже закрыта), 24 и 26.12.2025 (EO 14371).
// Такие указы выходят в середине декабря: новый день закрытия добавляется сюда и в календарь бота (ibkr-bot-840, morning.py,
// SEC_ONLY_HOLIDAYS, если биржа в этот день торгует) — иначе сборка на VPS ждёт индекс до 23:30 и поднимает тревогу.
export const SEC_SPECIAL_CLOSURES = new Set(['2024-12-24', '2025-01-09', '2025-12-24', '2025-12-26']);
// Индекса EDGAR за этот день не будет: выходной, федеральный праздник или внеплановое закрытие
export function isSecClosed(day) {
  const w = dow(day);
  if (w === 0 || w === 6) return true;
  return secHolidays(Number(day.slice(0, 4))).has(day) || SEC_SPECIAL_CLOSURES.has(day);
}

// Биржа (NYSE) закрыта: выходные и биржевые праздники. От календаря SEC отличается: Страстная пятница — биржа закрыта, а SEC работает и индекс выходит;
// День Колумба и День ветеранов — биржа открыта, SEC закрыта. Нужна сборке на VPS, чтобы отличить «нет бара D0, потому что биржа не торговала» от «бары не догружены».
function easter(y) {   // григорианская Пасха (алгоритм Meeus/Jones/Butcher)
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}
// Разовые закрытия биржи (траур, ураган) — те же, что у бота (ibkr-bot-840, auction.py, _SPECIAL_CLOSURES). Будущие не известны:
// новое добавляется сюда и в календари бота (calendar.py HOLIDAYS, auction.py) вместе.
export const NYSE_SPECIAL_CLOSURES = new Set(['2007-01-02', '2012-10-29', '2012-10-30', '2018-12-05', '2025-01-09']);
export function nyseHolidays(year) {
  const set = new Set([
    ...[[7, 4], [12, 25]].map(([m, d]) => observed(iso(year, m, d))),
    nth(year, 1, 1, 3), nth(year, 2, 1, 3), nth(year, 5, 1, -1), nth(year, 9, 1, 1), nth(year, 11, 4, 4),
    addDaysIso(easter(year), -2),                       // Страстная пятница
  ]);
  // Juneteenth биржа закрывает с 2022 года (до 27.11.2026 здесь — за все годы: бары IWM и SPY есть 19.06.2014–18.06.2021)
  if (year >= 2022) set.add(observed(iso(year, 6, 19)));
  const ny = iso(year, 1, 1);                           // Новый год: на субботу не переносится (в пятницу 31 декабря биржа открыта), с воскресенья — на понедельник
  if (dow(ny) !== 6) set.add(dow(ny) === 0 ? addDaysIso(ny, 1) : ny);
  for (const d of NYSE_SPECIAL_CLOSURES) if (d.startsWith(`${year}-`)) set.add(d);
  return set;
}
export function isMarketClosed(day) {
  const w = dow(day);
  return w === 0 || w === 6 || nyseHolidays(Number(day.slice(0, 4))).has(day);
}

// Следующий торговый день биржи после day — ожидаемый D+1 списка за день подачи day (страница: живые цены D+1, web/app.js).
// Праздник после дня подачи (День благодарения, Рождество, Новый год, Страстная пятница…) сдвигает D+1 на следующий торговый день.
export function nextMarketDay(day) {
  let d = day;
  do { d = addDaysIso(d, 1); } while (isMarketClosed(d));
  return d;
}

// Сокращённые дни NYSE — основная сессия закрывается в 13:00 по Нью-Йорку: пятница после Дня благодарения, 24 декабря и 3 июля,
// когда это будний торговый день (не выходной и не сам праздник по переносу: 03.07.2026 и 24.12.2027 — праздничные пятницы).
// Нужны сборке, чтобы знать, когда дневной бар закрыт (scripts/lib/session.mjs). Разовые закрытия биржи (траур) сюда не входят.
export function nyseEarlyCloses(year) {
  const hol = nyseHolidays(year);
  const out = new Set([addDaysIso(nth(year, 11, 4, 4), 1)]);
  for (const d of [iso(year, 7, 3), iso(year, 12, 24)]) { const w = dow(d); if (w >= 1 && w <= 5 && !hol.has(d)) out.add(d); }
  return out;
}
// Закрытие основной сессии по Нью-Йорку: '16:00', в сокращённый день — '13:00'; null — биржа в этот день не торгует
export function marketCloseEt(day) {
  if (isMarketClosed(day)) return null;
  return nyseEarlyCloses(Number(day.slice(0, 4))).has(day) ? '13:00' : '16:00';
}
// Отсечка заявок MOC/LOC NYSE по Нью-Йорку: за 10 минут до закрытия — '15:50', в сокращённый день '12:50' (правило NYSE 7.35:
// сроки аукциона закрытия сдвигаются вместе с концом сессии); null — биржа не торгует. Подпись таблицы списка на странице.
export function mocCutoffEt(day) {
  const close = marketCloseEt(day);
  return close === null ? null : close === '13:00' ? '12:50' : '15:50';
}
