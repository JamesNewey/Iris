// Launches a real Chromium process with its CDP debugging port exposed on
// 127.0.0.1:9222, then opens a seed page as an independent client — proving
// that Iris (a separate CDP client) can discover a session it didn't create,
// same as it would for a real automation script running against this client.
//
// Deliberately NOT using playwright's chromium.launch(): Playwright's own
// launch wrapper drives Chrome over an internal pipe for its own control,
// which conflicts with also exposing a usable TCP CDP port. Launching the
// raw binary avoids that entirely.
const { spawn } = require("child_process");
const { chromium } = require("playwright-core");

const CHROME = chromium.executablePath();

const child = spawn(
  CHROME,
  [
    "--remote-debugging-port=9222",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--user-data-dir=/tmp/chrome-profile",
    "--no-first-run",
    "--no-default-browser-check",
  ],
  { stdio: "inherit", env: { ...process.env, DISPLAY: ":99" } }
);

child.on("exit", (code) => console.log("chrome exited", code));

setTimeout(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();
  await page.goto("https://example.com");
  console.log("Seed page loaded via independent CDP connection:", page.url());
  await browser.close(); // closes this client's connection, not the browser itself
}, 2000);
