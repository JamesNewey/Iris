# Test client (dev-only)

A throwaway local stand-in for a real Iris client, for developing and manually testing Iris itself. **This is not the real client image** — real clients are Docker containers provisioned externally via Terraform (see the requirements doc and [[iris-project-overview]] memory), and building/deploying them is explicitly out of scope for Iris. This exists purely so `cargo tauri dev` has something real to connect to on a dev machine.

It reproduces the two client-side technical requirements Iris actually depends on:

1. **A reachable CDP endpoint.** Modern Chrome refuses to bind its remote-debugging port to anything but `127.0.0.1` and rejects requests whose `Host` header doesn't match — so a plain `docker run -p` publish of Chrome's CDP port doesn't work. `cdp-proxy.js` is a small reverse proxy that fixes both problems; every real client needs the equivalent of this, or Iris can never reach it. See the `client-cdp-proxy-requirement` memory for the full story.
2. **A noVNC admin fallback.** `x11vnc` + `websockify` + the `novnc` static web client, attached to the same X display Chrome runs on, so Iris's "Open admin view" escape hatch has something real to open.

## Build & run

```bash
cd dev/test-client
docker build -t iris-test-client .
docker create --name iris-test-client -p <HOST_CDP_PORT>:9333 iris-test-client
docker start iris-test-client
```

`chrome-launcher.js` and `cdp-proxy.js` are baked into the image at build time — no need to `docker cp` them in separately.

Note only the CDP proxy port (9333 → whatever host port you map) needs an explicit `-p` publish for Iris to connect to it in the usual case. The noVNC port (6080) doesn't need one: reach it from the host directly via the container's bridge IP (`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' iris-test-client`), e.g. `http://<that-ip>:6080/vnc.html?autoconnect=true` — that's the URL to paste into Iris's "noVNC admin URL" field when adding the connection.

## Running a second one

Give it a different name and host port:

```bash
docker create --name iris-test-client-2 -p <ANOTHER_HOST_PORT>:9333 iris-test-client
docker start iris-test-client-2
```

## If it won't restart after being force-killed

Xvfb leaves a stale `/tmp/.X99-lock` in the container's writable layer if it was killed uncleanly, which then blocks it from starting again on `docker start`. Recreate instead of restarting: `docker rm -f <name>` then repeat the create/start steps above. See the `iris-dev-loop-gotchas` memory.
