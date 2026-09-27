# The Iris client image — see client/README.md and the client/terraform/ directory
# for how this gets built and deployed to Azure.
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN npm init -y && npm install playwright@1.40.0
COPY chrome-launcher.js cdp-proxy.js entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENV DISPLAY=:99

# 9333 = CDP proxy (core, required); 6080 = noVNC admin fallback (optional).
# Both are configurable via PROXY_PORT/NOVNC_PORT env vars — real deployments
# (see client/terraform/) set both so the noVNC port is exactly 100 above the CDP
# port, matching NOVNC_PORT_OFFSET in host/src/main.ts.
EXPOSE 9333 6080

CMD ["./entrypoint.sh"]
