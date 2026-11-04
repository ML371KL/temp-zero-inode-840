# Вечерний сборщик 840 — выкладка на VPS

Что это и зачем — `docs/ВЕЧЕРНЯЯ-СХЕМА.md`. Здесь — шаги. На сервере: пользователь `dash`, код `/srv/dash/repo-840`,
env `/usr/local/etc/insider840-evening/env`, состояние `/var/lib/insider840-evening`, юнит и таймер
`/etc/systemd/system/insider840-evening.{service,timer}` (таймер: пн–пт 15:55 по Нью-Йорку, сборщик работает до 20:35 ET).

Доставка: сборщик → `PUT /paper/log/ГГГГ-ММ-ДД.jsonl` в воркер `radar840-quotes` (привязка R2 `PAPER`, бакет `radar840-paper`) →
ежедневная сборка читает `GET /paper/index` и `GET /paper/log/...` без токена. Ключей git и записи в репозиторий не нужно.

## Шаги

1. **Бакет и секрет — вы, до выкладки воркера** (токен `CLOUD` в репозитории недействителен, `worker.yml` воркер не выложит):
   ```bash
   cd worker
   npx wrangler r2 bucket create radar840-paper
   openssl rand -hex 32                                   # это и есть PAPER_TOKEN; сохраните — понадобится на VPS
   npx wrangler secret put PAPER_TOKEN                    # вставить значение
   npx wrangler deploy                                    # воркер с приёмом журнала и полями bid/ask
   curl -s https://radar840-quotes.financehub.workers.dev/paper/index      # {"files":[]} — привязка работает
   ```
2. **Слить PR** (порядок: основной список → этот). `daily.yml` начнёт забирать журнал из воркера (необязательный шаг).
3. **Установка** (от root, из клона): `sudo bash ops/insider840-evening/install.sh`. Идемпотентно: код (анонимный клон открытого репозитория),
   env из `env.example`, каталог состояния, юнит и таймер, проверка окружения (`probe-quotes.mjs --check`: SEC, воркер без заголовка Origin,
   `GET /paper/index`, токен приёма). Впишите `PAPER_TOKEN` в `/usr/local/etc/insider840-evening/env` и запустите установку ещё раз —
   без токена таймер не включается.
4. **Тревоги.** В `dash-alert` (репо 839, `ops/dash-alert`) добавить ветку, иначе тревога придёт родовым именем юнита:
   `insider840-evening*)  subject="840 · вечерний сбор";  key="collector-840-evening";;`
   (панели без публикации с VPS в `PANELS` сторожа `dash-watch` заводить не нужно — у этого юнита нет страницы).
5. **Проба источников — вечером по Нью-Йорку** (16:05–19:55 ET, то есть 00:05–03:55 МСК):
   ```bash
   sudo -u dash bash -c 'cd /srv/dash/repo-840 && node scripts/evening/probe-quotes.mjs AAPL,MSFT,MGM --nasdaq --out /tmp/probe.json'
   ```
   Покажет по каждой бумаге и IWM: что отдал воркер (bid/ask/вечерняя цена и её время), годна ли книга, и то же по api.nasdaq.com.
   Если у nasdaq книга годна, а у воркера нет — `EVENING_NASDAQ=1` в env (запросы к nasdaq — по одному на тикер, с паузой 0,7 с).
6. **Первый вечер.** Таймер стартует сам. Контроль: `journalctl -u insider840-evening -e` (строки «журнал … отправлен»);
   `curl -s .../paper/index` показывает файл уже в течение вечера (отправка каждые 5 минут); на следующий день `daily.yml` покажет шаг
   «Журнал вечерней схемы», а на панели — блок «Вечерняя схема на бумаге против текущей» (первые числа — когда у событий закроется D+1).

## Ручной запуск и откат

- Пробный прогон без записи и отправки: `sudo -u dash bash -c 'cd /srv/dash/repo-840 && node scripts/evening/collector.mjs --dir /tmp/paper-test --once --dry-run'`.
- Остановить: `sudo systemctl disable --now insider840-evening.timer` (журнал на диске и в R2 остаётся).
- Удалить: убрать юнит и таймер из `/etc/systemd/system`, `systemctl daemon-reload`; каталог состояния — по желанию.
- Сменить токен: `wrangler secret put PAPER_TOKEN` и новое значение в env на VPS (читать журнал токен не нужен — он только на запись).
