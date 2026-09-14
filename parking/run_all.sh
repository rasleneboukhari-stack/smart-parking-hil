#!/usr/bin/env bash

set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="$PROJECT_DIR/.venv/bin/python"

LOG_DIR="$PROJECT_DIR/.runlogs"
GATEWAY_LOG="$LOG_DIR/gateway.log"
HIL_LOG="$LOG_DIR/hil_bridge.log"

GATEWAY_PID=""
HIL_PID=""

mkdir -p "$LOG_DIR"

GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
NC="\033[0m"

cleanup() {
    echo
    echo -e "${YELLOW}[RUN] Stopping parking stack...${NC}"

    [[ -n "$HIL_PID" ]] && kill "$HIL_PID" 2>/dev/null || true
    [[ -n "$GATEWAY_PID" ]] && kill "$GATEWAY_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

cd "$PROJECT_DIR"


# ============================================================
# CHECK PYTHON
# ============================================================

if [[ ! -x "$PYTHON" ]]; then
    echo -e "${RED}[ERROR] Missing parking .venv${NC}"
    exit 1
fi


# ============================================================
# BUILD HIL CHIP
# ============================================================

echo -e "${GREEN}[RUN] Building HIL chip...${NC}"

wokwi-cli chip compile \
    parking-hil.chip.c \
    -o parking-hil.chip.wasm || exit 1


# ============================================================
# BUILD ESP32
# ============================================================

echo
echo -e "${GREEN}[RUN] Building ESP32...${NC}"

pio run || exit 1


# ============================================================
# START GATEWAY
# ============================================================

echo
echo -e "${GREEN}[RUN] Starting gateway...${NC}"

: > "$GATEWAY_LOG"

PYTHONUNBUFFERED=1 \
"$PYTHON" "$PROJECT_DIR/gateway/gateway.py" \
    > "$GATEWAY_LOG" 2>&1 &

GATEWAY_PID=$!


# Wait for port 8000
for i in {1..30}; do

    if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
        echo -e "${RED}[ERROR] Gateway crashed:${NC}"
        cat "$GATEWAY_LOG"
        exit 1
    fi

    if "$PYTHON" - <<'PY' >/dev/null 2>&1
import socket

s = socket.socket()
s.settimeout(0.2)

try:
    s.connect(("127.0.0.1", 8000))
except Exception:
    raise SystemExit(1)
finally:
    s.close()
PY
    then
        break
    fi

    sleep 0.5
done


echo -e "${GREEN}[OK] Gateway ready.${NC}"


# ============================================================
# OPEN WEBSITES
# ============================================================

xdg-open "http://127.0.0.1:8000/" >/dev/null 2>&1 &
xdg-open "http://127.0.0.1:8000/simulator" >/dev/null 2>&1 &


# ============================================================
# OPEN VS CODE
# ============================================================

code "$PROJECT_DIR" >/dev/null 2>&1 &


echo
echo -e "${YELLOW}============================================${NC}"
echo -e "${YELLOW} START WOKWI NOW${NC}"
echo -e "${YELLOW}============================================${NC}"
echo
echo "In VS Code:"
echo
echo "  Ctrl+Shift+P"
echo "  Wokwi: Start Simulator"
echo
echo "Keep the Wokwi Simulator tab visible."
echo
echo "Waiting for a REAL RFC2217 connection..."
echo


# ============================================================
# WAIT FOR REAL RFC2217 NEGOTIATION
# ============================================================

RFC_READY=false

while true; do

    if "$PYTHON" - <<'PY' >/dev/null 2>&1
import serial

try:
    ser = serial.serial_for_url(
        "rfc2217://127.0.0.1:4000",
        baudrate=115200,
        timeout=0.2
    )

    ser.close()

except Exception:
    raise SystemExit(1)
PY
    then

        RFC_READY=true
        break
    fi

    sleep 1
done


echo
echo -e "${GREEN}[OK] Real RFC2217 handshake succeeded.${NC}"

# Give Wokwi a moment after the test connection closes
sleep 1


# ============================================================
# START HIL BRIDGE
# ============================================================

echo -e "${GREEN}[RUN] Starting HIL bridge...${NC}"

: > "$HIL_LOG"

PYTHONUNBUFFERED=1 \
"$PYTHON" "$PROJECT_DIR/gateway/hil_bridge.py" \
    > "$HIL_LOG" 2>&1 &

HIL_PID=$!

sleep 2


if ! kill -0 "$HIL_PID" 2>/dev/null; then

    echo -e "${RED}[ERROR] HIL bridge crashed:${NC}"
    cat "$HIL_LOG"

    exit 1
fi


# ============================================================
# READY
# ============================================================

echo
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN} PARKING STACK RUNNING${NC}"
echo -e "${GREEN}============================================${NC}"
echo
echo "Website:"
echo "  http://127.0.0.1:8000/"
echo
echo "Simulator:"
echo "  http://127.0.0.1:8000/simulator"
echo
echo "Gateway log:"
echo "  $GATEWAY_LOG"
echo
echo "HIL log:"
echo "  $HIL_LOG"
echo
echo "Ctrl+C stops gateway + HIL bridge."
echo


while true; do

    if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
        echo -e "${RED}[ERROR] Gateway died.${NC}"
        tail -50 "$GATEWAY_LOG"
        exit 1
    fi

    if ! kill -0 "$HIL_PID" 2>/dev/null; then
        echo -e "${RED}[ERROR] HIL bridge died.${NC}"
        tail -50 "$HIL_LOG"
        exit 1
    fi

    sleep 2
done
