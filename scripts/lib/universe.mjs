// Загрузка и дедупликация сделок; вселенная эмитентов.
import { readJsonGz, readJson } from './util.mjs';
import { exchangeAt } from './symbols.mjs';
import { secKey } from './edgar.mjs';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// TXSE (Техасская фондовая биржа) — с 25.08.2026 справочник SEC переводит туда эмитентов с двойным листингом
// (ET, SUN, DDS, TCBI, IBOC, OBK, CECO, SUNC, USAC): до 11.2026 их покупки считались внебиржевыми.
export const ALLOWED_EXCHANGES = new Set(['NYSE', 'Nasdaq', 'CBOE', 'TXSE']);
// Площадки, которые однозначно внебиржевые. Всё прочее незнакомое решает реестр символов на дату сделки.
export const OTC_EXCHANGES = new Set(['OTC']);

function readShard(path) {
  const raw = readJsonGz(path, null);
  if (!raw) return { trades: [], amend: [] };
  return Array.isArray(raw) ? { trades: raw, amend: [] } : { trades: raw.trades ?? [], amend: raw.amend ?? [] };
}

// Все сделки из шардов с дедупликацией и разрешением поправок 4/A.
// Возвращает { trades, stats } — stats нужен для честного meta.json.
export function loadAllTrades(dataDir) {
  const dir = join(dataDir, 'trades');
  if (!existsSync(dir)) return { trades: [], stats: {} };
  const files = readdirSync(dir).filter(f => f.endsWith('.json.gz')).sort();

  // Ключ строки включает класс бумаги: одна подача может содержать покупки нескольких
  // классов (Class A + Class C), и без этого вторая строка молча затирала бы первую.
  const rowKey = r => `${r.acc}|${r.code}|${r.tdate}|${secKey(r.sec)}`;
  const byKey = new Map();
  const amend = [];
  // Датасетные строки приоритетнее live: они прошли нормализацию SEC
  for (const f of files.filter(x => x !== 'live.json.gz')) {
    const s = readShard(join(dir, f));
    for (const r of s.trades) byKey.set(rowKey(r), r);
    amend.push(...s.amend);
  }
  {
    const s = readShard(join(dir, 'live.json.gz'));
    for (const r of s.trades) if (!byKey.has(rowKey(r))) byKey.set(rowKey(r), r);
    amend.push(...s.amend);
  }

  // Поправки 4/A замещают оригинал по содержательному ключу. Количество акций в ключ НЕ
  // входит: поправки чаще всего правят именно его, и тогда оригинал с ошибочным числом
  // (встречались строки на сотни миллиардов долларов) остался бы в выборке вторым экземпляром.
  // Замещает ТОЛЬКО поправка (resolveAmendments): две исходные формы одного лица за одну дату сделки —
  // это разные покупки (KOD 30.09.2026: три формы Baker Bros на $58,6 / $35,0 / $60,5 млн), их складываем.
  // Лицо в ключе — наименьший CIK подателей, а не первый по порядку: в датасете SEC порядок подателей произвольный и у исходной
  // формы и поправки разный (в 2026q3 первый податель датасета не совпал с первым подателем формы у 18 подач из 26). Поправка с
  // несколькими подателями поэтому не находила исходную строку и оставалась вторым «первым раскрытием» со своей датой: 242 строки
  // покупок за 2016–2026, около 5 лишних событий в год (CVNA: форма 14.06.2022 и поправка 15.06.2022; аудит форм 17.11.2026, A2).
  const groups = new Map();
  for (const r of byKey.values()) {
    const k = `${r.cik}|${ownerKeyOf(r)}|${r.tdate}|${r.code}|${secKey(r.sec)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
  }
  // Второй проход — только для поправок, не нашедших исходную форму: поправка, добавившая или убравшая подателя с наименьшим
  // номером, получает другой ключ (TMUS 15.03.2018: к форме на $13,3 млн добавлен податель с меньшим CIK; 11 таких поправок за
  // 2016–2026). Группа из одних поправок ищет исходную форму среди строк того же эмитента, даты сделки, кода и класса по
  // пересечению составов подателей. Исходные формы разных лиц между собой не объединяются; подходящих групп несколько — не трогаем.
  const rejoined = rejoinOrphanAmendments(groups);
  const out = [];
  let replaced = 0, exactDups = 0, keptOriginals = 0;
  for (const g of groups.values()) {
    if (g.length === 1) { out.push(g[0]); continue; }
    const res = resolveAmendments(g);
    replaced += res.replaced; exactDups += res.exactDups; keptOriginals += res.keptOriginals;
    out.push(...res.rows);
  }

  // Аннулирующие поправки НЕ детектируются намеренно. Признак «4/A без строк P/S» выглядит
  // логично, но на реальных данных таких поправок 84% (правки грантов, деривативов, адреса),
  // а инсайдеры регулярно подают несколько форм за день — сопоставление по дате подачи
  // гасило настоящие покупки, включая целые кластеры. Отличить «поправка убрала сделку» от
  // «поправка касается другой строки» можно только сохраняя ВСЕ строки формы, а не только
  // P/S. Пока этого нет, безопаснее не гасить ничего: маркеры поправок лежат в shard.amend.
  return {
    trades: out,
    stats: { raw: byKey.size, replacedByAmendment: replaced, exactDuplicates: exactDups, separateOriginals: keptOriginals, amendments: amend.length, rejoinedAmendments: rejoined },
  };
}

// groups — Map(ключ -> строки). Группа из одних поправок (4/A) присоединяется к единственной группе того же эмитента, даты сделки,
// кода и класса, где есть исходная форма и хотя бы один общий податель. Возвращает число присоединённых строк.
export function rejoinOrphanAmendments(groups) {
  const bucketOf = r => `${r.cik}|${r.tdate}|${r.code}|${secKey(r.sec)}`;
  const ownersOf = g => { const s = new Set(); for (const r of g) for (const o of r.owners ?? []) if (o?.cik > 0) s.add(o.cik); return s; };
  const buckets = new Map();
  for (const [k, g] of groups) { const b = bucketOf(g[0]); (buckets.get(b) ?? buckets.set(b, []).get(b)).push(k); }
  let n = 0;
  for (const keys of buckets.values()) {
    if (keys.length < 2) continue;
    for (const k of keys) {
      const g = groups.get(k);
      if (!g || g.some(r => r.form !== '4/A')) continue;
      const mine = ownersOf(g);
      if (!mine.size) continue;
      const hosts = keys.filter(h => h !== k && groups.has(h) && groups.get(h).some(r => r.form !== '4/A') && [...ownersOf(groups.get(h))].some(c => mine.has(c)));
      if (hosts.length !== 1) continue;
      groups.get(hosts[0]).push(...g); groups.delete(k); n += g.length;
    }
  }
  return n;
}

// Устойчивый признак состава подателей строки: наименьший CIK (0 — подателей нет). От порядка подателей не зависит.
export function ownerKeyOf(r) {
  let m = 0;
  for (const o of r.owners ?? []) if (o?.cik > 0 && (!m || o.cik < m)) m = o.cik;
  return m;
}

// Строки одного эмитента, лица, даты сделки, кода и класса из РАЗНЫХ подач.
//  · Исходные формы (4) с одинаковыми акциями и ценой — повторная подача одного и того же: одна строка.
//  · Разные исходные формы — разные покупки: остаются все.
//  · Поправка (4/A) замещает ту строку, которую правит: с датой подачи, равной её dateOfOriginalSubmission,
//    иначе с тем же числом акций, иначе последнюю раньше неё. Замещённая строка передаёт поправке ДАТУ
//    ПЕРВОЙ ПОДАЧИ (fdate) и время приёма (at): информация стала публичной тогда, а не в день поправки.
//    Поправка без исходника в данных — первое раскрытие, остаётся со своей датой.
// Ревизия данных 11.2026: поправки и поздние формы со своей датой не дают перевеса D+1
// (события с 4/A 2016–2026, скор ≥2: −0,05%, t −0,1), а в утреннем списке выглядели свежими (CVNA 05.10 к сделке 31.07).
export function resolveAmendments(group) {
  const byDate = (a, b) => (a.fdate < b.fdate ? -1 : a.fdate > b.fdate ? 1 : (a.acc < b.acc ? -1 : 1));
  const originals = group.filter(r => r.form !== '4/A').sort(byDate);
  const amends = group.filter(r => r.form === '4/A').sort(byDate);
  const rows = [];
  let exactDups = 0, replaced = 0;
  for (const o of originals) {
    if (rows.some(x => x.sh === o.sh && x.px === o.px)) { exactDups++; continue; }
    rows.push(o);
  }
  const keptOriginals = Math.max(0, rows.length - 1);
  for (const a of amends) {
    const prior = rows.filter(x => x.fdate <= a.fdate);
    const target = prior.find(x => a.orig && (x.fdate === a.orig || x.fdate0 === a.orig))
      ?? prior.find(x => x.sh === a.sh)
      ?? (prior.length ? prior[prior.length - 1] : null);
    if (!target) { rows.push(a); continue; }
    replaced++;
    const first = target.fdate0 ?? target.fdate;
    const at = target.at ?? a.at;
    const merged = { ...a, fdate: first, fdate0: first, famend: a.fdate, ...(at ? { at } : {}) };
    rows.splice(rows.indexOf(target), 1, merged);
  }
  return { rows, replaced, exactDups, keptOriginals };
}

// Эмитенты справочника по биржам — для meta.json и журнала цен.
export function exchangeCounts(ref) {
  const out = {};
  for (const v of ref.values()) { const k = v?.exchange ?? 'нет'; out[k] = (out[k] ?? 0) + 1; }
  return out;
}

// Справочник тикеров: { cik: {ticker, exchange, name} }
export function loadTickerRef(dataDir) {
  const raw = readJson(join(dataDir, 'reference', 'tickers.json'), {});
  return new Map(Object.entries(raw).map(([cik, v]) => [Number(cik), v]));
}

// Текущий тикер по CIK (переименования FB->META); иначе — тикер из самой формы
export function resolveTicker(row, ref) {
  const cur = ref.get(row.cik);
  if (cur?.ticker) return cur.ticker.toUpperCase();
  return row.t || null;
}

// 'listed' — NYSE/Nasdaq/CBOE сейчас; 'otc' — исключаем; 'unknown' — площадка неизвестна.
//
// Справочник SEC содержит только ЖИВЫЕ компании. Раньше делистнутый эмитент всегда получал
// 'unknown' и попадал во вселенную, даже если его бумага никогда не торговалась на бирже:
// проверить площадку было нечем. Измерено — так проходили 1392 тикера и 26 тыс. покупок,
// то есть 12% выборки, и они же составляли большую часть «пропавших цен».
// Теперь при отсутствии эмитента в справочнике площадка берётся из реестра символов
// НА ДАТУ СДЕЛКИ (lib/symbols.mjs). 'unknown' остаётся только там, где реестр не знает символа.
export function issuerCategory(row, ref, ranges = null) {
  const cur = ref.get(row.cik);
  if (cur && cur.exchange) {
    if (ALLOWED_EXCHANGES.has(cur.exchange)) return 'listed';
    if (OTC_EXCHANGES.has(cur.exchange)) return 'otc';
    // Незнакомая площадка (как TXSE до 11.2026): не считаем её внебиржевой по умолчанию, спрашиваем реестр
    if (ranges && /^\d{4}-\d{2}-\d{2}$/.test(row.tdate ?? '')) {
      const kind = exchangeAt(ranges, (cur.ticker || row.t || '').toUpperCase(), row.tdate);
      if (kind) return kind === 'listed' ? 'listed' : 'otc';
    }
    return 'unknown';
  }
  if (ranges && /^\d{4}-\d{2}-\d{2}$/.test(row.tdate ?? '')) {
    const t = (cur?.ticker || row.t || '').toUpperCase();
    const kind = exchangeAt(ranges, t, row.tdate);
    if (kind) return kind === 'listed' ? 'listed' : 'otc';
  }
  return 'unknown';
}

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
export function plausibleTicker(t) {
  return !!t && TICKER_RE.test(t) && t !== 'NONE' && t !== 'N/A' && t !== 'NA';
}
