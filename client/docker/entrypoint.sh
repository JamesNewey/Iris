#!/bin/sh
set -e

NOVNC_PORT="${NOVNC_PORT:-6080}"

Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
sleep 1

x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -bg -o /tmp/x11vnc.log

websockify --web=/usr/share/novnc/ "$NOVNC_PORT" localhost:5900 &
node chrome-launcher.js &
exec node cdp-proxy.js
