#!/usr/bin/env bash
# Установка и запуск из папки проекта. Пароли читаются из соседнего .env.
set -euo pipefail
cd "$(dirname "$0")"

if [[ "${1:-}" == "start" ]]; then
  if [[ -f /etc/systemd/system/lotweb.service ]] && command -v systemctl >/dev/null 2>&1 && [[ "$(id -u)" -eq 0 ]]; then
    systemctl restart lotweb
    systemctl status lotweb --no-pager
    exit 0
  fi
  exec node server.mjs
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Для установки Node.js запустите: sudo ./install.sh"
    exit 1
  fi
  apt-get update
  apt-get install -y ca-certificates curl git
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

npm install
node server.mjs setup

if [[ "$(id -u)" -eq 0 ]] && command -v systemctl >/dev/null 2>&1; then
  cat >/etc/systemd/system/lotweb.service <<EOF
[Unit]
Description=Lot VPN shop
After=network.target

[Service]
WorkingDirectory=$(pwd)
ExecStart=$(command -v node) server.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable lotweb
  echo "Служба lotweb включена. Она сама прочитает $(pwd)/.env"
fi

echo "Дальше откройте .env в этой папке и выполните ./install.sh start"
