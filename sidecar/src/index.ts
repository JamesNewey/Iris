import { WebSocketServer, type WebSocket } from "ws";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";

const PORT = 8765;

type SessionEntry = {
  page: Page;
  cdp: CDPSession | null;
  screencastActive: boolean;
};

let browser: Browser | null = null;
const sessions = new Map<string, SessionEntry>();

function sessionId(index: number): string {
  return `session-${index}`;
}

async function handleConnect(endpoint: string) {
  browser = await chromium.connectOverCDP(endpoint);
  const contexts = browser.contexts();
  const pages = contexts.flatMap((ctx) => ctx.pages());

  sessions.clear();
  const summaries = await Promise.all(
    pages.map(async (page, i) => {
      const id = sessionId(i);
      sessions.set(id, { page, cdp: null, screencastActive: false });
      let title = "";
      try {
        title = await page.title();
      } catch {
        // page may be navigating; title is best-effort
      }
      return { id, url: page.url(), title };
    })
  );

  return { browserVersion: browser.version(), sessions: summaries };
}

async function getCdpSession(id: string): Promise<CDPSession> {
  const entry = sessions.get(id);
  if (!entry) throw new Error(`Unknown session ${id}`);
  if (!entry.cdp) {
    entry.cdp = await entry.page.context().newCDPSession(entry.page);
  }
  return entry.cdp;
}

async function startScreencast(id: string, onFrame: (dataBase64: string) => void) {
  const entry = sessions.get(id);
  if (!entry) throw new Error(`Unknown session ${id}`);
  const cdp = await getCdpSession(id);
  if (entry.screencastActive) return;
  entry.screencastActive = true;

  cdp.on("Page.screencastFrame", async (frame: any) => {
    onFrame(frame.data);
    try {
      await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
    } catch {
      // session may have gone away
    }
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60 });
}

async function stopScreencast(id: string) {
  const entry = sessions.get(id);
  if (!entry || !entry.cdp || !entry.screencastActive) return;
  entry.screencastActive = false;
  await entry.cdp.send("Page.stopScreencast");
}

async function dispatchClick(id: string, x: number, y: number) {
  const cdp = await getCdpSession(id);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function dispatchKey(id: string, text: string) {
  const cdp = await getCdpSession(id);
  for (const char of text) {
    await cdp.send("Input.dispatchKeyEvent", { type: "char", text: char });
  }
}

const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });

wss.on("error", (err: Error) => {
  console.error("Sidecar WS server error:", err.message);
  process.exit(1);
});

wss.on("connection", (ws: WebSocket) => {
  const send = (msg: unknown) => ws.send(JSON.stringify(msg));

  ws.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send({ type: "error", error: "invalid JSON" });
      return;
    }

    try {
      switch (msg.type) {
        case "connect": {
          const result = await handleConnect(msg.endpoint);
          send({ type: "connected", requestId: msg.requestId, ...result });
          break;
        }
        case "startScreencast": {
          await startScreencast(msg.sessionId, (data) => {
            send({ type: "frame", sessionId: msg.sessionId, data });
          });
          send({ type: "screencastStarted", requestId: msg.requestId, sessionId: msg.sessionId });
          break;
        }
        case "stopScreencast": {
          await stopScreencast(msg.sessionId);
          send({ type: "screencastStopped", requestId: msg.requestId, sessionId: msg.sessionId });
          break;
        }
        case "click": {
          const t0 = Date.now();
          await dispatchClick(msg.sessionId, msg.x, msg.y);
          send({ type: "clickDone", requestId: msg.requestId, sessionId: msg.sessionId, latencyMs: Date.now() - t0 });
          break;
        }
        case "key": {
          await dispatchKey(msg.sessionId, msg.text);
          send({ type: "keyDone", requestId: msg.requestId, sessionId: msg.sessionId });
          break;
        }
        default:
          send({ type: "error", requestId: msg.requestId, error: `Unknown message type ${msg.type}` });
      }
    } catch (err: any) {
      send({ type: "error", requestId: msg.requestId, error: err?.message ?? String(err) });
    }
  });
});

wss.on("listening", () => {
  console.log(`Iris sidecar listening on ws://127.0.0.1:${PORT}`);
});
