# Iris

Desktop app for managing Playwright browser-automation sessions running on remote clients.

Full requirements: https://claude.ai/code/artifact/b3215882-b9a8-46ba-8486-9ae19a604880

Two parts, kept clearly separate:

- **[`host/`](host)** — the desktop app itself (what a user runs on their own machine). Tauri v2 (Rust) shell + a Node.js sidecar + a Vite/TypeScript frontend.
- **[`client/`](client)** — the Docker container image that runs on each remote machine the host app connects to and controls.

## `host/` — the desktop app

- **`host/src-tauri/`** — Tauri v2 shell (Rust). Owns the native window, spawns/supervises the Node sidecar, and bridges IPC between the sidecar and the frontend.
- **`host/sidecar/`** — Node.js/TypeScript sidecar. Owns all live Playwright connections and session state (`connectOverCDP`), since Playwright's full API is Node-only.
- **`host/src/`** — Frontend (Vite + TypeScript), rendered in the Tauri webview.

Manual control (thumbnails, the large control frame, click/keyboard passthrough) is built on Playwright CDP (`Page.startScreencast`, `Input.dispatch*`) over the same connection used for session management — not noVNC. noVNC is reserved as an admin-only fallback route for when CDP itself is unresponsive.

### Development

Prerequisites: Rust (via [rustup](https://rustup.rs)), Node LTS, and on Linux the [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/#linux) (`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`, `build-essential`, `libssl-dev`, `libgtk-3-dev`, `libdbus-1-dev`, `pkg-config`).

```bash
cd host
npm install
npm run dev
```

## `client/` — the remote client image

See [`client/README.md`](client/README.md) for what it is and how to build/run it.
