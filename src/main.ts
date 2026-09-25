import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type SessionSummary = { id: string; url: string; title: string };
type AddConnectionResult = { connectionId: string; browserVersion: string; sessions: SessionSummary[] };
type FrameEvent = { type: "frame"; connectionId: string; sessionId: string; data: string };

let statusEl: HTMLElement | null;
let sessionsEl: HTMLElement | null;
let controlEl: HTMLElement | null;
let controlSessionIdEl: HTMLElement | null;
let canvasEl: HTMLCanvasElement | null;
let latencyEl: HTMLElement | null;

let activeConnectionId: string | null = null;
let activeSessionId: string | null = null;
let naturalWidth = 0;
let naturalHeight = 0;

function setStatus(text: string) {
  if (statusEl) statusEl.textContent = text;
}

function renderSessions(connectionId: string, sessions: SessionSummary[]) {
  if (!sessionsEl) return;
  sessionsEl.innerHTML = "";
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "row";
    row.textContent = `${s.id} — ${s.title || "(untitled)"} — ${s.url} `;
    const btn = document.createElement("button");
    btn.textContent = "Take control";
    btn.addEventListener("click", () => takeControl(connectionId, s.id));
    row.appendChild(btn);
    sessionsEl.appendChild(row);
  }
}

async function takeControl(connectionId: string, sessionId: string) {
  activeConnectionId = connectionId;
  activeSessionId = sessionId;
  if (controlSessionIdEl) controlSessionIdEl.textContent = sessionId;
  if (controlEl) controlEl.style.display = "block";
  setStatus(`Starting screencast for ${sessionId}...`);
  await invoke("start_screencast", { connectionId, sessionId });
  setStatus(`Live: ${sessionId}`);
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

window.addEventListener("DOMContentLoaded", () => {
  statusEl = document.querySelector("#status");
  sessionsEl = document.querySelector("#sessions");
  controlEl = document.querySelector("#control");
  controlSessionIdEl = document.querySelector("#control-session-id");
  canvasEl = document.querySelector("#screencast");
  latencyEl = document.querySelector("#latency");

  canvasEl?.addEventListener("click", handleCanvasClick);

  document.querySelector("#connect-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nameInput = document.querySelector<HTMLInputElement>("#name-input");
    const endpointInput = document.querySelector<HTMLInputElement>("#endpoint-input");
    const name = nameInput?.value || "Test client";
    const endpoint = endpointInput?.value ?? "";
    setStatus(`Connecting to ${endpoint}...`);
    try {
      const result = await invoke<AddConnectionResult>("add_connection", { name, endpoint });
      setStatus(`Connected — Chrome ${result.browserVersion}, ${result.sessions.length} session(s)`);
      renderSessions(result.connectionId, result.sessions);
    } catch (err) {
      setStatus(`Connect failed: ${err}`);
    }
  });

  listen<FrameEvent>("sidecar-frame", (event) => {
    if (event.payload.connectionId === activeConnectionId && event.payload.sessionId === activeSessionId) {
      drawFrame(event.payload.data);
    }
  });

  listen<Record<string, unknown>>("sidecar-event", (event) => {
    console.log("sidecar-event", event.payload);
  });
});
