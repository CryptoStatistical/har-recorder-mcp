#!/usr/bin/env node
/**
 * Local web dashboard for the HAR recorder — a second front-end alongside the
 * MCP server. It can START / STOP / checkpoint / close recordings and inspect
 * them (live or on disk), reusing the same RecordingManager engine.
 *
 * Process model: this is a SEPARATE process from the MCP server, so it owns its
 * OWN RecordingManager. It fully controls the sessions it launches; sessions
 * launched via MCP are only visible here once stopped (read from `.recording/`).
 *
 * Run: `npm run ui` (compiles to dist/web.js). Binds to 127.0.0.1 ONLY — the
 * recordings hold live session cookies/tokens AND this endpoint can launch a
 * browser, so it must never be reachable off the loopback interface. Mutating
 * requests are additionally guarded against cross-origin (CSRF / DNS-rebinding).
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, stat as fsStat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_NAME, SERVER_VERSION, recordingRoot, resolveRoot } from "./config.js";
import { cookiesFromHar, selectEntry, summarizeRequests, type RequestFilter } from "./har.js";
import { log, logError } from "./log.js";
import { RecordingManager } from "./manager.js";
import { findIndexEntry, readCookies, readHar, readIndex, readMetadata, recordingDirPath } from "./storage.js";
import type { Har } from "./har.js";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4477;
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const manager = new RecordingManager();

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

// ---------------------------------------------------------------------------
// MRU HAR cache so paging/filtering a stopped recording's requests table
// doesn't re-read & re-parse a (potentially large) session.har every click.
// (Live recordings are served straight from the in-memory manager instead.)
// ---------------------------------------------------------------------------
const harCache = new Map<string, { mtimeMs: number; har: Har }>();

async function loadHar(dir: string): Promise<Har> {
  const harFile = path.join(recordingDirPath(dir), "session.har");
  let mtimeMs = 0;
  try {
    mtimeMs = (await fsStat(harFile)).mtimeMs;
  } catch {
    /* fall through to readHar, which throws a clearer error */
  }
  const cached = harCache.get(dir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.har;
  const har = await readHar(dir);
  harCache.set(dir, { mtimeMs, har });
  if (harCache.size > 4) harCache.delete(harCache.keys().next().value as string);
  return har;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function notFound(res: ServerResponse, message = "Not found"): void {
  sendJson(res, 404, { error: message });
}
function num(value: string | null | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
function str(value: string | null | undefined): string | undefined {
  return value && value.length ? value : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new Error("Body must be a JSON object.");
  return parsed as Record<string, unknown>;
}

/**
 * Reject cross-origin mutating requests: a malicious page in the user's browser
 * could otherwise POST to 127.0.0.1 and launch a capture. Loopback Host is also
 * enforced to blunt DNS-rebinding. Origin-less callers (curl) are allowed.
 */
function sameOriginOk(req: IncomingMessage, port: number): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client (no Origin header)
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

async function resolveStoppedDir(id: string): Promise<{ id: string; dir: string } | undefined> {
  const idx = await findIndexEntry(id);
  if (!idx || idx.status !== "stopped") return undefined;
  return { id: idx.id, dir: idx.dir };
}

function serveStatic(res: ServerResponse, pathname: string): void {
  const entry = STATIC_FILES[pathname];
  if (!entry) {
    notFound(res);
    return;
  }
  const filePath = path.join(PUBLIC_DIR, entry.file);
  const stream = createReadStream(filePath);
  // no-store so iterating on the UI never serves a stale app.js/styles.css.
  stream.on("open", () => res.writeHead(200, { "content-type": entry.type, "cache-control": "no-store" }));
  stream.on("error", () => {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("UI assets missing — did you run `npm run build`?");
  });
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// GET API
// ---------------------------------------------------------------------------

async function handleGet(res: ServerResponse, url: URL): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

  // GET /api/status — live snapshot of the active session (or idle)
  if (parts.length === 2 && parts[1] === "status") {
    sendJson(res, 200, await manager.status());
    return;
  }

  // GET /api/recordings — list (newest first); flags the active one
  if (parts.length === 2 && parts[1] === "recordings") {
    const entries = await readIndex();
    const activeId = manager.activeRecordingId();
    const recordings = entries
      .slice()
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
      .map((e) => ({
        recordingId: e.id,
        name: e.dir,
        status: e.status,
        live: e.id === activeId,
        url: e.url,
        host: e.host,
        title: e.title,
        label: e.label,
        startedAt: e.startedAt,
        stoppedAt: e.stoppedAt,
        requestCount: e.requestCount,
        cookieCount: e.cookieCount,
        webSocketCount: e.webSocketCount,
        webSocketFrameCount: e.webSocketFrameCount,
      }));
    sendJson(res, 200, { root: resolveRoot(), count: recordings.length, activeRecordingId: activeId, recordings });
    return;
  }

  if (parts.length >= 3 && parts[1] === "recordings") {
    const id = decodeURIComponent(parts[2]);
    const sub = parts[3];
    // "live" means still recording — once stopped, everything is on disk, so we
    // serve from disk even while the (stopped) browser is still open.
    const live = manager.activeRecordingId() === id;
    const found = live ? { id, dir: "" } : await resolveStoppedDir(id);
    if (!found) {
      notFound(res, `Recording not found (or not yet stopped): ${id}`);
      return;
    }
    const { dir } = found;

    // GET /api/recordings/:id — metadata (live: synthesized from status)
    if (!sub) {
      if (live) {
        const s = (await manager.status(id)) as Record<string, unknown>;
        sendJson(res, 200, { ...s, live: true, host: hostOf(String(s.url ?? "")) });
        return;
      }
      const metadata = await readMetadata(dir);
      if (!metadata) {
        notFound(res, `metadata.json missing for ${id}`);
        return;
      }
      sendJson(res, 200, { ...metadata, live: false });
      return;
    }

    // GET /api/recordings/:id/requests
    if (sub === "requests") {
      const filter: RequestFilter = {
        method: str(url.searchParams.get("method")),
        status: num(url.searchParams.get("status")),
        urlContains: str(url.searchParams.get("urlContains")),
        mimeType: str(url.searchParams.get("mimeType")),
        resourceType: str(url.searchParams.get("resourceType")),
        limit: num(url.searchParams.get("limit")) ?? 1000,
        offset: num(url.searchParams.get("offset")) ?? 0,
      };
      if (live) {
        sendJson(res, 200, await manager.listRequests(id, filter));
        return;
      }
      sendJson(res, 200, { ...summarizeRequests(await loadHar(dir), filter), live: false });
      return;
    }

    // GET /api/recordings/:id/request?index=N
    if (sub === "request") {
      const selector = {
        index: num(url.searchParams.get("index")),
        requestId: str(url.searchParams.get("requestId")),
        urlContains: str(url.searchParams.get("urlContains")),
      };
      const entry = live ? await manager.getRequest(id, selector) : selectEntry(await loadHar(dir), selector);
      if (!entry) {
        notFound(res, "Request not found for the given selector.");
        return;
      }
      sendJson(res, 200, entry);
      return;
    }

    // GET /api/recordings/:id/cookies?domain=
    if (sub === "cookies") {
      const domain = str(url.searchParams.get("domain"));
      if (live) {
        sendJson(res, 200, await manager.getCookies(id, domain));
        return;
      }
      let all = await readCookies(dir);
      // cookies.json can be empty (older recordings hit the headful getAllCookies
      // bug) — reconstruct the jar from the captured HAR traffic instead.
      if (!all.length) {
        try {
          all = cookiesFromHar(await loadHar(dir));
        } catch {
          /* no HAR — leave empty */
        }
      }
      const cookies = domain ? all.filter((c) => (c.domain ?? "").toLowerCase().includes(domain.toLowerCase())) : all;
      sendJson(res, 200, {
        total: cookies.length,
        httpOnly: cookies.filter((c) => c.httpOnly).length,
        secure: cookies.filter((c) => c.secure).length,
        cookies,
      });
      return;
    }

    // GET /api/recordings/:id/summary — disk only
    if (sub === "summary") {
      if (live) {
        notFound(res, "summary.md is written on stop_recording.");
        return;
      }
      const filePath = path.join(recordingDirPath(dir), "summary.md");
      const stream = createReadStream(filePath);
      stream.on("open", () => res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }));
      stream.on("error", () => notFound(res, "summary.md missing."));
      stream.pipe(res);
      return;
    }

    // GET /api/recordings/:id/files — list downloadable artifacts (with sizes)
    if (sub === "files") {
      if (live) {
        notFound(res, "Files are written on stop_recording.");
        return;
      }
      sendJson(res, 200, { files: await listFiles(dir), partLimitMB: 20 });
      return;
    }

    // GET /api/recordings/:id/file/<name> — download a single artifact
    if (sub === "file") {
      if (live) {
        notFound(res, "Files are written on stop_recording.");
        return;
      }
      const name = path.basename(decodeURIComponent(parts[4] ?? ""));
      if (!name) {
        notFound(res, "Missing file name.");
        return;
      }
      const dirPath = recordingDirPath(dir);
      const filePath = path.join(dirPath, name);
      // path-guard: the resolved file must stay inside the recording directory.
      if (path.relative(dirPath, filePath).startsWith("..")) {
        notFound(res, "Invalid file path.");
        return;
      }
      const stream = createReadStream(filePath);
      stream.on("open", () =>
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
        }),
      );
      stream.on("error", () => notFound(res, `File not found: ${name}`));
      stream.pipe(res);
      return;
    }

    // GET /api/recordings/:id/claude-prompt — continuation prompt + transfer info
    if (sub === "claude-prompt") {
      if (live) {
        notFound(res, "Stop the recording first to hand it to Claude.");
        return;
      }
      const meta = await readMetadata(dir);
      sendJson(res, 200, buildClaudePrompt(id, dir, meta));
      return;
    }
  }

  notFound(res);
}

// ---------------------------------------------------------------------------
// download helpers
// ---------------------------------------------------------------------------

/** Classify an artifact by name so the UI can label/sort the download list. */
function fileKind(name: string): string {
  if (/\.zip\.\d+$/.test(name)) return "part";
  if (name.endsWith(".har")) return "har";
  if (name.endsWith(".har.gz")) return "har.gz";
  if (name.endsWith(".zip")) return "zip";
  if (name === "cookies.json") return "cookies";
  if (name === "metadata.json") return "metadata";
  if (name === "summary.md") return "summary";
  return "other";
}

async function listFiles(dir: string): Promise<Array<{ name: string; bytes: number; kind: string }>> {
  const dirPath = recordingDirPath(dir);
  const names = await readdir(dirPath);
  const files: Array<{ name: string; bytes: number; kind: string }> = [];
  for (const name of names) {
    try {
      const st = await fsStat(path.join(dirPath, name));
      if (st.isFile()) files.push({ name, bytes: st.size, kind: fileKind(name) });
    } catch {
      /* skip unreadable */
    }
  }
  const order = ["zip", "part", "har", "har.gz", "cookies", "summary", "metadata", "other"];
  files.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
  return files;
}

/**
 * Build the continuation prompt the user pastes into the Claude conversation that
 * launched the MCP, plus the split-part info to attach (Claude's upload caps at
 * ~20 MB, so large bundles travel as the ≤20 MB parts; the whole file is for the
 * local download instead).
 */
function buildClaudePrompt(
  id: string,
  dir: string,
  meta: Awaited<ReturnType<typeof readMetadata>>,
): { prompt: string; split: boolean; parts: string[]; zipName?: string; reconstruct?: string; dir: string } {
  const absDir = recordingDirPath(dir);
  const name = meta?.title || meta?.label || meta?.host || dir;
  const zipName = meta?.files?.zip;
  const parts = meta?.zipParts ?? [];
  const split = parts.length > 0;
  const reconstruct = split && zipName ? `cat ${zipName}.* > ${zipName} && unzip ${zipName}` : undefined;

  const lines = [
    `Continue: analyze the recorded browsing session "${name}" captured by the har-recorder MCP (recordingId: ${id}).`,
    "",
    "Use the har-recorder tools to reconstruct what happened:",
    '- list_requests with resourceType="document" for the navigation path, and method="POST" for actions/login;',
    "- get_request for the details of the relevant requests;",
    "- get_cookies for the session jar (http-only included).",
    "Summarize: where I went, the hosts contacted, the authentication requests, and whether an authenticated session was established.",
    "",
    `The recording is saved locally at: ${absDir}`,
  ];
  if (split) {
    lines.push(
      "",
      `The full bundle is split into ${parts.length} parts for upload (each ≤20 MB): ${parts.join(", ")}.`,
      "Attach ALL the parts to me, then rejoin them BEFORE opening session.har:",
      `  ${reconstruct}`,
    );
  }
  return { prompt: lines.join("\n"), split, parts, zipName, reconstruct, dir: absDir };
}

// ---------------------------------------------------------------------------
// POST API (control)
// ---------------------------------------------------------------------------

async function handlePost(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean);
  const body = await readBody(req);

  // POST /api/recordings — start
  if (parts.length === 2 && parts[1] === "recordings") {
    const result = await manager.start({
      url: str(body.url as string),
      label: str(body.label as string),
      profile: body.profile === "fresh" ? "fresh" : body.profile === "persistent" ? "persistent" : undefined,
      captureBodies: typeof body.captureBodies === "boolean" ? body.captureBodies : undefined,
      channel: str(body.channel as string),
      attachToPort: num(body.attachToPort as string),
    });
    sendJson(res, 200, result);
    return;
  }

  if (parts.length === 4 && parts[1] === "recordings") {
    const id = decodeURIComponent(parts[2]);
    const action = parts[3];
    if (action === "stop") {
      sendJson(res, 200, await manager.stop(id));
      return;
    }
    if (action === "checkpoint") {
      const label = str(body.label as string);
      if (!label) {
        sendJson(res, 400, { error: "Field 'label' is required." });
        return;
      }
      sendJson(res, 200, manager.markCheckpoint(id, label));
      return;
    }
    if (action === "annotate") {
      const note = str(body.note as string);
      if (!note) {
        sendJson(res, 400, { error: "Field 'note' is required." });
        return;
      }
      sendJson(res, 200, await manager.annotate(id, note));
      return;
    }
    if (action === "close") {
      sendJson(res, 200, await manager.closeBrowser(id));
      return;
    }
    if (action === "delete") {
      const idx = await findIndexEntry(id);
      const result = await manager.deleteRecording(id);
      if (idx) harCache.delete(idx.dir); // drop any cached HAR for the removed recording
      sendJson(res, 200, result);
      return;
    }
  }

  notFound(res);
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

function openInBrowser(targetUrl: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", targetUrl] : [targetUrl];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => log(`Open manually: ${targetUrl}`));
    child.unref();
  } catch {
    log(`Open manually: ${targetUrl}`);
  }
}

function start(): void {
  const port = num(process.env.HAR_RECORDER_UI_PORT) ?? DEFAULT_PORT;

  const server = createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${HOST}:${port}`);

    if (method === "GET") {
      if (url.pathname.startsWith("/api/")) {
        handleGet(res, url).catch((err) => {
          logError("api error", err);
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        });
      } else {
        serveStatic(res, url.pathname);
      }
      return;
    }

    if (method === "POST") {
      if (!url.pathname.startsWith("/api/")) {
        notFound(res);
        return;
      }
      if (!sameOriginOk(req, port)) {
        sendJson(res, 403, { error: "Cross-origin request refused." });
        return;
      }
      handlePost(req, res, url).catch((err) => {
        logError("api error", err);
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      });
      return;
    }

    sendJson(res, 405, { error: "Method not allowed." });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logError(`Port ${port} is in use. Set HAR_RECORDER_UI_PORT=<free port> and try again.`);
      process.exit(1);
    }
    logError("server error", err);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    const targetUrl = `http://${HOST}:${port}/`;
    log(`${SERVER_NAME} dashboard v${SERVER_VERSION} → ${targetUrl}`);
    log(`Recordings from: ${recordingRoot()}`);
    if (process.env.HAR_RECORDER_UI_NO_OPEN !== "1") openInBrowser(targetUrl);
  });

  const shutdown = async () => {
    try {
      await manager.dispose();
    } finally {
      server.close(() => process.exit(0));
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

start();
