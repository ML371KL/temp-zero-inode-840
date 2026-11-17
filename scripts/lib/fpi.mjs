// Иностранные частные эмитенты в потоке форм 4 (аудит форм 17.11.2026, находка 1; решение владельца 18.11.2026).
//
// Закон Holding Foreign Insiders Accountable Act (правила SEC от 27.02.2026, релиз 34-104903, в силе с 18.03.2026) обязал директоров и
// офицеров иностранных частных эмитентов подавать формы 3/4/5; раньше они были освобождены. В 20 годах истории, на которой измерено
// правило утреннего списка, этой группы нет, а с марта 2026 она даёт 6–11% основного списка, причём у части форм сумма в чужой
// валюте или в других единицах. Решение: такие события в основной список не входят (main: false, fpi: true), история по ним копится
// отдельной строкой счётчика.
//
// Кто помечается: эмитент, по которому до принятия правил не было ни одной формы 3/4/5 («новый податель»), и при этом он не обычный
// новый листинг — либо подаёт отчёты иностранного частного эмитента (20-F, 40-F, 6-K и поправки к ним), либо его бумага торговалась
// задолго до закона. Эмитент, чьи инсайдеры подавали формы и раньше, остаётся в правиле, даже если он иностранный: он в измеренной выборке.
//
// Граница «нового подателя» — 27.02.2026, а не 18.03.2026: первые формы 3 иностранных эмитентов пошли сразу после принятия правил —
// у 42 эмитентов с отчётами 20-F/6-K первая форма датирована 03–17.03.2026 (PAM 12.03, CX 13.03, GFS и NOMD 17.03), а в
// 18.12.2025–26.02.2026 таких первых форм нет ни одной.
//
// Источники (обе сборки — сервер и GitHub — читают одни и те же файлы ветки data и обязаны ставить пометку одинаково):
//   reference/first-form.json — дата первой формы 3/4/5 по эмитенту из SUBMISSION.tsv квартальных датасетов SEC, все типы документов
//                               (пишет backfill.mjs). Эмитента в файле нет — его первая форма позже последнего загруженного квартала.
//   reference/fpi-forms.json  — кто подаёт 20-F, 40-F, 6-K: из дневного индекса, который live.mjs и так скачивает; начальное наполнение —
//                               квартальные полные индексы SEC за пять кварталов (live.mjs --fpi-fill, шаг ежедневной сборки GitHub).
//   reference/symbol-ranges.json.gz и первый бар ряда цен — давность листинга.
// Справочника нет или он неполон — сборка не падает: пометок нет (или они только по части признаков), в morning.json — предупреждение.
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readJson, addDaysIso } from './util.mjs';
import { mergeRanges } from './symbols.mjs';

export const FPI = {
  lawFrom: '2026-02-27',        // правила SEC приняты; формы 3/4/5 раньше этой даты — «эмитент подавал и до закона»
  listedBefore: '2026-01-01',   // «торговалась задолго до закона»: листинг и первый бар ряда раньше этой даты
  firstFrom: '2016q1',          // справочник первой формы обязан покрывать кварталы от этого…
  needQuarter: '2026q1',        // …до этого включительно (в нём граница lawFrom); более поздние на признак не влияют
  tickerBackDays: 1096,         // преемник: тот же тикер стоял в формах другого эмитента за три года до lawFrom
  registrySlackDays: 60,        // интервал реестра должен доходить до даты подачи с таким запасом (снимок реестра отстаёт)
  staleDays: 10,                // справочник отчётов старше дня списка на столько дней — предупреждение
  fillQuarters: 5,              // начальное наполнение справочника отчётов: столько кварталов полных индексов
};
// Отчёты иностранного частного эмитента: годовые 20-F и 40-F (Канада), текущие 6-K и поправки к ним
export const FPI_FORM_RE = /^(?:20-F|40-F|6-K)(?:\/A)?$/;
export const firstFormPath = dataDir => join(dataDir, 'reference', 'first-form.json');
export const fpiFormsPath = dataDir => join(dataDir, 'reference', 'fpi-forms.json');

const quartersBetween = (a, b) => {
  const out = [];
  for (let y = Number(a.slice(0, 4)), q = Number(a.slice(5)); `${y}q${q}` <= b; q === 4 ? (y++, q = 1) : q++) out.push(`${y}q${q}`);
  return out;
};
// Справочник первой формы пригоден, когда в нём все кварталы от firstFrom до needQuarter: во время перечитывания кварталов он
// неполон, и эмитент, чей квартал ещё не прочитан, выглядел бы «новым подателем».
export const firstFormCovers = (quarters, p = FPI) => { const have = new Set(quarters ?? []); return quartersBetween(p.firstFrom, p.needQuarter).every(q => have.has(q)); };

// ---------- справочник первой формы (backfill.mjs) ----------
// first — { cik: 'ГГГГ-ММ-ДД' } одного квартала (normalizeQuarterZip). Возвращает число эмитентов, у которых дата стала раньше.
export function mergeFirstForms(ref, quarter, first) {
  ref.v = 1; ref.quarters ??= []; ref.first ??= {};
  let n = 0;
  for (const [cik, d] of Object.entries(first ?? {})) if (d && (!ref.first[cik] || d < ref.first[cik])) { ref.first[cik] = d; n++; }
  if (!ref.quarters.includes(quarter)) ref.quarters.push(quarter);
  ref.quarters.sort();
  return n;
}

// ---------- справочник отчётов иностранных эмитентов (live.mjs) ----------
// Строки индекса SEC (дневного form.ГГГГММДД.idx или квартального full-index/…/form.idx) с отчётами иностранного эмитента.
// Поля берутся с КОНЦА строки, как у parseFormIdx: в названиях компаний встречаются двойные пробелы. -> [{ cik, date }]
const FPI_LINE_RE = /^((?:20-F|40-F|6-K)(?:\/A)?)\s{2,}.*?\s(\d{1,10})\s+(\d{4})-?(\d{2})-?(\d{2})\s+edgar\/data\/\S+\s*$/;
export function parseFpiIdx(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = FPI_LINE_RE.exec(line.replace(/\r$/, ''));
    if (m) out.push({ cik: Number(m[2]), date: `${m[3]}-${m[4]}-${m[5]}` });
  }
  return out;
}
export const emptyFpiForms = () => ({ v: 1, asOf: null, filled: [], fillDone: false, ciks: {} });
// rows — [{ cik, date }]; day — день индекса (для дневного индекса), по который справочник теперь полон. Возвращает true, если что-то изменилось.
export function absorbFpiForms(ref, rows, day = null) {
  ref.ciks ??= {};
  let changed = false;
  for (const { cik, date } of rows ?? []) if (cik > 0 && date && !(ref.ciks[cik] >= date)) { ref.ciks[cik] = date; changed = true; }
  if (day && !(ref.asOf >= day)) { ref.asOf = day; changed = true; }
  return changed;
}
// Кварталы начального наполнения: текущий (по дате today) и fillQuarters − 1 перед ним, от старого к новому. -> [{ y, q, key }]
export function fillQuartersFor(today, n = FPI.fillQuarters) {
  let y = Number(today.slice(0, 4)), q = Math.ceil(Number(today.slice(5, 7)) / 3);
  const out = [];
  for (let k = 0; k < n; k++) { out.unshift({ y, q, key: `${y}q${q}` }); if (--q === 0) { q = 4; y--; } }
  return out;
}
export const fullIndexUrl = (base, y, q) => `${base}/Archives/edgar/full-index/${y}/QTR${q}/form.gz`;
// Тело ответа full-index/…/form.gz: gzip (как лежит в архиве) или уже распакованный текст (если транспорт распаковал сам)
export function fullIndexText(body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
  return (b.length > 2 && b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString('latin1');
}

// ---------- чтение для сборки ----------
// -> { first: Map(cik -> дата) | null, forms: Set(cik) | null, formsAsOf, warn: [строки предупреждений] }
export function loadFpiRefs(dataDir, p = FPI) {
  const warn = [];
  const ff = readJson(firstFormPath(dataDir), null), fr = readJson(fpiFormsPath(dataDir), null);
  let first = null, forms = null;
  if (!ff?.first) warn.push('нет справочника первой формы по эмитенту (reference/first-form.json): иностранные эмитенты не помечаются');
  else if (!firstFormCovers(ff.quarters, p)) warn.push(`справочник первой формы по эмитенту неполон (нужны кварталы ${p.firstFrom}–${p.needQuarter}): иностранные эмитенты не помечаются`);
  else first = new Map(Object.entries(ff.first).map(([k, v]) => [Number(k), v]));
  if (!fr?.ciks || !fr.fillDone) warn.push('справочник отчётов иностранных эмитентов (reference/fpi-forms.json) не наполнен: пометка только по давности листинга');
  else forms = new Set(Object.keys(fr.ciks).map(Number));
  return { first, forms, formsAsOf: fr?.asOf ?? null, warn };
}
// Справочник отчётов отстал от дня списка — предупреждение (пометки ставятся по тому, что есть)
export function fpiStaleWarning(refs, listFor, p = FPI) {
  if (!refs?.forms || !listFor) return null;
  return !refs.formsAsOf || refs.formsAsOf < addDaysIso(listFor, -p.staleDays)
    ? `справочник отчётов иностранных эмитентов устарел (по ${refs.formsAsOf ?? '—'}, список за ${listFor})` : null;
}

// Начало листинга по реестру символов: начало слитого интервала, в который попадает дата (последний с началом не позже даты, если он
// дотянут до даты с запасом на отставание снимка реестра). null — реестр символа не знает или интервал давно кончился.
export function listedSince(ranges, ticker, iso, p = FPI) {
  const list = ranges?.[String(ticker ?? '').toUpperCase()];
  if (!list?.length) return null;
  let hit = null;
  for (const [s, e] of mergeRanges(list)) if (s <= iso) hit = [s, e];
  return hit && hit[1] >= addDaysIso(iso, -p.registrySlackDays) ? hit[0] : null;
}
// «Торговалась задолго до закона» — и листинг по реестру, и первый бар ряда раньше listedBefore. Нужны ОБА: реестр под одним тикером
// склеивает старую и новую компании (ITG, LIME: листинг «с 1994 года», а ряд начинается с IPO 2026 года), а ряд без записи в реестре
// бывает чужим (CCCT). Нет любого из двух — признака нет.
export function longListed(ranges, ticker, iso, bar0, p = FPI) {
  const s = listedSince(ranges, ticker, iso, p);
  return !!s && s < p.listedBefore && !!bar0 && bar0 < p.listedBefore;
}
// Тикеры, стоявшие в формах перед законом: тикер формы -> Set(CIK эмитентов) по строкам P и S с подачей в [lawFrom − tickerBackDays, lawFrom).
// Новый CIK под тикером, по которому формы шли у другого CIK, — смена регистранта у того же эмитента (реорганизация: NVRI 05.2026,
// CLBK 07.2026), а не иностранный эмитент: его инсайдеры в измеренной выборке.
export function tickersBeforeLaw(trades, p = FPI) {
  const from = addDaysIso(p.lawFrom, -p.tickerBackDays), out = new Map();
  for (const r of trades ?? []) {
    if (!(r.fdate >= from && r.fdate < p.lawFrom)) continue;
    const t = String(r.t ?? '').toUpperCase();
    if (t) (out.get(t) ?? out.set(t, new Set()).get(t)).add(r.cik);
  }
  return out;
}

// Вердикт по эмитенту события: null — не помечается; 'forms' — новый податель с отчётами иностранного эмитента; 'listed' — новый
// податель с давним листингом (отчёты подаёт местные или справочника отчётов нет). x — { cik, ticker, fdate, bar0 }: тикер и первый
// бар ряда цен — как у строки сборки (тикер справочника SEC), fdate — день подачи.
export function fpiVerdict(x, refs, { ranges = null, before = null } = {}, p = FPI) {
  if (!refs?.first) return null;
  const f = refs.first.get(x.cik);
  if (f && f < p.lawFrom) return null;                                   // формы были и до закона — эмитент в измеренной выборке
  if (refs.forms?.has(x.cik)) return 'forms';
  if (!longListed(ranges, x.ticker, x.fdate, x.bar0, p)) return null;   // обычный новый листинг
  const prior = before?.get(String(x.ticker ?? '').toUpperCase());
  if (prior && [...prior].some(c => c !== x.cik)) return null;           // тот же тикер у прежнего регистранта — не новый податель
  return 'listed';
}
