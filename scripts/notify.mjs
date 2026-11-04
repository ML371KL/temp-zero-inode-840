// Telegram-уведомления. Повод ровно один: ВЫШЕЛ УТРЕННИЙ СПИСОК — покупки инсайдеров по подачам
// последнего дня, которые можно купить на открытии следующего торгового дня и продать на его
// закрытии (D+1; ревизия 04.11.2026 и независимая проверка, docs/ЧТО-РАБОТАЕТ.md). Одно письмо на
// дату подачи. Если основной список (оборот от $10 млн в день, скор от 2) пуст, письмо всё равно уходит — коротким
// «сигналов нет» за день, для которого собран список (morning.listFor): иначе тишина не отличалась бы от
// «конвейер встал» (ревизия данных 04.11.2026, П14). Письма о позициях рабочего набора «у максимума, 3 мес.»
// убраны: набор альфы не дал.
//
// Без секретов (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) в чат ничего не уходит — прод не блокирует.
// Состояние «что уже отправлено» — data/state/notify.json (живёт на ветке data). Дата попадает
// туда только ПОСЛЕ того, как Telegram принял сообщение о ней; недоставленное сообщение даёт
// ненулевой код выхода и уходит следующим прогоном.
// Режимы: --dry-run (в сеть не ходит, состояние двигает), --preview (последний непустой список
// как образец, состояние не трогает), --test (проверка связки), --any-date (не проверять свежесть).
//
// Письмо может уйти из двух мест: с VPS сразу после индекса EDGAR (~22:05 ET, scripts/vps/morning-build.mjs) и из ежедневной
// сборки на GitHub (позже, полным пересчётом). Чтобы не продублировать, отправитель после доставки кладёт в воркер отметку
// PUT /morning/letter/ДАТА (нужен PAPER_TOKEN — он только на VPS), а перед отправкой читает её (GET, без токена): отметка есть —
// письмо за эту дату уже ушло, дата записывается отправленной без повторной отправки. VPS дополнительно видит ключи ветки data
// (state/notify.json от GitHub). --sender vps|github (или MORNING_SENDER) говорит, кто мы. Воркер не ответил — отправляем:
// пропущенное письмо хуже редкого дубля.
// Если полный пересчёт на GitHub разошёлся со списком VPS (morning.crossCheck.same === false, пишет scripts/crosscheck.mjs) и письмо
// о списке отправил VPS, уходит короткое уточнение (ключ fix|ДАТА, раз на дату).
import { readJson, writeJson, isoToday, addDaysIso } from './lib/util.mjs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function argVal(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const DATA = argVal('--data', 'data');
const SITE = argVal('--site', 'site');
const DRY = args.includes('--dry-run');
const SENDER = argVal('--sender', process.env.MORNING_SENDER || 'github');
const MORNING_URL = (process.env.MORNING_URL || 'https://radar840-quotes.financehub.workers.dev').replace(/\/$/, '');
const MARKER_TOKEN = process.env.PAPER_TOKEN || '';
const PREVIEW = args.includes('--preview');   // показать последний непустой список, не трогая состояние

const SITE_URL = 'https://ml371kl.github.io/temp-zero-inode-840/';
const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;

// ---------- отправка ----------
const plain = s => String(s).replace(/<[^>]+>/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Сроки ответа. Без них зависший Telegram или хаб держали бы шаг минутами (у fetch свой
// срок — 300 с на заголовки), а прогон радара целиком — до его общего тайм-аута.
const TG_TIMEOUT_MS = 15000;
const NEXUS_TIMEOUT_MS = 5000;
// 429 с запретом длиннее минуты не ждём: позиция останется неотправленной и уйдёт следующим
// прогоном, а держать ежедневное обновление ради одного письма незачем.
const RETRY_AFTER_MAX_S = 60;

// Один запрос к Telegram. Обрыв соединения, срок ответа и тело ошибки разбираются здесь же:
// до 29.10.2026 сетевая ошибка вылетала необработанным исключением, а позиция к этому
// моменту уже числилась отправленной.
async function tgOnce(payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, parse_mode: 'HTML', disable_web_page_preview: true, ...payload }),
      signal: AbortSignal.timeout(TG_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => '');
    let retryAfter = null;
    try { retryAfter = JSON.parse(body)?.parameters?.retry_after ?? null; } catch { /* не JSON */ }
    return { ok: false, status: res.status, retryAfter, why: `HTTP ${res.status}: ${body.slice(0, 300)}` };
  } catch (error) {
    const why = error?.name === 'TimeoutError'
      ? `нет ответа за ${TG_TIMEOUT_MS / 1000} с`
      : `сеть: ${error?.cause?.code || error?.cause?.message || error?.message || error}`;
    return { ok: false, status: 0, retryAfter: null, why };
  }
}

// Повтор в том же прогоне — только на 429: там Telegram сам называет срок, и второй запрос
// не может продублировать уже доставленное. Прочие отказы не повторяются здесь — позиция
// остаётся неотправленной до следующего прогона, а шаг завершается с ошибкой.
async function tg(payload) {
  let r = await tgOnce(payload);
  if (!r.ok && r.status === 429) {
    const wait = r.retryAfter == null ? 1 : Number(r.retryAfter);
    if (Number.isFinite(wait) && wait >= 0 && wait <= RETRY_AFTER_MAX_S) {
      console.log(`[notify] Telegram 429: повтор через ${wait} с`);
      await sleep(wait * 1000);
      r = await tgOnce(payload);
    } else {
      console.error(`[notify] Telegram 429 с запретом на ${r.retryAfter} с — в этом прогоне не ждём`);
    }
  }
  // Разметку Telegram не разобрал — тот же текст простым: сообщение важнее шрифта (стандарт 29.10.2026).
  if (!r.ok && r.status === 400 && /can't parse entities/i.test(r.why)) {
    console.error(`[notify] Telegram не разобрал разметку — повтор простым текстом (${r.why.slice(0, 120)})`);
    const text = plain(payload.text).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    r = await tgOnce({ ...payload, text, parse_mode: undefined });
  }
  if (!r.ok) console.error(`[notify] Telegram не принял сообщение — ${r.why}`);
  return r.ok;
}

// Копия каждого сообщения уходит в приватную ленту NEXUS. Канал best-effort: его отказ
// никогда не блокирует Telegram и ежедневную публикацию радара. Молчать при этом нельзя —
// раньше ненастроенное зеркало не оставляло в логе ни строчки, и «почему на хабе пусто»
// было нечем ответить.
// eventId — ключ дедупликации хаба (он хранит событие по хешу «источник + eventId» и повтор
// игнорирует). Без него ключом служил сам текст, а в карточке есть цена «сейчас», которая
// меняется каждый день: досылка недоставленного письма на следующий день легла бы в ленту
// второй записью.
async function sendNexusEvent(text, eventId) {
  const url = process.env.NEXUS_EVENTS_URL;
  const nexusToken = process.env.NEXUS_INGEST_TOKEN;
  if (!url || !nexusToken) {
    console.log('[notify] NEXUS не настроен (нет NEXUS_EVENTS_URL или NEXUS_INGEST_TOKEN) — зеркало пропущено');
    return false;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${nexusToken}` },
      body: JSON.stringify({ source: '840', text: plain(text), occurredAt: new Date().toISOString(), ...(eventId ? { eventId } : {}) }),
      signal: AbortSignal.timeout(NEXUS_TIMEOUT_MS),
    });
    if (!res.ok) { console.error('[notify] NEXUS HTTP', res.status, (await res.text()).slice(0, 200)); return false; }
    console.log('[notify] NEXUS: событие принято');
    return true;
  } catch (error) {
    console.error('[notify] NEXUS недоступен:', error?.message || error);
    return false;
  }
}

// Единственная дверь наружу. Всё, что бот показывает в Telegram, обязано попасть и в ленту
// NEXUS — иначе очередной путь (тест, предпросмотр, боевая рассылка) молча обойдёт зеркало.
// Ровно это и случилось: предпросмотр слал только в чат, и на хабе сообщения не было.
// Отсутствие секретов Telegram больше не отменяет зеркало: это два независимых канала.
// Исход — по Telegram: 'sent' (принял), 'fail' (не принял — позиция остаётся неотправленной),
// 'off' (секретов нет, слать некуда; состояние в этом случае двигается, иначе подключение
// секретов вывалило бы разом всю неделю).
async function send(text, markup, eventId) {
  let outcome = 'off';
  if (token && chat) outcome = (await tg({ text, reply_markup: markup })) ? 'sent' : 'fail';
  else console.log('[notify] секреты Telegram не заданы — отправка в чат пропущена');
  await sendNexusEvent(text, eventId);
  return outcome;
}

// ---------- отметка «письмо отправлено» в воркере ----------
// get: объект отметки { by, at, ok } | null (нет) | undefined (воркер не ответил — неизвестно, отправляем)
async function markerGet(date) {
  try {
    const r = await fetch(`${MORNING_URL}/morning/letter/${date}`, { signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return null;
    if (!r.ok) { console.error(`[notify] отметка письма: HTTP ${r.status} — считаем, что письма не было`); return undefined; }
    return await r.json();
  } catch (error) {
    console.error('[notify] отметка письма недоступна:', error?.message || error);
    return undefined;
  }
}
// put: пишем только там, где есть токен приёма (VPS); три попытки. false — отметка не легла: дубль возможен, об этом в лог.
async function markerPut(date) {
  if (!MARKER_TOKEN) return false;
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(`${MORNING_URL}/morning/letter/${date}`, {
        method: 'PUT', headers: { Authorization: `Bearer ${MARKER_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ by: SENDER, at: new Date().toISOString() }), signal: AbortSignal.timeout(8000),
      });
      if (r.ok) return true;
      console.error(`[notify] отметка письма не принята: HTTP ${r.status}`);
    } catch (error) { console.error('[notify] отметка письма не отправлена:', error?.message || error); }
    await sleep(1500);
  }
  console.error(`[notify] ВНИМАНИЕ: письмо за ${date} ушло, а отметки в воркере нет — ежедневная сборка на GitHub может отправить его повторно`);
  return false;
}

// ---------- форматирование (единый стиль сообщений панелей, 29.10.2026) ----------
// Пометка панели — первым словом заголовка, как на карточке хаба NEXUS. Числа — по-русски: запятая,
// «−», разряды неразрывным пробелом с 10 000 (четырёхзначные слитно), «$» перед числом, процент
// слитно. Даты — «27.10», год — только не текущий; время — по Москве с пометкой «МСК».
const PANEL_TAG = 'Инсайдерский радар';
const NBSP = ' ';
const MINUS = '−';
const MSK_MS = 3 * 3600e3;
const today = isoToday();
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Одна функция на число: digits — знаков после запятой; fixed — держать нули («$22,70»); sign — «+».
function fmtNum(x, digits = 1, { fixed = false, sign = false } = {}) {
  if (!Number.isFinite(x)) return '—';
  const [int, frac = ''] = Math.abs(x).toFixed(digits).split('.');
  const tail = fixed ? frac : frac.replace(/0+$/, '');
  const zero = /^0*$/.test(int + tail);
  const body = (int.length >= 5 ? int.replace(/\B(?=(\d{3})+$)/g, NBSP) : int) + (tail ? ',' + tail : '');
  return (zero ? '' : x < 0 ? MINUS : sign ? '+' : '') + body;
}
const p2 = n => String(n).padStart(2, '0');
const mskYear = () => new Date(Date.now() + MSK_MS).getUTCFullYear();
// «2026-10-27» -> «27.10»; дата не текущего года — с годом: «26.01.2027».
function fmtDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso ?? '')) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${p2(d)}.${p2(m)}` + (y === mskYear() ? '' : `.${y}`);
}
// Момент по Москве: «29.10, 09:15 МСК».
function fmtMoment(ms) {
  const d = new Date(ms + MSK_MS);
  return `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}${d.getUTCFullYear() === mskYear() ? '' : '.' + d.getUTCFullYear()}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} МСК`;
}
const money = v => v >= 1e6 ? `$${fmtNum(v / 1e6, v >= 1e7 ? 0 : 1)}${NBSP}млн` : `$${fmtNum(v / 1e3, 0)}${NBSP}тыс.`;
// Заголовок и подвал — одни на все сообщения панели: «<эмодзи> Панель · событие» и
// «Открыть панель · время МСК». У событий радара своего времени нет — в подвале время прогона.
const head = (emoji, title) => `${emoji} <b>${esc(PANEL_TAG)} · ${title}</b>`;
const footer = () => `<a href="${SITE_URL}">Открыть панель</a> · ${fmtMoment(Date.now())}`;
const ROMAN = /^(?:I{1,3}|IV|VI{0,3}|IX|X)$/;
const FORCE = { LTD: 'Ltd', LTDA: 'Ltda' };   // юрформы без гласных, которые всё же не аббревиатуры
// «EQUITY BANCSHARES INC» -> «Equity Bancshares Inc», но «CVB» и «LLC» остаются заглавными:
// сплошной капс в письме читается как крик, а обычный Title Case ломает аббревиатуры.
function nameCase(s) {
  return String(s ?? '').replace(/[A-Za-z][A-Za-z']*/g, w => {
    const u = w.toUpperCase();
    if (FORCE[u]) return FORCE[u];
    if (u.length <= 2 || ROMAN.test(u) || !/[AEIOUY]/.test(u)) return u;
    return u[0] + u.slice(1).toLowerCase();
  });
}
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return n + ' ' + (a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many);
};

// ---------- режим проверки связки ----------
if (args.includes('--test')) {
  if (!token || !chat) {
    console.error('[notify] ОШИБКА: не заданы TELEGRAM_BOT_TOKEN и/или TELEGRAM_CHAT_ID');
    console.error(`  токен: ${token ? 'задан (' + token.slice(0, 8) + '…)' : 'ОТСУТСТВУЕТ'}`);
    console.error(`  чат:   ${chat ? chat : 'ОТСУТСТВУЕТ'}`);
    process.exit(1);
  }
  const ok = 'sent' === await send(
    head('ℹ️', 'Проверка связи') + '\n'
    + 'Связка работает. Сюда приходит ровно одно событие: <b>утренний список</b> — покупки инсайдеров '
    + 'по вчерашним подачам в ликвидных бумагах (оборот от $10\u00a0млн в день, скор от 2).\n'
    + 'Только заявки на аукционы: MOO до 9:28 и MOC до 15:50 по Нью-Йорку. '
    + 'В дни без подходящих бумаг придёт короткое «сигналов нет»: тишина значит, что сборка не вышла.\n\n' + footer());
  if (ok) console.log('[notify] тестовое сообщение отправлено');
  process.exit(ok ? 0 : 1);
}

// ---------- данные ----------
const morning = readJson(join(SITE, 'data', 'morning.json'), null);
const statePath = join(DATA, 'state', 'notify.json');
const state = readJson(statePath, {});

// Основной список (оборот от $10 млн, скор от 2) — то, что уходит в письмо; остальные от $10 млн — одной строкой.
const mainOf = day => (day?.rows ?? []).filter(x => x.main);
const restOf = day => (day?.rows ?? []).filter(x => !x.main);
const days = (morning?.days ?? []);                       // от свежего дня к старому

// Следующий рабочий день после даты подачи (праздники не знаем): до его конца утренний список ещё
// пригоден. После — письмо «покупай на открытии» читалось бы задним числом, и слать его не нужно.
function nextBusinessDay(iso) {
  let d = addDaysIso(iso, 1);
  for (;;) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6) return d;
    d = addDaysIso(d, 1);
  }
}

// ---------- сообщение ----------
// Устройство письма: первая строка самодостаточна (в пуше видно только её), дальше — десять
// лучших по скору и сумме с пометками, правило исполнения и строка счётчика. Объяснений про
// методику в письме нет: они не меняются от письма к письму, их место — на панели.
const TAG_LABEL = { off: 'офицер', deep: 'просадка глубже 30%', big: '≥$1\u00a0млн' };
const TOP_N = 10;
const signed2 = x => fmtNum(x * 100, 2, { fixed: true, sign: true }) + '%';
function counterLine(c) {
  const s = c?.main;
  const from = fmtDate(c?.from);
  if (!s?.n) return `Счётчик с ${from}: сделок пока нет.`;
  return `Счётчик с ${from}: ${plural(s.n, 'сделка', 'сделки', 'сделок')}, среднее ${signed2(s.iwm.mean)} к IWM, ${signed2(s.spy.mean)} к S&P, в плюсе ${Math.round(s.iwm.win * 100)}%.`;
}
function rowLine(x) {
  const marks = (x.tags ?? []).map(t => TAG_LABEL[t]).filter(Boolean);
  return `<b>${esc(x.t)}</b> · ${esc(trunc(nameCase(x.name), 24))} · скор ${x.score} · ${money(x.val)}` + (marks.length ? ` · ${marks.join(', ')}` : '');
}
function trunc(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
// Пустой день: первая строка самодостаточна, как и у обычного письма. Бумаги со скором 0–1 упоминаются одной строкой.
// Индекс разобран не полностью — это сказано в письме: «сигналов нет» по неполным данным нельзя выдавать за полное «нет».
function emptyMessage(day, counter, cov) {
  const rest = restOf(day);
  const lines = [
    head('🔕', 'утренний список пуст'),
    `Подачи за ${fmtDate(day.date)} · основной список без бумаг: оборот от ${money(morning?.params?.dvMin ?? 1e7)}, скор от ${morning?.params?.scoreMin ?? 2}`,
  ];
  if (rest.length) lines.push(`Ещё ${plural(rest.length, 'бумага', 'бумаги', 'бумаг')} со скором 0–1 — на панели.`);
  if (cov?.status === 'partial' && cov.indexed > 0) lines.push(`Индекс разобран не полностью: ${cov.collected ?? 0} из ${cov.indexed} форм.`);
  lines.push('', counterLine(counter), '', footer());
  return lines.join('\n');
}
// Уточнение после полной пересборки: чем основной список отличается от того, что ушло с VPS. Строки — тикер, скор, сумма.
function fixMessage(cc) {
  const lines = [head('🔁', 'список уточнён'), `Подачи за ${fmtDate(cc.listFor)} · полная пересборка изменила основной список:`];
  const d = cc.diff ?? [];
  const show = d.slice(0, TOP_N).map(x => {
    const tail = `<b>${esc(x.t)}</b> · ${esc(trunc(nameCase(x.name), 24))}`;
    if (x.was === null) return `+ ${tail} · скор ${x.now}${x.val ? ' · ' + money(x.val) : ''}`;
    if (x.now === null) return `− ${tail} убрана`;
    return `≈ ${tail} · скор ${x.was} → ${x.now}`;
  });
  lines.push(...show);
  if (d.length > TOP_N) lines.push(`и ещё ${d.length - TOP_N} — на панели`);
  lines.push('', 'Актуальный список — на панели.', '', footer());
  return lines.join('\n');
}
function morningMessage(day, counter, note = '') {
  const main = mainOf(day), rest = restOf(day);
  const lines = [
    head('🔔', 'утренний список'),
    `Подачи за ${fmtDate(day.date)} · ${plural(main.length, 'бумага', 'бумаги', 'бумаг')}: оборот от ${money(morning?.params?.dvMin ?? 1e7)}, скор от ${morning?.params?.scoreMin ?? 2}`,
    '',
    ...main.slice(0, TOP_N).map(rowLine),
  ];
  if (main.length > TOP_N) lines.push(`и ещё ${main.length - TOP_N} — на панели`);
  if (rest.length) lines.push('', `Ещё ${plural(rest.length, 'бумага', 'бумаги', 'бумаг')} со скором 0–1 — на панели.`);
  // Исполнение — только аукционы: около 60% перевеса дня набирается в первые 5 минут после открытия
  lines.push('', 'Только заявки на аукционы: MOO до 9:28 и MOC до 15:50 по Нью-Йорку. Около 60% перевеса дня — первые 5 минут: покупка по рынку после открытия его съедает.', counterLine(counter));
  if (note) lines.push('', note);
  lines.push('', footer());
  return lines.join('\n');
}

// ---------- предпросмотр формата: последний непустой список, состояние не трогаем ----------
if (PREVIEW) {
  const day = days.find(d => mainOf(d).length);
  if (!day) { console.log('[notify] непустых списков нет'); process.exit(0); }
  // Оговорка обязательна в обоих каналах: образец неотличим от боевого письма.
  const text = morningMessage(day, morning.counter, '<i>Это образец формата, а не новый список.</i>');
  if (DRY) { console.log('\n' + plain(text)); process.exit(0); }
  const ok = 'sent' === await send(text, undefined);
  console.log(ok ? '[notify] предпросмотр отправлен' : '[notify] предпросмотр в чат НЕ отправлен');
  process.exit(0);
}

// ---------- что уже отправляли ----------
// Ключ — дата подачи: `morning|YYYY-MM-DD`, одно письмо на дату. Версия нужна, чтобы смена
// схемы не отправила разом всю историю: первый прогон новой версии молча пересевает состояние
// (версия 4 — переход с писем о позициях рабочего набора на утренний список).
//
// «Отправил → запомнил»: дата попадает в sentMorning только после того, как Telegram принял
// сообщение, и состояние уходит на диск после КАЖДОГО такого сообщения. Недоставленное письмо
// остаётся неотправленным и уходит следующим прогоном, пока список не устарел; сам прогон
// при этом завершается с ошибкой.
const NOTIFY_VERSION = 4;
const seeding = !Array.isArray(state.sentMorning) || state.version !== NOTIFY_VERSION;
const sent = new Set(state.version === NOTIFY_VERSION ? (state.sentMorning ?? []) : []);
state.version = NOTIFY_VERSION;
delete state.sentTrades; delete state.sentPositions;   // ключи прежних схем больше не читаются
const dayId = d => `morning|${d.date}`;
function saveState() {
  state.sentMorning = [...sent].slice(-400);
  writeJson(statePath, state, true);
}

if (seeding) {
  for (const d of days) if (mainOf(d).length) sent.add(dayId(d));
  saveState();
  console.log(`[notify] первый прогон схемы v${NOTIFY_VERSION}: состояние пересеяно (${sent.size} списков), письма не шлём`);
  process.exit(0);
}
// Письма заслуживает день с основным списком и день, за который собран список (listFor), даже пустой. Покрытие индекса
// из state/live.json: «выходной» и «индекс не вышел» — не «сигналов нет» (первое не событие, второе — тревога сторожа),
// поэтому пустое письмо уходит при неизвестном покрытии, полном и частичном (в письме об этом сказано).
const listFor = morning?.listFor ?? days[0]?.date ?? null;
const cov = morning?.coverage ?? null;
const emptyOk = !cov || cov.status === 'complete' || cov.status === 'partial';
const hasLetter = d => mainOf(d).length > 0 || (d.date === listFor && emptyOk);
// Свежий список, о котором ещё не писали. --any-date снимает проверку свежести
// (ручной прогон после простоя).
const fresh = days.filter(d => hasLetter(d) && !sent.has(dayId(d))
  && (args.includes('--any-date') || today <= nextBusinessDay(d.date))).reverse();   // от старого к свежему
saveState();
// Уточнение по crossCheck может понадобиться и без новых списков: письмо ушло с VPS раньше, а пересчёт разошёлся с ним позже
if (!fresh.length && morning?.crossCheck?.same !== false) { console.log('[notify] новых утренних списков нет'); process.exit(0); }
console.log(`[notify] новых утренних списков: ${fresh.length}${fresh.some(d => !mainOf(d).length) ? ' (в том числе пустой день)' : ''}`);

// ---------- отправка ----------
// eventId — «840|morning|дата подачи»: список, доставленный повторно, на хабе ляжет на прежнюю запись.
const messages = fresh.map(d => ({ date: d.date, text: mainOf(d).length ? morningMessage(d, morning.counter) : emptyMessage(d, morning.counter, cov), markup: undefined, id: dayId(d), eventId: '840|' + dayId(d) }));

// Отметка в воркере: письмо за дату уже отправил другой отправитель — не повторяем, дату считаем отправленной.
// Читается и в пробном прогоне (только чтение); при ошибке воркера письмо уходит.
const already = [];
for (const m of [...messages]) {
  const mk = await markerGet(m.date);
  if (mk?.ok) {
    console.log(`[notify] письмо за ${m.date} уже отправлено (${mk.by}, ${mk.at}) — повторно не шлём`);
    sent.add(m.id); already.push(m.date);
    messages.splice(messages.indexOf(m), 1);
  }
}
if (already.length) saveState();

// Уточнение: полный пересчёт на GitHub разошёлся со списком, о котором написал VPS
const cc = morning?.crossCheck;
if (cc && cc.same === false && cc.listFor && (cc.diff ?? []).length && !sent.has(`fix|${cc.listFor}`)
  && (args.includes('--any-date') || today <= nextBusinessDay(cc.listFor)) && sent.has(dayId({ date: cc.listFor }))) {
  const mk = await markerGet(cc.listFor);
  if (mk?.by === 'vps' && mk.ok) messages.push({ date: null, text: fixMessage(cc), markup: undefined, id: `fix|${cc.listFor}`, eventId: `840|fix|${cc.listFor}` });
}
if (!messages.length) { console.log('[notify] писем к отправке нет'); process.exit(0); }

if (DRY) {
  // Пробный прогон «доставляет» в консоль и двигает состояние так же, как боевой: на этом
  // стоят самотесты последовательных прогонов. В сеть он не ходит.
  for (const m of messages) {
    console.log('\n' + '─'.repeat(46) + '\n' + plain(m.text));
    sent.add(m.id);
  }
  saveState();
  process.exit(0);
}

let okCount = 0, failCount = 0;
for (const [k, m] of messages.entries()) {
  // Telegram душит бота примерно на одном сообщении в секунду на чат
  if (k) await sleep(1200);
  const outcome = await send(m.text, m.markup, m.eventId);
  if (outcome === 'fail') { failCount++; continue; }
  if (outcome === 'sent') { okCount++; if (m.date) await markerPut(m.date); }
  sent.add(m.id);
  saveState();
}
console.log('[notify] отправлено в Telegram:', okCount, 'из', messages.length);
if (failCount) {
  // Ненулевой код — сигнал workflow: шаг помечается упавшим, а в конце прогона (после снимка
  // данных и публикации) отдельный шаг красит весь прогон.
  console.error(`[notify] НЕ доставлено: ${failCount} из ${messages.length} — списки остались неотправленными и уйдут следующим прогоном`);
  process.exit(1);
}
