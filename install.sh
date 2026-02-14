#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

APP_NAME="peerserver"
APP_USER="peerserver"
APP_DIR="/opt/peerserver"
CONFIG_FILE="${APP_DIR}/config.json"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
BINARY="${APP_DIR}/${APP_NAME}"

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
ask()  { echo -ne "${CYAN}[?]${NC} $1"; }

if [ "$(id -u)" -ne 0 ]; then
    err "Run as root: sudo ./setup.sh"
fi

echo ""
echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║       PeerServer Setup Script        ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# --- Domain ---
ask "Enter domain or subdomain (e.g. peer.example.com): "
read -r DOMAIN
if [ -z "$DOMAIN" ]; then
    err "Domain cannot be empty"
fi

ask "Server port [8080]: "
read -r PORT
PORT=${PORT:-8080}

ask "Max peers [100000]: "
read -r MAX_PEERS
MAX_PEERS=${MAX_PEERS:-100000}

ask "Use Redis broker? (y/n) [n]: "
read -r USE_REDIS
USE_REDIS=${USE_REDIS:-n}

BROKER_TYPE="local"
REDIS_ADDR="localhost:6379"
REDIS_PASS=""
if [[ "$USE_REDIS" =~ ^[Yy] ]]; then
    BROKER_TYPE="redis"
    ask "Redis address [localhost:6379]: "
    read -r REDIS_ADDR_INPUT
    REDIS_ADDR=${REDIS_ADDR_INPUT:-$REDIS_ADDR}
    ask "Redis password (empty for none): "
    read -rs REDIS_PASS
    echo ""
fi

echo ""
echo -e "${CYAN}─── Summary ───${NC}"
echo "  Domain:     ${DOMAIN}"
echo "  Port:       ${PORT}"
echo "  Max Peers:  ${MAX_PEERS}"
echo "  Broker:     ${BROKER_TYPE}"
echo ""
ask "Proceed? (y/n): "
read -r CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
    echo "Aborted."
    exit 0
fi
echo ""

# --- Build binary ---
log "Building binary..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if command -v go &>/dev/null; then
    cd "$SCRIPT_DIR"
    go build -ldflags "-s -w" -o "${APP_NAME}" .
    log "Binary built"
elif [ -f "${SCRIPT_DIR}/${APP_NAME}" ]; then
    warn "Go not found, using existing binary"
else
    err "Go not installed and no pre-built binary found. Install Go 1.23+ or build first with 'make build'"
fi

# --- Create user ---
if ! id "$APP_USER" &>/dev/null; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
    log "Created system user: ${APP_USER}"
else
    log "User ${APP_USER} already exists"
fi

# --- Install binary ---
mkdir -p "$APP_DIR"
cp "${SCRIPT_DIR}/${APP_NAME}" "$BINARY"
chmod +x "$BINARY"
log "Binary installed to ${BINARY}"

# --- Config ---
cat > "$CONFIG_FILE" << CFGEOF
{
  "host": "127.0.0.1",
  "port": ${PORT},
  "max_peers": ${MAX_PEERS},
  "shard_count": 64,
  "write_timeout": 10000000000,
  "read_timeout": 60000000000,
  "ping_interval": 30000000000,
  "pong_wait": 35000000000,
  "max_message_size": 65536,
  "broker_type": "${BROKER_TYPE}",
  "redis_addr": "${REDIS_ADDR}",
  "redis_password": "${REDIS_PASS}",
  "redis_db": 0,
  "rate_limit_per_sec": 100,
  "rate_limit_burst": 200,
  "tls_cert": "",
  "tls_key": "",
  "metrics_enabled": true,
  "metrics_port": 9090
}
CFGEOF
log "Config written to ${CONFIG_FILE}"

chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# --- Systemd service ---
cat > "$SERVICE_FILE" << SVCEOF
[Unit]
Description=PeerServer - WebRTC Signaling Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
ExecStart=${BINARY} -config ${CONFIG_FILE}
Restart=always
RestartSec=3
LimitNOFILE=1000000
LimitNPROC=65535
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}
Environment=GOMAXPROCS=0

[Install]
WantedBy=multi-user.target
SVCEOF
log "Systemd service created"

systemctl daemon-reload
systemctl enable "$APP_NAME"
systemctl start "$APP_NAME"
log "Service started and enabled"

# --- Sysctl tuning ---
cat > /etc/sysctl.d/99-peerserver.conf << SYSEOF
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
fs.file-max = 1000000
net.ipv4.tcp_fin_timeout = 15
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
SYSEOF
sysctl --system > /dev/null 2>&1
log "Kernel tuning applied"

cat > /etc/security/limits.d/peerserver.conf << LIMEOF
${APP_USER} soft nofile 1000000
${APP_USER} hard nofile 1000000
LIMEOF
log "File descriptor limits set"

# --- Nginx ---
if ! command -v nginx &>/dev/null; then
    log "Installing nginx..."
    apt-get update -qq
    apt-get install -y -qq nginx > /dev/null 2>&1
    log "nginx installed"
fi

cat > /etc/nginx/sites-available/peerserver << NGXEOF
upstream peerserver_backend {
    server 127.0.0.1:${PORT};
    keepalive 64;
}

server {
    listen 80;
    server_name ${DOMAIN};

    location /ws {
        proxy_pass http://peerserver_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_buffering off;
        proxy_cache off;
    }

    location /health {
        proxy_pass http://peerserver_backend;
        proxy_set_header Host \$host;
    }

    location /stats {
        proxy_pass http://peerserver_backend;
        proxy_set_header Host \$host;
    }

    location / {
        return 404 '{"error":"not found"}';
        add_header Content-Type application/json;
    }
}
NGXEOF

ln -sf /etc/nginx/sites-available/peerserver /etc/nginx/sites-enabled/peerserver
rm -f /etc/nginx/sites-enabled/default

nginx -t > /dev/null 2>&1 || err "nginx config test failed"
systemctl reload nginx
log "nginx configured for ${DOMAIN}"

# --- Certbot ---
ask "Install SSL certificate with certbot? (y/n) [y]: "
read -r INSTALL_SSL
INSTALL_SSL=${INSTALL_SSL:-y}

if [[ "$INSTALL_SSL" =~ ^[Yy] ]]; then
    if ! command -v certbot &>/dev/null; then
        log "Installing certbot..."
        apt-get install -y -qq certbot python3-certbot-nginx > /dev/null 2>&1
        log "certbot installed"
    fi

    ask "Email for certbot (for renewal notices): "
    read -r CERT_EMAIL

    if [ -z "$CERT_EMAIL" ]; then
        certbot --nginx -d "$DOMAIN" --agree-tos --register-unsafely-without-email --non-interactive
    else
        certbot --nginx -d "$DOMAIN" --agree-tos -m "$CERT_EMAIL" --non-interactive
    fi
    log "SSL certificate installed for ${DOMAIN}"

    if ! systemctl is-active --quiet certbot.timer 2>/dev/null; then
        systemctl enable --now certbot.timer 2>/dev/null || true
    fi
    log "Auto-renewal enabled"
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       Setup Complete!                ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo "  WebSocket:  wss://${DOMAIN}/ws"
echo "  Health:     https://${DOMAIN}/health"
echo "  Stats:      https://${DOMAIN}/stats"
echo ""
echo "  Service:    systemctl status ${APP_NAME}"
echo "  Logs:       journalctl -u ${APP_NAME} -f"
echo "  Config:     ${CONFIG_FILE}"
echo ""
