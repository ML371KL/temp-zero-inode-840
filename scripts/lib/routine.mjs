// Рутинность и инфлексии по истории инсайдера (owner CIK стабилен сквозь компании).
//
// Cohen, Malloy, Pomorski (JF 2012) «Decoding Inside Information»: инсайдер «рутинный», если
// торговал в один и тот же календарный месяц три года подряд. Более половины всех сделок —
// рутинные, и их альфа статистически неотличима от нуля; вся документированная доходность
// (~82 б.п./мес) сидит в оппортунистических сделках. Это самый сильный фильтр шума из известных.
//
// Все функции строго point-in-time: смотрят только на историю СТРОГО ДО текущей сделки.

const YEARS_REQUIRED = 3;

// История одного инсайдера: сделки, отсортированные по дате сделки
export function buildOwnerHistory(trades) {
  const hist = new Map(); // ownerCik -> [{tdate, fdate, code, cik, val, sh}]
  for (const r of trades) {
    for (const o of r.owners ?? []) {
      if (!o.cik) continue;
      const list = hist.get(o.cik) ?? [];
      list.push({ tdate: r.tdate, fdate: r.fdate, code: r.code, cik: r.cik, val: r.val, sh: r.sh });
      hist.set(o.cik, list);
    }
  }
  for (const list of hist.values()) list.sort((a, b) => a.tdate < b.tdate ? -1 : a.tdate > b.tdate ? 1 : 0);
  return hist;
}

// Рутинность по CMP: торговал ли инсайдер в этом же календарном месяце в каждый из
// предыдущих трёх годов. null = недостаточно истории для классификации (не «нет»).
export function isRoutineCMP(history, tdate) {
  if (!history?.length) return null;
  const year = Number(tdate.slice(0, 4)), month = tdate.slice(5, 7);
  const first = Number(history[0].tdate.slice(0, 4));
  if (year - first < YEARS_REQUIRED) return null; // истории меньше трёх лет — классификация неприменима
  for (let k = 1; k <= YEARS_REQUIRED; k++) {
    const y = String(year - k);
    if (!history.some(h => h.tdate.slice(0, 4) === y && h.tdate.slice(5, 7) === month)) return false;
  }
  return true;
}

// Регулярность: серия сделок одного кода по одному эмитенту с почти постоянным шагом и
// объёмом — признак плана/DRIP даже без флага 10b5-1 и без трёхлетней истории для CMP.
export function isRegularSeries(history, tdate, issuerCik, code) {
  const prior = history.filter(h => h.tdate < tdate && h.cik === issuerCik && h.code === code);
  if (prior.length < 3) return false;
  const last = prior.slice(-4).concat([{ tdate, val: null }]);
  const days = last.map(h => Date.parse(h.tdate + 'T00:00:00Z') / 86400000);
  const gaps = [];
  for (let i = 1; i < days.length; i++) gaps.push(days[i] - days[i - 1]);
  if (gaps.some(g => g <= 0 || g > 200)) return false;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean < 20) return false; // слишком частые сделки — это не расписание
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  return sd / mean < 0.25;
}

// Инфлексия — изменение привычного поведения (паттерн VerityData «insider broke his pattern»).
// 'first-ever'  — первая покупка этого лица в наших данных при наличии прошлых сделок;
// 'first-in-3y' — не покупал три года и вдруг купил.
export function inflection(history, tdate) {
  const priorAll = history.filter(h => h.tdate < tdate);
  if (!priorAll.length) return null; // человека вообще нет в истории — не с чем сравнивать
  const priorBuys = priorAll.filter(h => h.code === 'P');
  if (!priorBuys.length) return 'first-ever';
  const cut = new Date(Date.parse(tdate + 'T00:00:00Z') - 3 * 365 * 86400000).toISOString().slice(0, 10);
  const spanYears = (Date.parse(tdate) - Date.parse(priorAll[0].tdate)) / (365 * 86400000);
  if (spanYears >= 3 && !priorBuys.some(h => h.tdate >= cut)) return 'first-in-3y';
  return null;
}

// Медиана долларового размера прошлых покупок — база для «сделка кратно больше обычной»
export function typicalBuyValue(history, tdate) {
  const vals = history.filter(h => h.tdate < tdate && h.code === 'P' && h.val > 0).map(h => h.val).sort((a, b) => a - b);
  return vals.length ? vals[(vals.length - 1) >> 1] : null;
}
