// Ежедневная сверка покупок дня списка со сторонним разбором тех же форм (OpenInsider). Чистые функции без сети — их проверяют самотесты.
//
// Зачем: два списка панели (сервер и GitHub) собирает один и тот же код из одних и тех же данных — ошибку разбора, общую для обоих,
// не увидит ни одна сверка между ними. OpenInsider разбирает формы 4 сам; аудит форм 17.11.2026 сверил с ним 239 тыс. покупок
// 2006–2026 (в панели найдено 99,69%) и живое окно 02–16.11.2026 (539 из 539).
//
// Тревога — только настоящий пропуск: покупка от OI.minVal в биржевой бумаге, которая есть у стороннего разбора и которой нет в
// строках панели за этот день подачи. Обратное направление (у панели есть, у источника нет) тревогой не считается: у OpenInsider есть
// свои провалы — нет компаний развития бизнеса и части фондов (PSEC, ARCC), бывают дни, когда он сам собрал мало (09.08.2022 — 3 подачи
// из 63), — и ложную тревогу они давать не должны.
export const OI = {
  minVal: 1e5,        // порог тревоги, $
  shTol: 0.02,        // допуск по числу акций при сопоставлении
  timeoutMs: 30000,
  ua: 'InsiderRadar/1.0',   // подпись запроса: название проекта, без личных данных
};
// Страница скринера: покупки (xp=1) от $10 тыс. (vl=10) с датой подачи day, до 1 000 строк
export function oiUrl(day) {
  const [y, m, d] = day.split('-');
  const fdr = `${m}%2F${d}%2F${y}+-+${m}%2F${d}%2F${y}`;
  return `http://openinsider.com/screener?s=&o=&pl=&ph=&ll=&lh=&fd=-1&fdr=${fdr}&td=0&tdr=&fdlyl=&fdlyh=&daysago=&xp=1&vl=10&vh=&ocl=&och=`
    + '&sic1=-1&sicl=100&sich=9999&grp=0&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=&sortcol=0&cnt=1000&page=1';
}
const unescapeHtml = s => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&');
const numOf = v => Number(String(v).replace(/[^0-9.\-]/g, '')) || 0;
// Строки таблицы скринера: X | дата и время подачи | дата сделки | тикер | компания | лицо | должность | тип | цена | акции | остаток | ΔOwn | сумма.
// Строка — одна подача (акции всех покупок формы, средневзвешенная цена). Повторы (одна форма на нескольких страницах) убираются.
// Дата подачи — ссылка на форму в архиве SEC: из её адреса берётся номер подачи (acc). В ячейке тикера внутри тега стоит всплывающая
// подсказка со знаком «>», поэтому тикер — то, что после последнего «>».
export function parseOi(html) {
  const out = [], seen = new Set();
  for (const m of String(html ?? '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const raw = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(t => t[1]);
    const c = raw.map(t => unescapeHtml(t.replace(/<[^>]+>/g, '')).trim());
    if (c.length < 13 || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(c[1])) continue;
    const am = /\/Archives\/edgar\/data\/\d+\/(\d{10})(\d{2})(\d{6})\//.exec(raw[1]);
    const r = { x: c[0], filed: c[1], acc: am ? `${am[1]}-${am[2]}-${am[3]}` : null, tdate: c[2], t: c[3].split('>').pop().trim().toUpperCase(), issuer: c[4], insider: c[5], title: c[6], kind: c[7],
      px: numOf(c[8]), qty: Math.abs(numOf(c[9])), val: Math.abs(numOf(c[12])) };
    const k = `${r.filed}|${r.t}|${r.insider}|${r.tdate}|${r.qty}`;
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  }
  return out;
}
const normT = t => String(t ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normName = s => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// oiRows — parseOi; panelRows — строки покупок панели с подачей day: { acc, t (тикер формы), T (тикер справочника SEC), sh, val, owners:[{name}] };
// listed(тикер) — биржевая ли бумага. -> { day, oi, found, byName, missing, alerts }
// Сопоставление: номер подачи (у панели есть покупки этой подачи); номера в ссылке нет или подачи у панели нет — как в сверке аудита:
// тикер и число акций (подачи целиком или одной её строки) в пределах допуска; тикера у панели нет (другой класс акций, смена тикера) —
// имя лица и число акций. Последние два шага страхуют от повторной подачи той же формы под другим номером.
export function matchOi(oiRows, panelRows, { day, listed = () => true, p = OI } = {}) {
  const rows = (oiRows ?? []).filter(o => o.filed.slice(0, 10) === day && /^P/i.test(o.kind) && o.qty > 0);
  const byAcc = new Map();
  for (const r of panelRows ?? []) (byAcc.get(r.acc) ?? byAcc.set(r.acc, []).get(r.acc)).push(r);
  const byT = new Map(), byName = new Map();
  for (const [acc, rs] of byAcc) {
    for (const t of new Set(rs.flatMap(r => [normT(r.t), normT(r.T)]).filter(Boolean))) (byT.get(t) ?? byT.set(t, new Set()).get(t)).add(acc);
    for (const n of new Set(rs.flatMap(r => (r.owners ?? []).map(o => normName(o.name))).filter(Boolean))) (byName.get(n) ?? byName.set(n, new Set()).get(n)).add(acc);
  }
  const fits = (acc, qty) => {
    const rs = byAcc.get(acc), tol = Math.max(1, p.shTol * qty);
    return Math.abs(rs.reduce((s, r) => s + r.sh, 0) - qty) <= tol || rs.some(r => Math.abs(r.sh - qty) <= tol);
  };
  // refiled — подача источника с известным номером, которой у панели нет, но та же покупка найдена в другой подаче (повторная
  // подача, отдельные формы совместных подателей): не тревога, но видно в файле. partial — подача у панели есть, а акций в ней
  // меньше, чем у источника: разбор потерял часть строк формы; недостача от порога в биржевой бумаге — тревога наравне с пропуском.
  const res = { day, oi: rows.length, found: 0, byAcc: 0, byName: 0, missing: [], alerts: [], refiled: [], partial: [] };
  const oiQty = new Map(), checked = new Set();
  for (const o of rows) if (o.acc) oiQty.set(o.acc, (oiQty.get(o.acc) ?? 0) + o.qty);
  for (const o of rows) {
    if (o.acc && byAcc.has(o.acc)) {
      res.found++; res.byAcc++;
      if (!checked.has(o.acc)) {
        checked.add(o.acc);
        const want = oiQty.get(o.acc), have = byAcc.get(o.acc).reduce((s, r) => s + r.sh, 0), short = want - have;
        if (short > Math.max(1, p.shTol * want)) {
          const part = { t: o.t, acc: o.acc, issuer: o.issuer, insider: o.insider, tdate: o.tdate, filed: o.filed, qty: want, panelQty: have, px: o.px, val: Math.round(short * (o.px || 0)), listed: !!listed(o.t), partial: true };
          res.partial.push(part);
          if (part.val >= p.minVal && part.listed) res.alerts.push(part);
        }
      }
      continue;
    }
    const by = [...(byT.get(normT(o.t)) ?? [])].some(a => fits(a, o.qty)) ? 'ticker' : [...(byName.get(normName(o.insider)) ?? [])].some(a => fits(a, o.qty)) ? 'name' : null;
    if (by) {
      res.found++; if (by === 'name') res.byName++;
      if (o.acc) res.refiled.push({ t: o.t, acc: o.acc, insider: o.insider, qty: o.qty, val: o.val, by });
      continue;
    }
    const miss = { t: o.t, acc: o.acc, issuer: o.issuer, insider: o.insider, title: o.title, tdate: o.tdate, filed: o.filed, qty: o.qty, px: o.px, val: o.val, listed: !!listed(o.t) };
    res.missing.push(miss);
    if (miss.val >= p.minVal && miss.listed) res.alerts.push(miss);
  }
  res.missing.sort((a, b) => b.val - a.val); res.alerts.sort((a, b) => b.val - a.val);
  return res;
}
