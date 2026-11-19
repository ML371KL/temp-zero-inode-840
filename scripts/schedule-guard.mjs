// Страж страховочного прогона daily.yml (первая задача workflow). Прогон по расписанию GitHub (событие schedule) по плану идёт
// в 22:40–23:40 по Нью-Йорку, но опаздывает на часы: 03–04 утра в октябре 2026, 07:26 — 17.11.2026. Начатый в торговый день позже
// 08:10 и до закрытия торгов, он попал бы на приём списка ботом (08:30) и на торговую сессию — такой прогон завершается сразу,
// ничего не меняя. Правило и границы — scripts/lib/session.mjs (scheduleGuard). Ручной запуск и запуск от слияния не ограничены.
//
//   node scripts/schedule-guard.mjs --event schedule [--now 2026-11-18T09:41:00-05:00]
//
// Печатает решение одной строкой; если задан GITHUB_OUTPUT, дописывает в него skip=true|false. Код выхода всегда 0: при любой
// ошибке самого стража прогон НЕ пропускается (skip=false) — ночная сборка важнее, а бар незакрытого дня prices.mjs не запишет.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
let verdict;
try {
  const { scheduleGuard } = await import('./lib/session.mjs');
  const nowArg = argVal('--now', null);
  const nowMs = nowArg ? Date.parse(nowArg) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error(`--now: не момент времени (${nowArg})`);
  verdict = scheduleGuard(argVal('--event', process.env.GITHUB_EVENT_NAME ?? ''), nowMs);
} catch (e) {
  verdict = { skip: false, why: `страж не сработал (${e?.message ?? e}) — прогон не ограничивается` };
}
console.log(`[страж] ${verdict.skip ? 'ПРОПУСК' : 'работаем'}: ${verdict.why}`);
if (verdict.skip && process.env.GITHUB_ACTIONS) console.log(`::notice::Прогон пропущен: ${verdict.why}`);
if (process.env.GITHUB_OUTPUT) {
  try { appendFileSync(process.env.GITHUB_OUTPUT, `skip=${verdict.skip ? 'true' : 'false'}\n`); }
  catch (e) { console.log(`[страж] GITHUB_OUTPUT не записан (${e.message}) — прогон не ограничивается`); }
}
