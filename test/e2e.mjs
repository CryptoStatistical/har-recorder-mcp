// End-to-end:
//  1) http-only cookies captured as response Set-Cookie AND as the subsequent
//     request Cookie header (via CDP *ExtraInfo) — what naive exporters miss;
//  2) SERVICE WORKER network is captured (browser-level flatten auto-attach).
// Runs headless against a local server. Run: npm run build && node test/e2e.mjs
import http from "node:http";
import { RecordingManager } from "../dist/manager.js";

process.env.HAR_RECORDER_HEADLESS = "1";

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
  await sleep(4000); // page load + credentialed fetch + SW register/install/activate fetches
  const stopped = await manager.stop();
  console.log(`stopped: ${stopped.name} | req ${stopped.requestCount} | targets ${stopped.targetsCaptured} | http-only cookies ${stopped.httpOnlyCookieCount}`);

  const docEntry = await manager.getRequest(started.recordingId, { urlContains: `127.0.0.1:${port}/` });
  const apiEntry = await manager.getRequest(started.recordingId, { urlContains: "/api" });
  const swList = await manager.listRequests(started.recordingId, { urlContains: "/sw-fetch" });
  const jar = await manager.getCookies(started.recordingId);

  assert(stopped.requestCount >= 3, "almeno 3 richieste (documento + /api + /sw-fetch)");
  const docSetCookie = docEntry.response.cookies.find((c) => c.name === "sid");
  assert(!!docSetCookie && docSetCookie.httpOnly === true, "Set-Cookie http-only 'sid' nella risposta documento");
  const apiReqCookie = apiEntry.request.cookies.find((c) => c.name === "sid");
  assert(!!apiReqCookie, "Cookie http-only 'sid' NELLA RICHIESTA /api (via ExtraInfo)");
  assert(!!apiEntry.response.content.text?.includes("seenSid"), "body risposta /api catturato");
  assert(swList.matched >= 1, `fetch del SERVICE WORKER catturata (/sw-fetch): trovate ${swList.matched}`);
  assert(jar.httpOnly >= 2, `cookie jar con >=2 http-only (trovati ${jar.httpOnly})`);

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
