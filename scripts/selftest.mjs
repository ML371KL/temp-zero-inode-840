// Самотесты на фиксированных фикстурах. Правило: никаких утверждений, зависящих от дня
// недели запуска; динамические ряды строятся «до сегодня» так, чтобы классификация не менялась.
import { strict as assert } from 'node:assert';
import { execFileSync, execFile } from 'node:child_process';
import { rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { secDate, parseTsv, addDaysIso, isoToday, readJson, writeJson, writeJsonGz, readJsonGz, isIsoDate } from './lib/util.mjs';
import { zipCreate, zipExtract } from './lib/zip.mjs';
import { normalizeQuarterZip, relFlags, parseFormIdx, parseForm4Txt, acceptedAt, SHARD_VERSION } from './lib/edgar.mjs';
import {
  mergeSeries, writePriceCache, nominalFactor, sanitizeSeries, metaAcceptable, normalizeTiingo,
  trimFrozenTail, repairUnadjustedSplits, clipToInstrument, cutAtDataBreak, listedThrough, fetchYahooDaily, turnover20,
  parseYahooChart, readPriceCache, cachedTail, TAIL_KEEP,
} from './lib/prices.mjs';
import { barsFrom, fetchBars, applyBars } from './lib/bars.mjs';
import { isSecClosed, isMarketClosed } from './lib/calendar.mjs';
import * as buildCalendar from './lib/calendar.mjs';
import * as webCalendar from '../web/calendar.js';
import { missedSecDays, staleState, DEADLINE_NY_HOUR, STALE_MIN_MISSED } from '../web/stale.js';
import { main as morningMain, liveVerdict, reconcileStage, d0Verdict } from './vps/morning-build.mjs';
import { parseFeedJournal, loadFeed, pruneFeed, feedFile, reconcile, mergeFeedRows, parseAtom, filingPath } from './lib/feed.mjs';
import { buildDay, buildDayFull, tradeResult, summarize, breadth, bestRole, tagsOf, sessionOf, scoreOf, costOf, compareMain, prevDays } from './lib/morning.mjs';
import { HEALTH, healthY, healthDay, healthStep, nextStatus, healthTrace, signalHealth, looLimit } from './lib/morning.mjs';
import { pickOpens, mergeOpens, nextTradingDay, opensOf, readOpens, writeOpens } from './lib/opens.mjs';
import { nyWall, nyToMs } from './lib/nytime.mjs';
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
ok('mergeSeries: ответ, который кончается раньше кэша, последних баров кэша не стирает (IRTC 19.11.2026); длинный или далёкий хвост — прежнее правило', () => {
  // ряд IRTC в копии сервера: бар 19.11 записал прогон GitHub в 18:49, в 22:04 Yahoo отдал ряд с 16.11 по 18.11
  const c = [['2026-11-13', 91.91, 91.91, 917800], ['2026-11-16', 90.83, 90.83, 712100], ['2026-11-17', 89.665, 89.665, 590200], ['2026-11-18', 94.87, 94.87, 1198700], ['2026-11-19', 94.24, 94.24, 795224]];
  const f = c.slice(1, 4);
  assert.deepEqual(cachedTail(c, f), [c[4]]);
  assert.deepEqual(mergeSeries(c, f), c, 'бар 19.11 остался');
  // ответ дошёл до конца кэша — хвоста нет, свежее замещает, как раньше
  const f2 = [...f, ['2026-11-19', 94.24, 94.24, 800000], ['2026-11-20', 95, 95, 1e6]];
  assert.deepEqual(cachedTail(c, f2), []); assert.deepEqual(mergeSeries(c, f2), [c[0], ...f2]);
  // пропуск внутри ответа (день без торгов) — бар кэша внутри ряда по-прежнему замещается: хвост — только после конца ответа
  assert.deepEqual(mergeSeries(c, [c[1], c[3]]), [c[0], c[1], c[3], c[4]]);
  // хвост длиннее TAIL_KEEP.bars или дальше TAIL_KEEP.days от конца ответа — другой случай (делистинг, чужой инструмент), не держим
  assert.deepEqual(TAIL_KEEP, { bars: 3, days: 7, closeTol: 0.01, jump: 3 });
  const long = [...c, ['2026-11-20', 95, 95, 1e6], ['2026-11-23', 96, 96, 1e6]];
  assert.equal(cachedTail(long, f).length, 3, 'три бара после конца ответа — держим');
  const longer = [...long, ['2026-11-24', 97, 97, 1e6]];
  assert.deepEqual(cachedTail(longer, f), [], 'четыре — нет'); assert.deepEqual(mergeSeries(longer, f), c.slice(0, 4));
  const far = [...c.slice(0, 4), ['2026-11-26', 99, 99, 1e6]];
  assert.equal(cachedTail([...c.slice(0, 4), ['2026-11-25', 99, 99, 1e6]], f).length, 1, 'через 7 дней — держим');
  assert.deepEqual(cachedTail(far, f), [], 'через 8 дней — нет');
  for (const [a, b] of [[[], f], [null, f], [c, []], [c, null]]) assert.deepEqual(cachedTail(a, b), []);
  assert.deepEqual(mergeSeries(c, []), c); assert.deepEqual(mergeSeries([], f), f);
});
ok('mergeSeries: хвост держится только при согласованном стыке, без скачка и свежим ко дню прогона; adjclose хвоста — в базе ответа', () => {
  const c = [['2026-11-16', 90.83, 90.83, 712100], ['2026-11-17', 89.665, 89.665, 590200], ['2026-11-18', 94.87, 94.87, 1198700], ['2026-11-19', 94.24, 94.24, 795224]];
  const f = c.slice(0, 3);
  // обратный сплит 1:10 с отсечкой 19.11: кэш (прогон 18:49) уже пересчитан, ответ без бара 19.11 — ещё нет; хвост дал бы +900% за день
  const split = [['2026-11-17', 10, 10, 1e5], ['2026-11-18', 10, 10, 1e5], ['2026-11-19', 10, 10, 2e5]];
  const unadj = [['2026-11-17', 1, 1, 1e6], ['2026-11-18', 1, 1, 1e6]];
  assert.deepEqual(cachedTail(split, unadj), [], 'close на стыке разошёлся — прежнее правило');
  assert.deepEqual(mergeSeries(split, unadj), unadj);
  assert.equal(cachedTail([c[0], c[1], ['2026-11-18', 95.8, 95.8, 1], c[3]], f).length, 1, 'расхождение close до 1% — стык согласован');
  assert.deepEqual(cachedTail([c[0], c[1], ['2026-11-18', 96, 96, 1], c[3]], f), [], 'больше 1% — нет');
  // в кэше нет бара за последний день ответа — сверять не с чем
  assert.deepEqual(cachedTail([c[0], c[1], c[3]], f), []);
  // скачок close хвоста больше чем втрое от конца ответа — фантомный или чужой бар
  assert.equal(cachedTail([...f, ['2026-11-19', 284, 284, 1]], f).length, 1, 'втрое — ещё держим');
  assert.deepEqual(cachedTail([...f, ['2026-11-19', 285, 285, 1]], f), []);
  assert.deepEqual(cachedTail([...f, ['2026-11-19', 31.6, 31.6, 1]], f), [], 'падение больше чем втрое — тоже нет');
  // дивиденд 2% с отсечкой 19.11: кэш его учёл (adjclose 18.11 ниже close), ответ без бара 19.11 — ещё нет; adjclose хвоста переводится в
  // базу ответа, и доходность дня через стык та же, что в кэше: 94.24 / 92.9726 − 1 ≈ +1,36%, а не 94.24 / 94.87 − 1 ≈ −0,66%
  const div = [c[0], c[1], ['2026-11-18', 94.87, 92.9726, 1198700], c[3]];
  const t = cachedTail(div, f);
  assert.equal(t.length, 1); assert.deepEqual([t[0][0], t[0][1], t[0][3]], ['2026-11-19', 94.24, 795224], 'close и объём — как в кэше');
  assert.ok(Math.abs(t[0][2] / f[2][2] - div[3][2] / div[2][2]) < 1e-6, `доходность дня ${t[0][2] / f[2][2] - 1}`);
  assert.equal(mergeSeries(div, f).at(-1)[2], t[0][2]);
  // день прогона: хвост держится, если он не старше недели до него — ряд, который источник перестал продлевать, не держит хвост бессрочно
  assert.equal(cachedTail(c, f, { asOf: '2026-11-20' }).length, 1);
  assert.equal(cachedTail(c, f, { asOf: '2026-11-26' }).length, 1, 'ровно неделя');
  assert.deepEqual(cachedTail(c, f, { asOf: '2026-11-27' }), [], 'больше недели');
  assert.deepEqual(mergeSeries(c, f, { asOf: '2026-12-01' }), f);
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
  // признак «другие единицы» стоит на эмитенте, но отсеивает только строку с несходящейся ценой (A3, ниже)
  assert.equal(applyGates(base, { close: 50, unitsMismatch: true }).drop, 'units');
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

// ---------- здоровье сигнала (audit-840-health-2026-11-17/REPORT.md, раздел 3.10: самотесты 1–6) ----------
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} против ${b}`);
// n дней подряд (ISO-даты по порядку), по k сделок основного списка с доходностью r при IWM = 0
const flatDays = (n, k, r) => Array.from({ length: n }, (_, i) => addDaysIso('2026-08-17', i)).flatMap(day => Array.from({ length: k }, () => ({ day, main: true, r, b: 0 })));
ok('здоровье 1: мера сделки обрезается на −6% и +15%, средняя дня 3,3333%, вес 3', () => {
  const ys = [0.01, -0.10, 0.20].map(r => healthY(r, 0));
  assert.deepEqual(ys, [0.01, -0.06, 0.15]);
  const d = healthDay(ys);
  assert.equal(d.W, 3); assert.equal(d.n, 3); near(d.ybar, 0.033333, 1e-6, 'средняя дня');
  near(healthY(0.02, 0.01), 0.02 - 1.17 * 0.01, 1e-12, 'остаток с бетой 1,17');
  assert.deepEqual(healthDay([]), { n: 0, W: 0, ybar: null }, 'день без сделок основного списка — вес 0');
});
ok('здоровье 2: восемь сделок по +0,5% — вес дня 5, вклад в S_Y 0,025', () => {
  const d = healthDay(Array(8).fill(healthY(0.005, 0)));
  assert.equal(d.W, 5);
  const s = healthStep({ sw: 0, sy: 0, sw2: 0 }, d.W, d.ybar);
  near(s.sy, 0.025, 1e-12, 'S_Y'); assert.equal(s.sw, 5); assert.equal(s.sw2, 5);
  // день без сделок только затухает: λ = 0,5^(1/125)
  const s2 = healthStep(s, 0, null);
  near(s2.sw, 5 * 0.5 ** (1 / 125), 1e-12, 'затухание S_W'); near(s2.sw2, 5 * 0.5 ** (2 / 125), 1e-12, 'затухание S_W2'); near(s2.m, 0.005, 1e-12, 'm не меняется');
});
ok('здоровье 3: 250 дней по 4 сделки ровно по +0,37% — m 0,37%, z 0, S_W 542,512, se 0,1020%', () => {
  const last = healthTrace(flatDays(250, 4, 0.0037)).at(-1);
  near(last.m, 0.0037, 1e-12, 'm'); near(last.z, 0, 1e-9, 'z'); near(last.sw, 542.512, 5e-4, 'S_W'); near(last.se, 0.001020, 5e-7, 'se');
  assert.equal(last.s, 'normal');
});
ok('здоровье 4: 250 дней по 4 сделки ровно по 0% — z −3,629, тревога', () => {
  const tr = healthTrace(flatDays(250, 4, 0));
  near(tr.at(-1).z, -3.629, 5e-4, 'z'); assert.equal(tr.at(-1).s, 'alarm');
  assert.equal(tr[0].s, 'nodata', 'пока S_W < 100 — «мало данных»');
  const first = tr.findIndex(x => x.sw >= HEALTH.minW);
  assert.equal(tr[first - 1].s, 'nodata'); assert.notEqual(tr[first].s, 'nodata');
});
ok('здоровье 5: автомат статусов с гистерезисом', () => {
  const seq = [[-1.6, 'watch'], [-1.2, 'watch'], [-0.9, 'normal'], [-2.3, 'alarm'], [-1.6, 'alarm'], [-1.2, 'watch'], [-0.9, 'normal']];
  let st = 'normal';
  for (const [z, want] of seq) { st = nextStatus(st, z); assert.equal(st, want, `z ${z}`); }
  assert.equal(nextStatus('normal', -1.55), 'watch', 'ровно −1,55 — наблюдение'); assert.equal(nextStatus('watch', -2.25), 'alarm', 'ровно −2,25 — тревога');
  assert.equal(nextStatus('watch', -1.0), 'watch', 'ровно −1,0 — ещё наблюдение'); assert.equal(nextStatus('alarm', -1.55), 'alarm', 'ровно −1,55 — ещё тревога');
  assert.equal(nextStatus('alarm', -0.5), 'normal', 'из тревоги сразу в норму'); assert.equal(nextStatus('watch', null), 'watch', 'нет z — без изменений');
});
ok('здоровье 6: лимит LOO как у бота — 11,01 при закрытии D0 10,00 пропуск limit, 11,00 считается', () => {
  const I = [200, 201, 199], S = [400, 404, 399];
  assert.equal(tradeResult([11.01, 11.5, 10.00], I, S).skip, 'limit');
  assert.equal(tradeResult([11.00, 11.5, 10.00], I, S).skip, undefined);
  assert.equal(tradeResult([11.00, 11.5, 10.00, 12345], I, S).r, 0.0455, 'с объёмом — так же');
  assert.equal(tradeResult([14.325, 13.66, 12.98, 13023500], I, S).skip, 'limit', 'GLXY 06.11.2026: разрыв +10,4%');
  assert.equal(tradeResult([69, 66.51, 62.22, 5101600], I, S).skip, 'limit', 'TTMI 06.11.2026: разрыв +10,9%');
  assert.equal(tradeResult([11.5, 11.6, null], I, S).skip, undefined, 'нет закрытия D0 — лимит не проверяется');
  assert.equal(looLimit(12.98), 14.27, 'вниз до цента'); assert.equal(looLimit(10), 11);
});
ok('здоровье: поле health — смены, «с какого дня», пороги, справочные строки, ряд не длиннее 250 дней', () => {
  // 30 дней по 4 сделки +0,37% (мало данных), затем 270 дней по 4 сделки 0% — норма, наблюдение, тревога; плюс скор 0–1 по +0,1%
  const tr = [...flatDays(300, 4, 0.0037).slice(0, 120), ...flatDays(300, 4, 0).slice(120)].map(x => ({ ...x, score: 3, cost: 0.001, ex: x.r, exS: x.r }));
  const rest = Array.from({ length: 300 }, (_, i) => ({ day: addDaysIso('2026-08-17', i), main: false, score: 1, r: 0.001, b: 0, cost: 0.0015, ex: 0.001, exS: 0.001 }));
  const h = signalHealth([...tr, ...rest]);
  assert.equal(h.from, '2026-08-17'); assert.equal(h.days, 300); assert.equal(h.n, 1200);
  assert.equal(h.series.length, 250, 'ряд — последние 250 дней'); assert.equal(h.series.at(-1).d, h.asOf);
  assert.deepEqual(h.changes.map(c => [c.from, c.to]), [['nodata', 'normal'], ['normal', 'watch'], ['watch', 'alarm']]);
  assert.equal(h.status, 'alarm'); assert.equal(h.since, h.changes.at(-1).d);
  assert.ok(h.changes[1].z <= -1.55 && h.changes[2].z <= -2.25);
  near(h.thrWatch, 0.0037 - 1.55 * h.se, 1e-6, 'порог наблюдения'); near(h.thrAlarm, 0.0037 - 2.25 * h.se, 1e-6, 'порог тревоги');
  assert.equal(h.spread.days, 250); assert.equal(h.spread.nMain, 1000); assert.equal(h.spread.nRest, 250);
  near(h.spread.diff, 0 - 0.001, 1e-9, 'основной список минус скор 0–1 за 250 дней');
  assert.equal(h.live.n, 1200); near(h.live.net, (120 * 0.0037) / 1200 - 0.001, 5e-5, 'после издержек (среднее округлено до 0,01 п.п.)');
  assert.equal(h.params.mu0, 0.0037); assert.equal(signalHealth([]), null);
  // день только со сделками скора 0–1: показатель затухает, но день считается
  const t2 = signalHealth([{ day: '2026-08-17', main: true, r: 0.01, b: 0, cost: 0.001, ex: 0.01, exS: 0.01 }, { day: '2026-08-18', main: false, r: 0.01, b: 0, cost: 0.001, ex: 0.01, exS: 0.01 }]);
  assert.equal(t2.days, 2); near(t2.sw, 0.5 ** (1 / 125), 1e-3, 'затух'); assert.equal(t2.status, 'nodata'); assert.deepEqual(t2.changes, []); assert.equal(t2.since, '2026-08-17');
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

// ---------- время по Нью-Йорку и лента getcurrent (лента на весь день, сборка на VPS) ----------
ok('время по Нью-Йорку: переход на зимнее время, путь полного текста формы', () => {
  assert.equal(nyToMs('2026-07-01T17:00:00'), Date.parse('2026-07-01T21:00:00Z'), 'летом UTC−4');
  assert.equal(nyToMs('2026-11-04T17:00:00'), Date.parse('2026-11-04T22:00:00Z'), 'зимой UTC−5');
  assert.equal(nyToMs('2026-11-04T17:00'), Date.parse('2026-11-04T22:00:00Z'), 'секунды необязательны');
  assert.equal(nyWall(Date.parse('2026-11-04T22:21:35Z')), '2026-11-04T17:21:35');
  assert.equal(nyToMs('мусор'), null);
  assert.equal(filingPath(123, '0001-26-000001'.replace('0001', '0000000001')), 'edgar/data/123/000000000126000001/0000000001-26-000001.txt');
});
ok('лента getcurrent: формы без повторов, поправки и чужие типы различимы', () => {
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
// Журнал закрытой вечерней схемы остаётся на ветке data (data/paper/log): сборка его больше не читает, раздела paper в morning.json нет
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

ok('compute: старый журнал вечерней схемы в данных не даёт раздела paper', () => {
  assert.ok(existsSync(join(TMP, 'paper', 'log', '2026-01-01.jsonl')), 'журнал в данных есть');
  assert.equal('paper' in R('morning.json'), false);
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
  // здоровье сигнала: одна сделка с подачи после HEALTH.from — мера с бетой 1,17, «мало данных»
  const h = m.health;
  assert.ok(h, 'поле health в morning.json');
  assert.equal(h.from, d1L); assert.equal(h.asOf, d1L); assert.equal(h.n, 1); assert.equal(h.days, 1);
  assert.equal(h.status, 'nodata'); assert.equal(h.sw, 1); near(h.m, 0.02 - 1.17 * 0.005, 1e-6, 'перевес: +2% минус 1,17 × IWM +0,5%');
  assert.deepEqual(h.series.map(x => x.d), [d1L]); assert.deepEqual(h.changes, []); assert.equal(h.live.n, 1); assert.equal(h.live.mean, 0.015);
  const old = m.days.find(d => d.date === '2020-02-05');
  assert.ok(old && !old.done && old.entry === null, 'у старых подач дня входа в хранилище нет — результат не выдумывается');
  const b = R('stats.json').breadth;
  assert.ok(b && b.history.length <= 60 && b.thr === 2, 'поле breadth в stats.json');
  assert.ok(b.asOf < isoToday().slice(0, 7), 'текущим считается последний ЗАВЕРШЁННЫЙ месяц');
});

// --- повтор (prev) сквозным прогоном: полная сборка и сборка на VPS (--only-morning) на одних данных дают одно и то же поле ---
ok('compute: prev в строках morning.json — прошлый день подачи эмитента с покупкой от $10 тыс., прошедшей гейты; полная сборка = --only-morning', () => {
  const P = join(TMP, '..', '.selftest-prev');
  rmSync(P, { recursive: true, force: true });
  mkdirSync(join(P, 'state'), { recursive: true });
  for (const b of ['SPY', 'IWM']) writePriceCache(P, b, bizDays('2023-01-02', today).map(d => [d, 100, 100, 1e6]));
  for (const t of ['PRVA', 'PRVB', 'PRVC']) writePriceCache(P, t, bizDays('2024-01-02', today).map(d => [d, 20, 20, 1e6]));   // $20 млн в день
  writeJson(join(P, 'reference', 'tickers.json'), {
    444: { ticker: 'PRVA', exchange: 'NYSE', name: 'Prev A' }, 555: { ticker: 'PRVB', exchange: 'Nasdaq', name: 'Prev B' },
    666: { ticker: 'PRVC', exchange: 'NYSE', name: 'Prev C' },
  });
  const FA = bizDays('2024-01-02', addDaysIso(today, -20)).at(-1), FB = bizDays('2024-01-02', addDaysIso(today, -6)).at(-1);
  const t = { 444: 'PRVA', 555: 'PRVB', 666: 'PRVC' };
  const buy = (acc, cik, fdate, owners, val, extra = {}) => T({ acc, cik, t: t[cik], fdate, tdate: addDaysIso(fdate, -1), owners, code: 'P', sh: val / 20, px: 20, val, own: 1e5, ...extra });
  writeJsonGz(join(P, 'trades', 'live.json.gz'), {
    v: SHARD_VERSION,
    trades: [
      buy('P1', 444, addDaysIso(FA, -10), dir, 20000),                 // прошлое событие PRVA: $20 тыс., прошло гейты
      buy('P2', 444, addDaysIso(FA, -3), ceo, 50000, { fn: { b5: 1 } }), // плановая — гейт отсеивает, не считается
      buy('P3', 444, addDaysIso(FA, -2), ceo, 5000),                   // меньше $10 тыс. — не считается
      buy('P4', 444, FA, ceo, 150000),
      buy('P5', 444, FB, ceo, 150000),
      buy('P6', 555, addDaysIso(FB, -400), dir, 30000),
      buy('P7', 555, addDaysIso(FB, -366), dir, 30000),                // 366 дней — вне окна
      buy('P8', 555, FB, ceo, 150000),
      buy('P9', 666, addDaysIso(FA, -365), dir, 30000),                // ровно 365 дней — в окне
      buy('P10', 666, FA, ceo, 150000),
    ],
    amend: [],
  });
  const run = (site, extra) => execFileSync(process.execPath, [join(ROOT, 'scripts', 'compute.mjs'), '--data', P, '--site', join(P, site), '--counter-from', addDaysIso(today, -30), ...extra], { stdio: 'pipe' });
  try {
    run('full', []); run('lean', ['--only-morning', '--builder', 'vps']);
    const rowsOf = site => {
      const m = readJson(join(P, site, 'data', 'morning.json'));
      return Object.fromEntries(m.days.flatMap(d => d.rows.map(r => [`${d.date}|${r.t}`, r])));
    };
    const full = rowsOf('full'), lean = rowsOf('lean');
    assert.equal(full[`${FA}|PRVA`].prev, Math.round((Date.parse(FA) - Date.parse(addDaysIso(FA, -10))) / 864e5), 'плановая и мелкая покупки ближе не считаются');
    assert.equal(full[`${FA}|PRVA`].prev, 10);
    assert.equal(full[`${FB}|PRVA`].prev, Math.round((Date.parse(FB) - Date.parse(FA)) / 864e5));
    assert.equal(full[`${FB}|PRVB`].prev, null, 'прошлая покупка старше 365 дней — null');
    assert.equal(full[`${FA}|PRVC`].prev, 365);
    assert.equal(full[`${FA}|PRVA`].main, true); assert.equal(full[`${FB}|PRVB`].score, 2, 'отбор и скор от prev не зависят');
    assert.ok(Object.keys(full).length >= 4);
    assert.deepEqual(Object.keys(lean).sort(), Object.keys(full).sort(), 'сборка на VPS видит те же строки');
    for (const k of Object.keys(full)) assert.equal(lean[k].prev, full[k].prev, 'prev ' + k + ': --only-morning против полной сборки');
  } finally { rmSync(P, { recursive: true, force: true }); }
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
  assert.match(out, /Только заявки на аукционы: LOO до 9:28 \(лимит \+10% к закрытию дня подачи\) и MOC до 15:50 по Нью-Йорку\. Покупка по рынку после открытия дороже аукциона на 0,3–0,5% и съедает перевес дня\./);
  assert.ok(!/около 60%|первые 5 минут|MOO/i.test(out), 'устаревшие фразы об исполнении из письма убраны');
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

// ---------- здоровье сигнала в Telegram (audit-840-health-2026-11-17/REPORT.md, раздел 3.6) ----------
const hParams = { mu0: 0.0037, sig: 0.03, beta: 1.17, lo: -0.06, hi: 0.15, kcap: 5, half: 125, zWatch: -1.55, zAlarm: -2.25, zBack: -1, minW: 100, spreadDays: 250 };
const hC0 = { d: nDay(-60), from: 'nodata', to: 'normal', z: 0.67 };
const mHealth = (extra = {}) => ({
  from: `${nYear}-08-17`, asOf: nDay(-1), n: 294, days: 63, sw: 177.77, m: 0.00474, se: 0.00207, z: 0.5, status: 'normal', since: hC0.d,
  thrWatch: 0.000492, thrAlarm: -0.000957, params: hParams,
  spread: { days: 63, main: 0.0048, rest: 0.0021, diff: 0.0027, nMain: 294, nRest: 180 }, live: { n: 294, days: 59, mean: 0.0043, net: 0.0031, tDays: 2.36 },
  series: [], changes: [hC0], ...extra,
});
// Смена и файл здоровья на день смены: перевес и z в ряду, статус после смены
const hChange = (d, from, to, z, m, extra = {}) => ({ c: { d, from, to, z }, h: mHealth({ status: to, m, z, since: d, series: [{ d, m, z, s: to }], ...extra }) });
const sentHealthOf = dir => readJson(join(dir, 'state', 'notify.json'), {}).sentHealth;
// Состояние, в котором письма и здоровье уже пересеяны (как после первого прогона новой версии)
function healthDir(name) {
  const dir = freshDir(name);
  writeJson(join(dir, 'state', 'notify.json'), { version: 4, sentMorning: [`morning|${nDay(-9)}`], sentHealth: [] });
  return dir;
}
const hBase = [mDay(nDay(-9), [mRow('OLD', 3e5)])];   // уже отправленный список: писем нет, остаются только смены здоровья
ok('notify: строка здоровья сигнала — после строки счётчика в утреннем и пустом письме; значок у наблюдения и тревоги; «мало данных» — с датой начала', () => {
  const pdir = freshDir('data-hprev');
  const preview = health => {
    writeMorning([mDay(nDay(-1), [mRow('AAA', 3e5)])], mCounter, health ? { health } : {});
    return execFileSync(process.execPath, [...NOTIFY_ARGS(pdir), '--dry-run', '--preview'], { encoding: 'utf8' });
  };
  assert.match(preview(mHealth()), /Счётчик с 05\.11: сделок пока нет\.\nЗдоровье сигнала: норма · перевес за полгода \+0,47% \(история \+0,37%\)\n/);
  assert.match(preview(mHealth({ status: 'watch', m: 0.0018 })), /\nЗдоровье сигнала: ⚠️ наблюдение · перевес за полгода \+0,18% \(история \+0,37%\)\n/);
  assert.match(preview(mHealth({ status: 'alarm', m: -0.0005 })), /\nЗдоровье сигнала: 🛑 тревога · перевес за полгода −0,05% \(история \+0,37%\)\n/);
  assert.match(preview(mHealth({ status: 'nodata' })), /\nЗдоровье сигнала: мало данных \(с 17\.08\)\n/);
  assert.ok(!/Здоровье сигнала/.test(preview(null)), 'без поля health строки нет');
  const dir = healthDir('data-hempty');
  const out = notify([mDay(nDay(-1), [mRow('LOW', 2e5, REST)])], { dir, extra: { listFor: nDay(-1), health: mHealth() } });
  assert.match(out, /утренний список пуст/);
  assert.match(out, /Счётчик с 05\.11: сделок пока нет\.\nЗдоровье сигнала: норма · перевес за полгода \+0,47% \(история \+0,37%\)\n/);
});
ok('notify: смена статуса здоровья — одно сообщение на ключ health|D+1|статус: наблюдение, тревога, отбой; повтор невозможен', () => {
  const dir = healthDir('data-hchange');
  const W = hChange(nDay(-5), 'normal', 'watch', -1.6, 0.0018);
  let out = notify(hBase, { dir, extra: { health: { ...W.h, changes: [hC0, W.c] } } });
  assert.match(out, /смен статуса здоровья сигнала к отправке: 1/);
  assert.match(out, /🩺 Инсайдерский радар · здоровье сигнала: норма → наблюдение\n/);
  assert.match(out, /\nПеревес дня D\+1 за полгода \(сглаженный\): \+0,18% при историческом \+0,37%; z −1,6 \(наблюдение с −1,55, тревога с −2,25\)\.\n/);
  assert.match(out, /\nЧто делать: ступень не поднимать, торговать как есть\.\nСкор различает: \+0,27 п\.п\. с 17\.08\. Подробности — на панели\.\n/);
  assert.deepEqual(sentHealthOf(dir), [`health|${W.c.d}|watch`]);
  assert.match(notify(hBase, { dir, extra: { health: { ...W.h, changes: [hC0, W.c] } } }), /новых утренних списков нет/, 'тот же ключ второй раз не уходит');
  const A = hChange(nDay(-3), 'watch', 'alarm', -2.3, -0.0005, { spread: { days: 250, main: 0.001, rest: 0.0014, diff: -0.0004, nMain: 900, nRest: 600 } });
  out = notify(hBase, { dir, extra: { health: { ...A.h, changes: [hC0, W.c, A.c] } } });
  assert.match(out, /здоровье сигнала: наблюдение → тревога\n/);
  assert.match(out, /\nЧто делать: бот — на малую ступень, разбор причин; за 21 год такое было один раз \(май–июнь 2018\)\.\n/);
  assert.match(out, /\nСкор различает: −0,04 п\.п\. за год — скор не различает\. Подробности — на панели\./);
  assert.equal((out.match(/🩺/g) ?? []).length, 1, 'прежняя смена не повторяется');
  const N = hChange(nDay(-1), 'alarm', 'normal', -0.8, 0.003);
  out = notify(hBase, { dir, extra: { health: { ...N.h, changes: [hC0, W.c, A.c, N.c] } } });
  assert.match(out, /здоровье сигнала: тревога → норма\nПеревес за полгода \+0,30%, z −0,8\. Работа по плану\.\nПодробности — на панели\.\n/);
  assert.deepEqual(sentHealthOf(dir).sort(), [`health|${W.c.d}|watch`, `health|${A.c.d}|alarm`, `health|${N.c.d}|normal`].sort());
});
ok('notify: здоровье молча — первый прогон с полем health, выход из «мало данных» в норму, смена старше недели', () => {
  const dir = freshDir('data-hseed');
  notify(hBase, { dir });                                              // пересев писем без поля health
  assert.equal(sentHealthOf(dir), undefined, 'без поля health состояние здоровья не заводится');
  const W = hChange(nDay(-2), 'normal', 'watch', -1.6, 0.0018);
  let out = notify(hBase, { dir, extra: { health: { ...W.h, changes: [hC0, W.c] } } });
  assert.match(out, /здоровье сигнала: первый прогон — смены статуса из файла \(1\) считаются отправленными/);
  assert.ok(!/🩺/.test(out), 'историю не рассылаем');
  assert.deepEqual(sentHealthOf(dir), [`health|${W.c.d}|watch`]);
  const dir2 = healthDir('data-hquiet');
  const NN = { d: nDay(-1), from: 'nodata', to: 'normal', z: 0.5 };
  out = notify(hBase, { dir: dir2, extra: { health: mHealth({ changes: [NN] }) } });
  assert.ok(!/🩺/.test(out), 'выход из «мало данных» в норму сообщения не даёт');
  const old = { d: nDay(-10), from: 'normal', to: 'watch', z: -1.6 };
  out = notify(hBase, { dir: dir2, extra: { health: mHealth({ status: 'watch', changes: [hC0, old] }) } });
  assert.ok(!/🩺/.test(out)); assert.match(out, /старше 7 дней — не рассылается/);
  assert.deepEqual(sentHealthOf(dir2), [`health|${old.d}|watch`]);
  const dir3 = healthDir('data-hany');
  assert.match(notify(hBase, { dir: dir3, args: ['--any-date'], extra: { health: mHealth({ status: 'watch', changes: [hC0, old] }) } }), /здоровье сигнала: норма → наблюдение/, '--any-date снимает проверку свежести');
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
  if (!/^(🔔|ℹ️|🩺) <b>Инсайдерский радар · [^<\n]+<\/b>$/u.test(lines[0])) bad.push(`заголовок: ${lines[0]}`);
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
  assert.deepEqual(buildDayFull([]), { rows: [], unpriced: [], fpi: [] });
});
ok('повтор (prev): дни до прошлого дня подачи эмитента с покупкой, прошедшей гейты; окно 365 дней; в строку списка — как есть', () => {
  const ds = ['2025-11-09', '2025-11-10', '2026-10-20', '2026-10-27', '2026-10-27', '2026-11-05'];
  assert.equal(prevDays(ds, '2026-11-09'), 4, 'ближайший прошлый день подачи');
  assert.equal(prevDays(ds, '2026-11-05'), 9, 'тот же день подачи не считается — только раньше');
  assert.equal(prevDays(ds, '2026-10-28'), 1, 'повторяющиеся даты не мешают');
  assert.equal(prevDays(ds, '2026-10-20'), 344);
  assert.equal(prevDays(['2025-11-09'], '2026-11-09'), 365, 'ровно 365 дней — ещё в окне');
  assert.equal(prevDays(['2025-11-09'], '2026-11-10'), null, '366 дней — вне окна');
  assert.equal(prevDays(ds, '2025-11-09'), null, 'раньше первого дня — null');
  assert.equal(prevDays([], '2026-11-09'), null); assert.equal(prevDays(undefined, '2026-11-09'), null);
  const base = { name: 'X', who: ['A'], role: 'C', officer: true, common: true, val: 2e5, dd: null, adv: 4e7, px: 20, drop: null };
  const r = buildDayFull([{ ...base, cik: 1, t: 'REP', prev: 4 }, { ...base, cik: 1, t: 'REP', val: 3e4, prev: 4 }, { ...base, cik: 2, t: 'NEW', prev: null }, { ...base, cik: 3, t: 'OLD' }]).rows;
  const by = t => r.find(x => x.t === t);
  assert.equal(by('REP').prev, 4); assert.equal(by('NEW').prev, null);
  assert.ok(!('prev' in by('OLD')), 'нет поля во входе (старые вызовы, синтетика) — нет и в строке');
  assert.deepEqual(r.map(x => x.t), buildDayFull([{ ...base, cik: 1, t: 'REP' }, { ...base, cik: 1, t: 'REP', val: 3e4 }, { ...base, cik: 2, t: 'NEW' }, { ...base, cik: 3, t: 'OLD' }]).rows.map(x => x.t), 'prev не меняет ни состав, ни порядок');
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
ok('сборка на VPS: вердикт по живому контуру — индекс не вышел, разобран частично, на последней попытке идём как есть', () => {
  const D = '2026-11-04', cov = (status, extra = {}) => ({ [D]: { status, indexed: 100, collected: 90, pending: 10, at: 'x', ...extra } });
  assert.deepEqual(liveVerdict({ lastDay: D, coverage: cov('complete', { collected: 100, pending: 0 }) }, D, 0), { ok: true, partial: false });
  assert.equal(liveVerdict({ lastDay: '2026-11-03' }, D, 0).ok, false, 'индекс D не разобран');
  assert.match(liveVerdict({ lastDay: '2026-11-03' }, D, 1).why, /код 1/);
  assert.equal(liveVerdict({ lastDay: D, coverage: cov('not-published') }, D, 0).ok, false);
  assert.equal(liveVerdict({ lastDay: D, coverage: cov('holiday') }, D, 0).ok, false);
  const part = liveVerdict({ lastDay: D, coverage: cov('partial') }, D, 0);
  assert.equal(part.ok, false); assert.match(part.why, /90 из 100.*добора 10/);
  assert.deepEqual(liveVerdict({ lastDay: D, coverage: cov('partial') }, D, 0, true), { ok: true, partial: true });
  assert.deepEqual(liveVerdict({ lastDay: D }, D, 0), { ok: true, partial: false }, 'старое состояние без coverage — достаточно lastDay');
});
ok('календарь биржи: Страстная пятница закрыта (SEC работает), День Колумба и ветеранов открыты; Новый год в субботу не переносится', () => {
  for (const d of ['2026-04-03', '2027-03-26', '2026-11-26', '2026-07-03', '2026-12-25', '2026-01-19', '2026-06-19', '2023-01-02', '2026-11-07'])
    assert.equal(isMarketClosed(d), true, d);
  for (const d of ['2026-11-11', '2026-10-12', '2026-11-04', '2021-12-31', '2026-04-02', '2026-04-06'])
    assert.equal(isMarketClosed(d), false, d);
  assert.equal(isSecClosed('2026-04-03'), false, 'SEC в Страстную пятницу работает');
});

// ---------- плашка «Данные EDGAR устарели» (web/stale.js) ----------
// Момент — UTC; срок дня D — 09:00 по Нью-Йорку дня D+1 (14:00 UTC зимой, 13:00 UTC летом). Пара [момент, пропущено]:
// плашка видна с одного пропущенного дня.
const Z = s => Date.parse(s + 'Z');
function expectStale(last, cases) {
  for (const [at, missed] of cases)
    assert.deepEqual(staleState(last, Z(at)), { missed, show: missed >= 1 }, `liveLastDay ${last}, ${at} UTC`);
}
ok('плашка EDGAR: 12.11.2026 после Дня ветеранов — вечером пропусков нет, к 09:00 ET без ночной сборки — один', () => {
  assert.equal(STALE_MIN_MISSED, 1);
  expectStale('2026-11-10', [
    ['2026-11-12T14:00', 0],   // утро 12.11: 11.11 SEC закрыта
    ['2026-11-13T01:36', 0],   // показ владельцу, 20:36 ET 12.11: индекс 12.11 ещё не вышел (старое правило — 2)
    ['2026-11-13T13:59', 0],
    ['2026-11-13T14:00', 1],   // 09:00 ET 13.11, а 12.11 не обработан: поломка ночной сборки видна к утру
  ]);
  expectStale('2026-11-12', [['2026-11-13T14:00', 0], ['2026-11-14T13:59', 0], ['2026-11-14T14:00', 1]]);
});
ok('плашка EDGAR: обычная неделя — выходные и понедельник без пропусков, вторник 09:00 ET без понедельника — один', () => {
  expectStale('2026-11-13', [   // пятница
    ['2026-11-14T03:00', 0], ['2026-11-14T14:00', 0], ['2026-11-15T14:00', 0],
    ['2026-11-16T13:59', 0], ['2026-11-16T14:00', 0], ['2026-11-17T01:00', 0],
    ['2026-11-17T13:59', 0], ['2026-11-17T14:00', 1],
  ]);
  // Живой контур двигает liveLastDay и на выходные (lib/livecal.mjs): субботний прогон ставит субботу, воскресный — воскресенье
  expectStale('2026-11-14', [['2026-11-14T03:45', 0], ['2026-11-17T13:59', 0], ['2026-11-17T14:00', 1]]);
  expectStale('2026-11-15', [['2026-11-17T13:59', 0], ['2026-11-17T14:00', 1]]);
  expectStale('2026-11-16', [['2026-11-17T14:00', 0], ['2026-11-18T13:59', 0], ['2026-11-18T14:00', 1]]);
});
ok('плашка EDGAR: День благодарения, Рождество и Новый год — вечер и утро после праздника при исправной сборке без пропусков', () => {
  // Чт 26.11.2026: прогоны 26.11 и 27.11 (03:25 UTC) стоят на 25.11 — индекс 27.11 выходит только вечером 27.11
  expectStale('2026-11-25', [
    ['2026-11-26T14:00', 0], ['2026-11-27T14:00', 0],
    ['2026-11-28T00:30', 0],   // вечер пятницы, 19:30 ET (старое правило — 2)
    ['2026-11-28T03:30', 0], ['2026-11-28T13:59', 0],
    ['2026-11-28T14:00', 1],   // суббота 09:00 ET, пятница не обработана — поломка
  ]);
  expectStale('2026-11-28', [['2026-11-28T14:00', 0], ['2026-11-30T14:00', 0], ['2026-12-01T01:00', 0]]);
  // Пт 25.12.2026: и при liveLastDay = 24.12 (прогоны выходных не прошли), и при 27.12 (прошли)
  expectStale('2026-12-24', [
    ['2026-12-25T14:00', 0], ['2026-12-26T14:00', 0], ['2026-12-28T14:00', 0],
    ['2026-12-29T01:00', 0],   // вечер понедельника 28.12
    ['2026-12-29T13:59', 0], ['2026-12-29T14:00', 1],
  ]);
  expectStale('2026-12-27', [['2026-12-29T01:00', 0], ['2026-12-29T13:59', 0]]);
  // Пт 01.01.2027
  expectStale('2026-12-31', [
    ['2027-01-01T14:00', 0], ['2027-01-02T14:00', 0], ['2027-01-04T14:00', 0],
    ['2027-01-05T01:00', 0], ['2027-01-05T13:59', 0], ['2027-01-05T14:00', 1],
  ]);
  expectStale('2027-01-03', [['2027-01-05T01:00', 0], ['2027-01-05T13:59', 0]]);
});
ok('плашка EDGAR: праздник, перенесённый с выходного, — не пропуск (04.07.2026 → пт 03.07; в 2027 — пт 24.12 и пт 31.12)', () => {
  expectStale('2026-07-02', [
    ['2026-07-03T13:00', 0], ['2026-07-04T13:00', 0], ['2026-07-06T13:00', 0],
    ['2026-07-07T01:00', 0], ['2026-07-07T12:59', 0], ['2026-07-07T13:00', 1],
  ]);
  expectStale('2027-12-23', [['2027-12-25T14:00', 0], ['2027-12-27T14:00', 0], ['2027-12-28T14:00', 1]]);
  expectStale('2027-12-30', [['2028-01-01T14:00', 0], ['2028-01-03T14:00', 0], ['2028-01-04T13:59', 0], ['2028-01-04T14:00', 1]]);
});
ok('плашка EDGAR: Страстная пятница — рабочий день SEC (биржа закрыта, индекс выходит)', () => {
  expectStale('2026-04-02', [['2026-04-03T14:00', 0], ['2026-04-04T12:59', 0], ['2026-04-04T13:00', 1]]);
  expectStale('2026-04-03', [['2026-04-04T13:00', 0]]);
});
ok('плашка EDGAR: срок 09:00 по Нью-Йорку — 13:00 UTC летом и 14:00 UTC зимой, в том числе вокруг переходов 2026 и 2027', () => {
  assert.equal(DEADLINE_NY_HOUR, 9);
  expectStale('2026-07-10', [['2026-07-14T12:59', 0], ['2026-07-14T13:00', 1]]);   // лето: пн 13.07 не обработан
  expectStale('2026-01-09', [['2026-01-13T13:59', 0], ['2026-01-13T14:00', 1]]);   // зима
  // Переход всегда в воскресенье, а срок в воскресенье бывает только у субботы — не рабочего дня SEC. Поэтому проверяются
  // ближайшие сроки — суббота до перехода (по старому сдвигу) и вторник после (по новому) — и сам день перехода по часам
  for (const [sun, satBefore, satAt, tueBefore, tueAt] of [
    ['2026-03-08', '13:59', '14:00', '12:59', '13:00'], ['2026-11-01', '12:59', '13:00', '13:59', '14:00'],
    ['2027-03-14', '13:59', '14:00', '12:59', '13:00'], ['2027-11-07', '12:59', '13:00', '13:59', '14:00'],
  ]) {
    const thu = addDaysIso(sun, -3), fri = addDaysIso(sun, -2), sat = addDaysIso(sun, -1), tue = addDaysIso(sun, 2);
    expectStale(thu, [[`${sat}T${satBefore}`, 0], [`${sat}T${satAt}`, 1]]);
    expectStale(fri, [[`${tue}T${tueBefore}`, 0], [`${tue}T${tueAt}`, 1]]);
    for (let h = 0; h < 24; h++) for (const mm of ['00', '59']) expectStale(thu, [[`${sun}T${String(h).padStart(2, '0')}:${mm}`, 1]]);
  }
});
ok('плашка EDGAR: долгая поломка — пропусков столько, сколько рабочих дней SEC с истёкшим сроком (перебор 2026–2027 по часам)', () => {
  expectStale('2026-11-04', [['2026-11-13T13:59', 4], ['2026-11-13T14:00', 5]]);   // 05, 06, 09, 10, 12.11; 11.11 SEC закрыта
  // Независимый счёт: срок дня — через nyToMs сборки (lib/nytime.mjs), календарь — через lib/calendar.mjs
  const due = new Map(), shut = new Map();
  for (let d = '2025-12-01'; d <= '2028-01-10'; d = addDaysIso(d, 1)) { due.set(d, nyToMs(`${addDaysIso(d, 1)}T09:00`)); shut.set(d, isSecClosed(d)); }
  const ref = (last, ms) => { let n = 0; for (let d = addDaysIso(last, 1); due.get(d) <= ms; d = addDaysIso(d, 1)) if (!shut.get(d)) n++; return n; };
  for (let h = Date.UTC(2026, 0, 1); h < Date.UTC(2028, 0, 1); h += 3600e3) {
    for (const ms of [h - 60e3, h]) {
      const day = new Date(ms).toISOString().slice(0, 10);
      for (const k of [1, 3, 9]) {
        const last = addDaysIso(day, -k);
        assert.equal(missedSecDays(last, ms), ref(last, ms), `liveLastDay ${last}, ${new Date(ms).toISOString()}`);
      }
    }
  }
});
ok('плашка EDGAR: нет liveLastDay или он битый — плашки нет и ошибок нет', () => {
  for (const last of [undefined, null, '', 'abc', '2026-13-45', '2026-02-30', '2026-11-10T00:00', 20261110, {}])
    assert.deepEqual(staleState(last, Z('2026-11-13T14:00')), { missed: 0, show: false }, String(last));
  for (const now of [NaN, undefined, null, '2026-11-13', 1e20, Infinity])
    assert.deepEqual(staleState('2026-11-04', now), { missed: 0, show: false }, String(now));
  expectStale('2026-11-14', [['2026-11-14T03:45', 0]]);   // liveLastDay впереди даты Нью-Йорка (суббота с 22:45 ET пятницы)
});
ok('плашка EDGAR: часы зрителя в другой зоне на счёт не влияют', () => {
  const probes = [['2026-11-10', '2026-11-13T01:36'], ['2026-11-10', '2026-11-13T14:00'], ['2026-11-25', '2026-11-28T00:30'],
    ['2026-03-05', '2026-03-08T07:00'], ['2026-03-06', '2026-03-10T13:00'], ['2026-10-29', '2026-11-01T05:30'], ['2026-11-13', '2026-11-17T04:30']];
  const want = probes.map(([l, t]) => missedSecDays(l, Z(t)));
  const code = `import { missedSecDays } from ${JSON.stringify(pathToFileURL(join(ROOT, 'web', 'stale.js')).href)};
    const p = ${JSON.stringify(probes)};
    process.stdout.write(JSON.stringify({ off: new Date(Date.UTC(2026, 10, 13)).getTimezoneOffset(), got: p.map(([l, t]) => missedSecDays(l, Date.parse(t + 'Z'))) }));`;
  for (const [TZ, off] of [['Asia/Tokyo', -540], ['Pacific/Pago_Pago', 660]]) {
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ }, encoding: 'utf8' }));
    assert.equal(out.off, off, `зона ${TZ} не применилась — проверка ничего не доказывает`);
    assert.deepEqual(out.got, want, TZ);
  }
});
ok('плашка EDGAR: календарь страницы — тот же модуль, что у сборки; страница грузит только файлы из web/', () => {
  for (const k of ['isSecClosed', 'secHolidays', 'isMarketClosed', 'nyseHolidays']) {
    assert.equal(typeof webCalendar[k], 'function', k);
    assert.equal(buildCalendar[k], webCalendar[k], `${k}: у сборки и страницы разные календари`);
  }
  // На страницу попадает только web/* (daily.yml, «Сборка сайта»): импорт из-за её пределов в браузере дал бы 404 и пустую страницу
  assert.match(readFileSync(join(ROOT, '.github', 'workflows', 'daily.yml'), 'utf8'), /run: cp web\/\* site\//);
  const files = readdirSync(join(ROOT, 'web')).filter(f => f.endsWith('.js'));
  for (const f of files) {
    for (const m of readFileSync(join(ROOT, 'web', f), 'utf8').matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
      assert.match(m[1], /^\.\/[\w.-]+\.js$/, `web/${f}: импорт «${m[1]}» не из web/`);
      assert.ok(files.includes(m[1].slice(2)), `web/${f}: нет файла ${m[1]}`);
    }
  }
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /staleState\(last, Date\.now\(\)\)/, 'плашка в web/app.js считает не через web/stale.js');
  assert.match(app, /пропущено рабочих дней: \$\{missed\}/);
});
ok('сборка на VPS: D0 списка обязан быть днём подачи, если биржа торговала; без бара SPY за D — повтор, на последней попытке идём с предупреждением', () => {
  assert.deepEqual(d0Verdict({ d0: '2026-11-04' }, '2026-11-04'), { ok: true });
  const bad = d0Verdict({ d0: '2026-11-03' }, '2026-11-04');
  assert.equal(bad.ok, false); assert.match(bad.why, /D0 списка — 2026-11-03, а день подачи 2026-11-04/);
  assert.equal(d0Verdict({ d0: null }, '2026-11-04').ok, false, 'календаря SPY нет совсем');
  assert.equal(d0Verdict({ d0: '2026-11-03' }, '2026-11-04', true).ok, true); assert.match(d0Verdict({ d0: '2026-11-03' }, '2026-11-04', true).warn, /не догружены/);
  assert.deepEqual(d0Verdict({ d0: '2026-04-02' }, '2026-04-03'), { ok: true }, 'биржа не торговала (Страстная пятница): D0 — четверг');
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
  // отметка сообщения о смене статуса здоровья сигнала: D+1 смены и новый статус
  const HL = '/morning/letter/2026-11-20-health-watch';
  assert.equal((await call('GET', HL)).status, 404);
  assert.equal((await call('PUT', HL, { body: JSON.stringify({ by: 'vps', at: '2026-11-21T03:06:00Z' }) })).status, 401);
  assert.equal((await call('PUT', HL, { body: JSON.stringify({ by: 'vps', at: '2026-11-21T03:06:00Z' }), token: T })).status, 200);
  assert.equal((await (await call('GET', HL)).json()).by, 'vps');
  assert.equal((await call('GET', '/morning/letter/2026-11-20')).status, 404, 'отметка здоровья — не отметка письма того же дня');
  assert.equal((await call('GET', '/morning/letter/2026-11-20-health-bad')).status, 404);
  assert.equal((await call('PUT', '/morning/letter/2026-11-20-health-x', { body: JSON.stringify({ by: 'vps', at: '2026-11-21T03:06:00Z' }), token: T })).status, 404);
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
  assert.deepEqual(st, { merged: 3, fresh: 2, opens: 2, missing: ['GONE'], tail: [] });
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
  const calls = { morningPuts: [], markerPuts: [], bars: [] };
  const state = { morning, markers: { ...markers } };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x'), auth = req.headers.authorization ?? null;
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const lm = /^\/morning\/letter\/(\d{4}-\d{2}-\d{2}(?:-health-[a-z]+)?)$/.exec(u.pathname);
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
    for (const k of ['t', 'val', 'mx', 'score', 'main', 'dv', 'px', 'cost', 'tags', 'o', 'c', 'ex', 'exS', 'prev'])
      assert.deepEqual(row[k], ref[k], 'поле ' + k + ' должно совпасть с полным пересчётом');
    assert.ok(sent.health, 'здоровье сигнала есть и в сборке на VPS');
    assert.deepEqual(sent.health, R('morning.json').health, 'здоровье сигнала: сборка на VPS = полный пересчёт');
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
await okAsync('notify: смена здоровья сигнала уходит после письма один раз на двоих отправителей — отметка в воркере, как у писем', async () => {
  const d = nDay(-1);
  const W = hChange(d, 'normal', 'watch', -1.6, 0.0018);
  const health = { ...W.h, changes: [hC0, W.c] };
  const wk = await fakeWorker(), tg = await fakeApis([]);
  try {
    // VPS: письмо за день и смена статуса; после доставки — две отметки
    const dirV = healthDir('data-hmk-vps');
    writeMorning([mDay(d, [mRow('AAA', 3e5)])], mCounter, { health });
    const r1 = await notifyW(dirV, { tg: tg.base, worker: wk.base, args: ['--sender', 'vps'], env: { PAPER_TOKEN: 'tok' } });
    assert.equal(r1.code, 0, r1.out); assert.equal(tg.calls.tg.length, 2);
    assert.equal(lineOf(tg.calls.tg[0], 0), '🔔 <b>Инсайдерский радар · утренний список</b>', 'сначала письмо');
    assert.equal(lineOf(tg.calls.tg[1], 0), '🩺 <b>Инсайдерский радар · здоровье сигнала: норма → наблюдение</b>');
    for (const c of tg.calls.tg) assert.deepEqual(styleFaults(c.body.text), [], styleFaults(c.body.text).join('; ') + ' :: ' + c.body.text);
    assert.match(tg.calls.tg[0].body.text, /\nЗдоровье сигнала: ⚠️ наблюдение · перевес за полгода \+0,18% \(история \+0,37%\)\n/);
    assert.deepEqual(wk.calls.markerPuts.map(x => x.date), [d, `${d}-health-watch`]);
    assert.deepEqual(tg.calls.nexus.map(b => b.eventId), [`840|morning|${d}`, `840|health|${d}|watch`]);
    assert.deepEqual(sentHealthOf(dirV), [`health|${d}|watch`]);
    // GitHub позже, своё состояние без этого ключа: отметки есть — ни письма, ни смены; ключ записан
    const dirG = healthDir('data-hmk-gh');
    const r2 = await notifyW(dirG, { tg: tg.base, worker: wk.base });
    assert.equal(r2.code, 0, r2.out); assert.equal(tg.calls.tg.length, 2, 'дубля нет');
    assert.match(r2.out, /смена health\|.+\|watch уже отправлена \(vps/);
    assert.deepEqual(sentHealthOf(dirG), [`health|${d}|watch`]);
    // Telegram не принял смену — ключ не записан, следующий прогон досылает
    const wk2 = await fakeWorker(), tg2 = await fakeApis([TG_OK, { status: 500, body: { ok: false, error_code: 500, description: 'Internal Server Error' } }]);
    try {
      const dirF = healthDir('data-hmk-fail');
      const r3 = await notifyW(dirF, { tg: tg2.base, worker: wk2.base });
      assert.notEqual(r3.code, 0); assert.deepEqual(sentHealthOf(dirF), [], 'недоставленная смена не числится отправленной');
      const r4 = await notifyW(dirF, { tg: tg2.base, worker: wk2.base });
      assert.equal(r4.code, 0, r4.out); assert.equal(tg2.calls.tg.length, 3, 'досылается одна смена');
      assert.match(tg2.calls.tg[2].body.text, /здоровье сигнала: норма → наблюдение/); assert.deepEqual(sentHealthOf(dirF), [`health|${d}|watch`]);
    } finally { await wk2.close(); await tg2.close(); }
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

// ---------- PR-3: лента формы 4 на весь день, сверка с индексом, список по ленте ----------
const atomOf = entries => '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' + entries.map(e => `<entry><title>${e.form ?? '4'} - X (0001) (Reporting)</title>`
  + `<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/${e.cik}/${e.acc.replace(/-/g, '')}/${e.acc}-index.htm"/>`
  + `<summary type="html">\n &lt;b&gt;Filed:&lt;/b&gt; ${e.filed} &lt;b&gt;AccNo:&lt;/b&gt; ${e.acc} &lt;b&gt;Size:&lt;/b&gt; 4 KB\n</summary><updated>${e.filed}T11:00:00-05:00</updated>`
  + `<category scheme="https://www.sec.gov/" label="form type" term="${e.form ?? '4'}"/><id>urn:tag:sec.gov,2008:accession-number=${e.acc}</id></entry>`).join('') + '</feed>';
const formTxt = (acc, filed) => FORM4_XML.replace('<SEC-DOCUMENT>\n', `<SEC-DOCUMENT>${acc}.txt : ${filed.replace(/-/g, '')}\n<SEC-HEADER>${acc}.hdr.sgml : ${filed.replace(/-/g, '')}\n<ACCEPTANCE-DATETIME>${filed.replace(/-/g, '')}101500\nACCESSION NUMBER:\t${acc}\n</SEC-HEADER>\n`);

ok('лента: Filed из описания записи, журнал с оборванной строкой, чтение за несколько дней, уборка старых файлов', () => {
  const e = parseAtom(atomOf([{ acc: '0001000000-26-000011', cik: 111, filed: '2026-11-04' }, { acc: '0001000000-26-000012', cik: 222, filed: '2026-11-05', form: '4/A' }]));
  assert.deepEqual(e.map(x => [x.acc, x.filed, x.form]), [['0001000000-26-000011', '2026-11-04', '4'], ['0001000000-26-000012', '2026-11-05', '4/A']]);
  assert.equal(parseAtom('<feed><entry><link href="https://www.sec.gov/Archives/edgar/data/1/x/0001000000-26-000013-index.htm"/><id>urn:tag:sec.gov,2008:accession-number=0001000000-26-000013</id></entry></feed>')[0].filed, null, 'нет описания — даты нет');
  const j = parseFeedJournal([JSON.stringify({ k: 'run' }), JSON.stringify({ k: 'seen', acc: 'A', filed: '2026-11-04' }), JSON.stringify({ k: 'form', acc: 'A', filed: '2026-11-04', trades: [] }), '{"k":"seen","acc":"B","fi'].join('\n'));
  assert.deepEqual([j.seen.size, j.forms.size, j.runs.length], [1, 1, 1], 'оборванная последняя строка не ломает чтение');
  const dir = join(NTMP, 'feed-load');
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  for (const [d, a] of [['2026-11-03', 'X'], ['2026-11-04', 'Y'], ['2026-10-01', 'OLD']]) writeFileSync(feedFile(dir, d), JSON.stringify({ k: 'seen', acc: a, filed: d }) + '\n');
  assert.deepEqual([...loadFeed(dir, '2026-11-04').seen.keys()].sort(), ['X', 'Y'], 'день и два предыдущих: подача 22:00–06:00 лежит в журнале соседнего дня');
  assert.equal(pruneFeed(dir, '2026-11-04'), 1); assert.equal(existsSync(feedFile(dir, '2026-10-01')), false); assert.equal(existsSync(feedFile(dir, '2026-11-03')), true);
});
ok('лента: сверка с индексом — чего нет в индексе, чего не видела лента, что замечено, но не скачано; слияние строк без дублей', () => {
  const D = '2026-11-04';
  const feed = parseFeedJournal([
    { k: 'seen', acc: 'A', form: '4', filed: D }, { k: 'form', acc: 'A', filed: D, trades: [{ acc: 'A', code: 'P', tdate: D, sec: 'Common', val: 1 }] },
    { k: 'seen', acc: 'C', form: '4', filed: D }, { k: 'form', acc: 'C', filed: D, trades: [{ acc: 'C', code: 'P', tdate: D, sec: 'Common', val: 2 }], amend: [{ acc: 'C', orig: D }] },
    { k: 'seen', acc: 'E', form: '4', filed: D },                                     // замечена, не скачана
    { k: 'seen', acc: 'Z', form: '4', filed: '2026-11-03' }, { k: 'seen', acc: 'T', form: '424B2', filed: D },   // другой день, другой тип
  ].map(x => JSON.stringify(x)).join('\n'));
  const r = reconcile(feed, new Set(['A', 'B', 'E']), D);
  assert.deepEqual(r, { indexed: 3, seen: 3, parsed: 2, extra: ['C'], missing: 1, unparsed: ['E'] });
  const shard = { trades: [{ acc: 'A', code: 'P', tdate: D, sec: 'Common', val: 1 }], amend: [] };
  assert.equal(mergeFeedRows(shard, feed.forms, ['A', 'C', 'нет-такой']), 1, 'A уже лежит — не дублируется, C добавлена');
  assert.equal(shard.trades.length, 2); assert.deepEqual(shard.amend, [{ acc: 'C', orig: D }]);
  assert.equal(mergeFeedRows(shard, feed.forms, ['C']), 0); assert.equal(shard.amend.length, 1, 'повторное слияние ничего не меняет');
});
await okAsync('лента: сборщик — подачи дня замечаются и разбираются, недоступный файл добирается следующим тактом, перезапуск без дублей', async () => {
  const day = '2026-10-01';
  const entries = [{ acc: '0001000000-26-000011', cik: 111222, filed: day }, { acc: '0001000000-26-000012', cik: 333, filed: day }, { acc: '0001000000-26-000013', cik: 444, filed: day, form: '424B2' }];
  const hits = { filings: [], b404: true };
  const server = createServer((req, res) => {
    if (req.url.startsWith('/cgi-bin/browse-edgar')) { res.writeHead(200, { 'content-type': 'application/atom+xml' }); res.end(atomOf(/start=0(&|$)/.test(req.url) ? entries : [])); return; }
    const m = /\/Archives\/edgar\/data\/\d+\/\d+\/(\d{10}-\d{2}-\d{6})\.txt$/.exec(req.url);
    if (m) { hits.filings.push(m[1]); if (m[1].endsWith('12') && hits.b404) { res.writeHead(404); res.end(); } else { res.writeHead(200); res.end(formTxt(m[1], day)); } return; }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const dir = join(NTMP, 'feed-run');
  rmSync(dir, { recursive: true, force: true });
  const run = () => new Promise(resolve => execFile(process.execPath, [join(ROOT, 'scripts', 'vps', 'feed-collector.mjs'), '--dir', dir, '--once'],
    { encoding: 'utf8', env: { ...process.env, EDGAR_BASE: `http://127.0.0.1:${server.address().port}` } }, (err, so, se) => resolve({ code: err ? (err.code ?? 1) : 0, out: so + se })));
  try {
    const r1 = await run();
    assert.equal(r1.code, 0, r1.out);
    const f = readdirSync(dir)[0], read = () => parseFeedJournal(readFileSync(join(dir, f), 'utf8'));
    let j = read();
    assert.deepEqual([...j.seen.keys()], ['0001000000-26-000011', '0001000000-26-000012'], '424B2 чужого типа не замечается');
    assert.deepEqual([...j.forms.keys()], ['0001000000-26-000011'], 'вторая подача ещё не отдаётся (404) — только замечена');
    const form = j.forms.get('0001000000-26-000011');
    assert.equal(form.filed, day); assert.equal(form.at, `${day}T10:15`); assert.equal(form.acs, `${day}T10:15:00`, 'время приёма с секундами — для сигнала в торговые часы'); assert.ok(Date.parse(form.w) > 0); assert.ok(form.trades.length >= 1 && form.trades.every(t => t.acc === '0001000000-26-000011' && t.fdate === day), 'строки как у живого контура, дата подачи из ленты');
    hits.b404 = false;
    const r2 = await run();
    assert.equal(r2.code, 0, r2.out);
    j = read();
    assert.deepEqual([...j.forms.keys()].sort(), ['0001000000-26-000011', '0001000000-26-000012']);
    const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(lines.filter(x => x.k === 'seen').length, 2, 'перезапуск не дублирует замеченные');
    assert.deepEqual(hits.filings, ['0001000000-26-000011', '0001000000-26-000012', '0001000000-26-000012'], 'разобранную подачу повторно не качаем');
    assert.ok(lines.some(x => x.k === 'stat' && x.polls >= 1), 'такт записан в журнал');
  } finally { await new Promise(r => server.close(r)); }
});

await okAsync('сборка на VPS: сверка индекса с лентой — подача, которой нет в индексе, добавляется в список, покрытие дня знает о ленте', async () => {
  const work = join(TMP, '..', '.selftest-feed1');
  rmSync(work, { recursive: true, force: true });
  const data = join(work, 'repo'), feedDir = join(work, 'feed'), D = '2026-11-04';
  mkdirSync(feedDir, { recursive: true });
  const row = acc => ({ acc, code: 'P', tdate: D, fdate: D, sec: 'Common Stock', val: 5e4, t: 'EXT' });
  writeFileSync(feedFile(feedDir, D), [
    { k: 'seen', acc: 'IN-1', form: '4', filed: D }, { k: 'form', acc: 'IN-1', filed: D, trades: [row('IN-1')], amend: [] },
    { k: 'seen', acc: 'LATE', form: '4', filed: D }, { k: 'form', acc: 'LATE', filed: D, trades: [row('LATE')], amend: [] },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  writeJsonGz(join(data, 'trades', 'live.json.gz'), { v: SHARD_VERSION, trades: [row('IN-1')], amend: [] });
  const info = await reconcileStage({ data, feedDir }, D, { fetchIndex: async () => ({ entries: [{ acc: 'IN-1' }, { acc: 'IN-1' }, { acc: 'ONLY-INDEX' }] }) });
  assert.deepEqual({ ...info, at: null, extraAcc: info.extraAcc }, { seen: 2, parsed: 2, indexed: 2, extra: 1, extraAcc: ['LATE'], missing: 1, unparsed: 0, merged: 1, from: '06:00', at: null });
  assert.deepEqual(readJsonGz(join(data, 'trades', 'live.json.gz')).trades.map(r => r.acc).sort(), ['IN-1', 'LATE']);
  assert.equal(readJson(join(data, 'state', 'feed.json'))[D].extra, 1);
  // лента за день пуста — сверки нет, шард не тронут
  assert.equal(await reconcileStage({ data, feedDir: join(work, 'нет') }, D, { fetchIndex: async () => ({ entries: [] }) }), null);
  rmSync(work, { recursive: true, force: true });
});
await okAsync('сборка на VPS: индекса нет до последней попытки — список по ленте с пометкой источника, покрытие «индекс не вышел», выход с ошибкой (тревога)', async () => {
  const work = join(TMP, '..', '.selftest-feed2');
  rmSync(work, { recursive: true, force: true });
  const data = join(work, 'repo'), feedDir = join(work, 'feed');
  for (const d of ['trades', 'reference', 'prices', 'state']) cpSync(join(TMP, d), join(data, d), { recursive: true });
  rmSync(join(data, 'prices', '_opens.json.gz'), { force: true });
  // подача L1 убрана из шарда и лежит только в журнале ленты
  const shardPath = join(data, 'trades', 'live.json.gz'), shard = readJsonGz(shardPath);
  const l1 = shard.trades.filter(r => r.acc === 'L1');
  assert.ok(l1.length, 'в фикстуре есть подача L1');
  shard.trades = shard.trades.filter(r => r.acc !== 'L1'); writeJsonGz(shardPath, shard);
  mkdirSync(feedDir, { recursive: true });
  writeFileSync(feedFile(feedDir, recentF), [{ k: 'seen', acc: 'L1', cik: 222, form: '4', filed: recentF }, { k: 'form', acc: 'L1', filed: recentF, at: `${recentF}T17:21`, trades: l1, amend: [] }].map(x => JSON.stringify(x)).join('\n') + '\n');
  const d0 = bizDays('2015-01-01', today).filter(d => d <= recentF).at(-1);
  for (const sym of ['SPY', 'IWM', 'LIVA']) writePriceCache(data, sym, readPriceCache(data, sym).filter(r => r[0] < d0));
  const over = { LIVA: { [d1L]: [50, 51] }, IWM: { [d1L]: [100, 100.5] }, SPY: { [d1L]: [100, 101] } };
  const src = { LIVA: livaSeries, IWM: bizDays('2015-01-01', today).map(d => [d, 100, 100, 1e6]), SPY: bizDays('2015-01-01', today).map(d => [d, 100, 100, 1e6]) };
  const charts = Object.fromEntries(Object.entries(src).map(([sym, s]) => [sym, from => chartOf(s.filter(r => r[0] >= from), over[sym])]));
  const api = await fakeWorker({ charts });
  const sec = createServer((req, res) => { res.writeHead(404); res.end(); });          // SEC: индекса нет
  await new Promise(r => sec.listen(0, '127.0.0.1', r));
  const realBase = process.env.EDGAR_BASE;
  process.env.EDGAR_BASE = `http://127.0.0.1:${sec.address().port}`;
  try {
    const code = await morningMain(['--state', work, '--data', data, '--site', join(work, 'site'), '--date', recentF, '--no-sync', '--feed-dir', feedDir, '--once', '--interval', '1'], { PAPER_URL: api.base, PAPER_TOKEN: 'tok' });
    assert.equal(code, 1, 'список доставлен, но индекс не вышел — тревога');
    assert.equal(api.calls.morningPuts.length, 1);
    const sent = JSON.parse(api.calls.morningPuts[0]);
    assert.equal(sent.source, 'feed'); assert.equal(sent.listFor, recentF); assert.equal(sent.builder, 'vps');
    assert.equal(sent.coverage.status, 'not-published'); assert.equal(sent.coverage.collected, 1); assert.equal(sent.coverage.feed.source, 'feed'); assert.equal(sent.coverage.feed.merged, l1.length);
    const row = sent.days.find(d => d.date === recentF).rows[0], ref = R('morning.json').days.find(d => d.date === recentF).rows[0];
    for (const k of ['t', 'val', 'mx', 'score', 'main', 'dv', 'px', 'cost', 'tags']) assert.deepEqual(row[k], ref[k], 'поле ' + k + ': по ленте то же, что по индексу');
    assert.equal(readJson(join(work, 'done', `${recentF}.json`)).source, 'feed');
  } finally {
    if (realBase === undefined) delete process.env.EDGAR_BASE; else process.env.EDGAR_BASE = realBase;
    await api.close(); await new Promise(r => sec.close(r)); rmSync(work, { recursive: true, force: true });
  }
  // индекса нет, а лента пуста — собрать нечем: сборка не придумывает пустой список
  const work2 = join(TMP, '..', '.selftest-feed3');
  rmSync(work2, { recursive: true, force: true });
  const api2 = await fakeWorker({ charts: {} }), sec2 = createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise(r => sec2.listen(0, '127.0.0.1', r));
  process.env.EDGAR_BASE = `http://127.0.0.1:${sec2.address().port}`;
  try {
    mkdirSync(join(work2, 'feed'), { recursive: true });
    const code = await morningMain(['--state', work2, '--data', join(work2, 'repo'), '--date', recentF, '--no-sync', '--feed-dir', join(work2, 'feed'), '--once'], { PAPER_URL: api2.base, PAPER_TOKEN: 'tok' });
    assert.equal(code, 1); assert.equal(api2.calls.morningPuts.length, 0);
  } finally {
    if (realBase === undefined) delete process.env.EDGAR_BASE; else process.env.EDGAR_BASE = realBase;
    await api2.close(); await new Promise(r => sec2.close(r)); rmSync(work2, { recursive: true, force: true });
  }
});
ok('notify: список по ленте — в письме сказано, что индекс не вышел; по индексу пометки нет', () => {
  const dir = seededDir('data-feedsrc');
  const days = [mDay(nDay(-1), [mRow('AAA', 3e5)])];
  const out = notify(days, { dir, extra: { source: 'feed' } });
  assert.match(out, /Список собран по ленте EDGAR: индекс за день не получен \(ещё не вышел или SEC не отвечала\), возможны неполные данные\./);
  const d2 = seededDir('data-feedsrc2');
  const out2 = notify([mDay(nDay(-1), [])], { dir: d2, extra: { source: 'feed' } });
  assert.match(out2, /утренний список пуст/); assert.match(out2, /по ленте EDGAR/, 'и в письме «сигналов нет»: лента могла видеть не всё');
  assert.ok(!/по ленте EDGAR/.test(notify(days, { dir: seededDir('data-feedsrc3'), extra: { source: 'index' } })));
});

rmSync(NTMP, { recursive: true, force: true });

// ==================== СБОР: календарь, сбои сети, добор, дедуп, разбор индекса (PR fix-collect-1) ====================
// Ревизия данных 04.11.2026 (audit-840-data-2026-11/REVIEW-DATA.md, дефекты П1, П4, П5, П6, П7, П12).
{
  const { missingIndexVerdict, shouldProbeNext, nextWeekday, coverageEntry, pruneCoverage, listDayOf } = await import('./lib/livecal.mjs');
  const { uniqueFilings, normalizeXmlDate, PARSER_REV } = await import('./lib/edgar.mjs');
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
    // ревизия разбора — текущая: фоновое перечитывание окна здесь не нужно (его проверяет отдельный тест)
    writeJson(join(CTMP, 'state', 'live.json'), { schema: SHARD_VERSION, from: '2026-09-01', lastDay: '2026-09-04', staleFloor: 1, parserRev: PARSER_REV });
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

    await okAsync('сбор: рост PARSER_REV — окно перечитывается в фоне, строки замещаются без дублей', async () => {
      const st = liveState();
      writeJson(join(CTMP, 'state', 'live.json'), { ...st, parserRev: 1 });
      const before = liveRows().length, hitsBefore = hits.length;
      const r = await runLive('2026-09-11');
      assert.equal(r.code, 0, r.out);
      const s = liveState();
      assert.equal(s.parserRev, PARSER_REV, r.out);
      assert.equal(s.reread, undefined, 'окно пройдено до конца');
      assert.equal(liveRows().length, before, 'строки замещены, а не продублированы');
      assert.ok(hits.length - hitsBefore >= 5, 'подачи окна скачаны заново');
      assert.equal(s.lastDay, st.lastDay, 'сегодняшний день не задержан и не сдвинут');
    });

    await okAsync('сбор: прогон, собравший новый день, окно не перечитывает — список и письмо его не ждут', async () => {
      const st = liveState();
      writeJson(join(CTMP, 'state', 'live.json'), { ...st, parserRev: 1 });
      index['2026-09-11'] = ['x'].join('\n');   // новый день: индекс вышел, подач в нём нет
      const hitsBefore = hits.length;
      const r1 = await runLive('2026-09-12');
      assert.equal(r1.code, 0, r1.out);
      const s1 = liveState();
      assert.equal(s1.coverage['2026-09-11'].status, 'complete', 'новый день (пятница) собран');
      assert.equal(s1.parserRev, 1, 'окно в этом прогоне не перечитывалось');
      assert.ok(s1.reread, 'перечитывание стоит в очереди');
      assert.match(r1.out, /перечитывание окна отложено/);
      const r2 = await runLive('2026-09-12');   // следующий прогон без нового дня
      assert.equal(r2.code, 0, r2.out);
      const s2 = liveState();
      assert.equal(s2.parserRev, PARSER_REV, r2.out);
      assert.equal(s2.reread, undefined, 'окно пройдено');
      assert.ok(hits.length - hitsBefore >= 5, 'окно перечитано вторым прогоном');
    });
  } finally {
    await new Promise(r => server.close(r));
    rmSync(CTMP, { recursive: true, force: true });
  }
}

// ==================== ГЕЙТЫ И ВСЕЛЕННАЯ: сноски к остатку, TXSE, склейка форм, поправки, поздние формы (PR fix-collect-2) ====================
// Ревизия данных 04.11.2026 (П2, П3, П8, П16).
{
  const { resolveAmendments, ALLOWED_EXCHANGES, exchangeCounts } = await import('./lib/universe.mjs');
  const { filingLagDays, isLateFiling } = await import('./lib/gates.mjs');
  const { holdingFootnoteFlags } = await import('./lib/footnotes.mjs');

  // Покупка, у которой сноска о DRIP/ESPP висит на остатке (так подают Uber, Celsius, Insulet, Agree Realty)
  const holdXml = (where, note) => `<SEC-DOCUMENT>\n<XML>\n<ownershipDocument><documentType>4</documentType>
    <issuer><issuerCik>1543151</issuerCik><issuerTradingSymbol>UBER</issuerTradingSymbol></issuer><aff10b5One>0</aff10b5One>
    <reportingOwner><reportingOwnerId><rptOwnerCik>1</rptOwnerCik><rptOwnerName>Ceo Person</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>Chief Executive Officer</officerTitle></reportingOwnerRelationship></reportingOwner>
    <nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-09-08</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>
      <transactionAmounts><transactionShares><value>141000</value>${where === 'shares' ? '<footnoteId id="F2"/>' : ''}</transactionShares>
        <transactionPricePerShare><value>70.96</value><footnoteId id="F1"/></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>1500000</value>${where === 'holding' ? '<footnoteId id="F2"/>' : ''}</sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction></nonDerivativeTable>
    <footnotes><footnote id="F1">The price reported is a weighted average price. Prices ranged from $70.50 to $71.40.</footnote>
      <footnote id="F2">${note}</footnote></footnotes>
  </ownershipDocument>\n</XML>`;

  ok('гейты/П2: сноска к остатку о ESPP/DRIP не отсеивает покупку, а даёт тег', () => {
    const note = "Includes 298 shares acquired under Uber's 2019 Employee Stock Purchase Plan on May 20, 2026.";
    const [r] = parseForm4Txt(holdXml('holding', note), '0000000000-26-000010', '2026-09-10').trades;
    assert.equal(r.fn.espp, undefined, 'природа сделки не задета сноской к остатку');
    assert.equal(r.fn.wavg, 1, 'сноска к цене по-прежнему работает');
    assert.equal(r.fnh.espp, 1);
    const g = applyGates(r, {});
    assert.equal(g.ok, true);
    assert.ok(g.tags.includes('hold-note'));
    // та же сноска на поле акций — это уже описание самой сделки: отсев остаётся
    const [s] = parseForm4Txt(holdXml('shares', note), '0000000000-26-000011', '2026-09-10').trades;
    assert.equal(s.fn.espp, 1);
    assert.equal(applyGates(s, {}).drop, 'espp');
    // DRIP на остатке
    const [d] = parseForm4Txt(holdXml('holding', 'Includes 6,263.244 shares acquired under a dividend reinvestment plan since the last Form 4.'), '0000000000-26-000012', '2026-08-31').trades;
    assert.equal(d.fn.drip, undefined);
    assert.equal(applyGates(d, {}).ok, true);
  });

  ok('гейты/П2: формоуровневый 10b5-1 не переходит на покупку со сноской к остатку', () => {
    // у строки есть своя сноска (к остатку) — значит, план из примечаний формы её не касается, как и раньше
    const f = rowFootnoteFlags([], ['Sales were made under a Rule 10b5-1 trading plan.'], ['Includes shares held in a 401(k) plan.']);
    assert.equal(f.b5, undefined);
    const g = rowFootnoteFlags([], ['Sales were made under a Rule 10b5-1 trading plan.'], []);
    assert.equal(g.b5, 1, 'строка без сносок, как раньше, наследует план формы');
    assert.deepEqual(holdingFootnoteFlags(['Includes shares acquired under the ESPP; held by trust.'], { trust: 1 }), { espp: 1 });
  });

  ok('гейты/П2: квартальный датасет — сноска к SHRS_OWND_FOLWNG_TRANS_FN идёт в fnh', () => {
    const z = zipCreate({
      'SUBMISSION.tsv': 'ACCESSION_NUMBER\tFILING_DATE\tDOCUMENT_TYPE\tISSUERCIK\tISSUERNAME\tISSUERTRADINGSYMBOL\tAFF10B5ONE\tDATE_OF_ORIG_SUB\tREMARKS\nQ-1\t02-SEP-2026\t4\t917251\tAgree\tADC\t0\t\t',
      'REPORTINGOWNER.tsv': 'ACCESSION_NUMBER\tRPTOWNERCIK\tRPTOWNERNAME\tRPTOWNER_RELATIONSHIP\tRPTOWNER_TITLE\nQ-1\t5\tRakolta John\tDirector\t',
      'NONDERIV_TRANS.tsv': 'ACCESSION_NUMBER\tTRANS_DATE\tTRANS_CODE\tEQUITY_SWAP_INVOLVED\tTRANS_SHARES\tTRANS_PRICEPERSHARE\tSHRS_OWND_FOLWNG_TRANS\tDIRECT_INDIRECT_OWNERSHIP\tTRANS_PRICEPERSHARE_FN\tSHRS_OWND_FOLWNG_TRANS_FN\nQ-1\t31-AUG-2026\tP\t0\t20000\t73.23\t90000\tD\t\tF2',
      'FOOTNOTES.tsv': 'ACCESSION_NUMBER\tFOOTNOTE_ID\tFOOTNOTE_TXT\nQ-1\tF2\tIncludes 6,263.244 shares acquired under a dividend reinvestment plan since the last Statement.',
    });
    const [r] = normalizeQuarterZip(z).trades;
    assert.equal(r.fn.drip, undefined);
    assert.equal(r.fnh.drip, 1);
    assert.equal(applyGates(r, {}).ok, true);
  });

  ok('вселенная/П3: TXSE — биржа; незнакомая площадка решается реестром, а не считается OTC', () => {
    assert.ok(ALLOWED_EXCHANGES.has('TXSE'));
    const ref = new Map([[1276187, { ticker: 'ET', exchange: 'TXSE' }], [2, { ticker: 'NEWX', exchange: 'NEWEXCH' }], [3, { ticker: 'PINK', exchange: 'OTC' }], [4, { ticker: 'GHST', exchange: 'NEWEXCH' }]]);
    const ranges = { NEWX: [[1, '2020-01-01', '2026-11-03']], GHST: [[0, '2020-01-01', '2026-11-03']] };
    assert.equal(issuerCategory({ cik: 1276187, tdate: '2026-08-19' }, ref, ranges), 'listed');
    assert.equal(issuerCategory({ cik: 2, tdate: '2026-08-19' }, ref, ranges), 'listed', 'незнакомая площадка, реестр — биржа');
    assert.equal(issuerCategory({ cik: 4, tdate: '2026-08-19' }, ref, ranges), 'otc', 'незнакомая площадка, реестр — внебиржевой');
    assert.equal(issuerCategory({ cik: 3, tdate: '2026-08-19' }, ref, ranges), 'otc');
    assert.equal(issuerCategory({ cik: 2, tdate: '2026-08-19' }, ref, null), 'unknown');
    assert.deepEqual(exchangeCounts(ref), { TXSE: 1, NEWEXCH: 2, OTC: 1 });
  });

  const row = (acc, form, fdate, sh, extra = {}) => ({ acc, form, fdate, tdate: '2026-09-28', cik: 1, owners: [{ cik: 7 }], code: 'P', sec: 'Common Stock', sh, px: 80, val: sh * 80, ...extra });
  ok('вселенная/П16: разные исходные формы одного лица за дату — разные покупки', () => {
    // KOD 30.09.2026: три формы Baker Bros на одну дату сделки, $58,6 / $35,0 / $60,5 млн
    const r = resolveAmendments([row('A1', '4', '2026-09-30', 807840), row('A2', '4', '2026-09-30', 418323), row('A3', '4', '2026-09-30', 681866)]);
    assert.equal(r.rows.length, 3);
    assert.equal(r.rows.reduce((s, x) => s + x.sh, 0), 1908029);
    // повторная подача одного и того же — одна строка
    assert.equal(resolveAmendments([row('B1', '4', '2026-09-11', 100000), row('B2', '4', '2026-09-11', 100000)]).rows.length, 1);
  });

  ok('вселенная/П8: поправка правит поля, дата — первой подачи', () => {
    // CVNA: исходник 04.08, поправка 05.10 к сделке 31.07 — в списке 05.10 её быть не должно
    const r = resolveAmendments([row('O', '4', '2026-08-04', 25000, { at: '2026-08-04T18:01' }), row('F', '4/A', '2026-10-05', 25500, { orig: '2026-08-04' })]);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].acc, 'F', 'поля — из поправки');
    assert.equal(r.rows[0].sh, 25500);
    assert.equal(r.rows[0].fdate, '2026-08-04', 'дата — первой подачи');
    assert.equal(r.rows[0].famend, '2026-10-05');
    assert.equal(r.rows[0].at, '2026-08-04T18:01');
    // две поправки подряд — дата остаётся первой
    const two = resolveAmendments([row('O', '4', '2026-08-04', 25000), row('F1', '4/A', '2026-08-10', 25500, { orig: '2026-08-04' }), row('F2', '4/A', '2026-09-01', 26000, { orig: '2026-08-04' })]);
    assert.deepEqual(two.rows.map(x => [x.acc, x.fdate]), [['F2', '2026-08-04']]);
    // поправка к одной из двух исходных — замещает ту, на которую указывает
    const pick = resolveAmendments([row('X1', '4', '2026-09-11', 5000), row('X2', '4', '2026-09-14', 3000), row('XA', '4/A', '2026-09-20', 3100, { orig: '2026-09-14' })]);
    assert.deepEqual(pick.rows.map(x => [x.acc, x.fdate]).sort(), [['X1', '2026-09-11'], ['XA', '2026-09-14']]);
    // поправка без исходника — первое раскрытие, своя дата (BPRE 29.09)
    const solo = resolveAmendments([row('S', '4/A', '2026-09-29', 1000, { orig: '2026-09-23' }), row('T', '4', '2026-10-30', 50)]);
    assert.ok(solo.rows.some(x => x.acc === 'S' && x.fdate === '2026-09-29'));
  });

  ok('гейты/П8: поздняя подача (сделка старше 10 рабочих дней) отсеивается', () => {
    assert.equal(filingLagDays('2026-11-02', '2026-11-04'), 2);
    assert.equal(filingLagDays('2026-10-30', '2026-11-02'), 1);
    assert.equal(isLateFiling({ tdate: '2026-10-19', fdate: '2026-11-02' }), false, '10 рабочих дней — ещё вовремя');
    assert.equal(isLateFiling({ tdate: '2026-10-16', fdate: '2026-11-02' }), true);
    const late = { acc: 'L', form: '4', fdate: '2026-09-16', tdate: '2026-03-19', code: 'P', sh: 100, px: 10, val: 1000, sec: 'Common Stock', fn: {} };
    assert.equal(applyGates(late, {}).drop, 'late');
    assert.equal(applyGates({ ...late, tdate: '2026-09-14' }, {}).ok, true);
  });
}

// ==================== ЦЕНЫ И ДАТАСЕТЫ: объём в открытиях, очередь цен, новый адрес кварталов, ключ класса (PR fix-collect-3) ====================
// Ревизия данных 04.11.2026 (П9, П10, П13).
{
  const { dailyQueue, latestFilingDays, volumesOf } = await import('./lib/opens.mjs');
  const { secKey, fetchQuarter, DATASET_URLS } = await import('./lib/edgar.mjs');
  const { firstUncoveredDay, windowStart } = await import('./lib/livecal.mjs');
  const iwm = [200, 201, 199], spy = [500, 502, 499];

  ok('цены/П9: открытие, равное вчерашнему закрытию, — не застывшая котировка, если объём есть', () => {
    // CBU 31.08.2026: открытие 63,16 = закрытию 28.08, объём 196 638 — обычный торговый день
    const r = tradeResult([63.16, 62.75, 63.16, 196638], iwm, spy);
    assert.equal(r.skip, undefined, JSON.stringify(r));
    assert.ok(r.ex < 0);
    assert.equal(tradeResult([63.16, 63.16, 63.16, 0], iwm, spy).skip, 'frozen', 'нулевой объём — торгов не было');
    assert.equal(tradeResult([63.16, 62.75, 63.16], iwm, spy).skip, 'frozen', 'старая запись без объёма читается по прежнему правилу');
    assert.equal(tradeResult([63.0, 62.75, 63.16], iwm, spy).skip, undefined);
  });

  ok('цены/П9: запись открытий несёт объём дня из того же ответа', () => {
    const ohlc = [['2026-08-28', 63.23, 63.16], ['2026-08-31', 63.16, 62.75], ['2026-09-01', 62.8, 62.9]];
    const series = [['2026-08-28', 63.16, 63.16, 146981], ['2026-08-31', 62.75, 62.75, 196638]];
    const p = pickOpens(ohlc, ['2026-08-28'], { vol: volumesOf(series), from: '2026-08-01' });
    assert.deepEqual(p, { '2026-08-31': [63.16, 62.75, 63.16, 196638] });
    const q = pickOpens(ohlc, ['2026-08-31'], { vol: volumesOf(series), from: '2026-08-01' });
    assert.deepEqual(q, { '2026-09-01': [62.8, 62.9, 62.75] }, 'объёма нет в ответе — запись из трёх чисел');
  });

  ok('цены/П13: бумаги двух последних дней подачи — сразу после бенчмарков', () => {
    const trades = [
      { code: 'P', fdate: '2026-11-02' }, { code: 'P', fdate: '2026-11-03' }, { code: 'P', fdate: '2026-10-30' }, { code: 'S', fdate: '2026-11-04' },
    ];
    assert.deepEqual(latestFilingDays(trades), ['2026-11-02', '2026-11-03']);
    const all = new Map([
      ['OLDA', { recent: true, last: '2026-09-01' }], ['NEWB', { recent: true, last: '2026-11-03' }],
      ['DEAD', { recent: false, last: '2024-01-02' }], ['NEWA', { recent: true, last: '2026-11-02' }], ['MIDC', { recent: true, last: '2026-10-30' }],
    ]);
    assert.deepEqual(dailyQueue(all, ['SPY', 'IWM'], latestFilingDays(trades)), ['SPY', 'IWM', 'NEWA', 'NEWB', 'OLDA', 'MIDC']);
  });

  ok('датасеты/П10: ключ класса одинаков у формы XML и у датасета SEC', () => {
    assert.equal(secKey('Common Stock, par value $0.001 per share (&quot;Common Stock'), secKey('"Common Stock, par value $0.001 per share (""Common Stock"")"'));
    assert.equal(secKey('Virtus Dividend, Interest &amp; Premium Strategy Fund'), secKey('Virtus Dividend, Interest & Premium Strategy Fund'));
    assert.equal(secKey('Class "B1" Preferred Shares'), secKey('Class &quot;B1&quot; Preferred Shares'));
    assert.notEqual(secKey('Class A Common Stock'), secKey('Class B Common Stock'));
    assert.equal(secKey(null), '');
  });

  ok('датасеты/П10: окно живого контура сдвигается за загруженный квартал', () => {
    assert.equal(firstUncoveredDay(['2025q4', '2026q1']), '2026-04-01');
    assert.equal(firstUncoveredDay(['2026q1', '2026q2', '2026q3']), '2026-10-01');
    assert.equal(firstUncoveredDay(['2026q4']), '2027-01-01');
    assert.equal(windowStart('2026-04-01', ['2026q1', '2026q2', '2026q3']), '2026-10-01', 'прежний from не держит окно на апреле');
    assert.equal(windowStart('2026-09-01', ['2026q1']), '2026-09-01');
  });

  await okAsync('датасеты/П10: новый адрес кварталов первым, старый — запасным', async () => {
    const zip = makeQuarterZip();
    const seen = [];
    const srv = createServer((req, res) => {
      seen.push(req.url);
      const old = req.url === '/files/structureddata/data/insider-transactions-data-sets/2025q4_form345.zip';
      const fresh = req.url === '/files/datastandardsinnovation/data/insider-transactions-data-sets/2026q3_form345.zip';
      if (old || fresh) { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(zip); return; }
      res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html>Page Not Found</html>');
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const prev = process.env.EDGAR_BASE;
    process.env.EDGAR_BASE = `http://127.0.0.1:${srv.address().port}`;
    try {
      assert.match(DATASET_URLS('2026q3')[0], /datastandardsinnovation/);
      const a = await fetchQuarter('2026q3');
      assert.ok(a.data && a.data.trades.length === 3);
      assert.match(a.url, /datastandardsinnovation/);
      const b = await fetchQuarter('2025q4');
      assert.ok(b.data);
      assert.match(b.url, /structureddata/, 'старый квартал — по прежнему адресу');
      const c = await fetchQuarter('2027q1');
      assert.equal(c.data, null, 'неопубликованный квартал — по обоим адресам 404');
      assert.equal(seen.filter(u => u.includes('2027q1')).length, 2);
    } finally {
      if (prev === undefined) delete process.env.EDGAR_BASE; else process.env.EDGAR_BASE = prev;
      await new Promise(r => srv.close(r));
    }
  });
}

ok('датасеты: флажок 10b5-1 «true» и сноска о плане на поле свопа — покупка плановая (CRBG, Nippon Life, 2026q3)', () => {
  const z = zipCreate({
    'SUBMISSION.tsv': 'ACCESSION_NUMBER\tFILING_DATE\tDOCUMENT_TYPE\tISSUERCIK\tISSUERNAME\tISSUERTRADINGSYMBOL\tAFF10B5ONE\tDATE_OF_ORIG_SUB\tREMARKS\nN-1\t11-SEP-2026\t4\t1889539\tCorebridge\tCRBG\ttrue\t\t\nN-2\t11-SEP-2026\t4\t1889539\tCorebridge\tCRBG\tfalse\t\t',
    'REPORTINGOWNER.tsv': 'ACCESSION_NUMBER\tRPTOWNERCIK\tRPTOWNERNAME\tRPTOWNER_RELATIONSHIP\tRPTOWNER_TITLE\nN-1\t9\tNIPPON LIFE INSURANCE CO\tTenPercentOwner\t\nN-2\t9\tNIPPON LIFE INSURANCE CO\tTenPercentOwner\t',
    'NONDERIV_TRANS.tsv': 'ACCESSION_NUMBER\tTRANS_DATE\tTRANS_CODE\tEQUITY_SWAP_INVOLVED\tTRANS_SHARES\tTRANS_PRICEPERSHARE\tSHRS_OWND_FOLWNG_TRANS\tDIRECT_INDIRECT_OWNERSHIP\tEQUITY_SWAP_TRANS_CD_FN\tTRANS_SHARES_FN\nN-1\t10-SEP-2026\tP\t0\t136500\t33.78\t122092722\tD\t\t\nN-2\t10-SEP-2026\tP\t0\t136500\t33.78\t122092722\tD\tF1\t',
    'FOOTNOTES.tsv': 'ACCESSION_NUMBER\tFOOTNOTE_ID\tFOOTNOTE_TXT\nN-2\tF1\tThe purchases reported herein were effected pursuant to a Rule 10b5-1 plan adopted by the Reporting Person on August 7, 2026.',
  });
  const { trades } = normalizeQuarterZip(z);
  assert.equal(trades.find(r => r.acc === 'N-1').b5, 1, 'флажок «true»');
  assert.equal(trades.find(r => r.acc === 'N-2').fn.b5, 1, 'сноска на EQUITY_SWAP_TRANS_CD_FN — поле сделки');
  assert.ok(trades.every(r => isPlanned(r)));
});

// ---------- сбор: предохранитель на лимит SEC; бюджет времени бэкфила ----------
{
  const { readJsonGz } = await import('./lib/util.mjs');
  const { PARSER_REV } = await import('./lib/edgar.mjs');
  const RTMP = join(ROOT, '.selftest-ratelimit');
  rmSync(RTMP, { recursive: true, force: true });
  const RATE_HTML = '<html><body>Request Rate Threshold Exceeded</body></html>';
  const S3_MISSING = '<Error><Code>AccessDenied</Code></Error>';
  const accN = n => `0000000007-26-${String(n).padStart(6, '0')}`;
  const pathOf = acc => `edgar/data/444/${acc.replace(/-/g, '')}/${acc}.txt`;
  const line = acc => `4                ${'ISSUER'.padEnd(62)}${'444'.padEnd(12)}20260908    ${pathOf(acc)}`;
  const body = acc => `<SEC-DOCUMENT>\n<ACCEPTANCE-DATETIME>20260908171500\n<XML>\n<ownershipDocument><documentType>4</documentType><issuer><issuerCik>444</issuerCik><issuerTradingSymbol>RLT</issuerTradingSymbol></issuer><reportingOwner><reportingOwnerId><rptOwnerCik>8</rptOwnerCik><rptOwnerName>Roe Jane</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>1</isDirector></reportingOwnerRelationship></reportingOwner><nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-09-04</value></transactionDate><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${Number(acc.slice(-2)) * 100}</value></transactionShares><transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>9000</value></sharesOwnedFollowingTransaction></postTransactionAmounts><ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>\n</XML>`;
  const accs = [1, 2, 3, 4, 5].map(accN);
  let blocked = true;
  const hits = [];
  const zip = makeQuarterZip();
  const srv = createServer((req, res) => {
    const url = decodeURIComponent(req.url);
    hits.push(url);
    if (/form\.20260908\.idx$/.test(url)) { res.writeHead(200); res.end(['x', ...accs.map(line)].join('\n')); return; }
    if (/daily-index/.test(url)) { res.writeHead(403); res.end(S3_MISSING); return; }
    if (/insider-transactions-data-sets\/2026q\d_form345\.zip$/.test(url)) { res.writeHead(200); res.end(zip); return; }
    const acc = accs.find(a => url.endsWith(a + '.txt'));
    if (!acc) { res.writeHead(404); res.end(); return; }
    if (blocked) { res.writeHead(403, { 'content-type': 'text/html' }); res.end(RATE_HTML); return; }
    res.writeHead(200); res.end(body(acc));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const env = { ...process.env, EDGAR_BASE: base, POLITE_BACKOFF_MS: '2' };
  const run = (script, args) => new Promise(resolve => execFile(process.execPath, [join(ROOT, 'scripts', script), '--data', RTMP, ...args],
    { encoding: 'utf8', env }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: stdout + stderr })));
  try {
    mkdirSync(join(RTMP, 'state'), { recursive: true });
    writeJson(join(RTMP, 'state', 'live.json'), { schema: SHARD_VERSION, from: '2026-09-01', lastDay: '2026-09-07', parserRev: PARSER_REV });
    writeJsonGz(join(RTMP, 'trades', 'live.json.gz'), { v: SHARD_VERSION, trades: [], amend: [] });

    await okAsync('сбор: три подачи подряд упёрлись в лимит SEC — остаток дня в добор без запросов, следующий день не трогаем', async () => {
      const r = await run('live.mjs', ['--today', '2026-09-10', '--retries', '0']);
      assert.equal(r.code, 0, r.out);
      const s = JSON.parse(readFileSync(join(RTMP, 'state', 'live.json'), 'utf8'));
      assert.equal(hits.filter(h => h.endsWith('.txt')).length, 3, 'запрошены только первые три подачи');
      assert.equal(Object.keys(s.pending['2026-09-08']).length, 5, 'все пять ждут добора');
      assert.equal(s.coverage['2026-09-08'].status, 'partial');
      assert.equal(s.coverage['2026-09-08'].error, 'лимит SEC');
      assert.ok(!hits.some(h => /form\.20260909\.idx$/.test(h)), 'индекс следующего дня в этом прогоне не запрашивался');
      assert.match(s.lastError.msg, /лимит SEC/);
      assert.equal(s.lastDay, '2026-09-08');
    });

    await okAsync('сбор: после снятия лимита отложенные подачи добираются', async () => {
      blocked = false;
      const r = await run('live.mjs', ['--today', '2026-09-10', '--retries', '0']);
      assert.equal(r.code, 0, r.out);
      const s = JSON.parse(readFileSync(join(RTMP, 'state', 'live.json'), 'utf8'));
      assert.equal(s.pending, undefined);
      assert.equal(s.coverage['2026-09-08'].status, 'complete');
      assert.equal(readJsonGz(join(RTMP, 'trades', 'live.json.gz')).trades.length, 5);
    });

    await okAsync('бэкфил: перечитывание кварталов прерывается бюджетом и продолжается следующим запуском', async () => {
      writeJson(join(RTMP, 'state', 'backfill.json'), { schema: SHARD_VERSION, quarterRev: 1, done: ['2026q1', '2026q2'], missing: [] });
      const r1 = await run('backfill.mjs', ['--from-year', '2026', '--time-budget-min', '0.000001']);
      assert.equal(r1.code, 0, r1.out);
      const b1 = JSON.parse(readFileSync(join(RTMP, 'state', 'backfill.json'), 'utf8'));
      assert.ok(b1.rebuildFrom, 'перечитывание не закончено — метка остаётся для следующей итерации');
      assert.notEqual(b1.quarterRev, 3);
      assert.deepEqual(b1.done, ['2026q1'], 'за прогон с исчерпанным бюджетом — ровно один квартал');
      const r2 = await run('backfill.mjs', ['--from-year', '2026']);
      assert.equal(r2.code, 0, r2.out);
      const b2 = JSON.parse(readFileSync(join(RTMP, 'state', 'backfill.json'), 'utf8'));
      assert.equal(b2.rebuildFrom, undefined);
      assert.ok(b2.quarterRev >= 3);
      assert.ok(b2.done.includes('2026q1'));
    });
  } finally {
    await new Promise(r => srv.close(r));
    rmSync(RTMP, { recursive: true, force: true });
  }
}

// ==================== АУДИТ ФОРМ 17.11.2026 (audit-840-forms-2026-11-17/REPORT.md), пакет A: разбор и отбор ====================
{
  const { titleFlags, roleFlags, PARSER_REV, QUARTER_REV } = await import('./lib/edgar.mjs');
  const universeLib = await import('./lib/universe.mjs');
  const gatesLib = await import('./lib/gates.mjs');
  // Квартальный датасет с заданными строками сделок: [подача, дата, код, акции, цена, остаток, класс, A/D]
  const quarterZip = (rows, owners = [['Q-1', 900, 'Ivanov Ivan', 'Director', '']]) => zipCreate({
    'SUBMISSION.tsv': ['ACCESSION_NUMBER\tFILING_DATE\tDOCUMENT_TYPE\tISSUERCIK\tISSUERNAME\tISSUERTRADINGSYMBOL\tAFF10B5ONE\tDATE_OF_ORIG_SUB\tREMARKS',
      ...[...new Set(rows.map(r => r[0]))].map(acc => `${acc}\t05-FEB-2020\t4\t111\tAlpha Corp\tALFA\t0\t\t`)].join('\n'),
    'REPORTINGOWNER.tsv': ['ACCESSION_NUMBER\tRPTOWNERCIK\tRPTOWNERNAME\tRPTOWNER_RELATIONSHIP\tRPTOWNER_TITLE', ...owners.map(o => o.join('\t'))].join('\n'),
    'NONDERIV_TRANS.tsv': ['ACCESSION_NUMBER\tSECURITY_TITLE\tTRANS_DATE\tTRANS_CODE\tEQUITY_SWAP_INVOLVED\tTRANS_SHARES\tTRANS_PRICEPERSHARE\tTRANS_ACQUIRED_DISP_CD\tSHRS_OWND_FOLWNG_TRANS\tDIRECT_INDIRECT_OWNERSHIP',
      ...rows.map(([acc, d, code, sh, px, own, sec, ad]) => `${acc}\t${sec}\t${d}\t${code}\t0\t${sh}\t${px}\t${ad ?? 'A'}\t${own}\tD`)].join('\n'),
    'FOOTNOTES.tsv': 'ACCESSION_NUMBER\tFOOTNOTE_ID\tFOOTNOTE_TXT',
  });
  // Форма 4 в XML с заданными строками: [дата, код, акции, цена, класс, A/D]
  const xmlForm = (rows, { title = '', officer = 0, director = 1, remarks = '' } = {}) => `<SEC-DOCUMENT>\n<XML>\n<ownershipDocument><documentType>4</documentType>`
    + `<issuer><issuerCik>111222</issuerCik><issuerTradingSymbol>TST</issuerTradingSymbol></issuer><aff10b5One>0</aff10b5One>`
    + `<reportingOwner><reportingOwnerId><rptOwnerCik>900901</rptOwnerCik><rptOwnerName>Doe John</rptOwnerName></reportingOwnerId>`
    + `<reportingOwnerRelationship><isDirector>${director}</isDirector><isOfficer>${officer}</isOfficer><officerTitle>${title}</officerTitle></reportingOwnerRelationship></reportingOwner>`
    + `<nonDerivativeTable>${rows.map(([d, code, sh, px, sec, ad]) => `<nonDerivativeTransaction><securityTitle><value>${sec}</value></securityTitle>`
      + `<transactionDate><value>${d}</value></transactionDate><transactionCoding><transactionCode>${code}</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>`
      + `<transactionAmounts><transactionShares><value>${sh}</value></transactionShares><transactionPricePerShare><value>${px}</value></transactionPricePerShare>`
      + `<transactionAcquiredDisposedCode><value>${ad ?? 'A'}</value></transactionAcquiredDisposedCode></transactionAmounts>`
      + `<postTransactionAmounts><sharesOwnedFollowingTransaction><value>90000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>`
      + `<ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction>`).join('')}</nonDerivativeTable>`
    + `<remarks>${remarks}</remarks></ownershipDocument>\n</XML>\n</SEC-DOCUMENT>`;

  ok('A4: класс бумаги, записанный в одной форме двумя способами, — одна строка с полной суммой (оба разбора)', () => {
    // 0001127602-23-029699 (15.12.2023): в форме $2,0 млн, у панели оставалось $176 тыс. — второй агрегат затирал первый по ключу строки
    const rows = [['Q-1', '03-FEB-2020', 'P', 100000, 18, 500000, 'Common Stock'], ['Q-1', '03-FEB-2020', 'P', 10000, 17.6, 510000, 'Common stock'],
      ['Q-1', '03-FEB-2020', 'P', 500, 25, 500, 'Series A Preferred Stock']];
    const q = normalizeQuarterZip(quarterZip(rows)).trades;
    assert.equal(q.length, 2, 'обыкновенные — одна строка, привилегированные — своя');
    const c = q.find(r => /common/i.test(r.sec));
    assert.equal(c.sh, 110000); assert.equal(c.val, 1976000); assert.equal(c.own, 510000);
    const x = parseForm4Txt(xmlForm([['2020-02-03', 'P', 100000, 18, 'Common Stock'], ['2020-02-03', 'P', 10000, 17.6, 'Common  stock']]), 'X-1', '2020-02-05').trades;
    assert.equal(x.length, 1); assert.equal(x[0].sh, 110000); assert.equal(x[0].val, 1976000);
    // ключ строки шарда у слитого агрегата один — в шарде не остаётся «победившей» половины
    const key = r => `${r.acc}|${r.code}|${r.tdate}|${r.sec.toLowerCase().replace(/\s+/g, ' ')}`;
    assert.equal(new Set(q.map(key)).size, q.length);
  });

  ok('A4: покупка с кодом «выбытие» — не покупка: помечается и отсеивается, рядом с обычной покупкой в сумму не входит (оба разбора)', () => {
    // только «выбытие»: строка остаётся в шарде под прежним ключом (перечитывание замещает на месте), но с пометкой и отсевом
    const only = normalizeQuarterZip(quarterZip([['Q-1', '03-FEB-2020', 'P', 5000, 20, 0, 'Common Stock', 'D']])).trades;
    assert.equal(only.length, 1); assert.equal(only[0].ad, 'D'); assert.equal(only[0].val, 100000);
    assert.equal(applyGates(only[0], { close: 20 }).drop, 'disposed');
    // обычная покупка и «выбытие» в одной подаче, дате и классе: в шарде — только обычная покупка, без пометки
    const mix = normalizeQuarterZip(quarterZip([['Q-1', '03-FEB-2020', 'P', 5000, 20, 0, 'Common Stock', 'D'], ['Q-1', '03-FEB-2020', 'P', 1000, 21, 9000, 'Common Stock', 'A']])).trades;
    assert.equal(mix.length, 1); assert.equal(mix[0].sh, 1000); assert.equal(mix[0].val, 21000); assert.equal('ad' in mix[0], false);
    assert.equal(applyGates(mix[0], { close: 21 }).ok, true);
    // продажа с любым кодом и обычная покупка не затронуты
    const sale = normalizeQuarterZip(quarterZip([['Q-1', '03-FEB-2020', 'S', 5000, 20, 0, 'Common Stock', 'D']])).trades;
    assert.equal(sale.length, 1); assert.equal('ad' in sale[0], false);
    const xOnly = parseForm4Txt(xmlForm([['2020-02-03', 'P', 5000, 20, 'Common Stock', 'D']]), 'X-2', '2020-02-05').trades;
    assert.equal(xOnly.length, 1); assert.equal(xOnly[0].ad, 'D'); assert.equal(applyGates(xOnly[0], { close: 20 }).drop, 'disposed');
    const xMix = parseForm4Txt(xmlForm([['2020-02-03', 'P', 5000, 20, 'Common Stock', 'D'], ['2020-02-03', 'P', 1000, 21, 'Common Stock', 'A']]), 'X-3', '2020-02-05').trades;
    assert.equal(xMix.length, 1); assert.equal(xMix[0].sh, 1000); assert.equal('ad' in xMix[0], false);
    // строка без поля (старый шард до перечитывания) проходит как раньше
    assert.equal(applyGates({ code: 'P', px: 20, fn: {} }, { close: 20 }).ok, true);
  });

  ok('A4: роль в живом разборе — только из титула офицера, примечания формы её не дают', () => {
    // Jefferies / Sumitomo Mitsui: «…Deputy President of SMFG…» в примечаниях давало C всем подателям с пустым титулом
    const remarks = 'Mr. Smith serves as Deputy President of the parent and as CFO of an affiliate.';
    const r = parseForm4Txt(xmlForm([['2020-02-03', 'P', 1000, 20, 'Common Stock']], { remarks }), 'X-4', '2020-02-05').trades[0];
    assert.equal(r.owners[0].rel, 'D', 'директор без титула остаётся директором');
    assert.equal(/[CFO]/.test(r.owners[0].rel), false, 'ложного балла «офицер» нет');
    const ceo = parseForm4Txt(xmlForm([['2020-02-03', 'P', 1000, 20, 'Common Stock']], { title: 'Chief Executive Officer', officer: 1, remarks }), 'X-5', '2020-02-05').trades[0];
    assert.equal(ceo.owners[0].rel, 'DOC');
  });

  ok('A4: «Vice President» — не CEO; CFO определяется независимо; признак «офицер» не меняется', () => {
    assert.equal(titleFlags('Vice President'), '');
    assert.equal(titleFlags('Executive Vice President, General Counsel'), '');
    assert.equal(titleFlags('Sr. Vice-President & CFO'), 'F', 'раньше — C: слово president стояло первым');
    assert.equal(titleFlags('Vice President and Chief Financial Officer'), 'F');
    assert.equal(titleFlags('President and CFO'), 'CF');
    assert.equal(titleFlags('President'), 'C');
    assert.equal(titleFlags('Vice Chairman and President'), 'C');
    assert.equal(titleFlags('Vice President; President of ABC Division'), 'C', 'президент рядом с вице-президентом остаётся президентом');
    assert.equal(titleFlags('Chief Executive Officer'), 'C');
    assert.equal(titleFlags('EVP, CFO'), 'F');
    assert.equal(titleFlags(''), '');
    // офицер — C, F или O в rel. Вице-президент с флажком офицера — O, без флажка — офицер по титулу (раньше им был через C)
    const officer = rel => /[CFO]/.test(rel);
    assert.equal(relFlags('Officer', 'Senior Vice President'), 'O');
    assert.equal(relFlags('Director', 'Vice President'), 'DO');
    assert.equal(roleFlags('', 'Vice President'), 'XO');
    for (const [rel, title] of [['Officer', 'Vice President'], ['Director', 'Vice President'], ['', 'Vice President'], ['Director, Officer', 'EVP'], ['Director', ''], ['TenPercentOwner', '']]) {
      const old = (rel ? relFlags(rel, '') : 'X') + (/\bceo\b|chief\s+exec|\bpres(?:ident)?\b/.test(title.toLowerCase()) ? 'C' : '');
      assert.equal(officer(relFlags(rel, title)), officer(old), `офицер не изменился: ${rel} / ${title}`);
    }
    const r = parseForm4Txt(xmlForm([['2020-02-03', 'P', 1000, 20, 'Common Stock']], { title: 'Vice President &amp; CFO', officer: 1, director: 0 }), 'X-6', '2020-02-05').trades[0];
    assert.equal(r.owners[0].rel, 'OF');
  });

  ok('A4: ревизии разбора подняты — кварталы и живое окно перечитываются', () => {
    assert.equal(PARSER_REV, 3); assert.equal(QUARTER_REV, 4);
  });

  ok('A5: поправка находит исходную форму при любом порядке подателей (Carvana 14 и 15.06.2022 — одно событие)', () => {
    const { ownerKeyOf } = universeLib;
    const garcia = { cik: 1017608, name: 'GARCIA ERNEST C. II', rel: 'T', title: '' }, verde = { cik: 1704727, name: 'VERDE INVESTMENTS, INC.', rel: 'T', title: '' };
    const row = (o, extra = {}) => ({ acc: 'CV-1', form: '4', fdate: '2022-06-14', tdate: '2022-06-13', cik: 1690820, t: 'CVNA', owners: o, code: 'P', sh: 1191468, px: 20.67, val: 24628050,
      own: 5e6, di: 'I', ownD: null, shD: null, b5: 0, orig: null, sec: 'Class A Common Stock', fn: {}, ...extra });
    const d = join(TMP, '..', '.selftest-amendkey');
    rmSync(d, { recursive: true, force: true });
    writeJsonGz(join(d, 'trades', '2022.json.gz'), { v: SHARD_VERSION, amend: [], trades: [
      row([garcia, verde]),
      row([verde, garcia], { acc: 'CV-2', form: '4/A', fdate: '2022-06-15', orig: '2022-06-14' }),            // у поправки податели в другом порядке
      row([{ cik: 1700538, name: 'GILL DANIEL J.', rel: 'O', title: 'Chief Product Officer' }], { acc: 'CV-3', sh: 94000, px: 21.77, val: 2046380 }),   // другое лицо, та же дата — не трогается
    ] });
    const { trades, stats } = loadAllTrades(d);
    assert.equal(trades.length, 2, 'исходная форма и поправка — одна строка, покупка другого лица — своя');
    const g = trades.find(r => r.val === 24628050);
    assert.equal(g.form, '4/A'); assert.equal(g.fdate, '2022-06-14', 'поправка встала на место исходной: дата раскрытия — день первой подачи');
    assert.equal(g.famend, '2022-06-15'); assert.equal(stats.replacedByAmendment, 1);
    assert.equal(ownerKeyOf({ owners: [verde, garcia] }), 1017608); assert.equal(ownerKeyOf({ owners: [] }), 0); assert.equal(ownerKeyOf({}), 0);
    rmSync(d, { recursive: true, force: true });
  });

  ok('A5 (ревью): поправка, добавившая подателя с меньшим номером, находит исходную форму по общему подателю; чужие исходные формы не объединяются', () => {
    const fund = { cik: 946770, name: 'FUND LP', rel: 'T', title: '' }, dir1 = { cik: 1500001, name: 'DOE JOHN', rel: 'D', title: '' }, dir2 = { cik: 1500002, name: 'ROE JANE', rel: 'D', title: '' };
    const row = (acc, o, extra = {}) => ({ acc, form: '4', fdate: '2018-03-15', tdate: '2018-03-13', cik: 1283699, t: 'TMUS', owners: o, code: 'P', sh: 200000, px: 66.5, val: 13300000,
      own: 5e6, di: 'I', ownD: null, shD: null, b5: 0, orig: null, sec: 'Common Stock', fn: {}, ...extra });
    const d = join(TMP, '..', '.selftest-amendkey2');
    const load = rows => { rmSync(d, { recursive: true, force: true }); writeJsonGz(join(d, 'trades', '2018.json.gz'), { v: SHARD_VERSION, amend: [], trades: rows }); return loadAllTrades(d); };
    // исходную форму подал один директор, в поправке к нему добавлен фонд с меньшим CIK: наименьший номер у двух подач разный
    let r = load([row('TM-1', [dir1]), row('TM-2', [fund, dir1], { form: '4/A', fdate: '2018-03-19', orig: '2018-03-15' }), row('TM-3', [dir2], { sh: 5000, px: 66.4, val: 332000 })]);
    assert.equal(r.trades.length, 2, 'поправка встала на место исходной формы, покупка другого директора — своя строка');
    const g = r.trades.find(x => x.acc === 'TM-2');
    assert.equal(g.fdate, '2018-03-15', 'дата раскрытия — день первой подачи'); assert.equal(g.famend, '2018-03-19');
    assert.deepEqual([r.stats.replacedByAmendment, r.stats.rejoinedAmendments], [1, 1]);
    // две исходные формы разных директоров, поправка называет обоих: к которой она относится, неизвестно — ничего не трогаем
    r = load([row('TM-1', [dir1]), row('TM-3', [dir2], { sh: 5000, px: 66.4, val: 332000 }), row('TM-4', [fund, dir1, dir2], { form: '4/A', fdate: '2018-03-19', orig: '2018-03-15' })]);
    assert.equal(r.trades.length, 3); assert.equal(r.stats.rejoinedAmendments, 0);
    // общих подателей нет — поправка остаётся первым раскрытием со своей датой
    r = load([row('TM-1', [dir1]), row('TM-5', [fund], { form: '4/A', fdate: '2018-03-19', orig: '2018-03-15' })]);
    assert.equal(r.trades.length, 2); assert.equal(r.trades.find(x => x.acc === 'TM-5').fdate, '2018-03-19');
    rmSync(d, { recursive: true, force: true });
  });

  ok('A6: «Preference Shares» — не обыкновенные акции', () => {
    assert.equal(isNonCommon('Series A Preference Shares'), true);
    assert.equal(isNonCommon('7.00% Cumulative Preference Shares'), true);
    assert.equal(applyGates({ code: 'P', px: 25, fn: {}, sec: 'Series A Preference Shares' }, { close: 25 }).drop, 'security');
    for (const s of ['Common Stock', 'Ordinary Shares', 'American Depositary Shares', 'Class A Common Stock']) assert.equal(isNonCommon(s), false, s);
  });

  ok('A2: покупка с ценой формы выше закрытия дня сделки больше чем в 1,25 раза — не покупка (Cemex 25.09.2026)', () => {
    // 400 800 сертификатов по 17,28 песо при цене расписки $9,71: «сумма» $6,93 млн, балл «от $1 млн»
    const cx = { code: 'P', px: 17.28, sh: 400800, val: 6925824, fn: { wavg: 1 }, sec: 'Ordinary Participation Certificates (CEMEX.CPO)' };
    assert.equal(applyGates(cx, { close: 9.71 }).drop, 'premium');
    const base = { code: 'P', px: 10, fn: {}, di: 'D' };
    assert.equal(applyGates(base, { close: 8.01 }).ok, true, 'отношение 1,248 — проходит');
    assert.equal(applyGates(base, { close: 8 }).ok, true, 'ровно 1,25 — проходит: порог строгий');
    assert.equal(applyGates(base, { close: 7.99 }).drop, 'premium');
    assert.equal(applyGates(base, { close: 0.9 }).drop, 'outlier', 'больше десятикратной — по-прежнему «выброс»');
    assert.equal(applyGates({ ...base, code: 'S' }, { close: 7 }).ok, true, 'продаж правило не касается');
    assert.equal(applyGates(base, { close: null, noPrice: true }).ok, true, 'нет котировки — сверять не с чем');
    assert.equal(applyGates({ ...base, fn: { offering: 1 } }, { close: 7 }).drop, 'offering', 'у размещения остаётся своя причина');
  });

  ok('A3: «другие единицы» — признак эмитента, отсев — по строке: расписки TSM за доллары проходят, акции в местной валюте — нет', () => {
    const { unitsRowMismatch, UNITS_TOL } = gatesLib;
    const ads = { code: 'P', px: 322.05, sh: 1000, val: 322050, fn: {}, sec: 'American Depositary Shares (TSM)' };          // Бёрнс, 01.04.2026
    const twd = { code: 'P', px: 71.7867, sh: 3000, val: 215360, fn: {}, sec: 'Common Shares (2330.TW)' };                  // 21.07.2026
    assert.equal(applyGates(ads, { close: 337.95, unitsMismatch: true }).ok, true, 'цена расписки сходится с котировкой (0,953) — строка идёт дальше');
    assert.equal(applyGates(twd, { close: 398.37, unitsMismatch: true }).drop, 'units', 'отношение 0,18 — другие единицы');
    assert.equal(applyGates(twd, { close: 398.37, unitsMismatch: false }).drop, 'discount', 'без признака эмитента — как раньше');
    // строка со сходящейся ценой проходит ОСТАЛЬНЫЕ гейты, а не просто пропускается
    assert.equal(applyGates(ads, { close: 337.95, unitsMismatch: true, planned: true }).drop, 'planned');
    assert.equal(applyGates({ ...ads, px: 290 }, { close: 337.95, unitsMismatch: true }).drop, 'discount', 'отношение 0,858 — в допуске единиц, дальше решает гейт дисконта');
    assert.equal(applyGates({ ...ads, px: 290 }, { close: 337.95, unitsMismatch: true, lows: [288, 300] }).ok, true, 'внутри дневного диапазона — проходит');
    assert.equal(applyGates({ ...ads, px: 280 }, { close: 337.95, unitsMismatch: true }).drop, 'units', 'отношение 0,829 — вне допуска');
    // нет цены формы или котировки — сверить нечем: у эмитента с признаком строка отсеивается, как раньше
    assert.equal(applyGates({ ...ads, px: null, val: 0 }, { close: 337.95, unitsMismatch: true }).drop, 'units');
    assert.equal(applyGates(ads, { close: null, unitsMismatch: true, noPrice: true }).drop, 'units');
    assert.equal(UNITS_TOL, 0.15);
    assert.equal(unitsRowMismatch(10, 10), false); assert.equal(unitsRowMismatch(11.5, 10), false); assert.equal(unitsRowMismatch(11.6, 10), true); assert.equal(unitsRowMismatch(8.4, 10), true);
  });

  // ---------- A1: иностранные частные эмитенты (lib/fpi.mjs) ----------
  const fpi = await import('./lib/fpi.mjs');
  const { FPI } = fpi;
  const allQ = []; for (let y = 2016; y <= 2026; y++) for (let q = 1; q <= 4; q++) if (`${y}q${q}` <= '2026q3') allQ.push(`${y}q${q}`);

  ok('A1: индекс SEC — строки отчётов иностранного эмитента (20-F, 40-F, 6-K и поправки), дневной и квартальный формат', () => {
    const idx = [
      'Form Type   Company Name                                                  CIK         Date Filed  File Name',
      '6-K              Pampa Energia S.A.                                            1469395     20261110    edgar/data/1469395/0001292814-26-004001.txt   ',
      '6-K/A            TOYOTA  MOTOR CORP/                                           1094517     20261110    edgar/data/1094517/0001094517-26-000090.txt',
      '20-F             AMDOCS LTD                                                    1062579     2026-10-30  edgar/data/1062579/0001062579-26-000031.txt         ',
      '40-F/A           Uranium Royalty Corp.                                         1711570     2026-07-24  edgar/data/1711570/0001711570-26-000050.txt',
      '10-K             Alpha Corp                                                    111         20261110    edgar/data/111/0000000111-26-000001.txt',
      '4                DOE  JOHN                                                     777         20261110    edgar/data/777/0000000009-26-000001.txt',
      'F-1              New Foreign Co                                                888         20261110    edgar/data/888/0000000888-26-000001.txt',
      'NT 20-F          Late Filer Ltd                                                999         20261110    edgar/data/999/0000000999-26-000001.txt',
    ].join('\r\n');
    assert.deepEqual(fpi.parseFpiIdx(idx), [{ cik: 1469395, date: '2026-11-10' }, { cik: 1094517, date: '2026-11-10' }, { cik: 1062579, date: '2026-10-30' }, { cik: 1711570, date: '2026-07-24' }]);
    assert.equal(parseFormIdx(idx).length, 1, 'строки форм 4 разбираются как раньше');
    const ref = fpi.emptyFpiForms();
    assert.equal(fpi.absorbFpiForms(ref, fpi.parseFpiIdx(idx), '2026-11-10'), true);
    assert.deepEqual(ref.ciks, { 1469395: '2026-11-10', 1094517: '2026-11-10', 1062579: '2026-10-30', 1711570: '2026-07-24' }); assert.equal(ref.asOf, '2026-11-10');
    assert.equal(fpi.absorbFpiForms(ref, [{ cik: 1469395, date: '2026-10-01' }], '2026-11-09'), false, 'более ранняя дата и более ранний день ничего не меняют');
    assert.equal(fpi.absorbFpiForms(ref, [], '2026-11-12'), true, 'день без отчётов всё равно двигает asOf'); assert.equal(ref.asOf, '2026-11-12');
    assert.deepEqual(fpi.fillQuartersFor('2026-11-18').map(x => x.key), ['2025q4', '2026q1', '2026q2', '2026q3', '2026q4']);
    assert.deepEqual(fpi.fillQuartersFor('2027-02-01').map(x => x.key), ['2026q1', '2026q2', '2026q3', '2026q4', '2027q1']);
    assert.equal(fpi.fullIndexUrl('https://www.sec.gov', 2026, 4), 'https://www.sec.gov/Archives/edgar/full-index/2026/QTR4/form.gz');
  });

  ok('A1: квартальный датасет отдаёт первую форму 3/4/5 по эмитенту (все типы документов); справочник складывается по кварталам', () => {
    const first = normalizeQuarterZip(makeQuarterZip()).first;
    assert.deepEqual(first, { 111: '2020-02-05' }, 'самая ранняя подача эмитента, считая форму 3 и поправки');
    const ref = { v: 1, quarters: [], first: {} };
    assert.equal(fpi.mergeFirstForms(ref, '2020q1', first), 1);
    assert.equal(fpi.mergeFirstForms(ref, '2019q4', { 111: '2019-12-30', 222: '2019-11-01' }), 2, 'более ранний квартал сдвигает дату назад');
    assert.equal(fpi.mergeFirstForms(ref, '2020q2', { 111: '2020-05-01' }), 0);
    assert.deepEqual(ref.first, { 111: '2019-12-30', 222: '2019-11-01' }); assert.deepEqual(ref.quarters, ['2019q4', '2020q1', '2020q2']);
    assert.equal(fpi.firstFormCovers(allQ), true);
    assert.equal(fpi.firstFormCovers(allQ.filter(q => q !== '2021q3')), false, 'идёт перечитывание кварталов — справочник неполон');
    assert.equal(fpi.firstFormCovers(allQ.filter(q => q > '2026q1')), false);
    assert.equal(fpi.firstFormCovers(allQ.filter(q => q <= '2026q1')), true, 'кварталы после границы закона на признак не влияют');
  });

  ok('A1: вердикт — новый податель с отчётами иностранного эмитента или с давним листингом; старый податель, новый листинг и преемник не помечаются', () => {
    const refs = { first: new Map([[100, '2016-01-05'], [200, '2026-03-12'], [300, '2026-02-26'], [310, '2025-12-17'], [320, '2026-01-15'], [400, '2026-03-18'], [500, '2026-05-08'], [600, '2026-07-01']]),
      forms: new Map([100, 200, 300, 310, 700].map(c => [c, '2026-11-02'])), formsAsOf: '2026-11-16', warn: [] };   // у всех свежий отчёт 6-K
    const ranges = { LONGA: [[1, '1998-06-19', '2026-11-16']], DOLE: [[1, '2009-10-23', '2013-11-01'], [1, '2021-07-30', '2026-11-16']], NVRI: [[1, '1987-11-05', '2026-05-29'], [1, '2026-05-27', '2026-11-16']],
      ITG: [[1, '1994-05-04', '2026-07-01'], [1, '2026-07-01', '2026-11-16']], NEWL: [[1, '2026-06-10', '2026-11-16']], GONE: [[1, '2001-01-02', '2019-12-20']] };
    const before = fpi.tickersBeforeLaw([{ t: 'nvri', cik: 45876, fdate: '2025-12-09' }, { t: 'ITG', cik: 9, fdate: '2019-02-01' }, { t: 'DOLE', cik: 400, fdate: '2026-04-01' }]);
    const v = (cik, ticker, bar0 = '2014-01-02', fdate = '2026-11-12') => fpi.fpiVerdict({ cik, ticker, fdate, bar0 }, refs, { ranges, before });
    assert.equal(v(100, 'LONGA'), null, 'формы были до закона — эмитент в измеренной выборке, хотя и подаёт 6-K');
    assert.equal(v(200, 'PAM'), 'forms', 'PAM: первая форма 12.03.2026 — после принятия правил 27.02, до вступления закона в силу 18.03');
    assert.equal(v(300, 'X'), 'forms', 'первая форма 26.02.2026 — после подписания закона 18.12.2025, отчёты иностранного эмитента подаёт (ранняя подача: FTS, SKM, PAC)');
    assert.equal(v(310, 'X'), null, 'первая форма до подписания закона — эмитент в измеренной выборке');
    assert.equal(v(320, 'LONGA'), null, 'отчётов иностранного эмитента нет, первая форма 15.01.2026 — до принятия правил: ушедший из статуса иностранного эмитента не помечается');
    assert.equal(v(700, 'NEWL', '2026-06-10'), 'forms', 'эмитента нет в квартальных файлах, отчёты иностранного эмитента подаёт — новый иностранный листинг');
    assert.equal(v(400, 'DOLE', '2021-07-30'), 'listed', 'местные формы отчётности, но листинг давний и форм до закона не было');
    assert.equal(v(500, 'NVRI'), null, 'тот же тикер стоял в формах прежнего регистранта — смена CIK, не новый податель');
    assert.equal(v(600, 'ITG', '2026-07-01'), null, 'реестр склеил старую и новую компании под одним тикером, но ряд начинается с IPO 2026 года');
    assert.equal(v(600, 'NEWL', '2026-06-10'), null, 'обычный новый листинг');
    assert.equal(v(600, 'NOREG'), null, 'реестр тикера не знает — давность листинга не доказана');
    assert.equal(v(600, 'GONE'), null, 'интервал реестра давно кончился');
    assert.equal(v(600, 'LONGA', null), null, 'нет ряда цен — давность листинга не доказана');
    assert.equal(fpi.listedSince(ranges, 'DOLE', '2026-11-12'), '2021-07-30'); assert.equal(fpi.listedSince(ranges, 'ITG', '2026-11-12'), '1994-05-04');
    assert.equal(before.get('DOLE'), undefined, 'строки после закона в «тикеры перед законом» не входят'); assert.equal(before.get('ITG'), undefined, 'и строки старше трёх лет — тоже');
    // справочники не готовы
    assert.equal(fpi.fpiVerdict({ cik: 200, ticker: 'PAM', fdate: '2026-11-12', bar0: '2014-01-02' }, { first: null, forms: refs.forms }, { ranges, before }), null, 'нет справочника первой формы — пометок нет');
    assert.equal(fpi.fpiVerdict({ cik: 200, ticker: 'LONGA', fdate: '2026-11-12', bar0: '2014-01-02' }, { first: refs.first, forms: null }, { ranges, before }), 'listed', 'нет справочника отчётов — только давний листинг');
    assert.equal(fpi.fpiStaleWarning(refs, '2026-11-18'), null); assert.match(fpi.fpiStaleWarning(refs, '2026-12-01'), /устарел/);
    assert.equal(FPI.lawFrom, '2026-02-27'); assert.equal(FPI.lawSigned, '2025-12-18');
  });

  ok('A1 (ревью): битый файл справочника — как отсутствующий: сборка не падает, пометок нет, предупреждение', () => {
    const L = join(ROOT, '.selftest-fpibroken');
    rmSync(L, { recursive: true, force: true }); mkdirSync(join(L, 'reference'), { recursive: true });
    writeFileSync(fpi.firstFormPath(L), '{"v":1,"quarters":["2016q1"],"first":{"100":"2016-0');
    writeFileSync(fpi.fpiFormsPath(L), '{"v":1,"asOf":"2026-11-16","fillDone":true,"ciks":{"14693');
    const refs = fpi.loadFpiRefs(L);
    assert.equal(refs.first, null); assert.equal(refs.forms, null);
    assert.equal(refs.warn.filter(w => /не читается/.test(w)).length, 2, refs.warn.join(' | '));
    assert.equal(fpi.fpiVerdict({ cik: 200, ticker: 'PAM', fdate: '2026-11-12', bar0: '2014-01-02' }, refs, {}), null);
    rmSync(L, { recursive: true, force: true });
  });

  await okAsync('A1: список — событие иностранного эмитента вне основного списка только с дня fpiFrom; скор и порядок прежние, раньше строка не меняется', async () => {
    const row = (cik, t, val, fpiWhy = null) => ({ cik, t, name: t, who: ['X'], role: 'C', officer: true, val, dd: -0.1, adv: 5e7, px: 40, at: null, drop: null, prev: null, fpi: fpiWhy });
    const rows = [row(1, 'PAM', 1.3e6, 'forms'), row(2, 'ROK', 4e5), row(3, 'DOLE', 2e5, 'listed'), row(4, 'LOW', 2e4, 'forms')];
    const off = buildDayFull(rows), on = buildDayFull(rows, undefined, { fpiActive: true });
    assert.deepEqual(off.rows.map(r => [r.t, r.score, r.main, 'fpi' in r]), [['PAM', 3, true, false], ['ROK', 2, true, false], ['DOLE', 2, true, false], ['LOW', 1, false, false]], 'до fpiFrom — как раньше, поля fpi нет');
    assert.deepEqual(on.rows.map(r => [r.t, r.score, r.main, r.fpi ?? null]), [['PAM', 3, false, true], ['ROK', 2, true, null], ['DOLE', 2, false, true], ['LOW', 1, false, true]]);
    for (const k of ['val', 'mx', 'dv', 'px', 'cost', 'tags', 'score']) assert.deepEqual(on.rows.map(r => r[k]), off.rows.map(r => r[k]), 'поле ' + k + ' от пометки не зависит');
    assert.deepEqual(off.fpi, ['PAM', 'DOLE', 'LOW']); assert.deepEqual(on.fpi, off.fpi, 'счётчику тикеры иностранных эмитентов известны при любом fpiFrom');
    assert.equal(compareMain(on.rows, on.rows).same, true);
    assert.deepEqual(compareMain(off.rows, on.rows).diff.map(x => x.t), ['PAM', 'DOLE'], 'сверка двух сборок видит, если пометку поставила только одна');
    // Дату ставит ведущий при выкладке; раньше 18.11.2026 она стоять не может: дни подачи до выкладки обязаны остаться как были
    const from = (await import('./lib/morning.mjs')).MORNING.fpiFrom;
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(from) && from >= '2026-11-18', 'MORNING.fpiFrom — дата не раньше дня выкладки (18.11.2026)');
  });

  await okAsync('A1: backfill строит справочник первой формы попутно; пропавший файл восстанавливается без перечитывания сделок', async () => {
    const B = join(ROOT, '.selftest-firstform');
    rmSync(B, { recursive: true, force: true });
    const zip = makeQuarterZip();
    let zipHits = 0;
    const srv = createServer((req, res) => { if (/insider-transactions-data-sets\/2026q[12]_form345\.zip$/.test(req.url)) { zipHits++; res.writeHead(200); res.end(zip); } else { res.writeHead(404); res.end(); } });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const run = () => new Promise(resolve => execFile(process.execPath, [join(ROOT, 'scripts', 'backfill.mjs'), '--data', B, '--from-year', '2026'],
      { encoding: 'utf8', env: { ...process.env, EDGAR_BASE: `http://127.0.0.1:${srv.address().port}`, POLITE_BACKOFF_MS: '2' } }, (err, so, se) => resolve({ code: err ? (err.code ?? 1) : 0, out: so + se })));
    try {
      const r1 = await run();
      assert.equal(r1.code, 0, r1.out);
      const ff = readJson(fpi.firstFormPath(B));
      assert.deepEqual(ff.first, { 111: '2020-02-05' }); assert.deepEqual(ff.quarters, ['2026q1', '2026q2']);
      const shard = readFileSync(join(B, 'trades', '2020.json.gz'));
      rmSync(fpi.firstFormPath(B));
      zipHits = 0;
      const r2 = await run();
      assert.equal(r2.code, 0, r2.out);
      assert.deepEqual(readJson(fpi.firstFormPath(B)).quarters, ['2026q1', '2026q2'], 'справочник восстановлен');
      assert.ok(zipHits >= 2, 'кварталы скачаны заново ради справочника');
      assert.ok(shard.equals(readFileSync(join(B, 'trades', '2020.json.gz'))), 'шард сделок при этом не тронут');
      assert.deepEqual(readJson(join(B, 'state', 'backfill.json')).done, ['2026q1', '2026q2']);
    } finally { await new Promise(r => srv.close(r)); rmSync(B, { recursive: true, force: true }); }
  });

  await okAsync('A1: live.mjs пишет справочник отчётов иностранных эмитентов из дневного индекса; начальное наполнение — только по флагу --fpi-fill и один раз', async () => {
    const { gzipSync } = await import('node:zlib');
    const L = join(ROOT, '.selftest-fpiforms');
    rmSync(L, { recursive: true, force: true });
    const acc = '0000000011-26-000001', path = `edgar/data/555000/${acc.replace(/-/g, '')}/${acc}.txt`;
    const line = (form, name, cik, date, p) => `${form.padEnd(17)}${name.padEnd(62)}${String(cik).padEnd(12)}${date}    ${p}`;
    const dayIdx = ['Form Type   Company Name   CIK   Date Filed   File Name', '-'.repeat(80), line('4', 'TEST ISSUER', 555000, '20260908', path),
      line('6-K', 'Pampa Energia S.A.', 1469395, '20260908', 'edgar/data/1469395/0001292814-26-004001.txt')].join('\n');
    // в настоящем квартальном индексе тысячи строк отчётов иностранных эмитентов: квартал с меньшим числом — не индекс
    const filler = q => Array.from({ length: FPI.fillMinRows }, (_, i) => line('6-K', 'AMDOCS LTD', 1062579, `2026-0${q}-01`, `edgar/data/1062579/f${i}.txt`));
    const fullIdx = q => gzipSync(['Description: Master Index', '', ...filler(q), line('20-F', 'AMDOCS LTD', 1062579, `2026-0${q}-15`, 'edgar/data/1062579/0001062579-26-000031.txt'), line('10-K', 'Alpha Corp', 111, `2026-0${q}-16`, 'edgar/data/111/x.txt')].join('\n'));
    let stub = '2025q4';                                            // этот квартал сначала отдаётся страницей-заглушкой с кодом 200
    const body = `<SEC-DOCUMENT>\n<ACCEPTANCE-DATETIME>20260908171500\n<XML>\n<ownershipDocument><documentType>4</documentType><issuer><issuerCik>555000</issuerCik><issuerTradingSymbol>TSTA</issuerTradingSymbol></issuer><reportingOwner><reportingOwnerId><rptOwnerCik>8</rptOwnerCik><rptOwnerName>Roe Jane</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>1</isDirector></reportingOwnerRelationship></reportingOwner><nonDerivativeTable></nonDerivativeTable></ownershipDocument>\n</XML>`;
    const hits = { full: [], seq: [] };
    const srv = createServer((req, res) => {
      const url = decodeURIComponent(req.url);
      const fm = /full-index\/(\d{4})\/QTR(\d)\/form\.gz$/.exec(url);
      if (fm) {
        const key = `${fm[1]}q${fm[2]}`;
        hits.full.push(key); hits.seq.push('full');
        if (key === stub) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>Service temporarily unavailable</html>'); return; }
        res.writeHead(200, { 'content-type': 'application/x-gzip' }); res.end(fullIdx(fm[2])); return;
      }
      if (/daily-index/.test(url)) hits.seq.push('day');
      if (/form\.20260908\.idx$/.test(url)) { res.writeHead(200); res.end(dayIdx); return; }
      if (/daily-index/.test(url)) { res.writeHead(403); res.end('<Error><Code>AccessDenied</Code></Error>'); return; }
      if (url.endsWith(acc + '.txt')) { res.writeHead(200); res.end(body); return; }
      res.writeHead(404); res.end();
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const run = extra => new Promise(resolve => execFile(process.execPath, [join(ROOT, 'scripts', 'live.mjs'), '--data', L, '--today', '2026-09-10', '--retries', '0', '--reread-budget-min', '0', ...extra],
      { encoding: 'utf8', env: { ...process.env, EDGAR_BASE: `http://127.0.0.1:${srv.address().port}`, POLITE_BACKOFF_MS: '2' } }, (err, so, se) => resolve({ code: err ? (err.code ?? 1) : 0, out: so + se })));
    try {
      mkdirSync(join(L, 'state'), { recursive: true });
      writeJson(join(L, 'state', 'live.json'), { schema: SHARD_VERSION, from: '2026-09-01', lastDay: '2026-09-07', parserRev: PARSER_REV });
      writeJsonGz(join(L, 'trades', 'live.json.gz'), { v: SHARD_VERSION, trades: [], amend: [] });
      const r1 = await run([]);
      assert.equal(r1.code, 0, r1.out);
      let ref = readJson(fpi.fpiFormsPath(L));
      assert.deepEqual(ref.ciks, { 1469395: '2026-09-08' }); assert.equal(ref.asOf, '2026-09-08'); assert.equal(ref.fillDone, false);
      assert.deepEqual(hits.full, [], 'без флага (ночная сборка на сервере) полные индексы не качаются');
      assert.equal(fpi.loadFpiRefs(L).forms, null, 'до конца начального наполнения сборка пометку по отчётам не ставит');
      hits.seq.length = 0;
      const r2 = await run(['--fpi-fill']);
      assert.equal(r2.code, 0, r2.out);
      ref = readJson(fpi.fpiFormsPath(L));
      assert.deepEqual(hits.full, ['2025q3', '2025q4', '2026q1', '2026q2', '2026q3'], 'пять кварталов, от старого к новому');
      assert.ok(hits.seq.indexOf('day') >= 0 && hits.seq.indexOf('day') < hits.seq.indexOf('full'), 'наполнение идёт после сбора форм дня, а не перед ним: ' + hits.seq.join(','));
      assert.equal(ref.fillDone, false, 'квартал, вместо индекса которого пришла страница-заглушка, наполненным не считается');
      assert.deepEqual(ref.filled, ['2025q3', '2026q1', '2026q2', '2026q3']); assert.match(r2.out, /похоже, это не индекс/);
      assert.equal(fpi.loadFpiRefs(L).forms, null, 'пометки «по отчётам» нет, пока справочник не наполнен целиком');
      stub = null;
      const r3 = await run(['--fpi-fill']);
      assert.equal(r3.code, 0, r3.out);
      ref = readJson(fpi.fpiFormsPath(L));
      assert.deepEqual(hits.full.slice(5), ['2025q4'], 'следующий прогон докачивает только недостающий квартал');
      assert.equal(ref.fillDone, true); assert.equal(ref.ciks[1062579], '2026-04-15', 'самая поздняя подача отчёта'); assert.equal(ref.ciks[1469395], '2026-09-08'); assert.equal(ref.ciks[111], undefined, '10-K — не отчёт иностранного эмитента');
      assert.equal(ref.asOf, '2026-09-08');
      const refs = fpi.loadFpiRefs(L);
      assert.deepEqual([...refs.forms].sort(), [[1062579, '2026-04-15'], [1469395, '2026-09-08']], 'эмитент -> дата последнего отчёта'); assert.equal(refs.first, null); assert.match(refs.warn.join(' '), /нет справочника первой формы/);
      await run(['--fpi-fill']);
      assert.equal(hits.full.length, 6, 'наполненный справочник заново не качается');
      // битый файл справочника сбор форм не останавливает
      writeFileSync(fpi.fpiFormsPath(L), '{"v":1,"asOf":"2026-09-08","ciks":{"14693');
      const r4 = await run([]);
      assert.equal(r4.code, 0, r4.out); assert.match(r4.out, /не читается/);
    } finally { await new Promise(r => srv.close(r)); rmSync(L, { recursive: true, force: true }); }
  });

  ok('A1: сборка — полная и «как на сервере» ставят пометку одинаково; до --fpi-from и без справочников список прежний, в файле — предупреждение', () => {
    const P = join(ROOT, '.selftest-fpi');
    rmSync(P, { recursive: true, force: true });
    mkdirSync(join(P, 'state'), { recursive: true });
    for (const b of ['SPY', 'IWM']) writePriceCache(P, b, bizDays('2023-01-02', today).map(d => [d, 100, 100, 1e6]));
    for (const t of ['FRNA', 'OLDA', 'LSTA']) writePriceCache(P, t, bizDays('2024-01-02', today).map(d => [d, 20, 20, 1e6]));
    writePriceCache(P, 'NEWA', bizDays('2026-06-01', today).map(d => [d, 20, 20, 1e6]));                 // новый листинг: ряд с июня 2026
    writeJson(join(P, 'reference', 'tickers.json'), { 444: { ticker: 'FRNA', exchange: 'NYSE', name: 'Foreign A' }, 555: { ticker: 'OLDA', exchange: 'Nasdaq', name: 'Old Filer' },
      666: { ticker: 'LSTA', exchange: 'NYSE', name: 'Long Listed' }, 777: { ticker: 'NEWA', exchange: 'Nasdaq', name: 'New Listing' } });
    writeJsonGz(join(P, 'reference', 'symbol-ranges.json.gz'), { FRNA: [[1, '2010-01-04', today]], OLDA: [[1, '2012-01-03', today]], LSTA: [[1, '2015-01-05', today]], NEWA: [[1, '2026-06-01', today]] });
    const FB = bizDays('2024-01-02', addDaysIso(today, -6)).at(-1);
    const tk = { 444: 'FRNA', 555: 'OLDA', 666: 'LSTA', 777: 'NEWA' };
    writeJsonGz(join(P, 'trades', 'live.json.gz'), { v: SHARD_VERSION, amend: [],
      trades: Object.keys(tk).map((cik, i) => T({ acc: 'F' + i, cik: Number(cik), t: tk[cik], fdate: FB, tdate: addDaysIso(FB, -1), owners: ceo, code: 'P', sh: 7500, px: 20, val: 150000, own: 1e5 })) });
    const putRefs = () => {
      writeJson(fpi.firstFormPath(P), { v: 1, quarters: allQ, first: { 444: '2026-03-10', 555: '2019-05-06' } });   // LSTA и NEWA в квартальных файлах нет: первая форма — в живом окне
      writeJson(fpi.fpiFormsPath(P), { v: 1, asOf: today, filled: ['x'], fillDone: true, ciks: { 444: FB, 555: FB } });
    };
    const run = (site, extra) => execFileSync(process.execPath, [join(ROOT, 'scripts', 'compute.mjs'), '--data', P, '--site', join(P, site), '--counter-from', addDaysIso(today, -30), ...extra], { stdio: 'pipe' });
    const read = site => { const m = readJson(join(P, site, 'data', 'morning.json')); return { m, rows: Object.fromEntries(m.days.find(d => d.date === FB).rows.map(r => [r.t, r])) }; };
    try {
      putRefs();
      run('full', ['--fpi-from', FB]); run('lean', ['--fpi-from', FB, '--only-morning', '--builder', 'vps']);
      const full = read('full'), lean = read('lean');
      assert.deepEqual(Object.keys(full.rows).sort(), ['FRNA', 'LSTA', 'NEWA', 'OLDA']);
      assert.deepEqual([full.rows.FRNA.fpi, full.rows.FRNA.main, full.rows.FRNA.score], [true, false, 2], 'новый податель с отчётами 6-K');
      assert.deepEqual([full.rows.LSTA.fpi, full.rows.LSTA.main], [true, false], 'новый податель с давним листингом');
      assert.deepEqual([full.rows.OLDA.fpi ?? null, full.rows.OLDA.main], [null, true], 'формы были до закона — в правиле, хотя и подаёт 6-K');
      assert.deepEqual([full.rows.NEWA.fpi ?? null, full.rows.NEWA.main], [null, true], 'обычный новый листинг');
      for (const t of Object.keys(full.rows)) assert.deepEqual([lean.rows[t].fpi ?? null, lean.rows[t].main, lean.rows[t].score], [full.rows[t].fpi ?? null, full.rows[t].main, full.rows[t].score], t + ': сборка на сервере = полная');
      assert.equal(full.m.fpi.from, FB); assert.equal(full.m.fpi.firstForm, 2); assert.equal(full.m.fpi.forms, 2); assert.equal(full.m.fpi.warn, undefined);
      assert.deepEqual(full.m.counter.fpi.from, '2026-08-01');
      // день подачи раньше --fpi-from: ни одна строка не меняется. До 24.11.2026 здесь стояла дата по умолчанию (MORNING.fpiFrom, тогда
      // «заглушка в будущем»); с этого дня FB (последний будний день не позже today − 6) её догоняет, и тест падал бы — дата задана явно
      run('off', ['--fpi-from', '2099-01-01']);
      const off = read('off');
      for (const t of Object.keys(off.rows)) { assert.equal('fpi' in off.rows[t], false); assert.equal(off.rows[t].main, true); }
      for (const t of Object.keys(off.rows)) for (const k of ['val', 'mx', 'score', 'dv', 'px', 'cost', 'tags', 'prev']) assert.deepEqual(off.rows[t][k], full.rows[t][k], `${t}.${k}: от пометки не зависит`);
      // справочника первой формы нет — пометок нет, сборка не падает, в файле предупреждение
      rmSync(fpi.firstFormPath(P));
      run('noref', ['--fpi-from', FB]);
      const noref = read('noref');
      for (const t of Object.keys(noref.rows)) { assert.equal('fpi' in noref.rows[t], false); assert.equal(noref.rows[t].main, true); }
      assert.match(noref.m.fpi.warn.join(' '), /нет справочника первой формы/);
      // справочник первой формы неполон (идёт перечитывание кварталов) — то же
      writeJson(fpi.firstFormPath(P), { v: 1, quarters: allQ.slice(0, 20), first: { 555: '2019-05-06' } });
      run('partial', ['--fpi-from', FB]);
      assert.equal(Object.values(read('partial').rows).some(r => r.fpi), false); assert.match(read('partial').m.fpi.warn.join(' '), /неполон/);
      // справочник отчётов не наполнен — пометка только по давнему листингу, предупреждение
      putRefs();
      writeJson(fpi.fpiFormsPath(P), { v: 1, asOf: today, filled: [], fillDone: false, ciks: { 444: FB } });
      run('noforms', ['--fpi-from', FB]);
      const nf = read('noforms');
      assert.deepEqual([nf.rows.FRNA.fpi ?? null, nf.rows.LSTA.fpi ?? null], [true, true], 'FRNA — тоже давний листинг');
      assert.match(nf.m.fpi.warn.join(' '), /не наполнен/);
    } finally { rmSync(P, { recursive: true, force: true }); }
  });
}

// ==================== АУДИТ ФОРМ 17.11.2026, пакет B: ночная сборка на сервере и лента ====================
{
  const { PARSER_REV } = await import('./lib/edgar.mjs');
  const { readJsonGz } = await import('./lib/util.mjs');
  const accB = n => `0000000012-26-${String(n).padStart(6, '0')}`;
  const pathB = (cik, acc) => `edgar/data/${cik}/${acc.replace(/-/g, '')}/${acc}.txt`;
  const idxLineB = (name, cik, day, path) => `4                ${name.padEnd(62)}${String(cik).padEnd(12)}${day.replace(/-/g, '')}    ${path}`;
  const formB = (acc, sym, { day = '2026-11-06', tdate = '2026-11-05', sh = 1000, px = 20 } = {}) =>
    `<SEC-DOCUMENT>${acc}.txt : ${day.replace(/-/g, '')}\n<SEC-HEADER>\n<ACCEPTANCE-DATETIME>${day.replace(/-/g, '')}171500\n</SEC-HEADER>\n<XML>\n<ownershipDocument><documentType>4</documentType>`
    + `<issuer><issuerCik>555000</issuerCik><issuerTradingSymbol>${sym}</issuerTradingSymbol></issuer><aff10b5One>0</aff10b5One>`
    + `<reportingOwner><reportingOwnerId><rptOwnerCik>777</rptOwnerCik><rptOwnerName>Doe John</rptOwnerName></reportingOwnerId>`
    + `<reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>CFO</officerTitle></reportingOwnerRelationship></reportingOwner>`
    + `<nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle>`
    + `<transactionDate><value>${tdate}</value></transactionDate><transactionCoding><transactionCode>P</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>`
    + `<transactionAmounts><transactionShares><value>${sh}</value></transactionShares><transactionPricePerShare><value>${px}</value></transactionPricePerShare>`
    + `<transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>`
    + `<postTransactionAmounts><sharesOwnedFollowingTransaction><value>10000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>`
    + `<ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction></nonDerivativeTable>`
    + `</ownershipDocument>\n</XML>\n</SEC-DOCUMENT>`;
  const S3B = '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>';
  const runScript = (script, args, env) => new Promise(resolve => execFile(process.execPath, [join(ROOT, 'scripts', script), ...args],
    { encoding: 'utf8', env: { ...process.env, POLITE_BACKOFF_MS: '2', ...env } }, (err, so, se) => resolve({ code: err ? (err.code ?? 1) : 0, out: so + se })));

  await okAsync('B1: «нет файла» по подаче свежего дня — не «снята»: повтор в конце прохода, добор, день partial; снятой считается только у дня старше суток', async () => {
    // ночь 06.11.2026: SEC ответила 404 по 31 подаче из 515, сборка на сервере пометила день полным (собрано 484, ждут 0)
    const L = join(ROOT, '.selftest-nofile');
    rmSync(L, { recursive: true, force: true });
    const D = '2026-11-06', [A, B, C] = [1, 2, 3].map(accB);
    const index = ['Form Type   Company Name   CIK   Date Filed   File Name', '-'.repeat(80), idxLineB('ISSUER A', 555000, D, pathB(555000, A)),
      idxLineB('ISSUER B', 555000, D, pathB(555000, B)), idxLineB('DOE JOHN', 777, D, pathB(777, B)), idxLineB('ISSUER C', 555000, D, pathB(555000, C))].join('\n');
    let bMissing = true;
    const hitsB = [];
    const srv = createServer((req, res) => {
      const url = decodeURIComponent(req.url);
      if (/form\.20261106\.idx$/.test(url)) { res.writeHead(200); res.end(index); return; }
      if (/daily-index/.test(url)) { res.writeHead(403, { 'content-type': 'application/xml' }); res.end(S3B); return; }
      const m = /(\d{10}-\d{2}-\d{6})\.txt$/.exec(url);
      if (m?.[1] === B) hitsB.push(url);
      if (m && (m[1] !== B || !bMissing)) { res.writeHead(200); res.end(formB(m[1], m[1] === A ? 'AAA' : m[1] === B ? 'BBB' : 'CCC')); return; }
      res.writeHead(404); res.end();
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const run = todayIso => runScript('live.mjs', ['--data', L, '--today', todayIso, '--retries', '0', '--reread-budget-min', '0'], { EDGAR_BASE: `http://127.0.0.1:${srv.address().port}` });
    const st = () => readJson(join(L, 'state', 'live.json'));
    const reset = () => {
      rmSync(L, { recursive: true, force: true });
      mkdirSync(join(L, 'state'), { recursive: true });
      writeJson(join(L, 'state', 'live.json'), { schema: SHARD_VERSION, from: '2026-11-02', lastDay: '2026-11-05', parserRev: PARSER_REV });
      writeJson(join(L, 'state', 'backfill.json'), { done: ['2026q3'] });
      writeJsonGz(join(L, 'trades', 'live.json.gz'), { v: SHARD_VERSION, trades: [], amend: [] });
    };
    try {
      reset();
      const r1 = await run('2026-11-07');                          // 22:03 ET 06.11 = 03:03 UTC 07.11
      assert.equal(r1.code, 0, r1.out);
      let c = st().coverage[D];
      assert.deepEqual([c.status, c.indexed, c.collected, c.pending, c.gone ?? 0], ['partial', 3, 2, 1, 0], 'день неполон, подача ждёт добора, «снятых» нет');
      assert.deepEqual(Object.keys(st().pending[D]), [B]); assert.match(st().pending[D][B].err, /нет файла/);
      assert.equal(st().pending[D][B].nf, 1, 'счёт ответов «нет файла» подряд — один на проход, повтор в конце прохода его не удваивает');
      assert.equal(hitsB.length, 4, 'оба адреса подачи спрошены дважды: в проходе и повтором в конце прохода');
      assert.equal(st().lastDay >= D, true, 'день пройден: список собирается, недобор виден в покрытии');
      bMissing = false;                                            // следующая попытка сборки: файл уже отдаётся
      const r2 = await run('2026-11-07');
      assert.equal(r2.code, 0, r2.out);
      c = st().coverage[D];
      assert.deepEqual([c.status, c.collected, c.pending], ['complete', 3, 0]);
      assert.deepEqual(readJsonGz(join(L, 'trades', 'live.json.gz')).trades.map(r => r.t).sort(), ['AAA', 'BBB', 'CCC']);
      // подачу и правда сняли: пока день свежий — ждёт в доборе, через сутки считается снятой, и день закрывается полным
      reset(); bMissing = true;
      await run('2026-11-07'); await run('2026-11-07');
      assert.equal(st().coverage[D].status, 'partial'); assert.equal(st().pending[D][B].tries, 2); assert.equal(st().pending[D][B].nf, 2);
      const r3 = await run('2026-11-08');
      assert.equal(r3.code, 0, r3.out);
      c = st().coverage[D];
      assert.deepEqual([c.status, c.collected, c.gone, c.pending], ['complete', 2, 1, 0]); assert.equal(st().pending, undefined);
      // день старше суток при первом же чтении (догон после простоя): как раньше — снята сразу
      reset();
      await run('2026-11-10');
      c = st().coverage[D];
      assert.deepEqual([c.status, c.collected, c.gone], ['complete', 2, 1]);
    } finally { await new Promise(r => srv.close(r)); rmSync(L, { recursive: true, force: true }); }
  });

  // ---------- B5: лента на весь день — устойчивость ----------
  const { FEED: FEEDP, formComplete } = await import('./lib/feed.mjs');
  const nyToday = nyWall(Date.now()).slice(0, 10);
  const feedRun = (dir, base, extra = ['--once']) => runScript(join('vps', 'feed-collector.mjs'), ['--dir', dir, ...extra], { EDGAR_BASE: base });
  const journalOf = (dir, day = nyToday) => parseFeedJournal(existsSync(feedFile(dir, day)) ? readFileSync(feedFile(dir, day), 'utf8') : '');

  await okAsync('B5: лента — сбой страницы не отменяет скачивание уже замеченных форм; три несдающиеся подряд формы не затягивают такт', async () => {
    const dir = join(ROOT, '.selftest-feed-b5a');
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    const accs = [1, 2, 3, 4, 5].map(accB);
    writeFileSync(feedFile(dir, nyToday), accs.map(a => JSON.stringify({ k: 'seen', acc: a, cik: 555000, form: '4', filed: nyToday, upd: null, t: 'x' })).join('\n') + '\n');
    const hits = { pages: 0, forms: [] };
    let mode = 'page-down';
    const srv = createServer((req, res) => {
      if (req.url.startsWith('/cgi-bin/browse-edgar')) { hits.pages++; if (mode === 'page-down') { res.writeHead(503); res.end('busy'); } else { res.writeHead(200); res.end(atomOf([])); } return; }
      const m = /(\d{10}-\d{2}-\d{6})\.txt$/.exec(req.url);
      if (m) { hits.forms.push(m[1]); if (mode === 'forms-down') { res.writeHead(503); res.end('busy'); } else { res.writeHead(200); res.end(formB(m[1], 'AAA', { day: nyToday })); } return; }
      res.writeHead(404); res.end();
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      const r1 = await feedRun(dir, base);
      assert.equal(r1.code, 0, r1.out);
      assert.deepEqual([...journalOf(dir).forms.keys()].sort(), accs, 'страница ленты не ответила, а замеченные раньше формы разобраны');
      assert.match(r1.out, /сбой такта/, 'такт при этом считается сбойным: ленту не прочитали');
      const f = journalOf(dir).forms.get(accs[0]);
      assert.equal(f.rev, PARSER_REV); assert.equal(f.end, true, 'в журнале — ревизия разбора и признак полного файла');
      // формы не отдаются: после трёх сбоев подряд очередь ждёт следующего такта
      rmSync(feedFile(dir, nyToday));
      writeFileSync(feedFile(dir, nyToday), accs.map(a => JSON.stringify({ k: 'seen', acc: a, cik: 555000, form: '4', filed: nyToday, upd: null, t: 'x' })).join('\n') + '\n');
      mode = 'forms-down'; hits.forms.length = 0;
      const r2 = await feedRun(dir, base);
      assert.equal(r2.code, 0, r2.out);
      assert.equal(new Set(hits.forms).size, 3, 'запрошены три подачи из пяти: ' + hits.forms.length + ' запросов');
      assert.equal(hits.forms.length, 3 * (FEEDP.retries + 1), 'один повтор на запрос');
      assert.equal(journalOf(dir).forms.size, 0);
    } finally { await new Promise(r => srv.close(r)); rmSync(dir, { recursive: true, force: true }); }
  });

  await okAsync('B5: лента — первый такт дня не перекачивает вчерашние формы; замеченная вчера, но не разобранная подача добирается', async () => {
    const dir = join(ROOT, '.selftest-feed-b5b');
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    const yday = addDaysIso(nyToday, -1), [Y1, Y2, N1] = [11, 12, 13].map(accB);
    writeFileSync(feedFile(dir, yday), [{ k: 'seen', acc: Y1, cik: 555000, form: '4', filed: yday }, { k: 'form', acc: Y1, filed: yday, trades: [], amend: [] },
      { k: 'seen', acc: Y2, cik: 555000, form: '4', filed: yday }].map(x => JSON.stringify(x)).join('\n') + '\n');
    const hits = [];
    const srv = createServer((req, res) => {
      if (req.url.startsWith('/cgi-bin/browse-edgar')) { res.writeHead(200); res.end(atomOf(/start=0(&|$)/.test(req.url) ? [{ acc: N1, cik: 555000, filed: nyToday }, { acc: Y1, cik: 555000, filed: yday }, { acc: Y2, cik: 555000, filed: yday }] : [])); return; }
      const m = /(\d{10}-\d{2}-\d{6})\.txt$/.exec(req.url);
      if (m) { hits.push(m[1]); res.writeHead(200); res.end(formB(m[1], 'AAA', { day: nyToday })); return; }
      res.writeHead(404); res.end();
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try {
      const r = await feedRun(dir, `http://127.0.0.1:${srv.address().port}`);
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(hits.slice().sort(), [Y2, N1].sort(), 'вчерашняя разобранная подача не качается заново; вчерашняя неразобранная и новая — качаются');
      const j = journalOf(dir);
      assert.deepEqual([...j.seen.keys()], [N1], 'в журнал дня «замечена» пишется только новая');
      assert.deepEqual([...j.forms.keys()].sort(), [Y2, N1].sort());
    } finally { await new Promise(r => srv.close(r)); rmSync(dir, { recursive: true, force: true }); }
  });

  await okAsync('B5: лента — выход с ошибкой по времени слепоты; порог 15 минут не упирается в предел перезапусков юнита', async () => {
    const dir = join(ROOT, '.selftest-feed-b5c');
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    const srv = createServer((req, res) => { res.writeHead(503); res.end('busy'); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try {
      const r = await feedRun(dir, `http://127.0.0.1:${srv.address().port}`, ['--from', '00:00', '--until', '23:59', '--interval', '0.05', '--blind-exit-min', '0']);
      assert.equal(r.code, 1, r.out);
      assert.equal((r.out.match(/сбой такта/g) ?? []).length, FEEDP.blindMinTicks, 'не раньше трёх сбоев подряд');
      assert.match(r.out, /выход с ошибкой/);
      assert.ok(journalOf(dir).stats.some(s => 'blind' in s), 'слепота записана в журнал');
    } finally { await new Promise(r => srv.close(r)); rmSync(dir, { recursive: true, force: true }); }
    // расчёт порога: тревога юнита — через четверть часа слепоты; цикл «слепота + перезапуск» длиннее, чем позволяет предел перезапусков
    const unit = readFileSync(join(ROOT, 'ops', 'insider840-feed', 'insider840-feed.service'), 'utf8');
    const num = k => Number(new RegExp(`^${k}=(\\d+)`, 'm').exec(unit)[1]);
    assert.equal(FEEDP.blindExitMin, 15); assert.equal(FEEDP.timeoutMs, 10000); assert.equal(FEEDP.retries, 1);
    const cycleSec = FEEDP.blindExitMin * 60 + num('RestartSec');
    assert.ok(num('StartLimitIntervalSec') / cycleSec < num('StartLimitBurst'), `перезапусков в окне ${(num('StartLimitIntervalSec') / cycleSec).toFixed(1)} при пределе ${num('StartLimitBurst')}`);
    assert.equal(formComplete('<SEC-DOCUMENT>x\n</SEC-DOCUMENT>\n'), true); assert.equal(formComplete('<SEC-DOCUMENT>x\n<XML>'), false);
  });

  await okAsync('B5 (ревью): лента — оборванный файл подачи в журнал не пишется и качается заново; сбой сети попытку не списывает, несдающиеся подачи уходят в конец очереди', async () => {
    const dir = join(ROOT, '.selftest-feed-b5d');
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    const accs = [21, 22, 23, 24, 25].map(accB), seenLines = list => list.map(a => JSON.stringify({ k: 'seen', acc: a, cik: 555000, form: '4', filed: nyToday, upd: null, t: 'x' })).join('\n') + '\n';
    writeFileSync(feedFile(dir, nyToday), seenLines(accs.slice(0, 1)));
    let cut = true, down = false;
    const hits = [];
    const srv = createServer((req, res) => {
      if (req.url.startsWith('/cgi-bin/browse-edgar')) { if (down) { res.writeHead(503); res.end('busy'); } else { res.writeHead(200); res.end(atomOf([])); } return; }
      const m = /(\d{10}-\d{2}-\d{6})\.txt$/.exec(req.url);
      if (!m) { res.writeHead(404); res.end(); return; }
      hits.push(m[1]);
      if (down) { res.writeHead(503); res.end('busy'); return; }
      const txt = formB(m[1], 'AAA', { day: nyToday });
      res.writeHead(200); res.end(cut ? txt.slice(0, Math.floor(txt.length / 2)) : txt);
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      const r1 = await feedRun(dir, base);
      assert.equal(r1.code, 0, r1.out);
      assert.match(r1.out, /файл подачи оборван/);
      assert.equal(journalOf(dir).forms.size, 0, 'оборванный файл не записан разобранной формой (иначе подачу больше никто не скачал бы)');
      cut = false;
      const r2 = await feedRun(dir, base);
      assert.equal(r2.code, 0, r2.out);
      const f = journalOf(dir).forms.get(accs[0]);
      assert.equal(f?.end, true); assert.equal(f.trades.length > 0, true, 'следующий запуск скачал подачу целиком');
      // сеть лежит три такта подряд: за такт пробуются три подачи, и каждый такт — те, по которым сбоев меньше; до правки это были
      // одни и те же первые три, и после шести тактов они выбывали из очереди до конца дня
      rmSync(feedFile(dir, nyToday)); writeFileSync(feedFile(dir, nyToday), seenLines(accs));
      down = true; hits.length = 0;
      const r3 = await feedRun(dir, base, ['--from', '00:00', '--until', '23:59', '--interval', '0.05', '--blind-exit-min', '0']);
      assert.equal(r3.code, 1, r3.out);
      assert.equal(new Set(hits).size, 5, 'за три сбойных такта спрошены все пять подач: ' + hits.length + ' запросов');
    } finally { await new Promise(r => srv.close(r)); rmSync(dir, { recursive: true, force: true }); }
  });

  // ---------- B2а, B4: журнал ленты — запас для подач, которые не скачались, и для ночи, когда SEC не отвечает ----------
  const mb = await import('./vps/morning-build.mjs');
  const morningLib = await import('./lib/morning.mjs');

  ok('B2а: подачи индекса, которые не скачались, берутся из журнала ленты; покрытие дня пересчитывается', () => {
    const work = join(ROOT, '.selftest-feedfill'), data = join(work, 'repo'), feedDir = join(work, 'feed'), D = '2026-11-06';
    rmSync(work, { recursive: true, force: true }); mkdirSync(feedDir, { recursive: true });
    const row = (acc, t) => ({ acc, form: '4', code: 'P', tdate: '2026-11-05', fdate: D, sec: 'Common Stock', sh: 1000, px: 20, val: 20000, t, cik: 555000, owners: [] });
    writeJsonGz(join(data, 'trades', 'live.json.gz'), { v: SHARD_VERSION, trades: [row('A-1', 'AAA')], amend: [] });
    writeJson(join(data, 'state', 'live.json'), { lastDay: D, coverage: { [D]: { status: 'partial', indexed: 4, collected: 1, pending: 3, at: 'x', error: 'сеть' } },
      pending: { [D]: { 'B-1': { paths: ['p'], tries: 1, err: 'нет файла (404)' }, 'C-1': { paths: ['p'], tries: 1, err: 'HTTP 503' }, 'E-1': { paths: ['p'], tries: 1, err: 'нет файла (404)' } } } });
    const fr = (acc, t, extra = {}) => ({ k: 'form', acc, filed: D, rev: PARSER_REV, end: true, trades: [row(acc, t)], amend: [], ...extra });
    writeFileSync(feedFile(feedDir, D), [fr('B-1', 'BBB'), fr('C-1', 'CCC', { trades: [], amend: [{ acc: 'C-1', orig: D }] }),
      fr('E-1', 'EEE', { filed: '2026-11-05' })].map(x => JSON.stringify(x)).join('\n') + '\n');
    assert.equal(mb.feedFillPending({ data, feedDir }, D), 2, 'B-1 и C-1 есть в ленте за этот день; E-1 в ленте числится за другой день — не берётся');
    const live = readJson(join(data, 'state', 'live.json')), c = live.coverage[D];
    assert.deepEqual([c.status, c.indexed, c.collected, c.pending, c.fromFeed], ['partial', 4, 3, 1, 2]);
    assert.deepEqual(Object.keys(live.pending[D]), ['E-1']);
    assert.deepEqual(readJsonGz(join(data, 'trades', 'live.json.gz')).trades.map(r => r.t).sort(), ['AAA', 'BBB']);
    assert.equal(mb.feedFillPending({ data, feedDir }, D), 0, 'повтор ничего не меняет');
    // последняя подача находится в ленте — день полный
    writeFileSync(feedFile(feedDir, D), JSON.stringify(fr('E-1', 'EEE')) + '\n', { flag: 'a' });
    assert.equal(mb.feedFillPending({ data, feedDir }, D), 1);
    const done = readJson(join(data, 'state', 'live.json'));
    assert.deepEqual([done.coverage[D].status, done.coverage[D].collected, done.coverage[D].pending, done.coverage[D].fromFeed, done.coverage[D].error], ['complete', 4, 0, 3, undefined]);
    assert.equal(done.pending, undefined);
    rmSync(work, { recursive: true, force: true });
  });

  ok('B2а (ревью): оборванная запись ленты и запись другой ревизии разбора подачу с добора не снимают — день остаётся partial; на последней попытке строки целой записи вливаются', () => {
    const work = join(ROOT, '.selftest-feedfill2'), data = join(work, 'repo'), feedDir = join(work, 'feed'), D = '2026-11-06';
    rmSync(work, { recursive: true, force: true }); mkdirSync(feedDir, { recursive: true });
    const row = (acc, t) => ({ acc, form: '4', code: 'P', tdate: '2026-11-05', fdate: D, sec: 'Common Stock', sh: 1000, px: 20, val: 20000, t, cik: 555000, owners: [] });
    writeJsonGz(join(data, 'trades', 'live.json.gz'), { v: SHARD_VERSION, trades: [row('A-1', 'AAA')], amend: [] });
    const p = err => ({ paths: ['p'], tries: 1, err });
    const state = { lastDay: D, coverage: { [D]: { status: 'partial', indexed: 4, collected: 1, pending: 3, at: 'x', error: 'сеть' } },
      pending: { [D]: { 'T-1': p('HTTP 503'), 'O-1': p('нет файла (404)'), 'R-1': p('HTTP 503') } } };
    writeJson(join(data, 'state', 'live.json'), state);
    writeFileSync(feedFile(feedDir, D), [
      { k: 'form', acc: 'T-1', filed: D, rev: PARSER_REV, end: false, trades: [], amend: [] },                       // файл оборван: сделок «нет»
      { k: 'form', acc: 'O-1', filed: D, trades: [row('O-1', 'OOO')], amend: [] },                                   // запись до правки: без rev и end
      { k: 'form', acc: 'R-1', filed: D, rev: PARSER_REV - 1, end: true, trades: [row('R-1', 'RRR')], amend: [] },   // прошлая ревизия разбора
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    assert.equal(mb.feedFillPending({ data, feedDir }, D), 0, 'ни одна запись не годится вместо своей загрузки');
    assert.deepEqual(readJson(join(data, 'state', 'live.json')), state, 'добор и покрытие не тронуты: день не стал «полным» без строк');
    assert.deepEqual(readJsonGz(join(data, 'trades', 'live.json.gz')).trades.map(r => r.t), ['AAA']);
    assert.equal(mb.feedFillPending({ data, feedDir }, D, { lastChance: true }), 0, 'последняя попытка: с добора всё равно не снимаются');
    assert.deepEqual(readJson(join(data, 'state', 'live.json')), state, 'день остаётся partial, три подачи ждут');
    assert.deepEqual(readJsonGz(join(data, 'trades', 'live.json.gz')).trades.map(r => r.t).sort(), ['AAA', 'OOO', 'RRR'], 'строки целых записей в списке есть, оборванной — нет');
    rmSync(work, { recursive: true, force: true });
  });

  ok('B1/B2а: сборка на сервере не ждёт до 23:30 подачу, по которой SEC раз за разом отвечает «нет файла», — но только единичную и не сразу', () => {
    const D = '2026-11-06', at = '2026-11-07T03:05:00.000Z', late = Date.parse(at) + mb.NO_FILE_WAIT_MIN * 60e3;
    const cov = { [D]: { status: 'partial', indexed: 515, collected: 514, pending: 1, at } };
    const st = (nf, n = 1, err = 'нет файла (404)') => ({ lastDay: D, coverage: cov,
      pending: { [D]: Object.fromEntries(Array.from({ length: n }, (_, i) => ['B' + i, { paths: [], tries: 9, err, ...(nf ? { nf } : {}) }])) } });
    assert.equal(liveVerdict(st(1), D, 0, false, late).ok, false); assert.equal(liveVerdict(st(2), D, 0, false, late).ok, false);
    assert.deepEqual(liveVerdict(st(mb.NO_FILE_TRIES), D, 0, false, late), { ok: true, partial: true, noFile: 1 });
    assert.deepEqual(liveVerdict(st(mb.NO_FILE_TRIES, mb.NO_FILE_MAX), D, 0, false, late), { ok: true, partial: true, noFile: mb.NO_FILE_MAX });
    assert.equal(liveVerdict(st(mb.NO_FILE_TRIES), D, 0, false, late - 60e3).ok, false, 'рано: с первого прохода индекса не прошло 25 минут (06.11 SEC отвечала так минимум три минуты)');
    assert.equal(liveVerdict(st(9, mb.NO_FILE_MAX + 1), D, 0, false, late).ok, false, 'всплеск (06.11 — 31 подача): ждём до последней попытки');
    assert.equal(liveVerdict(st(0, 1, 'HTTP 503'), D, 0, false, late).ok, false, 'сбой сети ждём до последней попытки, сколько бы попыток ни было');
    assert.equal(liveVerdict(st(0), D, 0, false, late).ok, false, 'запись добора без счёта nf (старое состояние) — ждём');
    assert.deepEqual(liveVerdict(st(1), D, 0, true), { ok: true, partial: true }, 'последняя попытка — как раньше');
  });

  // Ночь, когда SEC не отвечает: данные фикстуры без подачи L1 в шарде (она только в журнале ленты), бары — через подставной воркер
  const feedNight = async (name, secHandler, runBuild = morningMain) => {
    const work = join(ROOT, name), data = join(work, 'repo'), feedDir = join(work, 'feed');
    rmSync(work, { recursive: true, force: true });
    for (const d of ['trades', 'reference', 'prices', 'state']) cpSync(join(TMP, d), join(data, d), { recursive: true });
    rmSync(join(data, 'prices', '_opens.json.gz'), { force: true });
    const shardPath = join(data, 'trades', 'live.json.gz'), shard = readJsonGz(shardPath);
    const l1 = shard.trades.filter(r => r.acc === 'L1');
    shard.trades = shard.trades.filter(r => r.acc !== 'L1'); writeJsonGz(shardPath, shard);
    writeJson(join(data, 'state', 'live.json'), { schema: SHARD_VERSION, from: addDaysIso(recentF, -30), lastDay: addDaysIso(recentF, -1), parserRev: PARSER_REV });
    mkdirSync(feedDir, { recursive: true });
    writeFileSync(feedFile(feedDir, recentF), [{ k: 'seen', acc: 'L1', cik: 222, form: '4', filed: recentF }, { k: 'form', acc: 'L1', filed: recentF, at: `${recentF}T17:21`, trades: l1, amend: [] }].map(x => JSON.stringify(x)).join('\n') + '\n');
    const d0 = bizDays('2015-01-01', today).filter(d => d <= recentF).at(-1);
    for (const sym of ['SPY', 'IWM', 'LIVA']) writePriceCache(data, sym, readPriceCache(data, sym).filter(r => r[0] < d0));
    const over = { LIVA: { [d1L]: [50, 51] }, IWM: { [d1L]: [100, 100.5] }, SPY: { [d1L]: [100, 101] } };
    const src = { LIVA: livaSeries, IWM: bizDays('2015-01-01', today).map(d => [d, 100, 100, 1e6]), SPY: bizDays('2015-01-01', today).map(d => [d, 100, 100, 1e6]) };
    const api = await fakeWorker({ charts: Object.fromEntries(Object.entries(src).map(([sym, s]) => [sym, from => chartOf(s.filter(r => r[0] >= from), over[sym])])) });
    const sec = createServer(secHandler);
    await new Promise(r => sec.listen(0, '127.0.0.1', r));
    const keep = { base: process.env.EDGAR_BASE, back: process.env.POLITE_BACKOFF_MS };
    process.env.EDGAR_BASE = `http://127.0.0.1:${sec.address().port}`; process.env.POLITE_BACKOFF_MS = '2';
    try {
      const code = await runBuild(['--state', work, '--data', data, '--site', join(work, 'site'), '--date', recentF, '--no-sync', '--feed-dir', feedDir, '--once', '--interval', '1'], { PAPER_URL: api.base, PAPER_TOKEN: 'tok' });
      return { code, puts: api.calls.morningPuts.map(x => JSON.parse(x)), l1 };
    } finally {
      for (const [k, v] of [['EDGAR_BASE', keep.base], ['POLITE_BACKOFF_MS', keep.back]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await api.close(); await new Promise(r => sec.close(r)); rmSync(work, { recursive: true, force: true });
    }
  };
  const feedListOk = (r, why) => {
    assert.equal(r.code, 1, why + ': список доставлен, но не по индексу — тревога');
    assert.equal(r.puts.length, 1, why);
    const sent = r.puts[0];
    assert.equal(sent.source, 'feed'); assert.equal(sent.listFor, recentF); assert.equal(sent.coverage.source, 'feed');
    const row = sent.days.find(d => d.date === recentF).rows[0], ref = R('morning.json').days.find(d => d.date === recentF).rows[0];
    for (const k of ['t', 'val', 'mx', 'score', 'main', 'dv', 'px', 'cost', 'tags']) assert.deepEqual(row[k], ref[k], `${why}: поле ${k} по ленте то же, что по индексу`);
  };
  await okAsync('B4: SEC не отвечает до последней попытки — список по ленте (раньше резерв включался только при неопубликованном индексе)', async () => {
    feedListOk(await feedNight('.selftest-feed-b4a', req => req.socket.destroy()), 'SEC недоступна');
  });
  await okAsync('B4 (ревью): SEC молчит и на непоследней, и на последней попытке — проба индекса повторяется, резерв по ленте включается без нового прогона шага форм', async () => {
    const hits = { head: 0, get: 0 };
    const r = await feedNight('.selftest-feed-b4c', req => { hits[req.method === 'HEAD' ? 'head' : 'get']++; req.socket.destroy(); }, async (args, env) => {
      const opts = mb.parseArgs(args, env), ctx = { stage: {}, lastChance: false, summary: null };
      const a1 = await mb.attempt(opts, recentF, ctx);
      assert.equal(a1.ok, false, 'непоследняя попытка: формы не собраны — повтор');
      assert.ok(!ctx.stage.index, 'SEC не ответила — шаг индекса не помечен пройденным (до правки помечался, и резерв ждал ещё один прогон форм)');
      assert.equal(hits.head, 1); assert.ok(hits.get > 0, 'шаг форм на непоследней попытке всё же пробовали');
      const gets = hits.get;
      ctx.lastChance = true;
      const a2 = await mb.attempt(opts, recentF, ctx);
      assert.equal(a2.ok, true, a2.why);
      assert.equal(ctx.source, 'feed'); assert.equal(ctx.feedWhy, 'SEC не отвечала');
      assert.equal(hits.head, 1 + 3, 'на последней попытке — три пробы, прежде чем считать, что SEC не отвечает');
      assert.equal(hits.get, gets, 'шаг форм на последней попытке не запускался: время до предела юнита не потрачено');
      return 1;                                                    // main вернул бы 1: список по ленте — тревога
    });
    feedListOk(r, 'SEC недоступна две попытки подряд');
  });
  await okAsync('B4: индекс есть, но шаг форм не удался и на последней попытке — список по ленте вместо «НЕ СОБРАНО»', async () => {
    feedListOk(await feedNight('.selftest-feed-b4b', (req, res) => { if (req.method === 'HEAD') { res.writeHead(200); res.end(); } else { res.writeHead(503); res.end('busy'); } }), 'шаг форм не удался');
  });

  // ---------- B3: минимумы дня на сервере ----------
  const { applyLows, LOWS_BACK_DAYS } = await import('./lib/bars.mjs');
  const { readLows } = await import('./lib/prices.mjs');
  // ответ источника цен с минимумами дня: lows — { дата: минимум }
  const chartLow = (series, lows = {}) => { const c = chartOf(series); c.chart.result[0].indicators.quote[0].low = series.map(r => lows[r[0]] ?? null); return c; };

  ok('B3: минимум дня из ответа источника цен дописывается в слой в том же виде, что у lows.mjs (тикер формы, дата сделки, номинальная шкала)', () => {
    const dir = join(ROOT, '.selftest-lows');
    rmSync(dir, { recursive: true, force: true }); mkdirSync(join(dir, 'reference'), { recursive: true });
    const ser = [['2026-11-06', 210, 210, 1e6], ['2026-11-09', 205, 205, 1e6], ['2026-11-10', 225, 225, 1e6]];
    const got = new Map([['COHR', parseYahooChart(chartLow(ser, { '2026-11-06': 206.1, '2026-11-09': 197.19, '2026-11-10': 203.5 }))], ['NOLO', parseYahooChart(chartOf(ser))]]);
    assert.deepEqual(got.get('COHR').lows, [['2026-11-06', 206.1], ['2026-11-09', 197.19], ['2026-11-10', 203.5]]);
    assert.deepEqual(got.get('NOLO').lows, [], 'источник не отдал минимумы — слой не трогаем');
    assert.equal(applyLows(dir, got, { COHR: ['2026-11-09', '2026-11-08'], NOLO: ['2026-11-09'], NONE: ['2026-11-09'] }), 1, 'только день с баром; 08.11 — воскресенье');
    assert.deepEqual(readLows(dir).get('COHR|2026-11-09'), [197.19, 206.1], 'минимум дня сделки и предыдущего бара');
    assert.equal(applyLows(dir, got, { COHR: ['2026-11-09', '2026-11-10'] }), 1, 'уже лежащая строка не дублируется');
    assert.equal(readLows(dir).size, 2);
    // сплит после даты сделки: минимум возвращается в цену своего времени, как у lows.mjs
    writeJson(join(dir, 'prices', '_splits.json'), { SPLT: [['2026-11-10', 2]] });
    assert.equal(applyLows(dir, new Map([['SPLT', parseYahooChart(chartLow(ser, { '2026-11-06': 100, '2026-11-09': 98 }))]]), { SPLT: ['2026-11-09'] }), 1);
    assert.deepEqual(readLows(dir).get('SPLT|2026-11-09'), [196, 200]);
    // гейт: покупка CEO Coherent 12.11.2026 — 199,48 при закрытии 225,19 и минимуме дня 197,19
    const buy = { code: 'P', px: 199.48, sh: 5000, val: 997400, fn: {} };
    assert.equal(applyGates(buy, { close: 225.19, lows: null }).drop, 'discount', 'без минимумов (сервер до правки)');
    assert.equal(applyGates(buy, { close: 225.19, lows: readLows(dir).get('COHR|2026-11-09') }).ok, true, 'с минимумом дня покупка внутри диапазона');
    assert.equal(LOWS_BACK_DAYS, 7);
    rmSync(dir, { recursive: true, force: true });
  });

  await okAsync('B3: сборка на сервере — план просит минимумы дня сделок, список совпадает с полной сборкой, у которой минимумы уже лежат (COHR 12.11.2026)', async () => {
    // Покупка на 11,4% дешевле закрытия дня сделки, но внутри дневного диапазона: полная сборка (минимумы в слое) её оставляет,
    // сборка на сервере до правки отсеивала как «скидку» — крупнейшая покупка события расходилась
    const base = join(ROOT, '.selftest-lows-vps'), full = join(base, 'full'), work = join(base, 'vps'), data = join(work, 'repo');
    rmSync(base, { recursive: true, force: true }); mkdirSync(join(full, 'state'), { recursive: true });
    const days = bizDays('2024-01-02', today), FB = days.filter(d => d <= addDaysIso(today, -6)).at(-1), TD = days[days.indexOf(FB) - 1], PD = days[days.indexOf(FB) - 2];
    const flat = days.map(d => [d, 100, 100, 1e6]);
    const lser = days.map(d => [d, d >= TD ? 225 : 205, d >= TD ? 225 : 205, 1e6]);          // LOWA: рост 205 → 225 в день сделки
    for (const b of ['SPY', 'IWM']) writePriceCache(full, b, flat);
    writePriceCache(full, 'LOWA', lser);
    writeJson(join(full, 'reference', 'tickers.json'), { 444: { ticker: 'LOWA', exchange: 'NYSE', name: 'Low Inside Range' } });
    const buy = (acc, owners, sh, px) => T({ acc, cik: 444, t: 'LOWA', fdate: FB, tdate: TD, owners, code: 'P', sh, px, val: Math.round(sh * px), own: 1e5 });
    writeJsonGz(join(full, 'trades', 'live.json.gz'), { v: SHARD_VERSION, amend: [], trades: [buy('W1', ceo, 5000, 199.48), buy('W2', dir, 1000, 224)] });
    writeJson(join(full, 'state', 'live.json'), { schema: SHARD_VERSION, lastDay: FB, coverage: { [FB]: { status: 'complete', indexed: 2, collected: 2, pending: 0, at: 'x' } } });
    const lowsFile = (dir, lines) => applyLows(dir, new Map([['LOWA', parseYahooChart(chartLow(lser, lines))]]), { LOWA: [TD] });
    const lowLines = { [PD]: 203.5, [TD]: 197.19 };
    const run = (dataDir, site, extra = []) => execFileSync(process.execPath, [join(ROOT, 'scripts', 'compute.mjs'), '--data', dataDir, '--site', site, '--only-morning', ...extra], { stdio: 'pipe' });
    const rowOf = site => readJson(join(site, 'data', 'morning.json')).days.find(d => d.date === FB).rows.find(r => r.t === 'LOWA');
    try {
      for (const d of ['trades', 'reference', 'prices', 'state']) cpSync(join(full, d), join(data, d), { recursive: true });       // копия сервера — ещё без минимумов
      lowsFile(full, lowLines);                                                                                                     // полная сборка: lows.mjs их уже дописал
      run(full, join(base, 'site-full'));
      const ref = rowOf(join(base, 'site-full'));
      assert.equal(ref.mx, 997400, 'эталон: покупка CEO внутри дневного диапазона остаётся');
      run(data, join(base, 'site-nolow'), ['--plan', join(base, 'plan-nolow.json')]);
      assert.equal(rowOf(join(base, 'site-nolow')).mx, 224000, 'без минимумов крупнейшая покупка события — другая: то, что сервер считал до правки');
      assert.deepEqual(readJson(join(base, 'plan-nolow.json')).lows, { LOWA: [TD] }, 'план докачки просит минимум дня сделки: ключ — тикер формы и дата сделки');
      // сборка на сервере: бар D0 срезан, воркер отдаёт ответ источника с минимумами
      const d0 = days.filter(d => d <= FB).at(-1);
      for (const sym of ['SPY', 'IWM', 'LOWA']) writePriceCache(data, sym, readPriceCache(data, sym).filter(r => r[0] < d0));
      const api = await fakeWorker({ charts: { SPY: from => chartOf(flat.filter(r => r[0] >= from)), IWM: from => chartOf(flat.filter(r => r[0] >= from)), LOWA: from => chartLow(lser.filter(r => r[0] >= from), lowLines) } });
      try {
        const code = await morningMain(['--state', work, '--data', data, '--site', join(work, 'site'), '--date', FB, '--no-sync', '--no-live', '--no-index-check', '--no-feed', '--once', '--interval', '1'], { PAPER_URL: api.base, PAPER_TOKEN: 'tok' });
        assert.equal(code, 0);
        // день подачи в фикстуре уже прошёл, поэтому план считается дважды: ко второму проходу минимум лежит в слое, и план его больше не просит
        assert.deepEqual(readJson(join(work, 'plan.json')).lows, {}, 'после докачки минимум дня в слое');
        const asked = api.calls.bars.filter(b => b.sym === 'LOWA').map(b => b.from).sort()[0];
        assert.ok(asked <= addDaysIso(TD, -LOWS_BACK_DAYS), `запрос покрывает день сделки и предыдущий бар: с ${asked}`);
        assert.deepEqual(readLows(data).get(`LOWA|${TD}`), [197.19, 203.5]);
        const row = JSON.parse(api.calls.morningPuts[0]).days.find(d => d.date === FB).rows.find(r => r.t === 'LOWA');
        for (const k of ['mx', 'val', 'n', 'score', 'main']) assert.deepEqual(row[k], ref[k], `поле ${k}: сервер = полная сборка`);
      } finally { await api.close(); }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  ok('B6: сверка двух сборок сравнивает и крупнейшую покупку события (12.11.2026: COHR $223 тыс. у сервера, $997 тыс. у GitHub при том же скоре)', () => {
    const { mxDiffers, MX_TOL } = morningLib;
    const r = (t, score, mx, val = mx) => ({ t, name: t, score, main: score >= 2, mx, val });
    const vps = [r('MP', 4, 2.1e6), r('HOS', 3, 5e5), r('COHR', 3, 222885, 1220285), r('EQPT', 3, 249989, 804105), r('PAM', 3, 786517)];
    const gh = [r('MP', 4, 2.1e6), r('HOS', 3, 5e5), r('COHR', 3, 997400, 1220285), r('EQPT', 3, 554116, 804105), r('PAM', 3, 786517)];
    const c = compareMain(vps, gh);
    assert.equal(c.same, false, 'состав и скор равны, но порядок бумаг у бота другой');
    assert.deepEqual(c.diff.map(x => [x.t, x.was, x.now, x.mxWas, x.mxNow]), [['COHR', 3, 3, 222885, 997400], ['EQPT', 3, 3, 249989, 554116]]);
    assert.equal(compareMain(gh, gh).same, true);
    assert.equal(compareMain([r('A', 2, 100000)], [r('A', 2, 100900)]).same, true, 'расхождение до 1% — не отличие (округление цены)');
    assert.equal(compareMain([r('A', 2, 100000)], [r('A', 2, 101100)]).same, false);
    assert.deepEqual(compareMain([r('A', 2, 1e5)], [r('A', 3, 2e6)]).diff[0], { t: 'A', name: 'A', was: 2, now: 3, val: 2e6 }, 'изменился скор — запись прежнего вида');
    assert.equal(mxDiffers({ val: 5 }, { val: 5 }), false, 'у старых строк без mx сравнивается сумма'); assert.equal(MX_TOL, 0.01);
  });

  await okAsync('B2б: ночная сборка берёт из журнала ленты формы, разобранные тем же разбором и скачанные целиком; остальные качает — строки те же', async () => {
    const base = join(ROOT, '.selftest-feedfirst');
    rmSync(base, { recursive: true, force: true });
    const D = '2026-11-06', accs = [21, 22, 23, 24].map(accB), sym = { [accs[0]]: 'AAA', [accs[1]]: 'BBB', [accs[2]]: 'CCC', [accs[3]]: 'DDD' };
    const index = ['Form Type   Company Name   CIK   Date Filed   File Name', '-'.repeat(80), ...accs.map(a => idxLineB('ISSUER ' + sym[a], 555000, D, pathB(555000, a)))].join('\n');
    const hits = [];
    const srv = createServer((req, res) => {
      const url = decodeURIComponent(req.url);
      if (/form\.20261106\.idx$/.test(url)) { res.writeHead(200); res.end(index); return; }
      if (/daily-index/.test(url)) { res.writeHead(403, { 'content-type': 'application/xml' }); res.end(S3B); return; }
      const m = /(\d{10}-\d{2}-\d{6})\.txt$/.exec(url);
      if (m) { hits.push(m[1]); res.writeHead(200); res.end(formB(m[1], sym[m[1]])); return; }
      res.writeHead(404); res.end();
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const prep = name => {
      const L = join(base, name);
      mkdirSync(join(L, 'state'), { recursive: true });
      writeJson(join(L, 'state', 'live.json'), { schema: SHARD_VERSION, from: '2026-11-02', lastDay: '2026-11-05', parserRev: PARSER_REV });
      writeJson(join(L, 'state', 'backfill.json'), { done: ['2026q3'] });
      writeJsonGz(join(L, 'trades', 'live.json.gz'), { v: SHARD_VERSION, trades: [], amend: [] });
      return L;
    };
    const run = (L, extra = []) => runScript('live.mjs', ['--data', L, '--today', '2026-11-07', '--retries', '0', '--reread-budget-min', '0', ...extra], { EDGAR_BASE: `http://127.0.0.1:${srv.address().port}` });
    const rowsOf = L => readJsonGz(join(L, 'trades', 'live.json.gz')).trades.slice().sort((a, b) => (a.acc < b.acc ? -1 : 1));
    try {
      // эталон: все четыре формы скачаны
      const full = prep('full');
      assert.equal((await run(full)).code, 0);
      assert.deepEqual(hits.slice().sort(), accs);
      // журнал ленты: A — тем же разбором и целиком; B — другой ревизией разбора; C — файл оборван; D — числится за другой день
      const feedDir = join(base, 'feed'); mkdirSync(feedDir, { recursive: true });
      const rec = (a, extra = {}) => { const p = parseForm4Txt(formB(a, sym[a]), a, D); return { k: 'form', acc: a, filed: D, at: `${D}T17:15`, rev: PARSER_REV, end: true, trades: p.trades, amend: p.amend, ...extra }; };
      writeFileSync(feedFile(feedDir, D), [rec(accs[0]), rec(accs[1], { rev: PARSER_REV - 1 }), rec(accs[2], { end: false }), rec(accs[3], { filed: '2026-11-05' })].map(x => JSON.stringify(x)).join('\n') + '\n');
      hits.length = 0;
      const fed = prep('fed');
      const r = await run(fed, ['--feed-dir', feedDir]);
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(hits.slice().sort(), accs.slice(1), 'форма из журнала ленты не качается; три остальные — качаются');
      const c = readJson(join(fed, 'state', 'live.json')).coverage[D];
      assert.deepEqual([c.status, c.indexed, c.collected, c.fromFeed], ['complete', 4, 4, 1]);
      assert.deepEqual(rowsOf(fed), rowsOf(full), 'шард тот же, что при скачивании всех форм');
      assert.match(r.out, /из журнала ленты 1, скачано 3/);
      // старый журнал без полей rev и end (записи до правки) первым источником не служит
      writeFileSync(feedFile(feedDir, D), JSON.stringify({ k: 'form', acc: accs[0], filed: D, trades: [], amend: [] }) + '\n');
      hits.length = 0;
      const old = prep('old');
      await run(old, ['--feed-dir', feedDir]);
      assert.deepEqual(hits.slice().sort(), accs); assert.deepEqual(rowsOf(old), rowsOf(full));
    } finally { await new Promise(r => srv.close(r)); rmSync(base, { recursive: true, force: true }); }
  });
}

// ==================== АУДИТ ФОРМ 17.11.2026, пакет C: ежедневная сверка со сторонним разбором (OpenInsider) ====================
{
  const { OI, oiUrl, parseOi, matchOi } = await import('./lib/oicheck.mjs');
  // Строка таблицы скринера в настоящей разметке: дата подачи — ссылка на форму, в ячейке тикера — всплывающая подсказка с «>» внутри тега
  const oiRow = ({ acc, cik = 1234, filed, tdate, t, issuer = 'Issuer Inc', insider, title = 'CEO', px, qty, val, kind = 'P - Purchase', x = '' }) =>
    `<tr style="background:#f3fff3"><td align=right>${x}</td><td align=right><div><a href="http://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/xslF345X03/wk-form4.xml" title="SEC Form 4" target="_blank">${filed}</a></div></td>`
    + `<td align=right><div>${tdate}</div></td><td><b> <a href="/${t}" onmouseover="Tip('<img src=\\'https://example.org/chart?chart=${t}\\' width=\\'360px\\'>', DELAY, 1)" onmouseout="UnTip()">${t}</a></b></td>`
    + `<td><a href="/${t}">${issuer}</a></td><td><a href="/insider/x/1">${insider}</a></td><td>${title}</td><td>${kind}</td><td align=right>$${px.toFixed(2)}</td><td align=right>+${qty.toLocaleString('en-US')}</td>`
    + `<td align=right>100,000</td><td align=right>+5%</td><td align=right>+$${Math.round(val).toLocaleString('en-US')}</td><td></td><td></td><td></td><td></td></tr>`;
  const D = '2026-11-12';
  const page = rows => `<html><body><table class="tinytable"><thead><tr><th>X</th><th>Filing Date</th></tr></thead><tbody>${rows.map(oiRow).join('\n')}</tbody></table></body></html>`;
  const P = (acc, t, sh, name, extra = {}) => ({ acc, t, T: t, sh, val: sh * 10, owners: [{ name }], ...extra });

  ok('C: разбор страницы стороннего источника — номер подачи из ссылки, тикер из ячейки с подсказкой, повторы убираются', () => {
    const r = { acc: '0000899140-26-001276', filed: `${D} 18:02:11`, tdate: '2026-11-09', t: 'COHR', insider: 'Anderson James Robert', px: 199.48, qty: 5000, val: 997400 };
    const rows = parseOi(page([r, r, { ...r, acc: '0001104659-26-126281', t: 'BRK.B', insider: 'Doe &amp; Roe LP', qty: 100, val: 50000, px: 500 }]));
    assert.equal(rows.length, 2, 'повтор строки убран');
    assert.deepEqual([rows[0].acc, rows[0].t, rows[0].filed, rows[0].tdate, rows[0].qty, rows[0].val, rows[0].px, rows[0].kind], ['0000899140-26-001276', 'COHR', `${D} 18:02:11`, '2026-11-09', 5000, 997400, 199.48, 'P - Purchase']);
    assert.equal(rows[1].t, 'BRK.B'); assert.equal(rows[1].insider, 'Doe & Roe LP');
    assert.deepEqual(parseOi('<html><body>Service unavailable</body></html>'), [], 'нет таблицы — нет строк');
    assert.match(oiUrl(D), /fdr=11%2F12%2F2026\+-\+11%2F12%2F2026&td=0.*&xp=1&vl=10&.*cnt=1000/);
    assert.equal(/@|rodion/i.test(OI.ua + oiUrl(D)), false, 'в запросе нет личных данных');
  });

  ok('C: тревога — только покупка от $100 тыс. в биржевой бумаге, которой нет у панели; провалы самого источника тревоги не дают', () => {
    const oi = parseOi(page([
      { acc: '0000899140-26-001276', filed: `${D} 18:02:11`, tdate: '2026-11-09', t: 'COHR', insider: 'Anderson James Robert', px: 199.48, qty: 5000, val: 997400 },   // есть у панели: тот же номер подачи
      { acc: '0000000001-26-000001', filed: `${D} 17:00:00`, tdate: '2026-11-10', t: 'DUPF', insider: 'Smith John', px: 20, qty: 10000, val: 200000 },                  // повторная подача под другим номером: тикер и акции
      { acc: '0000000002-26-000001', filed: `${D} 17:00:00`, tdate: '2026-11-10', t: 'BH', insider: 'Biglari Sardar', px: 355, qty: 628, val: 222940 },                  // тикер другого класса: имя лица и акции
      { acc: '0000000003-26-000001', filed: `${D} 16:30:00`, tdate: '2026-11-10', t: 'MISS', insider: 'Lost Buyer', px: 50, qty: 30000, val: 1500000 },                  // настоящий пропуск
      { acc: '0000000004-26-000001', filed: `${D} 16:31:00`, tdate: '2026-11-10', t: 'SMAL', insider: 'Small Buyer', px: 5, qty: 4000, val: 20000 },                     // пропуск, но меньше порога
      { acc: '0000000005-26-000001', filed: `${D} 16:32:00`, tdate: '2026-11-10', t: 'OTCX', insider: 'Otc Buyer', px: 1, qty: 500000, val: 500000 },                    // внебиржевая бумага
      { acc: '0000000006-26-000001', filed: '2026-11-11 16:32:00', tdate: '2026-11-10', t: 'YEST', insider: 'Other Day', px: 10, qty: 50000, val: 500000 },              // другой день подачи
      { acc: '0000000007-26-000001', filed: `${D} 16:33:00`, tdate: '2026-11-10', t: 'SALE', insider: 'Seller', px: 10, qty: 50000, val: 500000, kind: 'S - Sale' },     // не покупка
      { acc: '0000000012-26-000001', filed: `${D} 16:40:00`, tdate: '2026-11-10', t: 'PART', insider: 'Half Parsed', px: 20, qty: 50000, val: 1000000 },                 // подача у панели есть, но акций в ней впятеро меньше
      { acc: '0000000013-26-000001', filed: `${D} 16:41:00`, tdate: '2026-11-10', t: 'TINY', insider: 'Tiny Gap', px: 5, qty: 10000, val: 50000 },                       // недостача есть, но меньше порога
    ]));
    const panel = [P('0000899140-26-001276', 'COHR', 5000, 'Anderson James Robert'), P('0000000009-26-000009', 'DUPF', 10000, 'SMITH JOHN'), P('0000000010-26-000010', 'BH-A', 628, 'BIGLARI SARDAR'),
      P('0000000012-26-000001', 'PART', 10000, 'Half Parsed'), P('0000000013-26-000001', 'TINY', 9000, 'Tiny Gap'),
      P('0000000011-26-000011', 'ONLY', 7000, 'Panel Only')];        // покупка, которой нет у источника (компании развития бизнеса, фонды), — не тревога
    const res = matchOi(oi, panel, { day: D, listed: t => t !== 'OTCX' });
    assert.deepEqual([res.oi, res.found, res.byAcc, res.byName], [8, 5, 3, 1]);
    assert.deepEqual(res.missing.map(m => m.t), ['MISS', 'OTCX', 'SMAL']);
    assert.deepEqual(res.alerts.map(m => [m.t, m.val, m.insider, !!m.partial]), [['MISS', 1500000, 'Lost Buyer', false], ['PART', 800000, 'Half Parsed', true]],
      'тревога — и пропуск подачи, и подача, из которой разбор взял только часть акций (недостача от $100 тыс.)');
    assert.deepEqual(res.partial.map(m => [m.t, m.qty, m.panelQty, m.val]), [['PART', 50000, 10000, 800000], ['TINY', 10000, 9000, 5000]]);
    assert.deepEqual(res.refiled.map(m => [m.t, m.by]), [['DUPF', 'ticker'], ['BH', 'name']], 'номер подачи известен, у панели его нет, покупка найдена в другой подаче — в файле это видно');
    assert.equal(matchOi(oi, [], { day: '2026-11-13' }).oi, 0, 'строки другого дня не сверяются');
  });

  ok('C: шаг сборки пишет oicheck.json рядом с morning.json и не падает, когда источник недоступен; письмо — строка только при пропуске', () => {
    const base = join(ROOT, '.selftest-oicheck'), data = join(base, 'data'), site = join(base, 'site'), htmlFile = join(base, 'oi.html');
    rmSync(base, { recursive: true, force: true }); mkdirSync(join(site, 'data'), { recursive: true }); mkdirSync(join(data, 'state'), { recursive: true });
    const day = nDay(-1);
    const row = (acc, t, sh, name) => ({ acc, form: '4', code: 'P', fdate: day, tdate: day, cik: t === 'AAA' ? 1 : 2, t, sh, px: 20, val: sh * 20, sec: 'Common Stock', owners: [{ cik: 9, name, rel: 'D', title: '' }] });
    writeJsonGz(join(data, 'trades', 'live.json.gz'), { v: SHARD_VERSION, amend: [], trades: [row('0000000021-26-000001', 'AAA', 20000, 'Smith John')] });
    writeJson(join(data, 'reference', 'tickers.json'), { 1: { ticker: 'AAA', exchange: 'NYSE', name: 'Aaa' }, 2: { ticker: 'BBB', exchange: 'Nasdaq', name: 'Bbb' }, 3: { ticker: 'OTCX', exchange: 'OTC', name: 'Otc' } });
    const morningFile = join(site, 'data', 'morning.json');
    const putMorning = () => writeJson(morningFile, { built: isoToday(), listFor: day, params: { minVal: 1e4, minPx: 5, dvMin: 1e7, dvCost: 3e7, scoreMin: 2 }, counter: mCounter, days: [mDay(day, [mRow('AAA', 4e5)])] });
    putMorning();
    writeFileSync(htmlFile, page([{ acc: '0000000021-26-000001', filed: `${day} 17:00:00`, tdate: day, t: 'AAA', insider: 'Smith John', px: 20, qty: 20000, val: 400000 },
      { acc: '0000000022-26-000001', filed: `${day} 17:05:00`, tdate: day, t: 'BBB', insider: 'Jones Mary', px: 30, qty: 40000, val: 1200000 }]));
    const check = extra => execFileSync(process.execPath, [join(ROOT, 'scripts', 'oicheck.mjs'), '--data', data, '--site', site, ...extra], { encoding: 'utf8' });
    const letter = dir => execFileSync(process.execPath, [join(ROOT, 'scripts', 'notify.mjs'), '--site', site, '--data', dir, '--dry-run'], { encoding: 'utf8' });
    const seeded = name => { const d = join(base, name); mkdirSync(join(d, 'state'), { recursive: true }); writeJson(join(d, 'state', 'notify.json'), { version: 4, sentMorning: [] }); return d; };
    try {
      const before = readFileSync(morningFile, 'utf8');
      assert.match(check(['--html', htmlFile]), /нет у панели 1; ПРОПУСК/);
      const j = readJson(join(site, 'data', 'oicheck.json'));
      assert.deepEqual([j.ok, j.listFor, j.oi, j.found, j.alerts.length, j.alerts[0].t, j.alerts[0].val], [true, day, 2, 1, 1, 'BBB', 1200000]);
      assert.equal(readFileSync(morningFile, 'utf8'), before, 'morning.json шаг не трогает: контракт бота не меняется');
      const out = letter(seeded('n1'));
      assert.match(out, /Сверка со сторонним разбором: в данных панели нет покупок, которые видит OpenInsider \(от \$100.тыс\.\), — BBB \$1,2.млн\. Список мог выйти неполным\./);
      assert.deepEqual(readJson(join(base, 'n1', 'state', 'notify.json')).sentMorning.sort(), [`morning|${day}`, `oi|${day}`].sort(), 'строка ушла в письме — отдельного сообщения не будет');
      // письмо за день уже ушло (с сервера), а пропуск найден позже — отдельное короткое сообщение, один раз
      const late = seeded('n2'); writeJson(join(late, 'state', 'notify.json'), { version: 4, sentMorning: [`morning|${day}`] });
      const out2 = letter(late);
      assert.match(out2, /сверка со сторонним разбором/); assert.match(out2, /BBB/); assert.ok(!/утренний список/.test(out2));
      assert.ok(!/BBB/.test(letter(late)), 'повторно не шлётся');
      // пропусков нет — в письме ни слова
      writeFileSync(htmlFile, page([{ acc: '0000000021-26-000001', filed: `${day} 17:00:00`, tdate: day, t: 'AAA', insider: 'Smith John', px: 20, qty: 20000, val: 400000 }]));
      check(['--html', htmlFile]);
      assert.equal(readJson(join(site, 'data', 'oicheck.json')).alerts.length, 0);
      assert.ok(!/сторонним разбором/.test(letter(seeded('n3'))));
      // источник недоступен или отдал страницу без таблицы: код 0, ok: false, тревоги нет
      writeFileSync(htmlFile, '<html><body>Service Temporarily Unavailable</body></html>');
      check(['--html', htmlFile]);
      assert.equal(readJson(join(site, 'data', 'oicheck.json')).ok, false);
      assert.ok(!/сторонним разбором/.test(letter(seeded('n4'))));
      // файла за другой день письмо не читает
      writeJson(join(site, 'data', 'oicheck.json'), { ok: true, listFor: nDay(-9), minVal: 1e5, alerts: [{ t: 'OLD', val: 5e6 }] });
      assert.ok(!/OLD/.test(letter(seeded('n5'))));
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}

// ==================== ВТОРАЯ ПАЧКА ПО АУДИТУ ФОРМ, 11.2026 (audit-840-forms-2026-11-17/fixes2) ====================
// Правка 2: бар незакрытого торгового дня не пишется в кэш цен и в открытия дня входа (lib/session.mjs, prices.mjs)
{
  const { openBarDay, barClosedAtMs, dropOpenBars, SESSION } = await import('./lib/session.mjs');
  const at = wall => nyToMs(wall);

  ok('пачка 2, правка 2: сокращённые дни биржи — пятница после Дня благодарения, 24 декабря и 3 июля, когда это торговый будний день', () => {
    const { nyseEarlyCloses, marketCloseEt } = buildCalendar;
    assert.deepEqual([...nyseEarlyCloses(2026)].sort(), ['2026-11-27', '2026-12-24'], '03.07.2026 — праздничная пятница (День независимости в субботу)');
    assert.deepEqual([...nyseEarlyCloses(2025)].sort(), ['2025-07-03', '2025-11-28', '2025-12-24']);
    assert.deepEqual([...nyseEarlyCloses(2027)].sort(), ['2027-11-26'], '03.07.2027 — суббота, 24.12.2027 — праздничная пятница');
    assert.deepEqual([...nyseEarlyCloses(2023)].sort(), ['2023-07-03', '2023-11-24'], '24.12.2023 — воскресенье');
    assert.deepEqual([...nyseEarlyCloses(2024)].sort(), ['2024-07-03', '2024-11-29', '2024-12-24']);
    assert.equal(marketCloseEt('2026-11-18'), '16:00');
    assert.equal(marketCloseEt('2026-11-27'), '13:00');
    for (const d of ['2026-11-26', '2026-11-21', '2026-07-03', '2026-04-03']) assert.equal(marketCloseEt(d), null, d);
    assert.equal(webCalendar.marketCloseEt, marketCloseEt, 'календарь сборки и страницы — один модуль');
  });

  ok('пачка 2, правка 2: бар дня закрыт с 16:10 по Нью-Йорку, в сокращённый день — с 13:10; до того день считается незакрытым', () => {
    assert.equal(SESSION.settleMin, 10);
    assert.equal(barClosedAtMs('2026-11-18'), Date.parse('2026-11-18T21:10:00Z'), 'зимнее время: 16:10 ET = 21:10 UTC');
    assert.equal(barClosedAtMs('2026-07-01'), Date.parse('2026-07-01T20:10:00Z'), 'летнее время: 16:10 ET = 20:10 UTC');
    assert.equal(barClosedAtMs('2026-11-27'), Date.parse('2026-11-27T18:10:00Z'), 'сокращённый день: 13:10 ET');
    assert.equal(barClosedAtMs('2026-11-26'), null, 'День благодарения: биржа не торгует');
    for (const w of ['2026-11-18T00:05', '2026-11-18T07:30', '2026-11-18T09:29', '2026-11-18T11:00', '2026-11-18T15:59', '2026-11-18T16:09'])
      assert.equal(openBarDay(at(w)), '2026-11-18', w);
    for (const w of ['2026-11-18T16:10', '2026-11-18T16:15', '2026-11-18T22:03', '2026-11-18T23:59'])
      assert.equal(openBarDay(at(w)), null, w);
    assert.equal(openBarDay(at('2026-11-21T11:00')), null, 'суббота');
    assert.equal(openBarDay(at('2026-11-26T11:00')), null, 'праздник биржи');
    assert.equal(openBarDay(at('2026-11-27T12:30')), '2026-11-27', 'сокращённый день, торги идут');
    assert.equal(openBarDay(at('2026-11-27T13:09')), '2026-11-27', 'сокращённый день: до закрытия с запасом');
    assert.equal(openBarDay(at('2026-11-27T13:10')), null, 'сокращённый день: бар закрыт');
    assert.equal(openBarDay(at('2026-07-01T15:00')), '2026-07-01'); assert.equal(openBarDay(at('2026-07-01T16:10')), null);
  });

  ok('пачка 2, правка 2: из ответа источника срезаются ряд, открытия и минимумы незакрытого дня; закрытый ответ не меняется', () => {
    const days = bizDays('2026-10-01', '2026-11-18'), D = '2026-11-18', P = '2026-11-17';
    const ser = days.map((d, i) => [d, 100 + (i % 7) * 0.5, 100 + (i % 7) * 0.5, d === D ? 4e5 : 1e6]);
    const res = parseYahooChart(chartOf(ser, { [D]: [101, 99] }));
    res.lows = ser.map(r => [r[0], r[1] - 1]);
    assert.equal(res.series.at(-1)[0], D); assert.equal(res.ohlc.at(-1)[0], D);
    const cut = dropOpenBars(res, openBarDay(at(`${D}T11:00`)));
    assert.equal(cut.series.at(-1)[0], P); assert.equal(cut.ohlc.at(-1)[0], P); assert.equal(cut.lows.at(-1)[0], P); assert.equal(cut.cut, 1);
    assert.equal(res.series.at(-1)[0], D, 'исходный ответ не тронут');
    assert.equal(dropOpenBars(res, openBarDay(at(`${D}T16:15`))), res, 'после закрытия ответ тот же');
    assert.equal(dropOpenBars(cut, D), cut, 'бара дня в ответе нет — срезать нечего (утренний прогон)');
    assert.deepEqual(dropOpenBars({ missing: true }, D), { missing: true });
    // запись, как в prices.mjs: кэш и открытие дня входа для покупки с подачей накануне
    const L = join(TMP, 'openbar');
    const write = r => { writePriceCache(L, 'AAA', r.series); const st = readOpens(L); mergeOpens(st, 'AAA', pickOpens(r.ohlc, [P], { vol: new Map(r.series.map(x => [x[0], x[3]])) })); writeOpens(L, st, D); };
    write(cut);
    assert.equal(readPriceCache(L, 'AAA').at(-1)[0], P, '11:00 — бара дня в кэше нет');
    assert.equal(opensOf(readOpens(L), 'AAA', D), null, '11:00 — открытия дня входа нет');
    write(dropOpenBars(parseYahooChart(chartOf(ser.map(r => (r[0] === D ? [D, 105, 105, 1e6] : r)), { [D]: [101, 105] })), openBarDay(at(`${D}T16:15`))));
    assert.deepEqual(readPriceCache(L, 'AAA').at(-1), [D, 105, 105, 1e6], '16:15 — бар дня записан закрытым');
    assert.deepEqual(opensOf(readOpens(L), 'AAA', D).slice(0, 2), [101, 105]);
  });

  // Прогон prices.mjs целиком: источник цен и справочник SEC подставные (подмена fetch модулем --import), часы — --now
  await okAsync('пачка 2, правка 2: прогон обновления цен в 11:00 по Нью-Йорку не оставляет бара дня, в 16:15 — оставляет, в сокращённый день — по его закрытию', async () => {
    const base = join(ROOT, '.selftest-openbar');
    rmSync(base, { recursive: true, force: true }); mkdirSync(base, { recursive: true });
    const stub = join(base, 'stub.mjs');
    writeFileSync(stub, [
      "import { readFileSync } from 'node:fs';",
      "const fx = () => JSON.parse(readFileSync(process.env.STUB_FIXTURE, 'utf8'));",
      "const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });",
      'globalThis.fetch = async url => {',
      '  const u = new URL(String(url)), f = fx();',
      "  if (u.hostname === 'www.sec.gov') return json(f.tickers);",
      "  const m = u.pathname.startsWith('/v8/finance/chart/') ? decodeURIComponent(u.pathname.slice('/v8/finance/chart/'.length)) : null;",
      "  return m && f.charts[m] ? json(f.charts[m]) : new Response('', { status: 404 });",
      '};',
    ].join('\n') + '\n');
    const run = (L, now, fixture) => {
      const fx = join(base, 'fixture.json');
      writeJson(fx, fixture);
      return new Promise(resolve => execFile(process.execPath, ['--import', pathToFileURL(stub).href, join(ROOT, 'scripts', 'prices.mjs'), '--mode', 'daily', '--data', L, '--now', now],
        { encoding: 'utf8', env: { ...process.env, POLITE_BACKOFF_MS: '2', STUB_FIXTURE: fx } }, (err, so, se) => resolve({ code: err ? (err.code ?? 1) : 0, out: so + se })));
    };
    const tickers = { fields: ['cik', 'name', 'ticker', 'exchange'], data: [[1, 'AAA Inc', 'AAA', 'NYSE']] };
    // day — торговый день прогона, prev — день подачи покупки (её день входа — day); бар дня — середины сессии (fin = false) или закрытый
    const scene = (name, day, prev) => {
      const L = join(base, name);
      const days = bizDays('2026-08-03', day).filter(d => !isMarketClosed(d));
      const ser = fin => days.map((d, i) => (d === day ? [d, fin ? 105 : 99, fin ? 105 : 99, fin ? 1e6 : 4e5] : [d, 100 + (i % 7) * 0.5, 100 + (i % 7) * 0.5, 1e6]));
      const charts = fin => Object.fromEntries(['SPY', 'IWM', 'AAA'].map(s => [s, chartOf(ser(fin), { [day]: [101, fin ? 105 : 99] })]));
      writeJsonGz(join(L, 'trades', 'live.json.gz'), { v: SHARD_VERSION, amend: [], trades: [T({ acc: 'OB1', cik: 1, t: 'AAA', fdate: prev, tdate: prev, owners: ceo, code: 'P', sh: 1000, px: 100, val: 1e5, own: 1e5 })] });
      return { L, charts, last: sym => readPriceCache(L, sym).at(-1), open: sym => opensOf(readOpens(L), sym, day) };
    };
    try {
      const a = scene('wed', '2026-11-18', '2026-11-17');
      let r = await run(a.L, '2026-11-18T11:00:00-05:00', { tickers, charts: a.charts(false) });
      assert.equal(r.code, 0, r.out);
      for (const s of ['SPY', 'IWM', 'AAA']) { assert.equal(a.last(s)[0], '2026-11-17', `${s}: бар незакрытого дня в кэш не записан`); assert.equal(a.open(s), null, `${s}: открытия незакрытого дня нет`); }
      assert.match(r.out, /торги 2026-11-18 ещё не закрыты: бар этого дня не записан у 3 рядов/);
      r = await run(a.L, '2026-11-18T16:15:00-05:00', { tickers, charts: a.charts(true) });
      assert.equal(r.code, 0, r.out);
      for (const s of ['SPY', 'IWM', 'AAA']) { assert.deepEqual(a.last(s), ['2026-11-18', 105, 105, 1e6], s); assert.deepEqual(a.open(s).slice(0, 2), [101, 105], s); }
      assert.ok(!/ещё не закрыты/.test(r.out));
      // сокращённый день (пятница после Дня благодарения): 12:30 — нет, 13:05 — запас ещё не вышел, 13:15 — да
      const b = scene('short', '2026-11-27', '2026-11-25');
      r = await run(b.L, '2026-11-27T12:30:00-05:00', { tickers, charts: b.charts(false) });
      assert.equal(r.code, 0, r.out); assert.equal(b.last('AAA')[0], '2026-11-25'); assert.equal(b.open('IWM'), null);
      r = await run(b.L, '2026-11-27T13:05:00-05:00', { tickers, charts: b.charts(true) });
      assert.equal(b.last('AAA')[0], '2026-11-25', '13:05 — запас после закрытия ещё не вышел');
      r = await run(b.L, '2026-11-27T13:15:00-05:00', { tickers, charts: b.charts(true) });
      assert.deepEqual(b.last('AAA'), ['2026-11-27', 105, 105, 1e6]); assert.deepEqual(b.open('AAA').slice(0, 2), [101, 105]);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}

// Правка 3: страховочный прогон daily.yml по расписанию GitHub не работает с 08:10 по Нью-Йорку до закрытия торгов (lib/session.mjs, schedule-guard.mjs)
{
  const { scheduleGuard, SESSION } = await import('./lib/session.mjs');
  const g = (ev, wall) => scheduleGuard(ev, nyToMs(wall)).skip;

  ok('пачка 2, правка 3: прогон по расписанию, начатый в торговый день позже 08:10 и до закрытия торгов, пропускается; остальные — нет', () => {
    assert.equal(SESSION.guardFrom, '08:10');
    // как опаздывало расписание до сих пор: 03–04 утра в октябре, 07:26 — 17.11.2026; по плану — 22:40 (зима) и 23:40 (лето)
    for (const w of ['2026-10-15T03:40', '2026-11-17T07:26', '2026-11-18T08:10', '2026-11-18T22:40', '2026-07-01T23:40', '2026-11-18T00:10'])
      assert.equal(g('schedule', w), false, w);
    for (const w of ['2026-11-18T08:11', '2026-11-18T08:30', '2026-11-18T09:30', '2026-11-18T12:00', '2026-11-18T15:59', '2026-11-18T16:09', '2026-07-01T10:00'])
      assert.equal(g('schedule', w), true, w);
    assert.equal(g('schedule', '2026-11-18T16:10'), false, 'торги закрыты: бары дня уже закрытые');
    assert.equal(g('schedule', '2026-11-21T10:00'), false, 'суббота');
    assert.equal(g('schedule', '2026-11-26T10:00'), false, 'праздник биржи (SEC тоже закрыта)');
    assert.equal(g('schedule', '2026-04-03T10:00'), false, 'Страстная пятница: биржа закрыта');
    assert.equal(g('schedule', '2026-11-27T13:05'), true, 'сокращённый день: до закрытия с запасом');
    assert.equal(g('schedule', '2026-11-27T13:10'), false, 'сокращённый день: после закрытия');
    for (const ev of ['workflow_dispatch', 'push', '', undefined]) assert.equal(g(ev, '2026-11-18T12:00'), false, `событие ${ev}: ограничения нет`);
    assert.match(scheduleGuard('schedule', nyToMs('2026-11-18T09:41')).why, /начат в 09:41 по Нью-Йорку торгового дня 2026-11-18 — позже 08:10 и до закрытия торгов \(16:10\)/);
  });

  ok('пачка 2, правка 3: шаг стража — решение в GITHUB_OUTPUT, код выхода всегда 0; сбой стража прогон не останавливает', () => {
    const out = join(TMP, 'guard-output.txt');
    const run = (argv, env = {}) => {
      rmSync(out, { force: true });
      const text = execFileSync(process.execPath, [join(ROOT, 'scripts', 'schedule-guard.mjs'), ...argv], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_ACTIONS: '', ...env } });
      return { text, skip: readFileSync(out, 'utf8') };
    };
    let r = run(['--event', 'schedule', '--now', '2026-11-18T09:41:00-05:00']);
    assert.equal(r.skip, 'skip=true\n'); assert.match(r.text, /ПРОПУСК: прогон по расписанию GitHub начат в 09:41/);
    r = run(['--event', 'schedule', '--now', '2026-11-18T07:26:00-05:00']);
    assert.equal(r.skip, 'skip=false\n'); assert.match(r.text, /работаем/);
    assert.equal(run(['--event', 'workflow_dispatch', '--now', '2026-11-18T09:41:00-05:00']).skip, 'skip=false\n', 'ручной запуск не ограничен');
    assert.equal(run(['--event', 'push', '--now', '2026-11-18T09:41:00-05:00']).skip, 'skip=false\n', 'запуск от слияния не ограничен');
    assert.equal(run(['--now', '2026-11-18T09:41:00-05:00'], { GITHUB_EVENT_NAME: 'schedule' }).skip, 'skip=true\n', 'событие берётся и из окружения GitHub');
    r = run(['--event', 'schedule', '--now', 'не-время']);
    assert.equal(r.skip, 'skip=false\n', 'ошибка стража — прогон идёт'); assert.match(r.text, /страж не сработал/);
    assert.match(run(['--event', 'schedule', '--now', '2026-11-18T09:41:00-05:00'], { GITHUB_ACTIONS: 'true' }).text, /::notice::Прогон пропущен/);
  });

  ok('пачка 2, правка 3: в daily.yml вся работа (снимок в ветку data, публикация Pages, письма) — в задаче update, а она не идёт при skip=true стража', () => {
    const y = readFileSync(join(ROOT, '.github', 'workflows', 'daily.yml'), 'utf8').replace(/\r/g, '');
    const jobs = y.slice(y.indexOf('\njobs:\n'));
    const names = [...jobs.matchAll(/^ {2}([a-z_-]+):\n/gm)].map(m => m[1]);
    assert.deepEqual(names, ['guard', 'update'], 'задач две: страж и обновление');
    const guard = jobs.slice(jobs.indexOf('\n  guard:\n'), jobs.indexOf('\n  update:\n')), update = jobs.slice(jobs.indexOf('\n  update:\n'));
    assert.match(guard, /outputs:\n {6}skip: \$\{\{ steps\.guard\.outputs\.skip \}\}/);
    assert.match(guard, /\n {4}continue-on-error: true\n/, 'сбой задачи-стража прогон не красит');
    assert.match(guard, /id: guard\n {8}continue-on-error: true\n {8}run: node scripts\/schedule-guard\.mjs --event "\$\{\{ github\.event_name \}\}"/);
    assert.ok(!/git push|upload-pages-artifact|deploy-pages|notify\.mjs|prices\.mjs|compute\.mjs/.test(guard), 'страж ничего не меняет');
    assert.match(update, /^\n {2}update:\n {4}needs: guard\n(?: {4}#.*\n)* {4}if: \$\{\{ !cancelled\(\) && needs\.guard\.outputs\.skip != 'true' \}\}\n/);
    for (const step of ['Снапшот на ветку data', 'Артефакт Pages', 'Публикация Pages', 'Telegram-уведомления (необязательно)', 'Обновление цен', 'Живой контур EDGAR', 'Вычисления и payload'])
      assert.ok(update.includes(`- name: ${step}\n`), `шаг «${step}» — в задаче update`);
    // очередь общая с бэкфилом и расписание — как были
    assert.match(y, /concurrency:\n {2}group: insider-radar-data\n {2}cancel-in-progress: false/);
    assert.match(y, /- cron: "40 3 \* \* 2-6"/);
  });
}

// Правка 1: ночная сборка сервера перекачивает бар D0 всем бумагам дня, бар дня входа — строкам вчерашнего списка, бары бенчмарков — всегда
{
  const mb = await import('./vps/morning-build.mjs');

  await okAsync('пачка 2, правка 1: в ветке data бары дня записаны до закрытия торгов — список сервера всё равно равен полному пересчёту по закрытым барам (цена, оборот, просадка, результаты вчерашних сделок)', async () => {
    const base = join(ROOT, '.selftest-openbar-vps'), full = join(base, 'full'), work = join(base, 'vps'), data = join(work, 'repo');
    rmSync(base, { recursive: true, force: true });
    const days = bizDays('2024-01-02', today), D = days.filter(d => d <= addDaysIso(today, -6)).at(-1), iD = days.indexOf(D), PD = days[iD - 1], TD = days[iD - 2];
    // Закрытый бар D: цена 52, объём 3 млн; тот же бар в середине сессии: цена 51, объём 1 млн. Объёмы через день 3 и 1 млн — медиана
    // оборота за 20 баров зависит от бара D (как у BLX 17.11.2026: $10,3 млн по недозакрытому бару против $12,1 млн). Два месяца
    // назад бумага стоила 60 — от этого максимума считается просадка на день сделки (у бумаги дня сделка в день подачи).
    const ser = (closed, upTo = today) => days.filter(d => d <= upTo).map((d, i) => (d === D
      ? [d, closed ? 52 : 51, closed ? 52 : 51, closed ? 3e6 : 1e6] : [d, i <= iD - 40 ? 60 : 50, i <= iD - 40 ? 60 : 50, (iD - i) % 2 === 0 ? 3e6 : 1e6]));
    const bench = (closed, upTo = today) => days.filter(d => d <= upTo).map(d => [d, d === D ? (closed ? 101 : 100.4) : 100, d === D ? (closed ? 101 : 100.4) : 100, 1e6]);
    const overOf = closed => ({ DAYA: { [D]: [50.5, closed ? 52 : 51] }, PRVA: { [D]: [50.5, closed ? 52 : 51] }, IWM: { [D]: [100, closed ? 101 : 100.4] }, SPY: { [D]: [100, closed ? 101 : 100.4] } });
    const seriesOf = (sym, closed, upTo) => (sym === 'IWM' || sym === 'SPY' ? bench(closed, upTo) : ser(closed, upTo));
    const gotOf = (closed, upTo) => new Map(['SPY', 'IWM', 'DAYA', 'PRVA'].map(sym => [sym, parseYahooChart(chartOf(seriesOf(sym, closed, upTo), overOf(closed)[sym]))]));
    const seed = (dirTo, closed, upTo) => {
      mkdirSync(join(dirTo, 'state'), { recursive: true });
      writeJson(join(dirTo, 'reference', 'tickers.json'), { 444: { ticker: 'DAYA', exchange: 'NYSE', name: 'Day A Corp' }, 445: { ticker: 'PRVA', exchange: 'NYSE', name: 'Prev A Corp' } });
      writeJsonGz(join(dirTo, 'trades', 'live.json.gz'), { v: SHARD_VERSION, amend: [], trades: [
        T({ acc: 'OV1', cik: 444, t: 'DAYA', fdate: D, tdate: D, owners: ceo, code: 'P', sh: 5000, px: 51, val: 255000, own: 1e5 }),
        T({ acc: 'OV2', cik: 445, t: 'PRVA', fdate: PD, tdate: TD, owners: ceo, code: 'P', sh: 5000, px: 50, val: 250000, own: 1e5 }),
      ] });
      writeJson(join(dirTo, 'state', 'live.json'), { schema: SHARD_VERSION, lastDay: D, coverage: { [D]: { status: 'complete', indexed: 1, collected: 1, pending: 0, at: 'x' } } });
      applyBars(dirTo, gotOf(closed, upTo), { opensNeeds: { PRVA: [PD], DAYA: [D] }, updated: upTo });
    };
    const compute = (dataDir, site, extra = []) => execFileSync(process.execPath, [join(ROOT, 'scripts', 'compute.mjs'), '--data', dataDir, '--site', site, '--only-morning', ...extra], { stdio: 'pipe' });
    const dayOf = (m, date) => m.days.find(d => d.date === date);
    const rowOf = (m, date, t) => dayOf(m, date).rows.find(r => r.t === t);
    const LISTK = ['val', 'mx', 'n', 'score', 'main', 'dv', 'px', 'dd', 'cost', 'tags'], RESK = ['o', 'c', 'r', 'b', 'bs', 'ex', 'exS', 'skip'];
    try {
      seed(full, true, today);                                   // полный пересчёт: все бары закрытые
      compute(full, join(base, 'site-full'));
      const ref = readJson(join(base, 'site-full', 'data', 'morning.json'));
      seed(data, false, D);                                      // копия сервера в 22:03: ветку data последним писал прогон GitHub в торговые часы
      const planFile = join(base, 'plan-stale.json');
      compute(data, join(base, 'site-stale'), ['--plan', planFile]);
      const stale = readJson(join(base, 'site-stale', 'data', 'morning.json'));
      // без перекачки сервер считал бы по недозакрытым барам — это и была находка ночи 17→18.11.2026
      const a = rowOf(ref, D, 'DAYA'), b = rowOf(stale, D, 'DAYA');
      assert.deepEqual([a.px, a.dv, b.px, b.dv], [52, 100000000, 51, 50500000], 'цена и оборот по закрытому и по недозакрытому бару');
      assert.notEqual(a.dd, b.dd, 'просадка от максимума тоже другая');
      assert.deepEqual([rowOf(ref, PD, 'PRVA').c, rowOf(stale, PD, 'PRVA').c], [52, 51], 'закрытие дня входа вчерашней сделки');
      assert.notEqual(rowOf(ref, PD, 'PRVA').ex, rowOf(stale, PD, 'PRVA').ex);
      // план: бар D0 у бумаги дня есть, поэтому в bars её нет, но она стоит в fresh.bars; строка вчерашнего дня — в fresh.opens
      const plan = readJson(planFile);
      assert.deepEqual([plan.d0, plan.bars, plan.opens], [D, {}, {}]);
      assert.deepEqual(plan.fresh, { bars: ['DAYA'], opens: { PRVA: [PD] } });
      // сборка сервера: воркер отдаёт закрытые бары
      const closedCharts = Object.fromEntries(['SPY', 'IWM', 'DAYA', 'PRVA'].map(sym => [sym, from => chartOf(seriesOf(sym, true, today).filter(r => r[0] >= from), overOf(true)[sym])]));
      const api = await fakeWorker({ charts: closedCharts });
      try {
        const code = await morningMain(['--state', work, '--data', data, '--site', join(work, 'site'), '--date', D, '--no-sync', '--no-live', '--no-index-check', '--no-feed', '--once', '--interval', '1'], { PAPER_URL: api.base, PAPER_TOKEN: 'tok' });
        assert.equal(code, 0);
        const asked = sym => api.calls.bars.filter(x => x.sym === sym).map(x => x.from).sort()[0];
        for (const sym of ['SPY', 'IWM', 'DAYA', 'PRVA']) assert.ok(asked(sym) && asked(sym) <= addDaysIso(D, -3), `${sym}: бар D0 перекачан с перекрытием (запрос с ${asked(sym)})`);
        assert.deepEqual(readPriceCache(data, 'DAYA').find(r => r[0] === D), [D, 52, 52, 3e6], 'в копии данных бар D0 теперь закрытый');
        const sent = JSON.parse(api.calls.morningPuts[0]);
        assert.equal(sent.listFor, D);
        for (const k of LISTK) assert.deepEqual(rowOf(sent, D, 'DAYA')[k], a[k], `список дня, поле ${k}: сервер = полный пересчёт`);
        for (const k of [...LISTK, ...RESK]) assert.deepEqual(rowOf(sent, PD, 'PRVA')[k], rowOf(ref, PD, 'PRVA')[k], `вчерашний список, поле ${k}: сервер = полный пересчёт`);
        assert.deepEqual(sent.health, ref.health, 'здоровье сигнала считается по тем же результатам');
      } finally { await api.close(); }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  await okAsync('пачка 2, правка 1: источник цен не ответил — до последней попытки сборка ждёт, на последней идёт с барами из ветки data и пишет об этом; уже перекачанное повторно не просит', async () => {
    const base = join(ROOT, '.selftest-openbar-vps2'), work = join(base, 'vps'), data = join(work, 'repo');
    rmSync(base, { recursive: true, force: true });
    const days = bizDays('2024-01-02', today), D = days.filter(d => d <= addDaysIso(today, -6)).at(-1), PD = days[days.indexOf(D) - 1];
    const flat = (upTo = D) => days.filter(d => d <= upTo).map(d => [d, 100, 100, 1e6]);
    const got = new Map(['SPY', 'IWM', 'DAYA'].map(sym => [sym, parseYahooChart(chartOf(flat()))]));
    mkdirSync(join(data, 'state'), { recursive: true });
    writeJson(join(data, 'reference', 'tickers.json'), { 444: { ticker: 'DAYA', exchange: 'NYSE', name: 'Day A Corp' } });
    writeJsonGz(join(data, 'trades', 'live.json.gz'), { v: SHARD_VERSION, amend: [], trades: [T({ acc: 'OV3', cik: 444, t: 'DAYA', fdate: D, tdate: PD, owners: ceo, code: 'P', sh: 5000, px: 100, val: 500000, own: 1e5 })] });
    writeJson(join(data, 'state', 'live.json'), { schema: SHARD_VERSION, lastDay: D, coverage: { [D]: { status: 'complete', indexed: 1, collected: 1, pending: 0, at: 'x' } } });
    applyBars(data, got, { updated: D });
    const chart = from => chartOf(flat(today).filter(r => r[0] >= from));
    const opts = api => mb.parseArgs(['--state', work, '--data', data, '--site', join(work, 'site'), '--date', D, '--no-sync', '--no-live', '--no-index-check', '--no-feed', '--dry-run', '--interval', '1'], { PAPER_URL: api.base, PAPER_TOKEN: 'tok' });
    const lines = [], orig = console.log;
    console.log = (...x) => { lines.push(x.join(' ')); };
    let api = await fakeWorker({ charts: {} });                                     // воркер на месте, источник цен не отдаёт ничего
    try {
      mkdirSync(work, { recursive: true });
      // не последняя попытка: бенчмарки не перекачаны — повтор, хотя бары за D в копии есть
      let r = await mb.attempt(opts(api), D, { stage: {}, lastChance: false, summary: null });
      assert.equal(r.ok, false); assert.match(r.why, /бары бенчмарков не получены/);
      // последняя попытка: идём с тем, что есть, и говорим об этом; список собран
      const ctx = { stage: {}, lastChance: true, summary: null };
      r = await mb.attempt(opts(api), D, ctx);
      assert.equal(r.ok, true, r.why);
      assert.ok(lines.some(l => /последняя попытка, идём как есть\): бары бенчмарков не получены/.test(l)), 'предупреждение о бенчмарках');
      assert.ok(lines.some(l => /бар не перекачан у 1 бумаг \(DAYA\)/.test(l)), 'предупреждение о бумаге дня');
      assert.equal(ctx.summary.rows, 1);
      await api.close();
      // источник отвечает: вторая попытка того же запуска не просит заново то, что уже перекачано
      api = await fakeWorker({ charts: { SPY: chart, IWM: chart, DAYA: chart } });
      const ctx2 = { stage: {}, lastChance: false, summary: null };
      r = await mb.attempt(opts(api), D, ctx2);
      assert.equal(r.ok, true, r.why);
      assert.deepEqual([...ctx2.refreshed], ['DAYA']);
      const fetched = () => lines.filter(l => /докачка баров \(проход 1\)/.test(l)).at(-1);
      assert.match(fetched(), /, 1 — перекачка бара, уже лежащего в данных\)/);
      ctx2.stage.bars = false; ctx2.stage.built = false;                              // как при повторе после сбоя позднего шага
      r = await mb.attempt(opts(api), D, ctx2);
      assert.equal(r.ok, true, r.why);
      assert.match(fetched(), /, 0 — перекачка бара, уже лежащего в данных\)/, 'перекачка бара D0 — один раз за запуск');
    } finally { console.log = orig; await api.close(); rmSync(base, { recursive: true, force: true }); }
  });
}

// Ответ источника цен не укорачивает ряд (20.11.2026). Ночь 19→20.11: ветку data последним писал прогон GitHub после закрытия торгов
// (бары 19.11 закрытые), а Yahoo в 22:04–22:42 по Нью-Йорку у ~30 бумаг отдавал ряд без бара 19.11. Перекачка пачки 2 (сервер) и полная
// замена ряда (ежедневный прогон GitHub) стирали этот бар: у сервера «без цены на D0» стало 34 бумаги вместо 5, IRTC и MTDR выпали из обоих
// ночных списков, утром бот получил «позднюю цену» и купил ARR вместо IRTC.
{
  await okAsync('ряд не укорачивается: источник отдал ряд без бара D0, а в ветке data он закрытый — список сервера равен полному пересчёту, в журнале названа бумага', async () => {
    const base = join(ROOT, '.selftest-tail-vps'), full = join(base, 'full'), work = join(base, 'vps'), data = join(work, 'repo');
    rmSync(base, { recursive: true, force: true });
    const days = bizDays('2024-01-02', today), D = days.filter(d => d <= addDaysIso(today, -6)).at(-1), iD = days.indexOf(D), PD = days[iD - 1];
    // Две бумаги дня с одинаковым рядом: два месяца назад 60, потом 50, объёмы через день 3 и 1 млн; бар D закрытый — 52 и 3 млн
    const ser = upTo => days.filter(d => d <= upTo).map((d, i) => (d === D ? [d, 52, 52, 3e6] : [d, i <= iD - 40 ? 60 : 50, i <= iD - 40 ? 60 : 50, (iD - i) % 2 === 0 ? 3e6 : 1e6]));
    const bench = upTo => days.filter(d => d <= upTo).map(d => [d, d === D ? 101 : 100, d === D ? 101 : 100, 1e6]);
    const SYMS = ['SPY', 'IWM', 'CUTA', 'FULB'];
    const seriesOf = (sym, upTo) => (sym === 'SPY' || sym === 'IWM' ? bench(upTo) : ser(upTo));
    const seed = dirTo => {
      mkdirSync(join(dirTo, 'state'), { recursive: true });
      writeJson(join(dirTo, 'reference', 'tickers.json'), { 451: { ticker: 'CUTA', exchange: 'NYSE', name: 'Cut A Corp' }, 452: { ticker: 'FULB', exchange: 'NYSE', name: 'Full B Corp' } });
      writeJsonGz(join(dirTo, 'trades', 'live.json.gz'), { v: SHARD_VERSION, amend: [], trades: [
        T({ acc: 'TL1', cik: 451, t: 'CUTA', fdate: D, tdate: D, owners: ceo, code: 'P', sh: 5000, px: 51, val: 255000, own: 1e5 }),
        T({ acc: 'TL2', cik: 452, t: 'FULB', fdate: D, tdate: D, owners: ceo, code: 'P', sh: 5000, px: 51, val: 255000, own: 1e5 }),
      ] });
      writeJson(join(dirTo, 'state', 'live.json'), { schema: SHARD_VERSION, lastDay: D, coverage: { [D]: { status: 'complete', indexed: 2, collected: 2, pending: 0, at: 'x' } } });
      // копия ветки data в 22:03: бары D уже лежат, их записал прогон GitHub после закрытия
      applyBars(dirTo, new Map(SYMS.map(sym => [sym, parseYahooChart(chartOf(seriesOf(sym, D)))])), { updated: D });
    };
    const rowOf = (m, t) => m.days.find(d => d.date === D)?.rows.find(r => r.t === t);
    const LISTK = ['val', 'mx', 'n', 'score', 'main', 'dv', 'px', 'dd', 'cost', 'tags'];
    try {
      seed(full);
      execFileSync(process.execPath, [join(ROOT, 'scripts', 'compute.mjs'), '--data', full, '--site', join(base, 'site-full'), '--only-morning'], { stdio: 'pipe' });
      const ref = readJson(join(base, 'site-full', 'data', 'morning.json'));
      assert.deepEqual([rowOf(ref, 'CUTA')?.px, rowOf(ref, 'FULB')?.px], [52, 52], 'эталон: у обеих бумаг цена D0');
      seed(data);
      // источник цен в 22:04: у CUTA ряд без бара D (как у IRTC и MTDR 19.11), остальным — полный
      const charts = Object.fromEntries(SYMS.map(sym => [sym, from => chartOf(seriesOf(sym, sym === 'CUTA' ? PD : D).filter(r => r[0] >= from))]));
      const api = await fakeWorker({ charts });
      const lines = [], orig = console.log;
      console.log = (...x) => { lines.push(x.join(' ')); };
      try {
        const code = await morningMain(['--state', work, '--data', data, '--site', join(work, 'site'), '--date', D, '--no-sync', '--no-live', '--no-index-check', '--no-feed', '--once', '--interval', '1'], { PAPER_URL: api.base, PAPER_TOKEN: 'tok' });
        assert.equal(code, 0);
        assert.ok(api.calls.bars.some(x => x.sym === 'CUTA'), 'бар D у CUTA перекачивался');
        assert.deepEqual(readPriceCache(data, 'CUTA').at(-1), [D, 52, 52, 3e6], 'бар D из ветки data не стёрт');
        const sent = JSON.parse(api.calls.morningPuts[0]), day = sent.days.find(d => d.date === D);
        assert.ok(!(day.unpriced ?? []).includes('CUTA'), 'CUTA не «без цены на D0»');
        for (const t of ['CUTA', 'FULB']) for (const k of LISTK) assert.deepEqual(rowOf(sent, t)?.[k], rowOf(ref, t)[k], `${t}, поле ${k}: сервер = полный пересчёт`);
        assert.ok(lines.some(l => /ответ источника кончается раньше данных у 1 бумаг \(CUTA\)/.test(l)), 'в журнале названа бумага, у которой бар оставлен из ветки data');
        // перекачанной CUTA не считается: повтор попытки того же запуска просит её снова, FULB — нет
        const mb = await import('./vps/morning-build.mjs');
        mkdirSync(join(base, 'vps2'), { recursive: true });
        const opts = mb.parseArgs(['--state', join(base, 'vps2'), '--data', data, '--site', join(base, 'site2'), '--date', D, '--no-sync', '--no-live', '--no-index-check', '--no-feed', '--dry-run', '--interval', '1'], { PAPER_URL: api.base, PAPER_TOKEN: 'tok' });
        const ctx = { stage: {}, lastChance: false, summary: null };
        let r = await mb.attempt(opts, D, ctx);
        assert.equal(r.ok, true, r.why); assert.deepEqual([...ctx.refreshed], ['FULB']);
        ctx.stage.bars = false; ctx.stage.built = false;
        r = await mb.attempt(opts, D, ctx);
        assert.equal(r.ok, true, r.why);
        assert.match(lines.filter(l => /докачка баров \(проход 1\)/.test(l)).at(-1), /, 1 — перекачка бара, уже лежащего в данных\)/, 'повтор просит только CUTA');
        assert.equal(readJson(join(base, 'site2', 'data', 'morning.json')).days.find(d => d.date === D).rows.find(x => x.t === 'CUTA')?.px, 52);
      } finally { console.log = orig; await api.close(); }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // Прогон prices.mjs целиком, как в правке 2 пачки 2: источник цен и справочник SEC подставные, часы — --now
  await okAsync('ряд не укорачивается: ежедневный прогон цен — ответ без бара дня не стирает бар, записанный после закрытия; полный ответ замещает его, как раньше', async () => {
    const base = join(ROOT, '.selftest-tail-prices');
    rmSync(base, { recursive: true, force: true }); mkdirSync(base, { recursive: true });
    const stub = join(base, 'stub.mjs');
    writeFileSync(stub, [
      "import { readFileSync } from 'node:fs';",
      "const fx = () => JSON.parse(readFileSync(process.env.STUB_FIXTURE, 'utf8'));",
      "const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });",
      'globalThis.fetch = async url => {',
      '  const u = new URL(String(url)), f = fx();',
      "  if (u.hostname === 'www.sec.gov') return json(f.tickers);",
      "  const m = u.pathname.startsWith('/v8/finance/chart/') ? decodeURIComponent(u.pathname.slice('/v8/finance/chart/'.length)) : null;",
      "  return m && f.charts[m] ? json(f.charts[m]) : new Response('', { status: 404 });",
      '};',
    ].join('\n') + '\n');
    const run = (L, now, fixture) => {
      const fx = join(base, 'fixture.json');
      writeJson(fx, fixture);
      return new Promise(resolve => execFile(process.execPath, ['--import', pathToFileURL(stub).href, join(ROOT, 'scripts', 'prices.mjs'), '--mode', 'daily', '--data', L, '--now', now],
        { encoding: 'utf8', env: { ...process.env, POLITE_BACKOFF_MS: '2', STUB_FIXTURE: fx } }, (err, so, se) => resolve({ code: err ? (err.code ?? 1) : 0, out: so + se })));
    };
    const tickers = { fields: ['cik', 'name', 'ticker', 'exchange'], data: [[1, 'AAA Inc', 'AAA', 'NYSE']] };
    const D = '2026-11-18', P = '2026-11-17', L = join(base, 'data');
    const days = bizDays('2026-08-03', D).filter(d => !isMarketClosed(d));
    const ser = (upTo, vol = 1e6) => days.filter(d => d <= upTo).map((d, i) => (d === D ? [d, 105, 105, vol] : [d, 100 + (i % 7) * 0.5, 100 + (i % 7) * 0.5, 1e6]));
    const charts = (aaaUpTo, vol) => ({ SPY: chartOf(ser(D)), IWM: chartOf(ser(D)), AAA: chartOf(ser(aaaUpTo, vol)) });
    writeJsonGz(join(L, 'trades', 'live.json.gz'), { v: SHARD_VERSION, amend: [], trades: [T({ acc: 'TP1', cik: 1, t: 'AAA', fdate: P, tdate: P, owners: ceo, code: 'P', sh: 1000, px: 100, val: 1e5, own: 1e5 })] });
    const last = () => readPriceCache(L, 'AAA').at(-1);
    try {
      // 18:49 — прогон от слияния в main после закрытия: бар дня записан
      let r = await run(L, `${D}T18:49:00-05:00`, { tickers, charts: charts(D, 795224) });
      assert.equal(r.code, 0, r.out); assert.deepEqual(last(), [D, 105, 105, 795224]);
      // 22:30 — ночной прогон: источник отдаёт ряд без бара дня; бар остаётся, в журнале — строка о сохранённом хвосте
      r = await run(L, `${D}T22:30:00-05:00`, { tickers, charts: charts(P) });
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(last(), [D, 105, 105, 795224], 'ответ без бара дня его не стёр');
      assert.match(r.out, /ответ кончался раньше кэша у 1 рядов \(AAA\)/);
      // утро следующего дня: источник снова отдаёт бар дня (с окончательным объёмом) — он замещает сохранённый, как раньше
      r = await run(L, '2026-11-19T07:10:00-05:00', { tickers, charts: charts(D, 801000) });
      assert.equal(r.code, 0, r.out); assert.deepEqual(last(), [D, 105, 105, 801000], 'полный ответ замещает бар дня');
      assert.ok(!/ответ кончался раньше кэша/.test(r.out));
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}

// Правка 5: вердикт «иностранный эмитент по отчётам» — только при отчёте 20-F/40-F/6-K не старше 270 дней до дня подачи строки (lib/fpi.mjs)
{
  const fpi = await import('./lib/fpi.mjs');
  const quarters = [];
  for (let y = 2016; y <= 2026; y++) for (let q = 1; q <= 4; q++) if (`${y}q${q}` <= '2026q3') quarters.push(`${y}q${q}`);

  ok('пачка 2, правка 5: отчёт свежий, если он не старше 270 дней до дня подачи строки; граница — включительно', () => {
    assert.equal(fpi.FPI.formsFreshDays, 270);
    assert.equal(fpi.reportFresh('2026-02-21', '2026-11-18'), true, 'ровно 270 дней');
    assert.equal(fpi.reportFresh('2026-02-20', '2026-11-18'), false, '271 день');
    assert.equal(fpi.reportFresh('2026-11-17', '2026-11-18'), true);
    assert.equal(fpi.reportFresh('2026-12-01', '2026-11-18'), true, 'отчёт позже дня подачи: в справочнике только последний, эмитент отчёты подаёт');
    for (const none of [undefined, null, '']) assert.equal(fpi.reportFresh(none, '2026-11-18'), false, 'даты отчёта нет');
    assert.equal(fpi.reportFresh('2020-01-01', null), true, 'дня подачи нет — сравнивать не с чем');
    assert.equal(fpi.reportFresh('2026-02-20', '2026-11-18', { ...fpi.FPI, formsFreshDays: 365 }), true, 'порог — параметр');
  });

  ok('пачка 2, правка 5: ушедшие из статуса иностранного эмитента не помечаются, Dole остаётся по давнему листингу, настоящие иностранные — как раньше', () => {
    // первая форма и последний отчёт — с боевых справочников 18.11.2026 (review2/STAGE2-FPI-NIGHT.md, раздел 2)
    const first = new Map([[1, '2026-01-02'], [2, '2026-01-09'], [3, '2026-01-16'], [4, '2025-12-31'], [5, '2026-01-02'], [6, '2026-03-18'], [7, '2026-03-12'], [8, '2026-02-19'], [9, '2016-01-05']]);
    const forms = new Map([[1, '2025-11-06'], [2, '2025-11-20'], [3, '2025-11-26'], [4, '2025-12-29'], [5, '2026-01-07'], [6, '2025-12-17'], [7, '2026-11-12'], [8, '2026-11-04'], [9, '2026-11-10']]);
    const refs = { first, forms, formsAsOf: '2026-11-17', warn: [] };
    const sym = ['', 'SN', 'FOCL', 'QUCY', 'DGXX', 'ONCY', 'DOLE', 'PAM', 'SKM', 'OLDF'];
    const ranges = Object.fromEntries(sym.slice(1).map(t => [t, [[1, '2010-01-04', '2026-11-17']]]));
    const v = (cik, fdate, bar0 = '2014-01-02') => fpi.fpiVerdict({ cik, ticker: sym[cik], fdate, bar0 }, refs, { ranges, before: new Map() });
    for (const cik of [1, 2, 3, 4, 5]) assert.equal(v(cik, '2026-11-18'), null, `${sym[cik]}: отчёт давний, первая форма до принятия правил — не помечается`);
    assert.equal(v(6, '2026-11-04'), 'listed', 'Dole: отчёт 17.12.2025 давний, первая форма 18.03.2026 и листинг давний — помечается по листингу');
    assert.equal(v(6, '2026-10-22'), 'listed'); assert.equal(v(6, '2026-06-01'), 'forms', 'Dole в июне: отчёту меньше 270 дней — по отчётам');
    assert.equal(v(6, '2026-11-04', null), null, 'Dole без ряда цен и с давним отчётом: давность листинга не доказана');
    assert.equal(v(7, '2026-11-18'), 'forms', 'Pampa: свежий отчёт'); assert.equal(v(8, '2026-11-18'), 'forms', 'ранняя подача после подписания закона, свежий отчёт');
    assert.equal(v(9, '2026-11-18'), null, 'формы были до закона — в измеренной выборке, как раньше');
    // день сравнения — день подачи строки: у Oncolytics последний отчёт 07.01.2026, строка от 01.10.2026 ещё помечается, от 05.10.2026 — уже нет
    assert.equal(v(5, '2026-10-04'), 'forms'); assert.equal(v(5, '2026-10-05'), null);
    // прежнее правило (без срока) пометило бы всех пятерых: порог «бесконечность» возвращает старое поведение
    for (const cik of [1, 2, 3, 4, 5]) assert.equal(fpi.fpiVerdict({ cik, ticker: sym[cik], fdate: '2026-11-18', bar0: '2014-01-02' }, refs, { ranges, before: new Map() }, { ...fpi.FPI, formsFreshDays: 1e5 }), 'forms');
    // чтение справочника: эмитент -> дата последнего отчёта; запись без даты не считается свежим отчётом
    const L = join(TMP, 'fpi-fresh');
    writeJson(fpi.firstFormPath(L), { v: 1, quarters, first: { 1: '2026-01-02' } });
    writeJson(fpi.fpiFormsPath(L), { v: 1, asOf: '2026-11-17', filled: ['x'], fillDone: true, ciks: { 1: '2025-11-06', 7: '2026-11-12', 10: true } });
    const r = fpi.loadFpiRefs(L);
    assert.deepEqual([...r.forms], [[1, '2025-11-06'], [7, '2026-11-12'], [10, '']]); assert.equal(r.forms.size, 3); assert.deepEqual(r.warn, []);
    assert.equal(fpi.fpiVerdict({ cik: 10, ticker: 'NOPE', fdate: '2026-11-18', bar0: null }, r, {}), null);
    assert.equal(fpi.fpiStaleWarning(r, '2026-11-18'), null, 'проверка отставания справочника работает по-прежнему');
  });

  ok('пачка 2, правка 5: сборка — полная и «как на сервере» ставят пометку одинаково; давний отчёт пометки не даёт, свежий даёт, день сравнения — день подачи строки', () => {
    const P = join(ROOT, '.selftest-fpifresh');
    rmSync(P, { recursive: true, force: true });
    mkdirSync(join(P, 'state'), { recursive: true });
    const biz = bizDays('2024-01-02', addDaysIso(today, -6)), FB = biz.at(-1), FA = biz.filter(d => d <= addDaysIso(FB, -40)).at(-1);
    const tk = { 801: 'SNA', 802: 'FRSH', 803: 'EDGE', 804: 'EDGO', 805: 'DOLA', 806: 'TWOD' };
    for (const b of ['SPY', 'IWM']) writePriceCache(P, b, bizDays('2023-01-02', today).map(d => [d, 100, 100, 1e6]));
    for (const t of Object.values(tk)) writePriceCache(P, t, bizDays('2024-01-02', today).map(d => [d, 20, 20, 1e6]));
    writeJson(join(P, 'reference', 'tickers.json'), Object.fromEntries(Object.entries(tk).map(([cik, t]) => [cik, { ticker: t, exchange: 'NYSE', name: t + ' plc' }])));
    writeJsonGz(join(P, 'reference', 'symbol-ranges.json.gz'), Object.fromEntries(Object.values(tk).map(t => [t, [[1, '2010-01-04', today]]])));
    const buy = (cik, fdate, i) => T({ acc: `R${cik}${i}`, cik, t: tk[cik], fdate, tdate: addDaysIso(fdate, -1), owners: ceo, code: 'P', sh: 7500, px: 20, val: 150000, own: 1e5 });
    writeJsonGz(join(P, 'trades', 'live.json.gz'), { v: SHARD_VERSION, amend: [], trades: [...Object.keys(tk).map(c => buy(Number(c), FB, 0)), buy(806, FA, 1)] });
    // первая форма у всех — после подписания закона; у DOLA — после принятия правил (как у Dole), у остальных — до (как у SharkNinja)
    writeJson(fpi.firstFormPath(P), { v: 1, quarters, first: { 801: '2026-01-02', 802: '2026-01-09', 803: '2026-01-09', 804: '2026-01-09', 805: '2026-03-18', 806: '2026-01-09' } });
    writeJson(fpi.fpiFormsPath(P), { v: 1, asOf: today, filled: ['x'], fillDone: true,
      ciks: { 801: addDaysIso(FB, -300), 802: addDaysIso(FB, -200), 803: addDaysIso(FB, -270), 804: addDaysIso(FB, -271), 805: addDaysIso(FB, -330), 806: addDaysIso(FB, -300) } });
    const run = (site, extra) => execFileSync(process.execPath, [join(ROOT, 'scripts', 'compute.mjs'), '--data', P, '--site', join(P, site), '--counter-from', addDaysIso(today, -30), '--fpi-from', FA, ...extra], { stdio: 'pipe' });
    const read = site => { const m = readJson(join(P, site, 'data', 'morning.json')); return day => Object.fromEntries(m.days.find(d => d.date === day).rows.map(r => [r.t, [r.fpi ?? null, r.main]])); };
    try {
      run('full', []); run('lean', ['--only-morning', '--builder', 'vps']);
      const full = read('full'), lean = read('lean');
      assert.deepEqual(full(FB), {
        SNA: [null, true],          // отчёту 300 дней — ушёл из статуса иностранного эмитента: в основном списке
        FRSH: [true, false],        // отчёту 200 дней — иностранный эмитент
        EDGE: [true, false],        // ровно 270 дней — ещё свежий
        EDGO: [null, true],         // 271 день
        DOLA: [true, false],        // отчёт давний, но первая форма после принятия правил и листинг давний — по листингу
        TWOD: [null, true],         // на день FB отчёту 300 дней
      });
      assert.deepEqual(full(FA), { TWOD: [true, false] }, 'та же компания 40 днями раньше: отчёту было 260 дней — строка того дня помечена');
      assert.deepEqual(lean(FB), full(FB), 'сборка на сервере = полная'); assert.deepEqual(lean(FA), full(FA));
    } finally { rmSync(P, { recursive: true, force: true }); }
  });
}

// Правка 1, доводка по независимому ревью: даты открытий объединяются; отказ воркера по лимиту не оставляет бумаги без перекачки молча
{
  const mb = await import('./vps/morning-build.mjs');

  ok('пачка 2, правка 1 (ревью): бумага и во вчерашнем списке, и в раннем дне без открытия — даты подач объединяются, перекачка дня входа не теряется', () => {
    assert.deepEqual(mb.unionNeeds({ X: ['2026-11-16'], Y: ['2026-11-16'] }, { X: ['2026-11-10'], Z: ['2026-11-12'] }),
      { X: ['2026-11-10', '2026-11-16'], Y: ['2026-11-16'], Z: ['2026-11-12'] });
    assert.deepEqual(mb.unionNeeds({ X: ['2026-11-16'] }, { X: ['2026-11-16'] }), { X: ['2026-11-16'] });
    assert.deepEqual(mb.unionNeeds(), {}); assert.deepEqual(mb.unionNeeds({ X: ['2026-11-16'] }), { X: ['2026-11-16'] });
    // запись открытия дня входа для обеих дат подачи: без объединения вторая не перезаписывалась бы
    const ohlc = [['2026-11-10', 10, 10], ['2026-11-11', 11, 11.5], ['2026-11-16', 12, 12], ['2026-11-17', 13, 13.5]];
    assert.deepEqual(Object.keys(pickOpens(ohlc, mb.unionNeeds({ X: ['2026-11-16'] }, { X: ['2026-11-10'] }).X)).sort(), ['2026-11-11', '2026-11-17']);
  });

  await okAsync('пачка 2, правка 1 (ревью): воркер ответил лимитом и не дошёл до части бумаг — повтор, на последней попытке — список с предупреждением; повтор просит только остаток', async () => {
    const base = join(ROOT, '.selftest-openbar-limit'), work = join(base, 'vps'), data = join(work, 'repo');
    rmSync(base, { recursive: true, force: true });
    const days = bizDays('2024-01-02', today), D = days.filter(d => d <= addDaysIso(today, -6)).at(-1), PD = days[days.indexOf(D) - 1];
    const syms = Array.from({ length: 25 }, (_, i) => `L${String(i + 1).padStart(2, '0')}A`);
    const flat = (upTo = D) => days.filter(d => d <= upTo).map(d => [d, 100, 100, 1e6]);
    mkdirSync(join(data, 'state'), { recursive: true });
    writeJson(join(data, 'reference', 'tickers.json'), Object.fromEntries(syms.map((t, i) => [600 + i, { ticker: t, exchange: 'NYSE', name: t + ' Corp' }])));
    writeJsonGz(join(data, 'trades', 'live.json.gz'), { v: SHARD_VERSION, amend: [],
      trades: syms.map((t, i) => T({ acc: 'LM' + i, cik: 600 + i, t, fdate: D, tdate: PD, owners: ceo, code: 'P', sh: 5000, px: 100, val: 500000, own: 1e5 })) });
    writeJson(join(data, 'state', 'live.json'), { schema: SHARD_VERSION, lastDay: D, coverage: { [D]: { status: 'complete', indexed: 25, collected: 25, pending: 0, at: 'x' } } });
    applyBars(data, new Map(['SPY', 'IWM', ...syms].map(sym => [sym, parseYahooChart(chartOf(flat()))])), { updated: D });
    // воркер: бенчмарки отдаёт всегда; в режиме лимита на первую пачку бумаг отвечает и ставит limited — до остальных сборка не доходит
    let limit = true;
    const calls = [];
    const srv = createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname !== '/bars') return send(404, {});
      const parts = (u.searchParams.get('symbols') ?? '').split(',').map(p => p.split(':'));
      calls.push(parts.map(p => p[0]));
      const bars = Object.fromEntries(parts.map(([sym, from]) => [sym, chartOf(flat(today).filter(r => r[0] >= from))]));
      send(200, { ok: true, bars, failed: {}, limited: limit && !parts.some(p => p[0] === 'SPY') });
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const opts = mb.parseArgs(['--state', work, '--data', data, '--site', join(work, 'site'), '--date', D, '--no-sync', '--no-live', '--no-index-check', '--no-feed', '--dry-run', '--interval', '1'],
      { PAPER_URL: `http://127.0.0.1:${srv.address().port}`, PAPER_TOKEN: 'tok' });
    const lines = [], orig = console.log;
    console.log = (...x) => { lines.push(x.join(' ')); };
    const fetched = () => lines.filter(l => /докачка баров \(проход 1\)/.test(l)).at(-1);
    try {
      mkdirSync(work, { recursive: true });
      const ctx = { stage: {}, lastChance: false, summary: null };
      let r = await mb.attempt(opts, D, ctx);
      assert.equal(r.ok, false); assert.match(r.why, /бары не перекачаны \(воркер ответил лимитом\): L21A, L22A, L23A, L24A, L25A/);
      assert.match(fetched(), /, 25 — перекачка бара/); assert.equal(ctx.refreshed.size, 20, 'первая пачка перекачана');
      // следующая попытка того же запуска: воркер отвечает — перекачивается только остаток
      limit = false;
      r = await mb.attempt(opts, D, ctx);
      assert.equal(r.ok, true, r.why); assert.match(fetched(), /, 5 — перекачка бара/); assert.equal(ctx.refreshed.size, 25);
      // последняя попытка при том же лимите: список выходит, в журнале — у каких бумаг бар не перекачан
      limit = true;
      const last = { stage: {}, lastChance: true, summary: null };
      r = await mb.attempt(opts, D, last);
      assert.equal(r.ok, true, r.why); assert.equal(last.summary.rows, 25);
      assert.ok(lines.some(l => /бар не перекачан у 5 бумаг \(L21A, L22A, L23A, L24A, L25A\)/.test(l)), 'предупреждение называет бумаги, до которых воркер не дошёл');
    } finally { console.log = orig; await new Promise(r => srv.close(r)); rmSync(base, { recursive: true, force: true }); }
  });
}

// ==================== КОНТУР B: лента в торговые часы (audit-840-levers-2026-11-17: B-ВНЕДРЕНИЕ.md, раздел 5; B-ПОСЛЕ-АУДИТА-ФОРМ.md, 5.3) ====================
{
  const { acceptedAtSec } = await import('./lib/edgar.mjs');
  const { feedIntervalSec, FEED } = await import('./lib/feed.mjs');
  const ny = w => nyToMs(w);

  ok('контур B: время приёма формы с секундами — рядом с минутным, которое идёт в список', () => {
    const h = '<SEC-HEADER>x\n<ACCEPTANCE-DATETIME>20261120113107\nACCESSION NUMBER: 1\n';
    assert.equal(acceptedAtSec(h), '2026-11-20T11:31:07'); assert.equal(acceptedAt(h), '2026-11-20T11:31', 'минутное поле не изменилось');
    assert.equal(acceptedAtSec('<ACCEPTANCE-DATETIME>20261120256107'), null); assert.equal(acceptedAtSec('<ACCEPTANCE-DATETIME>202611201131'), null);
    assert.equal(acceptedAtSec(''), null); assert.equal(acceptedAtSec(null), null);
  });

  ok('контур B: шаг опроса ленты — 15 секунд в основную сессию, 45 вне её; сокращённый день, выходной, праздник', () => {
    const f = w => feedIntervalSec(ny(w), 45, 15);
    assert.equal(FEED.rthIntervalSec, 15); assert.equal(FEED.intervalSec, 45);
    assert.deepEqual(['2026-11-20T09:29:59', '2026-11-20T09:30:00', '2026-11-20T12:00', '2026-11-20T15:59:59', '2026-11-20T16:00:00', '2026-11-20T06:00', '2026-11-20T21:59'].map(f), [45, 15, 15, 15, 45, 45, 45]);
    assert.deepEqual(['2026-11-27T12:59:59', '2026-11-27T13:00:00', '2026-11-27T15:00'].map(f), [15, 45, 45], 'пятница после Дня благодарения: сессия до 13:00');
    assert.deepEqual(['2026-11-21T12:00', '2026-11-26T12:00', '2026-04-03T12:00'].map(f), [45, 45, 45], 'суббота, День благодарения, Страстная пятница');
    assert.equal(f('2026-07-01T10:00'), 15, 'летнее время');
    assert.equal(feedIntervalSec(ny('2026-11-20T12:00'), 45, 0), 45, '--rth-interval 0 — прежний шаг весь день');
    assert.equal(feedIntervalSec(ny('2026-11-20T12:00'), 30, 60), 30, 'шаг сессии не может быть реже обычного');
    const unit = readFileSync(join(ROOT, 'ops', 'insider840-feed', 'insider840-feed.service'), 'utf8').replace(/\r/g, '');
    assert.match(unit, /--interval 45 --rth-interval 15\n/); assert.match(unit, /\nCPUWeight=400\n/);
  });
}

// ==================== КОНТУР B: сигнал в торговые часы (audit-840-levers-2026-11-17: B-ВНЕДРЕНИЕ.md, B-ПОСЛЕ-АУДИТА-ФОРМ.md) ====================
// Справочник D−1 (compute --intraday-ref, vps/intraday-ref.mjs), расчёт события дня (lib/intraday.mjs), процесс сигналов (vps/signal-watch.mjs).
{
  const it = await import('./lib/intraday.mjs');
  const { SIGNAL, LATENCY, DayState, OwnerGroups, evalEvent, refProblem, refDays, prevMarketDay, inSession, splitLines, latencyStat, acceptedMs, resolveToday } = it;
  const { FEED } = await import('./lib/feed.mjs');
  const { barClosedAtMs } = await import('./lib/session.mjs');
  const ir = await import('./vps/intraday-ref.mjs');
  const ny = w => nyToMs(w);

  ok('контур B: время приёма формы в записи ленты — с секундами, у старых записей минутное', () => {
    assert.equal(acceptedMs({ acs: '2026-11-20T11:31:07' }), Date.parse('2026-11-20T16:31:07Z'));
    assert.equal(acceptedMs({ at: '2026-11-20T11:31' }), Date.parse('2026-11-20T16:31:00Z'), 'у старых записей ленты — минутное время');
    assert.equal(acceptedMs({ trades: [{ at: '2026-07-01T11:31' }] }), Date.parse('2026-07-01T15:31:00Z'), 'летнее время');
    assert.equal(acceptedMs({}), null);
  });

  ok('контур B: день справочника — последний закрытый бар и следующий торговый день (ночь, утро, выходные, праздник, сокращённый день)', () => {
    const rd = w => { const ms = ny(w); return refDays(ms, w.slice(0, 10), barClosedAtMs); };
    assert.deepEqual(rd('2026-11-19T23:52'), { asOf: '2026-11-19', forDay: '2026-11-20' }, 'ночной запуск');
    assert.deepEqual(rd('2026-11-20T07:00'), { asOf: '2026-11-19', forDay: '2026-11-20' }, 'утренний повтор — тот же справочник');
    assert.deepEqual(rd('2026-11-20T23:52'), { asOf: '2026-11-20', forDay: '2026-11-23' }, 'пятница — на понедельник');
    assert.deepEqual(rd('2026-11-25T23:52'), { asOf: '2026-11-25', forDay: '2026-11-27' }, 'канун Дня благодарения — на пятницу');
    assert.deepEqual(rd('2026-11-26T23:52'), { asOf: '2026-11-25', forDay: '2026-11-27' }, 'в праздник — тот же');
    assert.deepEqual(rd('2026-11-27T13:09'), { asOf: '2026-11-25', forDay: '2026-11-27' }, 'сокращённый день: до 13:10 бар не закрыт');
    assert.deepEqual(rd('2026-11-27T13:10'), { asOf: '2026-11-27', forDay: '2026-11-30' });
    assert.deepEqual(rd('2026-11-20T16:09'), { asOf: '2026-11-19', forDay: '2026-11-20' }, 'до 16:10 бар дня не закрыт');
    assert.equal(prevMarketDay('2026-11-23'), '2026-11-20'); assert.equal(prevMarketDay('2026-11-27'), '2026-11-25');
    assert.equal(inSession(ny('2026-11-20T09:30'), '2026-11-20'), true); assert.equal(inSession(ny('2026-11-20T16:00'), '2026-11-20'), false);
    assert.equal(inSession(ny('2026-11-27T13:00'), '2026-11-27'), false); assert.equal(inSession(ny('2026-11-26T12:00'), '2026-11-26'), false);
  });

  // Подставной справочник: AAA — $50, оборот $50 млн, просадка −35%; хвост из 14 баров до 19.11
  const DAY = '2026-11-20', ASOF = '2026-11-19';
  const barDays = bizDays('2026-11-02', ASOF);
  const mkBars = (px, dd = -0.35, dv = 4e7) => barDays.map((d, i) => [d, px, dd, dv, 300 + i]);
  const mkRef = (over = {}) => ({
    v: 1, asOf: ASOF, for: DAY, built: '2026-11-20T04:55:00.000Z', n: 5, fpiWarn: [], months: ['2026-10', '2026-11'],
    tickers: {
      100: { t: 'AAA', name: 'Aaa Inc', px: 50, adv: 5e7, bars: mkBars(50) },
      200: { t: 'FOR', name: 'Foreign Plc', px: 50, adv: 5e7, bars: mkBars(50), fpi: 'forms' },
      300: { t: 'THN', name: 'Thin Co', px: 50, adv: 2.5e7, bars: mkBars(50) },
      400: { t: 'UNI', name: 'Units Sa', px: 50, adv: 5e7, bars: mkBars(50), units: 1 },
      500: { t: 'CHP', name: 'Cheap Co', px: 4.5, adv: 5e7, bars: mkBars(4.5) },
      600: { t: 'FLT', name: 'Flat Co', px: 50, adv: 5e7, bars: mkBars(50, -0.05) },
    },
    lows: {}, routine: { '2026-10': [], '2026-11': [9001] }, regular: {}, groups: {}, recent: {}, ...over,
  });
  const P1 = [{ cik: 9000, name: 'Ivanov Ivan', rel: 'DOC', title: 'CEO' }], P2 = [{ cik: 9002, name: 'Petrov Petr', rel: 'D', title: '' }];
  let accN = 0;
  const row = (o = {}) => { const px = o.px ?? 50, sh = o.sh ?? 3000; return { acc: `ACC-${++accN}`, form: '4', fdate: DAY, tdate: ASOF, cik: 100, t: 'AAA', owners: P1, code: 'P', sh, px, val: Math.round(px * sh), di: 'D', b5: 0, sec: 'Common Stock', fn: {}, at: `${DAY}T11:31`, ...o }; };
  const ev = (rows, ref = mkRef(), cik = rows[0].cik) => { const g = new OwnerGroups(ref); for (const r of rows) g.addFiling(r.owners); return evalEvent(ref, DAY, cik, rows, g); };

  ok('контур B: событие по справочнику D−1 — скор и его слагаемые, цена, оборот и просадка по последнему закрытому бару', () => {
    const r = ev([row()]);
    assert.equal(r.kind, 'sig');
    assert.deepEqual([r.t, r.score, r.pts, r.mx, r.val, r.rows], ['AAA', 3, { v100k: 1, v1m: 0, off: 1, deep: 1 }, 150000, 150000, 1]);
    assert.deepEqual([r.px, r.dv, r.dd, r.asOf, r.role], [50, 5e7, -0.35, ASOF, 'C']);
    assert.deepEqual([r.td, r.fpx, r.same, r.units], [ASOF, 50, false, false]);
    // сделка, датированная днём сигнала: бара этого дня нет — сверяется с последним баром; запись несёт признак для итоговой сверки ботом
    const s = ev([row({ tdate: DAY, px: 51 })]);
    assert.equal(s.kind, 'sig'); assert.deepEqual([s.td, s.fpx, s.same], [DAY, 51, true]);
    // покупка от $1 млн директора в бумаге без просадки: два балла за сумму
    const b = ev([row({ cik: 600, t: 'FLT', owners: P2, sh: 30000 })]);
    assert.deepEqual([b.kind, b.score, b.pts, b.role], ['sig', 2, { v100k: 1, v1m: 1, off: 0, deep: 0 }, 'D']);
    // две строки двух лиц: крупнейшая задаёт балл, офицер — по любой строке, сумма — обе
    const m = ev([row({ owners: P2, sh: 30000 }), row({ sh: 1000 })]);
    assert.deepEqual([m.score, m.mx, m.val, m.rows], [4, 1500000, 1550000, 2]);
  });

  ok('контур B: события, которые сигнала не дают, — нет бумаги в справочнике, иностранный эмитент, оборот, цена, скор', () => {
    assert.deepEqual(ev([row({ cik: 999, t: 'ZZZ' })]), { kind: 'skip', why: 'no_ref_ticker' });
    assert.deepEqual(ev([row({ cik: 200, t: 'FOR' })]), { kind: 'skip', why: 'fpi', score: 3 });
    assert.deepEqual(ev([row({ cik: 300, t: 'THN' })]), { kind: 'skip', why: 'dv', score: 3 }, 'оборот $25 млн: в справочнике есть, порога $30 млн нет');
    assert.deepEqual(ev([row({ cik: 500, t: 'CHP', px: 4.5, sh: 40000 })]), { kind: 'skip', why: 'px' });
    assert.deepEqual(ev([row({ cik: 600, t: 'FLT', owners: P2, sh: 3000 })]), { kind: 'skip', why: 'score', score: 1 });
  });

  ok('контур B: отсевы — те же, что у ночного списка, каждый на своём примере', () => {
    const why = (rows, ref) => { const r = ev(rows, ref); return r.kind === 'skip' ? r.why : `sig ${r.score}`; };
    assert.equal(why([row({ tdate: '2026-10-30' })]), 'gates:late', 'сделка старше 10 рабочих дней');
    assert.equal(why([row({ px: 40 })]), 'gates:discount', 'на 20% ниже закрытия дня сделки, минимумов дня нет');
    assert.equal(why([row({ px: 40 })], mkRef({ lows: { [`AAA|${ASOF}`]: [39.5, 41] } })), 'sig 3', 'цена внутри дневного диапазона — не скидка');
    assert.equal(why([row({ px: 40, t: 'AAA.B' })], mkRef({ lows: { [`AAA|${ASOF}`]: [39.5, 41] } })), 'gates:discount', 'слой минимумов ключуется тикером формы');
    assert.equal(why([row({ px: 70 })]), 'gates:premium', 'цена формы выше рынка в 1,25 раза');
    assert.equal(why([row({ px: 600 })]), 'gates:outlier');
    assert.equal(why([row({ sec: 'Series A Preferred Stock' })]), 'gates:security');
    assert.equal(why([row({ b5: 1 })]), 'gates:planned'); assert.equal(why([row({ fn: { b5: 1 } })]), 'gates:planned');
    assert.equal(why([row({ fn: { offering: 1 } })]), 'gates:offering'); assert.equal(why([row({ fn: { drip: 1 } })]), 'gates:drip');
    assert.equal(why([row({ owners: [{ cik: 9001, name: 'Routine Roman', rel: 'DO', title: 'CFO' }] })]), 'gates:routine', 'рутинный по CMP в месяце сделки');
    assert.equal(why([row({ owners: [{ cik: 9001, name: 'Routine Roman', rel: 'DO', title: 'CFO' }], tdate: '2026-10-30' })]), 'gates:late');
    assert.equal(why([row({ owners: [{ cik: 7000, name: 'Big Capital Partners LP', rel: 'T', title: '' }] })]), 'gates:fund');
    assert.equal(why([row({ sh: 100 })]), 'gates:minval', 'покупка меньше $10 тыс.');
    assert.equal(why([row({ ad: 'D' })]), 'gates:disposed');
    assert.equal(why([row({ sh: 4e9 })]), 'gates:badvalue');
    assert.equal(why([row({ sh: 2e7 })], mkRef({ tickers: { 100: { t: 'AAA', name: 'Aaa', px: 50, adv: 5e7, bars: barDays.map((d, i) => [d, 50, -0.35, 2e6, 300 + i]) } } })), 'gates:capacity', 'сумма в сотни раз больше дневного оборота');
    // признак эмитента «другие единицы»: отсеивается только строка, чья цена не сходится с котировкой
    assert.equal(why([row({ cik: 400, t: 'UNI', px: 60 })]), 'gates:units'); assert.equal(why([row({ cik: 400, t: 'UNI', px: 51 })]), 'sig 3');
    // синхронная подача: та же цена и дата у трёх независимых подателей (двое — во вчерашних формах справочника)
    const prior = [1, 2].map(k => ({ acc: `OLD-${k}`, form: '4', fdate: ASOF, tdate: ASOF, cik: 100, code: 'P', sec: 'Common Stock', sh: 1000, px: 50, orig: null, owners: [{ cik: 8000 + k, name: `Fund ${k} LP` }] }));
    assert.equal(why([row()], mkRef({ recent: { 100: prior } })), 'gates:sync');
    assert.equal(why([row()], mkRef({ recent: { 100: prior }, groups: { 8001: 8002 } })), 'sig 3', 'двое прежних — одна группа: независимых подателей два');
    assert.equal(why([row({ px: 50.01 })], mkRef({ recent: { 100: prior } })), 'sig 3', 'цена другая — не синхронная подача');
    // регулярная серия: три прежние покупки с шагом 30 дней и четвёртая на том же шаге
    const reg = { 9000: { 100: ['2026-08-21', '2026-09-20', '2026-10-20'] } };
    assert.equal(why([row()], mkRef({ regular: reg })), 'gates:regular');
    assert.equal(why([row()], mkRef({ regular: { 9000: { 100: ['2026-08-21', '2026-09-20', '2026-10-20', '2026-10-20'] } } })), 'sig 3', 'две записи одного дня — не расписание');
    assert.equal(why([row()], mkRef({ regular: { 9000: { 777: reg[9000][100] } } })), 'sig 3', 'серия у другого эмитента не в счёт');
    // сделка раньше хвоста ряда, но не поздняя — сверять не с чем
    assert.equal(why([row({ tdate: '2026-11-10' })], mkRef({ tickers: { 100: { t: 'AAA', name: 'Aaa', px: 50, adv: 5e7, bars: mkBars(50).slice(-3) } } })), 'gates:nobar');
    // молодая бумага: до сделки меньше 20 баров; ряд без оборота
    assert.equal(why([row()], mkRef({ tickers: { 100: { t: 'AAA', name: 'Aaa', px: 50, adv: 5e7, bars: barDays.map((d, i) => [d, 50, null, 4e7, 5 + i]) } } })), 'gates:newlisting');
    assert.equal(why([row()], mkRef({ tickers: { 100: { t: 'AAA', name: 'Aaa', px: 50, adv: 5e7, bars: barDays.map((d, i) => [d, 50, -0.35, null, 300 + i]) } } })), 'gates:noliq');
  });

  ok('контур B: поправка 4/A и повтор раньше поданной формы — не событие дня; сегодняшняя поправка к сегодняшней форме — событие', () => {
    const old = { acc: 'OLD-1', form: '4', fdate: '2026-11-18', tdate: '2026-11-17', cik: 100, code: 'P', sec: 'Common Stock', sh: 3000, px: 50, orig: null, owners: P1.map(o => ({ cik: o.cik, name: o.name })) };
    const ref = mkRef({ recent: { 100: [old] } });
    assert.deepEqual(ev([row({ form: '4/A', tdate: '2026-11-17', orig: '2026-11-18', sh: 3100 })], ref), { kind: 'skip', why: 'amend' }, 'поправка берёт дату подачи исходной формы');
    assert.deepEqual(ev([row({ tdate: '2026-11-17' })], ref), { kind: 'skip', why: 'amend' }, 'та же покупка подана повторно');
    assert.equal(ev([row({ tdate: '2026-11-17', sh: 5000 })], ref).kind, 'sig', 'другая покупка того же лица за ту же дату — складывается');
    const a = row({ tdate: '2026-11-18' }), b = row({ form: '4/A', tdate: '2026-11-18', orig: DAY, sh: 2000 });
    const r = ev([a, b]);
    assert.deepEqual([r.kind, r.rows, r.mx], ['sig', 1, 100000], 'поправка заместила исходную строку того же дня');
    const { mine, all } = resolveToday([old], [row({ form: '4/A', tdate: '2026-11-17', orig: '2026-11-18', sh: 3100 })], DAY);
    assert.equal(mine.length, 0); assert.equal(all.length, 1); assert.equal(all[0].fdate, '2026-11-18');
  });

  const formOf = (rows, hms, o = {}) => ({ k: 'form', acc: rows[0].acc, filed: DAY, at: `${DAY}T${hms.slice(0, 5)}`, acs: `${DAY}T${hms}`, w: new Date(ny(`${DAY}T${hms}`) + 40e3).toISOString(), rev: 3, end: true, trades: rows, amend: [], ...o });
  ok('контур B: одна запись на эмитента в день; повторная — только при росте скора; пропуск пишется один раз; перезапуск ничего не дублирует', () => {
    const ref = mkRef();
    const f1 = formOf([row({ cik: 600, t: 'FLT', owners: P2, sh: 30000 })], '11:31:07');        // скор 2
    const f2 = formOf([row({ cik: 600, t: 'FLT', sh: 500 })], '11:33:20');                     // офицер: скор 3
    const f3 = formOf([row({ cik: 600, t: 'FLT', owners: [{ cik: 9005, name: 'Sidorov Sidor', rel: 'D', title: '' }], sh: 400 })], '11:40:00');   // ничего не добавляет
    const f4 = formOf([row({ cik: 300, t: 'THN' })], '11:41:00'), f5 = formOf([row({ cik: 300, t: 'THN', sh: 1000 })], '11:42:00');
    const s = new DayState(ref, DAY);
    const now = ny(`${DAY}T11:31:50`);
    const o1 = s.onForm(f1, { seenAt: '2026-11-20T16:31:40Z', nowMs: now });
    assert.equal(o1.length, 1);
    assert.deepEqual([o1[0].k, o1[0].v, o1[0].day, o1[0].cik, o1[0].t, o1[0].n, o1[0].acc, o1[0].score], ['sig', 1, DAY, 600, 'FLT', 1, f1.acc, 2]);
    assert.deepEqual([o1[0].at, o1[0].at0, o1[0].seen, o1[0].tw], ['2026-11-20T16:31:07Z', '2026-11-20T16:31:07Z', '2026-11-20T16:31:40Z', '2026-11-20T16:31:50Z']);
    assert.deepEqual(Object.keys(o1[0]), ['k', 'v', 'day', 'cik', 't', 'n', 'acc', 'at', 'at0', 'seen', 'tw', 'score', 'pts', 'mx', 'val', 'rows', 'dv', 'px', 'asOf', 'dd', 'role', 'td', 'fpx', 'same', 'units'], 'состав записи — как в договорённости с ботом');
    assert.deepEqual(s.onForm(f1), [], 'та же подача второй раз не считается');
    const o2 = s.onForm(f2, { nowMs: now + 120e3 });
    assert.deepEqual([o2[0].k, o2[0].n, o2[0].score, o2[0].acc, o2[0].at, o2[0].at0, o2[0].rows], ['sig', 2, 3, f2.acc, '2026-11-20T16:33:20Z', '2026-11-20T16:31:07Z', 2], 'скор вырос — вторая запись, время — по форме, давшей рост');
    assert.deepEqual(s.onForm(f3), [], 'скор не вырос — записи нет');
    const k4 = s.onForm(f4, { nowMs: now });
    assert.deepEqual([k4[0].k, k4[0].why, k4[0].t_, k4[0].cik, k4[0].score], ['skip', 'dv', 'THN', 300, 3]);
    assert.deepEqual(s.onForm(f5), [], 'та же причина пропуска второй раз не пишется');
    assert.deepEqual(s.onForm(formOf([{ ...row(), code: 'S' }], '11:50:00')), [], 'форма без покупок');
    assert.deepEqual(s.onForm(formOf([row()], '11:51:00', { filed: ASOF })), [], 'форма с другой датой подачи');
    // перезапуск: состояние из файла дня, формы — заново из журнала
    const s2 = new DayState(ref, DAY, [...o1, ...o2, ...k4]);
    for (const f of [f1, f2, f3, f4, f5]) assert.deepEqual(s2.onForm(f), []);
    // день выключен — записей нет
    const s3 = new DayState(ref, DAY, [{ k: 'off', why: 'fpi_warn' }]);
    assert.deepEqual(s3.onForm(f1), []); assert.equal(s3.off, 'fpi_warn');
  });

  ok('контур B: справочник не на тот день, отсутствует или справочники иностранных эмитентов не готовы — сигналов нет весь день', () => {
    assert.equal(refProblem(mkRef(), DAY), null);
    assert.equal(refProblem(null, DAY).why, 'no_ref');
    assert.equal(refProblem(mkRef({ for: ASOF }), DAY).why, 'stale_ref');
    assert.equal(refProblem(mkRef({ asOf: '2026-11-18' }), DAY).why, 'stale_ref', 'бары старше предыдущего торгового дня');
    assert.equal(refProblem(mkRef({ v: 2 }), DAY).why, 'bad_ref'); assert.equal(refProblem({ v: 1 }, DAY).why, 'bad_ref');
    const w = refProblem(mkRef({ fpiWarn: ['справочник отчётов иностранных эмитентов устарел (по 2026-11-01, список за 2026-11-20)'] }), DAY);
    assert.equal(w.why, 'fpi_warn'); assert.match(w.text, /устарел/);
    assert.equal(refProblem(mkRef({ for: '2026-11-23', asOf: DAY }), '2026-11-23'), null, 'понедельник по барам пятницы');
  });

  ok('контур B: чтение дописываемого журнала — недописанная строка ждёт следующего чтения, испорченная пропускается', () => {
    const a = splitLines('{"k":"seen","acc":"A"}\n{"k":"form","acc":"A"}\n{"k":"se');
    assert.deepEqual(a.recs.map(r => r.k), ['seen', 'form']); assert.equal(a.rest, '{"k":"se');
    const b = splitLines(a.rest + 'en","acc":"B"}\nмусор\n\n{"k":"stat"}\n');
    assert.deepEqual(b.recs.map(r => r.k), ['seen', 'stat']); assert.equal(b.rest, '');
    assert.deepEqual(splitLines('без перевода строки'), { recs: [], rest: 'без перевода строки' });
    assert.deepEqual(splitLines(Buffer.from('{"k":"run"}\n')).recs, [{ k: 'run' }]);
  });

  ok('контур B: задержка ленты за час и тревога — медиана выше двух минут не меньше чем на пяти формах', () => {
    const t0 = ny(`${DAY}T13:00`), mk = lats => lats.map((lat, i) => ({ t: t0 - i * 60e3, lat }));
    assert.deepEqual(latencyStat([], t0), { n: 0, med: null, p90: null, ok90: null, alarm: false });
    const okS = latencyStat(mk([40, 50, 51, 60, 95, 30]), t0);
    assert.deepEqual([okS.n, okS.med, okS.alarm, okS.ok90], [6, 51, false, 0.833]);
    assert.equal(latencyStat(mk([200, 300, 400, 500]), t0).alarm, false, 'четыре формы — мало для тревоги');
    assert.equal(latencyStat(mk([200, 300, 400, 500, 50]), t0).alarm, true);
    assert.equal(latencyStat(mk([200, 300, 40, 50, 60]), t0).alarm, false, 'медиана в норме');
    assert.equal(latencyStat([...mk([40, 50, 60, 45, 55]), ...[200, 300, 400, 500, 600].map((lat, i) => ({ t: t0 - 61 * 60e3 - i, lat }))], t0).alarm, false, 'старше часа — вне окна');
    assert.equal(LATENCY.alarmSec, 120); assert.equal(LATENCY.windowMin, 60);
  });

  // Процесс сигналов на подставных каталогах
  const sigBase = join(ROOT, '.selftest-signals');
  const watch = (argv) => new Promise(resolve => execFile(process.execPath, [join(ROOT, 'scripts', 'vps', 'signal-watch.mjs'), ...argv], { encoding: 'utf8' }, (err, so, se) => resolve({ code: err ? (err.code ?? 1) : 0, out: so + se })));
  const runWatch = (dir, feedDir, extra = []) => watch(['--dir', dir, '--feed-dir', feedDir, '--day', DAY, '--once', ...extra]);
  const linesOf = p => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  await okAsync('контур B: процесс сигналов — накопившиеся формы (в том числе вчерашнего вечера с сегодняшней датой подачи), файл дня, перезапуск без дублей, дописанная форма', async () => {
    rmSync(sigBase, { recursive: true, force: true });
    const dir = join(sigBase, 'sig'), feedDir = join(sigBase, 'feed');
    mkdirSync(join(dir, 'ref'), { recursive: true }); mkdirSync(feedDir, { recursive: true });
    writeJson(join(dir, 'ref', `${DAY}.json`), mkRef());
    // вчера в 18:05 принята форма с сегодняшней датой подачи (скор 2), сегодня в 11:31 — вторая (скор 3)
    const eve = { ...formOf([row({ cik: 600, t: 'FLT', owners: P2, sh: 30000 })], '11:00:00'), at: `${ASOF}T18:05`, acs: `${ASOF}T18:05:11`, w: '2026-11-19T23:05:50.000Z' };
    const f2 = formOf([row({ cik: 600, t: 'FLT', sh: 500 })], '11:31:07'), f3 = formOf([row()], '11:32:00');
    writeFileSync(feedFile(feedDir, ASOF), [{ k: 'seen', acc: eve.acc, filed: DAY, t: '2026-11-19T23:05:40.000Z' }, eve].map(x => JSON.stringify(x)).join('\n') + '\n');
    writeFileSync(feedFile(feedDir, DAY), [{ k: 'run' }, { k: 'seen', acc: f2.acc, filed: DAY, t: '2026-11-20T16:31:40.000Z' }, f2].map(x => JSON.stringify(x)).join('\n') + '\n' + JSON.stringify(f3).slice(0, 80));
    const out = join(dir, `${DAY}.jsonl`);
    const r1 = await runWatch(dir, feedDir);
    assert.equal(r1.code, 0, r1.out);
    let L = linesOf(out);
    assert.deepEqual(L.map(x => x.k), ['run', 'sig', 'sig'], 'недописанная третья форма не прочитана');
    assert.deepEqual(L[0].ref, { asOf: ASOF, for: DAY, built: '2026-11-20T04:55:00.000Z', n: 5 });
    assert.deepEqual([L[1].n, L[1].score, L[1].at, L[1].seen], [1, 2, '2026-11-19T23:05:11Z', '2026-11-19T23:05:40Z'], 'вечерняя форма: время приёма вчерашнее — бот её не возьмёт по сроку годности');
    assert.deepEqual([L[2].n, L[2].score, L[2].at, L[2].at0, L[2].seen], [2, 3, '2026-11-20T16:31:07Z', '2026-11-19T23:05:11Z', '2026-11-20T16:31:40Z']);
    // строка дописана, процесс перезапущен: прежние сигналы не повторяются, новый — один
    writeFileSync(feedFile(feedDir, DAY), [{ k: 'run' }, { k: 'seen', acc: f2.acc, filed: DAY, t: '2026-11-20T16:31:40.000Z' }, f2, f3].map(x => JSON.stringify(x)).join('\n') + '\n');
    const r2 = await runWatch(dir, feedDir);
    assert.equal(r2.code, 0, r2.out);
    L = linesOf(out);
    assert.deepEqual(L.map(x => x.k), ['run', 'sig', 'sig', 'run', 'sig']); assert.deepEqual([L[4].t, L[4].n, L[4].score], ['AAA', 1, 3]);
    const r3 = await runWatch(dir, feedDir);
    assert.deepEqual(linesOf(out).map(x => x.k), ['run', 'sig', 'sig', 'run', 'sig', 'run'], 'третий запуск ничего не добавил'); assert.equal(r3.code, 0);
    // биржевой праздник — процесс выходит сразу
    const h = await watch(['--dir', dir, '--feed-dir', feedDir, '--day', '2026-11-26', '--once']);
    assert.equal(h.code, 0); assert.match(h.out, /биржа не торгует/); assert.equal(existsSync(join(dir, '2026-11-26.jsonl')), false);
  });
  await okAsync('контур B: процесс сигналов — справочника нет или справочники иностранных эмитентов не готовы: запись off и ни одного сигнала; тревога по задержке на повторе журнала', async () => {
    const feedDir = join(sigBase, 'feed2'), f = formOf([row()], '11:31:07');
    mkdirSync(feedDir, { recursive: true });
    writeFileSync(feedFile(feedDir, DAY), JSON.stringify(f) + '\n');
    for (const [name, refObj, why] of [['none', null, 'no_ref'], ['warn', mkRef({ fpiWarn: ['нет справочника первой формы'] }), 'fpi_warn'], ['old', mkRef({ for: ASOF, asOf: '2026-11-18' }), 'stale_ref']]) {
      const dir = join(sigBase, `off-${name}`);
      mkdirSync(join(dir, 'ref'), { recursive: true });
      if (refObj) writeJson(join(dir, 'ref', `${DAY}.json`), refObj);
      const r = await runWatch(dir, feedDir);
      assert.equal(r.code, 0, r.out); assert.match(r.out, /СИГНАЛОВ СЕГОДНЯ НЕТ/);
      let L = linesOf(join(dir, `${DAY}.jsonl`));
      assert.deepEqual(L.map(x => x.k), ['run', 'off']); assert.equal(L[1].why, why); assert.ok(L[1].text.length > 10);
      // справочник появился позже — день всё равно выключен (запись off действует до конца дня)
      writeJson(join(dir, 'ref', `${DAY}.json`), mkRef());
      await runWatch(dir, feedDir);
      L = linesOf(join(dir, `${DAY}.jsonl`));
      assert.deepEqual(L.map(x => x.k), ['run', 'off', 'run'], 'второй раз off не пишется, сигналов нет');
    }
    // без --once процесс с выключенным днём выходит с кодом 3 (тревога юнита без перезапуска)
    const c = await watch(['--dir', join(sigBase, 'off-code'), '--feed-dir', feedDir, '--day', DAY]);
    assert.equal(c.code, 3, c.out);
    const unit = readFileSync(join(ROOT, 'ops', 'insider840-signals', 'insider840-signals.service'), 'utf8').replace(/\r/g, '');
    assert.match(unit, /\nRestartPreventExitStatus=3\n/); assert.match(unit, /\nCPUWeight=400\n/); assert.match(unit, /\nStateDirectoryMode=0755\n/);
    // повтор журнала: шесть форм торговых часов с задержкой от 200 секунд — запись stat с тревогой; с обычной задержкой тревоги нет
    for (const [name, lag, alarm] of [['slow', 200, true], ['fast', 40, false]]) {
      const fd = join(sigBase, `feed-${name}`), dir = join(sigBase, `lat-${name}`);
      mkdirSync(fd, { recursive: true }); mkdirSync(join(dir, 'ref'), { recursive: true });
      writeJson(join(dir, 'ref', `${DAY}.json`), mkRef());
      const forms = [0, 1, 2, 3, 4, 5].map(i => { const hms = `11:${String(10 + i * 5).padStart(2, '0')}:00`; return { ...formOf([{ ...row(), code: 'S' }], hms), w: new Date(ny(`${DAY}T${hms}`) + lag * 1000).toISOString() }; });
      writeFileSync(feedFile(fd, DAY), forms.map(x => JSON.stringify(x)).join('\n') + '\n');
      const r = await runWatch(dir, fd, ['--replay']);
      assert.equal(r.code, 0, r.out);
      const st = linesOf(join(dir, `${DAY}.jsonl`)).filter(x => x.k === 'stat');
      assert.equal(st.some(x => x.alarm === true), alarm, r.out);
      if (alarm) { const a = st.find(x => x.alarm); assert.ok(a.med > 120 && a.n >= 5); assert.match(r.out, /ТРЕВОГА: медиана задержки ленты/); assert.equal(st.filter(x => x.alarm).length, 1, 'не чаще раза в час'); }
    }
    rmSync(sigBase, { recursive: true, force: true });
  });

  // Справочник D−1 от самого compute: без ключа сборка не меняется; событие по справочнику равно строке списка, посчитанной compute
  await okAsync('контур B: compute --intraday-ref — список тот же, что без ключа; событие по справочнику равно строке списка самого compute на тех же барах', async () => {
    const base = join(ROOT, '.selftest-intraday'), data = join(base, 'repo');
    rmSync(base, { recursive: true, force: true });
    for (const d of ['trades', 'reference', 'prices', 'state']) cpSync(join(TMP, d), join(data, d), { recursive: true });
    const spy = readPriceCache(data, 'SPY'), asOf = spy.at(-1)[0];
    let forDay = addDaysIso(asOf, 1); while (isMarketClosed(forDay)) forDay = addDaysIso(forDay, 1);
    const run = (site, extra = []) => execFileSync(process.execPath, [join(ROOT, 'scripts', 'compute.mjs'), '--data', data, '--site', join(base, site), '--only-morning', '--builder', 'vps', ...extra], { encoding: 'utf8', stdio: 'pipe' });
    const strip = m => ({ ...m, builtAt: null });
    run('plain');
    const refFile = join(base, 'ref.json');
    const out = run('withref', ['--intraday-ref', refFile, '--intraday-for', forDay]);
    assert.match(out, /справочник D−1: бары по /);
    assert.deepEqual(strip(readJson(join(base, 'withref', 'data', 'morning.json'))), strip(readJson(join(base, 'plain', 'data', 'morning.json'))), 'ключ --intraday-ref список не меняет');
    assert.throws(() => run('bad', ['--intraday-ref', refFile]), /intraday-for/, 'без дня сигнала — отказ');
    const ref = readJson(refFile);
    assert.deepEqual([ref.v, ref.asOf, ref.for, ref.n], [1, asOf, forDay, 1], 'в справочнике одна бумага: ALFA ушла с биржи (нет свежего бара), OTCX — внебиржевая');
    assert.equal(refProblem(ref, forDay)?.why, prevMarketDay(forDay) === asOf ? 'fpi_warn' : 'stale_ref', 'в фикстуре нет справочников иностранных эмитентов — день был бы выключен');
    const tk = ref.tickers[222];
    assert.deepEqual([tk.t, tk.name, tk.bars.length, tk.bars.at(-1)[0]], ['LIVA', 'Liva Inc', SIGNAL.tailBars, asOf]);
    assert.equal(tk.px, livaSeries.find(r => r[0] === asOf)[1]); assert.ok(tk.adv > 5e7);
    assert.ok(ref.recent[222].some(r => r.acc === 'L1'), 'недавняя покупка — в справочнике (поправки, синхронные подачи)');
    assert.ok(ref.fpiWarn.length >= 1);
    // форма дня сигнала: директор и CEO, цена сделки — закрытие asOf; эталон — compute с этой формой в шарде на тех же барах
    const px = tk.px, mk = (acc, owners, sh, tdate) => T({ acc, fdate: forDay, tdate, cik: 222, t: 'LIVA', owners, code: 'P', sh, px, val: Math.round(px * sh), own: 9e4, sec: 'Common Stock', at: `${forDay}T11:31` });
    const today2 = [mk('N1', dir, 20000, asOf), mk('N2', ceo, 2000, forDay)];
    const g = new OwnerGroups(ref); for (const r of today2) g.addFiling(r.owners);
    const sig = evalEvent({ ...ref, fpiWarn: [] }, forDay, 222, today2, g);
    const shard = readJsonGz(join(data, 'trades', 'live.json.gz'));
    writeJsonGz(join(data, 'trades', 'live.json.gz'), { ...shard, trades: [...shard.trades, ...today2] });
    run('oracle');
    const w = readJson(join(base, 'oracle', 'data', 'morning.json')).days.find(d => d.date === forDay).rows.find(r => r.t === 'LIVA');
    assert.equal(sig.kind, 'sig');
    assert.deepEqual([sig.score, sig.mx, sig.val, sig.rows, sig.dv, sig.px, sig.dd, sig.role], [w.score, w.mx, w.val, w.n, w.dv, w.px, w.dd, w.role], 'скор, суммы, оборот, цена, просадка — как у compute');
    assert.deepEqual([sig.score, sig.pts.v1m, sig.pts.off, sig.same], [3, 1, 1, false]);
    // вселенная шага справочника: по кэшу цен, биржевые бумаги с запасом по обороту и цене; устаревший кэш не берётся
    const u = ir.pickUniverse(data, asOf);
    assert.deepEqual(Object.keys(u.universe), ['LIVA']); assert.equal(u.universe.LIVA, asOf); assert.equal(u.stat.stale, 1, 'ALFA: кэш кончился в 2021 году');
    rmSync(base, { recursive: true, force: true });
  });

  await okAsync('контур B: шаг справочника — бары вселенной через воркер, бар незакрытого дня и бары позже asOf не берутся, готовый справочник не пересобирается', async () => {
    const base = join(ROOT, '.selftest-intraday2'), state = join(base, 'state'), data = join(state, 'build', 'repo');
    rmSync(base, { recursive: true, force: true });
    for (const d of ['trades', 'reference', 'prices', 'state']) cpSync(join(TMP, d), join(data, d), { recursive: true });
    // «сейчас» — 07:00 ET сегодняшнего (или ближайшего) торгового дня: бар этого дня не закрыт, asOf — предыдущий торговый день
    let day = nyWall(Date.now()).slice(0, 10); while (isMarketClosed(day)) day = addDaysIso(day, 1);
    const nowIso = new Date(nyToMs(`${day}T07:00`)).toISOString(), asOf = prevMarketDay(day);
    // в копии данных ряды кончаются за два дня до asOf; источник отдаёт ряд по сегодняшний день включительно (недозакрытый бар)
    const cutAt = prevMarketDay(asOf);
    for (const sym of ['SPY', 'IWM', 'LIVA']) writePriceCache(data, sym, readPriceCache(data, sym).filter(r => r[0] < cutAt));
    const flat = bizDays('2015-01-01', day).filter(d => !isMarketClosed(d)).map(d => [d, 100, 100, 1e6]);
    const liva = bizDays('2024-01-02', day).filter(d => !isMarketClosed(d)).map(d => [d, d === day ? 99 : 60, d === day ? 99 : 60, 1e6]);
    const src = { SPY: flat, IWM: flat, LIVA: liva };
    const asked = [];
    const api = await fakeWorker({ charts: Object.fromEntries(Object.entries(src).map(([sym, s]) => [sym, from => { asked.push([sym, from]); const rows = s.filter(r => r[0] >= from), c = chartOf(rows); c.chart.result[0].indicators.quote[0].low = rows.map(r => r[1] * 0.99); return c; }])) });
    try {
      const args = ['--state', state, '--no-sync', '--once', '--now', nowIso, '--min-tickers', '1'];
      const code = await ir.main(args, { PAPER_URL: api.base, PAPER_TOKEN: 'tok' });
      assert.equal(code, 0);
      const ref = readJson(join(state, 'ref', `${day}.json`));
      assert.deepEqual([ref.asOf, ref.for, ref.n], [asOf, day, 1]);
      assert.equal(ref.tickers[222].px, 60, 'цена — закрытие asOf, а не недозакрытый бар сегодняшнего дня (99)');
      assert.equal(ref.tickers[222].bars.at(-1)[0], asOf);
      assert.equal(readPriceCache(data, 'LIVA').at(-1)[0], asOf, 'бар незакрытого дня в копию данных не записан');
      assert.deepEqual(asked.map(x => x[0]).sort(), ['IWM', 'LIVA', 'SPY']);
      assert.ok(asked.every(([, from]) => from <= addDaysIso(asOf, -ir.REF.barsBackDays)), 'запрос с перекрытием: минимумы дня нужны за последние бары');
      assert.ok(Object.keys(ref.lows).some(k => k.startsWith('LIVA|')), 'минимумы дня последних баров — в справочнике');
      // второй запуск: справочник на этот день по этим барам уже лежит — к источнику не ходим
      const n = asked.length;
      assert.equal(await ir.main(args, { PAPER_URL: api.base, PAPER_TOKEN: 'tok' }), 0); assert.equal(asked.length, n);
      // источник цен не отвечает — справочник не собран, код 1 (тревога)
      rmSync(join(state, 'ref', `${day}.json`));
      const dead = await ir.main(['--state', state, '--no-sync', '--once', '--now', nowIso], { PAPER_URL: 'http://127.0.0.1:9', PAPER_TOKEN: 'tok' });
      assert.equal(dead, 1); assert.equal(existsSync(join(state, 'ref', `${day}.json`)), false);
      assert.equal(await ir.main(['--state', state, '--no-sync', '--once', '--now', nowIso], { PAPER_URL: api.base }), 1, 'без токена воркера — отказ');
      assert.equal(await ir.main(['--state', state, '--no-sync', '--once', '--now', nowIso], { PAPER_URL: api.base, PAPER_TOKEN: 'tok' }), 1, 'справочник из одной бумаги — не справочник (порог --min-tickers)');
    } finally { await api.close(); rmSync(base, { recursive: true, force: true }); }
    assert.equal(ir.closedOnly({ series: [['2026-11-19', 1, 1, 1], ['2026-11-20', 2, 2, 2]], ohlc: [['2026-11-19', 1, 1], ['2026-11-20', 2, 2]], lows: [['2026-11-19', 1], ['2026-11-20', 2]] }, '2026-11-19', nyToMs('2026-11-20T23:52')).series.length, 1, 'бары позже asOf срезаются и после закрытия');
  });
}

rmSync(TMP, { recursive: true, force: true });
console.log(`Самотесты: ${passed} ok${process.exitCode ? ', ЕСТЬ ПАДЕНИЯ' : ''}`);
