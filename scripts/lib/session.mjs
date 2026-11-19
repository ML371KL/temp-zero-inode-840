// Торговая сессия биржи во времени сборки: закрыт ли дневной бар и можно ли страховочному прогону GitHub работать.
//
// Источник цен отдаёт бар текущего дня с самого открытия: в нём цена последней сделки вместо закрытия и объём на эту минуту.
// Прогон GitHub в торговые часы клал такой бар в ветку data, а ночная сборка сервера считала по нему цену, оборот и просадку
// списка и результаты вчерашних сделок (ночь 17→18.11.2026: все 14 строк списка сервера; BLX — оборот $10,3 млн против $12,1 млн
// у самого порога $10 млн). Правило: бар торгового дня не записывается, пока сессия не закрыта с запасом SESSION.settleMin
// (16:10 по Нью-Йорку, в сокращённый день — 13:10). Ряд без бара текущего дня — обычное состояние утреннего прогона.
// Чистые функции от момента времени: их проверяют самотесты с подставными часами.
import { nyWall, nyToMs } from './nytime.mjs';
import { marketCloseEt } from './calendar.mjs';

export const SESSION = {
  settleMin: 10,          // запас после закрытия сессии, минут: аукцион закрытия и поздние отчёты о сделках
  guardFrom: '08:10',     // страховочный прогон GitHub по расписанию, начатый в торговый день позже этого времени, не работает
};

// Момент (мс UTC), с которого бар дня day считается закрытым; null — биржа в этот день не торгует, бара не будет
export function barClosedAtMs(day, p = SESSION) {
  const close = marketCloseEt(day);
  const ms = close ? nyToMs(`${day}T${close}`) : null;
  return ms === null ? null : ms + p.settleMin * 60e3;
}
// Торговый день, чей бар в момент nowMs ещё не закрыт: сегодняшний день по Нью-Йорку, если биржа сегодня торгует и до закрытия
// с запасом ещё не дошло (в том числе ночью и до открытия: бара ещё нет или он предторговый). Иначе null.
export function openBarDay(nowMs = Date.now(), p = SESSION) {
  const day = nyWall(nowMs).slice(0, 10);
  const at = barClosedAtMs(day, p);
  return at !== null && nowMs < at ? day : null;
}
// Ответ источника цен (parseYahooChart, fetchStooqDaily) без баров незакрытого дня: ряд, пары «открытие — закрытие» и минимумы дня
// обрезаются до openDay не включительно. Сплиты остаются: коэффициент известен с утра и от закрытия не зависит.
// Возвращает тот же объект, если срезать нечего; cut — сколько баров ряда снято.
export function dropOpenBars(res, openDay) {
  if (!openDay || !res?.series?.length || res.series[res.series.length - 1][0] < openDay) return res;
  const before = x => x[0] < openDay;
  const series = res.series.filter(before);
  return { ...res, series, cut: res.series.length - series.length,
    ...(res.ohlc ? { ohlc: res.ohlc.filter(before) } : {}), ...(res.lows ? { lows: res.lows.filter(before) } : {}) };
}

// Страховочный прогон daily.yml по расписанию GitHub (событие schedule, по плану 22:40–23:40 по Нью-Йорку) опаздывает на часы:
// 03–04 утра в октябре 2026, 07:26 — 17.11.2026. Сползая дальше, он попал бы на приём списка ботом (08:30) и на торговую сессию.
// Прогон по расписанию, начатый в торговый день позже SESSION.guardFrom и до закрытия бара дня, завершается сразу, ничего не меняя.
// Ручной запуск и запуск от слияния этим не ограничены: их защищает запрет записи незакрытого бара (dropOpenBars).
// -> { skip, why }
export function scheduleGuard(eventName, nowMs = Date.now(), p = SESSION) {
  const wall = nyWall(nowMs), day = wall.slice(0, 10), hm = wall.slice(11, 16);
  if (eventName !== 'schedule') return { skip: false, why: `событие ${eventName || '—'}: ограничение действует только на расписание GitHub` };
  const closed = barClosedAtMs(day, p);
  if (closed === null) return { skip: false, why: `${day} — биржа не торгует, ${hm} по Нью-Йорку` };
  if (hm <= p.guardFrom) return { skip: false, why: `${hm} по Нью-Йорку — не позже ${p.guardFrom}` };
  const until = nyWall(closed).slice(11, 16);
  if (nowMs >= closed) return { skip: false, why: `${hm} по Нью-Йорку — торги дня закрыты с ${until}` };
  return { skip: true, why: `прогон по расписанию GitHub начат в ${hm} по Нью-Йорку торгового дня ${day} — позже ${p.guardFrom} и до закрытия торгов (${until}): завершаюсь без изменений` };
}
