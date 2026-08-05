// Самотесты на фиксированных фикстурах. Правило: никаких утверждений, зависящих от дня
// недели запуска; динамические ряды строятся «до сегодня» так, чтобы классификация не менялась.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secDate, parseTsv, addDaysIso, isoToday, readJson, writeJson, writeJsonGz, isIsoDate } from './lib/util.mjs';
import { zipCreate, zipExtract } from './lib/zip.mjs';
import { normalizeQuarterZip, relFlags, parseFormIdx, parseForm4Txt, SHARD_VERSION } from './lib/edgar.mjs';
import {
  mergeSeries, writePriceCache, nominalFactor, sanitizeSeries, metaAcceptable, normalizeTiingo,
  trimFrozenTail, repairUnadjustedSplits, clipToInstrument, cutAtDataBreak, listedThrough,
} from './lib/prices.mjs';
import { parseRegistry, exchangeAt, mergeRanges, sameInstrumentAsLatest } from './lib/symbols.mjs';
import { Panel, monthlyFromDaily, portfolioSeries, factorAlpha, factorSeries, vsBenchmark, neweyWestT, universeSeries, pairedDiff, turnover } from './lib/portfolio.mjs';
import { applyGates, isPlanned, isNonCommon, isImplausible } from './lib/gates.mjs';
import { isEntityName, isPersonOwner, buildOwnerGroups, isFundOnly, topRole, dOwnOf } from './lib/entity.mjs';
import { buildOwnerHistory, isRoutineCMP, isRegularSeries, inflection, typicalBuyValue } from './lib/routine.mjs';
import { classifyFootnotes, rowFootnoteFlags } from './lib/footnotes.mjs';
import { loadAllTrades, issuerCategory } from './lib/universe.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
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
    T({ acc: 'L1', fdate: recentF, tdate: recentT, cik: 222, t: 'LIVA', owners: ceo, code: 'P', sh: 5000, px: livaAt(recentT), val: 275000, own: 15000 }),
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

execFileSync(process.execPath, [join(ROOT, 'scripts', 'compute.mjs'), '--data', TMP, '--site', join(TMP, 'site')], { stdio: 'pipe' });
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

// ---------- уведомления ----------
// Единица письма — ПОЗИЦИЯ, а не форма: докупка в уже открытой позиции второго письма
// порождать не должна. Проверяем сквозным прогоном скрипта на синтетическом фиде.
const NTMP = join(ROOT, '.selftest-notify');
rmSync(NTMP, { recursive: true, force: true });
mkdirSync(join(NTMP, 'site', 'data'), { recursive: true });
mkdirSync(join(NTMP, 'data', 'state'), { recursive: true });
writeJson(join(NTMP, 'site', 'data', 'stats.json'), { setDef: { hold: 3, freshDays: 45 } });

const nDay = n => addDaysIso(isoToday(), n);
const nRow = (t, fdate, who, val, extra = {}) => ({
  t, name: t + ' HOLDINGS INC', fdate, who, role: 'D', sh: 1000, px: val / 1000, val,
  dd: -0.012, dv: 6e6, set: 1, exit: addDaysIso(fdate, 91), cur: val / 1000, chg: 0.02, ...extra,
});
function notify(feed) {
  writeJson(join(NTMP, 'site', 'data', 'feed.json'), feed);
  return execFileSync(process.execPath,
    [join(ROOT, 'scripts', 'notify.mjs'), '--dry-run', '--site', join(NTMP, 'site'), '--data', join(NTMP, 'data')],
    { encoding: 'utf8' });
}

ok('notify: первый прогон молча пересевает состояние', () => {
  const out = notify([nRow('AAA', nDay(-2), 'Smith John', 3e5)]);
  assert.match(out, /состояние пересеяно/);
  assert.ok(!out.includes('новая позиция'), 'при пересеве письма не шлются');
});
ok('notify: новая позиция даёт ровно одну карточку', () => {
  const out = notify([nRow('AAA', nDay(-2), 'Smith John', 3e5), nRow('BBB', nDay(-1), 'Lee Anna', 4e5)]);
  assert.match(out, /новых позиций: 1/);
  assert.equal((out.match(/— новая позиция/g) ?? []).length, 1);
  assert.match(out, /BBB — новая позиция/);
  assert.match(out, /вход до .+ выход /, 'в карточке есть срок входа и дата выхода');
});
ok('notify: докупка в открытой позиции письма не даёт', () => {
  const out = notify([
    nRow('AAA', nDay(-2), 'Smith John', 3e5), nRow('BBB', nDay(-1), 'Lee Anna', 4e5),
    nRow('BBB', nDay(0), 'Park Wu', 2e5),
  ]);
  assert.match(out, /новых позиций нет/);
});
ok('notify: повторная покупка после закрытия окна — новая позиция', () => {
  const dir = join(NTMP, 'data2');
  mkdirSync(join(dir, 'state'), { recursive: true });
  const run = feed => {
    writeJson(join(NTMP, 'site', 'data', 'feed.json'), feed);
    return execFileSync(process.execPath,
      [join(ROOT, 'scripts', 'notify.mjs'), '--dry-run', '--site', join(NTMP, 'site'), '--data', dir],
      { encoding: 'utf8' });
  };
  const first = nRow('CCC', nDay(-100), 'Smith John', 3e5);
  run([first]);                                                    // пересев
  assert.match(run([first, nRow('CCC', nDay(-95), 'Smith John', 1e5)]), /новых позиций нет/);
  assert.match(run([first, nRow('CCC', nDay(0), 'Smith John', 3e5)]), /CCC — новая позиция/);
});
ok('notify: залп больше четырёх позиций сворачивается в сводку', () => {
  const dir = join(NTMP, 'data3');
  mkdirSync(join(dir, 'state'), { recursive: true });
  const run = feed => {
    writeJson(join(NTMP, 'site', 'data', 'feed.json'), feed);
    return execFileSync(process.execPath,
      [join(ROOT, 'scripts', 'notify.mjs'), '--dry-run', '--site', join(NTMP, 'site'), '--data', dir],
      { encoding: 'utf8' });
  };
  run([nRow('ZZZ', nDay(-2), 'Old Man', 3e5)]);                     // пересев
  const five = ['D1', 'D2', 'D3', 'D4', 'D5'].map((t, i) => nRow(t, nDay(0), 'Buyer ' + i, 1e5 * (i + 1)));
  const out = run([nRow('ZZZ', nDay(-2), 'Old Man', 3e5), ...five]);
  assert.match(out, /новых позиций: 5/);
  assert.match(out, /Рабочий набор: 5 новых позиций/);
  assert.ok(!out.includes('— новая позиция'), 'вместо пяти карточек одна сводка');
});
rmSync(NTMP, { recursive: true, force: true });

rmSync(TMP, { recursive: true, force: true });
console.log(`Самотесты: ${passed} ok${process.exitCode ? ', ЕСТЬ ПАДЕНИЯ' : ''}`);
