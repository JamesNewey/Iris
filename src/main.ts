import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { load, type Store } from "@tauri-apps/plugin-store";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting" | "error";
type SessionSummary = { id: string; url: string; title: string };
type AddConnectionResult = { connectionId: string; browserVersion: string; sessions: SessionSummary[] };
type FrameEvent = { type: "frame"; connectionId: string; sessionId: string; data: string };
type SidecarPushEvent =
  | { type: "connectionStatus"; connectionId: string; status: ConnectionStatus; error?: string }
  | { type: "sessionAdded" | "sessionUpdated"; connectionId: string; session: SessionSummary }
  | { type: "sessionRemoved"; connectionId: string; sessionId: string }
  | { type: string; [key: string]: unknown };

interface StoredConfig {
  configId: string;
  name: string;
  endpoint: string;
  token?: string;
}

interface Connection {
  configId: string;
  connectionId: string | null; // null while disconnected
  name: string;
  endpoint: string;
  token?: string;
  status: ConnectionStatus | "idle";
  browserVersion?: string;
  connectedAt?: number;
  error?: string;
  sessions: Map<string, SessionSummary>;
}

const connections = new Map<string, Connection>(); // keyed by configId
let store: Store | null = null;

let connectionsListEl: HTMLElement | null;
let controlPanelEl: HTMLElement | null;
let controlSessionIdEl: HTMLElement | null;
let canvasEl: HTMLCanvasElement | null;
let latencyEl: HTMLElement | null;

let activeConnectionId: string | null = null;
let activeSessionId: string | null = null;
let naturalWidth = 0;
let naturalHeight = 0;

const STATUS_LABEL: Record<Connection["status"], string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected",
  reconnecting: "Reconnecting…",
  error: "Error",
};

function statusClass(status: Connection["status"]): string {
  return `status status-${status}`;
}

function render() {
  if (!connectionsListEl) return;
  connectionsListEl.innerHTML = "";

  for (const conn of connections.values()) {
    const li = document.createElement("li");
    li.className = "connection-item";

    const header = document.createElement("div");
    header.className = "connection-header";

    const badge = document.createElement("span");
    badge.className = statusClass(conn.status);
    badge.textContent = STATUS_LABEL[conn.status];

    const nameEl = document.createElement("strong");
    nameEl.textContent = conn.name;
    nameEl.title = "Click to rename";
    nameEl.className = "connection-name";
    nameEl.addEventListener("click", () => renameConnection(conn.configId));

    header.appendChild(badge);
    header.appendChild(nameEl);
    li.appendChild(header);

    const meta = document.createElement("div");
    meta.className = "muted small";
    const bits = [conn.endpoint];
    if (conn.browserVersion) bits.push(`Chrome ${conn.browserVersion}`);
    if (conn.connectedAt && conn.status === "connected") {
      const secs = Math.floor((Date.now() - conn.connectedAt) / 1000);
      bits.push(`up ${secs}s`);
    }
    if (conn.error) bits.push(`error: ${conn.error}`);
    meta.textContent = bits.join(" · ");
    li.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "row";
    const isLive = conn.connectionId !== null;

    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = isLive ? "Disconnect" : "Reconnect";
    toggleBtn.addEventListener("click", () => (isLive ? disconnectConnection(conn.configId) : reconnectConnection(conn.configId)));
    actions.appendChild(toggleBtn);

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeConnection(conn.configId));
    actions.appendChild(removeBtn);
    li.appendChild(actions);

    if (conn.sessions.size > 0) {
      const sessionsList = document.createElement("ul");
      sessionsList.className = "sessions-list";
      for (const s of conn.sessions.values()) {
        const isActive = conn.connectionId === activeConnectionId && s.id === activeSessionId;
        const sLi = document.createElement("li");
        sLi.className = "row";
        if (isActive) sLi.classList.add("session-active");
        const label = document.createElement("span");
        label.textContent = `${isActive ? "● " : ""}${s.title || "(untitled)"} — ${s.url}`;
        sLi.appendChild(label);
        const controlBtn = document.createElement("button");
        controlBtn.textContent = isActive ? "Controlling" : "Take control";
        controlBtn.disabled = isActive;
        controlBtn.addEventListener("click", () => takeControl(conn.connectionId!, s.id));
        sLi.appendChild(controlBtn);
        sessionsList.appendChild(sLi);
      }
      li.appendChild(sessionsList);
    }

    connectionsListEl.appendChild(li);
  }
}

async function persist() {
  if (!store) return;
  await store.clear();
  for (const conn of connections.values()) {
    const entry: StoredConfig = { configId: conn.configId, name: conn.name, endpoint: conn.endpoint, token: conn.token };
    await store.set(conn.configId, entry);
  }
  await store.save();
}

async function connectConfig(conn: Connection) {
  conn.status = "connecting";
  render();
  try {
    const result = await invoke<AddConnectionResult>("add_connection", {
      name: conn.name,
      endpoint: conn.endpoint,
      token: conn.token,
    });
    conn.connectionId = result.connectionId;
    conn.browserVersion = result.browserVersion;
    conn.connectedAt = Date.now();
    conn.status = "connected";
    conn.error = undefined;
    conn.sessions.clear();
    for (const s of result.sessions) conn.sessions.set(s.id, s);
  } catch (err) {
    conn.status = "error";
    conn.error = String(err);
  }
  render();
}

async function reconnectConnection(configId: string) {
  const conn = connections.get(configId);
  if (!conn) return;
  await connectConfig(conn);
}

async function disconnectConnection(configId: string) {
  const conn = connections.get(configId);
  if (!conn || !conn.connectionId) return;
  try {
    await invoke("remove_connection", { connectionId: conn.connectionId });
  } catch {
    // best effort; fall through and mark disconnected locally regardless
  }
  conn.connectionId = null;
  conn.status = "disconnected";
  conn.sessions.clear();
  render();
}

async function removeConnection(configId: string) {
  const conn = connections.get(configId);
  if (!conn) return;
  if (conn.connectionId) {
    try {
      await invoke("remove_connection", { connectionId: conn.connectionId });
    } catch {
      // ignore; we're deleting the config regardless
    }
  }
  connections.delete(configId);
  if (store) {
    await store.delete(configId);
    await store.save();
  }
  render();
}

function renameConnection(configId: string) {
  const conn = connections.get(configId);
  if (!conn) return;
  const next = prompt("Rename connection", conn.name);
  if (!next || next === conn.name) return;
  conn.name = next;
  render();
  void persist();
}

function findConnectionByLiveId(connectionId: string): Connection | undefined {
  for (const conn of connections.values()) {
    if (conn.connectionId === connectionId) return conn;
  }
  return undefined;
}

function clearCanvas() {
  naturalWidth = 0;
  naturalHeight = 0;
  if (!canvasEl) return;
  const ctx = canvasEl.getContext("2d");
  ctx?.clearRect(0, 0, canvasEl.width, canvasEl.height);
}

async function releaseActiveControl() {
  if (!activeConnectionId || !activeSessionId) return;
  const prevConnectionId = activeConnectionId;
  const prevSessionId = activeSessionId;
  activeConnectionId = null;
  activeSessionId = null;
  try {
    await invoke("stop_screencast", { connectionId: prevConnectionId, sessionId: prevSessionId });
    await invoke("release_control", { connectionId: prevConnectionId, sessionId: prevSessionId });
  } catch {
    // session may already be gone (closed/disconnected) — nothing more to do
  }
}

async function takeControl(connectionId: string, sessionId: string) {
  if (activeSessionId === sessionId && activeConnectionId === connectionId) return; // already controlling this one
  await releaseActiveControl();

  activeConnectionId = connectionId;
  activeSessionId = sessionId;
  clearCanvas();

  const conn = findConnectionByLiveId(connectionId);
  const session = conn?.sessions.get(sessionId);
  if (controlSessionIdEl) controlSessionIdEl.textContent = session ? session.title || session.url : sessionId;
  if (controlPanelEl) controlPanelEl.style.display = "block";
  if (latencyEl) latencyEl.textContent = "";

  await invoke("take_control", { connectionId, sessionId });
  await invoke("start_screencast", { connectionId, sessionId });
  render(); // reflect the new "controlling" state in the sessions list
}

function drawFrame(dataBase64: string) {
  if (!canvasEl) return;
  const ctx = canvasEl.getContext("2d");
  if (!ctx) return;
  const img = new Image();
  img.onload = () => {
    naturalWidth = img.naturalWidth;
    naturalHeight = img.naturalHeight;
    ctx.drawImage(img, 0, 0, canvasEl!.width, canvasEl!.height);
  };
  img.src = `data:image/jpeg;base64,${dataBase64}`;
}

async function handleCanvasClick(ev: MouseEvent) {
  if (!activeConnectionId || !activeSessionId || !canvasEl || !naturalWidth || !naturalHeight) return;
  const rect = canvasEl.getBoundingClientRect();
  const cx = ((ev.clientX - rect.left) / rect.width) * naturalWidth;
  const cy = ((ev.clientY - rect.top) / rect.height) * naturalHeight;
  const t0 = performance.now();
  const result = await invoke<{ latencyMs: number }>("send_click", {
    connectionId: activeConnectionId,
    sessionId: activeSessionId,
    x: cx,
    y: cy,
  });
  const roundTrip = performance.now() - t0;
  if (latencyEl) {
    latencyEl.textContent = `Sidecar-reported click latency: ${result.latencyMs}ms · full round trip: ${roundTrip.toFixed(1)}ms`;
  }
}

function handleSidecarEvent(event: SidecarPushEvent) {
  if (event.type === "connectionStatus") {
    const conn = findConnectionByLiveId(event.connectionId as string);
    if (!conn) return;
    conn.status = event.status as ConnectionStatus;
    if (event.error) conn.error = event.error as string;
    render();
  } else if (event.type === "sessionAdded" || event.type === "sessionUpdated") {
    const conn = findConnectionByLiveId(event.connectionId as string);
    if (!conn) return;
    const session = event.session as SessionSummary;
    conn.sessions.set(session.id, session);
    render();
  } else if (event.type === "sessionRemoved") {
    const conn = findConnectionByLiveId(event.connectionId as string);
    if (!conn) return;
    conn.sessions.delete(event.sessionId as string);
    if (event.sessionId === activeSessionId && conn.connectionId === activeConnectionId) {
      activeConnectionId = null;
      activeSessionId = null;
      if (controlPanelEl) controlPanelEl.style.display = "none";
      clearCanvas();
    }
    render();
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  connectionsListEl = document.querySelector("#connections-list");
  controlPanelEl = document.querySelector("#control-panel");
  controlSessionIdEl = document.querySelector("#control-session-id");
  canvasEl = document.querySelector("#screencast");
  latencyEl = document.querySelector("#latency");

  canvasEl?.addEventListener("click", handleCanvasClick);
  document.querySelector("#release-control-btn")?.addEventListener("click", async () => {
    await releaseActiveControl();
    if (controlPanelEl) controlPanelEl.style.display = "none";
    clearCanvas();
    render();
  });

  store = await load("connections.json", { autoSave: false });
  const entries = await store.entries<StoredConfig>();
  for (const [, cfg] of entries) {
    connections.set(cfg.configId, {
      configId: cfg.configId,
      connectionId: null,
      name: cfg.name,
      endpoint: cfg.endpoint,
      token: cfg.token,
      status: "idle",
      sessions: new Map(),
    });
  }
  render();
  for (const conn of connections.values()) {
    void connectConfig(conn); // auto-reconnect persisted connections on launch
  }

  document.querySelector("#connect-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nameInput = document.querySelector<HTMLInputElement>("#name-input");
    const endpointInput = document.querySelector<HTMLInputElement>("#endpoint-input");
    const tokenInput = document.querySelector<HTMLInputElement>("#token-input");
    const name = nameInput?.value || "Untitled connection";
    const endpoint = endpointInput?.value ?? "";
    const token = tokenInput?.value || undefined;

    const configId = crypto.randomUUID();
    const conn: Connection = { configId, connectionId: null, name, endpoint, token, status: "idle", sessions: new Map() };
    connections.set(configId, conn);
    await persist();
    await connectConfig(conn);
  });

  listen<FrameEvent>("sidecar-frame", (event) => {
    if (event.payload.connectionId === activeConnectionId && event.payload.sessionId === activeSessionId) {
      drawFrame(event.payload.data);
    }
  });

  listen<SidecarPushEvent>("sidecar-event", (event) => handleSidecarEvent(event.payload));

  setInterval(render, 1000); // keep the "up Ns" uptime readout live
});
