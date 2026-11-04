// Самотесты на фиксированных фикстурах. Правило: никаких утверждений, зависящих от дня
// недели запуска; динамические ряды строятся «до сегодня» так, чтобы классификация не менялась.
import { strict as assert } from 'node:assert';
import { execFileSync, execFile } from 'node:child_process';
import { rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { secDate, parseTsv, addDaysIso, isoToday, readJson, writeJson, writeJsonGz, isIsoDate } from './lib/util.mjs';
import { zipCreate, zipExtract } from './lib/zip.mjs';
import { normalizeQuarterZip, relFlags, parseFormIdx, parseForm4Txt, acceptedAt, acceptedAtSec, SHARD_VERSION } from './lib/edgar.mjs';
import {
  mergeSeries, writePriceCache, nominalFactor, sanitizeSeries, metaAcceptable, normalizeTiingo,
  trimFrozenTail, repairUnadjustedSplits, clipToInstrument, cutAtDataBreak, listedThrough, fetchYahooDaily, turnover20,
  parseYahooChart, readPriceCache,
} from './lib/prices.mjs';
import { barsFrom, fetchBars, applyBars } from './lib/bars.mjs';
import { isSecClosed } from './lib/calendar.mjs';
import { main as morningMain } from './vps/morning-build.mjs';
import { buildDay, buildDayFull, tradeResult, summarize, breadth, bestRole, tagsOf, sessionOf, scoreOf, costOf, compareMain } from './lib/morning.mjs';
import { pickOpens, mergeOpens, nextTradingDay, opensOf, readOpens, writeOpens } from './lib/opens.mjs';
import { EVENING, nyWall, nyToMs, inEveningWindow, parseAtom, filingPath, buildEvent, fromWorker, validBook, entryPx, benchPx, paperTrade, summarizePaper, planQuotes, parseJournal, pickQuote } from './lib/evening.mjs';
import { buildPaper } from './lib/paper.mjs';
import { parseRegistry, exchangeAt, mergeRanges, sameInstrumentAsLatest } from './lib/symbols.mjs';
import { Panel, monthlyFromDaily, portfolioSeries, factorAlpha, factorSeries, vsBenchmark, neweyWestT, universeSeries, pairedDiff, turnover } from './lib/portfolio.mjs';
import { applyGates, isPlanned, isNonCommon, isImplausible } from './lib/gates.mjs';
import { isEntityName, isPersonOwner, buildOwnerGroups, isFundOnly, topRole, dOwnOf } from './lib/entity.mjs';
import { buildOwnerHistory, isRoutineCMP, isRegularSeries, inflection, typicalBuyValue } from './lib/routine.mjs';
import { classifyFootnotes, rowFootnoteFlags } from './lib/footnotes.mjs';
import { loadAllTrades, issuerCategory } from './lib/universe.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.MORNING_URL = 'http://127.0.0.1:9';        // отметки писем (notify.mjs) в тестах не уходят в боевой воркер
delete process.env.PAPER_TOKEN;
let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// ---------- util / zip ----------
ok('secDate конвертирует формат SEC', () => {
  assert.equal(secDate('27-DEC-2024'), '2024-12-27');
  assert.equal(secDate(''), null);
  assert.equal(secDate('garbage'), null);
});
ok('isIsoDate отсеивает несуществующие даты из форм', () => {
  // Регрессия: битая дата в одном филинге роняла всю сборку на RangeError
  assert.equal(isIsoDate('2026-06-30'), true);
  assert.equal(isIsoDate('2026-06-31'), false);   // такого дня не существует
  assert.equal(isIsoDate('2026-13-01'), false);
  assert.equal(isIsoDate('0000-00-00'), false);
  assert.equal(isIsoDate('2026-6-1'), false);
  assert.equal(isIsoDate(''), false);
  assert.equal(isIsoDate(null), false);
});
ok('parseTsv разбирает строки с заголовком', () => {
  assert.deepEqual(parseTsv('A\tB\r\n1\t2\n3\t4\n'), [{ A: '1', B: '2' }, { A: '3', B: '4' }]);
});
ok('zip: roundtrip', () => {
  const z = zipCreate({ 'a.tsv': 'X\tY\n1\t2\n', 'b.txt': 'привет'.repeat(100) });
  assert.equal(zipExtract(z, 'a.tsv').toString(), 'X\tY\n1\t2\n');
  assert.equal(zipExtract(z, 'nope'), null);
});

// ---------- сноски ----------
ok('сноски: классификация природы сделки', () => {
  assert.equal(classifyFootnotes(['Shares acquired in the rights offering']).offering, 1);
  assert.equal(classifyFootnotes(['Purchased pursuant to the Securities Purchase Agreement']).offering, 1);
  assert.equal(classifyFootnotes(['Acquired under the Company\'s dividend reinvestment plan']).drip, 1);
  assert.equal(classifyFootnotes(['Sold to satisfy a margin call']).forced, 1);
  assert.equal(classifyFootnotes(['Price is a weighted average; prices ranging from $36.00 to $36.20']).wavg, 1);
  assert.equal(classifyFootnotes(['Shares held by the Smith Family Trust']).trust, 1);
  // Обычная покупка не должна ловиться ни одним правилом
  assert.deepEqual(classifyFootnotes(['Open market purchase of common stock.']), {});
});
ok('сноски: обычная открыторыночная покупка НЕ считается размещением', () => {
  // Регрессия: «at the market price» — стандартное описание открыторыночной сделки,
  // а «is not an underwriter» — отрицание. Раньше и то и другое давало offering.
  for (const txt of [
    'Shares purchased in the open market at the market price.',
    'The reporting person purchased the shares at the market price on the date indicated.',
    'The Reporting Person is not an underwriter of the offering.',
  ]) assert.equal(classifyFootnotes([txt]).offering, undefined, txt);
  // А настоящие маркеры размещения ловиться должны
  for (const txt of [
    'Shares sold under the Company at-the-market offering program.',
    'Purchased in an underwritten public offering.',
    'Acquired pursuant to a PIPE transaction.',
  ]) assert.equal(classifyFootnotes([txt]).offering, 1, txt);
});
ok('сноски: формоуровневый 10b5-1 не приписывается строке со своими сносками', () => {
  // Строка без собственных сносок наследует признак плана с уровня формы
  assert.equal(rowFootnoteFlags([], ['Sale pursuant to a Rule 10b5-1 trading plan']).b5, 1);
  // А строка со своей сноской — нет: в смешанной подаче план мог относиться к продаже
  const mixed = rowFootnoteFlags(['Open market purchase.'], ['Sale pursuant to a Rule 10b5-1 trading plan']);
  assert.equal(mixed.b5, undefined);
  assert.equal(mixed.offering, undefined);
});

// ---------- нормализация квартального датасета ----------
function makeQuarterZip() {
  const sub = [
    'ACCESSION_NUMBER\tFILING_DATE\tDOCUMENT_TYPE\tISSUERCIK\tISSUERNAME\tISSUERTRADINGSYMBOL\tAFF10B5ONE\tDATE_OF_ORIG_SUB\tREMARKS',
    'ACC-1\t05-FEB-2020\t4\t111\tAlpha Corp\tALFA\t0\t\t',
    'ACC-2\t10-FEB-2020\t4/A\t111\tAlpha Corp\tALFA\t1\t05-FEB-2020\t',
    'ACC-3\t11-FEB-2020\t3\t111\tAlpha Corp\tALFA\t0\t\t',      // форма 3 — отбрасывается
    'ACC-4\t12-FEB-2020\t4\t111\tAlpha Corp\tALFA\t0\t\t',
  ].join('\n');
  const own = [
    'ACCESSION_NUMBER\tRPTOWNERCIK\tRPTOWNERNAME\tRPTOWNER_RELATIONSHIP\tRPTOWNER_TITLE',
    'ACC-1\t900\tIvanov Ivan\tOfficer, Director\tChief Executive Officer',
    'ACC-2\t901\tPetrov Petr\tDirector\t',
    'ACC-4\t902\tSidorov Sidor\tOfficer\tChief Financial Officer',
  ].join('\n');
  const trans = [
    'ACCESSION_NUMBER\tTRANS_DATE\tTRANS_CODE\tEQUITY_SWAP_INVOLVED\tTRANS_SHARES\tTRANS_PRICEPERSHARE\tSHRS_OWND_FOLWNG_TRANS\tDIRECT_INDIRECT_OWNERSHIP\tTRANS_PRICEPERSHARE_FN\tTRANS_SHARES_FN',
    'ACC-1\t03-FEB-2020\tP\t0\t1000\t10.00\t5000\tD\t\t',       // агрегация двух строк одной покупки
    'ACC-1\t03-FEB-2020\tP\t0\t1000\t12.00\t6000\tD\t\t',
    'ACC-1\t03-FEB-2020\tA\t0\t500\t0\t6500\tD\t\t',            // грант — отбрасывается
    'ACC-2\t07-FEB-2020\tS\t0\t200\t15.00\t4000\tD\t\t',
    'ACC-2\t08-FEB-2020\tP\t1\t100\t10.00\t4100\tD\t\t',        // своп — отбрасывается
    'ACC-4\t11-FEB-2020\tP\t0\t500\t9.00\t1500\tD\tF1\t',        // сноска о размещении
  ].join('\n');
  const notes = [
    'ACCESSION_NUMBER\tFOOTNOTE_ID\tFOOTNOTE_TXT',
    'ACC-4\tF1\tShares purchased in a private placement pursuant to a Securities Purchase Agreement.',
  ].join('\n');
  return zipCreate({
    'SUBMISSION.tsv': sub, 'REPORTINGOWNER.tsv': own,
    'NONDERIV_TRANS.tsv': trans, 'FOOTNOTES.tsv': notes,
  });
}
ok('normalizeQuarterZip: агрегация, фильтры, сноски, поправки', () => {
  const { v, trades, amend } = normalizeQuarterZip(makeQuarterZip());
  assert.equal(v, SHARD_VERSION);
  assert.equal(trades.length, 3);            // P(ACC-1), S(ACC-2), P(ACC-4)
  const p = trades.find(r => r.acc === 'ACC-1');
  assert.equal(p.sh, 2000);
  assert.equal(p.px, 11);                    // vwap (1000*10 + 1000*12)/2000
  assert.equal(p.own, 6000);                 // итоговый остаток покупки — наибольший из строк
  assert.equal(p.di, 'D');
  assert.equal(p.owners[0].rel.includes('C'), true);  // CEO по титулу
  const pipe = trades.find(r => r.acc === 'ACC-4');
  assert.equal(pipe.fn.offering, 1);         // сноска привязана к строке через TRANS_PRICEPERSHARE_FN
  assert.equal(pipe.owners[0].rel.includes('F'), true); // CFO
  assert.equal(trades.find(r => r.acc === 'ACC-2').b5, 1);
  assert.equal(amend.length, 1);
  assert.equal(amend[0].orig, '2020-02-05');
  assert.equal(amend[0].rows, 2);            // 4/A содержит строки -> не аннулирование
});
ok('relFlags: роли и титулы', () => {
  assert.equal(relFlags('Officer', 'Chief Financial Officer').includes('F'), true);
  assert.equal(relFlags('TenPercentOwner', '').includes('T'), true);
  assert.equal(relFlags('', ''), 'X');
});

// ---------- daily index + XML ----------
ok('parseFormIdx: только Form 4/4A', () => {
  const idx = [
    'Form Type   Company Name      CIK         Date Filed  File Name',
    '4           Alpha Corp        111         20260728    edgar/data/111/0001-26-000001.txt',
    '4/A         Beta Inc          222         20260728    edgar/data/222/0001-26-000002.txt',
    '8-K         Gamma LLC         333         20260728    edgar/data/333/0001-26-000003.txt',
  ].join('\n');
  const e = parseFormIdx(idx);
  assert.equal(e.length, 2);
  assert.equal(e[1].form, '4/A');
});

const FORM4_XML = `<SEC-DOCUMENT>
<XML>
<ownershipDocument>
  <documentType>4</documentType>
  <issuer><issuerCik>0000111222</issuerCik><issuerTradingSymbol>tst</issuerTradingSymbol></issuer>
  <aff10b5One>0</aff10b5One>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0000900901</rptOwnerCik><rptOwnerName>Smith &amp; Jones Trust</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>Chief Executive Officer</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-01</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>
      <transactionAmounts><transactionShares><value>1000</value></transactionShares><transactionPricePerShare><value>8.00</value><footnoteId id="F1"/></transactionPricePerShare></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>11000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-01</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>
      <transactionAmounts><transactionShares><value>3000</value></transactionShares><transactionPricePerShare><value>10.00</value></transactionPricePerShare></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>14000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-02</value></transactionDate>
      <transactionCoding><transactionCode>F</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>
      <transactionAmounts><transactionShares><value>50</value></transactionShares></transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
  <footnotes>
    <footnote id="F1">Weighted average price; shares purchased in multiple transactions ranging from $7.90 to $8.10.</footnote>
    <footnote id="F2">Unrelated note about an option grant.</footnote>
  </footnotes>
  <remarks>Exhibit 24 power of attorney</remarks>
</ownershipDocument>
</XML>
</SEC-DOCUMENT>`;
ok('parseForm4Txt: агрегация, роли, построчные сноски', () => {
  const { trades } = parseForm4Txt(FORM4_XML, 'ACC-X', '2026-05-03');
  assert.equal(trades.length, 1);            // две P слились, F отброшена
  const r = trades[0];
  assert.equal(r.cik, 111222);
  assert.equal(r.t, 'TST');
  assert.equal(r.sh, 4000);
  assert.equal(r.px, 9.5);
  // Строка смешивает прямое и косвенное владение: раньше весь агрегат становился 'I',
  // а остаток брался из случайной строки и давал правдоподобный, но неверный прирост
  assert.equal(r.di, 'M');
  assert.equal(r.own, null, 'у смешанной строки общего остатка не существует');
  assert.equal(dOwnOf(r) === null || dOwnOf(r) > 0, true);
  assert.equal(r.owners[0].name, 'Smith & Jones Trust');
  assert.equal(r.owners[0].rel.includes('C'), true);
  assert.equal(r.fn.wavg, 1);                // F1 привязана к цене
  assert.equal(r.fn.b5, undefined);          // плана нет ни в форме, ни в сносках
});
ok('parseForm4Txt отбрасывает строку с невалидной датой сделки', () => {
  // Регрессия: дата «2026-06-31» из формы доходила до арифметики и роняла всю сборку
  const bad = FORM4_XML.replace('<transactionDate><value>2026-05-01</value></transactionDate>\n      <transactionCoding><transactionCode>P</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>\n      <transactionAmounts><transactionShares><value>1000</value>',
    '<transactionDate><value>2026-06-31</value></transactionDate>\n      <transactionCoding><transactionCode>P</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>\n      <transactionAmounts><transactionShares><value>1000</value>');
  const { trades } = parseForm4Txt(bad, 'ACC-BAD', '2026-07-01');
  assert.equal(trades.length, 1);            // битая строка отброшена, валидная осталась
  assert.equal(trades[0].sh, 3000);
});

ok('приём формы: время из шапки .txt — необязательное поле строки, по Нью-Йорку', () => {
  assert.equal(acceptedAt('<SEC-HEADER>\n<ACCEPTANCE-DATETIME>20261103162053\nACCESSION NUMBER: 1'), '2026-11-03T16:20');
  assert.equal(acceptedAt('<ACCEPTANCE-DATETIME>20261103082635'), '2026-11-03T08:26');
  assert.equal(acceptedAt('<ACCEPTANCE-DATETIME>20261331082635'), null, 'несуществующая дата');
  assert.equal(acceptedAt('<ACCEPTANCE-DATETIME>20261103252635'), null, 'несуществующее время');
  assert.equal(acceptedAt('нет шапки'), null);
  assert.equal(acceptedAt(undefined), null);
  const withHeader = FORM4_XML.replace('<SEC-DOCUMENT>\n', '<SEC-DOCUMENT>0001-26-000001.txt : 20260503\n<SEC-HEADER>0001-26-000001.hdr.sgml : 20260503\n<ACCEPTANCE-DATETIME>20260503172115\nACCESSION NUMBER:\t0001-26-000001\n</SEC-HEADER>\n');
  const r = parseForm4Txt(withHeader, 'ACC-T', '2026-05-03').trades[0];
  assert.equal(r.at, '2026-05-03T17:21');
  // без шапки поля нет вовсе (а не null): у строк квартальных датасетов его тоже не бывает
  const bare = parseForm4Txt(FORM4_XML, 'ACC-X', '2026-05-03').trades[0];
  assert.equal('at' in bare, false);
  // Поле не запускает перечитывание шардов: детектор смотрит на ownD, а не на at, и версия схемы прежняя
  const stale = [{ acc: 'A', fdate: '2026-05-10', at: '2026-05-10T09:00' }, { acc: 'B', fdate: '2026-05-10', ownD: null }, r, bare];
  assert.deepEqual(stale.filter(x => !('ownD' in x)).map(x => x.acc), ['A'], 'старая строка без ownD остаётся устаревшей, а новая без at — нет');
  assert.equal(SHARD_VERSION, 3);
});

ok('живой контур: устаревшие строки видны по содержимому, а не по метке состояния', () => {
  // Регрессия: бэкфил затирал состояние живого контура, тот считал себя перечитанным
  // и молча пропускал строки старой схемы. Признак нового разбора — наличие поля ownD
  // (оно пишется всегда, пусть и со значением null), поэтому проверка не зависит от меток.
  const shard = [
    { acc: 'A', fdate: '2026-05-10', di: 'D', own: 10 },                 // старая схема
    { acc: 'B', fdate: '2026-04-02', di: 'D', own: 10, ownD: 10, shD: 1 }, // новая
    { acc: 'C', fdate: '2026-06-01', di: 'M', own: null, ownD: null, shD: null },
  ];
  const staleDates = shard.filter(r => !('ownD' in r)).map(r => r.fdate);
  assert.equal(staleDates.length, 1);
  assert.equal(staleDates.reduce((a, b) => b < a ? b : a), '2026-05-10');
  // строка со значением null поля не теряет: JSON её сохраняет
  assert.equal('ownD' in shard[2], true);
  assert.equal(JSON.parse(JSON.stringify(shard[2])).ownD, null);
  // Часть строк перечитать нельзя: филинга уже нет в дневном индексе. После полного
  // прохода остаток фиксируется полом, иначе хвост перечитывался бы вечно по кругу.
  const need = (stale, floor) => stale > (floor ?? 0);
  assert.equal(need(14875, 0), true, 'первый проход нужен');
  assert.equal(need(34, 0), true, 'остаток ещё не зафиксирован — проход нужен');
  assert.equal(need(34, 34), false, 'после прохода остаток стал полом — повтора нет');
  assert.equal(need(120, 34), true, 'новых старых строк больше пола — снова перечитываем');
});

ok('владение: остаток относится к форме владения, а не к лицу', () => {
  // однородная строка: остаток осмыслен, прирост считается
  assert.equal(dOwnOf({ di: 'D', sh: 1000, own: 11000 }), 0.1);
  // позиция открыта с нуля
  assert.equal(dOwnOf({ di: 'D', sh: 5000, own: 5000 }), 9.99);
  // смешанная строка: общий остаток не определён, берём прямую часть
  assert.equal(dOwnOf({ di: 'M', sh: 1500, own: null, shD: 1000, ownD: 11000 }), 0.1);
  // смешанная строка без прямой части — прирост неизвестен, а не «правдоподобен»
  assert.equal(dOwnOf({ di: 'M', sh: 1500, own: null, shD: null, ownD: null }), null);
  // купить больше, чем осталось после покупки, нельзя: остаток от другого пакета
  // (у одного лица бывает несколько косвенных — траст, супруга, LLC)
  assert.equal(dOwnOf({ di: 'I', sh: 5750000, own: 3000000 }), null);
});

// ---------- цены ----------
ok('mergeSeries: свежее замещает хвост с точки перекрытия', () => {
  const cached = [['2020-01-01', 1, 1, 10], ['2020-01-02', 2, 2, 10], ['2020-01-03', 3, 3, 10]];
  const fresh = [['2020-01-02', 20, 20, 99], ['2020-01-04', 40, 40, 99]];
  assert.deepEqual(mergeSeries(cached, fresh), [['2020-01-01', 1, 1, 10], ['2020-01-02', 20, 20, 99], ['2020-01-04', 40, 40, 99]]);
});

ok('sanitizeSeries: изолированный выброс снимается, настоящий скачок остаётся', () => {
  const base = Array.from({ length: 12 }, (_, i) => [`2020-01-${String(i + 1).padStart(2, '0')}`, 10, 10, 1000]);
  // одиночный «залётный» бар (склейка чужого инструмента, как было у ITC)
  const spiked = base.map((r, i) => i === 5 ? [r[0], 8000, 8000, 5] : r);
  const cleaned = sanitizeSeries(spiked);
  assert.equal(cleaned.dropped, 1);
  assert.equal(cleaned.series.length, 11);
  assert.ok(!cleaned.series.some(r => r[2] === 8000));
  // настоящий скачок держится следующими барами и переживает фильтр
  const real = base.map((r, i) => i >= 5 ? [r[0], 60, 60, 1000] : r);
  assert.equal(sanitizeSeries(real).dropped, 0);
});

ok('sanitizeSeries: блок чужих баров снимается целиком (регрессия ITC)', () => {
  // Прежнее окно ±7 не перекрывало блок из 16 чужих баров, и ряд оставался грязным
  const base = Array.from({ length: 120 }, (_, i) => [addDaysIso('2021-01-01', i), 40, 40, 1e6]);
  const dirty = base.map((r, i) => (i >= 50 && i < 66) ? [r[0], 15000, 15000, 500] : r);
  const c = sanitizeSeries(dirty);
  assert.equal(c.dropped, 16);
  assert.ok(!c.series.some(r => r[2] === 15000));
});

ok('sanitizeSeries: объём защищает настоящий всплеск, но не крайнее отклонение', () => {
  const mk = (n, px, vol) => Array.from({ length: n }, (_, i) => [addDaysIso('2021-01-01', i), px, px, vol]);
  const base = mk(60, 10, 1e6);
  // Короткое сжатие: цена ×7 на один день, объём ×20 — настоящий бар, трогать нельзя
  const squeeze = base.map((r, i) => i === 30 ? [r[0], 70, 70, 2e7] : r);
  assert.equal(sanitizeSeries(squeeze).dropped, 0);
  // Тот же всплеск без объёма — выброс
  const quiet = base.map((r, i) => i === 30 ? [r[0], 70, 70, 5e5] : r);
  assert.equal(sanitizeSeries(quiet).dropped, 1);
  // Отклонение в 280 раз снимается независимо от объёма (чужой бар ITC пришёл с большим)
  const alien = base.map((r, i) => i === 30 ? [r[0], 2800, 2800, 2e6] : r);
  assert.equal(sanitizeSeries(alien).dropped, 1);
});

ok('repairUnadjustedSplits: обратный сплит без коррекции пересчитывается', () => {
  // TTOO: 1:50 на 2022-10-13, ряд пришёл в номинале — скачок 5.60 -> 255
  const pre = Array.from({ length: 30 }, (_, i) => [addDaysIso('2022-09-01', i), 5.6, 5.6, 500000]);
  const post = Array.from({ length: 30 }, (_, i) => [addDaysIso('2022-10-13', i), 255, 255, 10000]);
  const r = repairUnadjustedSplits(pre.concat(post), [['2022-10-13', 0.02]]);
  assert.equal(r.fixed, 1);
  assert.equal(r.series[0][2], 280);          // 5.6 / 0.02
  assert.equal(r.series[0][3], 10000);        // объём в новых акциях: 500000 * 0.02
  assert.equal(r.series[30][2], 255, 'бары после сплита не трогаем');
  // уже скорректированный ряд не трогается вовсе
  const good = pre.map(x => [x[0], 280, 280, 10000]).concat(post);
  assert.equal(repairUnadjustedSplits(good, [['2022-10-13', 0.02]]).fixed, 0);
  // Скорректированный ряд с МЕЛКИМ коэффициентом тоже не трогаем: без требования ступени
  // сплит 1:2 «чинился» на ровном месте и делил всю историю пополам
  const flat = Array.from({ length: 60 }, (_, i) => [addDaysIso('2022-09-01', i), 50, 50, 1e6]);
  assert.equal(repairUnadjustedSplits(flat, [['2022-10-13', 0.5]]).fixed, 0);
  // Дата события у источника съезжает на день: скачок ищем в окне ±3 бара (случай FFAI)
  const a = Array.from({ length: 40 }, (_, i) => [addDaysIso('2026-06-01', i), 0.112, 0.112, 6e7]);
  const b = Array.from({ length: 20 }, (_, i) => [addDaysIso('2026-07-13', i), 10.8, 10.8, 4e5]);
  const r2 = repairUnadjustedSplits(a.concat(b), [['2026-07-15', 0.0067]]);
  assert.equal(r2.fixed, 1);
  assert.ok(Math.abs(r2.series[0][2] - 10.8) < 0.2, 'история приведена к посплитовому номиналу');
});

ok('clipToInstrument: чужой инструмент режется, переименование — нет', () => {
  const mk = (from, n, px) => Array.from({ length: n }, (_, i) => [addDaysIso(from, i), px, px, 1e6]);
  // CHRD: старый капитал погашен, новая бумага с 2020-11-20 — на границе скачок ×250
  const glued = mk('2020-09-01', 60, 0.12).concat(mk('2020-11-20', 60, 31));
  const cut = clipToInstrument(glued, [['2020-11-20', '2026-08-04']]);
  assert.equal(cut.head, 60);
  assert.equal(cut.series[0][1], 31);
  // TICC -> OXSQ: тикер в реестре начинается с переименования, но ряд непрерывен — не режем
  const renamed = mk('2018-01-01', 60, 7).concat(mk('2018-03-02', 60, 7.1));
  assert.equal(clipToInstrument(renamed, [['2018-03-02', '2026-08-04']]).head, 0);
  // ITC: листинг кончился в 2016-м, а бары есть до 2022-го — хвост убираем
  const tail = mk('2016-01-04', 200, 40).concat(mk('2021-06-22', 60, 15000));
  const t2 = clipToInstrument(tail, [['2005-07-26', '2016-10-24']]);
  assert.ok(t2.tail > 0);
  assert.ok(t2.series.every(r => r[0] <= '2016-10-24'));
});

ok('cutAtDataBreak: сдвиг уровня режется, настоящая новость остаётся', () => {
  const mk = (from, n, px, vol) => Array.from({ length: n }, (_, i) => [addDaysIso(from, i), px, px, vol]);
  // COSM: 0.33 -> 23.01 без записи о сплите, объём НЕ вырос -> смена номинала
  const split = mk('2022-11-01', 45, 0.33, 5e7).concat(mk('2022-12-16', 45, 23, 5e7));
  const c = cutAtDataBreak(split, null);
  assert.equal(c.cut, 45);
  assert.equal(c.series[0][2], 23);
  // Настоящая новость: цена ×6 и объём ×20 — ряд не трогаем
  const news = mk('2019-10-01', 45, 17, 1e5).concat(mk('2019-11-18', 45, 102, 2e6));
  assert.equal(cutAtDataBreak(news, null).cut, 0);
  // Обвал впятеро не режем никогда: это настоящий убыток, а не порча данных
  const crash = mk('2020-01-01', 45, 10, 1e6).concat(mk('2020-02-15', 45, 1.5, 1e6));
  assert.equal(cutAtDataBreak(crash, null).cut, 0);
});

ok('listedThrough: конец листинга по реестру отличает делистинг от устаревшего кэша', () => {
  const ranges = { DEAD: [[1, '2010-01-01', '2019-06-28']], LIVE: [[1, '2010-01-01', '2026-08-04']] };
  assert.equal(listedThrough(ranges, 'DEAD'), '2019-06-28');
  assert.equal(listedThrough(ranges, 'LIVE'), '2026-08-04');
  assert.equal(listedThrough(ranges, 'UNKNOWN'), null);
});

ok('metaAcceptable: чужая валюта и не-акция отвергаются, отсутствие меты — нет', () => {
  assert.equal(metaAcceptable({ currency: 'USD', instrumentType: 'EQUITY' }).ok, true);
  assert.equal(metaAcceptable({ currency: 'USD', instrumentType: 'ETF' }).ok, true);
  assert.equal(metaAcceptable({ currency: 'INR', instrumentType: 'EQUITY' }).ok, false);
  assert.equal(metaAcceptable({ currency: 'USD', instrumentType: 'CURRENCY' }).ok, false);
  assert.equal(metaAcceptable(null).ok, true);
});

ok('normalizeTiingo: close переводится в конвенцию Yahoo по сплитам', () => {
  // сплит 2:1 на 2020-01-03: бары до него должны быть поделены на 2, adjClose берётся как есть
  const rows = [
    { date: '2020-01-01T00:00:00.000Z', close: 100, adjClose: 49, volume: 10, adjVolume: 20, splitFactor: 1 },
    { date: '2020-01-02T00:00:00.000Z', close: 102, adjClose: 50, volume: 11, adjVolume: 22, splitFactor: 1 },
    { date: '2020-01-03T00:00:00.000Z', close: 52, adjClose: 51, volume: 24, adjVolume: 24, splitFactor: 2 },
    { date: '2020-01-06T00:00:00.000Z', close: 53, adjClose: 52, volume: 25, adjVolume: 25, splitFactor: 1 },
  ];
  const { series, splits } = normalizeTiingo(rows);
  assert.deepEqual(splits, [['2020-01-03', 2]]);
  assert.equal(series[0][1], 50);   // 100 / 2
  assert.equal(series[1][1], 51);   // 102 / 2
  assert.equal(series[2][1], 52);   // день сплита уже посчитан после него
  assert.equal(series[3][1], 53);
  assert.equal(series[0][2], 49);   // adjClose не трогаем
  // объём тоже в сплит-конвенции, иначе close*volume разъедется в два раза
  assert.equal(series[0][3], 20);
  assert.equal(series[3][3], 25);
});

ok('trimFrozenTail: достроенный хвост делистнутой бумаги обрезается', () => {
  // Tiingo не обрывает ряд поглощённой компании, а повторяет последнюю цену с нулевым
  // объёмом (SGEN: сделка с Pfizer закрылась 2023-12-14, дальше 660 баров по $228.74)
  const day = n => addDaysIso('2023-10-01', n);
  const real = Array.from({ length: 40 }, (_, i) => [day(i), 100 + i, 100 + i, 1e6]);
  const frozen = Array.from({ length: 30 }, (_, i) => [day(40 + i), 139, 139, 0]);
  const t = trimFrozenTail(real.concat(frozen));
  assert.equal(t.trimmed, 30);
  assert.equal(t.series.length, 40);
  assert.equal(t.series[t.series.length - 1][0], day(39), 'последним остаётся настоящий торговый день');
  // живой ряд с настоящим объёмом не трогаем, даже если цена пару дней стоит
  const alive = real.concat(Array.from({ length: 8 }, (_, i) => [day(40 + i), 139, 139, 9e5]));
  assert.equal(trimFrozenTail(alive).trimmed, 0);
  // короткий ряд не трогаем вовсе
  assert.equal(trimFrozenTail(real.slice(0, 10)).trimmed, 0);
});

// ---------- календарно-временной портфель (главная метрика Статистики) ----------
ok('portfolio: месячная панель берёт закрытие последнего дня и медианный оборот', () => {
  const daily = [
    ['2020-01-02', 10, 10, 100], ['2020-01-15', 11, 11, 300], ['2020-01-31', 12, 12, 200],
    ['2020-02-03', 13, 13, 100], ['2020-02-28', 14, 14, 100],
  ];
  const m = monthlyFromDaily(daily);
  assert.equal(m.px['2020-01'], 12, 'закрытие месяца — последний торговый день');
  assert.equal(m.px['2020-02'], 14);
  // обороты 10*100=1000, 11*300=3300, 12*200=2400 -> медиана 2400
  assert.equal(m.dv['2020-01'], 2400, 'оборот — медианный дневной долларовый, не средний и не максимум');
});

ok('portfolio: равный вес ПО БУМАГАМ, окно удержания, порог ликвидности', () => {
  const p = new Panel();
  const mk = (a, b, c) => ({ px: { '2020-01': a, '2020-02': b, '2020-03': c }, dv: { '2020-01': 1e7, '2020-02': 1e7, '2020-03': 1e7 } });
  p.add('AAA', mk(100, 110, 121));   // +10% каждый месяц
  p.add('BBB', mk(100, 90, 81));     // -10% каждый месяц
  p.add('THIN', { px: { '2020-01': 100, '2020-02': 200, '2020-03': 400 }, dv: { '2020-01': 1e5, '2020-02': 1e5, '2020-03': 1e5 } });
  const sig = new Map([['2020-01', new Set(['AAA', 'BBB', 'THIN'])]]);
  const ser = portfolioSeries(p, sig, { H: 12, minDv: 1e6, minNames: 2 });
  assert.equal(ser.length, 2, 'месяцы удержания — февраль и март');
  assert.equal(ser[0].n, 2, 'неликвидная бумага в портфель не входит');
  assert.ok(Math.abs(ser[0].r - 0) < 1e-12, '+10% и -10% дают ноль при равном весе');
  // одна и та же бумага с двумя подачами не должна весить вдвое
  const sig2 = new Map([['2020-01', new Set(['AAA', 'BBB'])]]);
  const ser2 = portfolioSeries(p, sig2, { H: 12, minDv: 1e6, minNames: 2 });
  assert.deepEqual(ser2.map(x => x.n), ser.map(x => x.n));
  // окно удержания короче — бумага выпадает из портфеля
  const ser3 = portfolioSeries(p, sig, { H: 1, minDv: 1e6, minNames: 2 });
  assert.equal(ser3.length, 1, 'при H=1 держим только следующий месяц');
});

ok('portfolio: месячная просадка и контроль «тот же ценовой контекст»', () => {
  // Бумага падает с 100 до 50 и отрастает: на конец второго месяца просадка −50%,
  // а «побывала у максимума» верно только для первого месяца.
  const daily = [];
  const push = (iso, px) => daily.push([iso, px, px, 1e6]);
  for (let i = 0; i < 40; i++) push(addDaysIso('2020-01-01', i), 100);
  for (let i = 0; i < 40; i++) push(addDaysIso('2020-02-10', i), 50);
  const m = monthlyFromDaily(daily);
  assert.equal(m.dd['2020-03'], -0.5);
  assert.equal(m.ddHi['2020-01'], 0, 'в январе бумага стоит на максимуме');
  assert.ok(m.ddLo['2020-03'] <= -0.5);
  // контроль отбирается предикатом и держится столько же месяцев, сколько сигнал
  const p = new Panel();
  p.add('AAA', m);
  p.add('SPY', monthlyFromDaily(daily.map(r => [r[0], 10, 10, 1e9])), true);
  assert.ok(!p.px.has('ZZZ'));
  assert.deepEqual([...p.names()], ['AAA'], 'бенчмарк во вселенную не входит');
  const u = universeSeries(p, { minDv: 0, pred: (t, mm) => p.wasNearHigh(t, mm, -0.05) });
  assert.ok(u.size > 0);
});

ok('portfolio: парная разность и оборачиваемость', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ m: `2020-${String(i % 12 + 1).padStart(2, '0')}`, r: 0.02, n: 5 }));
  const ctrl = new Map(rows.map(x => [x.m, 0.01]));
  const d = pairedDiff(rows, ctrl);
  assert.ok(Math.abs(d.ex - 0.01) < 1e-12, 'разность 2% − 1% = 1% в месяц');
  // оборот: при удержании 1 месяц состав меняется целиком
  const p = new Panel();
  const daily = Array.from({ length: 400 }, (_, i) => [addDaysIso('2020-01-01', i), 10, 10, 1e6]);
  for (const t of ['A', 'B']) p.add(t, monthlyFromDaily(daily));
  const sig = new Map();
  const ms = p.months;
  ms.forEach((mm, i) => sig.set(mm, new Set([i % 2 ? 'A' : 'B'])));
  const to = turnover(p, sig, { H: 1, minDv: 0 });
  assert.ok(to > 0.9, `при полной смене состава оборот близок к 100%, получено ${to}`);
});

ok('portfolio: факторная альфа считается в избыточных доходностях', () => {
  // Портфель = рынок с бетой 1, но с постоянной прибавкой 0.5%/мес -> альфа ~6%/год
  const months = Array.from({ length: 60 }, (_, i) => `20${String(20 + Math.floor(i / 12)).padStart(2, '0')}-${String(i % 12 + 1).padStart(2, '0')}`);
  const mkt = new Map(), size = new Map(), mom = new Map();
  // Факторы должны быть невырожденными: три нулевые колонки дали бы сингулярную матрицу,
  // и регрессия честно вернула бы null — это тоже проверка, но не та, что нужна здесь.
  months.forEach((m, i) => {
    mkt.set(m, ((i * 37) % 13 - 6) / 100);
    size.set(m, ((i * 17) % 7 - 3) / 200);
    mom.set(m, ((i * 23) % 11 - 5) / 300);
  });
  const rows = months.map(m => ({ m, r: mkt.get(m) + 0.005, n: 10 }));
  const a = factorAlpha(rows, { market: mkt, size, mom });
  assert.ok(a, 'альфа посчитана');
  assert.ok(Math.abs(a.betas[0] - 1) < 0.02, `бета ${a.betas[0]} должна быть ~1`);
  assert.ok(Math.abs(a.alpha - 0.005) < 0.0005, `месячная альфа ${a.alpha} должна быть ~0.005`);
  // Тот же портфель против индекса: превышение то же, а Шарп выше рынка
  const v = vsBenchmark(rows, mkt);
  assert.ok(Math.abs(v.ex - 0.005) < 1e-9);
  assert.ok(v.ir > 100, 'при нулевой ошибке следования IR огромен');
});

ok('portfolio: факторы размера и моментума строятся из вселенной', () => {
  const p = new Panel();
  const day = (n, base, step) => Array.from({ length: n }, (_, i) => [addDaysIso('2020-01-01', i), base + i * step, base + i * step, 1e7]);
  // Тридцать бумаг: половина растёт быстрее — они и должны попасть в победители моментума
  for (let k = 0; k < 30; k++) p.add('T' + k, monthlyFromDaily(day(400, 10 + k, k < 15 ? 0.02 : 0.005)));
  const f = factorSeries(p, { minDv: 0 });
  assert.ok(f.size instanceof Map && f.mom instanceof Map);
  assert.ok(f.mom.size > 0, 'моментум-фактор посчитан хотя бы для одного месяца');
});

ok('compute: признак рабочего набора требует ВСЕХ трёх условий', () => {
  // Проверяем логику набора отдельно от сборки: цена у максимума, сумма и оборот
  const inSet = (dd, val, dv) => dd !== null && dd >= -0.05 && val >= 5e4 && dv >= 3e6;
  assert.equal(inSet(-0.01, 1e5, 1e7), true);
  assert.equal(inSet(-0.06, 1e5, 1e7), false, 'далеко от максимума');
  assert.equal(inSet(-0.01, 1e4, 1e7), false, 'слишком мелкая сумма');
  assert.equal(inSet(-0.01, 1e5, 1e6), false, 'неторгуемый оборот');
  assert.equal(inSet(null, 1e5, 1e7), false, 'просадка неизвестна');
});

// ---------- реестр биржевых символов ----------
ok('symbols: разбор реестра, площадка на дату и склейка интервалов', () => {
  const csv = 'ticker,exchange,assetType,priceCurrency,startDate,endDate\n'
    + 'LGCY,NASDAQ,Stock,USD,2007-01-12,2019-06-28\n'
    + 'LGCY,AMEX,Stock,USD,2024-09-26,2026-08-03\n'
    + 'MOVE,NASDAQ,Stock,USD,2010-01-04,2018-03-15\n'
    + 'MOVE,NYSE,Stock,USD,2018-03-16,2026-08-03\n'
    + 'JUNK,PINK,Stock,USD,2012-01-01,2020-01-01\n'
    + 'FUND,NMFQS,Mutual Fund,USD,2000-01-01,2026-01-01\n'
    + 'CHIN,SHE,Stock,CNY,2000-01-01,2026-01-01\n';
  const r = parseRegistry(csv);
  assert.equal(r.FUND, undefined, 'взаимные фонды в реестр не попадают');
  assert.equal(r.CHIN, undefined, 'иностранная валюта не попадает');
  assert.equal(exchangeAt(r, 'LGCY', '2017-03-06'), 'listed');
  assert.equal(exchangeAt(r, 'JUNK', '2015-01-01'), 'otc');
  assert.equal(exchangeAt(r, 'LGCY', '2021-01-01'), null, 'между интервалами символ ничей');
  assert.equal(exchangeAt(r, 'НЕТ', '2015-01-01'), null);
  // перевод листинга Nasdaq -> NYSE идёт встык и должен склеиться в один инструмент
  assert.deepEqual(mergeRanges(r.MOVE), [['2010-01-04', '2026-08-03']]);
  assert.equal(sameInstrumentAsLatest(r, 'MOVE', '2012-05-05'), true);
  // а смена владельца символа оставляет многолетний зазор
  assert.equal(sameInstrumentAsLatest(r, 'LGCY', '2017-03-06'), false, 'сделки Legacy Reserves ≠ нынешний владелец LGCY');
  assert.equal(sameInstrumentAsLatest(r, 'LGCY', '2025-01-15'), true);
  assert.equal(sameInstrumentAsLatest(r, 'НЕТ', '2015-01-01'), null);
});

ok('issuerCategory: у мёртвого эмитента площадка берётся из реестра символов', () => {
  const ref = new Map([[111, { ticker: 'ALIV', exchange: 'Nasdaq', name: 'Живая' }]]);
  const ranges = { DEAD: [[1, '2010-01-01', '2019-01-01']], OTCX: [[0, '2010-01-01', '2019-01-01']] };
  assert.equal(issuerCategory({ cik: 111, t: 'ALIV', tdate: '2018-05-05' }, ref, ranges), 'listed');
  // эмитента в справочнике нет: раньше всегда было 'unknown' и OTC проходил во вселенную
  assert.equal(issuerCategory({ cik: 222, t: 'DEAD', tdate: '2018-05-05' }, ref, ranges), 'listed');
  assert.equal(issuerCategory({ cik: 333, t: 'OTCX', tdate: '2018-05-05' }, ref, ranges), 'otc');
  assert.equal(issuerCategory({ cik: 444, t: 'ZZZZ', tdate: '2018-05-05' }, ref, ranges), 'unknown');
  assert.equal(issuerCategory({ cik: 222, t: 'DEAD', tdate: '2018-05-05' }, ref, null), 'unknown', 'без реестра поведение прежнее');
});

// ---------- юрлица и кластеры ----------
ok('entity: различение физлиц и юрлиц', () => {
  assert.equal(isEntityName('Vanguard Group Inc'), true);
  assert.equal(isEntityName('RA Capital Management, L.P.'), true);
  assert.equal(isEntityName('Ivanov Ivan'), false);
  // Имя первично, флаг вторичен. Прежнее правило «officer/director — всегда человек»
  // опровергнуто данными: 30 402 строки с юрлицовым именем несут флаг директора
  // («director by deputization»), и через них независимые физлица склеивались в одну
  // группу, отключая гейт синхронных подач.
  assert.equal(isPersonOwner({ name: 'Smith Capital Trust', rel: 'DO' }), false);
  assert.equal(isPersonOwner({ name: 'TRIAN FUND MANAGEMENT, L.P.', rel: 'D' }), false);
  assert.equal(isPersonOwner({ name: 'PELTZ NELSON', rel: 'DT' }), true);
  assert.equal(isPersonOwner({ name: 'RA Capital Management LP', rel: 'T' }), false);
  assert.equal(isFundOnly({ owners: [{ name: 'Baker Bros Advisors LP', rel: 'T' }] }), true);
  assert.equal(isFundOnly({ owners: [{ name: 'Baker Bros Advisors LP', rel: 'T' }, { name: 'Ivanov', rel: 'D' }] }), false);
});
ok('CMP: рутинный трейдер и недостаток истории', () => {
  const hist = [];
  for (const y of [2019, 2020, 2021, 2022]) hist.push({ tdate: `${y}-03-15`, code: 'P', cik: 1, val: 1000 });
  hist.sort((a, b) => a.tdate < b.tdate ? -1 : 1);
  assert.equal(isRoutineCMP(hist, '2022-03-15'), true);   // март 2019/2020/2021 подряд
  assert.equal(isRoutineCMP(hist, '2022-08-15'), false);  // в августе не торговал
  assert.equal(isRoutineCMP(hist, '2020-03-15'), null);   // истории меньше трёх лет
  assert.equal(isRoutineCMP([], '2022-03-15'), null);
});
ok('регулярная серия распознаётся по равным интервалам', () => {
  const hist = ['2021-01-10', '2021-04-11', '2021-07-12', '2021-10-11']
    .map(d => ({ tdate: d, code: 'P', cik: 5, val: 1000 }));
  assert.equal(isRegularSeries(hist, '2022-01-10', 5, 'P'), true);
  const messy = ['2021-01-10', '2021-02-20', '2021-09-01', '2021-10-11']
    .map(d => ({ tdate: d, code: 'P', cik: 5, val: 1000 }));
  assert.equal(isRegularSeries(messy, '2022-06-10', 5, 'P'), false);
});
ok('инфлексия: первая покупка за три года', () => {
  const hist = [
    { tdate: '2019-02-01', code: 'P', cik: 1, val: 100 },
    { tdate: '2021-05-01', code: 'S', cik: 1, val: 100 },
  ];
  assert.equal(inflection(hist, '2023-06-01'), 'first-in-3y');
  assert.equal(inflection(hist, '2019-06-01'), null);          // покупка была недавно
  assert.equal(inflection([{ tdate: '2019-01-01', code: 'S', cik: 1, val: 1 }], '2020-01-01'), 'first-ever');
  assert.equal(inflection([], '2020-01-01'), null);            // нет истории — не с чем сравнивать
  assert.equal(typicalBuyValue(hist, '2023-06-01'), 100);
});

// ---------- гейты ----------
ok('гейты: отсев ложных покупок', () => {
  const base = { code: 'P', px: 10, fn: {}, di: 'D' };
  assert.equal(applyGates(base, { close: 10 }).ok, true);
  assert.equal(applyGates({ ...base, fn: { offering: 1 } }, { close: 10 }).drop, 'offering');
  assert.equal(applyGates({ ...base, fn: { drip: 1 } }, { close: 10 }).drop, 'drip');
  assert.equal(applyGates({ ...base, fn: { forced: 1 } }, { close: 10 }).drop, 'forced');
  // Цена на 12% ниже закрытия — так открытый рынок не исполняет, это размещение
  assert.equal(applyGates(base, { close: 11.5 }).drop, 'discount');
  // Та же цена, но сноска говорит «средневзвешенная по серии» — допуск шире
  assert.equal(applyGates({ ...base, fn: { wavg: 1 } }, { close: 11.5 }).ok, true);
  assert.equal(applyGates(base, { close: 200 }).drop, 'outlier');
  assert.equal(applyGates(base, { close: 10, syncFilers: 4 }).drop, 'sync');
  assert.equal(applyGates(base, { close: 10, fundOnly: true }).drop, 'fund');
  assert.equal(applyGates(base, { close: 10, planned: true }).drop, 'planned');
  assert.equal(applyGates(base, { close: 10, routine: true }).drop, 'routine');
  assert.equal(applyGates(base, { close: 10, routine: null }).tags.includes('no-history'), true);
  assert.equal(applyGates({ ...base, cancelled: 1 }, { close: 10 }).drop, 'cancelled');
});
ok('гейты: короткий ряд котировок — это старт торгов, а не «цен нет»', () => {
  // Регрессия: ряд короче порога бэктеста считался отсутствием цен, histDays уходил null,
  // и гейт старта торгов не срабатывал — участие в IPO попадало в сигнал
  const base = { code: 'P', px: 15, fn: {}, di: 'D' };
  assert.equal(applyGates(base, { close: 15, histDays: 8, noPrice: false }).drop, 'newlisting');
  // Ряда нет вовсе: вердикта нет, но факт непроверяемости помечен тегом
  const none = applyGates(base, { close: null, histDays: null, noPrice: true });
  assert.equal(none.ok, true);
  assert.equal(none.tags.includes('no-price'), true);
});
ok('гейты: покупка на старте торгов не считается открыторыночной', () => {
  // Регрессия: у только что разместившейся бумаги нет истории котировок, поэтому ценовые
  // гейты молча не срабатывали — и участие фондов в IPO по ровной цене выпуска попадало
  // в сигнал как «кластер инсайдеров на десятки миллионов»
  const base = { code: 'P', px: 15, fn: {}, di: 'D' };
  assert.equal(applyGates(base, { close: 15, histDays: 3 }).drop, 'newlisting');
  assert.equal(applyGates(base, { close: 15, histDays: 19 }).drop, 'newlisting');
  assert.equal(applyGates(base, { close: 15, histDays: 20 }).ok, true);
  // Нет ряда вовсе — гейт не выносит вердикта, но помечает, что проверить было нечем
  const noPrice = applyGates(base, { close: null, histDays: null, noPrice: true });
  assert.equal(noPrice.ok, true);
  assert.equal(noPrice.tags.includes('no-price'), true);
});
ok('гейты: неисполнимый на рынке объём', () => {
  // Обмен акциями при слиянии приходит кодом P: 2.5 млрд акций микрокапа на $8.6 млрд
  // при обороте $3 млн/день физически невозможно исполнить на открытом рынке
  const base = { code: 'P', px: 3.45, fn: {}, di: 'D' };
  const ctx = { close: 3.45, histDays: 400, dollarVolume: 3e6 };
  assert.equal(applyGates({ ...base, val: 8.63e9 }, ctx).drop, 'capacity');
  // Крупная, но исполнимая покупка проходит: $50 млн при обороте $3 млн — 17× оборота
  assert.equal(applyGates({ ...base, val: 5e7 }, ctx).ok, true);
  // Без данных об обороте правило не применяется
  assert.equal(applyGates({ ...base, val: 8.63e9 }, { close: 3.45, histDays: 400, dollarVolume: 0 }).ok, true);
});
ok('гейты: невозможные числа в форме и чужой ценовой ряд', () => {
  const ctx = { close: 3.45, histDays: 400 };
  // Числа Form 4 не валидируются SEC: в выборке встречается «5 079 100 акций по $253 995.06»
  assert.equal(isImplausible({ px: 253995.06, sh: 5079100, val: 1.29e12 }), true);
  assert.equal(isImplausible({ px: 500000, sh: 142857, val: 7.1e10 }), true);
  assert.equal(applyGates({ code: 'P', px: 253995.06, sh: 5079100, val: 1.29e12, fn: {} }, ctx).drop, 'badvalue');
  // Обычная крупная покупка правдоподобна и проходит
  assert.equal(isImplausible({ px: 3.45, sh: 1e6, val: 3.45e6 }), false);
  // Ряд принадлежит другой компании: причина отсева должна быть именно эта, а не выдумка
  // о природе сделки, потому что ни цене, ни сопоставлению с котировкой доверять нельзя
  const g = applyGates({ code: 'P', px: 3.45, sh: 1000, val: 3450, sec: 'Common Stock', fn: {} },
    { ...ctx, reassigned: true, syncFilers: 9, planned: true });
  assert.equal(g.drop, 'reassigned');
});
ok('гейты: класс бумаги и несопоставимые единицы', () => {
  const base = { code: 'P', px: 10, fn: {}, di: 'D' };
  assert.equal(isNonCommon('7.875% Series A Cumulative Redeemable Preferred Stock'), true);
  assert.equal(isNonCommon('Warrants (right to buy)'), true);
  assert.equal(isNonCommon('Depositary Shares for Series B Preferred Stock'), true);
  assert.equal(isNonCommon('Common Stock'), false);
  assert.equal(isNonCommon('Class A Common Stock'), false);
  assert.equal(isNonCommon('Common Shares of Beneficial Interest'), false);
  // ADS иностранного эмитента — это и есть торгуемые обыкновенные акции
  assert.equal(isNonCommon('American Depositary Shares'), false);
  assert.equal(isNonCommon('Class A Ordinary Shares'), false);
  // Паи MLP — обычная торгуемая единица капитала, а не «не-обыкновенная бумага»
  assert.equal(isNonCommon('Common Units representing limited partner interests'), false);
  assert.equal(isNonCommon('Common Units'), false);
  assert.equal(applyGates({ ...base, sec: 'Series B Preferred Stock' }, { close: 10 }).drop, 'security');
  assert.equal(applyGates(base, { close: 10, unitsMismatch: true }).drop, 'units');
});
ok('сплиты: номинальная цена восстанавливается из котировки', () => {
  // Обратный сплит 1:20 в 2024: котировки до него Yahoo умножает на 20
  const splits = [['2024-06-01', 0.05]];
  assert.equal(nominalFactor(splits, '2023-01-01'), 0.05);   // сделка до сплита
  assert.equal(nominalFactor(splits, '2025-01-01'), 1);      // сделка после сплита
  // Прямой сплит 2:1 — исторические цены делятся вдвое, номинал вдвое выше
  assert.equal(nominalFactor([['2020-08-31', 2]], '2020-01-01'), 2);
  assert.equal(nominalFactor([], '2020-01-01'), 1);
  assert.equal(nominalFactor(undefined, '2020-01-01'), 1);
});
ok('плановость: чекбокс ИЛИ сноска', () => {
  assert.equal(isPlanned({ b5: 1, fn: {} }), true);
  assert.equal(isPlanned({ b5: 0, fn: { b5: 1 } }), true);   // история до апреля 2023
  assert.equal(isPlanned({ b5: 0, fn: {} }), false);
});

// ---------- скоринг ----------
ok('легенда признаков: коды короткие и без коллизий', () => {
  // Коды парсим из web/app.js: дублирующийся код сделал бы легенду ложной
  const src = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  const featBlock = src.slice(src.indexOf('export const FEAT = {'), src.indexOf('export const DROP_CODE'));
  const dropBlock = src.slice(src.indexOf('export const DROP_CODE = {'), src.indexOf('};', src.indexOf('export const DROP_CODE')));
  const featCodes = [...featBlock.matchAll(/\[\s*'([^']{1,2})'\s*,/g)].map(m => m[1]);
  const dropCodes = [...dropBlock.matchAll(/:\s*'([^']{1,2})'/g)].map(m => m[1]);
  assert.ok(featCodes.length >= 9, `кодов признаков должно быть ≥9, найдено ${featCodes.length}`);
  assert.ok(dropCodes.length >= 15, `кодов отсева должно быть ≥15, найдено ${dropCodes.length}`);
  for (const c of [...featCodes, ...dropCodes]) assert.ok(c.length <= 2, `код «${c}» длиннее двух знаков`);
  // Внутри каждой группы коллизий быть не должно. «Пл» намеренно один и тот же для
  // плановой сделки и причины отсева «план 10b5-1» — это одно и то же понятие.
  const dupFeat = featCodes.filter((c, i) => featCodes.indexOf(c) !== i);
  const dupDrop = dropCodes.filter((c, i) => dropCodes.indexOf(c) !== i);
  assert.deepEqual(dupFeat, [], `дубли среди признаков: ${dupFeat}`);
  assert.deepEqual(dupDrop, [], `дубли среди причин отсева: ${dupDrop}`);
});

ok('легенда «у максимума» называет тот же порог, что и правило набора', () => {
  // Порог живёт в двух местах: константа сборки и текст легенды. Разъехавшись, они дают
  // страницу, которая уверенно врёт про собственное правило, и заметить это можно только
  // глазами. При смене SET_MAX_DD этот тест краснеет и заставляет поправить текст.
  const compute = readFileSync(join(ROOT, 'scripts', 'compute.mjs'), 'utf8');
  const m = compute.match(/const SET_MAX_DD = (-?[\d.]+);/);
  assert.ok(m, 'в compute.mjs не найдена константа SET_MAX_DD');
  const pctRule = Math.abs(Math.round(Number(m[1]) * 100));
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  const legend = app.match(/high:\s*\[[^\]]*?не более чем на (\d+)% ниже/);
  assert.ok(legend, 'в web/app.js не найден текст легенды «у максимума»');
  assert.equal(Number(legend[1]), pctRule,
    `легенда обещает ${legend[1]}%, а правило набора — ${pctRule}%`);
});

// ---------- утренний список: отбор, результат D+1, счётчик, всплеск ----------
ok('утренний список: отбор строк, свёртка по бумаге, скор, основной список и пометки', () => {
  const base = { name: 'X Corp', who: ['Doe'], role: 'D', val: 2e4, dd: -0.1, dv: 4e7, px: 20, drop: null };
  const day = buildDay([
    { ...base, t: 'AAA', val: 3e5 },
    { ...base, t: 'AAA', val: 2e5, role: 'C', who: ['Roe'] },        // та же бумага: суммируется, лучшая роль C
    { ...base, t: 'BBB', val: 9999 },                                   // меньше $10 тыс.
    { ...base, t: 'CCC', px: 4.99 },                                    // дешевле $5
    { ...base, t: 'DDD', drop: 'offering' },                            // отсеяна гейтами
    { ...base, t: 'EEE', dv: 9.9e6 },                                   // оборот ниже $10 млн
    { ...base, t: 'FFF', dv: 1.5e7, val: 1.2e6, dd: -0.4, role: 'O' },  // все четыре балла, оборот $10–30 млн
    { ...base, t: 'GGG', val: 1e4, px: 5, dv: 1e7, dd: -0.3 },          // ровно на границах: проходит, скор 0
    { ...base, t: 'HHH', val: 9e4, dd: -0.35 },                         // скор 1 (только просадка)
    { ...base, t: 'III', val: 1e5, role: 'F', dd: 0 },                  // ровно $100 тыс. и офицер: скор 2
  ]);
  // сначала скор, внутри скора — сумма
  assert.deepEqual(day.map(x => x.t), ['FFF', 'AAA', 'III', 'HHH', 'GGG']);
  const [fff, aaa, iii, hhh, ggg] = day;
  assert.equal(aaa.val, 5e5); assert.equal(aaa.n, 2); assert.equal(aaa.role, 'C');
  assert.deepEqual(aaa.who, ['Doe', 'Roe']);
  assert.deepEqual(aaa.tags, ['off']);
  assert.equal(aaa.score, 2); assert.equal(aaa.main, true); assert.equal(aaa.cost, 0.001, 'оборот ≥$30 млн — 0,10% на круг');
  assert.equal(fff.score, 4); assert.equal(fff.main, true); assert.equal(fff.cost, 0.0015, 'оборот $10–30 млн — 0,15% на круг');
  assert.deepEqual(fff.tags, ['off', 'deep', 'big']);
  assert.equal(iii.score, 2); assert.equal(iii.main, true, 'ровно $100 тыс. даёт балл');
  assert.equal(hhh.score, 1); assert.equal(hhh.main, false);
  assert.equal(ggg.score, 0); assert.equal(ggg.main, false); assert.deepEqual(ggg.tags, [], 'просадка ровно −30% — не «глубже»');
  assert.equal(scoreOf({ val: 2e6, role: 'X', dd: null }), 2, 'сумма даёт два балла: от $100 тыс. и от $1 млн');
  assert.equal(scoreOf({ val: 5e4, role: 'T', dd: -0.31 }), 1);
  assert.equal(costOf(3e7), 0.001); assert.equal(costOf(2.99e7), 0.0015);
  assert.equal(bestRole(['D', 'O', 'T']), 'O'); assert.equal(bestRole([]), 'X');
  assert.deepEqual(tagsOf({ role: 'F', dd: null, val: 1e6 }), ['off', 'big']);
});
ok('утренний список: приём формы — после закрытия, в торги, до открытия; время первой формы дня', () => {
  assert.equal(sessionOf('2026-11-03T16:00'), 'post');
  assert.equal(sessionOf('2026-11-03T15:59'), 'rth');
  assert.equal(sessionOf('2026-11-03T09:30'), 'rth');
  assert.equal(sessionOf('2026-11-03T09:29'), 'pre');
  assert.equal(sessionOf('2026-11-03T21:20'), 'post');
  assert.equal(sessionOf(null), null);
  assert.equal(sessionOf(undefined), null);
  const base = { name: 'X', who: ['A'], role: 'D', val: 5e4, dd: -0.1, dv: 4e7, px: 20, drop: null };
  const [aaa, bbb] = buildDay([
    { ...base, t: 'AAA', at: '2026-11-03T18:10' }, { ...base, t: 'AAA', at: '2026-11-03T11:00' }, { ...base, t: 'AAA', at: null },
    { ...base, t: 'BBB', val: 4e4 },                                   // времени нет (квартальный датасет) — пусто, не выдумка
  ]);
  assert.equal(aaa.at, '2026-11-03T11:00'); assert.equal(aaa.ses, 'rth', 'бумага узнана по первой форме дня');
  assert.equal(bbb.at, null); assert.equal(bbb.ses, null);
});
ok('утренний список: результат сделки — от открытия до закрытия, минус IWM и SPY, причины пропуска', () => {
  const I = [200, 201, 199], S = [400, 404, 399];                       // IWM +0,5%, SPY +1,0%
  const r = tradeResult([100, 102, 99], I, S);
  assert.equal(r.r, 0.02); assert.equal(r.b, 0.005); assert.equal(r.bs, 0.01); assert.equal(r.ex, 0.015); assert.equal(r.exS, 0.01);
  assert.equal(tradeResult([100, 102, null], I, S).ex, 0.015, 'вчерашнего закрытия нет — это не «застывшее»');
  assert.equal(tradeResult([100, 102, 100], I, S).skip, 'frozen');      // открытие ровно равно вчерашнему закрытию
  assert.equal(tradeResult(null, I, S).skip, 'noopen');
  assert.equal(tradeResult([10, null, 9], I, S).skip, 'noclose');
  assert.equal(tradeResult([4.9, 5.2, 4.8], I, S).skip, 'px');
  assert.equal(tradeResult([5, 5.1, 4.8], I, S).skip, undefined, 'ровно $5 допустимо');
  assert.equal(tradeResult([100, 102, 99], null, S).skip, 'nobench');
  assert.equal(tradeResult([100, 102, 99], I, null).skip, 'nobench', 'нет SPY — сделка пропускается, а не считается наполовину');
});
ok('утренний список: сводка счётчика — к IWM и к SPY, свои издержки у каждой сделки', () => {
  const tr = [{ day: 'a', ex: 0.01 }, { day: 'a', ex: 0.03 }, { day: 'b', ex: -0.01 }, { day: 'c', ex: 0.02 }].map(x => ({ ...x, exS: x.ex - 0.002 }));
  const s = summarize(tr);
  // к IWM: средние по дням 0.02, −0.01, 0.02 -> среднее 0.01, sd 0.01732, t = 0.01 / (0.01732 / √3) = 1; издержки 0,10% по умолчанию
  assert.deepEqual(s, {
    n: 4, days: 3, cost: 0.001,
    iwm: { mean: 0.0125, median: 0.015, win: 0.75, tDays: 1, net: 0.0115, cumNet: 0.046 },
    spy: { mean: 0.0105, median: 0.013, win: 0.75, tDays: 0.8, net: 0.0095, cumNet: 0.038 },
  });
  assert.deepEqual(summarize([]), { n: 0, days: 0 });
  assert.equal(summarize([{ day: 'a', ex: 0.01, exS: 0.01 }, { day: 'a', ex: 0.02, exS: 0.02 }]).iwm.tDays, null, 'один день — t не определён');
  assert.equal(summarize([{ day: 'a', ex: 0.01, exS: 0.01 }, { day: 'b', ex: 0.01, exS: 0.01 }]).iwm.tDays, null, 'нулевой разброс — t не определён');
  // у каждой сделки свой уровень издержек: 0,10% и 0,15% -> в среднем 0,125%
  const mixed = summarize([{ day: 'a', ex: 0.01, exS: 0.01, cost: 0.001 }, { day: 'a', ex: 0.01, exS: 0.01, cost: 0.0015 }]);
  assert.equal(mixed.cost, 0.00125); assert.equal(mixed.iwm.net, 0.0088); assert.equal(mixed.iwm.cumNet, 0.0175);
});
ok('всплеск покупок: z к 36 прошлым месяцам, порог 2, нужен запас в 24 месяца', () => {
  // Малый пример руками: окно 3, запас 3. B3 = 36, 38, 37, 38, 38, 78; на последнем месяце
  // прошлые B3 = 37, 38, 38 (среднее 37.667, sd 0.577) -> z = 40.333 / 0.577 = 69.86
  const small = breadth(new Map([['2020-01', 10], ['2020-02', 11], ['2020-03', 15], ['2020-04', 12], ['2020-05', 10], ['2020-06', 16], ['2020-07', 12], ['2020-08', 50]]),
    { p: { win: 3, need: 3, zThr: 2, keep: 60 } });
  assert.equal(small.asOf, '2020-08'); assert.equal(small.b3, 78);
  assert.ok(Math.abs(small.z - 69.86) < 0.01, `z=${small.z}`);
  assert.equal(small.surge, true);
  // Синтетика целиком: 60 месяцев ровного фона с шумом, затем три месяца втрое выше
  const m = i => `${2016 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
  const flat = new Map(), spike = new Map();
  for (let i = 0; i < 60; i++) { const b = 100 + ((i * 7) % 11); flat.set(m(i), b); spike.set(m(i), i >= 57 ? 300 : b); }
  const f = breadth(flat), sp = breadth(spike);
  assert.equal(f.surge, false); assert.ok(Math.abs(f.z) < 2, `фон: z=${f.z}`);
  assert.equal(sp.surge, true); assert.ok(sp.z >= 2);
  assert.equal(sp.history.length, 60); assert.equal(sp.history.at(-1).m, m(59));
  const first = sp.history.find(x => x.z !== null);
  assert.equal(first.m, m(26), 'первый z — когда накопилось 24 прошлых значения B3 (индекс 2 + 24)');
  assert.ok(sp.history.slice(0, 26).every(x => x.z === null));
  // Неполный текущий месяц не бывает «текущим значением» и помечается в истории
  const part = breadth(spike, { partialFrom: m(59) });
  assert.equal(part.asOf, m(58)); assert.equal(part.history.at(-1).p, 1);
  assert.equal(breadth(new Map()), null);
});
ok('открытия: отбор дней входа из одного ответа, пропуски, слияние, календарь IWM', () => {
  const ohlc = [['2026-10-29', 10, 10.5], ['2026-10-30', 10.6, 10.4], ['2026-11-02', 10.4, 10.9], ['2026-11-03', null, 11]];
  // Подача 30.10 -> день входа 02.11: открытие 10.4, закрытие 10.9, вчерашнее закрытие 10.4
  const p = pickOpens(ohlc, ['2026-10-30']);
  assert.deepEqual(p, { '2026-11-02': [10.4, 10.9, 10.4] });
  assert.equal(tradeResult(p['2026-11-02'], [100, 101, 99]).skip, 'frozen', 'открытие равно вчерашнему закрытию');
  assert.deepEqual(pickOpens(ohlc, ['2026-11-02']), {}, 'у дня входа нет открытия — записи нет');
  assert.deepEqual(pickOpens(ohlc, ['2026-07-30']), {}, 'подачи до OPENS_FROM не хранятся');
  assert.deepEqual(pickOpens(ohlc, [], { all: true }), { '2026-10-29': [10, 10.5, null], '2026-10-30': [10.6, 10.4, 10.5], '2026-11-02': [10.4, 10.9, 10.4] });
  const store = { t: { AAA: { '2026-10-02': [9, 9.1, 8.9] }, IWM: { '2026-10-30': [1, 1, 1], '2026-11-02': [1, 1, 1], '2026-11-04': [1, 1, 1] } } };
  mergeOpens(store, 'AAA', { '2026-10-02': [9.5, 9.6, 9.4], '2026-11-02': [10.4, 10.9, 10.4] });
  assert.deepEqual(store.t.AAA['2026-10-02'], [9.5, 9.6, 9.4], 'свежая запись замещает прежнюю по той же дате');
  assert.deepEqual(opensOf(store, 'AAA', '2026-11-02'), [10.4, 10.9, 10.4]);
  assert.equal(opensOf(store, 'AAA', '2026-11-03'), null);
  assert.equal(nextTradingDay(store, '2026-10-30'), '2026-11-02');
  assert.equal(nextTradingDay(store, '2026-11-02'), '2026-11-04', 'пропущенный день (праздник) календарь IWM перешагивает');
  assert.equal(nextTradingDay(store, '2026-11-04'), null, 'дня входа ещё нет');
  // запись и чтение файла
  const od = join(ROOT, '.selftest-opens');
  rmSync(od, { recursive: true, force: true });
  writeOpens(od, store, '2026-11-04');
  assert.deepEqual(readOpens(od).t, store.t);
  assert.deepEqual(readOpens(join(od, 'нет')).t, {}, 'файла нет — пустое хранилище');
  rmSync(od, { recursive: true, force: true });
});

// ---------- вечерняя схема на бумаге ----------
ok('вечерняя схема: время по Нью-Йорку, окно приёма 16:00–20:00, секунды в шапке формы', () => {
  assert.equal(nyToMs('2026-07-01T17:00:00'), Date.parse('2026-07-01T21:00:00Z'), 'летом UTC−4');
  assert.equal(nyToMs('2026-11-04T17:00:00'), Date.parse('2026-11-04T22:00:00Z'), 'зимой UTC−5');
  assert.equal(nyWall(Date.parse('2026-11-04T22:21:35Z')), '2026-11-04T17:21:35');
  assert.equal(nyToMs('мусор'), null);
  assert.equal(inEveningWindow('2026-11-04T16:00'), true); assert.equal(inEveningWindow('2026-11-04T19:59'), true);
  assert.equal(inEveningWindow('2026-11-04T15:59'), false); assert.equal(inEveningWindow('2026-11-04T20:00'), false);
  assert.equal(inEveningWindow(null), false);
  assert.equal(acceptedAtSec('<ACCEPTANCE-DATETIME>20261103172135'), '2026-11-03T17:21:35');
  assert.equal(acceptedAtSec('<ACCEPTANCE-DATETIME>20261103176135'), null);
  assert.equal(filingPath(123, '0001-26-000001'.replace('0001', '0000000001')), 'edgar/data/123/000000000126000001/0000000001-26-000001.txt');
});
ok('вечерняя схема: лента getcurrent — формы без повторов, поправки и чужие типы различимы', () => {
  const xml = '<feed><entry><title>4 - Smith (0001) (Reporting)</title><link rel="alternate" href="https://www.sec.gov/Archives/edgar/data/111/000112345626000001/0001123456-26-000001-index.htm"/>'
    + '<updated>2026-11-04T17:21:35-05:00</updated><category term="4"/><id>urn:tag:sec.gov,2008:accession-number=0001123456-26-000001</id></entry>'
    + '<entry><title>4 - Issuer</title><link href="https://www.sec.gov/Archives/edgar/data/222/000112345626000001/0001123456-26-000001-index.htm"/><updated>2026-11-04T17:21:35-05:00</updated><category term="4"/><id>urn:tag:sec.gov,2008:accession-number=0001123456-26-000001</id></entry>'
    + '<entry><title>4/A - Roe</title><link href="https://www.sec.gov/Archives/edgar/data/333/000112345626000002/0001123456-26-000002-index.htm"/><updated>2026-11-04T17:30:00-05:00</updated><category term="4/A"/><id>urn:tag:sec.gov,2008:accession-number=0001123456-26-000002</id></entry>'
    + '<entry><title>без номера</title><link href="x"/></entry></feed>';
  const e = parseAtom(xml);
  assert.deepEqual(e.map(x => [x.acc, x.cik, x.form]), [['0001123456-26-000001', 111, '4'], ['0001123456-26-000002', 333, '4/A']]);
  assert.equal(nyWall(Date.parse(e[0].updated)), '2026-11-04T17:21:35');
  assert.deepEqual(parseAtom(''), []);
});
ok('вечерняя схема: событие — покупка P обыкновенных акций от $10 тыс. в окне приёма', () => {
  const row = (extra = {}) => ({ code: 'P', t: 'TST', cik: 5, val: 6000, ...extra });
  const ev = buildEvent([row(), row({ val: 7000 }), row({ code: 'S', val: 9e6 })], { acc: 'A1', at: '2026-11-04T17:21:35', fdate: '2026-11-04' });
  assert.deepEqual({ ...ev }, { k: 'event', id: 'A1', acc: 'A1', t: 'TST', cik: 5, fdate: '2026-11-04', at: '2026-11-04T17:21:35', val: 13000, n: 2 }, 'продажа не считается, суммы покупок складываются');
  assert.equal(buildEvent([row({ val: 9999 })], { acc: 'A2', at: '2026-11-04T17:21:35', fdate: 'x' }), null, 'меньше $10 тыс.');
  assert.equal(buildEvent([row()], { acc: 'A3', at: '2026-11-04T15:50:00', fdate: 'x' }), null, 'принята в торги');
  assert.equal(buildEvent([row({ val: 5e4 })], { acc: 'A4', at: '2026-11-04T17:21:35', fdate: 'x', isCommon: () => false }), null, 'не обыкновенная бумага');
  assert.equal(buildEvent([row({ code: 'S' })], { acc: 'A5', at: '2026-11-04T17:21:35', fdate: 'x' }), null, 'нет покупки');
});
ok('вечерняя схема: цена покупки — ask честной книги, иначе последняя сделка плюс оценка спреда', () => {
  // Yahoo вне сессии: AAPL bid 323.80 / ask 337.35 при цене 337 — разрыв 4%: книга негодна
  const junk = fromWorker({ b: 323.8, a: 337.35, p: 331.9, t: 1, pp: 337.05, pt: 1793797534, st: 'POST' });
  assert.equal(validBook(junk), false);
  const e1 = entryPx(junk, 1793797600);
  assert.equal(e1.est, true); assert.ok(Math.abs(e1.px - 337.05 * 1.002) < 1e-9, 'последняя сделка × (1 + оценка спреда)');
  assert.equal(validBook({ bid: 10, ask: 10.02 }), true);
  assert.deepEqual(entryPx({ bid: 10, ask: 10.02, last: 10.01 }), { px: 10.02, est: false });
  assert.equal(validBook({ bid: 0, ask: 10 }), false, 'нулевая сторона — «нет данных»'); assert.equal(validBook({ bid: 10.1, ask: 10 }), false, 'перевёрнутая книга');
  assert.equal(entryPx({ bid: 0, ask: 0 }), null, 'ни книги, ни сделки — цены нет');
  const stale = entryPx({ last: 10, lastT: 1000 }, 5000);
  assert.equal(stale.est, true); assert.equal(stale.stale, true, 'сделка старше 10 минут помечена');
  assert.equal(benchPx({ bid: 98.95, ask: 99.05, last: 99.5 }), 99, 'эталон — середина честной книги'); assert.equal(benchPx({ last: 99.5 }), 99.5);
  assert.deepEqual(fromWorker({ b: 0, a: null, p: 5 }).bid, null);
  assert.equal(fromWorker({ p: 5, t: 7, st: 'POST' }).lastT, 7, 'нет вечерней цены — берём последнюю регулярную');
});
ok('вечерняя схема: бумажная сделка — к IWM за то же окно, продажа на закрытии и на открытии D+1', () => {
  const qs = { 5: { bid: 9.99, ask: 10 }, 15: { bid: 9.99, ask: 10 }, 30: { bid: 9.99, ask: 10 } };
  const bs = { 5: { last: 200 }, 15: { last: 200 }, 30: { last: 200 } };
  const t = paperTrade(qs, bs, { o: 10.5, c: 10.8 }, { o: 201, c: 201.6 });
  // закрытие: +8,0% минус IWM 200 -> 201,6 (+0,8%) = +7,2%; открытие: +5,0% минус IWM 200 -> 201 (+0,5%) = +4,5%
  assert.equal(t.e[5].close, 0.072); assert.equal(t.e[30].open, 0.045);
  assert.equal(t.cur, 0.0256, 'текущая схема: 10,5 -> 10,8 (+2,86%) минус IWM 201 -> 201,6 (+0,30%)');
  assert.equal(t.est, 0);
  assert.equal(paperTrade({ ...qs, 15: null }, bs, { o: 10.5, c: 10.8 }, { o: 201, c: 201.6 }), null, 'нет котировки на 15 минут — события нет в общем наборе');
  assert.equal(paperTrade(qs, bs, { o: 10.5, c: 10.8 }, null), null);
  const sm = summarizePaper([
    { day: 'a', cur: 0.01, e: { 5: { close: 0.02, open: 0.01 }, 15: { close: 0.02, open: 0.01 }, 30: { close: 0.02, open: 0.01 } }, cost: 0.001 },
    { day: 'b', cur: -0.01, e: { 5: { close: 0.04, open: 0.03 }, 15: { close: 0.04, open: 0.03 }, 30: { close: 0.04, open: 0.03 } }, cost: 0.002 },
  ]);
  assert.equal(sm.n, 2); assert.equal(sm.days, 2);
  assert.equal(sm.cur.mean, -0.0015, 'текущая: после издержек своего уровня каждой сделки: (0,009 − 0,012) / 2'); assert.equal(sm.cur.gross, 0);
  assert.equal(sm.e[5].close.gross, 0.03); assert.equal(sm.e[5].close.mean, 0.0292, 'вечерняя: общие издержки на круг ' + EVENING.cost);
  assert.equal(sm.e[5].close.win, 1); assert.equal(sm.e[5].open.cumNet, 0.0384);
  assert.deepEqual(summarizePaper([]), { n: 0, days: 0 });
});
ok('вечерняя схема: журнал и план котировок — по сроку, без повторов, перезапуск ничего не дублирует', () => {
  const j = parseJournal([
    JSON.stringify({ k: 'event', id: 'A', t: 'TST', at: '2026-10-01T17:00:00', found: '2026-10-01T21:01:00Z' }),
    JSON.stringify({ k: 'q', id: 'A', m: 0, sym: 'TST', got: 'x' }),
    JSON.stringify({ k: 'q', id: 'A', m: 0, sym: 'IWM', got: 'x' }),
    '{"k":"q","id":"A","m":5,"sy',                                       // оборванная запись
    '', JSON.stringify({ k: 'run' }),
  ].join('\n'));
  assert.equal(j.events.size, 1); assert.equal(j.quotes.size, 2);
  const ev = [...j.events.values()];
  const now = Date.parse('2026-10-01T21:16:00Z');                         // 17:16 ET: приём 17:00 -> сроки +5 и +15 наступили, +30 — нет
  const have = new Set(['A|0']);
  assert.deepEqual(planQuotes(ev, have, now).map(x => x.m), [5, 15]);
  assert.deepEqual(planQuotes(ev, new Set(['A|0', 'A|5']), now).map(x => x.m), [15]);
  assert.deepEqual(planQuotes(ev, new Set(['A|0', 'A|5', 'A|15']), now), []);
  assert.deepEqual(planQuotes(ev, new Set(), Date.parse('2026-10-01T21:00:30Z')), [], 'до обнаружения и до сроков — ничего');
  // лучшая котировка: честная книга важнее, затем источник nasdaq
  const best = pickQuote([{ src: 'worker', got: '2', last: 1 }, { src: 'worker', got: '1', bid: 10, ask: 10.01 }, { src: 'nasdaq', got: '3', bid: 5, ask: 9 }]);
  assert.equal(best.ask, 10.01, 'у worker честная книга, у nasdaq разрыв шире 1%');
  assert.equal(pickQuote([]), null);
});
ok('вечерняя схема: сборка — только события со списком, закрытым D+1 и полным набором котировок', () => {
  const qj = [];
  const add = (id, sym, ms, q) => ms.forEach(m => qj.push(JSON.stringify({ k: 'q', id, m, sym, got: 'x', late: 3, ...q })));
  const evs = ['A', 'B', 'C', 'D', 'E'].map((id, i) => JSON.stringify({ k: 'event', id, acc: id, t: 'T' + id, fdate: '2026-11-0' + (i < 4 ? 2 : 3), at: `2026-11-0${i < 4 ? 2 : 3}T17:0${i}`, val: 5e4 }));
  evs.push(JSON.stringify({ k: 'event', id: 'A2', acc: 'A2', t: 'TA', fdate: '2026-11-02', at: '2026-11-02T17:30', val: 7e4 }));   // вторая форма той же бумаги в тот же день
  const good = { bid: 10, ask: 10.01 }, bench = { bid: 200, ask: 200.1 };
  for (const id of ['A', 'B', 'D', 'E']) { add(id, 'T' + id, [5, 15, 30], good); add(id, 'IWM', [5, 15, 30], bench); }
  add('C', 'TC', [5, 15], good); add('C', 'IWM', [5, 15, 30], bench);       // у C нет котировки на 30 минут
  const journal = parseJournal([...evs, ...qj].join('\n'));
  const rows = { 'TA': { main: true, cost: 0.001 }, 'TB': { main: false, cost: 0.0015 }, 'TC': { main: true, cost: 0.001 }, 'TE': { main: true, cost: 0.001 } };   // у D строки в списке нет
  const out = buildPaper(journal, {
    minPx: 5,
    rowOf: (fd, t) => rows[t] ?? null,
    d1Of: (fd, t) => (t === 'TE' ? null : { day: '2026-11-04', o: 10.2, c: 10.5, pc: 10.1, io: 201, ic: 201.6 }),    // у E D+1 ещё не закрыт
  });
  assert.equal(out.cov.events, 6); assert.equal(out.cov.dup, 1, 'вторая форма A в тот же день не даёт второй сделки'); assert.equal(out.cov.listed, 4); assert.equal(out.cov.closed, 3); assert.equal(out.cov.complete, 2);
  assert.equal(out.main.n, 1, 'основной список: только A'); assert.equal(out.all.n, 2, 'все: A и B; C без котировки на 30 минут не входит');
  assert.equal(out.from, '2026-11-02'); assert.deepEqual(out.late, { p50: 3, p90: 3 });
  assert.equal(buildPaper(parseJournal(''), { rowOf: () => null, d1Of: () => null }), null, 'нет журнала — нет блока');
});

// ---------- сквозной прогон compute ----------
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
// Бенчмарки плоские -> excess == сырой доходности, проверка арифметики становится точной
for (const b of ['SPY', 'IWM']) writePriceCache(TMP, b, bizDays('2015-01-01', today).map(d => [d, 100, 100, 1e6]));
// ALFA: +0.1%/торговый день с 2019-06 по 2021-06, затем делистинг.
// Цены сделок в фикстуре берутся ИЗ ряда: иначе гейт дисконта справедливо отсеет их как
// размещение (ровно та ошибка, которую v2 и должна ловить).
const alfaSeries = bizDays('2019-06-03', '2021-06-30').map((d, i) => {
  const p = Math.round(100 * 1.001 ** i * 10000) / 10000;
  return [d, p, p, 2e5];   // $20 млн/день -> small
});
writePriceCache(TMP, 'ALFA', alfaSeries);
// LIVA: живой тикер
const livaSeries = bizDays('2024-01-02', today).map((d, i) => {
  const p = Math.round(50 * 1.0005 ** i * 10000) / 10000;
  return [d, p, p, 1e6];
});
writePriceCache(TMP, 'LIVA', livaSeries);
const priceAt = (arr, iso) => {
  let last = arr[0][1];
  for (const r of arr) { if (r[0] > iso) break; last = r[1]; }
  return Math.round(last * 100) / 100;
};
const alfaAt = iso => priceAt(alfaSeries, iso);
const livaAt = iso => priceAt(livaSeries, iso);
writeJson(join(TMP, 'reference', 'tickers.json'), {
  111: { ticker: 'ALFA', exchange: 'NYSE', name: 'Alpha Corp' },
  222: { ticker: 'LIVA', exchange: 'Nasdaq', name: 'Liva Inc' },
  333: { ticker: 'OTCX', exchange: 'OTC', name: 'Otc Shell' },
});

const ceo = [{ cik: 900, name: 'Ivanov Ivan', rel: 'DOC', title: 'CEO' }];
const dir = [{ cik: 901, name: 'Petrov Petr', rel: 'D', title: '' }];
const fundJoint = [
  { cik: 950, name: 'Baker Bros Advisors LP', rel: 'T', title: '' },
  { cik: 951, name: 'Baker Julian', rel: 'T', title: '' },
  { cik: 952, name: 'Baker Felix', rel: 'T', title: '' },
];
const T = (o) => ({ form: '4', di: 'D', b5: 0, fn: {}, ...o });
writeJsonGz(join(TMP, 'trades', '2020.json.gz'), {
  v: SHARD_VERSION,
  trades: [
    // Настоящий кластер: два независимых физлица в пределах 14 дней, цена = рынку
    T({ acc: 'A1', fdate: '2020-02-05', tdate: '2020-02-03', cik: 111, t: 'ALFA', owners: ceo, code: 'P', sh: 1000, px: alfaAt('2020-02-03'), val: 100000, own: 5000 }),
    T({ acc: 'A2', fdate: '2020-02-13', tdate: '2020-02-11', cik: 111, t: 'ALFA', owners: dir, code: 'P', sh: 2000, px: alfaAt('2020-02-11'), val: 202000, own: 2000 }),
    // PIPE: совместная подача фонда, его GP и двух партнёров + сноска о размещении
    T({ acc: 'A3', fdate: '2020-03-05', tdate: '2020-03-03', cik: 111, t: 'ALFA', owners: fundJoint, code: 'P', sh: 100000, px: alfaAt('2020-03-03') * 0.85, val: 9000000, own: 100000, fn: { offering: 1 } }),
    // OTC — вне вселенной
    T({ acc: 'A4', fdate: '2020-03-05', tdate: '2020-03-03', cik: 333, t: 'OTCX', owners: dir, code: 'P', sh: 100, px: 1, val: 100, own: 100 }),
    // Плановая покупка по сноске (чекбокса в 2020 ещё не существовало)
    T({ acc: 'A5', fdate: '2020-04-07', tdate: '2020-04-03', cik: 111, t: 'ALFA', owners: ceo, code: 'P', sh: 100, px: alfaAt('2020-04-03'), val: 11000, own: 5100, fn: { b5: 1 } }),
  ],
  amend: [],
});
const recentF = addDaysIso(today, -6), recentT = addDaysIso(today, -7);
writeJsonGz(join(TMP, 'trades', 'live.json.gz'), {
  v: SHARD_VERSION,
  trades: [
    T({ acc: 'L1', fdate: recentF, tdate: recentT, cik: 222, t: 'LIVA', owners: ceo, code: 'P', sh: 5000, px: livaAt(recentT), val: 275000, own: 15000, at: `${recentF}T17:21` }),
    // Поправка к A2: замещает оригинал по содержательному ключу
    T({ acc: 'A2R', form: '4/A', fdate: '2020-02-25', tdate: '2020-02-11', cik: 111, t: 'ALFA', owners: dir, code: 'P', sh: 2000, px: alfaAt('2020-02-11') + 0.5, val: 203000, own: 2000, orig: '2020-02-13' }),
  ],
  amend: [],
});

ok('loadAllTrades: дедуп и приоритет 4/A', () => {
  const { trades, stats } = loadAllTrades(TMP);
  const a2 = trades.filter(r => r.cik === 111 && r.tdate === '2020-02-11');
  assert.equal(a2.length, 1);
  assert.equal(a2[0].form, '4/A');
  assert.equal(a2[0].px, alfaAt('2020-02-11') + 0.5);
  assert.equal(stats.replacedByAmendment, 1);
});
ok('loadAllTrades: поправка числа акций замещает оригинал, а не удваивает', () => {
  // Регрессия: количество акций входило в ключ, поэтому 4/A, правящая именно его,
  // не находила оригинал — и битая строка оставалась в выборке вторым экземпляром
  const dir2 = join(TMP, '..', '.selftest-tmp2');
  rmSync(dir2, { recursive: true, force: true });
  writeJsonGz(join(dir2, 'trades', '2021.json.gz'), {
    v: SHARD_VERSION,
    trades: [
      T({ acc: 'B1', form: '4', fdate: '2021-03-10', tdate: '2021-03-08', cik: 55, t: 'ZZZ', owners: dir, code: 'P', sh: 643850, px: 402, val: 258827700000, own: 700000 }),
      T({ acc: 'B2', form: '4/A', fdate: '2021-03-20', tdate: '2021-03-08', cik: 55, t: 'ZZZ', owners: dir, code: 'P', sh: 685000, px: 1.51, val: 1034350, own: 700000, orig: '2021-03-10' }),
    ],
    amend: [],
  });
  const { trades } = loadAllTrades(dir2);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].form, '4/A');
  assert.equal(trades[0].val, 1034350);
  rmSync(dir2, { recursive: true, force: true });
});
ok('loadAllTrades: разные классы акций в одной подаче не затирают друг друга', () => {
  // Регрессия: ключ без класса бумаги схлопывал Class A и Class C в одну строку
  const dir3 = join(TMP, '..', '.selftest-tmp3');
  rmSync(dir3, { recursive: true, force: true });
  writeJsonGz(join(dir3, 'trades', '2025.json.gz'), {
    v: SHARD_VERSION,
    trades: [
      T({ acc: 'C1', fdate: '2025-12-31', tdate: '2025-12-30', cik: 77, t: 'MC', owners: dir, code: 'P', sh: 1000, px: 10, val: 10000, own: 5000, sec: 'Class A Common Shares' }),
      T({ acc: 'C1', fdate: '2025-12-31', tdate: '2025-12-30', cik: 77, t: 'MC', owners: dir, code: 'P', sh: 2000, px: 9, val: 18000, own: 7000, sec: 'Class C Common Shares' }),
    ],
    amend: [],
  });
  const { trades } = loadAllTrades(dir3);
  assert.equal(trades.length, 2);
  rmSync(dir3, { recursive: true, force: true });
});

// Открытия утреннего списка: день входа L1 — первый рабочий день после подачи. IWM: открытие 100,
// закрытие 100.5 (+0.5%); LIVA: открытие 50, закрытие 51 (+2%), значит к IWM +1.5%.
const d1L = bizDays(addDaysIso(recentF, 1), addDaysIso(recentF, 7))[0];
// Журнал вечерней схемы (ветка paper): событие по форме L1 и котировки через 5/15/30 минут — по LIVA и IWM
{
  const q = (m, sym, extra) => JSON.stringify({ k: 'q', id: 'L1', m, sym, got: '2026-01-01T00:00:00Z', late: 4, src: 'worker', ...extra });
  const lines = [JSON.stringify({ k: 'event', id: 'L1', acc: 'L1', t: 'LIVA', cik: 222, fdate: recentF, at: `${recentF}T17:21`, val: 275000, n: 1, found: '2026-01-01T00:00:00Z' })];
  for (const m of [5, 15, 30]) { lines.push(q(m, 'LIVA', { bid: 48.9, ask: 49, last: 48.95 })); lines.push(q(m, 'IWM', { bid: 98.95, ask: 99.05, last: 99 })); }
  mkdirSync(join(TMP, 'paper', 'log'), { recursive: true });
  writeFileSync(join(TMP, 'paper', 'log', '2026-01-01.jsonl'), lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
}
writeOpens(TMP, { t: { IWM: { [d1L]: [100, 100.5, 99.8] }, SPY: { [d1L]: [400, 404, 399] }, LIVA: { [d1L]: [50, 51, 49.5] } } }, today);
execFileSync(process.execPath, [join(ROOT, 'scripts', 'compute.mjs'), '--data', TMP, '--site', join(TMP, 'site'), '--counter-from', addDaysIso(today, -30)], { stdio: 'pipe' });
const R = p => readJson(join(TMP, 'site', 'data', p));

ok('compute: гейты отсекают PIPE и плановую покупку', () => {
  const meta = R('meta.json');
  assert.equal(meta.trades.buys, 5);              // A1, A2R, A3(PIPE), A5(план), L1; OTC вне вселенной
  assert.equal(meta.gates.ok, 3);                 // PIPE и плановая отсеяны
  assert.equal(meta.gates.drops.offering, 1);
  assert.equal(meta.gates.drops.planned, 1);
  const bt = R('backtest/2020.json');
  assert.equal(bt.find(r => r.fdate === '2020-03-05').gate, 'offering');
  assert.equal(bt.find(r => r.fdate === '2020-04-07').gate, 'planned');
});
ok('compute: форварды точны и учитывают делистинг', () => {
  const bt = R('backtest/2020.json');
  const b = bt.find(r => r.fdate === '2020-02-05');
  const expected = Math.round((1.001 ** 63 - 1) * 10000) / 10000;
  assert.equal(b.s3, 'c');
  assert.ok(Math.abs(b.e3 - expected) < 0.002, `e3=${b.e3}, ожидалось ~${expected}`);
  assert.ok(Math.abs(b.x3 - expected) < 0.002, 'excess vs SPY должен совпасть при плоском бенчмарке');
  assert.equal(b.s24, 'd');                       // ряд оборван в 2021 — делистинг
  assert.equal(b.bucket, 'small');                // $20 млн/день
});
ok('compute: лента, признак набора, карточка тикера', () => {
  const feed = R('feed.json');
  assert.equal(feed.length, 1);
  assert.equal(feed[0].t, 'LIVA');
  assert.equal(feed[0].role, 'C');
  assert.ok(feed[0].cur > 0);
  assert.ok(feed[0].d1 !== null);                 // короткая perf-колонка заполнена
  assert.equal(feed[0].m6, null);                 // шестимесячное окно ещё не дозрело
  assert.ok(feed[0].set === 0 || feed[0].set === 1, 'признак рабочего набора проставлен');
  const meta = R('meta.json');
  assert.ok(meta.set, 'в мете есть счётчики рабочего набора');
  const tick = R('tickers/ALFA.json');
  assert.equal(tick.trades.length, 4);
  assert.equal(tick.okBuys, 2);
  assert.ok(tick.weekly.length > 50);
});

ok('compute: вечерняя схема на бумаге — события журнала дают сделки по общему набору', () => {
  const pp = R('morning.json').paper;
  assert.ok(pp, 'блок paper в morning.json');
  assert.equal(pp.from, recentF); assert.equal(pp.cov.events, 1); assert.equal(pp.cov.listed, 1); assert.equal(pp.cov.complete, 1);
  assert.equal(pp.main.n, 1); assert.equal(pp.all.n, 1);
  // покупка по ask 49 -> закрытие D+1 51 (+4,08%) минус IWM от середины 99 до закрытия 100,5 (+1,52%) = +2,57% до издержек
  assert.ok(Math.abs(pp.main.e[5].close.gross - 0.0257) < 0.0002, 'e5 close gross=' + pp.main.e[5].close.gross);
  assert.ok(Math.abs(pp.main.e[30].open.gross - ((50 / 49 - 1) - (100 / 99 - 1))) < 0.0002, 'открытие D+1: ' + pp.main.e[30].open.gross);
  assert.equal(pp.main.cur.gross, 0.015, 'текущая схема на тех же событиях: +2% минус IWM +0,5%');
  assert.equal(pp.cov.estShare, 0, 'у всех моментов честный bid/ask');
  assert.equal(pp.cost, EVENING.cost);
});
ok('compute: утренний список, счётчик D+1 и всплеск', () => {
  const m = R('morning.json');
  const day = m.days.find(d => d.date === recentF);
  assert.ok(day, 'день подачи L1 есть в файле');
  assert.equal(day.entry, d1L); assert.equal(day.done, true);
  assert.equal(day.rows.length, 1);
  const row = day.rows[0];
  assert.equal(row.t, 'LIVA'); assert.equal(row.val, 275000);
  assert.equal(row.score, 2, 'сумма от $100 тыс. + офицер'); assert.equal(row.main, true); assert.equal(row.cost, 0.001);
  assert.equal(row.role, 'C'); assert.ok(row.tags.includes('off'));
  assert.equal(row.at, `${recentF}T17:21`); assert.equal(row.ses, 'post', 'время приёма доходит до строки списка');
  assert.equal(m.params.stake, 10000, 'ставка для «суммы нетто» приходит из сборки');
  assert.equal(row.o, 50); assert.equal(row.c, 51);
  assert.equal(row.ex, 0.015, 'сделка +2% минус IWM +0.5%');
  assert.equal(row.exS, 0.01, 'сделка +2% минус SPY +1%');
  assert.equal(m.counter.main.n, 1); assert.equal(m.counter.main.iwm.mean, 0.015); assert.equal(m.counter.main.spy.mean, 0.01);
  assert.equal(m.counter.main.iwm.net, 0.014, 'нетто: 1,5% минус 0,10% на круг'); assert.equal(m.counter.upTo, d1L);
  assert.equal(m.counter.all.n, 1); assert.deepEqual(m.counter.costs, { hi: 0.001, lo: 0.0015, split: 3e7 });
  assert.equal(m.params.dvMin, 1e7); assert.equal(m.params.scoreMin, 2);
  const old = m.days.find(d => d.date === '2020-02-05');
  assert.ok(old && !old.done && old.entry === null, 'у старых подач дня входа в хранилище нет — результат не выдумывается');
  const b = R('stats.json').breadth;
  assert.ok(b && b.history.length <= 60 && b.thr === 2, 'поле breadth в stats.json');
  assert.ok(b.asOf < isoToday().slice(0, 7), 'текущим считается последний ЗАВЕРШЁННЫЙ месяц');
});

// ---------- уведомления ----------
// Единица письма — ДАТА ПОДАЧИ: одно утреннее сообщение на дату, и только если главный список
// (оборот от $30 млн в день) не пуст. Проверяем сквозным прогоном скрипта на синтетическом
// morning.json. Даты строятся от сегодня: «вчера» всегда свежее (следующий рабочий день не раньше
// сегодняшнего), а несколько дат сразу проверяются с --any-date, чтобы не зависеть от дня недели.
const NTMP = join(ROOT, '.selftest-notify');
rmSync(NTMP, { recursive: true, force: true });
mkdirSync(join(NTMP, 'site', 'data'), { recursive: true });
mkdirSync(join(NTMP, 'data', 'state'), { recursive: true });

const nDay = n => addDaysIso(isoToday(), n);
const mRow = (t, val, extra = {}) => ({
  t, name: t + ' HOLDINGS INC', who: ['Smith John'], nWho: 1, role: 'D', val, n: 1, dd: -0.05, dv: 6e7, px: 25, score: 3, main: true, cost: 0.001, tags: [], ...extra,
});
const mDay = (date, rows) => ({ date, entry: null, done: false, rows });
const nYear = isoToday().slice(0, 4);
const mCounter = { from: `${nYear}-11-05`, costs: { hi: 0.001, lo: 0.0015, split: 3e7 }, upTo: null, main: { n: 0 }, all: { n: 0 } };
const REST = { main: false, score: 1 };                           // не в основном списке: скор 0–1
const MORNING_JSON = join(NTMP, 'site', 'data', 'morning.json');
function writeMorning(days, counter = mCounter, extra = {}) {
  writeJson(MORNING_JSON, { built: isoToday(), params: { minVal: 1e4, minPx: 5, dvMin: 1e7, dvCost: 3e7, scoreMin: 2 }, counter, days, ...extra });
}
const NOTIFY_ARGS = dir => [join(ROOT, 'scripts', 'notify.mjs'), '--site', join(NTMP, 'site'), '--data', dir];
function notify(days, { dir = join(NTMP, 'data'), counter = mCounter, args = [], extra = {} } = {}) {
  writeMorning(days, counter, extra);
  mkdirSync(join(dir, 'state'), { recursive: true });
  return execFileSync(process.execPath, [...NOTIFY_ARGS(dir), '--dry-run', ...args], { encoding: 'utf8' });
}
const freshDir = name => { const d = join(NTMP, name); mkdirSync(join(d, 'state'), { recursive: true }); return d; };
const sentOf = dir => readJson(join(dir, 'state', 'notify.json'), {}).sentMorning ?? [];
const NB = '\u00a0';

ok('notify: первый прогон молча пересевает состояние', () => {
  const out = notify([mDay(nDay(-2), [mRow('AAA', 3e5)])]);
  assert.match(out, /состояние пересеяно/);
  assert.ok(!out.includes('утренний список'), 'при пересеве письма не шлются');
});
ok('notify: переход со схемы 3 (позиции) — пересев, старые ключи уходят', () => {
  const dir = freshDir('data-v3');
  writeJson(join(dir, 'state', 'notify.json'), { version: 3, sentPositions: ['OLD|2026-10-01'] });
  const out = notify([mDay(nDay(-1), [mRow('AAA', 3e5)])], { dir });
  assert.match(out, /первый прогон схемы v4/);
  const st = readJson(join(dir, 'state', 'notify.json'));
  assert.equal(st.version, 4); assert.equal(st.sentPositions, undefined);
  assert.deepEqual(st.sentMorning, [`morning|${nDay(-1)}`], 'текущий список считается отправленным: историю не рассылаем');
});
ok('notify: новая дата подачи даёт одно письмо — топ по сумме, пометки, правило, счётчик', () => {
  const counter = { ...mCounter, main: { n: 23, days: 5, iwm: { mean: 0.0031, win: 0.58 }, spy: { mean: 0.0018 } } };
  const day = mDay(nDay(-1), [
    mRow('CCC', 2.5e6, { tags: ['off', 'deep', 'big'], role: 'C', score: 4 }),
    mRow('BBB', 4e5, { tags: ['off'], role: 'O', score: 2 }),
    mRow('DDD', 5e4, { score: 2, tags: ['deep'] }),
    mRow('EEE', 3e4, REST),
  ]);
  notify([mDay(nDay(-2), [mRow('AAA', 3e5)])]);                       // пересев
  const out = notify([mDay(nDay(-2), [mRow('AAA', 3e5)]), day], { counter });
  assert.match(out, /новых утренних списков: 1/);
  assert.equal((out.match(/Инсайдерский радар · утренний список/g) ?? []).length, 1);
  assert.match(out, new RegExp(`Подачи за \\d\\d\\.\\d\\d · 3 бумаги: оборот от \\$10${NB}млн, скор от 2`));
  assert.match(out, new RegExp(`CCC · .* · скор 4 · \\$2,5${NB}млн · офицер, просадка глубже 30%, ≥\\$1${NB}млн`));
  assert.match(out, new RegExp(`BBB · .* · скор 2 · \\$400${NB}тыс\\. · офицер\\n`));
  assert.match(out, new RegExp(`DDD · .* · скор 2 · \\$50${NB}тыс\\. · просадка глубже 30%\\n`));
  assert.ok(!/EEE/.test(out), 'бумаги со скором 0–1 в письмо построчно не идут');
  assert.match(out, /Ещё 1 бумага со скором 0–1 — на панели\./);
  assert.match(out, /Только заявки на аукционы: MOO до 9:28 и MOC до 15:50 по Нью-Йорку\. Около 60% перевеса дня — первые 5 минут: покупка по рынку после открытия его съедает\./);
  assert.match(out, /Счётчик с 05\.11: 23 сделки, среднее \+0,31% к IWM, \+0,18% к S&P, в плюсе 58%\./);
  assert.ok(out.indexOf('CCC ·') < out.indexOf('BBB ·') && out.indexOf('BBB ·') < out.indexOf('DDD ·'), 'порядок — как в списке (скор, затем сумма)');
});
ok('notify: пустой счётчик и повторный прогон', () => {
  const dir = freshDir('data-twice');
  notify([mDay(nDay(-3), [mRow('OLD', 3e5)])], { dir });             // пересев
  const days = [mDay(nDay(-1), [mRow('AAA', 3e5)])];
  const out = notify(days, { dir });
  assert.match(out, /Счётчик с 05\.11: сделок пока нет\./);
  assert.deepEqual(sentOf(dir).filter(k => k === `morning|${nDay(-1)}`).length, 1);
  assert.match(notify(days, { dir }), /новых утренних списков нет/, 'вторая отправка той же даты невозможна');
});
ok('notify: устаревший день письма не даёт, --any-date снимает проверку свежести', () => {
  const dir = freshDir('data-rules');
  notify([mDay(nDay(-3), [mRow('OLD', 3e5)])], { dir });             // пересев
  // подача шестидневной давности: её торги D+1 давно прошли
  const stale = [mDay(nDay(-6), [mRow('OLDD', 3e5)])];
  assert.match(notify(stale, { dir }), /новых утренних списков нет/);
  assert.match(notify(stale, { dir, args: ['--any-date'] }), /OLDD · /);
});
ok('notify: в письме не больше десяти строк, остальное — «и ещё N», длина в пределе Telegram', () => {
  const dir = freshDir('data-top10');
  notify([mDay(nDay(-3), [mRow('OLD', 3e5)])], { dir });
  const rows = Array.from({ length: 13 }, (_, i) => mRow('Q' + String(i).padStart(2, '0'), 9e5 - i * 1e4, { name: 'VERY LONG COMPANY NAME NUMBER ' + i + ' HOLDINGS CORPORATION', tags: ['off', 'deep', 'big'] }));
  const out = notify([mDay(nDay(-1), rows)], { dir });
  assert.equal((out.match(/^Q\d\d · /gm) ?? []).length, 10);
  assert.match(out, /и ещё 3 — на панели/);
  assert.match(out, /Подачи за \d\d\.\d\d · 13 бумаг/);
  assert.ok(out.length < 4096);
});
ok('notify: --preview печатает образец с оговоркой и не двигает состояние', () => {
  const dir = freshDir('data-preview');
  writeMorning([mDay(nDay(-1), [mRow('AAA', 3e5)])]);
  const out = execFileSync(process.execPath, [...NOTIFY_ARGS(dir), '--dry-run', '--preview'], { encoding: 'utf8' });
  assert.match(out, /AAA · /); assert.match(out, /Это образец формата, а не новый список/);
  assert.equal(readJson(join(dir, 'state', 'notify.json'), null), null, 'состояние не создано');
});

// ---------- доставка: сбой Telegram не теряет письмо (аудит 28.10.2026, C1) ----------
// Боевой прогон скрипта против подставного Telegram: preload-модуль переадресует
// api.telegram.org на локальный сервер, так что проверяется настоящий код отправки без
// единой правки под тест. До 29.10.2026 запись шла отправленной ДО запроса —
// эти проверки на прежнем коде падают.
async function okAsync(name, fn) {
  try { await fn(); passed++; }
  catch (e) { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}
const TG_OK = { status: 200, body: { ok: true, result: { message_id: 1 } } };
const TG_429 = s => ({ status: 429, body: { ok: false, error_code: 429, description: `Too Many Requests: retry after ${s}`, parameters: { retry_after: s } } });
// script — ответы Telegram по порядку запросов ('drop' — оборвать соединение); дальше — 200.
function fakeApis(script) {
  const calls = { tg: [], nexus: [] };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      if (req.url.startsWith('/bot')) {
        const step = script[calls.tg.length] ?? TG_OK;
        calls.tg.push({ at: Date.now(), body });
        if (step === 'drop') { req.socket.destroy(); return; }
        res.writeHead(step.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(step.body));
      } else if (req.url === '/nexus') {
        calls.nexus.push(body);
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end('{"accepted":true}');
      } else { res.writeHead(404); res.end(); }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    calls, base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(r => server.close(r)),
  })));
}
const REDIRECT = join(NTMP, 'tg-redirect.mjs');
writeFileSync(REDIRECT, [
  'const base = process.env.FAKE_TG_BASE;',
  'const real = globalThis.fetch;',
  "globalThis.fetch = (url, init) => real(String(url).replace('https://api.telegram.org', base), init);",
].join('\n'));
function liveNotify(dir, base, extra = []) {
  return new Promise(resolve => execFile(process.execPath,
    ['--import', pathToFileURL(REDIRECT).href, ...NOTIFY_ARGS(dir), ...extra],
    { encoding: 'utf8', env: { ...process.env, FAKE_TG_BASE: base, TELEGRAM_BOT_TOKEN: 'TEST', TELEGRAM_CHAT_ID: '1',
      NEXUS_EVENTS_URL: base + '/nexus', NEXUS_INGEST_TOKEN: 'TEST' } },
    (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: stdout + stderr })));
}
// Состояние с уже пересеянной схемой: в нём один старый список.
function seededDir(name) {
  const dir = freshDir(name);
  notify([mDay(nDay(-9), [mRow('OLD', 3e5)])], { dir });
  return dir;
}
const lineOf = (call, k) => call.body.text.split('\n')[k];

await okAsync('notify: сбой Telegram не помечает письмо отправленным, следующий прогон досылает его одно', async () => {
  const dir = seededDir('data-fail');
  const dA = nDay(-2), dB = nDay(-1);
  writeMorning([mDay(dB, [mRow('BBB', 4e5)]), mDay(dA, [mRow('AAA', 3e5)])]);   // файл — от свежего дня к старому
  const api = await fakeApis([TG_OK, { status: 500, body: { ok: false, error_code: 500, description: 'Internal Server Error' } }]);
  try {
    const r1 = await liveNotify(dir, api.base, ['--any-date']);
    assert.ok(!sentOf(dir).includes(`morning|${dB}`), 'недоставленное письмо не должно числиться отправленным');
    assert.ok(sentOf(dir).includes(`morning|${dA}`), 'доставленное запомнено');
    assert.notEqual(r1.code, 0, 'недоставка обязана давать ненулевой код выхода');
    assert.equal(api.calls.tg.length, 2);
    assert.equal(lineOf(api.calls.tg[0], 0), '🔔 <b>Инсайдерский радар · утренний список</b>');
    assert.match(r1.out, /НЕ доставлено: 1 из 2/);
    // Зеркало в NEXUS — с ключом даты: досылка на следующий день ляжет на ту же запись хаба.
    assert.deepEqual(api.calls.nexus.map(b => b.eventId), [`840|morning|${dA}`, `840|morning|${dB}`]);

    const r2 = await liveNotify(dir, api.base, ['--any-date']);
    assert.equal(r2.code, 0, r2.out);
    assert.equal(api.calls.tg.length, 3, 'досылается ровно одно сообщение — недоставленное');
    assert.match(api.calls.tg[2].body.text, /<b>BBB<\/b> · /);
    assert.equal(api.calls.nexus.at(-1).eventId, `840|morning|${dB}`);
    assert.ok(sentOf(dir).includes(`morning|${dB}`));

    const r3 = await liveNotify(dir, api.base, ['--any-date']);
    assert.equal(r3.code, 0);
    assert.equal(api.calls.tg.length, 3, 'после доставки повторов нет');
    assert.match(r3.out, /новых утренних списков нет/);
  } finally { await api.close(); }
});
await okAsync('notify: обрыв соединения не роняет скрипт необработанной ошибкой и не теряет письмо', async () => {
  const dir = seededDir('data-drop');
  const d = nDay(-1);
  writeMorning([mDay(d, [mRow('CCC', 3e5)])]);
  const api = await fakeApis(['drop']);
  try {
    const r1 = await liveNotify(dir, api.base);
    assert.ok(!sentOf(dir).includes(`morning|${d}`), 'список не должен числиться отправленным');
    assert.notEqual(r1.code, 0);
    assert.match(r1.out, /Telegram не принял сообщение — сеть/);
    const r2 = await liveNotify(dir, api.base);
    assert.equal(r2.code, 0, r2.out);
    assert.equal(api.calls.tg.length, 2);
    assert.ok(sentOf(dir).includes(`morning|${d}`));
  } finally { await api.close(); }
});
await okAsync('notify: 429 — один повтор через retry_after, без потери и без дубля', async () => {
  const dir = seededDir('data-429');
  const d = nDay(-1);
  writeMorning([mDay(d, [mRow('DDD', 3e5)])]);
  const api = await fakeApis([TG_429(1)]);
  try {
    const r = await liveNotify(dir, api.base);
    assert.equal(r.code, 0, r.out);
    assert.equal(api.calls.tg.length, 2, 'ровно один повтор');
    assert.ok(api.calls.tg[1].at - api.calls.tg[0].at >= 950, 'повтор не раньше retry_after');
    assert.ok(sentOf(dir).includes(`morning|${d}`));
  } finally { await api.close(); }
});
await okAsync('notify: повторный 429 и запрет длиннее минуты — без ожидания, письмо ждёт следующего прогона', async () => {
  const dir = seededDir('data-429x');
  const dA = nDay(-2), dB = nDay(-1);
  writeMorning([mDay(dB, [mRow('FFF', 3e5)]), mDay(dA, [mRow('EEE', 3e5)])]);
  const api = await fakeApis([TG_429(1), TG_429(1), TG_429(3600)]);
  try {
    const t0 = Date.now();
    const r = await liveNotify(dir, api.base, ['--any-date']);
    assert.notEqual(r.code, 0);
    assert.equal(api.calls.tg.length, 3, 'первое письмо: запрос и один повтор; второе: запрос без повтора');
    assert.ok(Date.now() - t0 < 30000, 'час ожидания не берётся');
    assert.ok(!sentOf(dir).includes(`morning|${dA}`) && !sentOf(dir).includes(`morning|${dB}`));
  } finally { await api.close(); }
});
// ---------- единый стиль сообщений (стандарт 29.10.2026, TELEGRAM-STYLE-2026-10-29.md) ----------
// Пометка панели первым словом заголовка, одна эмодзи, подвал «ссылка · время МСК», русские числа
// (запятая, «−», «$» перед числом, процент слитно), ни ISO-дат, ни сырых float. В ленту NEXUS уходит
// тот же текст без разметки — он читается так же.
const SITE = 'https://ml371kl.github.io/temp-zero-inode-840/';
function styleFaults(html) {
  const bad = [];
  const lines = html.split('\n');
  if (!/^(🔔|ℹ️) <b>Инсайдерский радар · [^<\n]+<\/b>$/u.test(lines[0])) bad.push(`заголовок: ${lines[0]}`);
  if (!new RegExp(`^<a href="${SITE.replace(/[.]/g, '\\.')}">Открыть панель</a> · \\d\\d\\.\\d\\d(\\.\\d{4})?, \\d\\d:\\d\\d МСК$`).test(lines.at(-1))) bad.push(`подвал: ${lines.at(-1)}`);
  if (lines.at(-2) !== '') bad.push('перед подвалом нет пустой строки');
  if (html.length > 4096) bad.push(`длиннее 4096: ${html.length}`);
  const plain = html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
  const body = plain.replace(/\b\d\d\.\d\d(\.\d{4})?\b/g, 'ДАТА');
  for (const [re, what] of [
    [/UTC|\d{4}-\d\d-\d\d|\d:\d\dZ/, 'ISO или UTC'], [/\d\.\d/, 'десятичная точка'], [/(^|[\s(~])-\d/m, 'дефис вместо минуса'],
    [/\d[ \u00a0]%/, 'процент через пробел'], [/\d[ \u00a0]?\$/, 'доллар после числа'], [/\d[.,]\d{4,}/, 'сырой float'],
    [/\d \d{3}(?!\d)/, 'разряды обычным пробелом'], [/\d (тыс\.|млн)/, 'обычный пробел перед тыс./млн'], [/(^|\n)\s*·|·\s*($|\n)/, 'висящая «·»'],
    [/\b(янв|фев|мар|апр|мая|июн|июл|авг|сен|окт|ноя|дек)\b/, 'дата словами'],
  ]) if (re.test(body)) bad.push(`${what}: «${(body.match(re) || [''])[0]}»`);
  for (const l of lines.slice(1)) if (/^\p{Extended_Pictographic}/u.test(l)) bad.push(`эмодзи не в заголовке: ${l}`);
  return bad;
}
await okAsync('стиль: утреннее письмо — пометка панели, МСК, русские числа, подвал, зеркало NEXUS', async () => {
  const dir = seededDir('data-style');
  const d = nDay(-1);
  const counter = { ...mCounter, main: { n: 1234, days: 40, iwm: { mean: -0.0012, win: 0.481 }, spy: { mean: 0.0003 } } };
  writeMorning([mDay(d, [
    mRow('BRK', 12.34e6, { role: 'C', tags: ['off', 'big'], name: 'BERKSHIRE HATHAWAY INC' }),
    mRow('PNY', 4.5e4, { name: 'PENNY CORP', dv: 3.1e7 }),
    mRow('LOW', 2e5, { ...REST, dv: 1.2e7 }),
  ])], counter);
  const api = await fakeApis([]);
  try {
    const r = await liveNotify(dir, api.base);
    assert.equal(r.code, 0, r.out);
    assert.equal(api.calls.tg.length, 1);
    const t = api.calls.tg[0].body.text;
    assert.deepEqual(styleFaults(t), [], styleFaults(t).join('; ') + ' :: ' + t);
    assert.match(t, new RegExp(`<b>BRK</b> · Berkshire Hathaway Inc · скор 3 · \\$12${NB}млн · офицер, ≥\\$1${NB}млн`), t);
    assert.match(t, new RegExp(`<b>PNY</b> · Penny Corp · скор 3 · \\$45${NB}тыс\\.\\n`), t);
    assert.match(t, /Счётчик с 05\.11: 1234 сделки, среднее −0,12% к IWM, \+0,03% к S&P, в плюсе 48%\./, t);
    // зеркало NEXUS — тот же текст без разметки, с ключом даты подачи
    assert.equal(api.calls.nexus.length, 1);
    assert.equal(api.calls.nexus[0].eventId, `840|morning|${d}`);
    assert.match(api.calls.nexus[0].text, /^🔔 Инсайдерский радар · утренний список\n/, api.calls.nexus[0].text);
    assert.match(api.calls.nexus[0].text, /\n\nОткрыть панель · \d\d\.\d\d, \d\d:\d\d МСК$/, api.calls.nexus[0].text);
  } finally { await api.close(); }
});
await okAsync('стиль: «can\'t parse entities» — повтор тем же текстом без разметки', async () => {
  const dir = seededDir('data-parse');
  writeMorning([mDay(nDay(-1), [mRow('HHH', 3e5, { name: 'H&M <TEST> INC' })])]);
  const api = await fakeApis([{ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities: unexpected end tag at byte offset 12" } }]);
  try {
    const r = await liveNotify(dir, api.base);
    assert.equal(r.code, 0, r.out);
    assert.equal(api.calls.tg.length, 2);
    assert.equal(api.calls.tg[0].body.parse_mode, 'HTML');
    assert.equal(api.calls.tg[1].body.parse_mode, undefined, 'повтор — без разметки');
    assert.match(api.calls.tg[1].body.text, /^🔔 Инсайдерский радар · утренний список\n/, api.calls.tg[1].body.text);
    assert.ok(api.calls.tg[1].body.text.includes('HHH · H&M <Test> Inc · '), api.calls.tg[1].body.text);
    assert.ok(sentOf(dir).includes(`morning|${nDay(-1)}`));
  } finally { await api.close(); }
});
await okAsync('стиль: проверка связи — пометка панели и подвал', async () => {
  const api = await fakeApis([]);
  try {
    const out = await new Promise(resolve => execFile(process.execPath,
      ['--import', pathToFileURL(REDIRECT).href, join(ROOT, 'scripts', 'notify.mjs'), '--test'],
      { encoding: 'utf8', env: { ...process.env, FAKE_TG_BASE: api.base, TELEGRAM_BOT_TOKEN: 'TEST', TELEGRAM_CHAT_ID: '1', NEXUS_EVENTS_URL: api.base + '/nexus', NEXUS_INGEST_TOKEN: 'TEST' } },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: stdout + stderr })));
    // Windows: Node при process.exit() во время закрытия сетевого дескриптора падает с 0xC0000409
    // уже ПОСЛЕ отправки; на раннере Ubuntu выход нулевой. Само сообщение проверяется ниже.
    if (!(process.platform === 'win32' && out.code === 3221226505)) assert.equal(out.code, 0, out.out);
    const t = api.calls.tg[0].body.text;
    assert.ok(t.startsWith('ℹ️ <b>Инсайдерский радар · Проверка связи</b>\n'), t);
    assert.deepEqual(styleFaults(t), [], t);
  } finally { await api.close(); }
});
await okAsync('цены: ответ Yahoo даёт пары открытие/закрытие из одного ответа, снятые бары в них не попадают', async () => {
  const day = (iso, h = 14, mi = 30) => Math.floor(Date.parse(`${iso}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00Z`) / 1000);
  const days = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
  const body = { chart: { result: [{
    meta: { currency: 'USD', instrumentType: 'EQUITY', gmtoffset: -14400, exchangeName: 'NYQ' },
    timestamp: days.map(d => day(d)),
    indicators: {
      quote: [{ open: [10, 11, null, 12, 12.5], close: [10.5, 11.2, 11.0, 12.4, 12.6], volume: [1e6, 1e6, 1e6, 1e6, 1e6] }],
      adjclose: [{ adjclose: [10.5, 11.2, 11.0, 12.4, 12.6] }],
    },
  }] } };
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
  try {
    const res = await fetchYahooDaily('ZZZ', '2026-10-01');
    assert.deepEqual(res.ohlc, [
      [days[0], 10, 10.5], [days[1], 11, 11.2], [days[2], null, 11], [days[3], 12, 12.4], [days[4], 12.5, 12.6]]);
    assert.equal(res.series.length, 5);
  } finally { globalThis.fetch = real; }
});
await okAsync('воркер котировок: открытие дня идёт в ответе на обоих путях, CORS и формат прежние', async () => {
  const worker = (await import(pathToFileURL(join(ROOT, 'worker', 'index.js')).href)).default;
  const store = new Map();
  const realCaches = globalThis.caches, realFetch = globalThis.fetch;
  globalThis.caches = { default: {
    match: async k => store.has(k) ? store.get(k).clone() : undefined,
    put: async (k, r) => { store.set(k, r); },
  } };
  const SESSION = 1793716200;                       // начало сессии «сегодня»
  const chartBody = (sym, open, barAt) => ({ chart: { result: [{
    meta: { symbol: sym, regularMarketPrice: 10.5, regularMarketTime: SESSION + 3600, marketState: 'REGULAR', chartPreviousClose: 10, currentTradingPeriod: { regular: { start: SESSION } } },
    timestamp: [barAt], indicators: { quote: [{ open: [open] }] },
  }] } });
  let mode = 'quote';
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.startsWith('https://fc.yahoo.com')) return new Response('', { status: 404, headers: { 'set-cookie': 'A3=cookie; Path=/' } });
    if (u.includes('getcrumb')) return new Response('crumb123');
    if (u.includes('/v7/finance/quote')) {
      assert.ok(mode === 'quote', 'v7 не должен вызываться при явном запасном пути');
      return new Response(JSON.stringify({ quoteResponse: { result: [
        { symbol: 'AAA', regularMarketPrice: 10.5, regularMarketOpen: 10, regularMarketTime: SESSION + 3600, marketState: 'REGULAR', regularMarketPreviousClose: 9.9,
          bid: 10.4, ask: 10.6, bidSize: 3, askSize: 0, postMarketPrice: 10.7, postMarketTime: SESSION + 7200, preMarketPrice: 0 },
        { symbol: 'IWM', regularMarketPrice: 200, regularMarketTime: SESSION + 3600, marketState: 'REGULAR', regularMarketPreviousClose: 199 },
      ] } }));
    }
    if (u.includes('/v8/finance/chart/AAA')) return new Response(JSON.stringify(chartBody('AAA', 10, SESSION)));
    if (u.includes('/v8/finance/chart/IWM')) return new Response(JSON.stringify(chartBody('IWM', 199.5, SESSION - 86400)));   // бар вчерашний
    return new Response('?', { status: 500 });
  };
  const ask = async (qs, origin = 'https://ml371kl.github.io') => {
    const pending = [];
    const res = await worker.fetch(new Request('https://radar840-quotes.financehub.workers.dev/quotes?' + qs, { headers: { Origin: origin } }), {}, { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
    return res;
  };
  try {
    const r1 = await ask('symbols=AAA,IWM');
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('access-control-allow-origin'), 'https://ml371kl.github.io');
    const b1 = await r1.json();
    assert.equal(b1.src, 'quote');
    assert.deepEqual(b1.quotes.AAA, { p: 10.5, t: SESSION + 3600, st: 'REGULAR', prev: 9.9, o: 10,
      b: 10.4, a: 10.6, bs: 3, as: null, pp: 10.7, pt: SESSION + 7200, pre: null, prt: null },
      'bid/ask и вечерняя цена идут как пришли; ноль и «нет данных» — null');
    assert.equal(b1.quotes.IWM.b, null); assert.equal(b1.quotes.IWM.pp, null);
    assert.equal(b1.quotes.IWM.o, null, 'открытия в ответе нет — поле null, а не выдумка');
    // кэш края: второй запрос не идёт наверх
    const r1b = await ask('symbols=AAA,IWM');
    assert.equal(r1b.headers.get('x-cache'), 'hit');
    // запасной путь: открытие из бара того же запроса, вчерашний бар открытием не считается
    mode = 'chart';
    const b2 = await (await ask('symbols=AAA,IWM&src=chart')).json();
    assert.equal(b2.src, 'chart');
    assert.equal(b2.quotes.AAA.o, 10);
    assert.equal(b2.quotes.IWM.o, null, 'бар до начала сессии: открытие прошлого дня не отдаётся');
    assert.equal(b2.quotes.AAA.p, 10.5);
  } finally { globalThis.caches = realCaches; globalThis.fetch = realFetch; }
});
await okAsync('воркер: журнал вечерней схемы в R2 — приём по токену, чтение без него, защита от порчи', async () => {
  const worker = (await import(pathToFileURL(join(ROOT, 'worker', 'index.js')).href)).default;
  const objs = new Map();
  const R2 = {
    put: async (k, body, o) => { objs.set(k, { body, size: body.length, uploaded: new Date('2026-11-05T01:00:00Z'), customMetadata: o?.customMetadata ?? {} }); },
    head: async k => objs.get(k) ?? null,
    get: async k => objs.get(k) ?? null,
    list: async ({ prefix }) => ({ objects: [...objs.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.size, uploaded: o.uploaded })) }),
  };
  const ENV = { PAPER: R2, PAPER_TOKEN: 'sekret' };
  const call = (method, path, { body, token, env = ENV } = {}) => worker.fetch(
    new Request('https://w.example' + path, { method, body, headers: token ? { Authorization: 'Bearer ' + token } : {} }), env, { waitUntil() {} });
  const two = JSON.stringify({ k: 'run' }) + '\n' + JSON.stringify({ k: 'event', id: 'A' }) + '\n';
  const F = '/paper/log/2026-11-04.jsonl';
  // приём: только с верным токеном
  assert.equal((await call('PUT', F, { body: two })).status, 401, 'без токена');
  assert.equal((await call('PUT', F, { body: two, token: 'wrong' })).status, 401, 'чужой токен');
  assert.equal(objs.size, 0, 'ничего не записано');
  const ok = await call('PUT', F, { body: two, token: 'sekret' });
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true, key: 'log/2026-11-04.jsonl', lines: 2, bytes: two.length });
  // чтение — без токена
  const rd = await call('GET', F);
  assert.equal(rd.status, 200); assert.equal(await rd.text(), two); assert.match(rd.headers.get('content-type'), /ndjson/); assert.equal(rd.headers.get('cache-control'), 'no-store');
  const ix = await (await call('GET', '/paper/index')).json();
  assert.deepEqual(ix.files.map(f => f.name), ['2026-11-04.jsonl']); assert.equal(ix.files[0].size, two.length);
  assert.equal((await call('GET', '/paper/log/2026-01-01.jsonl')).status, 404);
  // токен проверяется без записи
  assert.equal((await call('GET', '/paper/ping')).status, 401); assert.equal((await call('GET', '/paper/ping', { token: 'sekret' })).status, 200);
  // защита от порчи: мусор, чужой вид записи, имя файла, усечённый журнал, переразмер
  assert.equal((await call('PUT', F, { body: two + 'не json\n', token: 'sekret' })).status, 400);
  assert.equal((await call('PUT', F, { body: JSON.stringify({ k: 'drop table' }) + '\n', token: 'sekret' })).status, 400);
  assert.equal((await call('PUT', '/paper/log/x.jsonl', { body: two, token: 'sekret' })).status, 404);
  const shrunk = await call('PUT', F, { body: JSON.stringify({ k: 'run' }) + '\n', token: 'sekret' });
  assert.equal(shrunk.status, 409, 'журнал только растёт'); assert.equal((await shrunk.json()).stored, 2);
  assert.equal((await call('PUT', F, { body: two + JSON.stringify({ k: 'stat' }) + '\n', token: 'sekret' })).status, 200, 'длиннее — принимается');
  assert.equal((await call('PUT', F, { body: 'x'.repeat(2 * 1024 * 1024 + 1), token: 'sekret' })).status, 413);
  // приём закрыт, если не настроен, и не открыт всем
  assert.equal((await call('PUT', F, { body: two, token: 'sekret', env: { PAPER: R2 } })).status, 503, 'нет секрета — приём закрыт');
  assert.equal((await call('PUT', F, { body: two, token: 'sekret', env: { PAPER_TOKEN: 'sekret' } })).status, 503, 'нет бакета');
  assert.equal((await call('GET', '/paper/index', { env: {} })).status, 503);
  // котировки по-прежнему только GET
  assert.equal((await call('PUT', '/quotes?symbols=AAA', { body: '' })).status, 405);
});

// ---------- вечерний сборщик: сквозной прогон против подставных SEC и воркера ----------
await okAsync('сборщик: форма в вечернем окне -> событие и котировки по бумаге и IWM; повторный запуск ничего не дублирует', async () => {
  const day = '2026-10-01';
  const form = id => FORM4_XML.replace('<SEC-DOCUMENT>\n', `<SEC-DOCUMENT>${id}.txt : 20261001\n<SEC-HEADER>${id}.hdr.sgml : 20261001\n<ACCEPTANCE-DATETIME>20261001172135\nACCESSION NUMBER:\t${id}\n</SEC-HEADER>\n`);
  const atom = `<feed>
<entry><title>4 - Smith (0001) (Reporting)</title><link href="https://www.sec.gov/Archives/edgar/data/111222/000100000026000001/0001000000-26-000001-index.htm"/><updated>${day}T17:21:35-04:00</updated><category term="4"/><id>urn:tag:sec.gov,2008:accession-number=0001000000-26-000001</id></entry>
<entry><title>4 - Early (0002) (Reporting)</title><link href="https://www.sec.gov/Archives/edgar/data/333/000100000026000002/0001000000-26-000002-index.htm"/><updated>${day}T10:00:00-04:00</updated><category term="4"/><id>urn:tag:sec.gov,2008:accession-number=0001000000-26-000002</id></entry>
<entry><title>424B2 - Bank</title><link href="https://www.sec.gov/Archives/edgar/data/444/000100000026000003/0001000000-26-000003-index.htm"/><updated>${day}T17:25:00-04:00</updated><category term="424B2"/><id>urn:tag:sec.gov,2008:accession-number=0001000000-26-000003</id></entry>
</feed>`;
  const hits = { feed: 0, filings: [], quotes: [], puts: [], failPut: false };
  const server = createServer((req, res) => {
    if (req.url.startsWith('/cgi-bin/browse-edgar')) { hits.feed++; res.writeHead(200, { 'content-type': 'application/atom+xml' }); res.end(atom); }
    else if (req.url.startsWith('/Archives/edgar/data/')) {
      hits.filings.push(req.url);
      res.writeHead(200); res.end(form('0001000000-26-000001'));
    } else if (req.method === 'PUT' && req.url.startsWith('/paper/log/')) {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => { hits.puts.push({ url: req.url, auth: req.headers.authorization, body: raw }); res.writeHead(hits.failPut ? 500 : 200, { 'content-type': 'application/json' }); res.end(hits.failPut ? '{"error":"сбой"}' : '{"ok":true}'); });
      return;
    } else if (req.url.startsWith('/quotes')) {
      hits.quotes.push(req.url);
      const q = { TST: { p: 9.9, t: 1, st: 'POST', b: 9.5, a: 9.6, bs: 200, as: 100, pp: 9.55, pt: 1793830000 }, IWM: { p: 200, t: 1, st: 'POST', b: 0, a: 0, pp: 200.5, pt: 1793830000 } };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ at: 1793830100, n: 2, src: 'quote', quotes: q }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const preload = join(NTMP, 'sec-redirect.mjs');
  writeFileSync(preload, ["const base = process.env.FAKE_SEC_BASE;", "const real = globalThis.fetch;",
    "globalThis.fetch = (url, init) => real(String(url).replace('https://www.sec.gov', base), init);"].join('\n'));
  const dir = join(NTMP, 'paper-run');
  const run = () => new Promise(resolve => execFile(process.execPath,
    ['--import', pathToFileURL(preload).href, join(ROOT, 'scripts', 'evening', 'collector.mjs'), '--dir', dir, '--once'],
    { encoding: 'utf8', env: { ...process.env, FAKE_SEC_BASE: base, QUOTES_URL: base + '/quotes', PAPER_URL: base, PAPER_TOKEN: 'tok' } },
    (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: stdout + stderr })));
  try {
    const r1 = await run();
    assert.equal(r1.code, 0, r1.out);
    const files = readdirSync(join(dir, 'log'));
    assert.equal(files.length, 1);
    const j = parseJournal(readFileSync(join(dir, 'log', files[0]), 'utf8'));
    assert.equal(j.events.size, 1, 'вечерняя форма одна: ранняя и чужого типа отброшены');
    const ev = j.events.get('0001000000-26-000001');
    assert.equal(ev.t, 'TST'); assert.equal(ev.at, `${day}T17:21:35`); assert.equal(ev.fdate, day);
    assert.equal(hits.filings.length, 1, 'полный текст скачан только для формы в окне');
    // сроки +5, +15, +30 прошли (дата в прошлом) — все четыре момента сняты, по бумаге и по IWM
    for (const m of [0, 5, 15, 30]) {
      const q = j.quotes.get(`${ev.id}|${m}|TST`)?.[0], b = j.quotes.get(`${ev.id}|${m}|IWM`)?.[0];
      assert.ok(q && b, `момент ${m}`);
      assert.equal(q.src, 'worker'); assert.equal(q.ask, 9.6); assert.equal(q.bid, 9.5); assert.equal(q.last, 9.55);
      assert.equal(b.bid, undefined, 'нулевая сторона у Yahoo не попадает в журнал как число');
      assert.ok(q.late >= 0 && q.due && q.got);
    }
    assert.equal(hits.quotes.length, 1, 'все моменты и IWM — одним запросом к воркеру');
    assert.match(hits.quotes[0], /symbols=TST%2CIWM|symbols=IWM%2CTST/);
    const before = readFileSync(join(dir, 'log', files[0]), 'utf8').split('\n').filter(Boolean).length;
    const r2 = await run();
    assert.equal(r2.code, 0, r2.out);
    const after = parseJournal(readFileSync(join(dir, 'log', files[0]), 'utf8'));
    assert.equal(after.events.size, 1); assert.equal([...after.quotes.values()].flat().length, 8, 'после перезапуска котировки не дублируются');
    assert.equal(readFileSync(join(dir, 'log', files[0]), 'utf8').split('\n').filter(Boolean).length, before + 2, 'добавились только служебные строки: запуск и статистика');
    // отправка журнала в воркер: целиком, с токеном, на путь с датой файла; на каждый запуск (файл вырос) — одна отправка
    assert.equal(hits.puts.length, 2);
    assert.equal(hits.puts[0].url, '/paper/log/' + files[0]); assert.equal(hits.puts[0].auth, 'Bearer tok');
    assert.equal(hits.puts[1].body, readFileSync(join(dir, 'log', files[0]), 'utf8'), 'уходит весь журнал, а не только прирост');
    // сбой воркера: код выхода ненулевой (тревога), журнал остаётся на диске и уйдёт при следующей отправке
    hits.failPut = true;
    const r3 = await run();
    assert.notEqual(r3.code, 0); assert.match(r3.out, /HTTP 500/);
    hits.failPut = false;
    const n3 = hits.puts.length;
    const r4 = await run();
    assert.equal(r4.code, 0, r4.out); assert.equal(hits.puts.length, n3 + 1, 'недоставленное ушло при следующем запуске');
  } finally { await new Promise(r => server.close(r)); }
});

// ---------- П11/П14 (ревизия данных 04.11.2026): определения отбора как в проверенной стратегии, поля для сторожа ----------
ok('turnover20: медиана close×volume за 20 баров, заканчивающихся днём подачи; меньше 10 баров — оборота нет', () => {
  const bar = (k, c, v) => ['2026-10-' + String(k).padStart(2, '0'), c, c, v];
  const s25 = Array.from({ length: 25 }, (_, k) => bar(k + 1, 1, k + 1));      // оборот k-го бара равен k
  assert.equal(turnover20(s25, 24), 16, 'окно 6..25, чётное число баров: среднее двух средних (15,5), а не нижнее');
  assert.equal(turnover20(s25, 14), 8, 'окно кончается на D0 (индекс 14): бары 1..15; бары после D0 не входят');
  assert.equal(turnover20(s25, 9), 6, 'ровно 10 баров — оборот есть (5,5 -> 6)');
  assert.equal(turnover20(s25, 8), null, 'девять баров — оборота нет');
  const zeros = Array.from({ length: 10 }, (_, k) => bar(k + 1, 1, k < 5 ? 0 : 100));
  assert.equal(turnover20(zeros, 9), 50, 'бар с нулевым объёмом входит в окно, как в проверке');
  const holes = Array.from({ length: 11 }, (_, k) => bar(k + 1, 2, k < 2 ? null : 10));
  assert.equal(turnover20(holes, 10), null, 'бары без объёма не входят: девять баров — оборота нет');
  assert.equal(turnover20([...holes, bar(12, 2, 10)], 11), 20, 'десять баров с объёмом: 2 × 10');
  assert.equal(turnover20(null, 0), null); assert.equal(turnover20(s25, -1), null); assert.equal(turnover20(s25, 99), null);
});
ok('утренний список (П11): событие — эмитент × день; суммы по самой крупной строке, офицер из любого rel, просадка — минимум', () => {
  const base = { cik: 1, t: 'AAA', name: 'X Corp', who: ['Doe'], role: 'D', officer: false, common: true, val: 5e4, dd: -0.1, adv: 4e7, px: 20, drop: null };
  const by = (rows, t) => buildDay(rows).find(x => x.t === t);
  // три покупки по $60 тыс.: сумма дня $180 тыс., но самая крупная строка — $60 тыс. -> балла за сумму нет
  const a = by([60, 61, 62].map(v => ({ ...base, cik: 10, t: 'SUMX', val: v * 1e3 })), 'SUMX');
  assert.equal(a.val, 183000); assert.equal(a.mx, 62000); assert.equal(a.score, 0); assert.equal(a.main, false); assert.deepEqual(a.tags, []);
  // $150 тыс. + $50 тыс.: самая крупная $150 тыс. -> один балл
  const b = by([{ ...base, cik: 11, t: 'MAXR', val: 1.5e5 }, { ...base, cik: 11, t: 'MAXR', val: 5e4 }], 'MAXR');
  assert.equal(b.val, 2e5); assert.equal(b.mx, 1.5e5); assert.equal(b.score, 1);
  // $1,2 млн + мелкая: оба балла за сумму, пометка «≥$1 млн»
  const c = by([{ ...base, cik: 12, t: 'BIGR', val: 1.2e6 }, { ...base, cik: 12, t: 'BIGR', val: 1e4 }], 'BIGR');
  assert.equal(c.score, 2); assert.equal(c.main, true); assert.ok(c.tags.includes('big'));
  // директор-офицер (rel «DO», role по topRole = D): офицер -> балл и пометка, на витрине роль «офицер»
  const d = by([{ ...base, cik: 13, t: 'DOFF', officer: true, dd: -0.35 }], 'DOFF');
  assert.equal(d.score, 2); assert.equal(d.role, 'O'); assert.deepEqual(d.tags, ['off', 'deep']);
  // как в проверке: офицер и просадка берутся по ВСЕМ обыкновенным строкам события, в том числе отсеянным гейтами
  const e = by([{ ...base, cik: 14, t: 'DROPS', val: 2e5 }, { ...base, cik: 14, t: 'DROPS', val: 9e5, officer: true, dd: -0.6, drop: 'planned' }], 'DROPS');
  assert.equal(e.val, 2e5, 'отсеянная строка в сумму и в самую крупную покупку не входит'); assert.equal(e.mx, 2e5);
  assert.equal(e.score, 3); assert.equal(e.dd, -0.6, 'просадка — минимум по строкам события'); assert.deepEqual(e.tags, ['off', 'deep']);
  // не-обыкновенные бумаги (преф, варрант) в событие не входят совсем
  const f = by([{ ...base, cik: 15, t: 'PREF', val: 3e4 }, { ...base, cik: 15, t: 'PREF', val: 9e6, officer: true, dd: -0.9, common: false }], 'PREF');
  assert.equal(f.val, 3e4); assert.equal(f.score, 0); assert.equal(f.dd, -0.1); assert.equal(f.role, 'D');
  // цена и оборот — у ведущей (самой крупной) строки; тикер события — её тикер
  const g = buildDay([{ ...base, cik: 16, t: 'GOOGL', val: 3e5 }, { ...base, cik: 16, t: 'GOOG', val: 1e5, px: 4, adv: 1e6 }]);
  assert.deepEqual(g.map(x => x.t), ['GOOGL']); assert.equal(g[0].n, 2); assert.equal(g[0].px, 20); assert.equal(g[0].dv, 4e7);
  // старый формат строки (dv, role без officer) читается: офицер выводится из роли
  const h = buildDay([{ t: 'OLDF', name: 'Old', who: ['A'], role: 'C', val: 2e5, dd: null, dv: 2e7, px: 9, drop: null }]);
  assert.equal(h[0].score, 2); assert.equal(h[0].dv, 2e7);
});
ok('утренний список (П11): границы цены и оборота по D0, события без цены или оборота считаются отдельно', () => {
  const base = { name: 'X', who: ['A'], role: 'D', officer: false, common: true, val: 1e5, dd: null, adv: 1e7, px: 5, drop: null };
  const rows = [
    { ...base, cik: 1, t: 'EDGE' },                         // ровно $5 и $10 млн — проходит
    { ...base, cik: 2, t: 'CHEAP', px: 4.99 },
    { ...base, cik: 3, t: 'THIN', adv: 9999999 },
    { ...base, cik: 4, t: 'NOPX', px: null },               // ряд не дотянул до D0
    { ...base, cik: 5, t: 'NOADV', adv: null },             // меньше десяти баров
    { ...base, cik: 6, t: 'TINY', val: 9999 },              // меньше $10 тыс. — события нет ни в списке, ни в «без цены»
    { ...base, cik: 7, t: 'GATED', drop: 'offering' },      // не прошла гейты — события нет
    { ...base, cik: 8, t: 'NOPREF', px: null, common: false },
  ];
  const r = buildDayFull(rows);
  assert.deepEqual(r.rows.map(x => x.t), ['EDGE']);
  assert.deepEqual(r.unpriced.sort(), ['NOADV', 'NOPX']);
  assert.deepEqual(buildDayFull([]), { rows: [], unpriced: [] });
});
ok('утренний список (П11): скор совпадает с эталоном проверки (r14_rank.py) на 400 случайных событиях', () => {
  let seed = 20261104;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const ref = ev => {
    const c = ev.filter(r => r.common);
    const mo = Math.max(0, ...c.filter(r => !r.drop).map(r => r.val));
    const dds = c.map(r => r.dd).filter(x => x !== null);
    const dd = dds.length ? Math.min(...dds) : null;
    return { mo, score: (mo >= 1e5 ? 1 : 0) + (mo >= 1e6 ? 1 : 0) + (c.some(r => r.officer) ? 1 : 0) + (dd !== null && dd < -0.3 ? 1 : 0) };
  };
  let included = 0, mains = 0;
  for (let i = 0; i < 400; i++) {
    const n = 1 + Math.floor(rnd() * 4);
    const ev = Array.from({ length: n }, () => ({
      cik: 1, t: 'EVT', name: 'E', who: ['A'], role: 'D', officer: rnd() < 0.3, common: rnd() < 0.9,
      val: Math.round(10 ** (3 + rnd() * 3.7)), dd: rnd() < 0.2 ? null : -0.7 + rnd() * 0.75, adv: 5e7, px: 30, drop: rnd() < 0.25 ? 'x' : null,
    }));
    const { mo, score } = ref(ev);
    const got = buildDay(ev);
    if (!(mo >= 1e4)) { assert.equal(got.length, 0, 'без строки от $10 тыс., прошедшей гейты, события нет'); continue; }
    included++;
    assert.equal(got.length, 1);
    assert.equal(got[0].score, score, JSON.stringify(ev));
    assert.equal(got[0].main, score >= 2);
    if (got[0].main) mains++;
  }
  assert.ok(included > 150 && mains > 20 && mains < included, `выборка вырождена: событий ${included}, в основном списке ${mains}`);
});
ok('compute (П14): listFor, builtAt, builder, coverage; день без покупок попадает в файл пустым', () => {
  const m = R('morning.json');
  assert.equal(m.listFor, recentF, 'нет state/live.json с lastDay — список за день последней покупки');
  assert.match(m.builtAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/); assert.equal(m.builder, 'github'); assert.equal(m.coverage, null);
  // День после последней покупки, чей индекс разобран, — будний: выходной списком не считается (livecal.listDayOf),
  // а recentF + 2 по дате запуска бывает и субботой
  let lastDay = addDaysIso(recentF, 2);
  while ([0, 6].includes(new Date(lastDay + 'T00:00:00Z').getUTCDay())) lastDay = addDaysIso(lastDay, 1);
  const cov = { status: 'complete', indexed: 40, collected: 40, pending: 0, at: lastDay + 'T22:10:00Z' };
  mkdirSync(join(TMP, 'state'), { recursive: true });
  const livePath = join(TMP, 'state', 'live.json');
  const had = readJson(livePath, null);
  writeJson(livePath, { schema: 3, lastDay, coverage: { [lastDay]: cov, [recentF]: { status: 'partial', indexed: 9, collected: 5, pending: 4, at: 'x' } } });
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'compute.mjs'), '--data', TMP, '--site', join(TMP, 'site-vps'), '--builder', 'vps', '--counter-from', addDaysIso(today, -30)], { stdio: 'pipe' });
  } finally { if (had) writeJson(livePath, had); else rmSync(livePath, { force: true }); }
  const v = readJson(join(TMP, 'site-vps', 'data', 'morning.json'));
  assert.equal(v.builder, 'vps'); assert.equal(v.listFor, lastDay, 'день, чей индекс разобран, — даже если покупок в нём не было');
  assert.deepEqual(v.coverage, cov, 'покрытие берётся ровно за listFor');
  assert.equal(v.days[0].date, lastDay); assert.deepEqual(v.days[0].rows, [], 'пустой день присутствует в списке дней');
  assert.ok(v.days.some(d => d.date === recentF), 'прежние дни остались');
});
ok('compute (П11): строка списка несёт самую крупную покупку и цену D0; оборот — 20 баров до подачи включительно', () => {
  const row = R('morning.json').days.find(d => d.date === recentF).rows[0];
  assert.equal(row.mx, 275000); assert.ok(row.px > 0);
  assert.ok(row.dv >= 1e7, 'оборот LIVA — не меньше порога списка');
});
ok('notify (П14): пустой день за listFor даёт короткое письмо «сигналов нет», повторно не шлётся', () => {
  const dir = freshDir('data-empty');
  notify([mDay(nDay(-3), [mRow('OLD', 3e5)])], { dir });                       // пересев
  const days = [mDay(nDay(-1), [mRow('LOW', 1e5, REST)])];                      // только скор 0–1: основной список пуст
  const out = notify(days, { dir });
  assert.match(out, /новых утренних списков: 1 \(в том числе пустой день\)/);
  assert.match(out, /🔕 Инсайдерский радар · утренний список пуст/);
  assert.match(out, new RegExp(`Подачи за \\d\\d\\.\\d\\d · основной список без бумаг: оборот от \\$10${NB}млн, скор от 2`));
  assert.match(out, /Ещё 1 бумага со скором 0–1 — на панели\./);
  assert.match(out, /Счётчик с 05\.11: сделок пока нет\./);
  assert.ok(!/Только заявки на аукционы/.test(out), 'правило исполнения в письме «сигналов нет» не нужно');
  assert.ok(!/Индекс разобран/.test(out), 'покрытие неизвестно — о нём не говорим');
  assert.equal(sentOf(dir).filter(k => k === `morning|${nDay(-1)}`).length, 1);
  assert.match(notify(days, { dir }), /новых утренних списков нет/, 'второе письмо за ту же дату невозможно');
  // день совсем без бумаг: строки про «ещё N» нет (пустые разделы не печатаются)
  const d2 = freshDir('data-empty-zero');
  notify([mDay(nDay(-3), [mRow('OLD', 3e5)])], { dir: d2 });
  assert.ok(!/Ещё \d/.test(notify([mDay(nDay(-1), [])], { dir: d2 })));
});
ok('notify (П14): пустое письмо — только за listFor; выходной и «индекс не вышел» не выдаются за «сигналов нет»', () => {
  const days = [mDay(nDay(-1), []), mDay(nDay(-2), [])];
  const dir = freshDir('data-empty-for');
  notify([mDay(nDay(-4), [mRow('OLD', 3e5)])], { dir });
  assert.match(notify(days, { dir, extra: { listFor: nDay(-1) } }), /новых утренних списков: 1 /, 'прежний пустой день задним числом не шлётся');
  assert.deepEqual(sentOf(dir).filter(k => k.endsWith(nDay(-2))), []);
  for (const status of ['not-published', 'holiday']) {
    const d = freshDir('data-empty-' + status);
    notify([mDay(nDay(-4), [mRow('OLD', 3e5)])], { dir: d });
    assert.match(notify(days, { dir: d, extra: { listFor: nDay(-1), coverage: { status, indexed: 0, collected: 0 } } }), /новых утренних списков нет/, status);
  }
  const d3 = freshDir('data-empty-partial');
  notify([mDay(nDay(-4), [mRow('OLD', 3e5)])], { dir: d3 });
  const out = notify(days, { dir: d3, extra: { listFor: nDay(-1), coverage: { status: 'partial', indexed: 9, collected: 7 } } });
  assert.match(out, /Индекс разобран не полностью: 7 из 9 форм\./);
  const d4 = freshDir('data-empty-complete');
  notify([mDay(nDay(-4), [mRow('OLD', 3e5)])], { dir: d4 });
  assert.match(notify(days, { dir: d4, extra: { listFor: nDay(-1), coverage: { status: 'complete', indexed: 9, collected: 9 } } }), /утренний список пуст/);
});

// ---------- PR-2: сборка утреннего списка на VPS, воркер (/morning, /bars), отметка письма, сверка с GitHub ----------
const mkR2 = () => {
  const objs = new Map();
  return {
    objs,
    put: async (k, body, o) => { objs.set(k, { body, size: body.length, uploaded: new Date('2026-11-05T03:05:00Z'), customMetadata: o?.customMetadata ?? {} }); },
    head: async k => objs.get(k) ?? null,
    get: async k => objs.get(k) ?? null,
    list: async ({ prefix }) => ({ objects: [...objs.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.size, uploaded: o.uploaded })) }),
  };
};
// Ответ Yahoo chart из ряда [[дата, close, adj, объём]]; over — { дата: [открытие, закрытие] } для пар открытие/закрытие дня входа
const chartOf = (series, over = {}) => ({
  chart: { result: [{
    meta: { gmtoffset: -18000, exchangeName: 'NYQ' },
    timestamp: series.map(r => Math.floor(Date.parse(r[0] + 'T14:30:00Z') / 1000)),
    indicators: {
      quote: [{ open: series.map(r => over[r[0]]?.[0] ?? r[1]), close: series.map(r => over[r[0]]?.[1] ?? r[1]), volume: series.map(r => r[3]) }],
      adjclose: [{ adjclose: series.map(r => over[r[0]]?.[1] ?? r[2]) }],
    },
    events: {},
  }] },
});
const MJ = (listFor, builtAt, builder = 'vps', extra = {}) => JSON.stringify({ built: listFor, listFor, builtAt, builder, coverage: null, params: {}, counter: { main: { n: 0 } }, days: [{ date: listFor, rows: [] }], ...extra });

ok('календарь SEC: федеральные праздники и их переносы, Страстная пятница — рабочий день SEC', () => {
  for (const d of ['2026-11-11', '2026-11-26', '2026-07-03', '2026-10-12', '2026-06-19', '2026-12-25', '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-09-07', '2027-12-31', '2026-11-07', '2026-11-08'])
    assert.equal(isSecClosed(d), true, d);
  for (const d of ['2026-11-04', '2026-11-05', '2026-04-03', '2026-07-02', '2026-11-12', '2027-01-04'])
    assert.equal(isSecClosed(d), false, d);
});
ok('сверка списков: состав и скор основного списка, остальные бумаги не сравниваются', () => {
  const r = (t, score, extra = {}) => ({ t, name: t + ' Inc', score, main: score >= 2, val: 1e5, ...extra });
  assert.deepEqual(compareMain([r('A', 3), r('B', 2), r('C', 1)], [r('A', 3), r('B', 2), r('C', 0), r('D', 1)]), { same: true, diff: [], vps: 2, github: 2 });
  const c = compareMain([r('A', 3), r('B', 2), r('E', 2)], [r('A', 4), r('B', 2), r('F', 3, { val: 7e5 })]);
  assert.equal(c.same, false);
  assert.deepEqual(c.diff.map(x => [x.t, x.was, x.now]), [['A', 3, 4], ['F', null, 3], ['E', 2, null]], 'по убыванию скора; ушедшая — в конце');
  assert.equal(compareMain([], [r('A', 2)]).diff[0].was, null);
});
ok('parseYahooChart: тот же разбор для текста и объекта, открытия и закрытия из одного ответа', () => {
  const s = [['2026-10-26', 10, 10, 100], ['2026-10-27', 11, 11, 200], ['2026-10-28', 12, 12, 300]];
  const a = parseYahooChart(chartOf(s, { '2026-10-28': [11.5, 12] })), b = parseYahooChart(JSON.stringify(chartOf(s, { '2026-10-28': [11.5, 12] })));
  assert.deepEqual(a, b); assert.deepEqual(a.series.map(x => x[0]), ['2026-10-26', '2026-10-27', '2026-10-28']);
  assert.deepEqual(a.ohlc.at(-1), ['2026-10-28', 11.5, 12]);
  assert.deepEqual(parseYahooChart('не json'), { missing: true }); assert.deepEqual(parseYahooChart({ chart: { result: [] } }), { missing: true });
});

await okAsync('воркер: /morning — приём по токену, версии только новее, чтение без токена; отметка письма — первая запись остаётся', async () => {
  const worker = (await import(pathToFileURL(join(ROOT, 'worker', 'index.js')).href)).default;
  const R2 = mkR2(), ENV = { PAPER: R2, PAPER_TOKEN: 'sekret' };
  const call = (method, path, { body, token, env = ENV } = {}) => worker.fetch(
    new Request('https://w.example' + path, { method, body, headers: token ? { Authorization: 'Bearer ' + token } : {} }), env, { waitUntil() {} });
  const T = 'sekret';
  assert.equal((await call('GET', '/morning')).status, 404, 'списка ещё нет');
  assert.equal((await call('PUT', '/morning', { body: MJ('2026-11-04', '2026-11-05T03:05:00Z') })).status, 401, 'без токена');
  assert.equal((await call('PUT', '/morning', { body: MJ('2026-11-04', '2026-11-05T03:05:00Z'), token: 'wrong' })).status, 401);
  assert.equal(R2.objs.size, 0, 'ничего не записано');
  const put = await call('PUT', '/morning', { body: MJ('2026-11-04', '2026-11-05T03:05:00Z'), token: T });
  assert.equal(put.status, 200); assert.equal((await put.json()).listFor, '2026-11-04');
  const rd = await call('GET', '/morning');
  assert.equal(rd.status, 200); assert.equal(rd.headers.get('cache-control'), 'no-store'); assert.match(rd.headers.get('last-modified'), /GMT$/);
  assert.equal((await rd.json()).builder, 'vps');
  // версия старее хранимой не принимается: прошлая дата, та же дата с более ранним временем сборки
  assert.equal((await call('PUT', '/morning', { body: MJ('2026-11-03', '2026-11-06T00:00:00Z'), token: T })).status, 409);
  const stale = await call('PUT', '/morning', { body: MJ('2026-11-04', '2026-11-05T03:04:00Z'), token: T });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).stored.builtAt, '2026-11-05T03:05:00.000Z');
  assert.equal((await call('PUT', '/morning', { body: MJ('2026-11-04', '2026-11-05T03:25:00Z', 'github'), token: T })).status, 200, 'позже на той же дате — принимается');
  assert.equal((await call('PUT', '/morning', { body: MJ('2026-11-05', '2026-11-06T03:05:00Z'), token: T })).status, 200, 'новая дата подачи');
  // защита от порчи
  for (const bad of ['не json', '[]', MJ('вчера', '2026-11-06T00:00:00Z'), MJ('2026-11-06', 'когда-то'), MJ('2026-11-06', '2026-11-06T00:00:00Z', 'ручной'), JSON.stringify({ listFor: '2026-11-06', builtAt: '2026-11-06T00:00:00Z', builder: 'vps', days: [] })])
    assert.equal((await call('PUT', '/morning', { body: bad, token: T })).status, 400, bad.slice(0, 40));
  assert.equal((await call('PUT', '/morning', { body: 'x'.repeat(4 * 1024 * 1024 + 1), token: T })).status, 413);
  assert.equal((await call('PUT', '/morning', { body: MJ('2026-11-07', '2026-11-08T00:00:00Z'), token: T, env: { PAPER: R2 } })).status, 503, 'нет секрета — приём закрыт');
  assert.equal((await call('GET', '/morning', { env: {} })).status, 503);
  // отметка письма
  const L = '/morning/letter/2026-11-05';
  assert.equal((await call('GET', L)).status, 404);
  assert.equal((await call('PUT', L, { body: JSON.stringify({ by: 'vps', at: '2026-11-05T03:06:00Z' }) })).status, 401);
  assert.equal((await call('PUT', L, { body: JSON.stringify({ by: 'кто-то', at: '2026-11-05T03:06:00Z' }), token: T })).status, 400);
  const m1 = await call('PUT', L, { body: JSON.stringify({ by: 'vps', at: '2026-11-05T03:06:00Z' }), token: T });
  assert.deepEqual(await m1.json(), { ok: true, existed: false, marker: { by: 'vps', at: '2026-11-05T03:06:00.000Z', ok: true } });
  const m2 = await call('PUT', L, { body: JSON.stringify({ by: 'github', at: '2026-11-05T03:30:00Z' }), token: T });
  assert.equal((await m2.json()).marker.by, 'vps', 'первая запись остаётся');
  assert.equal((await (await call('GET', L)).json()).by, 'vps');
  assert.equal((await call('GET', '/morning/letter/сегодня')).status, 404);
});
await okAsync('воркер: /bars — только с токеном, до 25 тикеров, свой старт для тикера, 429 и сбои названы', async () => {
  const worker = (await import(pathToFileURL(join(ROOT, 'worker', 'index.js')).href)).default;
  const ENV = { PAPER: mkR2(), PAPER_TOKEN: 'sekret' };
  const realFetch = globalThis.fetch, seen = [];
  globalThis.fetch = async url => {
    seen.push(String(url));
    const sym = decodeURIComponent(/chart\/([^?]+)/.exec(String(url))[1]);
    if (sym === 'LIM') return new Response('', { status: 429 });
    if (sym === 'BAD') return new Response('', { status: 404 });
    if (sym === 'HTML') return new Response('<html>captcha</html>', { status: 200 });
    return new Response(JSON.stringify(chartOf([['2026-11-03', 10, 10, 1]])), { status: 200 });
  };
  try {
    const call = (qs, token = 'sekret', env = ENV) => worker.fetch(new Request('https://w.example/bars?' + qs, { headers: token ? { Authorization: 'Bearer ' + token } : {} }), env, { waitUntil() {} });
    assert.equal((await call('symbols=AAPL&from=2026-10-01', null)).status, 401);
    assert.equal((await call('symbols=AAPL&from=2026-10-01', 'wrong')).status, 401);
    assert.equal((await call('symbols=AAPL&from=2026-10-01', 'sekret', { PAPER: ENV.PAPER })).status, 503);
    assert.equal(seen.length, 0, 'Yahoo без токена не трогаем');
    const r = await call('symbols=' + encodeURIComponent('AAPL,BRK.B:2025-09-01,LIM,BAD,HTML,aapl') + '&from=2026-10-01');
    const j = await r.json();
    assert.equal(r.status, 200); assert.deepEqual(Object.keys(j.bars).sort(), ['AAPL', 'BRK.B']); assert.deepEqual(j.failed, { LIM: 'HTTP 429', BAD: 'HTTP 404', HTML: 'ответ не JSON' }, 'не-JSON от Yahoo не портит общий ответ'); assert.equal(j.limited, true);
    const brk = seen.find(u => u.includes('BRK-B')), p1 = Number(/period1=(\d+)/.exec(brk)[1]);
    assert.equal(p1, Date.parse('2025-09-01T00:00:00Z') / 1000, 'у BRK.B своя дата начала, символ Yahoo — с дефисом');
    assert.equal(Number(/period1=(\d+)/.exec(seen.find(u => u.includes('/AAPL?')))[1]), Date.parse('2026-10-01T00:00:00Z') / 1000, 'у AAPL — общая');
    assert.equal(seen.filter(u => u.includes('/AAPL?')).length, 1, 'повтор тикера в запросе не удваивает обращений');
    assert.equal((await call('symbols=AAPL')).status, 400, 'нужна дата начала');
    assert.equal((await call('symbols=AAPL&from=1999-01-01')).status, 400);
    assert.equal((await call('symbols=' + Array.from({ length: 26 }, (_, i) => 'T' + i).join(',') + '&from=2026-10-01')).status, 400);
    assert.equal((await worker.fetch(new Request('https://w.example/bars?symbols=AAPL&from=2026-10-01', { method: 'PUT', headers: { Authorization: 'Bearer sekret' } }), ENV, { waitUntil() {} })).status, 405);
  } finally { globalThis.fetch = realFetch; }
});

ok('бары VPS: с какой даты просить, слияние в копию data (кэш, сплиты, открытия), пачки по 20', () => {
  assert.equal(barsFrom('2026-11-03', '2026-11-04'), '2026-10-31', 'есть кэш — с перекрытием в три дня');
  assert.equal(barsFrom(null, '2026-11-04'), addDaysIso('2026-11-04', -420), 'кэша нет — вся история для 52-недельного максимума');
  assert.equal(barsFrom('2026-11-03', '2026-11-04', ['2026-10-20', '2026-10-28']), '2026-10-17', 'открытия: не позже первой даты подачи');
  const dir = join(TMP, '..', '.selftest-bars');
  rmSync(dir, { recursive: true, force: true });
  const old = [['2026-10-26', 10, 10, 100], ['2026-10-27', 11, 11, 200]];
  writePriceCache(dir, 'OLD', old);
  const fresh = [...old, ['2026-10-28', 12, 12, 300], ['2026-10-29', 13, 13, 400]];
  const splitChart = chartOf(fresh); splitChart.chart.result[0].events = { splits: { x: { date: Date.parse('2026-10-29T14:30:00Z') / 1000, numerator: 2, denominator: 1 } } };
  const got = new Map([['OLD', parseYahooChart(chartOf(fresh))], ['NEW', parseYahooChart(splitChart)], ['IWM', parseYahooChart(chartOf(fresh, { '2026-10-28': [11.9, 12.2] }))], ['GONE', { missing: true }]]);
  const st = applyBars(dir, got, { opensNeeds: { OLD: ['2026-10-27'] }, updated: '2026-10-29' });
  assert.deepEqual(st, { merged: 3, fresh: 2, opens: 2, missing: ['GONE'] });
  assert.deepEqual(readPriceCache(dir, 'OLD').map(r => r[0]), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']);
  assert.equal(readPriceCache(dir, 'NEW').length, 4, 'бумага без кэша получила ряд');
  assert.deepEqual(readJson(join(dir, 'prices', '_splits.json')).NEW, [['2026-10-29', 2]]);
  const store = readOpens(dir);
  assert.equal(opensOf(store, 'OLD', '2026-10-28')?.[0], 12, 'первый торговый день после подачи 27.10');
  assert.equal(opensOf(store, 'OLD', '2026-10-29'), null, 'остальные дни не копим');
  assert.ok(opensOf(store, 'IWM', '2026-10-28') && opensOf(store, 'IWM', '2026-10-29'), 'у бенчмарка — каждый день');
  rmSync(dir, { recursive: true, force: true });
});
await okAsync('бары VPS: запрос к воркеру пачками, токен в заголовке, 429 останавливает остальные пачки, сбой пачки не роняет прочие', async () => {
  const calls = [];
  const mk = plan => async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization });
    const step = plan[calls.length - 1] ?? 'ok';
    if (step === 'http500') return new Response('', { status: 500 });
    const syms = decodeURIComponent(/symbols=([^&]+)/.exec(String(url))[1]).split(',').map(x => x.split(':')[0]);
    if (step === 'limit') return new Response(JSON.stringify({ ok: true, bars: {}, failed: Object.fromEntries(syms.map(s => [s, 'HTTP 429'])), limited: true }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, bars: Object.fromEntries(syms.map(s => [s, chartOf([['2026-11-03', 10, 10, 1]])])), failed: {}, limited: false }), { status: 200 });
  };
  const items = Array.from({ length: 45 }, (_, i) => ({ sym: 'T' + i, from: '2026-10-01' }));
  const noSleep = () => Promise.resolve();
  let r = await fetchBars('https://w.example', 'tok', items, { fetchImpl: mk([]), sleep: noSleep });
  assert.equal(calls.length, 3, '45 тикеров = 3 пачки по 20, 20 и 5'); assert.equal(r.got.size, 45); assert.equal(calls[0].auth, 'Bearer tok');
  assert.match(decodeURIComponent(calls[0].url), /symbols=T0:2026-10-01,T1:2026-10-01/);
  calls.length = 0;
  r = await fetchBars('https://w.example', 'tok', items, { fetchImpl: mk(['ok', 'limit']), sleep: noSleep });
  assert.equal(calls.length, 2, 'после 429 третья пачка не уходит'); assert.equal(r.limited, true); assert.equal(r.got.size, 20); assert.equal(Object.keys(r.failed).length, 20);
  calls.length = 0;
  r = await fetchBars('https://w.example', 'tok', items, { fetchImpl: mk(['http500', 'ok', 'ok']), sleep: noSleep });
  assert.equal(r.got.size, 25); assert.equal(Object.keys(r.failed).length, 20); assert.match(r.failed.T0, /HTTP 500/); assert.equal(r.limited, false);
});

// --- сборка на VPS целиком против подставного воркера: копия данных фикстуры, у LIVA/SPY/IWM срезаны бары D0, всё докачивается ---
function fakeWorker({ charts = {}, morning = null, markers = {} } = {}) {
  const calls = { morningPuts: [], markerPuts: [], bars: [], paper: 0 };
  const state = { morning, markers: { ...markers } };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x'), auth = req.headers.authorization ?? null;
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const lm = /^\/morning\/letter\/(\d{4}-\d{2}-\d{2})$/.exec(u.pathname);
      if (lm && req.method === 'GET') return state.markers[lm[1]] ? send(200, state.markers[lm[1]]) : send(404, { error: 'нет' });
      if (lm && req.method === 'PUT') {
        calls.markerPuts.push({ date: lm[1], auth, body: JSON.parse(raw) });
        if (!state.markers[lm[1]]) state.markers[lm[1]] = { ...JSON.parse(raw), ok: true };
        return send(200, { ok: true });
      }
      if (u.pathname === '/morning' && req.method === 'GET') return state.morning ? send(200, state.morning) : send(404, { error: 'нет' });
      if (u.pathname === '/morning' && req.method === 'PUT') {
        if (auth !== 'Bearer tok') return send(401, { error: 'нужен токен' });
        calls.morningPuts.push(raw); state.morning = JSON.parse(raw); return send(200, { ok: true, listFor: state.morning.listFor });
      }
      if (u.pathname === '/bars') {
        if (auth !== 'Bearer tok') return send(401, { error: 'нужен токен' });
        const bars = {}, failed = {};
        for (const part of (u.searchParams.get('symbols') ?? '').split(',')) {
          const [sym, from] = part.split(':');
          calls.bars.push({ sym, from });
          if (charts[sym]) bars[sym] = charts[sym](from); else failed[sym] = 'HTTP 404';
        }
        return send(200, { ok: true, bars, failed, limited: false });
      }
      if (u.pathname === '/paper/index') { calls.paper++; return send(200, { files: [] }); }
      send(404, { error: 'not found' });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    calls, state, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)),
  })));
}

await okAsync('сборка на VPS: бары D0 и открытия докачиваются через воркер, morning.json совпадает с полным пересчётом, список уходит в воркер', async () => {
  const work = join(TMP, '..', '.selftest-vps');
  rmSync(work, { recursive: true, force: true });
  const data = join(work, 'repo');
  for (const d of ['trades', 'reference', 'prices', 'state']) cpSync(join(TMP, d), join(data, d), { recursive: true });
  rmSync(join(data, 'prices', '_opens.json.gz'), { force: true });
  const d0 = bizDays('2015-01-01', today).filter(d => d <= recentF).at(-1);
  for (const sym of ['SPY', 'IWM', 'LIVA']) writePriceCache(data, sym, readPriceCache(data, sym).filter(r => r[0] < d0));
  // что вернёт Yahoo через воркер: полные ряды из фикстуры и пары открытие/закрытие дня входа
  const over = { LIVA: { [d1L]: [50, 51] }, IWM: { [d1L]: [100, 100.5] }, SPY: { [d1L]: [100, 101] } };
  const src = { LIVA: livaSeries, IWM: bizDays('2015-01-01', today).map(d => [d, 100, 100, 1e6]), SPY: bizDays('2015-01-01', today).map(d => [d, 100, 100, 1e6]) };
  const charts = Object.fromEntries(Object.entries(src).map(([sym, s]) => [sym, from => chartOf(s.filter(r => r[0] >= from), over[sym])]));
  const api = await fakeWorker({ charts });
  try {
    const env = { PAPER_URL: api.base, PAPER_TOKEN: 'tok' };
    const argv = ['--state', work, '--data', data, '--site', join(work, 'site'), '--date', recentF, '--no-sync', '--no-live', '--no-index-check', '--once', '--interval', '1'];
    const code = await morningMain(argv, env);
    assert.equal(code, 0);
    // запросы к воркеру: бенчмарки и бумага; у LIVA бар D0 отсутствовал — её просили не с нуля, а с перекрытием
    const asked = new Set(api.calls.bars.map(b => b.sym));
    assert.ok(asked.has('IWM') && asked.has('SPY') && asked.has('LIVA'), [...asked].join());
    assert.equal(api.calls.morningPuts.length, 1);
    const sent = JSON.parse(api.calls.morningPuts[0]);
    assert.equal(sent.builder, 'vps'); assert.equal(sent.listFor, recentF);
    const row = sent.days.find(d => d.date === recentF).rows[0], ref = R('morning.json').days.find(d => d.date === recentF).rows[0];
    for (const k of ['t', 'val', 'mx', 'score', 'main', 'dv', 'px', 'cost', 'tags', 'o', 'c', 'ex', 'exS'])
      assert.deepEqual(row[k], ref[k], 'поле ' + k + ' должно совпасть с полным пересчётом');
    assert.ok(existsSync(join(work, 'done', `${recentF}.json`)), 'день отмечен собранным');
    // повторный запуск того же дня ничего не делает
    assert.equal(await morningMain(argv, env), 0); assert.equal(api.calls.morningPuts.length, 1);
  } finally { await api.close(); rmSync(work, { recursive: true, force: true }); }
});
await okAsync('сборка на VPS: воркер недоступен — попытка не удалась с причиной, день не отмечен собранным', async () => {
  const work = join(TMP, '..', '.selftest-vps2');
  rmSync(work, { recursive: true, force: true });
  const data = join(work, 'repo');
  for (const d of ['trades', 'reference', 'prices', 'state']) cpSync(join(TMP, d), join(data, d), { recursive: true });
  const d0 = bizDays('2015-01-01', today).filter(d => d <= recentF).at(-1);
  writePriceCache(data, 'SPY', readPriceCache(data, 'SPY').filter(r => r[0] < d0));
  const api = await fakeWorker({ charts: {} });                       // бары не отдаёт: Yahoo не знает бенчмарков
  try {
    const code = await morningMain(['--state', work, '--data', data, '--site', join(work, 'site'), '--date', recentF, '--no-sync', '--no-live', '--no-index-check', '--once'], { PAPER_URL: api.base, PAPER_TOKEN: 'tok' });
    assert.equal(code, 1); assert.equal(api.calls.morningPuts.length, 0); assert.ok(!existsSync(join(work, 'done', `${recentF}.json`)));
  } finally { await api.close(); rmSync(work, { recursive: true, force: true }); }
});

// --- письмо: отметка в воркере, уточнение, сверка ---
function notifyW(dir, { tg, worker, args = [], env = {} }) {
  return new Promise(resolve => execFile(process.execPath,
    ['--import', pathToFileURL(REDIRECT).href, ...NOTIFY_ARGS(dir), ...args],
    { encoding: 'utf8', env: { ...process.env, FAKE_TG_BASE: tg, TELEGRAM_BOT_TOKEN: 'TEST', TELEGRAM_CHAT_ID: '1', NEXUS_EVENTS_URL: tg + '/nexus', NEXUS_INGEST_TOKEN: 'TEST', MORNING_URL: worker, ...env } },
    (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: stdout + stderr })));
}
await okAsync('notify: отметка в воркере — письмо за дату уходит один раз на двоих отправителей', async () => {
  const d = nDay(-1);
  const wk = await fakeWorker(), tg = await fakeApis([]);
  try {
    // VPS: токен есть -> после доставки кладёт отметку
    const dirV = seededDir('data-mk-vps');
    writeMorning([mDay(d, [mRow('AAA', 3e5)])]);
    const r1 = await notifyW(dirV, { tg: tg.base, worker: wk.base, args: ['--sender', 'vps'], env: { PAPER_TOKEN: 'tok' } });
    assert.equal(r1.code, 0, r1.out); assert.equal(tg.calls.tg.length, 1);
    assert.equal(wk.calls.markerPuts.length, 1); assert.equal(wk.calls.markerPuts[0].date, d);
    assert.equal(wk.calls.markerPuts[0].body.by, 'vps'); assert.equal(wk.calls.markerPuts[0].auth, 'Bearer tok');
    // GitHub позже, чистое состояние: отметка есть — письма нет, дата записана отправленной
    const dirG = seededDir('data-mk-gh');
    writeMorning([mDay(d, [mRow('AAA', 3e5)])]);
    const r2 = await notifyW(dirG, { tg: tg.base, worker: wk.base });
    assert.equal(r2.code, 0, r2.out); assert.equal(tg.calls.tg.length, 1, 'второго письма нет'); assert.match(r2.out, /уже отправлено \(vps/);
    assert.ok(sentOf(dirG).includes(`morning|${d}`)); assert.equal(wk.calls.markerPuts.length, 1, 'у GitHub токена нет — отметку не пишет');
    // повтор VPS на чистом состоянии (повторный запуск юнита): тоже без дубля
    const dirV2 = seededDir('data-mk-vps2');
    writeMorning([mDay(d, [mRow('AAA', 3e5)])]);
    const r3 = await notifyW(dirV2, { tg: tg.base, worker: wk.base, args: ['--sender', 'vps'], env: { PAPER_TOKEN: 'tok' } });
    assert.equal(tg.calls.tg.length, 1);
    // GitHub, когда отметки нет: письмо уходит, отметка не пишется (токена нет)
    const wk2 = await fakeWorker();
    try {
      const dirG2 = seededDir('data-mk-gh2');
      writeMorning([mDay(d, [mRow('AAA', 3e5)])]);
      const r4 = await notifyW(dirG2, { tg: tg.base, worker: wk2.base });
      assert.equal(r4.code, 0, r4.out); assert.equal(tg.calls.tg.length, 2); assert.equal(wk2.calls.markerPuts.length, 0);
    } finally { await wk2.close(); }
    // воркер недоступен: пропущенное письмо хуже редкого дубля — уходит
    const dirD = seededDir('data-mk-down');
    writeMorning([mDay(d, [mRow('AAA', 3e5)])]);
    const r5 = await notifyW(dirD, { tg: tg.base, worker: 'http://127.0.0.1:9' });
    assert.equal(r5.code, 0, r5.out); assert.equal(tg.calls.tg.length, 3);
  } finally { await wk.close(); await tg.close(); }
});
await okAsync('notify: уточнение, когда полный пересчёт разошёлся со списком, отправленным с VPS; раз на дату', async () => {
  const d = nDay(-1);
  const cc = { listFor: d, vpsBuiltAt: 'x', same: false, vps: 2, github: 2, diff: [
    { t: 'NEWB', name: 'NEWB HOLDINGS INC', was: null, now: 3, val: 7e5 }, { t: 'UPPA', name: 'UPPA CORP', was: 2, now: 3, val: 2e5 }, { t: 'GONE', name: 'GONE INC', was: 2, now: null, val: 1e5 },
  ] };
  const wk = await fakeWorker({ markers: { [d]: { by: 'vps', at: '2026-11-05T03:05:00Z', ok: true } } }), tg = await fakeApis([]);
  try {
    const dir = seededDir('data-fix');
    writeJson(join(dir, 'state', 'notify.json'), { version: 4, sentMorning: [`morning|${d}`] });
    writeMorning([mDay(d, [mRow('UPPA', 2e5, { score: 3 })])], mCounter, { crossCheck: cc });
    const r1 = await notifyW(dir, { tg: tg.base, worker: wk.base });
    assert.equal(r1.code, 0, r1.out); assert.equal(tg.calls.tg.length, 1);
    const text = tg.calls.tg[0].body.text;
    assert.equal(text.split('\n')[0], '🔁 <b>Инсайдерский радар · список уточнён</b>');
    assert.match(text, new RegExp(`\\+ <b>NEWB</b> · Newb Holdings Inc · скор 3 · \\$700${NB}тыс\\.`));
    assert.match(text, /≈ <b>UPPA<\/b> · Uppa Corp · скор 2 → 3/); assert.match(text, /− <b>GONE<\/b> · Gone Inc убрана/);
    assert.deepEqual(tg.calls.nexus.map(b => b.eventId), [`840|fix|${d}`]);
    assert.ok(sentOf(dir).includes(`fix|${d}`));
    const r2 = await notifyW(dir, { tg: tg.base, worker: wk.base });
    assert.equal(tg.calls.tg.length, 1, 'второго уточнения нет');
    // письмо отправил GitHub (отметки VPS нет) — уточнять нечего; совпавшие списки — тоже
    const wk2 = await fakeWorker({ markers: { [d]: { by: 'github', at: '2026-11-05T03:30:00Z', ok: true } } });
    try {
      const dir2 = seededDir('data-fix2');
      writeJson(join(dir2, 'state', 'notify.json'), { version: 4, sentMorning: [`morning|${d}`] });
      writeMorning([mDay(d, [mRow('UPPA', 2e5, { score: 3 })])], mCounter, { crossCheck: cc });
      await notifyW(dir2, { tg: tg.base, worker: wk2.base });
      writeMorning([mDay(d, [mRow('UPPA', 2e5, { score: 3 })])], mCounter, { crossCheck: { ...cc, same: true, diff: [] } });
      await notifyW(dir, { tg: tg.base, worker: wk.base, args: ['--any-date'] });
      assert.equal(tg.calls.tg.length, 1);
    } finally { await wk2.close(); }
  } finally { await wk.close(); await tg.close(); }
});
await okAsync('crosscheck.mjs: пишет crossCheck в morning.json по списку VPS за ту же дату; без списка, за другую дату или при недоступном воркере молчит', async () => {
  const d = nDay(-1);
  const row = (t, score) => ({ t, name: t, score, main: score >= 2, val: 1e5 });
  const mj = (rows, extra = {}) => JSON.stringify({ built: d, listFor: d, builtAt: '2026-11-05T03:05:00.000Z', builder: 'vps', params: {}, counter: { main: { n: 0 } }, days: [{ date: d, rows }], ...extra });
  const site = join(NTMP, 'site-cc');
  const run = base => new Promise(resolve => execFile(process.execPath, [join(ROOT, 'scripts', 'crosscheck.mjs'), '--site', site], { encoding: 'utf8', env: { ...process.env, MORNING_URL: base } }, (err, so, se) => resolve({ code: err ? 1 : 0, out: so + se })));
  const mine = rows => writeJson(join(site, 'data', 'morning.json'), { ...JSON.parse(mj(rows)), builder: 'github', builtAt: '2026-11-05T04:25:00.000Z' });
  mkdirSync(join(site, 'data'), { recursive: true });
  // нет списка VPS
  let wk = await fakeWorker();
  try {
    mine([row('A', 3)]);
    const r0 = await run(wk.base); assert.equal(r0.code, 0); assert.match(r0.out, /списка VPS нет/); assert.equal(readJson(join(site, 'data', 'morning.json')).crossCheck, undefined);
  } finally { await wk.close(); }
  // списки совпали
  wk = await fakeWorker({ morning: JSON.parse(mj([row('A', 3), row('B', 1)])) });
  try {
    mine([row('A', 3), row('B', 0)]);
    const r1 = await run(wk.base); assert.match(r1.out, /списки совпали/);
    assert.deepEqual(readJson(join(site, 'data', 'morning.json')).crossCheck, { listFor: d, vpsBuiltAt: '2026-11-05T03:05:00.000Z', same: true, vps: 1, github: 1, diff: [] });
    // расхождение
    mine([row('A', 3), row('C', 2)]);
    const r2 = await run(wk.base); assert.match(r2.out, /РАСХОЖДЕНИЕ/);
    const cc = readJson(join(site, 'data', 'morning.json')).crossCheck;
    assert.equal(cc.same, false); assert.deepEqual(cc.diff.map(x => [x.t, x.was, x.now]), [['C', null, 2]]);
  } finally { await wk.close(); }
  // у VPS список за другую дату
  wk = await fakeWorker({ morning: { ...JSON.parse(mj([row('A', 3)])), listFor: addDaysIso(d, -1) } });
  try { mine([row('A', 3)]); assert.match((await run(wk.base)).out, /не за /); } finally { await wk.close(); }
  // воркер недоступен
  mine([row('A', 3)]);
  const r3 = await run('http://127.0.0.1:9'); assert.equal(r3.code, 0); assert.match(r3.out, /недоступен/);
});

rmSync(NTMP, { recursive: true, force: true });

// ==================== СБОР: календарь, сбои сети, добор, дедуп, разбор индекса (PR fix-collect-1) ====================
// Ревизия данных 04.11.2026 (audit-840-data-2026-11/REVIEW-DATA.md, дефекты П1, П4, П5, П6, П7, П12).
{
  const { missingIndexVerdict, shouldProbeNext, nextWeekday, coverageEntry, pruneCoverage, listDayOf } = await import('./lib/livecal.mjs');
  const { uniqueFilings, normalizeXmlDate } = await import('./lib/edgar.mjs');
  const { readJsonGz } = await import('./lib/util.mjs');

  ok('сбор/П1: праздник SEC в будний день не задерживает следующий день (07.09, 12.10, 11.11)', () => {
    // прогон 03:25 UTC в среду после Дня труда: понедельника нет — это праздник, вторник читается сразу
    assert.equal(missingIndexVerdict('2026-09-07', '2026-09-09'), 'holiday');
    assert.equal(missingIndexVerdict('2026-10-12', '2026-10-14'), 'holiday');
    // День ветеранов — среда; прогон 03:25 UTC в пятницу: четверг читается в пятницу, а не в субботу
    assert.equal(missingIndexVerdict('2026-11-11', '2026-11-13'), 'holiday');
    // прежнее правило (day + 2 ≥ today) здесь давало «ещё не вышел» и сдвигало день на сутки
    assert.equal(addDaysIso('2026-09-07', 2) >= '2026-09-09', true, 'контроль: старое правило остановилось бы');
  });

  ok('сбор/П1: индекс вчерашнего дня может быть ещё не вышедшим (прогон в 00:30 UTC)', () => {
    // 00:30 UTC 05.11 = 19:30 ET 04.11: индекс 04.11 выйдет в 22:02 ET — стоп, а не праздник
    assert.equal(missingIndexVerdict('2026-11-04', '2026-11-05'), 'not-published');
    assert.equal(missingIndexVerdict('2026-11-05', '2026-11-05'), 'not-published');
    // проба следующего рабочего дня: она возможна, только если тот день не позже сегодня
    assert.equal(shouldProbeNext('2026-11-04', '2026-11-05'), true);
    assert.equal(shouldProbeNext('2026-11-05', '2026-11-05'), false);
    assert.equal(nextWeekday('2026-11-06'), '2026-11-09');
    // если индекс следующего рабочего дня уже есть, отсутствующий — праздник при любом времени запуска
    assert.equal(missingIndexVerdict('2026-11-04', '2026-11-05', true), 'holiday');
  });

  ok('список: listFor — последний рабочий день с разобранным индексом, не выходной и не праздник', () => {
    // субботний прогон проходит субботу: lastDay = суббота, а список — за пятницу
    assert.equal(listDayOf({ lastDay: '2026-11-07' }), '2026-11-06');
    assert.equal(listDayOf({ lastDay: '2026-11-08' }), '2026-11-06');
    // праздник (День ветеранов) и «ещё не вышел» пропускаются, разобранный день — нет
    const coverage = { '2026-11-10': { status: 'complete' }, '2026-11-11': { status: 'holiday' }, '2026-11-12': { status: 'not-published' } };
    assert.equal(listDayOf({ lastDay: '2026-11-12', coverage }), '2026-11-10');
    assert.equal(listDayOf({ lastDay: '2026-11-10', coverage }), '2026-11-10');
    // частично разобранный день — тоже день списка (письмо скажет, что разобран не полностью)
    assert.equal(listDayOf({ lastDay: '2026-11-10', coverage: { '2026-11-10': { status: 'partial' } } }), '2026-11-10');
    assert.equal(listDayOf(null), null);
    assert.equal(listDayOf({ lastDay: 'x' }), null);
  });

  ok('сбор/П5, П12: строка индекса с двойным пробелом в имени, дедуп по номеру подачи', () => {
    const idx = [
      '4                DANIELS  ROBERT P                                             1269019     20261103    edgar/data/1269019/0000821189-26-000209.txt     ',
      '4                EOG RESOURCES INC                                             821189      20261103    edgar/data/821189/0000821189-26-000209.txt   ',
      '4/A              MURDOCH  KEITH RUPERT                                         1024835     20261103    edgar/data/1024835/0001628280-26-055398.txt',
      '424B2            BANK                                                          1           20261103    edgar/data/1/0000000001-26-000001.txt',
    ].join('\r\n');
    const e = parseFormIdx(idx);
    assert.equal(e.length, 3);
    assert.deepEqual(e.map(x => x.path), ['edgar/data/1269019/0000821189-26-000209.txt', 'edgar/data/821189/0000821189-26-000209.txt', 'edgar/data/1024835/0001628280-26-055398.txt']);
    assert.deepEqual(e.map(x => x.cik), [1269019, 821189, 1024835]);
    assert.equal(e[2].form, '4/A');
    const u = uniqueFilings(e);
    assert.equal(u.length, 2, 'одна подача под двумя CIK качается один раз');
    assert.equal(u[0].acc, '0000821189-26-000209');
  });

  ok('сбор/П7: дата сделки со смещением пояса — та же календарная дата', () => {
    assert.equal(normalizeXmlDate('2026-10-28-05:00'), '2026-10-28');
    assert.equal(normalizeXmlDate('2026-10-28+0300'), '2026-10-28');
    assert.equal(normalizeXmlDate('2026-10-28Z'), '2026-10-28');
    assert.equal(normalizeXmlDate('2026-10-28'), '2026-10-28');
    assert.equal(normalizeXmlDate('2026-06-31'), '2026-06-31', 'опечатки не чинятся — их отсекает isIsoDate');
    const xml = FORM4_XML.replace(/<transactionDate><value>[^<]*<\/value><\/transactionDate>/, '<transactionDate><value>2026-07-27-05:00</value></transactionDate>');
    const { trades } = parseForm4Txt(xml, '0000000000-26-000001', '2026-07-28');
    assert.ok(trades.some(t => t.tdate === '2026-07-27'), 'транзакция с датой в поясе не выброшена: ' + trades.map(t => t.tdate).join(','));
  });

  ok('сбор: запись покрытия по счётчикам', () => {
    assert.deepEqual(coverageEntry({ indexed: 3, collected: 3, pending: 0, at: 'X' }), { status: 'complete', indexed: 3, collected: 3, pending: 0, at: 'X' });
    assert.equal(coverageEntry({ indexed: 3, collected: 2, pending: 1, at: 'X' }).status, 'partial');
    assert.equal(coverageEntry({ indexed: 3, collected: 2, pending: 0, gone: 1, at: 'X' }).status, 'complete', 'снятая SEC подача не держит день неполным');
    assert.deepEqual(Object.keys(pruneCoverage({ '2026-09-01': {}, '2026-10-20': {} }, '2026-11-04')), ['2026-10-20']);
  });

  // ---------- сквозной прогон live.mjs против подставного EDGAR ----------
  const CTMP = join(ROOT, '.selftest-collect');
  rmSync(CTMP, { recursive: true, force: true });
  const accN = n => `0000000009-26-${String(n).padStart(6, '0')}`;
  const pathOf = (cik, acc) => `edgar/data/${cik}/${acc.replace(/-/g, '')}/${acc}.txt`;
  const form4 = (acc, { cik = 555000, sym = 'TSTA', date = '2026-09-04', sh = 1000, px = 20, owner = 'Doe John' } = {}) =>
    `<SEC-DOCUMENT>${acc}.txt\n<ACCEPTANCE-DATETIME>20260908171500\n<XML>\n<ownershipDocument><documentType>4</documentType>` +
    `<issuer><issuerCik>${cik}</issuerCik><issuerTradingSymbol>${sym}</issuerTradingSymbol></issuer><aff10b5One>0</aff10b5One>` +
    `<reportingOwner><reportingOwnerId><rptOwnerCik>777</rptOwnerCik><rptOwnerName>${owner}</rptOwnerName></reportingOwnerId>` +
    `<reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>CFO</officerTitle></reportingOwnerRelationship></reportingOwner>` +
    `<nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle>` +
    `<transactionDate><value>${date}</value></transactionDate><transactionCoding><transactionCode>P</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>` +
    `<transactionAmounts><transactionShares><value>${sh}</value></transactionShares><transactionPricePerShare><value>${px}</value></transactionPricePerShare>` +
    `<transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>` +
    `<postTransactionAmounts><sharesOwnedFollowingTransaction><value>${sh * 10}</value></sharesOwnedFollowingTransaction></postTransactionAmounts>` +
    `<ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction></nonDerivativeTable>` +
    `</ownershipDocument>\n</XML>\n</SEC-DOCUMENT>`;
  const idxLine = (name, cik, day, path) => `4                ${name.padEnd(62)}${String(cik).padEnd(12)}${day.replace(/-/g, '')}    ${path}`;
  const S3_MISSING = '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>';
  const RATE_HTML = '<html><body><h1>Your Request Originates from an Undeclared Automated Tool</h1>Request Rate Threshold Exceeded</body></html>';

  // Сценарий: 04.09 (пт) уже собран; 07.09 — День труда; 08.09 — четыре подачи; 09.09 — одна; 10.09 — индекс отвечает 503.
  const A = accN(1), B = accN(2), C = accN(3), D = accN(4), E = accN(5), OLD = accN(9);
  const files = {
    [pathOf(1269019, A)]: { body: form4(A, { sym: 'AAA' }) }, [pathOf(555000, A)]: { body: form4(A, { sym: 'AAA' }) },
    [pathOf(555000, B)]: { body: form4(B, { sym: 'BBB' }), fail: ['ratelimit'] },
    [pathOf(555000, C)]: { body: form4(C, { sym: 'CCC' }), fail: ['503', '503', '503', '503', '503', '503'] },
    [pathOf(555000, D)]: { body: form4(D, { sym: 'DDD', date: '2026-09-04-05:00' }) },
    [pathOf(555000, E)]: { body: form4(E, { sym: 'EEE', date: '2026-09-08' }) },
    [pathOf(555000, OLD)]: { body: form4(OLD, { sym: 'OLD', date: '2026-09-03-05:00' }) },
  };
  const index = {
    '2026-09-07': 'missing',
    '2026-09-08': ['Form Type   Company Name   CIK   Date Filed   File Name', '-'.repeat(80),
      idxLine('DOE  JOHN', 1269019, '2026-09-08', pathOf(1269019, A)), idxLine('TEST ISSUER A', 555000, '2026-09-08', pathOf(555000, A)),
      idxLine('TEST ISSUER B', 555000, '2026-09-08', pathOf(555000, B)), idxLine('TEST ISSUER C', 555000, '2026-09-08', pathOf(555000, C)),
      idxLine('TEST ISSUER D', 555000, '2026-09-08', pathOf(555000, D))].join('\n'),
    '2026-09-09': 'missing',
    '2026-09-10': '503',
  };
  const hits = [];
  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url);
    hits.push(url);
    const im = /daily-index\/\d{4}\/QTR\d\/form\.(\d{4})(\d{2})(\d{2})\.idx$/.exec(url);
    if (im) {
      const v = index[`${im[1]}-${im[2]}-${im[3]}`] ?? 'missing';
      if (v === 'missing') { res.writeHead(403, { 'content-type': 'application/xml' }); res.end(S3_MISSING); return; }
      if (v === '503') { res.writeHead(503); res.end('busy'); return; }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end(v); return;
    }
    const f = files[url.replace(/^\/Archives\//, '')];
    if (!f) { res.writeHead(404); res.end(); return; }
    const step = f.fail?.shift();
    if (step === 'ratelimit') { res.writeHead(403, { 'content-type': 'text/html' }); res.end(RATE_HTML); return; }
    if (step === '503') { res.writeHead(503); res.end('busy'); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end(f.body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const runLive = todayIso => new Promise(resolve => execFile(process.execPath,
    [join(ROOT, 'scripts', 'live.mjs'), '--data', CTMP, '--today', todayIso, '--retries', '1', '--time-budget-min', '5', '--reread-budget-min', '1'],
    { encoding: 'utf8', env: { ...process.env, EDGAR_BASE: base, POLITE_BACKOFF_MS: '5' } },
    (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: stdout + stderr })));
  const liveState = () => JSON.parse(readFileSync(join(CTMP, 'state', 'live.json'), 'utf8'));
  const liveRows = () => readJsonGz(join(CTMP, 'trades', 'live.json.gz')).trades;
  try {
    mkdirSync(join(CTMP, 'state'), { recursive: true });
    writeJson(join(CTMP, 'state', 'live.json'), { schema: SHARD_VERSION, from: '2026-09-01', lastDay: '2026-09-04', staleFloor: 1 });
    // строка старого парсера: дата сделки в поясе, без ownD — её должна починить сама сборка
    writeJsonGz(join(CTMP, 'trades', 'live.json.gz'), { v: SHARD_VERSION, amend: [], trades: [
      { acc: OLD, form: '4', fdate: '2026-09-04', tdate: '2026-09-03-05:00', cik: 555000, t: 'OLD', owners: [{ cik: 777, name: 'Doe John', rel: 'OF', title: 'CFO' }], code: 'P', sh: 1000, px: 20, val: 20000, own: 10000, di: 'D', b5: 0, orig: null, sec: 'Common Stock', fn: {} },
    ] });

    await okAsync('сбор/П1, П4, П6, П12: прогон в среду 03:25 UTC после Дня труда', async () => {
      const r = await runLive('2026-09-09');
      assert.equal(r.code, 0, r.out);
      const s = liveState();
      assert.equal(s.coverage['2026-09-07'].status, 'holiday', 'понедельник — праздник, а не «ещё не вышел»');
      const c8 = s.coverage['2026-09-08'];
      assert.equal(c8.status, 'partial', JSON.stringify(c8));
      assert.equal(c8.indexed, 4, 'подачи считаются по номерам, не по строкам индекса');
      assert.equal(c8.collected, 3);
      assert.equal(c8.pending, 1);
      assert.deepEqual(Object.keys(s.pending['2026-09-08']), [C], 'подача с 503 ждёт добора, а не теряется');
      assert.equal(s.coverage['2026-09-09'].status, 'not-published');
      assert.equal(s.lastDay, '2026-09-08', 'вторник пройден в среду, а не в четверг');
      const rows = liveRows();
      assert.deepEqual(rows.filter(x => x.code === 'P').map(x => x.t).sort(), ['AAA', 'BBB', 'DDD', 'OLD']);
      assert.equal(rows.find(x => x.t === 'DDD').tdate, '2026-09-04', 'дата с поясом нормализована');
      const old = rows.filter(x => x.t === 'OLD');
      assert.equal(old.length, 1, 'старая строка замещена, а не продублирована');
      assert.equal(old[0].tdate, '2026-09-03');
      assert.ok('ownD' in old[0], 'строка разобрана новым парсером');
      assert.equal(hits.filter(h => h.endsWith(A + '.txt')).length, 1, 'подача под двумя CIK скачана один раз');
      assert.equal(hits.filter(h => h.endsWith(B + '.txt')).length, 2, 'лимит SEC (403 с HTML) переждан и повторён');
    });

    await okAsync('сбор/П4, П6: 503 на индексе не роняет прогон; добор отложенной подачи', async () => {
      index['2026-09-09'] = ['x', idxLine('TEST ISSUER E', 555000, '2026-09-09', pathOf(555000, E))].join('\n');
      const r = await runLive('2026-09-10');
      assert.equal(r.code, 0, r.out);
      const s = liveState();
      // C ещё отвечает 503 (два повтора за прогон съели две неудачи из шести)
      assert.equal(s.coverage['2026-09-08'].status, 'partial');
      assert.equal(s.pending['2026-09-08'][C].tries, 2, 'счётчик попыток растёт');
      assert.equal(s.coverage['2026-09-09'].status, 'complete');
      assert.equal(s.coverage['2026-09-10'].status, 'not-published', 'индекс текущего дня ответил 503 — «ещё нет», стоп');
      assert.match(s.coverage['2026-09-10'].error, /503/);
      assert.equal(s.lastDay, '2026-09-09');
      assert.ok(liveRows().some(x => x.t === 'EEE'));
    });

    await okAsync('сбор/П6: отложенная подача добирается, день становится полным', async () => {
      files[pathOf(555000, C)].fail = [];
      index['2026-09-10'] = ['x'].join('\n');
      const r = await runLive('2026-09-11');
      assert.equal(r.code, 0, r.out);
      const s = liveState();
      assert.deepEqual(s.coverage['2026-09-08'], { ...s.coverage['2026-09-08'], status: 'complete', indexed: 4, collected: 4, pending: 0 });
      assert.equal(s.pending, undefined, 'очередь добора пуста');
      assert.equal(s.coverage['2026-09-10'].status, 'complete');
      assert.equal(s.coverage['2026-09-10'].indexed, 0);
      assert.ok(liveRows().some(x => x.t === 'CCC'));
      assert.equal(s.staleFloor, undefined, 'строк старой схемы не осталось — пол опустился до нуля');
    });
  } finally {
    await new Promise(r => server.close(r));
    rmSync(CTMP, { recursive: true, force: true });
  }
}

rmSync(TMP, { recursive: true, force: true });
console.log(`Самотесты: ${passed} ok${process.exitCode ? ', ЕСТЬ ПАДЕНИЯ' : ''}`);
