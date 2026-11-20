// Сводка бота ib840 «что дал каждый контур» → блок bot списка, который ночная сборка VPS отправляет в воркер.
// Бот пишет файл /var/lib/ib840-public/split.json (числа сделок и доходности в долях, без сумм счёта, тикеров и номеров);
// страница читает список из воркера и рисует блок (web/botsplit.js, web/app.js).
//
// Главное правило: приложение сводки НИКОГДА не меняет и не срывает сам список — утром по нему торгует бот.
// - текст списка не пересобирается: блок вставляется перед последней скобкой, остальные байты те же;
// - результат разбирается заново и сверяется со списком — отличаться может только ключ bot;
// - любая неудача (файла нет, не JSON, поле не того вида, устарел, велик) возвращает исходный текст и причину.
import { readFileSync, statSync } from 'node:fs';
import { cleanBotSplit, botSplitFresh, BOT_SPLIT_MAX_AGE_DAYS } from '../../web/botsplit.js';

export const BOT_SPLIT_FILE = '/var/lib/ib840-public/split.json';
export const BOT_SPLIT_MAX_BYTES = 16 * 1024;      // сводка — меньше килобайта; больше — это не она

// (текст morning.json, текст сводки бота) → { text, attached, note }. Не бросает исключений.
export function attachBotSplit(morningText, splitText, nowMs = Date.now()) {
  const keep = note => ({ text: morningText, attached: false, note });
  try {
    if (typeof splitText !== 'string' || !splitText.trim()) return keep('сводка бота пуста');
    if (splitText.length > BOT_SPLIT_MAX_BYTES) return keep('сводка бота больше ' + BOT_SPLIT_MAX_BYTES + ' байт');
    let raw;
    try { raw = JSON.parse(splitText); } catch { return keep('сводка бота — не JSON'); }
    const why = {};
    const clean = cleanBotSplit(raw, why);
    if (!clean) return keep('сводка бота не прошла проверку полей: ' + why.text);
    if (!botSplitFresh(clean, nowMs)) return keep(`сводка бота старше ${BOT_SPLIT_MAX_AGE_DAYS} дней (собрана ${clean.built})`);
    const before = JSON.parse(morningText);
    if (!before || typeof before !== 'object' || Array.isArray(before)) return keep('список — не объект');
    if ('bot' in before) return keep('в списке уже есть блок bot');
    const end = morningText.lastIndexOf('}');
    if (end < 1) return keep('в тексте списка нет закрывающей скобки');
    const text = morningText.slice(0, end) + ',"bot":' + JSON.stringify(clean) + morningText.slice(end);
    // сверка: после вставки список тот же, добавился только ключ bot
    const after = JSON.parse(text);
    const { bot, ...rest } = after;
    if (JSON.stringify(rest) !== JSON.stringify(before) || JSON.stringify(bot) !== JSON.stringify(clean)) return keep('после вставки список изменился — вставка отменена');
    return { text, attached: true, note: `сводка бота приложена: живых дней ${clean.days}, сделок ${clean.total.n}, собрана ${clean.built}` };
  } catch (e) {
    return keep('сводка бота не приложена: ' + (e?.message ?? e));
  }
}

// То же с чтением файла. Файла нет — обычное дело (бот ещё не писал): список уходит без блока.
export function attachBotSplitFile(morningText, file = BOT_SPLIT_FILE, nowMs = Date.now()) {
  let splitText;
  try {
    const st = statSync(file);
    // только обычный файл: канал (FIFO) или устройство на этом месте подвесили бы чтение, а с ним и отправку списка
    if (!st.isFile()) return { text: morningText, attached: false, note: `сводки бота нет (${file}: не обычный файл)` };
    if (st.size > BOT_SPLIT_MAX_BYTES) return { text: morningText, attached: false, note: 'сводка бота больше ' + BOT_SPLIT_MAX_BYTES + ' байт' };
    splitText = readFileSync(file, 'utf8');
  } catch (e) {
    return { text: morningText, attached: false, note: `сводки бота нет (${file}: ${e?.code ?? e?.message ?? e})` };
  }
  return attachBotSplit(morningText, splitText, nowMs);
}
