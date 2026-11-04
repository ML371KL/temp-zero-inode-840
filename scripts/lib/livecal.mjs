// Календарь живого контура и покрытие дней подачи. Чистые функции без сети — их проверяют самотесты.
//
// Дневной индекс EDGAR за день D выходит в ~22:02 ET (в 65 днях 08–11.2026 — 22:01–22:24 ET), то есть
// в 02:0x UTC летом и 03:0x UTC зимой следующих суток. Прогон в 03:25 UTC дня T (по UTC) поэтому видит
// индекс T−1, а индекс T ещё не вышел. Отсюда правило:
//  · индекса дня D нет и D ≥ T−1 — «ещё не вышел»: стоп, следующий прогон спросит снова;
//  · индекса дня D нет и D ≤ T−2 — праздник SEC (он давно вышел бы), идём дальше.
// До 11.2026 стоп был при D ≥ T−2, и после праздника в будний день следующий рабочий день не
// читался ещё сутки: подачи 08.09 (после Дня труда) и 13.10 (после Columbus Day) пришли в список
// после своего D+1. Дополнительно: если индекса D нет, а индекс следующего рабочего дня уже есть,
// D — праздник при любом времени запуска.
import { addDaysIso } from './util.mjs';

export const COVERAGE_DAYS = 40;   // сколько дней подачи держать в state.coverage
export const STATUSES = ['complete', 'partial', 'holiday', 'not-published'];

export const isWeekend = iso => { const d = new Date(iso + 'T00:00:00Z').getUTCDay(); return d === 0 || d === 6; };
export function nextWeekday(iso) {
  let d = addDaysIso(iso, 1);
  while (isWeekend(d)) d = addDaysIso(d, 1);
  return d;
}

// Индекса дня нет: стоп или праздник. nextHasIndex — есть ли индекс следующего рабочего дня (true/false/null — не спрашивали).
export function missingIndexVerdict(day, today, nextHasIndex = null) {
  if (nextHasIndex === true) return 'holiday';
  return addDaysIso(day, 1) >= today ? 'not-published' : 'holiday';
}
// Нужно ли спрашивать индекс следующего рабочего дня (он мог выйти, только если тот день не позже сегодня)
export const shouldProbeNext = (day, today) => addDaysIso(day, 1) >= today && nextWeekday(day) <= today;

// Запись покрытия дня по счётчикам. indexed — уникальные подачи Form 4/4A в form.idx, collected —
// разобранные, pending — ждут добора, gone — путь из индекса отвечает 404 по всем адресам (подачу сняли).
export function coverageEntry({ indexed, collected, pending, gone = 0, at, error = null }) {
  const e = { status: pending > 0 || collected + gone < indexed ? 'partial' : 'complete', indexed, collected, pending, at };
  if (gone) e.gone = gone;
  if (error) e.error = String(error).slice(0, 200);
  return e;
}

export function pruneCoverage(coverage, today, days = COVERAGE_DAYS) {
  const cut = addDaysIso(today, -days);
  const out = {};
  for (const k of Object.keys(coverage ?? {}).sort()) if (k >= cut) out[k] = coverage[k];
  return out;
}
