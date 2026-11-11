// EDGAR: квартальные структурированные датасеты Forms 3/4/5, daily-index, XML Form 4.
// Нормализованная строка сделки (схема v2):
// { acc, form, fdate, tdate, cik, t, owners:[{cik,name,rel,title}], code, sh, px, val,
//   own, di, b5, orig, fn:{...} }
// Шард: { v:2, trades:[...], amend:[{acc,cik,owners,orig,rows}] } — amend нужен для
// детекции аннулированных сделок (4/A без строк, которые были в оригинале).
import { politeFetch, parseTsv, secDate, num, isIsoDate } from './util.mjs';
import { zipExtract } from './zip.mjs';
import { rowFootnoteFlags, holdingFootnoteFlags, fnIds } from './footnotes.mjs';

export const SHARD_VERSION = 3;
// Ревизия разбора уже собранных строк (сноски, даты). Рост номера НЕ сбрасывает шард и не задерживает
// сегодняшний день: live.mjs перечитывает окно [from, lastDay] в остаток бюджета (state.reread) и
// замещает строки подач свежим разбором. 1 — разбор до 11.2026; 2 — природа сделки только по
// сноскам полей сделки, сноски к остатку и форме владения — в fnh (ревизия данных, П2).
export const PARSER_REV = 2;
// То же для квартальных датасетов: backfill.mjs перечитывает кварталы с меньшей ревизией и замещает
// строки на месте (как при смене схемы, но без смены SHARD_VERSION и без задержки живого контура).
// 3 — флажок 10b5-1 «true» и сноски со всех полей сделки датасета (EQUITY_SWAP_TRANS_CD_FN и др.).
export const QUARTER_REV = 3;
// Поля датасета, сноски к которым описывают пакет, а не сделку (см. П2 в FIXES-COLLECT.md)
const HOLD_FN_FIELDS = new Set(['NATURE_OF_OWNERSHIP_FN', 'DIRECT_INDIRECT_OWNERSHIP_FN', 'SHRS_OWND_FOLWNG_TRANS_FN', 'VALU_OWND_FOLWNG_TRANS_FN']);

// Остаток владения (SHRS_OWND_FOLWNG_TRANS) относится к КОНКРЕТНОЙ форме владения, а не
// к лицу: прямой пакет и пакет «через траст» — разные счётчики. Строки одной подачи мы
// агрегируем (одна покупка часто разбита на несколько ценовых строк), и раньше в ключ
// агрегации не входил признак D/I: прямой и косвенный пакеты складывались, а остаток
// брался из случайно последней строки. Купленные акции при этом суммируются верно —
// портится именно остаток, а с ним прирост позиции dOwn.
// Измерено на 3 кварталах: смешанных агрегатов 3.2%, и ключ с D/I устраняет лишь 15%
// арифметических невозможностей — остальное это НЕСКОЛЬКО КОСВЕННЫХ пакетов у одного
// лица (траст, супруга, LLC), которым Form 4 не даёт структурного ключа вовсе.
// Поэтому: (1) считаем остаток по форме владения, (2) внутри формы берём МАКСИМУМ —
// при разбиении одной покупки на ценовые строки остаток растёт, и итоговый в последней;
// (3) там, где однозначно сопоставить нельзя, отдаём null вместо правдоподобного числа.
function foldOwnership(forms, code) {
  const out = { di: 'D', sh: 0, own: null, ownD: null, shD: null };
  const keys = [...forms.keys()];
  for (const [, f] of forms) out.sh += f.sh;
  out.di = keys.length > 1 ? 'M' : (keys[0] ?? 'D');
  const pick = f => f.own === null ? null : (code === 'S' ? f.ownMin : f.ownMax);
  const direct = forms.get('D');
  if (direct) { out.shD = Math.round(direct.sh); out.ownD = pick(direct); }
  // Остаток отдаём только для однородной строки: у смешанной он относился бы к одной
  // из форм, а sh — к обеим, и прирост позиции получился бы завышенным без всякого признака.
  if (keys.length === 1) out.own = pick(forms.get(keys[0]));
  return out;
}

// Адрес квартальных датасетов SEC сменился: 2026q2 (09.07.2026) и 2026q3 (07.10.2026) лежат под
// /files/datastandardsinnovation/, прежние — под /files/structureddata/. По старому адресу новые кварталы
// отвечают 404, и бэкфил считал их «не опубликованными». Пробуем оба пути, новый первым.
export const DATASET_URLS = q => [
  `${edgarBase()}/files/datastandardsinnovation/data/insider-transactions-data-sets/${q}_form345.zip`,
  `${edgarBase()}/files/structureddata/data/insider-transactions-data-sets/${q}_form345.zip`,
];

// Ключ класса бумаги для склейки строк: XML формы хранит название с экранированием (&quot;), датасет SEC —
// в кавычках CSV; длина обрезки у них разная. Без нормализации одна и та же строка получала два ключа
// (188 строк 04–09.2026), и при загрузке квартала строки задвоились бы.
export function secKey(s) {
  return String(s ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/"/g, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40);
}

export function quarterList(fromYear, toYear, toQ) {
  const out = [];
  for (let y = fromYear; y <= toYear; y++)
    for (let q = 1; q <= 4; q++) {
      if (y === toYear && q > toQ) break;
      out.push(`${y}q${q}`);
    }
  return out;
}

// Роли: строка RPTOWNER_RELATIONSHIP вида "Officer, Director" -> флаги.
// C (CEO/президент) и F (CFO) выводятся из титула — ключевой срез скоринга.
export function relFlags(relStr, title) {
  const s = (relStr || '').toLowerCase();
  let rel = '';
  if (s.includes('director')) rel += 'D';
  if (s.includes('officer')) rel += 'O';
  if (s.includes('tenpercent') || s.includes('10%')) rel += 'T';
  if (s.includes('other')) rel += 'X';
  return (rel || 'X') + titleFlags(title);
}

export function titleFlags(title) {
  const t = (title || '').toLowerCase();
  if (/\bceo\b|chief\s+exec|\bpres(?:ident)?\b/.test(t)) return 'C';
  if (/\bcfo\b|chief\s+fin|principal\s+financial/.test(t)) return 'F';
  return '';
}

// Квартальный zip -> { trades, amend }. Только коды P и S, формы 4/4A, без своп-сделок.
export function normalizeQuarterZip(zipBuf) {
  const subs = new Map();
  for (const r of parseTsv(zipExtract(zipBuf, 'SUBMISSION.tsv').toString('utf8'))) {
    if (r.DOCUMENT_TYPE !== '4' && r.DOCUMENT_TYPE !== '4/A') continue;
    subs.set(r.ACCESSION_NUMBER, {
      form: r.DOCUMENT_TYPE,
      fdate: secDate(r.FILING_DATE),
      cik: Number(r.ISSUERCIK),
      t: (r.ISSUERTRADINGSYMBOL || '').trim().toUpperCase(),
      // Флажок плана SEC пишет то «1»/«0», то «true»/«false» (2026q3: 3 798 «1» и 1 237 «true»). До 11.2026
      // признавалась только «1», и каждая четвёртая отмеченная форма датасета читалась как дискреционная.
      b5: ['1', 'true'].includes(String(r.AFF10B5ONE ?? '').trim().toLowerCase()) ? 1 : 0,
      orig: secDate(r.DATE_OF_ORIG_SUB),
      remarks: r.REMARKS || '',
    });
  }
  const owners = new Map();
  for (const r of parseTsv(zipExtract(zipBuf, 'REPORTINGOWNER.tsv').toString('utf8'))) {
    if (!subs.has(r.ACCESSION_NUMBER)) continue;
    const list = owners.get(r.ACCESSION_NUMBER) ?? [];
    list.push({
      cik: Number(r.RPTOWNERCIK),
      name: r.RPTOWNERNAME,
      rel: relFlags(r.RPTOWNER_RELATIONSHIP, r.RPTOWNER_TITLE),
      title: r.RPTOWNER_TITLE || '',
    });
    owners.set(r.ACCESSION_NUMBER, list);
  }
  // Сноски: acc -> { F1: текст }
  const notes = new Map();
  const fnBuf = zipExtract(zipBuf, 'FOOTNOTES.tsv');
  if (fnBuf) {
    for (const r of parseTsv(fnBuf.toString('utf8'))) {
      if (!subs.has(r.ACCESSION_NUMBER)) continue;
      const m = notes.get(r.ACCESSION_NUMBER) ?? new Map();
      m.set(r.FOOTNOTE_ID, r.FOOTNOTE_TXT || '');
      notes.set(r.ACCESSION_NUMBER, m);
    }
  }

  // Агрегация по (accession, code, tdate): множественные строки одной сделки по разным ценам
  const agg = new Map();
  const rowCount = new Map(); // acc -> число строк P/S (для детекции аннулирующих 4/A)
  for (const r of parseTsv(zipExtract(zipBuf, 'NONDERIV_TRANS.tsv').toString('utf8'))) {
    const sub = subs.get(r.ACCESSION_NUMBER);
    if (!sub) continue;
    if (r.TRANS_CODE !== 'P' && r.TRANS_CODE !== 'S') continue;
    rowCount.set(r.ACCESSION_NUMBER, (rowCount.get(r.ACCESSION_NUMBER) ?? 0) + 1);
    if (r.EQUITY_SWAP_INVOLVED === '1' || r.EQUITY_SWAP_INVOLVED === 'true') continue;
    const tdate = secDate(r.TRANS_DATE);
    const sh = num(r.TRANS_SHARES), px = num(r.TRANS_PRICEPERSHARE);
    if (!tdate || !sh || sh <= 0) continue;
    // Класс бумаги важен: в Table I попадают и привилегированные акции, и варранты —
    // их цена не сопоставима с котировкой обыкновенных, а сигнал у них другой природы
    const key = `${r.ACCESSION_NUMBER}|${r.TRANS_CODE}|${tdate}|${r.SECURITY_TITLE}`;
    const a = agg.get(key) ?? { sh: 0, cost: 0, forms: new Map(), fnIds: new Set(), holdIds: new Set(), sec: r.SECURITY_TITLE || '' };
    a.sh += sh;
    a.cost += sh * (px ?? 0);
    // Учёт по форме владения (см. foldOwnership): остаток относится к ней, а не к лицу
    const di = r.DIRECT_INDIRECT_OWNERSHIP === 'I' ? 'I' : 'D';
    const f = a.forms.get(di) ?? { sh: 0, own: null, ownMin: null, ownMax: null };
    f.sh += sh;
    const own = num(r.SHRS_OWND_FOLWNG_TRANS);
    // Одна покупка обычно разбита на несколько ценовых строк, и остаток в них НАРАСТАЕТ:
    // итоговый — наибольший. Раньше брался остаток случайно последней строки, из-за чего
    // прирост позиции ошибался на порядок (HY 2019-03-27: +500% вместо +1%).
    // У продаж остаток, наоборот, убывает — там итоговый наименьший.
    if (own !== null) {
      f.own = own;
      f.ownMin = f.ownMin === null ? own : Math.min(f.ownMin, own);
      f.ownMax = f.ownMax === null ? own : Math.max(f.ownMax, own);
    }
    a.forms.set(di, f);
    // Природу сделки определяют только сноски к полям самой сделки. Сноски к остатку и форме владения
    // описывают пакет («в остатке есть N акций из DRIP/ESPP») — раньше они отсеивали обычные покупки
    // (66% отсевов DRIP/ESPP в 2016–2026, CEO Uber $10 млн 10.09.2026). Они идут в теги (fnh).
    // Поля сделки — все *_FN, кроме полей остатка и формы владения: сноска о плане 10b5-1 бывает и на
    // EQUITY_SWAP_TRANS_CD_FN (Nippon Life в CRBG, 2026q3), и на TRANS_TIMELINESS_FN.
    for (const [k, v] of Object.entries(r)) {
      if (!v || !k.endsWith('_FN')) continue;
      for (const id of fnIds(v)) (HOLD_FN_FIELDS.has(k) ? a.holdIds : a.fnIds).add(id);
    }
    a.acc = r.ACCESSION_NUMBER; a.code = r.TRANS_CODE; a.tdate = tdate;
    agg.set(key, a);
  }

  const trades = [];
  for (const a of agg.values()) {
    const sub = subs.get(a.acc);
    const noteMap = notes.get(a.acc);
    const rowTexts = noteMap ? [...a.fnIds].map(id => noteMap.get(id)).filter(Boolean) : [];
    const holdTexts = noteMap ? [...a.holdIds].filter(id => !a.fnIds.has(id)).map(id => noteMap.get(id)).filter(Boolean) : [];
    const allTexts = noteMap ? [...noteMap.values()] : [];
    if (sub.remarks) allTexts.push(sub.remarks); // Remarks часто содержит дату плана 10b5-1
    const px = a.sh > 0 ? a.cost / a.sh : null;
    const ow = foldOwnership(a.forms, a.code);
    const fn = rowFootnoteFlags(rowTexts, allTexts, holdTexts);
    const fnh = holdingFootnoteFlags(holdTexts, fn);
    trades.push({
      acc: a.acc, form: sub.form, fdate: sub.fdate, tdate: a.tdate,
      cik: sub.cik, t: sub.t,
      owners: owners.get(a.acc) ?? [],
      code: a.code, sh: Math.round(a.sh),
      px: px !== null ? Math.round(px * 10000) / 10000 : null,
      val: Math.round(a.cost),
      own: ow.own, di: ow.di, ownD: ow.ownD, shD: ow.shD, b5: sub.b5,
      orig: sub.orig ?? null,
      sec: a.sec.slice(0, 60),
      fn, ...(Object.keys(fnh).length ? { fnh } : {}),
    });
  }

  // Маркеры поправок: нужны, чтобы отличить «4/A правит строку» от «4/A аннулирует сделку»
  const amend = [];
  for (const [acc, sub] of subs) {
    if (sub.form !== '4/A' || !sub.orig) continue;
    amend.push({
      acc, cik: sub.cik, orig: sub.orig,
      owners: (owners.get(acc) ?? []).map(o => o.cik),
      rows: rowCount.get(acc) ?? 0,
    });
  }
  return { v: SHARD_VERSION, trades, amend };
}

export async function fetchQuarter(q) {
  let status = null;
  for (const url of DATASET_URLS(q)) {
    const res = await politeFetch(url);
    status = res.status;
    if (res.body) return { status, data: normalizeQuarterZip(res.body), url };
  }
  return { status, data: null };
}

// ---- Живой контур: daily-index ----

// Строка form.idx: «Form Type | Company Name | CIK | Date Filed | File Name» колонками фиксированной
// ширины. Резать по «2+ пробела» нельзя: в именах подателей встречается двойной пробел
// («DANIELS  ROBERT P», «MURDOCH  KEITH RUPERT») — колонки съезжают, путь превращается в дату и уходит
// в 404 (17 строк за 65 дней в 08–11.2026). Поэтому поля берутся с КОНЦА строки: путь, дата, CIK.
const IDX_LINE_RE = /^(4|4\/A)\s{2,}.*?\s(\d{1,10})\s+(\d{8}|\d{4}-\d{2}-\d{2})\s+(edgar\/data\/\S+\.txt)\s*$/;
export const accOfPath = p => /(\d{10}-\d{2}-\d{6})\.txt$/.exec(p ?? '')?.[1] ?? String(p ?? '').replace(/^.*\//, '').replace(/\.txt$/, '');
export function parseFormIdx(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = IDX_LINE_RE.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    out.push({ form: m[1], cik: Number(m[2]), path: m[4], acc: accOfPath(m[4]) });
  }
  return out;
}
// Одна подача стоит в индексе по строке на эмитента и на каждого подателя (в среднем 2,08 строки):
// качать её нужно один раз. Порядок — первое вхождение.
export function uniqueFilings(entries) {
  const byAcc = new Map();
  for (const e of entries ?? []) if (!byAcc.has(e.acc)) byAcc.set(e.acc, e);
  return [...byAcc.values()];
}

// Корень архива EDGAR. Переопределяется только самотестами (EDGAR_BASE — локальный сервер).
export const edgarBase = () => process.env.EDGAR_BASE ?? 'https://www.sec.gov';

// Дневной индекс. entries === null — файла нет (праздник или ещё не вышел: SEC отвечает 403 хранилища).
// Сбой сети, 5xx и лимит SEC после повторов — исключение: «индекса нет» и «не достучались» — разные вещи.
export async function fetchDayIndex(iso, { retries = 4 } = {}) {
  const [y, m, d] = iso.split('-');
  const qtr = 'QTR' + Math.ceil(Number(m) / 3);
  const url = `${edgarBase()}/Archives/edgar/daily-index/${y}/${qtr}/form.${y}${m}${d}.idx`;
  const { status, body } = await politeFetch(url, { as: 'text', retries });
  if (!body) return { status, entries: null };
  return { status, entries: parseFormIdx(body) };
}

// ---- Парсер XML Form 4 ----

function tag(xml, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1].trim() : null;
}
function tagVal(xml, name) {
  const inner = tag(xml, name);
  if (inner === null) return null;
  const v = tag(inner, 'value');
  return v !== null ? v : inner.replace(/<[^>]*>/g, '').trim();
}
function allBlocks(xml, name) {
  const out = [];
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function boolVal(s) { return s === '1' || s === 'true'; }
// Дата XML-формы иногда приходит со смещением пояса: «2026-10-28-05:00» (агенты 0001477932 и 0001654954 —
// NEGG, ASPI, COSM, FONR, EML). Это та же календарная дата; раньше строка не проходила isIsoDate и
// транзакция выбрасывалась целиком. Возвращает «ГГГГ-ММ-ДД» или исходную строку без изменений.
export function normalizeXmlDate(s) {
  if (s === null || s === undefined) return s;
  const t = String(s).trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:T[\d:.]+)?(?:Z|[+-]\d{2}:?\d{2})$/.exec(t);
  return m ? m[1] : t;
}
function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#\d+;/g, ' ').replace(/&amp;/g, '&');
}

// Время приёма формы из шапки полного .txt: «<ACCEPTANCE-DATETIME>20261103082635» — это время EDGAR
// по Нью-Йорку (проверено на 40 формах за 03.11.2026: все на дату подачи, с 08:26 до 21:20 — форма 4
// принимается до 22:00 ET, при UTC вечерние формы уходили бы за полночь). Возвращает
// «ГГГГ-ММ-ДДTчч:мм» или null; битое значение не бросает — поле необязательное.
export function acceptedAt(header) {
  const m = /<ACCEPTANCE-DATETIME>(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\d{2}/.exec(header ?? '');
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  return isIsoDate(date) && Number(m[4]) < 24 && Number(m[5]) < 60 ? `${date}T${m[4]}:${m[5]}` : null;
}

// Полный .txt сабмишен -> { trades, amend } (та же схема, что из датасета)
export function parseForm4Txt(txt, acc, fdate) {
  const xm = /<XML>([\s\S]*?)<\/XML>/.exec(txt);
  if (!xm) return { trades: [], amend: [] };
  const xml = xm[1];
  if (!/<ownershipDocument/.test(xml)) return { trades: [], amend: [] };
  const docType = tag(xml, 'documentType');
  if (docType !== '4' && docType !== '4/A') return { trades: [], amend: [] };
  const issuer = tag(xml, 'issuer') ?? '';
  const cik = Number(tag(issuer, 'issuerCik'));
  const t = (tag(issuer, 'issuerTradingSymbol') || '').trim().toUpperCase();
  const b5 = boolVal(tagVal(xml, 'aff10b5One')) ? 1 : 0;
  const at = acceptedAt(txt.slice(0, xm.index));
  const orig = normalizeXmlDate(tagVal(xml, 'dateOfOriginalSubmission'));
  const remarks = unescapeXml(tag(xml, 'remarks') || '');

  const owners = allBlocks(xml, 'reportingOwner').map(o => {
    const rid = tag(o, 'reportingOwnerId') ?? '';
    const rr = tag(o, 'reportingOwnerRelationship') ?? '';
    let rel = '';
    if (boolVal(tagVal(rr, 'isDirector'))) rel += 'D';
    if (boolVal(tagVal(rr, 'isOfficer'))) rel += 'O';
    if (boolVal(tagVal(rr, 'isTenPercentOwner'))) rel += 'T';
    if (boolVal(tagVal(rr, 'isOther'))) rel += 'X';
    const title = unescapeXml(tag(rr, 'officerTitle') || '');
    return {
      cik: Number(tag(rid, 'rptOwnerCik')),
      name: unescapeXml(tag(rid, 'rptOwnerName') || ''),
      rel: (rel || 'X') + titleFlags(title || remarks),
      title,
    };
  });

  // Сноски документа
  const noteMap = new Map();
  const fnBlock = tag(xml, 'footnotes') ?? '';
  const fnRe = /<footnote\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/footnote>/g;
  let fm;
  while ((fm = fnRe.exec(fnBlock))) noteMap.set(fm[1], unescapeXml(fm[2].replace(/<[^>]*>/g, ' ')));
  const allTexts = [...noteMap.values()];
  if (remarks) allTexts.push(remarks);

  const agg = new Map();
  const table = tag(xml, 'nonDerivativeTable') ?? '';
  let rows = 0;
  for (const tr of allBlocks(table, 'nonDerivativeTransaction')) {
    const coding = tag(tr, 'transactionCoding') ?? '';
    const code = tag(coding, 'transactionCode');
    if (code !== 'P' && code !== 'S') continue;
    rows++;
    if (boolVal(tag(coding, 'equitySwapInvolved'))) continue;
    const tdate = normalizeXmlDate(tagVal(tr, 'transactionDate'));
    const amounts = tag(tr, 'transactionAmounts') ?? '';
    const sh = num(tagVal(amounts, 'transactionShares'));
    const px = num(tagVal(amounts, 'transactionPricePerShare'));
    // Дата из XML не проходит никакой валидации на стороне SEC — проверяем сами
    if (!isIsoDate(tdate) || !sh || sh <= 0) continue;
    const post = tag(tr, 'postTransactionAmounts') ?? '';
    const own = num(tagVal(post, 'sharesOwnedFollowingTransaction'));
    const nature = tag(tr, 'ownershipNature') ?? '';
    const di = tagVal(nature, 'directOrIndirectOwnership') === 'I' ? 'I' : 'D';
    const secTitle = unescapeXml(tagVal(tr, 'securityTitle') ?? '');
    const key = `${code}|${tdate}|${secTitle}`;
    const a = agg.get(key) ?? { sh: 0, cost: 0, forms: new Map(), ids: new Set(), holdIds: new Set(), sec: secTitle };
    a.sh += sh; a.cost += sh * (px ?? 0);
    const f = a.forms.get(di) ?? { sh: 0, own: null, ownMin: null, ownMax: null };
    f.sh += sh;
    // Одна покупка обычно разбита на несколько ценовых строк, и остаток в них НАРАСТАЕТ:
    // итоговый — наибольший. Раньше брался остаток случайно последней строки, из-за чего
    // прирост позиции ошибался на порядок (HY 2019-03-27: +500% вместо +1%).
    // У продаж остаток, наоборот, убывает — там итоговый наименьший.
    if (own !== null) {
      f.own = own;
      f.ownMin = f.ownMin === null ? own : Math.min(f.ownMin, own);
      f.ownMax = f.ownMax === null ? own : Math.max(f.ownMax, own);
    }
    a.forms.set(di, f);
    // Сноски, привязанные к полям именно этой транзакции. Сноски к остатку (postTransactionAmounts) и
    // форме владения (ownershipNature) описывают пакет, а не сделку («в остатке есть N акций из DRIP»):
    // природу сделки они не определяют и идут в теги (fnh).
    const holdPart = (/<postTransactionAmounts>[\s\S]*?<\/postTransactionAmounts>/.exec(tr)?.[0] ?? '')
      + (/<ownershipNature>[\s\S]*?<\/ownershipNature>/.exec(tr)?.[0] ?? '');
    const txnPart = tr.replace(/<postTransactionAmounts>[\s\S]*?<\/postTransactionAmounts>/, '')
      .replace(/<ownershipNature>[\s\S]*?<\/ownershipNature>/, '');
    for (const idm of txnPart.matchAll(/<footnoteId\s+id="([^"]+)"/g)) a.ids.add(idm[1]);
    for (const idm of holdPart.matchAll(/<footnoteId\s+id="([^"]+)"/g)) a.holdIds.add(idm[1]);
    a.code = code; a.tdate = tdate;
    agg.set(key, a);
  }

  const trades = [];
  for (const a of agg.values()) {
    const rowTexts = [...a.ids].map(id => noteMap.get(id)).filter(Boolean);
    const holdTexts = [...a.holdIds].filter(id => !a.ids.has(id)).map(id => noteMap.get(id)).filter(Boolean);
    const ow = foldOwnership(a.forms, a.code);
    const fn = rowFootnoteFlags(rowTexts, allTexts, holdTexts);
    const fnh = holdingFootnoteFlags(holdTexts, fn);
    trades.push({
      acc, form: docType, fdate, tdate: a.tdate, cik, t, owners,
      code: a.code, sh: Math.round(a.sh),
      px: a.sh > 0 ? Math.round((a.cost / a.sh) * 10000) / 10000 : null,
      val: Math.round(a.cost), own: ow.own, di: ow.di, ownD: ow.ownD, shD: ow.shD, b5,
      orig: orig ?? null,
      sec: String(a.sec).slice(0, 60),
      fn, ...(Object.keys(fnh).length ? { fnh } : {}),
      // Необязательное поле: у строк квартальных датасетов и у старых строк живого шарда его нет
      ...(at ? { at } : {}),
    });
  }
  const amend = docType === '4/A' && orig
    ? [{ acc, cik, orig, owners: owners.map(o => o.cik), rows }]
    : [];
  return { trades, amend };
}

// Полный .txt подачи; null — подачи нет (404). Сбой и лимит SEC — исключение.
export async function fetchFiling(path, { retries = 4 } = {}) {
  const { body } = await politeFetch(`${edgarBase()}/Archives/${path}`, { as: 'text', retries });
  return body;
}

export async function fetchTickerRef() {
  const { body } = await politeFetch('https://www.sec.gov/files/company_tickers_exchange.json', { as: 'text' });
  if (!body) throw new Error('company_tickers_exchange.json недоступен');
  const j = JSON.parse(body);
  const iCik = j.fields.indexOf('cik'), iT = j.fields.indexOf('ticker'),
    iEx = j.fields.indexOf('exchange'), iName = j.fields.indexOf('name');
  const byCik = new Map();
  for (const row of j.data) {
    const cik = row[iCik];
    // Первый листинг CIK — основной класс акций
    if (!byCik.has(cik)) byCik.set(cik, { ticker: row[iT], exchange: row[iEx], name: row[iName] });
  }
  return byCik;
}
