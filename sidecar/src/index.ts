import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { ConnectionManager } from "./connectionManager.js";
import type { SidecarEvent } from "./types.js";

const PORT = 8765;

const sockets = new Set<WebSocket>();

function broadcast(event: SidecarEvent) {
  const payload = JSON.stringify(event);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

const manager = new ConnectionManager(broadcast);

const incomingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("addConnection"), requestId: z.number(), name: z.string(), endpoint: z.string(), token: z.string().optional() }),
  z.object({ type: z.literal("removeConnection"), requestId: z.number(), connectionId: z.string() }),
  z.object({ type: z.literal("listSessions"), requestId: z.number(), connectionId: z.string() }),
  z.object({ type: z.literal("navigate"), requestId: z.number(), connectionId: z.string(), sessionId: z.string(), url: z.string() }),
  z.object({ type: z.literal("reload"), requestId: z.number(), connectionId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("goBack"), requestId: z.number(), connectionId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("goForward"), requestId: z.number(), connectionId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("closeSession"), requestId: z.number(), connectionId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("takeControl"), requestId: z.number(), connectionId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("releaseControl"), requestId: z.number(), connectionId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("startScreencast"), requestId: z.number(), connectionId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("stopScreencast"), requestId: z.number(), connectionId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("startThumbnail"), requestId: z.number(), connectionId: z.string(), sessionId: z.string(), intervalMs: z.number().optional() }),
  z.object({ type: z.literal("stopThumbnail"), requestId: z.number(), connectionId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("click"), requestId: z.number(), connectionId: z.string(), sessionId: z.string(), x: z.number(), y: z.number() }),
  z.object({ type: z.literal("key"), requestId: z.number(), connectionId: z.string(), sessionId: z.string(), key: z.string(), code: z.string() }),
]);

type IncomingMessage = z.infer<typeof incomingSchema>;

async function handle(msg: IncomingMessage): Promise<unknown> {
  switch (msg.type) {
    case "addConnection":
      return manager.addConnection(msg.name, msg.endpoint, msg.token);
    case "removeConnection":
      await manager.removeConnection(msg.connectionId);
      return {};
    case "listSessions":
      return { sessions: await manager.listSessions(msg.connectionId) };
    case "navigate":
      await manager.navigate(msg.connectionId, msg.sessionId, msg.url);
      return {};
    case "reload":
      await manager.reload(msg.connectionId, msg.sessionId);
      return {};
    case "goBack":
      await manager.goBack(msg.connectionId, msg.sessionId);
      return {};
    case "goForward":
      await manager.goForward(msg.connectionId, msg.sessionId);
      return {};
    case "closeSession":
      await manager.closeSession(msg.connectionId, msg.sessionId);
      return {};
    case "takeControl":
      await manager.takeControl(msg.connectionId, msg.sessionId);
      return {};
    case "releaseControl":
      await manager.releaseControl(msg.connectionId, msg.sessionId);
      return {};
    case "startScreencast":
      await manager.startScreencast(msg.connectionId, msg.sessionId);
      return {};
    case "stopScreencast":
      await manager.stopScreencast(msg.connectionId, msg.sessionId);
      return {};
    case "startThumbnail":
      return manager.startThumbnail(msg.connectionId, msg.sessionId, msg.intervalMs);
    case "stopThumbnail":
      await manager.stopThumbnail(msg.connectionId, msg.sessionId);
      return {};
    case "click":
      return manager.click(msg.connectionId, msg.sessionId, msg.x, msg.y);
    case "key":
      await manager.key(msg.connectionId, msg.sessionId, msg.key, msg.code);
      return {};
  }
}

const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });

wss.on("error", (err: Error) => {
  console.error("Sidecar WS server error:", err.message);
  process.exit(1);
});

wss.on("connection", (ws: WebSocket) => {
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));

  ws.on("message", async (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid JSON" }));
      return;
    }

    const result = incomingSchema.safeParse(parsed);
    if (!result.success) {
      const requestId = (parsed as any)?.requestId;
      ws.send(JSON.stringify({ type: "error", requestId, error: result.error.message }));
      return;
    }

    const msg = result.data;
    try {
      const response = await handle(msg);
      ws.send(JSON.stringify({ type: `${msg.type}Result`, requestId: msg.requestId, ...(response as object) }));
    } catch (err: any) {
      ws.send(JSON.stringify({ type: "error", requestId: msg.requestId, error: err?.message ?? String(err) }));
    }
  });
});

wss.on("listening", () => {
  console.log(`Iris sidecar listening on ws://127.0.0.1:${PORT}`);
});
