// Самотесты на фиксированных фикстурах. Правило: никаких утверждений, зависящих
// от дня недели запуска; динамические ряды строятся «до сегодня» так, чтобы
// классификация не менялась от даты прогона.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secDate, parseTsv, addDaysIso, isoToday, readJson } from './lib/util.mjs';
import { zipCreate, zipExtract } from './lib/zip.mjs';
import { normalizeQuarterZip, relFlags, parseFormIdx, parseForm4Txt } from './lib/edgar.mjs';
import { mergeSeries } from './lib/prices.mjs';
import { scoreBuy, topRole, dOwnOf } from './lib/scoring.mjs';
import { loadAllTrades } from './lib/universe.mjs';
import { writeJsonGz, writeJson } from './lib/util.mjs';
import { writePriceCache } from './lib/prices.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// ---------- util ----------
ok('secDate конвертирует формат SEC', () => {
  assert.equal(secDate('27-DEC-2024'), '2024-12-27');
  assert.equal(secDate('01-JAN-2016'), '2016-01-01');
  assert.equal(secDate(''), null);
  assert.equal(secDate('garbage'), null);
});
ok('parseTsv разбирает строки с заголовком', () => {
  const rows = parseTsv('A\tB\r\n1\t2\n3\t4\n');
  assert.deepEqual(rows, [{ A: '1', B: '2' }, { A: '3', B: '4' }]);
});

// ---------- zip ----------
ok('zip: roundtrip create/extract', () => {
  const z = zipCreate({ 'a.tsv': 'X\tY\n1\t2\n', 'b.txt': 'привет'.repeat(100) });
  assert.equal(zipExtract(z, 'a.tsv').toString(), 'X\tY\n1\t2\n');
  assert.equal(zipExtract(z, 'b.txt').toString(), 'привет'.repeat(100));
  assert.equal(zipExtract(z, 'nope'), null);
});

// ---------- нормализация квартального датасета ----------
function makeQuarterZip() {
  const sub = [
    'ACCESSION_NUMBER\tFILING_DATE\tDOCUMENT_TYPE\tISSUERCIK\tISSUERNAME\tISSUERTRADINGSYMBOL\tAFF10B5ONE',
    'ACC-1\t05-FEB-2020\t4\t111\tAlpha Corp\tALFA\t0',
    'ACC-2\t10-FEB-2020\t4/A\t111\tAlpha Corp\tALFA\t1',
    'ACC-3\t11-FEB-2020\t3\t111\tAlpha Corp\tALFA\t0', // форма 3 — отбрасывается
  ].join('\n');
  const own = [
    'ACCESSION_NUMBER\tRPTOWNERCIK\tRPTOWNERNAME\tRPTOWNER_RELATIONSHIP\tRPTOWNER_TITLE',
    'ACC-1\t900\tIvanov Ivan\tOfficer, Director\tChief Executive Officer',
    'ACC-2\t901\tPetrov Petr\tDirector\t',
  ].join('\n');
  const trans = [
    'ACCESSION_NUMBER\tTRANS_DATE\tTRANS_CODE\tEQUITY_SWAP_INVOLVED\tTRANS_SHARES\tTRANS_PRICEPERSHARE\tSHRS_OWND_FOLWNG_TRANS\tDIRECT_INDIRECT_OWNERSHIP',
    'ACC-1\t03-FEB-2020\tP\t0\t1000\t10.00\t5000\tD',   // агрегация: две строки одной покупки
    'ACC-1\t03-FEB-2020\tP\t0\t1000\t12.00\t6000\tD',
    'ACC-1\t03-FEB-2020\tA\t0\t500\t0\t6500\tD',        // грант — отбрасывается
    'ACC-2\t07-FEB-2020\tS\t0\t200\t15.00\t4000\tD',
    'ACC-2\t08-FEB-2020\tP\t1\t100\t10.00\t4100\tD',    // своп — отбрасывается
  ].join('\n');
  return zipCreate({ 'SUBMISSION.tsv': sub, 'REPORTINGOWNER.tsv': own, 'NONDERIV_TRANS.tsv': trans });
}
ok('normalizeQuarterZip: агрегация, фильтры, 10b5-1', () => {
  const rows = normalizeQuarterZip(makeQuarterZip());
  assert.equal(rows.length, 2); // P-агрегат ACC-1 и S ACC-2
  const p = rows.find(r => r.code === 'P');
  assert.equal(p.sh, 2000);
  assert.equal(p.px, 11);      // vwap (1000*10 + 1000*12)/2000
  assert.equal(p.val, 22000);
  assert.equal(p.own, 6000);   // остаток из последней строки
  assert.equal(p.t, 'ALFA');
  assert.equal(p.b5, 0);
  assert.equal(p.owners[0].rel.includes('C'), true); // CEO по титулу
  const s = rows.find(r => r.code === 'S');
  assert.equal(s.form, '4/A');
  assert.equal(s.b5, 1);
});
ok('relFlags: роли и титулы', () => {
  assert.equal(relFlags('Officer', 'Chief Financial Officer').includes('F'), true);
  assert.equal(relFlags('TenPercentOwner', '').includes('T'), true);
  assert.equal(relFlags('', ''), 'X');
});

// ---------- daily index ----------
ok('parseFormIdx: только Form 4/4A', () => {
  const idx = [
    'Form Type   Company Name      CIK         Date Filed  File Name',
    '----',
    '4           Alpha Corp        111         20260728    edgar/data/111/0001-26-000001.txt',
    '4/A         Beta Inc          222         20260728    edgar/data/222/0001-26-000002.txt',
    '8-K         Gamma LLC         333         20260728    edgar/data/333/0001-26-000003.txt',
    '424B2       Delta             444         20260728    edgar/data/444/0001-26-000004.txt',
  ].join('\n');
  const entries = parseFormIdx(idx);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].cik, 111);
  assert.equal(entries[1].form, '4/A');
});

// ---------- Form 4 XML ----------
const FORM4_XML = `<SEC-DOCUMENT>...
<XML>
<ownershipDocument>
  <documentType>4</documentType>
  <issuer><issuerCik>0000111222</issuerCik><issuerName>Test Co</issuerName><issuerTradingSymbol>tst</issuerTradingSymbol></issuer>
  <aff10b5One>1</aff10b5One>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0000900901</rptOwnerCik><rptOwnerName>Smith &amp; Jones Trust</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>Chief Executive Officer</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-01</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>P</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>
      <transactionAmounts><transactionShares><value>1000</value></transactionShares><transactionPricePerShare><value>8.00</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>11000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-01</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>P</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>
      <transactionAmounts><transactionShares><value>3000</value></transactionShares><transactionPricePerShare><value>10.00</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>14000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-02</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>F</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>
      <transactionAmounts><transactionShares><value>50</value></transactionShares><transactionPricePerShare><value>9.00</value></transactionPricePerShare></transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>
</XML>
</SEC-DOCUMENT>`;
ok('parseForm4Txt: агрегация, роли, 10b5-1, экранирование', () => {
  const rows = parseForm4Txt(FORM4_XML, 'ACC-X', '2026-05-03');
  assert.equal(rows.length, 1); // две P слились, F отброшена
  const r = rows[0];
  assert.equal(r.cik, 111222);
  assert.equal(r.t, 'TST');
  assert.equal(r.sh, 4000);
  assert.equal(r.px, 9.5); // vwap
  assert.equal(r.own, 14000);
  assert.equal(r.di, 'I'); // хотя бы одна строка indirect
  assert.equal(r.b5, 1);
  assert.equal(r.owners[0].name, 'Smith & Jones Trust');
  assert.equal(r.owners[0].rel.includes('C'), true);
  assert.equal(r.fdate, '2026-05-03');
});

// ---------- цены ----------
ok('mergeSeries: свежее замещает хвост с точки перекрытия', () => {
  const cached = [['2020-01-01', 1, 1], ['2020-01-02', 2, 2], ['2020-01-03', 3, 3]];
  const fresh = [['2020-01-02', 20, 20], ['2020-01-04', 40, 40]];
  assert.deepEqual(mergeSeries(cached, fresh), [['2020-01-01', 1, 1], ['2020-01-02', 20, 20], ['2020-01-04', 40, 40]]);
});

// ---------- скоринг ----------
ok('scoreBuy: компоненты и границы', () => {
  const max = scoreBuy({ clusterSize: 3, role: 'C', totalVal: 2e6, dOwn: 0.6, dd: -0.4, allB5: false });
  assert.equal(max.total, 95); // 30+20+20+15+10
  const b5 = scoreBuy({ clusterSize: 1, role: 'D', totalVal: 1e4, dOwn: null, dd: null, allB5: true });
  assert.equal(b5.total, 0); // 0+8+2-15 -> клип в 0
  assert.equal(topRole(['DO', 'DF']), 'F');
  assert.equal(dOwnOf({ sh: 500, own: 1500 }), 0.5);
  assert.equal(dOwnOf({ sh: 500, own: 500 }), 9.99);
  assert.equal(dOwnOf({ sh: 500, own: null }), null);
});

// ---------- сквозной прогон compute на фикстурах ----------
const TMP = join(ROOT, '.selftest-tmp');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'state'), { recursive: true });

function bizDays(fromIso, toIso) {
  const out = [];
  for (let d = fromIso; d <= toIso; d = addDaysIso(d, 1)) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d);
  }
  return out;
}
const today = isoToday();

// SPY: плоский 100 с 2019 до сегодня -> excess == raw return
const spyDays = bizDays('2019-01-01', today);
writePriceCache(TMP, 'SPY', spyDays.map(d => [d, 100, 100]));

// ALFA: рост 0.1%/торговый день с 2019-06-03 по 2021-06-30, затем делистинг
const alfaDays = bizDays('2019-06-03', '2021-06-30');
writePriceCache(TMP, 'ALFA', alfaDays.map((d, i) => {
  const p = Math.round(100 * 1.001 ** i * 10000) / 10000;
  return [d, p, p];
}));
// LIVA: живой тикер, растёт до сегодня
const livaDays = bizDays('2024-01-02', today);
writePriceCache(TMP, 'LIVA', livaDays.map((d, i) => {
  const p = Math.round(50 * 1.0005 ** i * 10000) / 10000;
  return [d, p, p];
}));

writeJson(join(TMP, 'reference', 'tickers.json'), {
  111: { ticker: 'ALFA', exchange: 'NYSE', name: 'Alpha Corp' },
  222: { ticker: 'LIVA', exchange: 'Nasdaq', name: 'Liva Inc' },
  333: { ticker: 'OTCX', exchange: 'OTC', name: 'Otc Shell' },
});

const own1 = [{ cik: 900, name: 'Ivanov', rel: 'DC', title: 'CEO' }];
const own2 = [{ cik: 901, name: 'Petrov', rel: 'D', title: '' }];
writeJsonGz(join(TMP, 'trades', '2020.json.gz'), [
  // кластер из двух покупателей в пределах 30 дней
  { acc: 'A1', form: '4', fdate: '2020-02-05', tdate: '2020-02-03', cik: 111, t: 'ALFA', owners: own1, code: 'P', sh: 1000, px: 10, val: 10000, own: 5000, di: 'D', b5: 0 },
  { acc: 'A2', form: '4', fdate: '2020-02-20', tdate: '2020-02-18', cik: 111, t: 'ALFA', owners: own2, code: 'P', sh: 2000, px: 10.5, val: 21000, own: 2000, di: 'D', b5: 0 },
  // OTC — должен быть отсечён
  { acc: 'A3', form: '4', fdate: '2020-03-05', tdate: '2020-03-03', cik: 333, t: 'OTCX', owners: own2, code: 'P', sh: 100, px: 1, val: 100, own: 100, di: 'D', b5: 0 },
]);
const recentF = addDaysIso(today, -6);
const recentT = addDaysIso(today, -7);
writeJsonGz(join(TMP, 'trades', 'live.json.gz'), [
  { acc: 'L1', form: '4', fdate: recentF, tdate: recentT, cik: 222, t: 'LIVA', owners: own1, code: 'P', sh: 5000, px: 55, val: 275000, own: 15000, di: 'D', b5: 0 },
  // дубль-поправка к A2: должна заместить оригинал (те же содержательные поля)
  { acc: 'A2R', form: '4/A', fdate: '2020-02-25', tdate: '2020-02-18', cik: 111, t: 'ALFA', owners: own2, code: 'P', sh: 2000, px: 10.6, val: 21200, own: 2000, di: 'D', b5: 0 },
]);

ok('loadAllTrades: дедуп и приоритет 4/A', () => {
  const all = loadAllTrades(TMP);
  const a2 = all.filter(r => r.cik === 111 && r.tdate === '2020-02-18');
  assert.equal(a2.length, 1);
  assert.equal(a2[0].form, '4/A');
  assert.equal(a2[0].px, 10.6);
});

execFileSync(process.execPath, [join(ROOT, 'scripts', 'compute.mjs'), '--data', TMP, '--site', join(TMP, 'site')], { stdio: 'pipe' });

ok('compute: вселенная и бэктест', () => {
  const meta = readJson(join(TMP, 'site', 'data', 'meta.json'));
  assert.equal(meta.trades.total, 3);          // OTC отсечён (A1, A2R, L1)
  assert.equal(meta.backtest.rows, 3);
  const bt = readJson(join(TMP, 'site', 'data', 'backtest', '2020.json'));
  assert.equal(bt.length, 2);
  const b = bt.find(r => r.fdate === '2020-02-05');
  assert.equal(b.cl, 2);                       // кластер из 2 инсайдеров
  // Вход 2020-02-06; 63 торговых дня при 0.1%/день, SPY плоский
  const expected = Math.round((1.001 ** 63 - 1) * 10000) / 10000;
  assert.equal(b.s3, 'c');
  assert.ok(Math.abs(b.e3 - expected) < 0.002, `e3=${b.e3} ожидалось ~${expected}`);
  assert.equal(b.s24, 'd');                    // ряд оборван в 2021 — делистинг
  assert.ok(b.e24 !== undefined);
});
ok('compute: лента и кластеры', () => {
  const feed = readJson(join(TMP, 'site', 'data', 'feed.json'));
  assert.equal(feed.length, 1);                // только свежая LIVA
  assert.equal(feed[0].t, 'LIVA');
  assert.ok(feed[0].cur > 0);
  assert.equal(feed[0].role, 'C');
  const clusters = readJson(join(TMP, 'site', 'data', 'clusters.json'));
  assert.equal(clusters.length, 0);            // кластер ALFA древний, LIVA — одиночка
  const tick = readJson(join(TMP, 'site', 'data', 'tickers', 'ALFA.json'));
  assert.equal(tick.trades.length, 2);
  assert.ok(tick.weekly.length > 50);
});

rmSync(TMP, { recursive: true, force: true });
console.log(`Самотесты: ${passed} ok${process.exitCode ? ', ЕСТЬ ПАДЕНИЯ' : ''}`);
