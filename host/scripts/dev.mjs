// `npm run dev` entry point: runs `tauri dev`, minus environment variables
// that a snap-packaged parent (e.g. VS Code installed as a snap, and so its
// integrated terminal) points into /snap/. Left in place, they make the app
// load the snap's bundled GTK/glibc pieces instead of the system's, and it
// dies at launch with:
//   symbol lookup error: /snap/core20/.../libpthread.so.0: undefined symbol: __libc_pthread_init
import { spawn } from "node:child_process";

const SNAP_POLLUTED = [
  "GTK_PATH",
  "GTK_EXE_PREFIX",
  "GDK_PIXBUF_MODULE_FILE",
  "GDK_PIXBUF_MODULEDIR",
  "GSETTINGS_SCHEMA_DIR",
  "LOCPATH",
  "GIO_MODULE_DIR",
  "GIO_LAUNCHED_DESKTOP_FILE",
];

const env = { ...process.env };
for (const name of SNAP_POLLUTED) {
  if (env[name]?.includes("/snap/")) delete env[name];
}

const child = spawn("tauri", ["dev", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
