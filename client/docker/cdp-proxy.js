// Minimal CDP-aware reverse proxy.
//
// Modern Chrome refuses to bind its remote-debugging port to anything but
// 127.0.0.1, and it rejects HTTP/WS requests whose Host header doesn't match
// what it's bound to (DNS-rebinding protection). Both defeat a naive
// Docker port-publish. This proxy sits inside the container, listens on
// 0.0.0.0, forwards to Chrome's real loopback port, rewrites the Host header
// on the way in (so Chrome accepts it) and rewrites the returned
// webSocketDebuggerUrl host:port on the way out (so external clients get a
// URL that actually routes back to them).
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");

const LISTEN_PORT = parseInt(process.env.PROXY_PORT || "9333", 10);
const TARGET_HOST = "127.0.0.1";
const TARGET_PORT = parseInt(process.env.CDP_PORT || "9222", 10);

// Resource usage of this whole container (Chrome, Xvfb, VNC, this proxy),
// read from its cgroup so it's measured against the container's own limits.
// CPU is a cumulative counter; the caller diffs two samples to get a rate.
function readFile(path) {
  try {
    return fs.readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function statField(text, key) {
  const match = text && text.match(new RegExp(`^${key} (\\d+)$`, "m"));
  return match ? Number(match[1]) : 0;
}

function readStats() {
  const hostCores = os.cpus().length;
  const unlimited = (n) => !Number.isFinite(n) || n <= 0 || n > os.totalmem() * 16;

  // cgroup v2
  const cpuStatV2 = readFile("/sys/fs/cgroup/cpu.stat");
  if (cpuStatV2 !== null && readFile("/sys/fs/cgroup/memory.current") !== null) {
    const [quota, period] = (readFile("/sys/fs/cgroup/cpu.max") || "max").split(" ");
    const memLimit = Number(readFile("/sys/fs/cgroup/memory.max"));
    return {
      source: "cgroup2",
      cpuUsageUsec: statField(cpuStatV2, "usage_usec"),
      cpuLimitCores: quota === "max" ? hostCores : Number(quota) / Number(period),
      // "working set": what kubectl/docker report — current minus reclaimable file cache
      memoryBytes:
        Number(readFile("/sys/fs/cgroup/memory.current")) -
        statField(readFile("/sys/fs/cgroup/memory.stat"), "inactive_file"),
      memoryLimitBytes: unlimited(memLimit) ? os.totalmem() : memLimit,
    };
  }

  // cgroup v1
  const cpuacct = readFile("/sys/fs/cgroup/cpuacct/cpuacct.usage") ?? readFile("/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage");
  const memUsage = readFile("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  if (cpuacct !== null && memUsage !== null) {
    const cpuDir = fs.existsSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us") ? "/sys/fs/cgroup/cpu" : "/sys/fs/cgroup/cpu,cpuacct";
    const quota = Number(readFile(`${cpuDir}/cpu.cfs_quota_us`));
    const period = Number(readFile(`${cpuDir}/cpu.cfs_period_us`));
    const memLimit = Number(readFile("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
    return {
      source: "cgroup1",
      cpuUsageUsec: Math.round(Number(cpuacct) / 1000),
      cpuLimitCores: quota > 0 && period > 0 ? quota / period : hostCores,
      memoryBytes: Number(memUsage) - statField(readFile("/sys/fs/cgroup/memory/memory.stat"), "total_inactive_file"),
      memoryLimitBytes: unlimited(memLimit) ? os.totalmem() : memLimit,
    };
  }

  // Fallback: the whole machine, from /proc/stat (USER_HZ is 100 on Linux).
  const [, ...ticks] = (readFile("/proc/stat") || "cpu 0").split("\n")[0].trim().split(/\s+/).map(Number);
  const idle = (ticks[3] || 0) + (ticks[4] || 0);
  const busy = ticks.slice(0, 8).reduce((a, b) => a + (b || 0), 0) - idle;
  return {
    source: "host",
    cpuUsageUsec: busy * 10_000,
    cpuLimitCores: hostCores,
    memoryBytes: os.totalmem() - os.freemem(),
    memoryLimitBytes: os.totalmem(),
  };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/iris/stats") {
    // Answered here, never forwarded to Chrome.
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ...readStats(), timestamp: Date.now() }));
    return;
  }
  const opts = {
    host: TARGET_HOST,
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` },
  };
  const upstream = http.request(opts, (upstreamRes) => {
    let chunks = [];
    upstreamRes.on("data", (c) => chunks.push(c));
    upstreamRes.on("end", () => {
      let body = Buffer.concat(chunks).toString("utf8");
      // Rewrite internal loopback references to whatever host:port the
      // external client actually used to reach us.
      const externalHostPort = req.headers.host;
      body = body.split(`${TARGET_HOST}:${TARGET_PORT}`).join(externalHostPort);
      // The rewrite changes the body's length whenever the external host:port
      // isn't exactly as long as 127.0.0.1:9222 (e.g. a real DNS name), so
      // Chrome's Content-Length no longer matches and strict clients (Node's
      // parser, so Playwright) reject the response.
      const headers = { ...upstreamRes.headers, "content-length": Buffer.byteLength(body) };
      delete headers["transfer-encoding"];
      res.writeHead(upstreamRes.statusCode, headers);
      res.end(body);
    });
  });
  req.pipe(upstream);
});

server.on("upgrade", (req, clientSocket, head) => {
  const targetSocket = net.connect(TARGET_PORT, TARGET_HOST, () => {
    const headers = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` };
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
    targetSocket.write(`${req.method} ${req.url} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
    if (head && head.length) targetSocket.write(head);
    targetSocket.pipe(clientSocket);
    clientSocket.pipe(targetSocket);
  });
  targetSocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => targetSocket.destroy());
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`CDP proxy listening on 0.0.0.0:${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
});
