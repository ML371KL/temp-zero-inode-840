#!/usr/bin/env bash
# Установка сборщика ленты формы 4 на весь день (840) на VPS. Запускать от root (sudo) из клона репозитория:
#   sudo bash ops/insider840-feed/install.sh
# Идемпотентно. Секретов и env не нужно. Шаблон — как у вечернего сборщика: пользователь dash, код /srv/dash/repo-840, состояние /var/lib.
# Журнал читает сборка утреннего списка (ops/insider840-morning): она сверяет индекс EDGAR с лентой в 22:03 ET.
set -euo pipefail

REPO_URL="https://github.com/ML371KL/temp-zero-inode-840.git"
CODE=/srv/dash/repo-840
STATE=/var/lib/insider840-feed
SRC="$(cd "$(dirname "$0")" && pwd)"
say() { printf '\n== %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "нет команды $1"; exit 1; }; }

[ "$(id -u)" = 0 ] || { echo "нужен root: sudo bash $0"; exit 1; }
need node; need git; need systemctl
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "нужен Node 20+, сейчас $(node --version)"; exit 1; }
id dash >/dev/null 2>&1 || { echo "нет пользователя dash — это не VPS панелей"; exit 1; }
systemd-analyze calendar "Mon..Fri *-*-* 06:00:00 America/New_York" >/dev/null || { echo "systemd не понимает пояс в OnCalendar"; exit 1; }

say "код: $CODE"
if [ -d "$CODE/.git" ]; then
  sudo -u dash git -C "$CODE" pull --ff-only
else
  install -d -o dash -g dash "$(dirname "$CODE")"
  sudo -u dash git clone "$REPO_URL" "$CODE"
fi

say "состояние: $STATE"
install -d -m 0750 -o dash -g dash "$STATE"

say "юнит и таймер"
install -m 0644 "$SRC/insider840-feed.service" /etc/systemd/system/insider840-feed.service
install -m 0644 "$SRC/insider840-feed.timer" /etc/systemd/system/insider840-feed.timer
systemctl daemon-reload

say "проверка: один такт ленты без записи журнала"
sudo -u dash bash -c "cd $CODE && node scripts/vps/feed-collector.mjs --dir /tmp/feed-probe --once --dry-run" || echo "(такт не удался — см. выше)"

systemctl enable --now insider840-feed.timer
systemctl list-timers insider840-feed.timer --no-pager || true
echo
echo "Готово. Лог дня: journalctl -u insider840-feed -e   Запустить сейчас (в любое время суток, сборщик отработает один такт и вечером остановится по --until): sudo systemctl start insider840-feed"
