// Local forward proxy that chains Chrome to an authenticated upstream proxy.
//
// Chrome's --proxy-server flag can't carry credentials, and answering its
// auth prompt over CDP would need a client attached to every target forever.
// Instead Chrome points at this unauthenticated loopback proxy, which adds
// Proxy-Authorization to everything it forwards to UPSTREAM_PROXY
// (http://user:pass@host:port). HTTPS goes through as a CONNECT tunnel, so
// nothing is decrypted here.
//
// Hosts matching BLOCKED_HOSTS (comma-separated; "*.example.com" matches
// example.com and every subdomain) get a 403 without touching the upstream,
// so Chrome's background traffic doesn't eat proxy bandwidth.
const http = require("http");
const net = require("net");

const LISTEN_PORT = parseInt(process.env.LOCAL_PROXY_PORT || "3128", 10);
const upstream = new URL(process.env.UPSTREAM_PROXY);
const UP_HOST = upstream.hostname;
const UP_PORT = parseInt(upstream.port || "80", 10);
const AUTH =
  "Basic " +
  Buffer.from(
    `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`
  ).toString("base64");

const BLOCKED = (process.env.BLOCKED_HOSTS ?? "*.googleapis.com,*.gvt1.com,*.googleusercontent.com")
  .split(",")
  .map((p) => p.trim().toLowerCase())
  .filter(Boolean);

function isBlocked(host) {
  host = host.toLowerCase();
  return BLOCKED.some((p) =>
    p.startsWith("*.") ? host === p.slice(2) || host.endsWith(p.slice(1)) : host === p
  );
}

const server = http.createServer((req, res) => {
  let hostname;
  try {
    ({ hostname } = new URL(req.url));
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (isBlocked(hostname)) {
    res.writeHead(403);
    res.end();
    return;
  }
  // Plain HTTP: req.url is already absolute-form, which is what a proxy expects.
  const upReq = http.request({
    host: UP_HOST,
    port: UP_PORT,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, "proxy-authorization": AUTH },
  });
  upReq.on("response", (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  upReq.on("error", (err) => {
    console.error("upstream-proxy http error:", err.message);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upReq);
});

server.on("connect", (req, clientSocket, head) => {
  if (isBlocked(req.url.replace(/:\d+$/, "").replace(/^\[|\]$/g, ""))) {
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const upSocket = net.connect(UP_PORT, UP_HOST, () => {
    upSocket.write(
      `CONNECT ${req.url} HTTP/1.1\r\n` +
        `Host: ${req.url}\r\n` +
        `Proxy-Authorization: ${AUTH}\r\n\r\n`
    );
  });

  // Read the upstream's CONNECT response headers, relay the status line to
  // Chrome, then splice the two sockets together.
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf("\r\n\r\n");
    if (end === -1) return;
    upSocket.off("data", onData);
    const statusLine = buf.subarray(0, buf.indexOf("\r\n")).toString();
    if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
      console.error(`upstream-proxy CONNECT ${req.url} refused: ${statusLine}`);
      clientSocket.end(`${statusLine}\r\n\r\n`);
      upSocket.destroy();
      return;
    }
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const rest = buf.subarray(end + 4);
    if (rest.length) clientSocket.write(rest);
    if (head.length) upSocket.write(head);
    upSocket.pipe(clientSocket);
    clientSocket.pipe(upSocket);
  };
  upSocket.on("data", onData);

  const kill = () => {
    clientSocket.destroy();
    upSocket.destroy();
  };
  upSocket.on("error", (err) => {
    console.error(`upstream-proxy CONNECT ${req.url} error:`, err.message);
    kill();
  });
  clientSocket.on("error", kill);
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`upstream-proxy on 127.0.0.1:${LISTEN_PORT} -> ${UP_HOST}:${UP_PORT}`);
  if (BLOCKED.length) console.log(`upstream-proxy blocking ${BLOCKED.join(", ")}`);
});
