// End-to-end, all in one headless run against a local server:
//  1) http-only cookies captured as response Set-Cookie AND as the subsequent
//     request Cookie header (via CDP *ExtraInfo) — what naive exporters miss;
//  2) SERVICE WORKER network captured (browser-level flatten auto-attach);
//  3) WEBSOCKET frames captured (Network.webSocket* → _webSocketMessages).
// Run: npm run build && node test/e2e.mjs
import http from "node:http";
import crypto from "node:crypto";
import { RecordingManager } from "../dist/manager.js";

process.env.HAR_RECORDER_HEADLESS = "1";

// --- minimal raw WebSocket framing (avoids a test dependency) ---------------
const wsAccept = (key) => crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
function encodeTextFrame(str) {
  const p = Buffer.from(str);
  return Buffer.concat([Buffer.from([0x81, p.length]), p]); // text, FIN, len < 126
}
function decodeClientFrame(buf) {
  if (buf.length < 2) return null;
  if ((buf[0] & 0x0f) === 8) return null; // close frame
  const len = buf[1] & 0x7f;
  if (len >= 126) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let off = 2;
  let mask = null;
  if (masked) {
    mask = buf.subarray(off, off + 4);
    off += 4;
  }
  const data = buf.subarray(off, off + len);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = data[i] ^ (mask ? mask[i % 4] : 0);
  return out.toString();
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/") {
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Set-Cookie": "sid=secret123; HttpOnly; Path=/; SameSite=Lax",
    });
    res.end(`<!doctype html><meta charset=utf8><title>E2E Login</title><body>hi<script>
      navigator.serviceWorker.register('/sw.js');
      fetch('/api',{credentials:'include'}).then(r=>r.json()).then(j=>{document.title='done:'+j.seenSid});
      const ws=new WebSocket('ws://'+location.host+'/socket');
      ws.onopen=()=>ws.send('ping-from-client');
    </script>`);
  } else if (url === "/sw.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(`self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(fetch('/sw-fetch?from=install')); });
             self.addEventListener('activate', e => e.waitUntil(fetch('/sw-fetch?from=activate')));`);
  } else if (url === "/sw-fetch") {
    res.writeHead(200, { "Content-Type": "text/plain", "Set-Cookie": "swtoken=zzz; HttpOnly; Path=/" });
    res.end("sw-ok");
  } else if (url === "/api") {
    const cookie = req.headers["cookie"] ?? "";
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "api_token=xyz; HttpOnly; Path=/" });
    res.end(JSON.stringify({ seenSid: /sid=secret123/.test(cookie) }));
  } else {
    res.writeHead(404);
    res.end("no");
  }
});

server.on("upgrade", (req, socket) => {
  if (req.url !== "/socket") return socket.destroy();
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
      wsAccept(req.headers["sec-websocket-key"]) +
      "\r\n\r\n",
  );
  socket.write(encodeTextFrame("hello-from-server"));
  socket.on("data", (buf) => {
    const m = decodeClientFrame(buf);
    if (m != null && !m.startsWith("echo:")) socket.write(encodeTextFrame("echo:" + m));
  });
  socket.on("error", () => {});
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;

const manager = new RecordingManager();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? "✅" : "❌"} ${msg}`);
  if (!cond) failures++;
};

try {
  const started = await manager.start({ url, profile: "fresh", captureBodies: true, label: "e2e login" });
  await sleep(4000); // page load + fetch + SW install/activate + WS handshake/frames
  const stopped = await manager.stop();
  console.log(`stopped: ${stopped.name} | req ${stopped.requestCount} | targets ${stopped.targetsCaptured} | http-only ${stopped.httpOnlyCookieCount}`);

  const docEntry = await manager.getRequest(started.recordingId, { urlContains: `127.0.0.1:${port}/` });
  const apiEntry = await manager.getRequest(started.recordingId, { urlContains: "/api" });
  const swList = await manager.listRequests(started.recordingId, { urlContains: "/sw-fetch" });
  const wsEntry = await manager.getRequest(started.recordingId, { urlContains: "/socket" });
  const jar = await manager.getCookies(started.recordingId);

  assert(stopped.requestCount >= 4, "almeno 4 richieste (documento + /api + /sw-fetch + ws)");
  const docSetCookie = docEntry.response.cookies.find((c) => c.name === "sid");
  assert(!!docSetCookie && docSetCookie.httpOnly === true, "Set-Cookie http-only 'sid' nella risposta documento");
  const apiReqCookie = apiEntry.request.cookies.find((c) => c.name === "sid");
  assert(!!apiReqCookie, "Cookie http-only 'sid' NELLA RICHIESTA /api (via ExtraInfo)");
  assert(!!apiEntry.response.content.text?.includes("seenSid"), "body risposta /api catturato");
  assert(swList.matched >= 1, `fetch del SERVICE WORKER catturata (/sw-fetch): trovate ${swList.matched}`);
  assert(jar.httpOnly >= 2, `cookie jar con >=2 http-only (trovati ${jar.httpOnly})`);

  // WebSocket
  const msgs = wsEntry._webSocketMessages ?? [];
  const sent = msgs.filter((m) => m.type === "send");
  const recv = msgs.filter((m) => m.type === "receive");
  assert(wsEntry.response.status === 101, `handshake WS catturato (status ${wsEntry.response.status})`);
  assert(sent.length >= 1 && recv.length >= 1, `frame WS: send>=1 (${sent.length}) e receive>=1 (${recv.length})`);
  assert(recv.some((m) => m.data.includes("hello-from-server")), "frame server→client 'hello-from-server' presente");
  assert(sent.some((m) => m.data.includes("ping-from-client")), "frame client→server 'ping-from-client' presente");

  await manager.closeBrowser();
} catch (err) {
  console.error("E2E ERROR:", err);
  failures++;
} finally {
  await manager.dispose().catch(() => {});
  server.close();
}

console.log(failures === 0 ? "\nE2E PASS" : `\nE2E FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
