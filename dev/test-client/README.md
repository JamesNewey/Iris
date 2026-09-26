# Test client (dev-only)

A throwaway local stand-in for a real Iris client, for developing and manually testing Iris itself. **This is not the real client image** — real clients are Docker containers provisioned externally via Terraform (see the requirements doc and [[iris-project-overview]] memory), and building/deploying them is explicitly out of scope for Iris. This exists purely so `cargo tauri dev` has something real to connect to on a dev machine.

It reproduces the two client-side technical requirements Iris actually depends on:

1. **A reachable CDP endpoint.** Modern Chrome refuses to bind its remote-debugging port to anything but `127.0.0.1` and rejects requests whose `Host` header doesn't match — so a plain `docker run -p` publish of Chrome's CDP port doesn't work. `cdp-proxy.js` is a small reverse proxy that fixes both problems; every real client needs the equivalent of this, or Iris can never reach it. See the `client-cdp-proxy-requirement` memory for the full story.
2. **A noVNC admin fallback.** `x11vnc` + `websockify` + the `novnc` static web client, attached to the same X display Chrome runs on, so Iris's "Open admin view" escape hatch has something real to open.

## Build & run

```bash
cd dev/test-client
docker build -t iris-test-client .
docker create --name iris-test-client -p <PORT>:9333 -p <PORT+100>:6080 iris-test-client
docker start iris-test-client
```

`chrome-launcher.js` and `cdp-proxy.js` are baked into the image at build time — no need to `docker cp` them in separately.

**Publish both ports, with the noVNC one exactly 100 higher than the CDP one** (e.g. `9225:9333` and `9325:6080`) — Iris doesn't ask for a separate noVNC URL. It derives the "Open admin view" link itself from the connection's own endpoint, assuming noVNC lives on the same host at `port + 100` (see `NOVNC_PORT_OFFSET` in `src/main.ts`). This is a placeholder assumption standing in for whatever the real Terraform-provisioned clients actually do — keep this container's port mapping in step with that constant, or update both together if it changes.

## Running a second one

Give it different host ports, same +100 relationship:

```bash
docker create --name iris-test-client-2 -p <PORT>:9333 -p <PORT+100>:6080 iris-test-client
docker start iris-test-client-2
```

## If it won't restart after being force-killed

Xvfb leaves a stale `/tmp/.X99-lock` in the container's writable layer if it was killed uncleanly, which then blocks it from starting again on `docker start`. Recreate instead of restarting: `docker rm -f <name>` then repeat the create/start steps above. See the `iris-dev-loop-gotchas` memory.
