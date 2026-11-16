#!/usr/bin/env bash
# Установка и запуск из папки проекта. Пароли читаются из соседнего .env.
set -euo pipefail
cd "$(dirname "$0")"

env_value() {
  local key="$1"
  [[ -f .env ]] || return 0
  local line
  line="$(grep -E "^${key}=" .env | head -1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  printf '%s' "$line" | tr -d '[:space:]'
}

site_host() {
  local host ip
  host="$(env_value SITE_HOST)"
  if [[ "$host" =~ ^[A-Za-z0-9.-]+$ ]]; then
    printf '%s' "$host"
    return 0
  fi
  ip="$(curl -4 -fsS --max-time 8 https://api.ipify.org || true)"
  if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf '%s.nip.io' "$ip"
    return 0
  fi
  return 1
}

install_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    return 0
  fi
  apt-get update
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  rm -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
}

write_unit() {
  local bind="${1:-}"
  local environment=""
  if [[ "$bind" == "127.0.0.1" ]]; then
    environment=$'Environment=BIND=127.0.0.1\nEnvironment=PORT=3000'
  fi
  cat >/etc/systemd/system/lotweb.service <<EOF
[Unit]
Description=Lot VPN shop
After=network.target

[Service]
WorkingDirectory=$(pwd)
${environment}
ExecStart=$(command -v node) server.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable lotweb
}

setup_https() {
  local host
  if ! host="$(site_host)"; then
    echo "Публичный адрес не определился. Сайт останется на порту из PORT."
    return 1
  fi
  install_caddy
  mkdir -p /etc/caddy
  cat >/etc/caddy/Caddyfile <<EOF
${host} {
	reverse_proxy 127.0.0.1:3000
}
EOF
  systemctl enable caddy
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
    ufw allow 80/tcp
    ufw allow 443/tcp
  fi
  echo "Сайт открывается по адресу https://${host}"
}

if [[ "${1:-}" == "start" ]]; then
  echo "Папка запуска: $(pwd)"
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Коммит: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"
  fi
  if grep -q "настоящего клиента" server.mjs; then
    echo "В server.mjs есть выдача настоящего ключа"
  else
    echo "server.mjs старый: строки про настоящего клиента нет"
  fi
  if [[ -f /etc/systemd/system/lotweb.service ]] && command -v systemctl >/dev/null 2>&1 && [[ "$(id -u)" -eq 0 ]]; then
    bind=""
    if setup_https; then
      bind="127.0.0.1"
    fi
    write_unit "$bind"
    systemctl stop lotweb || true
    if command -v fuser >/dev/null 2>&1; then
      fuser -k 3000/tcp >/dev/null 2>&1 || true
    fi
    sleep 0.4
    systemctl start lotweb
    sleep 1
    echo "Ответ сайта:"
    curl -fsS http://127.0.0.1:3000/api/shop || echo "Сайт на порту 3000 не ответил"
    echo
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
  bind=""
  if setup_https; then
    bind="127.0.0.1"
  fi
  write_unit "$bind"
  echo "Служба lotweb включена. Она сама прочитает $(pwd)/.env"
fi

echo "Дальше откройте .env в этой папке и выполните ./install.sh start"
