// EDGAR: квартальные структурированные датасеты Forms 3/4/5, daily-index, XML Form 4.
// Нормализованная строка сделки (схема v2):
// { acc, form, fdate, tdate, cik, t, owners:[{cik,name,rel,title}], code, sh, px, val,
//   own, di, b5, orig, fn:{...} }
// Шард: { v:2, trades:[...], amend:[{acc,cik,owners,orig,rows}] } — amend нужен для
// детекции аннулированных сделок (4/A без строк, которые были в оригинале).
import { politeFetch, parseTsv, secDate, num, isIsoDate } from './util.mjs';
import { zipExtract } from './zip.mjs';
import { rowFootnoteFlags, fnIds } from './footnotes.mjs';

export const SHARD_VERSION = 2;

const DATASET_URL = q => `https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/${q}_form345.zip`;

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
      b5: r.AFF10B5ONE === '1' ? 1 : 0,
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
    const a = agg.get(key) ?? { sh: 0, cost: 0, own: null, di: 'D', fnIds: new Set(), sec: r.SECURITY_TITLE || '' };
    a.sh += sh;
    a.cost += sh * (px ?? 0);
    const own = num(r.SHRS_OWND_FOLWNG_TRANS);
    if (own !== null) a.own = own; // остаток берём из последней строки агрегата
    if (r.DIRECT_INDIRECT_OWNERSHIP === 'I') a.di = 'I';
    for (const id of fnIds(r.TRANS_SHARES_FN, r.TRANS_PRICEPERSHARE_FN, r.SECURITY_TITLE_FN,
      r.TRANS_ACQUIRED_DISP_CD_FN, r.NATURE_OF_OWNERSHIP_FN, r.DIRECT_INDIRECT_OWNERSHIP_FN,
      r.SHRS_OWND_FOLWNG_TRANS_FN, r.TRANS_DATE_FN)) a.fnIds.add(id);
    a.acc = r.ACCESSION_NUMBER; a.code = r.TRANS_CODE; a.tdate = tdate;
    agg.set(key, a);
  }

  const trades = [];
  for (const a of agg.values()) {
    const sub = subs.get(a.acc);
    const noteMap = notes.get(a.acc);
    const rowTexts = noteMap ? [...a.fnIds].map(id => noteMap.get(id)).filter(Boolean) : [];
    const allTexts = noteMap ? [...noteMap.values()] : [];
    if (sub.remarks) allTexts.push(sub.remarks); // Remarks часто содержит дату плана 10b5-1
    const px = a.sh > 0 ? a.cost / a.sh : null;
    trades.push({
      acc: a.acc, form: sub.form, fdate: sub.fdate, tdate: a.tdate,
      cik: sub.cik, t: sub.t,
      owners: owners.get(a.acc) ?? [],
      code: a.code, sh: Math.round(a.sh),
      px: px !== null ? Math.round(px * 10000) / 10000 : null,
      val: Math.round(a.cost),
      own: a.own, di: a.di, b5: sub.b5,
      orig: sub.orig ?? null,
      sec: a.sec.slice(0, 60),
      fn: rowFootnoteFlags(rowTexts, allTexts),
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
  const { status, body } = await politeFetch(DATASET_URL(q));
  if (!body) return { status, data: null };
  return { status, data: normalizeQuarterZip(body) };
}

// ---- Живой контур: daily-index ----

export function parseFormIdx(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^(4|4\/A)\s{2,}/.exec(line);
    if (!m) continue;
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 5) continue; // Form Type | Company | CIK | Date Filed | File Name
    out.push({ form: parts[0], cik: Number(parts[2]), path: parts[4].trim() });
  }
  return out;
}

export async function fetchDayIndex(iso) {
  const [y, m, d] = iso.split('-');
  const qtr = 'QTR' + Math.ceil(Number(m) / 3);
  const url = `https://www.sec.gov/Archives/edgar/daily-index/${y}/${qtr}/form.${y}${m}${d}.idx`;
  const { status, body } = await politeFetch(url, { as: 'text' });
  if (!body) return { status, entries: null }; // 403/404 = выходной или ещё не опубликован
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
function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#\d+;/g, ' ').replace(/&amp;/g, '&');
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
  const orig = tagVal(xml, 'dateOfOriginalSubmission');
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
    const tdate = tagVal(tr, 'transactionDate');
    const amounts = tag(tr, 'transactionAmounts') ?? '';
    const sh = num(tagVal(amounts, 'transactionShares'));
    const px = num(tagVal(amounts, 'transactionPricePerShare'));
    // Дата из XML не проходит никакой валидации на стороне SEC — проверяем сами
    if (!isIsoDate(tdate) || !sh || sh <= 0) continue;
    const post = tag(tr, 'postTransactionAmounts') ?? '';
    const own = num(tagVal(post, 'sharesOwnedFollowingTransaction'));
    const nature = tag(tr, 'ownershipNature') ?? '';
    const di = tagVal(nature, 'directOrIndirectOwnership') === 'I' ? 'I' : 'D';
    const secTitle = tagVal(tr, 'securityTitle') ?? '';
    const key = `${code}|${tdate}|${secTitle}`;
    const a = agg.get(key) ?? { sh: 0, cost: 0, own: null, di: 'D', ids: new Set(), sec: secTitle };
    a.sh += sh; a.cost += sh * (px ?? 0);
    if (own !== null) a.own = own;
    if (di === 'I') a.di = 'I';
    // Сноски, привязанные к полям именно этой транзакции
    for (const idm of tr.matchAll(/<footnoteId\s+id="([^"]+)"/g)) a.ids.add(idm[1]);
    a.code = code; a.tdate = tdate;
    agg.set(key, a);
  }

  const trades = [];
  for (const a of agg.values()) {
    const rowTexts = [...a.ids].map(id => noteMap.get(id)).filter(Boolean);
    trades.push({
      acc, form: docType, fdate, tdate: a.tdate, cik, t, owners,
      code: a.code, sh: Math.round(a.sh),
      px: a.sh > 0 ? Math.round((a.cost / a.sh) * 10000) / 10000 : null,
      val: Math.round(a.cost), own: a.own, di: a.di, b5,
      orig: orig ?? null,
      sec: String(a.sec).slice(0, 60),
      fn: rowFootnoteFlags(rowTexts, allTexts),
    });
  }
  const amend = docType === '4/A' && orig
    ? [{ acc, cik, orig, owners: owners.map(o => o.cik), rows }]
    : [];
  return { trades, amend };
}

export async function fetchFiling(path) {
  const { body } = await politeFetch(`https://www.sec.gov/Archives/${path}`, { as: 'text' });
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
