import { randomUUID } from "node:crypto";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { dispatchClick, dispatchKey, ensureCdpSession, startScreencast, stopScreencast } from "./controlChannel.js";
import type { ConnectionConfig, ConnectionStatus, SessionSummary, SidecarEvent } from "./types.js";

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

interface SessionEntry {
  id: string;
  page: Page;
  cdp: CDPSession | null;
  screencastActive: boolean;
  underControl: boolean;
  headless: boolean;
  createdAt: number;
}

interface ConnectionEntry {
  config: ConnectionConfig;
  status: ConnectionStatus;
  browser: Browser | null;
  browserVersion: string | null;
  sessions: Map<string, SessionEntry>;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | null;
  closed: boolean;
}

function toSummary(entry: SessionEntry): SessionSummary {
  return {
    id: entry.id,
    url: entry.page.url(),
    title: "", // filled in lazily by callers that can await page.title()
    headless: entry.headless,
    underControl: entry.underControl,
    createdAt: entry.createdAt,
  };
}

export class ConnectionManager {
  private connections = new Map<string, ConnectionEntry>();

  constructor(private emit: (event: SidecarEvent) => void) {}

  async addConnection(name: string, endpoint: string): Promise<{ connectionId: string; browserVersion: string; sessions: SessionSummary[] }> {
    const id = randomUUID();
    const entry: ConnectionEntry = {
      config: { id, name, endpoint },
      status: "connecting",
      browser: null,
      browserVersion: null,
      sessions: new Map(),
      reconnectAttempt: 0,
      reconnectTimer: null,
      closed: false,
    };
    this.connections.set(id, entry);
    await this.connectEntry(entry);

    const summaries = await Promise.all([...entry.sessions.values()].map((s) => this.summarizeWithTitle(s)));
    return { connectionId: id, browserVersion: entry.browserVersion ?? "", sessions: summaries };
  }

  async removeConnection(connectionId: string): Promise<void> {
    const entry = this.getEntry(connectionId);
    entry.closed = true;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    if (entry.browser) {
      try {
        await entry.browser.close();
      } catch {
        // connection may already be dead
      }
    }
    this.connections.delete(connectionId);
  }

  async listSessions(connectionId: string): Promise<SessionSummary[]> {
    const entry = this.getEntry(connectionId);
    return Promise.all([...entry.sessions.values()].map((s) => this.summarizeWithTitle(s)));
  }

  async navigate(connectionId: string, sessionId: string, url: string): Promise<void> {
    const { session } = this.getSession(connectionId, sessionId);
    await session.page.goto(url);
  }

  async reload(connectionId: string, sessionId: string): Promise<void> {
    const { session } = this.getSession(connectionId, sessionId);
    await session.page.reload();
  }

  async goBack(connectionId: string, sessionId: string): Promise<void> {
    const { session } = this.getSession(connectionId, sessionId);
    await session.page.goBack();
  }

  async goForward(connectionId: string, sessionId: string): Promise<void> {
    const { session } = this.getSession(connectionId, sessionId);
    await session.page.goForward();
  }

  async closeSession(connectionId: string, sessionId: string): Promise<void> {
    const { session } = this.getSession(connectionId, sessionId);
    await session.page.close();
    // the page's 'close' listener (registered in registerSession) removes it
    // from the map and emits sessionRemoved.
  }

  async takeControl(connectionId: string, sessionId: string): Promise<void> {
    const { entry, session } = this.getSession(connectionId, sessionId);
    if (session.underControl) throw new Error(`Session ${sessionId} is already under control`);
    session.underControl = true;
    this.emit({ type: "sessionUpdated", connectionId, session: toSummary(session) });
    void entry; // entry currently unused beyond lookup, kept for symmetry/future use
  }

  async releaseControl(connectionId: string, sessionId: string): Promise<void> {
    const { session } = this.getSession(connectionId, sessionId);
    session.underControl = false;
    this.emit({ type: "sessionUpdated", connectionId, session: toSummary(session) });
  }

  async startScreencast(connectionId: string, sessionId: string): Promise<void> {
    const { session } = this.getSession(connectionId, sessionId);
    if (session.screencastActive) return;
    const cdp = await ensureCdpSession(session.page, session);
    session.screencastActive = true;
    await startScreencast(cdp, (data) => {
      this.emit({ type: "frame", connectionId, sessionId, data });
    });
  }

  async stopScreencast(connectionId: string, sessionId: string): Promise<void> {
    const { session } = this.getSession(connectionId, sessionId);
    if (!session.cdp || !session.screencastActive) return;
    session.screencastActive = false;
    await stopScreencast(session.cdp);
  }

  async click(connectionId: string, sessionId: string, x: number, y: number): Promise<{ latencyMs: number }> {
    const { session } = this.getSession(connectionId, sessionId);
    const cdp = await ensureCdpSession(session.page, session);
    const t0 = Date.now();
    await dispatchClick(cdp, x, y);
    return { latencyMs: Date.now() - t0 };
  }

  async key(connectionId: string, sessionId: string, text: string): Promise<void> {
    const { session } = this.getSession(connectionId, sessionId);
    const cdp = await ensureCdpSession(session.page, session);
    await dispatchKey(cdp, text);
  }

  // --- internals ---

  private getEntry(connectionId: string): ConnectionEntry {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`Unknown connection ${connectionId}`);
    return entry;
  }

  private getSession(connectionId: string, sessionId: string): { entry: ConnectionEntry; session: SessionEntry } {
    const entry = this.getEntry(connectionId);
    const session = entry.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId} on connection ${connectionId}`);
    return { entry, session };
  }

  private async summarizeWithTitle(session: SessionEntry): Promise<SessionSummary> {
    let title = "";
    try {
      title = await session.page.title();
    } catch {
      // page may be navigating away right now; best-effort only
    }
    return { ...toSummary(session), title };
  }

  private async connectEntry(entry: ConnectionEntry): Promise<void> {
    entry.status = "connecting";
    this.emit({ type: "connectionStatus", connectionId: entry.config.id, status: "connecting" });

    const browser = await chromium.connectOverCDP(entry.config.endpoint);
    entry.browser = browser;
    entry.browserVersion = browser.version();
    entry.status = "connected";
    entry.reconnectAttempt = 0;
    this.emit({ type: "connectionStatus", connectionId: entry.config.id, status: "connected" });

    browser.on("disconnected", () => this.handleDisconnect(entry));

    for (const ctx of browser.contexts()) {
      ctx.on("page", (page) => this.registerSession(entry, page));
      for (const page of ctx.pages()) {
        this.registerSession(entry, page, /* announce */ false);
      }
    }
  }

  private registerSession(entry: ConnectionEntry, page: Page, announce = true): void {
    const id = randomUUID();
    const session: SessionEntry = {
      id,
      page,
      cdp: null,
      screencastActive: false,
      underControl: false,
      headless: false, // CDP-attached pages don't expose this reliably; default false until a better signal exists
      createdAt: Date.now(),
    };
    entry.sessions.set(id, session);

    page.on("framenavigated", () => {
      this.emit({ type: "sessionUpdated", connectionId: entry.config.id, session: toSummary(session) });
    });
    page.on("console", (msg) => {
      this.emit({
        type: "consoleMessage",
        connectionId: entry.config.id,
        sessionId: id,
        level: msg.type(),
        text: msg.text(),
      });
    });
    page.on("pageerror", (err) => {
      this.emit({ type: "pageError", connectionId: entry.config.id, sessionId: id, message: err.message });
    });
    page.on("close", () => {
      entry.sessions.delete(id);
      this.emit({ type: "sessionRemoved", connectionId: entry.config.id, sessionId: id });
    });

    if (announce) {
      this.emit({ type: "sessionAdded", connectionId: entry.config.id, session: toSummary(session) });
    }
  }

  private handleDisconnect(entry: ConnectionEntry): void {
    if (entry.closed) return; // deliberate removeConnection, not a drop

    entry.browser = null;
    for (const id of entry.sessions.keys()) {
      this.emit({ type: "sessionRemoved", connectionId: entry.config.id, sessionId: id });
    }
    entry.sessions.clear();

    entry.status = "reconnecting";
    this.emit({ type: "connectionStatus", connectionId: entry.config.id, status: "reconnecting" });
    this.scheduleReconnect(entry);
  }

  private scheduleReconnect(entry: ConnectionEntry): void {
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** entry.reconnectAttempt, MAX_BACKOFF_MS);
    entry.reconnectAttempt += 1;
    entry.reconnectTimer = setTimeout(async () => {
      if (entry.closed) return;
      try {
        await this.connectEntry(entry);
      } catch (err: any) {
        entry.status = "error";
        this.emit({
          type: "connectionStatus",
          connectionId: entry.config.id,
          status: "error",
          error: err?.message ?? String(err),
        });
        this.scheduleReconnect(entry);
      }
    }, delay);
  }
}
