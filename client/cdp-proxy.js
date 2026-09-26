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

const LISTEN_PORT = parseInt(process.env.PROXY_PORT || "9333", 10);
const TARGET_HOST = "127.0.0.1";
const TARGET_PORT = parseInt(process.env.CDP_PORT || "9222", 10);

const server = http.createServer((req, res) => {
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
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
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
