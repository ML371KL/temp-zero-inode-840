// Сверка списка ежедневной сборки (полный пересчёт на GitHub) со списком, который собрал и опубликовал VPS за ту же дату подачи.
// Две независимые сборки одного дня: если основной список (состав или скор) разошёлся, это пишется в morning.json как crossCheck, а
// notify.mjs шлёт короткое письмо-уточнение, когда VPS уже отправил своё. Шаг необязательный: воркер недоступен, списка VPS нет
// или он за другой день — сверки нет, ничего не падает.
//   node scripts/crosscheck.mjs [--site site]            (MORNING_URL — адрес воркера)
import { join } from 'node:path';
import { readJson, writeJson } from './lib/util.mjs';
import { compareMain } from './lib/morning.mjs';

const args = process.argv.slice(2);
const SITE = (() => { const i = args.indexOf('--site'); return i >= 0 ? args[i + 1] : 'site'; })();
const URL_BASE = (process.env.MORNING_URL || 'https://radar840-quotes.financehub.workers.dev').replace(/\/$/, '');
const file = join(SITE, 'data', 'morning.json');
const mine = readJson(file, null);
if (!mine?.listFor) { console.log('[crosscheck] нет morning.json с listFor — пропуск'); process.exit(0); }

let vps = null;
try {
  const r = await fetch(`${URL_BASE}/morning`, { signal: AbortSignal.timeout(15000) });
  if (r.status === 404) { console.log('[crosscheck] в воркере списка VPS нет — пропуск'); process.exit(0); }
  if (!r.ok) { console.log(`[crosscheck] воркер: HTTP ${r.status} — пропуск`); process.exit(0); }
  vps = await r.json();
} catch (e) { console.log('[crosscheck] воркер недоступен — пропуск:', e.message); process.exit(0); }

if (vps.builder !== 'vps' || vps.listFor !== mine.listFor) {
  console.log(`[crosscheck] список VPS не за ${mine.listFor} (${vps.builder}, ${vps.listFor}) — пропуск`);
  process.exit(0);
}
const rows = f => f.days?.find(d => d.date === f.listFor)?.rows ?? [];
const cmp = compareMain(rows(vps), rows(mine));
mine.crossCheck = { listFor: mine.listFor, vpsBuiltAt: vps.builtAt, same: cmp.same, vps: cmp.vps, github: cmp.github, diff: cmp.diff };
writeJson(file, mine);
console.log(cmp.same
  ? `[crosscheck] ${mine.listFor}: списки совпали (основной: ${cmp.github})`
  : `[crosscheck] ${mine.listFor}: РАСХОЖДЕНИЕ — VPS ${cmp.vps}, GitHub ${cmp.github}; ${cmp.diff.map(x => `${x.t} ${x.was ?? '—'}→${x.now ?? '—'}`).join(', ')}`);
