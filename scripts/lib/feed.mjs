// Лента формы 4 на весь день (VPS): журнал сборщика, сверка с дневным индексом EDGAR, слияние строк в шард живого контура.
// Зачем: два независимых пути к одному списку. Индекс form.ГГГГММДД.idx выходит в ~22:03 ET и один раз, лента getcurrent живёт весь день.
// Расхождение (в ленте есть, в индексе нет) — признак неполного индекса; нет индекса к 23:30 ET — список собирается по ленте с пометкой.
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { addDaysIso } from './util.mjs';

export const FEED = { from: '06:00', until: '22:00', intervalSec: 45, keepDays: 14, maxTries: 6 };
export const feedFile = (dir, nyDate) => join(dir, `${nyDate}.jsonl`);

// Журнал JSONL, по записи в строке:
//   run  — старт сборщика; seen — номер подачи замечен в ленте {acc, cik, form, filed, upd, t};
//   form — полный .txt скачан и разобран {acc, filed, at, trades, amend} (строки P и S — как у живого контура);
//   stat — такт опроса {t, polls, errors, forms, pending, gap}.
// Оборванная последней строка (убили процесс посреди записи) не ломает чтение.
export function parseFeedJournal(text) {
  const out = { seen: new Map(), forms: new Map(), stats: [], runs: [] };
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r !== 'object') continue;
    if (r.k === 'seen') out.seen.set(r.acc, r);
    else if (r.k === 'form') out.forms.set(r.acc, r);
    else if (r.k === 'stat') out.stats.push(r);
    else if (r.k === 'run') out.runs.push(r);
  }
  return out;
}

// Журналы за последние дни (подача 22:00–06:00 ET попадает в журнал соседнего дня) одним объектом
export function loadFeed(dir, nyDate, back = 2) {
  const all = { seen: new Map(), forms: new Map(), stats: [], runs: [] };
  for (let k = back; k >= 0; k--) {
    const f = feedFile(dir, addDaysIso(nyDate, -k));
    if (!existsSync(f)) continue;
    const j = parseFeedJournal(readFileSync(f, 'utf8'));
    for (const [a, r] of j.seen) all.seen.set(a, r);
    for (const [a, r] of j.forms) all.forms.set(a, r);
    all.stats.push(...j.stats); all.runs.push(...j.runs);
  }
  return all;
}

// Удалить журналы старше keepDays
export function pruneFeed(dir, nyDate, keepDays = FEED.keepDays) {
  if (!existsSync(dir)) return 0;
  const cut = addDaysIso(nyDate, -keepDays);
  let n = 0;
  for (const f of readdirSync(dir)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < cut) { unlinkSync(join(dir, f)); n++; }
  return n;
}

const isForm4 = f => f === '4' || f === '4/A' || f == null;

// Сверка ленты с индексом дня D. indexAccs — Set номеров подач Form 4/4A из form.idx.
// extra — разобранные подачи дня D, которых нет в индексе (индекс неполон); missing — есть в индексе, нет в ленте (слепые зоны ленты:
// подачи до начала её работы, глубже 300 записей, форма не дождалась скачивания); unparsed — замечены лентой, но не скачаны.
export function reconcile(feed, indexAccs, day) {
  const seen = [...feed.seen.values()].filter(s => s.filed === day && isForm4(s.form));
  const parsed = [...feed.forms.values()].filter(f => f.filed === day);
  const parsedSet = new Set(parsed.map(f => f.acc));
  const feedSet = new Set([...seen.map(s => s.acc), ...parsedSet]);
  return {
    indexed: indexAccs.size, seen: feedSet.size, parsed: parsed.length,
    extra: parsed.filter(f => !indexAccs.has(f.acc)).map(f => f.acc),
    missing: [...indexAccs].filter(a => !feedSet.has(a)).length,
    unparsed: seen.filter(s => !parsedSet.has(s.acc)).map(s => s.acc),
  };
}

// Влить строки подач accs из ленты в шард живого контура (тот же ключ строки, что у live.mjs: подача|код|дата сделки|класс бумаги).
// Уже лежащие строки не замещаются. Возвращает число добавленных строк.
export function mergeFeedRows(shard, forms, accs) {
  const key = r => `${r.acc}|${r.code}|${r.tdate}|${r.sec ?? ''}`;
  const byKey = new Map((shard.trades ?? []).map(r => [key(r), r]));
  const haveAmend = new Set((shard.amend ?? []).map(a => a.acc));
  let added = 0;
  for (const acc of accs) {
    const f = forms.get(acc);
    if (!f) continue;
    for (const r of f.trades ?? []) if (!byKey.has(key(r))) { byKey.set(key(r), r); added++; }
    for (const a of f.amend ?? []) if (!haveAmend.has(a.acc)) { haveAmend.add(a.acc); (shard.amend ??= []).push(a); }
  }
  shard.trades = [...byKey.values()];
  return added;
}

// ---------- лента EDGAR getcurrent (atom) ----------
// -> [{ acc, cik, form, updated, filed }] по одному на форму: одна форма встречается в ленте несколько раз
// (эмитент и каждый инсайдер). updated — время из ленты, но ИСТИНА — <ACCEPTANCE-DATETIME> в самой форме.
export function parseAtom(xml) {
  const out = [], seen = new Set();
  for (const m of String(xml ?? '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const acc = /accession-number=(\d{10}-\d{2}-\d{6})/.exec(e)?.[1] ?? /\/(\d{10}-\d{2}-\d{6})-index\.htm/.exec(e)?.[1];
    const href = /<link[^>]*href="([^"]+)"/.exec(e)?.[1] ?? '';
    const cik = /\/data\/(\d+)\//.exec(href)?.[1];
    const form = /<category[^>]*term="([^"]+)"/.exec(e)?.[1] ?? /<title>\s*([^\s<]+)/.exec(e)?.[1] ?? null;
    if (!acc || !cik || seen.has(acc)) continue;
    seen.add(acc);
    // «Filed:» — дата подачи по правилам SEC (та же, что в дневном индексе); в ленте она лежит в экранированном описании записи
    const filed = /Filed:(?:&lt;\/b&gt;|<\/b>)?\s*(\d{4}-\d{2}-\d{2})/.exec(e)?.[1] ?? null;
    out.push({ acc, cik: Number(cik), form, updated: /<updated>([^<]+)<\/updated>/.exec(e)?.[1] ?? null, filed });
  }
  return out;
}
// Путь полного .txt формы под Archives/ (fetchFiling добавляет https://www.sec.gov/Archives/)
export const filingPath = (cik, acc) => `edgar/data/${cik}/${acc.replace(/-/g, '')}/${acc}.txt`;
