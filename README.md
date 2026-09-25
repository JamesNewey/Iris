# Iris

Desktop app for managing Playwright browser-automation sessions running on remote clients (Docker containers running `mcr.microsoft.com/playwright:v1.40.0-jammy`, provisioned externally via Terraform).

Full requirements: https://claude.ai/code/artifact/b3215882-b9a8-46ba-8486-9ae19a604880

## Architecture

- **`src-tauri/`** — Tauri v2 desktop shell (Rust). Owns the native window, spawns/supervises the Node sidecar, and bridges IPC between the sidecar and the frontend.
- **`sidecar/`** — Node.js/TypeScript sidecar. Owns all live Playwright connections and session state (`connect`/`connectOverCDP`), since Playwright's full API is Node-only.
- **`src/`** — Frontend (Vite + TypeScript), rendered in the Tauri webview.

Manual control (thumbnails, the large control frame, click/keyboard passthrough) is built on Playwright CDP (`Page.startScreencast`, `Input.dispatch*`) over the same connection used for session management — not noVNC. noVNC is reserved as an admin-only fallback route for when CDP itself is unresponsive.

## Development

Prerequisites: Rust (via [rustup](https://rustup.rs)), Node LTS, and on Linux the [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/#linux) (`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`, `build-essential`, `libssl-dev`, `libgtk-3-dev`, `libdbus-1-dev`, `pkg-config`).

```bash
npm install
npm run dev
```
