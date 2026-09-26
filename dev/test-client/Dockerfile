# Throwaway local stand-in for a real Terraform-provisioned Iris client.
# NOT the real client image — see dev/test-client/README.md.
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN npm init -y && npm install playwright@1.40.0
COPY chrome-launcher.js cdp-proxy.js ./

ENV DISPLAY=:99

# 9333 = CDP proxy (core, required); 6080 = noVNC admin fallback (optional)
EXPOSE 9333 6080

CMD Xvfb :99 -screen 0 1280x800x24 -nolisten tcp & \
    sleep 1 && \
    x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -bg -o /tmp/x11vnc.log && \
    websockify --web=/usr/share/novnc/ 6080 localhost:5900 & \
    node chrome-launcher.js & \
    node cdp-proxy.js
