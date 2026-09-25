// Per-session CDP screencast + input-dispatch handling, shared by session
// thumbnails and the large manual-control frame (they're the same CDP
// screencast, just sampled at different rates by the caller).
import type { CDPSession, Page } from "playwright-core";

export async function ensureCdpSession(page: Page, cache: { cdp: CDPSession | null }): Promise<CDPSession> {
  if (!cache.cdp) {
    cache.cdp = await page.context().newCDPSession(page);
  }
  return cache.cdp;
}

export async function startScreencast(cdp: CDPSession, onFrame: (dataBase64: string) => void): Promise<void> {
  cdp.on("Page.screencastFrame", (frame: any) => {
    onFrame(frame.data);
    cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {
      // session may have gone away between frame emission and ack
    });
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60 });
}

export async function stopScreencast(cdp: CDPSession): Promise<void> {
  await cdp.send("Page.stopScreencast");
}

export async function dispatchClick(cdp: CDPSession, x: number, y: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export async function dispatchKey(cdp: CDPSession, text: string): Promise<void> {
  for (const char of text) {
    await cdp.send("Input.dispatchKeyEvent", { type: "char", text: char });
  }
}
