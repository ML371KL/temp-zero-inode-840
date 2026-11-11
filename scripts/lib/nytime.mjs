// Время по Нью-Йорку без сторонних библиотек: стенные часы EDGAR и биржи (с переходом на зимнее и летнее время).
// Используют лента на весь день (scripts/vps/feed-collector.mjs), сборка на VPS (scripts/vps/morning-build.mjs) и проба окружения.
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
