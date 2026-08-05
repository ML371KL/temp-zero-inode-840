// Различение физлиц и юрлиц + склейка связанных филеров.
// Зачем: одна форма может подаваться совместно фондом, его GP, управляющей компанией и
// партнёром-физлицом — это ОДИН экономический участник. Наивный подсчёт «уникальных CIK»
// превращает такую подачу в «кластер ×4» и завышает скор на пустом месте.

const ENTITY_RE = /\b(L\.?P\.?|LLC|L\.L\.C\.|LLP|INC\.?|CORP\.?|CORPORATION|COMPANY|CO\.|LTD\.?|GMBH|PLC|N\.?V\.?|S\.?A\.?|TRUST|FUND[S]?|CAPITAL|PARTNERS?|ADVISORS?|ADVISERS?|MANAGEMENT|HOLDINGS?|GROUP|ASSOCIATES|VENTURES?|EQUITY|INVESTMENTS?|ASSET|BANCORP|BANK|FOUNDATION|ENDOWMENT|SOCIETY|LIMITED|MASTER|OFFSHORE|SPV)\b/i;

export function isEntityName(name) {
  return ENTITY_RE.test(String(name ?? ''));
}

// Флаги отношения первичны: officer/director — это всегда человек (юрлицо не бывает офицером).
// Чистый 10%-владелец с «юрлицовым» именем — фонд.
export function isPersonOwner(owner) {
  const rel = owner?.rel ?? '';
  if (rel.includes('D') || rel.includes('O')) return true;
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

// Сколько НЕЗАВИСИМЫХ физлиц стоит за набором сделок (участники кластера).
export function countIndependentPersons(rows, groups) {
  const seen = new Set();
  for (const r of rows)
    for (const o of r.owners ?? []) {
      if (!isPersonOwner(o)) continue;
      seen.add(groups.get(o.cik) ?? o.cik);
    }
  return seen.size;
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
