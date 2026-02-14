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
BINARY="${APP_DIR}/${APP_NAME}"
SERVICE_NAME="${APP_NAME}"

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
    err "Run as root: sudo ./update.sh"
fi

echo ""
echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║      PeerServer Update Script        ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Verify existing installation ---
if [ ! -f "$BINARY" ]; then
    err "No existing installation found at ${BINARY}. Run setup.sh first."
fi

if ! systemctl list-unit-files "${SERVICE_NAME}.service" &>/dev/null; then
    err "Service ${SERVICE_NAME} not found. Run setup.sh first."
fi

# --- Build ---
if ! command -v go &>/dev/null; then
    err "Go not installed. Install Go 1.23+ to build."
fi

log "Building binary..."
cd "$SCRIPT_DIR"
go build -ldflags "-s -w" -o "${APP_NAME}" .
log "Binary built successfully"

# --- Compare ---
NEW_HASH=$(sha256sum "${SCRIPT_DIR}/${APP_NAME}" | awk '{print $1}')
OLD_HASH=$(sha256sum "${BINARY}" 2>/dev/null | awk '{print $1}' || echo "none")

if [ "$NEW_HASH" = "$OLD_HASH" ]; then
    warn "Binary is identical to the running version. No update needed."
    rm -f "${SCRIPT_DIR}/${APP_NAME}"
    exit 0
fi

log "New binary differs from installed version"

# --- Backup ---
BACKUP="${BINARY}.backup.$(date +%Y%m%d%H%M%S)"
cp "$BINARY" "$BACKUP"
log "Backed up current binary to ${BACKUP}"

# --- Stop service ---
log "Stopping ${SERVICE_NAME}..."
systemctl stop "$SERVICE_NAME"

# --- Replace binary ---
cp "${SCRIPT_DIR}/${APP_NAME}" "$BINARY"
chmod +x "$BINARY"
chown "${APP_USER}:${APP_USER}" "$BINARY"
log "Binary replaced"

# --- Start service ---
log "Starting ${SERVICE_NAME}..."
systemctl start "$SERVICE_NAME"

# --- Health check ---
sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
    log "Service is running"
else
    warn "Service failed to start — rolling back..."
    cp "$BACKUP" "$BINARY"
    chmod +x "$BINARY"
    chown "${APP_USER}:${APP_USER}" "$BINARY"
    systemctl start "$SERVICE_NAME"
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        warn "Rollback successful. Previous version restored."
    else
        err "Rollback failed. Check manually: journalctl -u ${SERVICE_NAME} -n 50"
    fi
    exit 1
fi

# --- Cleanup build artifact ---
rm -f "${SCRIPT_DIR}/${APP_NAME}"

# --- Prune old backups (keep last 3) ---
BACKUP_COUNT=$(ls -1 "${BINARY}.backup."* 2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt 3 ]; then
    ls -1t "${BINARY}.backup."* | tail -n +4 | xargs rm -f
    log "Pruned old backups (kept last 3)"
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       Update Complete!               ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo "  Status:   systemctl status ${SERVICE_NAME}"
echo "  Logs:     journalctl -u ${SERVICE_NAME} -f"
echo "  Backup:   ${BACKUP}"
echo ""