# Вечерний сборщик 840 — выкладка на VPS

Что это и зачем — `docs/ВЕЧЕРНЯЯ-СХЕМА.md`. Здесь — шаги. На сервере: пользователь `dash`, код `/srv/dash/repo-840`,
env `/usr/local/etc/insider840-evening/env`, состояние `/var/lib/insider840-evening`, юнит и таймер
`/etc/systemd/system/insider840-evening.{service,timer}` (таймер: пн–пт 15:55 по Нью-Йорку, сборщик работает до 20:35 ET).

## Шаги

1. **Слить PR** (порядок: основной список → этот). Слияние выкладывает воркер (`worker.yml`: ответ получает `b, a, bs, as, pp, pt, pre, prt`)
   и обновляет `daily.yml` (шаг «Журнал вечерней схемы» забирает ветку `paper`).
2. **Deploy-ключ paper.** Нужен ОДИН ключ: ed25519, файл `/srv/dash/.ssh/deploy-840-paper` (владелец `dash`, режим 0600),
   публичная часть — deploy-ключ репозитория `ML371KL/temp-zero-inode-840` **с правом записи**:
   ```bash
   sudo -u dash ssh-keygen -t ed25519 -N '' -C insider840-paper -f /srv/dash/.ssh/deploy-840-paper
   gh repo deploy-key add /srv/dash/.ssh/deploy-840-paper.pub --repo ML371KL/temp-zero-inode-840 --allow-write -t insider840-paper
   ```
   Ключ с записью пишет в любую ветку репозитория — см. «Безопасность deploy-ключа» в `docs/ВЕЧЕРНЯЯ-СХЕМА.md` (защитить `main` или вынести
   журнал в отдельный репозиторий).
3. **Установка** (от root, из клона): `sudo bash ops/insider840-evening/install.sh`. Идемпотентно: ставит код (анонимный клон открытого репозитория),
   env из `env.example`, рабочую копию ветки `paper` (создаёт ветку, если её нет), юнит и таймер, прогоняет проверку окружения
   (`probe-quotes.mjs --check`: SEC, воркер без заголовка Origin, доступ git по ключу). Без ключа таймер не включается.
4. **Тревоги.** В `dash-alert` (репо 839, `ops/dash-alert`) добавить ветку, иначе тревога придёт родовым именем юнита:
   `insider840-evening*)  subject="840 · вечерний сбор";  key="collector-840-evening";;`
   (панели без публикации с VPS в `PANELS` сторожа `dash-watch` заводить не нужно — у этого юнита нет страницы).
5. **Проба источников — вечером по Нью-Йорку** (16:05–19:55 ET, то есть 00:05–03:55 МСК):
   ```bash
   sudo -u dash bash -c 'cd /srv/dash/repo-840 && node scripts/evening/probe-quotes.mjs AAPL,MSFT,MGM --nasdaq --out /tmp/probe.json'
   ```
   Покажет по каждой бумаге и IWM: что отдал воркер (bid/ask/вечерняя цена и её время), годна ли книга, и то же по api.nasdaq.com.
   Если у nasdaq книга годна, а у воркера нет — `EVENING_NASDAQ=1` в env (запросы к nasdaq — по одному на тикер, с паузой 0,7 с).
6. **Первый вечер.** Таймер стартует сам. Контроль: `journalctl -u insider840-evening -e`; в конце вечера (≈20:36 ET) в ветке `paper`
   появляется `log/ГГГГ-ММ-ДД.jsonl`; на следующий день `daily.yml` покажет шаг «Журнал вечерней схемы», а на панели — блок
   «Вечерняя схема на бумаге против текущей» (первые числа — когда у событий закроется D+1).

## Ручной запуск и откат

- Пробный прогон без записи и push: `sudo -u dash bash -c 'cd /srv/dash/repo-840 && node scripts/evening/collector.mjs --dir /tmp/paper-test --once --dry-run'`.
- Остановить: `sudo systemctl disable --now insider840-evening.timer` (журнал и ветка остаются).
- Удалить: убрать юнит и таймер из `/etc/systemd/system`, `systemctl daemon-reload`; каталог состояния и ключ — по желанию.
