// Общий слой: HTTP с троттлингом и ретраями, gzip-хелперы, TSV, даты.
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// SEC требует идентифицирующий User-Agent; лимит 10 req/s — держимся заметно ниже.
export const SEC_UA = 'InsiderRadar/1.0 (rodionkalmykov@gmail.com)';
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const hostState = new Map(); // host -> { nextAt }
const HOST_INTERVAL_MS = {
  'www.sec.gov': 140,          // ~7 req/s
  'data.sec.gov': 140,
  'query1.finance.yahoo.com': 350,
  'query2.finance.yahoo.com': 350,
  'stooq.com': 600,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function throttle(url, intervalMs = null) {
  const host = new URL(url).host;
  // intervalMs — свой минимум между запросами к хосту (вечерний сборщик держится не чаще 5 запросов в секунду к SEC)
  const interval = Math.max(intervalMs ?? 0, HOST_INTERVAL_MS[host] ?? 300);
  const st = hostState.get(host) ?? { nextAt: 0 };
  const now = Date.now();
  const wait = Math.max(0, st.nextAt - now);
  st.nextAt = Math.max(now, st.nextAt) + interval;
  hostState.set(host, st);
  if (wait > 0) await sleep(wait);
}

// База пауз между повторами. Переопределяется только самотестами (POLITE_BACKOFF_MS), иначе тест
// сбоя сети ждал бы десятки секунд.
const BACKOFF_MS = Number(process.env.POLITE_BACKOFF_MS ?? 1500);
// SEC отвечает 403 в двух разных случаях. Отсутствующий объект архива (праздничный или ещё не
// вышедший дневной индекс) — это 403 с XML хранилища `<Code>AccessDenied</Code>`: настоящий ответ,
// повторять нечего. Превышение лимита запросов — 403 с HTML-страницей («Request Rate Threshold
// Exceeded»): это сбой, его надо переждать и повторить, а не принимать за «файла нет» — иначе
// подача молча выпадает (так было до 11.2026).
// Подставной EDGAR самотестов (EDGAR_BASE) ведёт себя как SEC.
const isSecHost = url => {
  const u = new URL(url);
  if (/(^|\.)sec\.gov$/i.test(u.hostname)) return true;
  try { return !!process.env.EDGAR_BASE && u.host === new URL(process.env.EDGAR_BASE).host; } catch { return false; }
};
const isS3Missing = text => /<Code>(AccessDenied|NoSuchKey)<\/Code>/.test(text ?? '');

// Единая точка сетевых запросов: троттлинг по хосту, ретраи с экспоненциальной паузой.
// 404 не ретраится (это ответ, а не сбой). 429/5xx/сеть — ретраится; 403 sec.gov с HTML — тоже (лимит).
// Ответ с `missing: true` — «объекта нет» (404 или 403 хранилища); после исчерпания повторов — исключение.
export async function politeFetch(url, { ua = SEC_UA, retries = 4, timeoutMs = 60000, as = 'buffer', intervalMs = null } = {}) {
  let lastErr;
  const sec = isSecHost(url);
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(url, intervalMs);
    let rateLimited = false;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': ua, 'Accept-Encoding': 'gzip, deflate' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (res.status === 404) return { status: 404, body: null, missing: true };
      if (res.status === 403) {
        if (!sec) return { status: 403, body: null, missing: true };
        const text = await res.text().catch(() => '');
        if (isS3Missing(text)) return { status: 403, body: null, missing: true };
        rateLimited = true;
        throw new Error('HTTP 403 (лимит SEC)');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: res.status, body: as === 'text' ? buf.toString('utf8') : buf };
    } catch (e) {
      lastErr = e;
      // Лимит SEC снимается через ~10 минут бездействия; ждём дольше, чем при обычном сбое сети
      const pause = (rateLimited ? 4 : 1) * BACKOFF_MS * 2 ** attempt + Math.floor(BACKOFF_MS / 6 * (attempt + 1));
      if (attempt < retries) await sleep(pause);
    }
  }
  throw new Error(`politeFetch ${url}: ${lastErr?.message ?? lastErr}`);
}

export function readJsonGz(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'));
}
export function writeJsonGz(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gzipSync(JSON.stringify(obj), { level: 9 }));
}
export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function writeJson(path, obj, pretty = false) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, pretty ? JSON.stringify(obj, null, 1) : JSON.stringify(obj));
}

// TSV с заголовком -> массив объектов. Файлы SEC не содержат кавычек/экранирования.
export function parseTsv(text) {
  const lines = text.split('\n');
  const header = lines[0].replace(/\r$/, '').split('\t');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line) continue;
    const cells = line.split('\t');
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = cells[j] ?? '';
    out.push(row);
  }
  return out;
}

const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
// "27-DEC-2024" -> "2024-12-27"; пустое -> null
export function secDate(s) {
  if (!s) return null;
  const m = /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec(s.trim().toUpperCase());
  if (!m) return null;
  const mm = MONTHS[m[2]];
  return mm ? `${m[3]}-${mm}-${m[1]}` : null;
}

export function isoToday() { return new Date().toISOString().slice(0, 10); }

// Дата вида YYYY-MM-DD, которая действительно существует. Формы подают люди и агенты:
// в EDGAR встречаются опечатки («2026-06-31», обрезанные строки), и одна такая дата,
// дойдя до арифметики, роняет всю сборку.
export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function num(s) {
  if (s === null || s === undefined || s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}
