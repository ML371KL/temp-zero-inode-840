// Ежедневная сверка покупок дня списка со сторонним разбором форм (OpenInsider) — шаг сборки GitHub, необязательный: недоступный
// источник, смена разметки и любая ошибка сборку не роняют (код выхода 0, в файле — ok: false). Результат — отдельный файл
// site/data/oicheck.json рядом с morning.json (контракт morning.json для бота не меняется); notify.mjs даёт строку в письмо только
// при настоящем пропуске: покупка от $100 тыс. в биржевой бумаге, которой нет в строках панели (lib/oicheck.mjs).
//   node scripts/oicheck.mjs [--data data] [--site site] [--html файл]      (--html — сохранённая страница вместо запроса, для проверки)
// В запросе к источнику — только дата и подпись проекта: личных данных нет.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson, readJsonGz } from './lib/util.mjs';
import { ALLOWED_EXCHANGES } from './lib/universe.mjs';
import { OI, oiUrl, parseOi, matchOi } from './lib/oicheck.mjs';

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DATA = argVal('--data', 'data'), SITE = argVal('--site', 'site'), HTML = argVal('--html', null);
const out = join(SITE, 'data', 'oicheck.json');
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

async function page(url) {
  if (HTML) return readFileSync(HTML, 'utf8');
  let last;
  for (let k = 0; k < 2; k++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': OI.ua }, signal: AbortSignal.timeout(OI.timeoutMs) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) { last = e; }
  }
  throw last;
}

let day = null;
try {
  const morning = readJson(join(SITE, 'data', 'morning.json'), null);
  day = morning?.listFor;
  if (!day) { console.log('[oicheck] нет morning.json с listFor — пропуск'); process.exit(0); }
  // Покупки панели с подачей day — все строки, до гейтов: сверяется сбор и разбор, а не отбор
  const ref = readJson(join(DATA, 'reference', 'tickers.json'), {});
  const tickerOf = cik => String(ref[cik]?.ticker ?? '').toUpperCase();
  const listedSet = new Set(Object.values(ref).filter(v => ALLOWED_EXCHANGES.has(v?.exchange)).map(v => String(v.ticker ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')));
  const panel = [];
  for (const f of ['live.json.gz', `${day.slice(0, 4)}.json.gz`, `${Number(day.slice(0, 4)) - 1}.json.gz`]) {
    const p = join(DATA, 'trades', f);
    if (!existsSync(p)) continue;
    const s = readJsonGz(p, null);
    for (const r of (Array.isArray(s) ? s : s?.trades) ?? []) if (r.code === 'P' && r.fdate === day) panel.push({ acc: r.acc, t: r.t, T: tickerOf(r.cik), sh: r.sh, val: r.val, owners: r.owners });
  }
  let html;
  try { html = await page(oiUrl(day)); }
  catch (e) { writeJson(out, { listFor: day, at: now(), source: 'openinsider', ok: false, error: `источник недоступен: ${String(e.message ?? e).slice(0, 120)}` }); console.log(`[oicheck] ${day}: источник недоступен (${e.message ?? e}) — сверки нет`); process.exit(0); }
  const rows = parseOi(html);
  // Нет ни одной строки таблицы: источник недоступен или сменил разметку. День без покупок у источника так не выглядит только в
  // праздники — тревогой это не считается в любом случае.
  if (!rows.length) { writeJson(out, { listFor: day, at: now(), source: 'openinsider', ok: false, error: 'в ответе нет строк таблицы' }); console.log(`[oicheck] ${day}: в ответе источника нет строк таблицы — сверки нет`); process.exit(0); }
  const res = matchOi(rows, panel, { day, listed: t => listedSet.has(String(t).toUpperCase().replace(/[^A-Z0-9]/g, '')) });
  // Страница с таблицей, но без единой покупки за день, когда у панели их несколько, — не «сверено, пропусков нет», а несверенный день
  const panelAccs = new Set(panel.map(r => r.acc)).size;
  if (!res.oi && panelAccs >= 5) { writeJson(out, { listFor: day, at: now(), source: 'openinsider', ok: false, error: `у источника нет покупок за день, у панели подач с покупками ${panelAccs}` }); console.log(`[oicheck] ${day}: у источника нет покупок за день — сверка не состоялась`); process.exit(0); }
  writeJson(out, { listFor: day, at: now(), source: 'openinsider', ok: true, minVal: OI.minVal, panel: new Set(panel.map(r => r.acc)).size, oi: res.oi, found: res.found, byAcc: res.byAcc, byName: res.byName,
    missing: res.missing.slice(0, 50), alerts: res.alerts.slice(0, 20), partial: res.partial.slice(0, 20), refiled: res.refiled.slice(0, 20) });
  console.log(`[oicheck] ${day}: покупок у стороннего разбора ${res.oi}, найдено у панели ${res.found} (по номеру подачи ${res.byAcc}${res.byName ? `, по имени лица ${res.byName}` : ''}), нет у панели ${res.missing.length}`
    + (res.alerts.length ? `; ПРОПУСК от $${OI.minVal / 1e3} тыс. в биржевых бумагах: ${res.alerts.map(a => `${a.t} $${Math.round(a.val)}`).join(', ')}` : ''));
} catch (e) {
  console.log(`[oicheck] сверка не удалась (сборку не останавливает): ${e.stack ?? e}`);
  try { writeJson(out, { listFor: day, at: now(), source: 'openinsider', ok: false, error: `сверка не удалась: ${String(e.message ?? e).slice(0, 120)}` }); } catch { /* файл не записался — письмо просто не увидит сверки */ }
}
