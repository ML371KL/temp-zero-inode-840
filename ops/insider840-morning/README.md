# Сборка утреннего списка 840 на VPS — выкладка

Что это и зачем — `docs/СБОРКА-НА-VPS.md`. Здесь — шаги. На сервере: пользователь `dash`, код `/srv/dash/repo-840` (тот же клон, что у ленты `insider840-feed`), env
`/usr/local/etc/insider840-morning/env`, состояние `/var/lib/insider840-morning` (рабочая копия ветки data ~400 МБ), юнит и таймер
`/etc/systemd/system/insider840-morning.{service,timer}` (таймер: пн–пт 22:03 по Нью-Йорку, скрипт повторяет попытки каждые 2 минуты до 23:30 ET).

## Шаги

1. **Воркер — вы, до установки** (токен `CLOUD` в репозитории недействителен, `worker.yml` воркер не выложит). Бакет `radar840-paper` и секрет `PAPER_TOKEN` уже есть.
   Нужно только выложить новый код воркера с маршрутами `/morning`, `/morning/letter/…` и `/bars`:
   ```bash
   cd worker && npx wrangler deploy
   curl -s -o /dev/null -w '%{http_code}\n' https://radar840-quotes.financehub.workers.dev/morning       # 404 — списка ещё нет, маршрут живой
   curl -s -H "Authorization: Bearer $PAPER_TOKEN" 'https://radar840-quotes.financehub.workers.dev/bars?symbols=SPY&from=2026-10-26' | head -c 200
   ```
2. **Слить PR** (порядок: определения отбора #9 → этот). После слияния `daily.yml` начнёт сверять свой список со списком VPS (необязательный шаг), панель — читать оба.
3. **Установка** (от root, из клона): `sudo bash ops/insider840-morning/install.sh`. Идемпотентно: код (`git pull --ff-only`), env из `env.example`, каталог состояния,
   юнит и таймер, проверка окружения (`scripts/vps/probe.mjs --check`: Node, git, место, SEC, ветка data, воркер `/morning`, токен, `/bars`). Впишите `PAPER_TOKEN`
   (секрет воркера, тот же, что задан командой `wrangler secret put PAPER_TOKEN`) и повторите установку — без токена таймер не включается.
4. **Письмо с VPS (по желанию).** Впишите `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` (те же, что секреты GitHub) — письмо будет уходить в ~22:10 ET, а не после ежедневной сборки.
   Пока они пусты, VPS только собирает и публикует список, письмо шлёт GitHub. Дубля не будет: отметка в воркере + ключи состояния. `NEXUS_*` — зеркало в хаб, необязательно.
5. **Тревоги.** В `dash-alert` (репо 839, `ops/dash-alert`) добавить ветку, иначе тревога придёт родовым именем юнита:
   `insider840-morning*)  subject="840 · утренний список";  key="morning-840";;`
   Сторож (`dash-watch`, вариант В3) читает `GET …/morning` и запасной `…/data/morning.json`: к 23:00 ET `listFor` = сегодня (рабочий день SEC), к 08:00 ET — последний рабочий день.
6. **Лента на весь день (по желанию, лучше сразу).** `sudo bash ops/insider840-feed/install.sh` — отдельный юнит собирает подачи с 06:00 до 22:00 ET в `/var/lib/insider840-feed`;
   в 22:03 сборка сверяет индекс с лентой, а если индекса нет к 23:30 ET, собирает список по ленте с пометкой `source: feed` и тревогой. Без ленты сборка работает только по индексу.
7. **Первый вечер.** Таймер стартует сам. Контроль: `journalctl -u insider840-morning -e` (строки «список за …», «отправлено в воркер», «готово»);
   `curl -s https://radar840-quotes.financehub.workers.dev/morning | head -c 300` — `builder: vps`, `listFor` = сегодня; утром `daily.yml` покажет шаг «Сверка со списком VPS».

## Ручной запуск и откат

- Пробный прогон без записи и писем (с токеном в окружении — бары идут через воркер):
  ```bash
  set -a; . /usr/local/etc/insider840-morning/env; set +a
  sudo -u dash --preserve-env=PAPER_URL,PAPER_TOKEN bash -c 'cd /srv/dash/repo-840 && node scripts/vps/morning-build.mjs --state /tmp/m840 --once --dry-run --no-letter'
  ```
- Запустить сейчас настоящую сборку: `sudo systemctl start insider840-morning` (день уже собран — скрипт скажет и выйдет; чтобы пересобрать, удалить `/var/lib/insider840-morning/done/ДАТА.json`).
- Остановить: `sudo systemctl disable --now insider840-morning.timer` — ежедневная сборка на GitHub продолжает работать как раньше.
- Сменить токен: `wrangler secret put PAPER_TOKEN` и новое значение в `/usr/local/etc/insider840-morning/env` на VPS.
- Сбросить рабочую копию данных: `sudo rm -rf /var/lib/insider840-morning/repo` — следующий запуск загрузит ветку заново (~13 с).
