// Классификация сносок Form 4. Сноски — единственный источник правды о природе сделки:
// код P покрывает и открытый рынок, и частные размещения; флага «это PIPE» в схеме нет.
// Привязка к строке: в TSV через поля *_FN («F1, F2»), в XML через <footnoteId id="F1"/>
// внутри блока транзакции. Флаг 10b5-1 — формоуровневый (относится к подаче целиком).

export const FN_RULES = {
  // Плановая сделка. До появления чекбокса (04.2023) упоминание в сноске — единственный признак.
  b5: /10b5[\s-]?1|rule\s*10b5|trading\s+plan/i,
  // Не открытый рынок: размещение, подписка, допэмиссия. Главный отсев ложных P.
  // Формулировки подобраны так, чтобы НЕ ловить обычную покупку: «at the market price» —
  // стандартное описание именно открыторыночной сделки, поэтому ATM-программа требует
  // слова offering/program рядом, а underwriting — конкретного контекста (иначе срабатывало
  // бы на «The Reporting Person is not an underwriter of the offering»).
  offering: /rights\s+offering|private\s+placement|securities\s+purchase\s+agreement|subscription\s+agreement|registered\s+direct|underwrit(?:ten|ing)\s+(?:public\s+)?(?:offering|agreement|discount)|\bPIPE\b|at[\s-]the[\s-]market\s+(?:offering|program|sales\s+agreement|facility)|placement\s+agent|investment\s+agreement/i,
  // Автоматическое реинвестирование дивидендов — механика, не решение.
  drip: /dividend\s+reinvest|\bDRIP\b|automatic\s+(?:monthly|quarterly|periodic)?\s*(?:purchase|investment)\s+plan/i,
  // Программы сотрудников: покупка по расписанию с дисконтом, не сигнал.
  espp: /employee\s+stock\s+purchase|\bESPP\b|401\s*\(\s*k\s*\)|deferred\s+compensation\s+plan/i,
  // Принудительное распоряжение: не решение инсайдера (но само по себе тревожный признак).
  forced: /margin\s+call|foreclos|involuntar|divorce\s+decree|domestic\s+relations\s+order|court\s+order/i,
  // Залог акций — раскрытие, не принудительность. Информационный флаг риска.
  pledge: /pledg/i,
  // Цена строки — средневзвешенная по серии сделок; сама цена ненадёжна.
  wavg: /weighted\s+average|ranging\s+from|range\s+of\s+prices|prices\s+ranging|various\s+prices/i,
  // Безвозмездно.
  gift: /bona\s+fide\s+gift|no\s+consideration|charitable/i,
  // Косвенное владение через траст/супруга: деньги того же инсайдера, но НЕ отдельный участник
  // кластера. Тег информационный, поэтому широкое совпадение по слову «trust» допустимо.
  trust: /\btrusts?\b|\bGRAT\b|by\s+(?:his|her|the)?\s*(?:spouse|wife|husband)|family\s+(?:partnership|limited)/i,
};

export const FN_KEYS = Object.keys(FN_RULES);

// texts: массив строк сносок, относящихся к строке транзакции (+ формоуровневые для b5)
export function classifyFootnotes(texts) {
  const flags = {};
  if (!texts?.length) return flags;
  const joined = texts.join(' \n ');
  for (const [key, re] of Object.entries(FN_RULES)) if (re.test(joined)) flags[key] = 1;
  return flags;
}

// «F1, F2» -> ['F1','F2']; принимает несколько полей сразу
export function fnIds(...fields) {
  const out = new Set();
  for (const f of fields) {
    if (!f) continue;
    for (const id of String(f).split(/[,\s]+/)) if (id) out.add(id.trim());
  }
  return out;
}

// Итоговые флаги строки: построчные сноски + формоуровневое упоминание плана 10b5-1.
// Формоуровневый признак применяется ТОЛЬКО когда у строки нет собственных сносок: иначе
// в смешанной подаче (продажа по плану + дискреционная покупка) план приписывался бы и покупке.
export function rowFootnoteFlags(rowTexts, allTexts) {
  const flags = classifyFootnotes(rowTexts);
  if (!flags.b5 && !rowTexts?.length && FN_RULES.b5.test((allTexts ?? []).join(' \n '))) flags.b5 = 1;
  return flags;
}
