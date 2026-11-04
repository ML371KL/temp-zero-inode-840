#!/usr/bin/env bash
# Установка вечернего сборщика 840 на VPS. Запускать от root (sudo) из клона репозитория:
#   sudo bash ops/insider840-evening/install.sh
# Идемпотентно: повторный запуск ничего не ломает. Ничего не включает, пока нет deploy-ключа paper, и говорит об этом.
# Шаблон — обычный для панелей: пользователь dash, код /srv/dash/repo-840, env в /usr/local/etc, состояние /var/lib.
set -euo pipefail

REPO_URL="https://github.com/ML371KL/temp-zero-inode-840.git"       # репозиторий открытый: код — анонимным клоном, без ключа
CODE=/srv/dash/repo-840
ETC=/usr/local/etc/insider840-evening
STATE=/var/lib/insider840-evening
PAPER="$STATE/paper"
KEY=/srv/dash/.ssh/deploy-840-paper
SRC="$(cd "$(dirname "$0")" && pwd)"
say() { printf '\n== %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "нет команды $1"; exit 1; }; }

[ "$(id -u)" = 0 ] || { echo "нужен root: sudo bash $0"; exit 1; }
need node; need git; need systemctl
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "нужен Node 20+, сейчас $(node --version)"; exit 1; }
id dash >/dev/null 2>&1 || { echo "нет пользователя dash — это не VPS панелей"; exit 1; }
systemd-analyze calendar "Mon..Fri *-*-* 15:55:00 America/New_York" >/dev/null || { echo "systemd не понимает пояс в OnCalendar"; exit 1; }

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
  echo "создан из env.example — проверьте значения"
else
  echo "уже есть, не трогаю"
fi

say "состояние и рабочая копия ветки paper: $PAPER"
install -d -m 0750 -o dash -g dash "$STATE"
if [ ! -d "$PAPER/.git" ]; then
  sudo -u dash git init -q -b paper "$PAPER"
  sudo -u dash git -C "$PAPER" remote add origin "$(grep '^PAPER_REMOTE=' "$ETC/env" | cut -d= -f2-)"
fi
if [ -f "$KEY" ]; then
  SSHCMD="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$STATE/known_hosts"
  dash_git() { sudo -u dash env GIT_SSH_COMMAND="$SSHCMD" git "$@"; }
  if dash_git -C "$PAPER" ls-remote --exit-code --heads origin paper >/dev/null 2>&1; then
    dash_git -C "$PAPER" fetch -q origin paper
    sudo -u dash git -C "$PAPER" checkout -q -B paper origin/paper
    echo "ветка paper есть — рабочая копия по ней"
  else
    # Ветки ещё нет: первый коммит сирота-ветки с описанием, чтобы daily.yml нашёл что забирать
    sudo -u dash install -d "$PAPER/log"
    printf '# Журнал вечерней схемы 840\n\nПишет сборщик на VPS (ops/insider840-evening): log/ГГГГ-ММ-ДД.jsonl — формы, принятые 16:00–20:00 ET, и котировки через 5/15/30 минут.\nЧитает ежедневная сборка панели (scripts/lib/paper.mjs). Руками не править.\n' | sudo -u dash tee "$PAPER/README.md" >/dev/null
    sudo -u dash git -C "$PAPER" add -A
    sudo -u dash git -C "$PAPER" -c user.name=insider-evening-bot -c user.email=actions@users.noreply.github.com commit -q -m "ветка paper: журнал вечерней схемы"
    dash_git -C "$PAPER" push -q origin paper
    echo "ветка paper создана и отправлена"
  fi
else
  echo "НЕТ КЛЮЧА $KEY — ветка paper не подготовлена. Ключ заводит владелец:"
  echo "  sudo -u dash ssh-keygen -t ed25519 -N '' -C insider840-paper -f $KEY"
  echo "  затем добавить $KEY.pub в репозиторий как deploy-ключ с записью (gh repo deploy-key add $KEY.pub --allow-write -t insider840-paper)"
fi

say "юнит и таймер"
install -m 0644 "$SRC/insider840-evening.service" /etc/systemd/system/insider840-evening.service
install -m 0644 "$SRC/insider840-evening.timer" /etc/systemd/system/insider840-evening.timer
systemctl daemon-reload

say "проверка окружения (SEC, воркер без Origin, доступ git)"
set -a; . "$ETC/env"; set +a
sudo -u dash env QUOTES_URL="${QUOTES_URL:-}" PAPER_KEY="${PAPER_KEY:-}" PAPER_DIR="${PAPER_DIR:-}" bash -c "cd $CODE && node scripts/evening/probe-quotes.mjs --check" || echo "(есть FAIL — см. выше; таймер не включён)"

if [ -f "$KEY" ]; then
  systemctl enable --now insider840-evening.timer
  systemctl list-timers insider840-evening.timer --no-pager || true
else
  echo
  echo "Таймер НЕ включён: нет ключа. После заведения ключа повторить установку."
fi
echo
echo "Готово. Лог вечера: journalctl -u insider840-evening -e   Ручной пробный запуск: sudo systemctl start insider840-evening"
