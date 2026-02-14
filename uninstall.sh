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
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
ask()  { echo -ne "${CYAN}[?]${NC} $1"; }

if [ "$(id -u)" -ne 0 ]; then
    err "Run as root: sudo ./uninstall.sh"
fi

echo ""
echo -e "${RED}╔══════════════════════════════════════╗${NC}"
echo -e "${RED}║     PeerServer Uninstall Script      ║${NC}"
echo -e "${RED}╚══════════════════════════════════════╝${NC}"
echo ""
echo "This will remove:"
echo "  - Systemd service"
echo "  - Binary and config from ${APP_DIR}"
echo "  - Nginx site config"
echo "  - Sysctl and limits tuning"
echo "  - System user: ${APP_USER}"
echo ""
ask "Continue? (y/n): "
read -r CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
    echo "Aborted."
    exit 0
fi
echo ""

# --- Stop service ---
if systemctl is-active --quiet "$APP_NAME" 2>/dev/null; then
    systemctl stop "$APP_NAME"
    log "Service stopped"
fi

if systemctl is-enabled --quiet "$APP_NAME" 2>/dev/null; then
    systemctl disable "$APP_NAME"
    log "Service disabled"
fi

# --- Remove service file ---
if [ -f "$SERVICE_FILE" ]; then
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload
    log "Systemd service removed"
fi

# --- Remove binary and config ---
if [ -d "$APP_DIR" ]; then
    ask "Keep config.json backup? (y/n) [y]: "
    read -r KEEP_CONFIG
    KEEP_CONFIG=${KEEP_CONFIG:-y}
    if [[ "$KEEP_CONFIG" =~ ^[Yy] ]] && [ -f "${APP_DIR}/config.json" ]; then
        cp "${APP_DIR}/config.json" "/tmp/peerserver-config-backup.json"
        log "Config backed up to /tmp/peerserver-config-backup.json"
    fi
    rm -rf "$APP_DIR"
    log "Removed ${APP_DIR}"
fi

# --- Remove nginx config ---
if [ -f /etc/nginx/sites-available/peerserver ]; then
    rm -f /etc/nginx/sites-available/peerserver
    rm -f /etc/nginx/sites-enabled/peerserver
    if command -v nginx &>/dev/null && nginx -t > /dev/null 2>&1; then
        systemctl reload nginx 2>/dev/null || true
    fi
    log "Nginx config removed"
fi

# --- Remove SSL cert ---
ask "Remove SSL certificates for the domain? (y/n) [n]: "
read -r REMOVE_SSL
REMOVE_SSL=${REMOVE_SSL:-n}
if [[ "$REMOVE_SSL" =~ ^[Yy] ]]; then
    ask "Enter domain to remove cert for: "
    read -r DOMAIN
    if [ -n "$DOMAIN" ] && command -v certbot &>/dev/null; then
        certbot delete --cert-name "$DOMAIN" --non-interactive 2>/dev/null || warn "Certbot delete failed, may need manual removal"
        log "SSL certificate removed for ${DOMAIN}"
    fi
fi

# --- Remove sysctl tuning ---
if [ -f /etc/sysctl.d/99-peerserver.conf ]; then
    rm -f /etc/sysctl.d/99-peerserver.conf
    sysctl --system > /dev/null 2>&1
    log "Sysctl tuning removed"
fi

# --- Remove limits ---
if [ -f /etc/security/limits.d/peerserver.conf ]; then
    rm -f /etc/security/limits.d/peerserver.conf
    log "File descriptor limits removed"
fi

# --- Remove user ---
if id "$APP_USER" &>/dev/null; then
    userdel "$APP_USER" 2>/dev/null || warn "Could not remove user ${APP_USER}"
    log "User ${APP_USER} removed"
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     Uninstall Complete               ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
