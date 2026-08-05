// Различение физлиц и юрлиц, склейка связанных филеров, роль и прирост позиции.
// Зачем: одна форма может подаваться совместно фондом, его GP, управляющей компанией и
// партнёром-физлицом — это ОДИН экономический участник. Наивный подсчёт «уникальных CIK»
// превращает такую подачу в несколько независимых покупателей — это ломает гейты sync и fund.

const ENTITY_RE = /\b(L\.?P\.?|LLC|L\.L\.C\.|LLP|INC\.?|CORP\.?|CORPORATION|COMPANY|CO\.|LTD\.?|GMBH|PLC|N\.?V\.?|S\.?A\.?|TRUST|FUND[S]?|CAPITAL|PARTNERS?|ADVISORS?|ADVISERS?|MANAGEMENT|HOLDINGS?|GROUP|ASSOCIATES|VENTURES?|EQUITY|INVESTMENTS?|ASSET|BANCORP|BANK|FOUNDATION|ENDOWMENT|SOCIETY|LIMITED|MASTER|OFFSHORE|SPV)\b/i;

export function isEntityName(name) {
  return ENTITY_RE.test(String(name ?? ''));
}

// Имя первично, флаг вторичен. Предположение «officer/director — это всегда человек»
// опровергнуто данными: 30 402 строки владельцев с явно юрлицовым именем несут флаг
// директора — это «director by deputization», обычная практика фондов (Trian Fund
// Management L.P. подаёт форму как директор Wendy's). Из-за прежнего правила такие
// юрлица считались людьми и СКЛЕИВАЛИ независимых физлиц в одну группу через совместные
// подачи: 1783 настоящих человека оказывались в 594 общих группах, и гейт синхронных
// подач переставал срабатывать — одна покупка Trian в WEN, поданная девятью формами,
// проходила фильтры целиком.
// Пустое или нечитаемое имя трактуется как физлицо: это консервативно — такая строка
// останется в выборке, а не исчезнет молча.
export function isPersonOwner(owner) {
  return !isEntityName(owner?.name);
}

class Union {
  constructor() { this.p = new Map(); }
  find(x) {
    if (!this.p.has(x)) { this.p.set(x, x); return x; }
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(x) !== r) { const n = this.p.get(x); this.p.set(x, r); x = n; }
    return r;
  }
  join(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p.set(ra, rb);
  }
}

// Граф совместных подач: CIK, встретившиеся в одном accession, считаются одной группой.
// Правила SEC разрешают совместную подачу только связанным лицам, поэтому склейка безопасна
// и консервативна: она может недосчитать участников кластера, но не выдумать лишних.
//
// ВАЖНО (аудит 08.2026): склейка идёт ОТДЕЛЬНО по юрлицам и по физлицам, мост между ними
// не строится. Прежняя сплошная склейка была транзитивной: независимый директор портфельной
// компании подавал форму вместе с фондом, другой директор другой компании — вместе с тем же
// фондом, и оба оказывались «одним покупателем». В крупнейшей группе так слиплись 396 CIK,
// включая Шварцмана и девять независимых директоров разных эмитентов; всего это затрагивало
// 3418 физлиц из 72 515 и занижало размер кластеров.
// Внутри ОДНОЙ подачи физлица по-прежнему склеиваются между собой: совместная подача
// нескольких человек разрешена SEC только связанным лицам (супруги, семейный траст).
export function buildOwnerGroups(trades) {
  const u = new Union();
  for (const r of trades) {
    const owners = (r.owners ?? []).filter(o => o.cik);
    const ents = owners.filter(o => !isPersonOwner(o)).map(o => o.cik);
    const pers = owners.filter(isPersonOwner).map(o => o.cik);
    for (let i = 1; i < ents.length; i++) u.join(ents[0], ents[i]);
    for (let i = 1; i < pers.length; i++) u.join(pers[0], pers[i]);
  }
  const groups = new Map();
  for (const r of trades)
    for (const o of r.owners ?? []) if (o.cik) groups.set(o.cik, u.find(o.cik));
  return groups;
}

// Роль подателя. Порядок значим: CFO и CEO выводятся из титула, остальное — из флагов
// формы. Роль X («иное») и O (офицер не первого эшелона) системно хуже индекса, D и F —
// лучше вселенной; в остальном роль ничего не решает (docs/ЧТО-РАБОТАЕТ.md).
export const ROLE_ORDER = ['F', 'C', 'D', 'O', 'T', 'X'];
export function topRole(rels) {
  for (const c of ROLE_ORDER) if (rels.some(x => (x ?? '').includes(c))) return c;
  return 'X';
}

// Прирост позиции: куплено / остаток до сделки. 9.99 = позиция открыта с нуля.
//
// Остаток в Form 4 относится к форме владения (прямой пакет или конкретный косвенный),
// а не к лицу. У смешанной строки (di='M') сопоставим с покупкой только прямой пакет —
// берём его. Отрицательный остаток «до» арифметически невозможен для одной формы
// владения и означает, что остаток и покупка относятся к разным пакетам (у одного лица
// бывает несколько косвенных: траст, супруга, LLC — Form 4 не даёт им ключа).
// Такие строки честнее отдать как «неизвестно», чем как правдоподобное число.
// Показывается в ленте как описание сделки: предсказательной силы у прироста нет
// (докупка <5% даёт столько же, сколько ≥20%).
export function dOwnOf(r) {
  const mixed = r.di === 'M';
  const sh = mixed ? r.shD : r.sh;
  const own = mixed ? r.ownD : r.own;
  if (own === null || own === undefined || !sh) return null;
  const before = own - sh;
  if (before < 0) return null;
  return before > 0 ? Math.round((sh / before) * 1e4) / 1e4 : 9.99;
}

// Есть ли среди подателей хотя бы одно физлицо-инсайдер (officer/director)
export function hasInsiderPerson(row) {
  return (row.owners ?? []).some(o => (o.rel ?? '').includes('D') || (o.rel ?? '').includes('O'));
}

// Сделка целиком от юрлиц-десятипроцентников (фонд): отдельный дисконтированный канал
export function isFundOnly(row) {
  const os = row.owners ?? [];
  return os.length > 0 && os.every(o => !isPersonOwner(o));
}
