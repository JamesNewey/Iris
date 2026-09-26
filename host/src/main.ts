import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { load, type Store } from "@tauri-apps/plugin-store";
import { openUrl } from "@tauri-apps/plugin-opener";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting" | "error";
type SessionSummary = { id: string; url: string; title: string };
type AddConnectionResult = { connectionId: string; browserVersion: string; sessions: SessionSummary[] };
type FrameEvent = { type: "frame"; connectionId: string; sessionId: string; data: string };
type ThumbnailEvent = { type: "thumbnail"; connectionId: string; sessionId: string; data: string };
type SidecarPushEvent =
  | { type: "connectionStatus"; connectionId: string; status: ConnectionStatus; error?: string }
  | { type: "sessionAdded" | "sessionUpdated"; connectionId: string; session: SessionSummary }
  | { type: "sessionRemoved"; connectionId: string; sessionId: string }
  | { type: "consoleMessage"; connectionId: string; sessionId: string; level: string; text: string }
  | { type: "pageError"; connectionId: string; sessionId: string; message: string }
  | { type: "sidecarCrashed" | "sidecarRestarting"; [key: string]: unknown };

type ActivityKind = "navigation" | "console" | "pageerror";
interface ActivityEntry {
  timestamp: number;
  kind: ActivityKind;
  level?: string;
  text: string;
}

interface StoredConfig {
  configId: string;
  name: string;
  endpoint: string;
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
const thumbnails = new Map<string, string>(); // sessionId -> base64 jpeg
const activityLogs = new Map<string, ActivityEntry[]>(); // sessionId -> capped entries
const MAX_ACTIVITY_ENTRIES = 200;
let store: Store | null = null;

let connectionsListEl: HTMLElement | null;
let controlPanelEl: HTMLElement | null;
let controlSessionIdEl: HTMLElement | null;
let canvasEl: HTMLCanvasElement | null;
let latencyEl: HTMLElement | null;
let activityLogEl: HTMLElement | null;
let activityFilterEl: HTMLInputElement | null;
let commandResultEl: HTMLElement | null;

let activeConnectionId: string | null = null;
let activeSessionId: string | null = null;
let naturalWidth = 0;
let naturalHeight = 0;
let lastFrameData: string | null = null;

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

// Real clients aren't known to Iris in advance (Terraform's job, not
// Iris's — see the requirements doc's Non-Goals), so there's no way to ask
// one "what's your noVNC port". Placeholder assumption until a real
// convention is known: noVNC lives on the same host as the CDP endpoint, on
// the CDP port plus a fixed offset. Change NOVNC_PORT_OFFSET (and the dev
// test-client's port mappings, see dev/test-client/README.md) if that
// assumption turns out wrong.
const NOVNC_PORT_OFFSET = 100;

function deriveAdminUrl(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if (!url.port) return undefined;
    url.port = String(Number(url.port) + NOVNC_PORT_OFFSET);
    url.pathname = "/vnc.html";
    url.search = "?autoconnect=true";
    return url.toString();
  } catch {
    return undefined;
  }
}

// Runs every second to keep the "up Ns" readout live. Deliberately updates
// just the one text node per connection rather than calling render() — a
// full rebuild detaches/reattaches the control panel's <canvas>, which
// resets its bitmap in this webview and made the live view flash blank.
function updateUptimes() {
  for (const conn of connections.values()) {
    if (!conn.connectedAt || conn.status !== "connected") continue;
    const metaEl = document.getElementById(`meta-${conn.configId}`);
    if (!metaEl) continue;
    const bits: string[] = [];
    if (conn.browserVersion) bits.push(`Chrome ${conn.browserVersion}`);
    bits.push(`up ${Math.floor((Date.now() - conn.connectedAt) / 1000)}s`);
    if (conn.error) bits.push(`error: ${conn.error}`);
    metaEl.textContent = bits.join(" · ");
  }
}

function render() {
  if (!connectionsListEl) return;
  controlPanelEl?.remove(); // detach; re-attached below only if a session is actually under control
  connectionsListEl.innerHTML = "";

  for (const conn of connections.values()) {
    const li = document.createElement("li");
    li.className = "connection-item";

    const titlebar = document.createElement("div");
    titlebar.className = "connection-titlebar";

    const badge = document.createElement("span");
    badge.className = statusClass(conn.status);
    badge.textContent = STATUS_LABEL[conn.status];
    titlebar.appendChild(badge);

    const nameEl = document.createElement("strong");
    nameEl.textContent = conn.name;
    nameEl.title = "Click to rename";
    nameEl.className = "connection-name";
    nameEl.addEventListener("click", () => renameConnection(conn.configId));
    titlebar.appendChild(nameEl);

    const endpointEl = document.createElement("span");
    endpointEl.className = "connection-endpoint muted small";
    endpointEl.textContent = conn.endpoint;
    titlebar.appendChild(endpointEl);

    if (conn.endpoint.startsWith("http://")) {
      const insecureEl = document.createElement("span");
      insecureEl.className = "insecure-badge";
      insecureEl.textContent = "insecure";
      insecureEl.title = "This connection uses plain HTTP — traffic is not encrypted";
      titlebar.appendChild(insecureEl);
    }

    const metaBits: string[] = [];
    if (conn.browserVersion) metaBits.push(`Chrome ${conn.browserVersion}`);
    if (conn.connectedAt && conn.status === "connected") {
      metaBits.push(`up ${Math.floor((Date.now() - conn.connectedAt) / 1000)}s`);
    }
    if (conn.error) metaBits.push(`error: ${conn.error}`);
    if (metaBits.length > 0) {
      const metaEl = document.createElement("span");
      metaEl.id = `meta-${conn.configId}`;
      metaEl.className = "connection-meta muted small";
      metaEl.textContent = metaBits.join(" · ");
      titlebar.appendChild(metaEl);
    }

    const spacer = document.createElement("span");
    spacer.className = "spacer";
    titlebar.appendChild(spacer);

    const actions = document.createElement("div");
    actions.className = "connection-actions";
    const isLive = conn.connectionId !== null;

    const adminUrl = deriveAdminUrl(conn.endpoint);
    if (adminUrl) {
      const adminBtn = document.createElement("button");
      adminBtn.textContent = "Open admin view";
      adminBtn.title = "Opens the client's noVNC session directly — an escape hatch for when CDP control isn't available";
      adminBtn.addEventListener("click", () => {
        openUrl(adminUrl).catch((err) => showCommandResult(`Failed to open admin view: ${err}`, true));
      });
      actions.appendChild(adminBtn);
    }

    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = isLive ? "Disconnect" : "Reconnect";
    toggleBtn.addEventListener("click", () => (isLive ? disconnectConnection(conn.configId) : reconnectConnection(conn.configId)));
    actions.appendChild(toggleBtn);

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeConnection(conn.configId));
    actions.appendChild(removeBtn);
    titlebar.appendChild(actions);

    li.appendChild(titlebar);

    if (conn.sessions.size > 0) {
      const sessionsRow = document.createElement("ul");
      sessionsRow.className = "sessions-row";
      for (const s of conn.sessions.values()) {
        const isActive = conn.connectionId === activeConnectionId && s.id === activeSessionId;
        const sLi = document.createElement("li");
        sLi.className = "session-card";
        if (isActive) sLi.classList.add("session-active");

        const thumb = document.createElement("img");
        thumb.className = "thumb";
        thumb.id = `thumb-${s.id}`;
        thumb.title = s.url;
        const cached = thumbnails.get(s.id);
        if (cached) thumb.src = `data:image/jpeg;base64,${cached}`;
        thumb.addEventListener("click", () => takeControl(conn.connectionId!, s.id));
        sLi.appendChild(thumb);

        const label = document.createElement("div");
        label.className = "session-label";
        label.textContent = `${isActive ? "● " : ""}${s.title || "(untitled)"}`;
        sLi.appendChild(label);

        sessionsRow.appendChild(sLi);
      }
      li.appendChild(sessionsRow);

      if (conn.connectionId === activeConnectionId && activeSessionId && conn.sessions.has(activeSessionId) && controlPanelEl) {
        li.appendChild(controlPanelEl); // move the persistent control view in-flow, right after this connection's sessions
        // Reparenting a <canvas> clears its bitmap in this webview; repaint
        // the last frame immediately (same tick, before the browser paints)
        // so it never visibly flashes blank.
        if (lastFrameData) drawFrame(lastFrameData);
      }
    } else {
      const empty = document.createElement("div");
      empty.className = "muted small sessions-empty";
      empty.textContent = "No sessions";
      li.appendChild(empty);
    }

    connectionsListEl.appendChild(li);
  }
}

async function persist() {
  if (!store) return;
  await store.clear();
  for (const conn of connections.values()) {
    // Only name/endpoint go in the plaintext JSON store; the auth token (if
    // any) lives in the OS keychain, keyed by configId — see persistToken().
    const entry: StoredConfig = { configId: conn.configId, name: conn.name, endpoint: conn.endpoint };
    await store.set(conn.configId, entry);
  }
  await store.save();
}

async function persistToken(configId: string, token: string | undefined) {
  try {
    if (token) {
      await invoke("store_token", { configId, token });
    } else {
      await invoke("delete_token", { configId });
    }
  } catch (err) {
    console.error("Failed to persist token in OS keychain:", err);
  }
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
    for (const s of result.sessions) {
      conn.sessions.set(s.id, s);
      void startThumbnailFor(result.connectionId, s.id);
    }
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
  if (conn.connectionId === activeConnectionId) {
    activeConnectionId = null;
    activeSessionId = null;
    clearCanvas();
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
  if (conn.connectionId === activeConnectionId) {
    activeConnectionId = null;
    activeSessionId = null;
    clearCanvas();
  }
  connections.delete(configId);
  if (store) {
    await store.delete(configId);
    await store.save();
  }
  await persistToken(configId, undefined); // remove any stored auth token too
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

async function startThumbnailFor(connectionId: string, sessionId: string) {
  try {
    await invoke("start_thumbnail", { connectionId, sessionId });
  } catch {
    // session may already be gone; harmless
  }
}

async function stopThumbnailFor(connectionId: string, sessionId: string) {
  try {
    await invoke("stop_thumbnail", { connectionId, sessionId });
  } catch {
    // session may already be gone; harmless
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function activityEntryClass(entry: ActivityEntry): string {
  if (entry.kind === "navigation") return "entry-navigation";
  if (entry.kind === "pageerror") return "entry-pageerror";
  if (entry.level === "error") return "entry-console-error";
  if (entry.level === "warning") return "entry-console-warning";
  return "";
}

function activityEntryText(entry: ActivityEntry): string {
  const prefix = entry.kind === "navigation" ? "→" : entry.kind === "pageerror" ? "✕" : entry.level === "error" ? "✕" : "·";
  return `${prefix} ${entry.text}`;
}

function appendActivityLi(entry: ActivityEntry) {
  if (!activityLogEl) return;
  const filter = activityFilterEl?.value.trim().toLowerCase() ?? "";
  if (filter && !entry.text.toLowerCase().includes(filter)) return;

  const li = document.createElement("li");
  const cls = activityEntryClass(entry);
  if (cls) li.className = cls;
  const time = document.createElement("span");
  time.className = "entry-time";
  time.textContent = formatTime(entry.timestamp);
  li.appendChild(time);
  li.appendChild(document.createTextNode(activityEntryText(entry)));
  activityLogEl.appendChild(li);
  activityLogEl.scrollTop = activityLogEl.scrollHeight;
}

function logActivity(sessionId: string, kind: ActivityKind, text: string, level?: string) {
  const entry: ActivityEntry = { timestamp: Date.now(), kind, text, level };
  let list = activityLogs.get(sessionId);
  if (!list) {
    list = [];
    activityLogs.set(sessionId, list);
  }
  list.push(entry);
  if (list.length > MAX_ACTIVITY_ENTRIES) list.shift();

  if (sessionId === activeSessionId) appendActivityLi(entry);
}

function renderActivityLog() {
  if (!activityLogEl) return;
  activityLogEl.innerHTML = "";
  if (!activeSessionId) return;
  for (const entry of activityLogs.get(activeSessionId) ?? []) {
    appendActivityLi(entry);
  }
}

function clearCanvas() {
  naturalWidth = 0;
  naturalHeight = 0;
  lastFrameData = null;
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
  void startThumbnailFor(prevConnectionId, prevSessionId); // resume its thumbnail now the live view isn't covering it
}

async function takeControl(connectionId: string, sessionId: string) {
  if (activeSessionId === sessionId && activeConnectionId === connectionId) return; // already controlling this one
  await releaseActiveControl();

  activeConnectionId = connectionId;
  activeSessionId = sessionId;
  clearCanvas();
  void stopThumbnailFor(connectionId, sessionId); // the live screencast covers this session now; no need to also poll thumbnails

  const conn = findConnectionByLiveId(connectionId);
  const session = conn?.sessions.get(sessionId);
  if (controlSessionIdEl) controlSessionIdEl.textContent = session ? session.title || session.url : sessionId;
  if (latencyEl) latencyEl.textContent = "";
  if (commandResultEl) commandResultEl.textContent = "";
  const urlInput = document.querySelector<HTMLInputElement>("#url-input");
  if (urlInput) urlInput.value = session?.url ?? "";
  if (activityFilterEl) activityFilterEl.value = "";
  renderActivityLog();

  await invoke("take_control", { connectionId, sessionId });
  await invoke("start_screencast", { connectionId, sessionId });
  render(); // reflect the new "controlling" state in the sessions list
  controlPanelEl?.scrollIntoView({ block: "start", behavior: "instant" });
}

function drawFrame(dataBase64: string) {
  lastFrameData = dataBase64;
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

function showCommandResult(text: string, isError = false) {
  if (!commandResultEl) return;
  commandResultEl.textContent = text;
  commandResultEl.style.color = isError ? "#a12622" : "";
}

async function runSessionCommand(tauriCommand: string, label: string, extra: Record<string, unknown> = {}) {
  if (!activeConnectionId || !activeSessionId) return;
  showCommandResult(`${label}…`);
  try {
    await invoke(tauriCommand, { connectionId: activeConnectionId, sessionId: activeSessionId, ...extra });
    showCommandResult(`${label}: success`);
  } catch (err) {
    showCommandResult(`${label} failed: ${err}`, true);
  }
}

async function handleNavigateSubmit(ev: SubmitEvent) {
  ev.preventDefault();
  const input = document.querySelector<HTMLInputElement>("#url-input");
  const raw = input?.value.trim() ?? "";
  if (!raw) return;
  let url = raw;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    new URL(url);
  } catch {
    showCommandResult(`Invalid URL: ${raw}`, true);
    return;
  }
  await runSessionCommand("navigate", "Navigate", { url });
}

async function handleCloseSession() {
  if (!activeConnectionId || !activeSessionId) return;
  if (!confirm("Close this session's page? This cannot be undone.")) return;
  await runSessionCommand("close_session", "Close session");
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

async function handleCanvasKeydown(ev: KeyboardEvent) {
  if (!activeConnectionId || !activeSessionId) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return; // let modifier combos (copy/paste, devtools, etc.) pass through untouched
  ev.preventDefault();
  try {
    await invoke("send_key", { connectionId: activeConnectionId, sessionId: activeSessionId, key: ev.key, code: ev.code });
  } catch (err) {
    showCommandResult(`Key send failed: ${err}`, true);
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
    const previous = conn.sessions.get(session.id);
    const isNew = !previous;
    conn.sessions.set(session.id, session);
    if (isNew && !(conn.connectionId === activeConnectionId && session.id === activeSessionId)) {
      void startThumbnailFor(event.connectionId as string, session.id);
    }
    if (!isNew && previous.url !== session.url) {
      logActivity(session.id, "navigation", `navigated to ${session.url}`);
    }
    render();
  } else if (event.type === "consoleMessage") {
    logActivity(event.sessionId, "console", event.text, event.level);
  } else if (event.type === "pageError") {
    logActivity(event.sessionId, "pageerror", event.message);
  } else if (event.type === "sessionRemoved") {
    const conn = findConnectionByLiveId(event.connectionId as string);
    if (!conn) return;
    conn.sessions.delete(event.sessionId as string);
    thumbnails.delete(event.sessionId as string);
    activityLogs.delete(event.sessionId as string);
    if (event.sessionId === activeSessionId && conn.connectionId === activeConnectionId) {
      activeConnectionId = null;
      activeSessionId = null;
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
  activityLogEl = document.querySelector("#activity-log");
  activityFilterEl = document.querySelector("#activity-filter");
  commandResultEl = document.querySelector("#command-result");

  canvasEl?.addEventListener("click", handleCanvasClick);
  canvasEl?.addEventListener("keydown", handleCanvasKeydown);
  document.querySelector("#release-control-btn")?.addEventListener("click", async () => {
    await releaseActiveControl();
    clearCanvas();
    render();
  });

  document.querySelector<HTMLFormElement>("#navigate-form")?.addEventListener("submit", handleNavigateSubmit);
  document.querySelector("#reload-btn")?.addEventListener("click", () => runSessionCommand("reload_session", "Reload"));
  document.querySelector("#back-btn")?.addEventListener("click", () => runSessionCommand("go_back", "Back"));
  document.querySelector("#forward-btn")?.addEventListener("click", () => runSessionCommand("go_forward", "Forward"));
  document.querySelector("#close-session-btn")?.addEventListener("click", handleCloseSession);
  activityFilterEl?.addEventListener("input", renderActivityLog);

  store = await load("connections.json", { autoSave: false });
  const entries = await store.entries<StoredConfig>();
  for (const [, cfg] of entries) {
    let token: string | undefined;
    try {
      token = (await invoke<string | null>("get_token", { configId: cfg.configId })) ?? undefined;
    } catch (err) {
      console.error("Failed to read token from OS keychain:", err);
    }
    connections.set(cfg.configId, {
      configId: cfg.configId,
      connectionId: null,
      name: cfg.name,
      endpoint: cfg.endpoint,
      token,
      status: "idle",
      sessions: new Map(),
    });
  }
  render();
  for (const conn of connections.values()) {
    void connectConfig(conn); // auto-reconnect persisted connections on launch
  }

  const addConnectionDialog = document.querySelector<HTMLDialogElement>("#add-connection-dialog");

  document.querySelector("#fab-add-connection")?.addEventListener("click", () => {
    addConnectionDialog?.showModal();
  });
  document.querySelector("#cancel-add-connection")?.addEventListener("click", () => {
    addConnectionDialog?.close();
  });

  document.querySelector("#connect-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nameInput = document.querySelector<HTMLInputElement>("#name-input");
    const endpointInput = document.querySelector<HTMLInputElement>("#endpoint-input");
    const tokenInput = document.querySelector<HTMLInputElement>("#token-input");
    const name = nameInput?.value || "Untitled connection";
    const endpoint = endpointInput?.value ?? "";
    const token = tokenInput?.value || undefined;

    if (endpoint.startsWith("http://")) {
      const proceed = confirm(
        "This endpoint isn't using HTTPS — traffic to it (including any auth token) travels in plaintext. Continue anyway?"
      );
      if (!proceed) return;
    }

    addConnectionDialog?.close();
    if (tokenInput) tokenInput.value = "";

    const configId = crypto.randomUUID();
    const conn: Connection = { configId, connectionId: null, name, endpoint, token, status: "idle", sessions: new Map() };
    connections.set(configId, conn);
    await persist();
    await persistToken(configId, token);
    await connectConfig(conn);
  });

  listen<FrameEvent>("sidecar-frame", (event) => {
    if (event.payload.connectionId === activeConnectionId && event.payload.sessionId === activeSessionId) {
      drawFrame(event.payload.data);
    }
  });

  listen<SidecarPushEvent>("sidecar-event", (event) => handleSidecarEvent(event.payload));

  listen<ThumbnailEvent>("sidecar-thumbnail", (event) => {
    const { sessionId, data } = event.payload;
    thumbnails.set(sessionId, data);
    const img = document.getElementById(`thumb-${sessionId}`) as HTMLImageElement | null;
    if (img) img.src = `data:image/jpeg;base64,${data}`; // update in place, skip a full render()
  });

  setInterval(updateUptimes, 1000);
});
