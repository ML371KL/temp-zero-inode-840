// Скоринг v2. Каждый вес обоснован конкретной работой (ПРОЕКТ.md §3) — не подобран на глаз.
// Компоненты возвращаются отдельно: интерфейс показывает разбор, а экран «Статистика»
// позволяет проверить на собственных данных, какие компоненты реально работали.
const rnd = (v, k = 4) => Math.round(v * 10 ** k) / 10 ** k;

// Приоритет ролей. Вопреки интуиции, CEO НЕ на первом месте:
// Wang/Shin/Francis (JFQA 2012) — покупки CFO дают +5% к CEO за 12 мес;
// Ravina & Sapienza (RFS 2010) — независимые директора почти не уступают исполнительным.
export const ROLE_ORDER = ['F', 'C', 'D', 'O', 'T', 'X'];
export const ROLE_POINTS = { F: 20, C: 14, D: 12, O: 10, T: 4, X: 2 };

export function topRole(rels) {
  for (const c of ROLE_ORDER) if (rels.some(x => (x ?? '').includes(c))) return c;
  return 'X';
}

// Прирост позиции: куплено / остаток до сделки. 9.99 = позиция открыта с нуля.
export function dOwnOf(r) {
  if (r.own === null || r.own === undefined || !r.sh) return null;
  const before = r.own - r.sh;
  return before > 0 ? rnd(r.sh / before) : (r.own === r.sh ? 9.99 : null);
}

export function scoreBuy({
  persons = 1,      // независимых физлиц в кластере (после склейки co-filing)
  role = 'X',
  totalVal = 0,     // объём кластера (или сделки, если одиночная)
  dOwn = null,      // прирост позиции
  dd = null,        // просадка от 52-недельного максимума на дату сделки
  track = null,     // { n, hit } — трек-рекорд инсайдера, только по дозревшим прошлым покупкам
  inflect = null,   // 'first-in-3y' | 'first-ever'
  sizeVsTypical = null, // отношение к медианному размеру прошлых покупок этого лица
} = {}) {
  const parts = {};

  // Alldredge (JFR 2019): покупка рядом с покупкой коллеги даёт +0.9 п.п./мес к одиночной.
  parts.cluster = persons >= 3 ? 30 : persons === 2 ? 18 : 0;

  parts.role = ROLE_POINTS[role] ?? 2;

  // Seyhun (1998): сигнал сильнее у крупных сделок топ-менеджеров.
  parts.size = totalVal >= 1e6 ? 10 : totalVal >= 2.5e5 ? 7 : totalVal >= 5e4 ? 3 : 0;

  // Материальность относительно уже имеющейся позиции: $50k при позиции $100k
  // информативнее $500k при позиции $50M.
  parts.conviction = dOwn === null ? 0 : dOwn >= 0.5 ? 12 : dOwn >= 0.2 ? 8 : dOwn >= 0.05 ? 3 : 0;

  // Ali & Hirshleifer (JFE 2017): прошлая успешность инсайдера — устойчивая черта (>1%/мес).
  // Считается строго point-in-time: только по окнам, дозревшим до текущей подачи.
  parts.track = 0;
  if (track && track.n >= 3) {
    if (track.hit >= 0.6) parts.track = 15;
    else if (track.hit >= 0.45) parts.track = 6;
    else if (track.hit <= 0.25 && track.n >= 4) parts.track = -6;
  }

  // Инфлексия: слом собственного паттерна (обратная сторона рутинности CMP).
  parts.inflect = inflect === 'first-in-3y' ? 12 : inflect === 'first-ever' ? 6 : 0;

  // Сделка кратно крупнее обычной для этого человека (прокси «trade scale» из 2iQ).
  parts.unusual = sizeVsTypical !== null && sizeVsTypical >= 5 ? 6 : 0;

  // Ценовой контекст: обе крайности информативны, но по разным причинам —
  // покупка на просадке (contrarian, Piotroski & Roulstone) и покупка у максимума
  // (сигнал продолжения, паттерн InsideArbitrage).
  parts.price = dd === null ? 0 : dd <= -0.30 ? 6 : dd >= -0.05 ? 6 : 0;

  const total = Math.max(0, Math.min(100, Object.values(parts).reduce((a, b) => a + b, 0)));
  return { total, parts };
}

// Свежесть сигнала: Brochet (TAR 2010) — рынок реагирует на подачу в первые дни,
// но дрейф живёт 6–12 месяцев (и short-swing rule держит инсайдера в позиции ≥6 мес).
// Используется для ранжирования скринера, но НЕ входит в сам скор, чтобы не путать
// «качество сигнала» с «давностью».
export function freshness(daysSinceFiling) {
  if (daysSinceFiling === null || daysSinceFiling === undefined) return 1;
  if (daysSinceFiling <= 14) return 1;
  if (daysSinceFiling >= 180) return 0;
  return rnd(1 - (daysSinceFiling - 14) / 166, 3);
}
