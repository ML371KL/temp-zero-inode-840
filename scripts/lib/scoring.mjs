// Прозрачный скоринг покупки/кластера. Компоненты возвращаются отдельно —
// фронтенд показывает разбор, а бэктест (экран «Статистика») позволяет проверить,
// какие компоненты реально работали, и перекалибровать веса.
const rnd = (v, k = 4) => Math.round(v * 10 ** k) / 10 ** k;

export const ROLE_ORDER = ['C', 'F', 'O', 'D', 'T', 'X']; // CEO/през > CFO > офицер > директор > 10% > прочее

export function topRole(rels) {
  for (const c of ROLE_ORDER) if (rels.some(x => x.includes(c))) return c;
  return 'X';
}

// Прирост позиции: куплено / (остаток до сделки)
export function dOwnOf(r) {
  if (r.own === null || r.own === undefined || !r.sh) return null;
  const before = r.own - r.sh;
  return before > 0 ? rnd(r.sh / before) : (r.own === r.sh ? 9.99 : null); // 9.99 = позиция с нуля
}

export function scoreBuy({ clusterSize, role, totalVal, dOwn, dd, allB5 }) {
  const parts = {};
  parts.cluster = clusterSize >= 3 ? 30 : clusterSize === 2 ? 18 : 0;
  parts.role = role === 'C' ? 20 : role === 'F' ? 18 : role === 'O' ? 12 : role === 'D' ? 8 : 2;
  parts.size = totalVal >= 1e6 ? 20 : totalVal >= 2.5e5 ? 12 : totalVal >= 5e4 ? 6 : 2;
  parts.conviction = dOwn === null ? 0 : dOwn >= 0.5 ? 15 : dOwn >= 0.2 ? 8 : dOwn >= 0.05 ? 3 : 0;
  parts.dip = dd === null ? 0 : dd <= -0.30 ? 10 : dd <= -0.15 ? 5 : 0;
  parts.b5 = allB5 ? -15 : 0; // плановые покупки 10b5-1 малоинформативны
  const total = Math.max(0, Math.min(100, Object.values(parts).reduce((a, b) => a + b, 0)));
  return { total, parts };
}
