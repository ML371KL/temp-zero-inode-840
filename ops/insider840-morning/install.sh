#!/usr/bin/env bash
# Установка сборки утреннего списка 840 на VPS. Запускать от root (sudo) из клона репозитория:
#   sudo bash ops/insider840-morning/install.sh
# Идемпотентно: повторный запуск ничего не ломает. Таймер не включает, пока в env нет PAPER_TOKEN, и говорит об этом.
# Шаблон — обычный для панелей: пользователь dash, код /srv/dash/repo-840 (тот же клон, что у ленты insider840-feed), env в /usr/local/etc,
# состояние /var/lib. Код обновляется ТОЛЬКО этим скриптом (git pull --ff-only); сам юнит клон не трогает.
# Ключей git и доступа к GitHub на запись не нужно: ветка data читается анонимно, список уходит в воркер по токену.
set -euo pipefail

REPO_URL="https://github.com/ML371KL/temp-zero-inode-840.git"       # репозиторий открытый: код — анонимным клоном, без ключа
CODE=/srv/dash/repo-840
ETC=/usr/local/etc/insider840-morning
STATE=/var/lib/insider840-morning
SRC="$(cd "$(dirname "$0")" && pwd)"
say() { printf '\n== %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "нет команды $1"; exit 1; }; }

[ "$(id -u)" = 0 ] || { echo "нужен root: sudo bash $0"; exit 1; }
need node; need git; need systemctl
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "нужен Node 20+, сейчас $(node --version)"; exit 1; }
id dash >/dev/null 2>&1 || { echo "нет пользователя dash — это не VPS панелей"; exit 1; }
systemd-analyze calendar "Mon..Fri *-*-* 22:03:00 America/New_York" >/dev/null || { echo "systemd не понимает пояс в OnCalendar"; exit 1; }

say "код: $CODE"
if [ -d "$CODE/.git" ]; then
  sudo -u dash git -C "$CODE" pull --ff-only
else
  install -d -o dash -g dash "$(dirname "$CODE")"
  sudo -u dash git clone "$REPO_URL" "$CODE"
fi

say "env: $ETC/env"
install -d -m 0750 -o root -g dash "$ETC"
if [ ! -f "$ETC/env" ]; then
  install -m 0640 -o root -g dash "$SRC/env.example" "$ETC/env"
  echo "создан из env.example — впишите PAPER_TOKEN (секрет воркера radar840-quotes); TELEGRAM_* — если письмо должно уходить с VPS"
else
  echo "уже есть, не трогаю"
fi

say "состояние: $STATE"
install -d -m 0750 -o dash -g dash "$STATE"

say "юнит и таймер"
install -m 0644 "$SRC/insider840-morning.service" /etc/systemd/system/insider840-morning.service
install -m 0644 "$SRC/insider840-morning.timer" /etc/systemd/system/insider840-morning.timer
systemctl daemon-reload

say "проверка окружения (SEC, ветка data, воркер /morning и /bars, токен, диск)"
set -a; . "$ETC/env"; set +a
sudo -u dash env PAPER_URL="${PAPER_URL:-}" PAPER_TOKEN="${PAPER_TOKEN:-}" TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}" TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}" \
  bash -c "cd $CODE && node scripts/vps/probe.mjs --check --state $STATE" || echo "(есть FAIL — см. выше)"

if [ -n "${PAPER_TOKEN:-}" ]; then
  systemctl enable --now insider840-morning.timer
  systemctl list-timers insider840-morning.timer --no-pager || true
else
  echo
  echo "Таймер НЕ включён: в $ETC/env пустой PAPER_TOKEN. Впишите токен и повторите установку."
fi
echo
echo "Готово. Лог: journalctl -u insider840-morning -e   Пробный запуск без отправки: sudo -u dash bash -c 'cd $CODE && node scripts/vps/morning-build.mjs --state /tmp/m840 --once --dry-run --no-letter'"
