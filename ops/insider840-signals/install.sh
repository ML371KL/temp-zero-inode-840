#!/usr/bin/env bash
# Установка сигнала в торговые часы (840, контур B бота) на VPS: справочник D−1 (ночной шаг) и процесс сигналов рядом с лентой.
# Запускать от root (sudo) из клона репозитория:
#   sudo bash ops/insider840-signals/install.sh
# Идемпотентно. Секретов не заводит: шагу справочника нужны PAPER_URL и PAPER_TOKEN из env сборки утреннего списка
# (/usr/local/etc/insider840-morning/env — ops/insider840-morning). Шаблон — как у остальных юнитов панели: пользователь dash,
# код /srv/dash/repo-840, состояние /var/lib.
# Юнит ленты (ops/insider840-feed) этот скрипт не трогает: шаг опроса 15 секунд в торговые часы и CPUWeight ставит её установщик.
set -euo pipefail

REPO_URL="https://github.com/ML371KL/temp-zero-inode-840.git"
CODE=/srv/dash/repo-840
STATE=/var/lib/insider840-signals
ENV_FILE=/usr/local/etc/insider840-morning/env
SRC="$(cd "$(dirname "$0")" && pwd)"
say() { printf '\n== %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "нет команды $1"; exit 1; }; }

[ "$(id -u)" = 0 ] || { echo "нужен root: sudo bash $0"; exit 1; }
need node; need git; need systemctl
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "нужен Node 20+, сейчас $(node --version)"; exit 1; }
id dash >/dev/null 2>&1 || { echo "нет пользователя dash — это не VPS панелей"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "нет $ENV_FILE — сначала ops/insider840-morning/install.sh (оттуда берутся адрес и токен воркера)"; exit 1; }
systemd-analyze calendar "Mon..Fri *-*-* 23:52:00 America/New_York" >/dev/null || { echo "systemd не понимает пояс в OnCalendar"; exit 1; }

say "код: $CODE"
if [ -d "$CODE/.git" ]; then
  sudo -u dash git -C "$CODE" pull --ff-only
else
  install -d -o dash -g dash "$(dirname "$CODE")"
  sudo -u dash git clone "$REPO_URL" "$CODE"
fi

say "состояние: $STATE (открыт на чтение: файлы сигналов дня читает бот, пользователь ib840)"
install -d -m 0755 -o dash -g dash "$STATE" "$STATE/ref" "$STATE/state" "$STATE/build"

say "юниты и таймеры"
for f in insider840-signals-ref.service insider840-signals-ref.timer insider840-signals.service insider840-signals.timer; do
  install -m 0644 "$SRC/$f" "/etc/systemd/system/$f"
done
systemctl daemon-reload

say "проверка: расчёт сигналов без записи (по тому, что уже лежит в журнале ленты; без справочника напишет «сигналов сегодня нет»)"
sudo -u dash bash -c "cd $CODE && node scripts/vps/signal-watch.mjs --dir $STATE --feed-dir /var/lib/insider840-feed --once --dry-run" | tail -5 || echo "(проверка не удалась — см. выше)"

systemctl enable --now insider840-signals-ref.timer insider840-signals.timer
systemctl list-timers 'insider840-signals*' --no-pager || true
echo
echo "Готово. Справочник соберётся в 23:52 ET (сейчас: sudo systemctl start insider840-signals-ref — около 10 минут);"
echo "процесс сигналов стартует в 09:25 ET. Журналы: journalctl -u insider840-signals-ref -e; journalctl -u insider840-signals -e"
