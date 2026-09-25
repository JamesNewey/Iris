export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting" | "error";

export interface ConnectionConfig {
  id: string;
  name: string;
  endpoint: string;
}

export interface SessionSummary {
  id: string;
  url: string;
  title: string;
  headless: boolean;
  underControl: boolean;
  createdAt: number;
}

export type SidecarEvent =
  | { type: "connectionStatus"; connectionId: string; status: ConnectionStatus; error?: string }
  | { type: "sessionAdded"; connectionId: string; session: SessionSummary }
  | { type: "sessionUpdated"; connectionId: string; session: SessionSummary }
  | { type: "sessionRemoved"; connectionId: string; sessionId: string }
  | { type: "frame"; connectionId: string; sessionId: string; data: string }
  | { type: "consoleMessage"; connectionId: string; sessionId: string; level: string; text: string }
  | { type: "pageError"; connectionId: string; sessionId: string; message: string };
