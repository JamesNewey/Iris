# Iris client image

The Docker container image that runs on each remote machine Iris manages. This is one of the two parts of the Iris solution, alongside the desktop app in [`host/`](../host) — see the top-level [README](../README.md) for how they fit together. For deploying this image to real remote machines, see [`terraform/`](terraform) (currently: Azure Container Instances).

The image's files live in [`docker/`](docker). It's built from `mcr.microsoft.com/playwright:v1.40.0-jammy` and exposes what the host app needs to connect to it:

1. **A reachable CDP endpoint.** Modern Chrome refuses to bind its remote-debugging port to anything but `127.0.0.1` and rejects requests whose `Host` header doesn't match — so a plain `docker run -p` publish of Chrome's CDP port doesn't work. `cdp-proxy.js` is a small reverse proxy that fixes both problems. See the `client-cdp-proxy-requirement` memory for the full story of why this exists.
2. **A noVNC admin fallback.** `x11vnc` + `websockify` + the `novnc` static web client, attached to the same X display Chrome runs on, so the host app's "Open admin view" escape hatch has something real to open.

3. **Resource stats.** `cdp-proxy.js` also answers `GET /iris/stats` itself (it isn't forwarded to Chrome) with the whole container's CPU and memory usage and limits, read from its cgroup. The host app polls it every 5 s to show a per-connection CPU/memory readout; older images without the route simply show none.

`chrome-launcher.js` launches the browser itself (deliberately not via Playwright's own `launch()` — see the comment at the top of that file for why).

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_PORT` | `9333` | Port `cdp-proxy.js` listens on. |
| `CDP_PORT` | `9222` | Port Chrome's own remote-debugging endpoint is on, inside the container — you shouldn't need to change this. |
| `NOVNC_PORT` | `6080` | Port `websockify` (and so noVNC) listens on. |
| `UPSTREAM_PROXY` | _(unset)_ | Authenticated proxy Chrome browses through, as `http://user:pass@host:port`. Unset means Chrome browses directly. |
| `BLOCKED_HOSTS` | `*.googleapis.com,*.gvt1.com,*.googleusercontent.com` | Only used with `UPSTREAM_PROXY`. Comma-separated hosts refused with a 403 instead of being sent upstream; `*.example.com` also matches `example.com` itself. Set it empty to block nothing. |

## Build & run

```bash
cd client/docker
docker build -t iris-client .
docker create --name iris-client -p <PORT>:9333 -p <PORT+100>:6080 iris-client
docker start iris-client
```

`chrome-launcher.js` and `cdp-proxy.js` are baked into the image at build time.

**Publish both ports, with the noVNC one exactly 100 higher than the CDP one** (e.g. `9225:9333` and `9325:6080`) — the host app doesn't ask for a separate noVNC URL, it derives the "Open admin view" link from the connection's own endpoint, assuming noVNC lives on the same host at `port + 100` (see `NOVNC_PORT_OFFSET` in `host/src/main.ts`). Keep that constant and this image's port mapping in step if the convention ever changes.

To route a local container through an authenticated proxy, add
`-e UPSTREAM_PROXY="http://USER:PASS@HOST:PORT"` to `docker create`.

### Testing the proxy

`scripts/test-proxy.sh [COUNT] [URL]` fetches `URL` (default
`https://api.ipify.org`, which returns the exit IP) through `COUNT`
consecutive ports starting at `upstream_proxy.port` (default: one per client).
It takes the settings from `upstream_proxy` in `terraform/terraform.tfvars`,
via `terraform console`, so it tests exactly what a deploy would use. It prints each port's exit IP or, on failure, the proxy's own
explanation, and exits non-zero if any port failed.

## Running more than one (for local multi-connection testing)

Give each one a different name and host ports, same +100 relationship:

```bash
docker create --name iris-client-2 -p <PORT>:9333 -p <PORT+100>:6080 iris-client
docker start iris-client-2
```

## If it won't restart after being force-killed

Xvfb leaves a stale `/tmp/.X99-lock` in the container's writable layer if it was killed uncleanly, which then blocks it from starting again on `docker start`. Recreate instead of restarting: `docker rm -f <name>` then repeat the create/start steps above. See the `iris-dev-loop-gotchas` memory.
