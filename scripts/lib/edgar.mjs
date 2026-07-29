// EDGAR: квартальные структурированные датасеты Forms 3/4/5, daily-index, XML Form 4.
// Нормализованная строка сделки (см. README, раздел «Модель данных»):
// { acc, form, fdate, tdate, cik, t, owners:[{cik,name,rel,title}], code, sh, px, val, own, di, b5 }
import { politeFetch, parseTsv, secDate, num, SEC_UA } from './util.mjs';
import { zipExtract } from './zip.mjs';

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

// Роли: строка RPTOWNER_RELATIONSHIP вида "Officer, Director" -> флаги
export function relFlags(relStr, title) {
  const s = (relStr || '').toLowerCase();
  let rel = '';
  if (s.includes('director')) rel += 'D';
  if (s.includes('officer')) rel += 'O';
  if (s.includes('tenpercent') || s.includes('10%')) rel += 'T';
  if (s.includes('other')) rel += 'X';
  const t = (title || '').toLowerCase();
  // C-suite определяем по титулу — важнейший срез для скоринга
  if (/\bceo\b|chief exec|\bpres\b|president/.test(t)) rel += 'C';
  else if (/\bcfo\b|chief fin/.test(t)) rel += 'F';
  return rel || 'X';
}

// Квартальный zip -> нормализованные сделки (только коды P и S, форма 4/4A, без своп-сделок).
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
  // Агрегация по (accession, code, tdate): множественные строки одной сделки по разным ценам
  const agg = new Map();
  for (const r of parseTsv(zipExtract(zipBuf, 'NONDERIV_TRANS.tsv').toString('utf8'))) {
    const sub = subs.get(r.ACCESSION_NUMBER);
    if (!sub) continue;
    if (r.TRANS_CODE !== 'P' && r.TRANS_CODE !== 'S') continue;
    if (r.EQUITY_SWAP_INVOLVED === '1' || r.EQUITY_SWAP_INVOLVED === 'true') continue;
    const tdate = secDate(r.TRANS_DATE);
    const sh = num(r.TRANS_SHARES), px = num(r.TRANS_PRICEPERSHARE);
    if (!tdate || !sh || sh <= 0) continue;
    const key = `${r.ACCESSION_NUMBER}|${r.TRANS_CODE}|${tdate}`;
    const a = agg.get(key) ?? { sh: 0, cost: 0, own: null, di: 'D', n: 0 };
    a.sh += sh;
    a.cost += sh * (px ?? 0);
    a.n++;
    const own = num(r.SHRS_OWND_FOLWNG_TRANS);
    // Остаток после сделки: берём из последней строки агрегата (максимально поздней)
    if (own !== null) a.own = own;
    if (r.DIRECT_INDIRECT_OWNERSHIP === 'I') a.di = 'I';
    a.acc = r.ACCESSION_NUMBER; a.code = r.TRANS_CODE; a.tdate = tdate;
    agg.set(key, a);
  }
  const rows = [];
  for (const a of agg.values()) {
    const sub = subs.get(a.acc);
    const px = a.sh > 0 ? a.cost / a.sh : null;
    rows.push({
      acc: a.acc, form: sub.form, fdate: sub.fdate, tdate: a.tdate,
      cik: sub.cik, t: sub.t,
      owners: owners.get(a.acc) ?? [],
      code: a.code, sh: Math.round(a.sh),
      px: px !== null ? Math.round(px * 10000) / 10000 : null,
      val: Math.round(a.cost),
      own: a.own, di: a.di, b5: sub.b5,
    });
  }
  return rows;
}

export async function fetchQuarter(q) {
  const { status, body } = await politeFetch(DATASET_URL(q));
  if (!body) return { status, rows: null };
  return { status, rows: normalizeQuarterZip(body) };
}

// ---- Живой контур: daily-index ----

// form.YYYYMMDD.idx -> [{cik, path}] только Form 4 / 4/A
export function parseFormIdx(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^(4|4\/A)\s{2,}/.exec(line);
    if (!m) continue;
    const parts = line.trim().split(/\s{2,}/);
    // Формат: Form Type | Company Name | CIK | Date Filed | File Name
    if (parts.length < 5) continue;
    out.push({ form: parts[0], cik: Number(parts[2]), path: parts[4].trim() });
  }
  return out;
}

export async function fetchDayIndex(iso) {
  const [y, m, d] = iso.split('-');
  const qtr = 'QTR' + Math.ceil(Number(m) / 3);
  const url = `https://www.sec.gov/Archives/edgar/daily-index/${y}/${qtr}/form.${y}${m}${d}.idx`;
  const { status, body } = await politeFetch(url, { as: 'text' });
  if (!body) return { status, entries: null }; // 403/404 = файла нет (выходной/ещё не опубликован)
  return { status, entries: parseFormIdx(body) };
}

// ---- Парсер XML Form 4 (из полного .txt сабмишена) ----

function tag(xml, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1].trim() : null;
}
function tagVal(xml, name) {
  // Значения в Form 4 обёрнуты в <value>
  const inner = tag(xml, name);
  if (inner === null) return null;
  const v = tag(inner, 'value');
  return v !== null ? v : inner;
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
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// Полный .txt сабмишен -> нормализованные строки (та же форма, что из датасета)
export function parseForm4Txt(txt, acc, fdate) {
  const xm = /<XML>([\s\S]*?)<\/XML>/.exec(txt);
  if (!xm) return [];
  const xml = xm[1];
  if (!/<ownershipDocument/.test(xml)) return [];
  const docType = tag(xml, 'documentType');
  if (docType !== '4' && docType !== '4/A') return [];
  const issuer = tag(xml, 'issuer') ?? '';
  const cik = Number(tag(issuer, 'issuerCik'));
  const t = (tag(issuer, 'issuerTradingSymbol') || '').trim().toUpperCase();
  const b5 = boolVal(tag(xml, 'aff10b5One')) ? 1 : 0;
  const owners = allBlocks(xml, 'reportingOwner').map(o => {
    const rid = tag(o, 'reportingOwnerId') ?? '';
    const rr = tag(o, 'reportingOwnerRelationship') ?? '';
    let rel = '';
    if (boolVal(tagVal(rr, 'isDirector'))) rel += 'D';
    if (boolVal(tagVal(rr, 'isOfficer'))) rel += 'O';
    if (boolVal(tagVal(rr, 'isTenPercentOwner'))) rel += 'T';
    if (boolVal(tagVal(rr, 'isOther'))) rel += 'X';
    const title = unescapeXml(tag(rr, 'officerTitle') || '');
    const tl = title.toLowerCase();
    if (/\bceo\b|chief exec|president/.test(tl)) rel += 'C';
    else if (/\bcfo\b|chief fin/.test(tl)) rel += 'F';
    return {
      cik: Number(tag(rid, 'rptOwnerCik')),
      name: unescapeXml(tag(rid, 'rptOwnerName') || ''),
      rel: rel || 'X',
      title,
    };
  });
  const agg = new Map();
  const table = tag(xml, 'nonDerivativeTable') ?? '';
  for (const tr of allBlocks(table, 'nonDerivativeTransaction')) {
    const coding = tag(tr, 'transactionCoding') ?? '';
    const code = tag(coding, 'transactionCode');
    if (code !== 'P' && code !== 'S') continue;
    if (boolVal(tag(coding, 'equitySwapInvolved'))) continue;
    const tdate = tagVal(tr, 'transactionDate');
    const amounts = tag(tr, 'transactionAmounts') ?? '';
    const sh = num(tagVal(amounts, 'transactionShares'));
    const px = num(tagVal(amounts, 'transactionPricePerShare'));
    if (!tdate || !sh || sh <= 0) continue;
    const post = tag(tr, 'postTransactionAmounts') ?? '';
    const own = num(tagVal(post, 'sharesOwnedFollowingTransaction'));
    const nature = tag(tr, 'ownershipNature') ?? '';
    const di = tagVal(nature, 'directOrIndirectOwnership') === 'I' ? 'I' : 'D';
    const key = `${code}|${tdate}`;
    const a = agg.get(key) ?? { sh: 0, cost: 0, own: null, di: 'D' };
    a.sh += sh; a.cost += sh * (px ?? 0);
    if (own !== null) a.own = own;
    if (di === 'I') a.di = 'I';
    a.code = code; a.tdate = tdate;
    agg.set(key, a);
  }
  const rows = [];
  for (const a of agg.values()) {
    rows.push({
      acc, form: docType, fdate, tdate: a.tdate, cik, t, owners,
      code: a.code, sh: Math.round(a.sh),
      px: a.sh > 0 ? Math.round((a.cost / a.sh) * 10000) / 10000 : null,
      val: Math.round(a.cost), own: a.own, di: a.di, b5,
    });
  }
  return rows;
}

// path вида edgar/data/1998387/0001193125-26-321223.txt
export async function fetchFiling(path) {
  const { body } = await politeFetch(`https://www.sec.gov/Archives/${path}`, { as: 'text' });
  return body;
}

// Текущий справочник тикер/биржа SEC
export async function fetchTickerRef() {
  const { body } = await politeFetch('https://www.sec.gov/files/company_tickers_exchange.json', { as: 'text' });
  if (!body) throw new Error('company_tickers_exchange.json недоступен');
  const j = JSON.parse(body);
  const iCik = j.fields.indexOf('cik'), iT = j.fields.indexOf('ticker'), iEx = j.fields.indexOf('exchange'), iName = j.fields.indexOf('name');
  const byCik = new Map();
  for (const row of j.data) {
    const cik = row[iCik];
    // Первый листинг CIK — основной класс акций (SEC сортирует по капитализации/первичности)
    if (!byCik.has(cik)) byCik.set(cik, { ticker: row[iT], exchange: row[iEx], name: row[iName] });
  }
  return byCik;
}
