# Iris client image

The Docker container image that runs on each remote machine Iris manages. This is one of the two parts of the Iris solution, alongside the desktop app in [`host/`](../host) — see the top-level [README](../README.md) for how they fit together.

It's built from `mcr.microsoft.com/playwright:v1.40.0-jammy` and exposes what the host app needs to connect to it:

1. **A reachable CDP endpoint.** Modern Chrome refuses to bind its remote-debugging port to anything but `127.0.0.1` and rejects requests whose `Host` header doesn't match — so a plain `docker run -p` publish of Chrome's CDP port doesn't work. `cdp-proxy.js` is a small reverse proxy that fixes both problems. See the `client-cdp-proxy-requirement` memory for the full story of why this exists.
2. **A noVNC admin fallback.** `x11vnc` + `websockify` + the `novnc` static web client, attached to the same X display Chrome runs on, so the host app's "Open admin view" escape hatch has something real to open.

`chrome-launcher.js` launches the browser itself (deliberately not via Playwright's own `launch()` — see the comment at the top of that file for why).

## Build & run

```bash
cd client
docker build -t iris-client .
docker create --name iris-client -p <PORT>:9333 -p <PORT+100>:6080 iris-client
docker start iris-client
```

`chrome-launcher.js` and `cdp-proxy.js` are baked into the image at build time.

**Publish both ports, with the noVNC one exactly 100 higher than the CDP one** (e.g. `9225:9333` and `9325:6080`) — the host app doesn't ask for a separate noVNC URL, it derives the "Open admin view" link from the connection's own endpoint, assuming noVNC lives on the same host at `port + 100` (see `NOVNC_PORT_OFFSET` in `host/src/main.ts`). Keep that constant and this image's port mapping in step if the convention ever changes.

## Running more than one (for local multi-connection testing)

Give each one a different name and host ports, same +100 relationship:

```bash
docker create --name iris-client-2 -p <PORT>:9333 -p <PORT+100>:6080 iris-client
docker start iris-client-2
```

## If it won't restart after being force-killed

Xvfb leaves a stale `/tmp/.X99-lock` in the container's writable layer if it was killed uncleanly, which then blocks it from starting again on `docker start`. Recreate instead of restarting: `docker rm -f <name>` then repeat the create/start steps above. See the `iris-dev-loop-gotchas` memory.
