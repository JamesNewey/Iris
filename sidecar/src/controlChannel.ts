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

// Windows virtual-key codes for the non-printable keys worth supporting for
// remote-control purposes. CDP needs these (not just `key`/`code`) for the
// target page to see real navigation/editing keys rather than nothing.
const VIRTUAL_KEY_CODES: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Backspace: 8,
  Delete: 46,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
};

export async function dispatchKey(cdp: CDPSession, key: string, code: string): Promise<void> {
  const virtualKeyCode = VIRTUAL_KEY_CODES[key];

  if (key.length === 1 && virtualKeyCode === undefined) {
    // Printable character: a single CDP "char" event both presses the key
    // and inserts the text, which is all a page normally observes for typing.
    await cdp.send("Input.dispatchKeyEvent", { type: "char", key, code, text: key });
    return;
  }

  const base = {
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
