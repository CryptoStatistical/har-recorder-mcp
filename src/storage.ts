import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import archiver from "archiver";
import { indexPath, recordingRoot } from "./config.js";
import type { Har, HarEntry } from "./har.js";
import type { HarCookie } from "./capture.js";

const gzipAsync = promisify(gzip);

/**
 * Max bytes per transfer chunk. Many upload channels (chat attachments, etc.)
 * cap a single file at 20 MB, and a full HAR can be far larger, so the bundle is
 * split into parts that each stay under that cap. 19 MiB (~19.9 MB) leaves margin
 * whether the channel reads "20 MB" as decimal (20,000,000) or binary (20 MiB).
 */
export const SPLIT_PART_BYTES = 19 * 1024 * 1024;

export type RecordingStatus = "recording" | "stopped" | "error";

export interface IndexEntry {
  id: string;
  dir: string; // directory name under .recording/
  label?: string;
  url: string;
  host?: string;
  title?: string;
  status: RecordingStatus;
  startedAt: string;
  stoppedAt?: string;
  requestCount: number;
  cookieCount?: number;
  webSocketCount?: number;
  webSocketFrameCount?: number;
  notes?: string[];
}

export interface Checkpoint {
  at: string; // ISO
  label: string;
}

export interface RecordingMetadata {
  id: string;
  label?: string;
  url: string;
  host?: string;
  title?: string;
  profile: "persistent" | "fresh";
  captureBodies: boolean;
  startedAt: string;
  stoppedAt?: string;
  durationMs?: number;
  requestCount: number;
  webSocketCount?: number;
  webSocketFrameCount?: number;
  cookieCount: number;
  httpOnlyCookieCount: number;
  hosts: string[];
  titles: string[];
  checkpoints: Checkpoint[];
  notes: string[];
  browser?: { name: string; version: string };
  files: Record<string, string>;
  /** Byte size of the .zip bundle. */
  zipBytes?: number;
  /** Split-part basenames when the bundle exceeded the 20 MB transfer cap. */
  zipParts?: string[];
}

export async function ensureRecordingRoot(): Promise<void> {
  await fs.mkdir(recordingRoot(), { recursive: true });
}

export function recordingDirPath(dir: string): string {
  return path.join(recordingRoot(), dir);
}

export async function readIndex(): Promise<IndexEntry[]> {
  try {
    const raw = await fs.readFile(indexPath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function writeIndex(entries: IndexEntry[]): Promise<void> {
  await ensureRecordingRoot();
  await fs.writeFile(indexPath(), JSON.stringify(entries, null, 2));
}

export async function upsertIndex(entry: IndexEntry): Promise<void> {
  const entries = await readIndex();
  const i = entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) entries[i] = entry;
  else entries.push(entry);
  await writeIndex(entries);
}

export async function findIndexEntry(id: string): Promise<IndexEntry | undefined> {
  const entries = await readIndex();
  return entries.find((e) => e.id === id || e.dir === id);
}

/**
 * Delete a recording's directory (HAR, cookies, summary, zip parts, everything)
 * and drop it from the index. `dir` is the directory name under `.recording/`.
 * Guarded so it can only remove a path INSIDE the recording root.
 */
export async function deleteRecording(dir: string): Promise<void> {
  const root = recordingRoot();
  const target = recordingDirPath(dir);
  const rel = path.relative(root, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to delete a path outside .recording/: ${dir}`);
  }
  await fs.rm(target, { recursive: true, force: true });
  const entries = await readIndex();
  const next = entries.filter((e) => e.dir !== dir);
  if (next.length !== entries.length) await writeIndex(next);
}

async function createZip(zipPath: string, files: Array<{ name: string; path: string }>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    for (const f of files) archive.file(f.path, { name: f.name });
    void archive.finalize();
  });
}

/**
 * Split `filePath` into `<filePath>.001`, `<filePath>.002`, … each ≤ partBytes,
 * streaming so a huge bundle is never held in memory. Returns the part basenames
 * (empty when the file already fits in a single part). Reconstruct with:
 *   cat <file>.* > <file>   (Windows: copy /b <file>.001+<file>.002 <file>)
 */
export async function splitIntoParts(filePath: string, partBytes: number): Promise<string[]> {
  const { size } = await fs.stat(filePath);
  if (size <= partBytes) return [];
  const total = Math.ceil(size / partBytes);
  const parts: string[] = [];
  for (let i = 0; i < total; i++) {
    const start = i * partBytes;
    const end = Math.min(start + partBytes, size) - 1; // inclusive byte range
    const partPath = `${filePath}.${String(i + 1).padStart(3, "0")}`;
    await pipeline(createReadStream(filePath, { start, end }), createWriteStream(partPath));
    parts.push(path.basename(partPath));
  }
  return parts;
}

export interface WriteArtifactsInput {
  dirName: string;
  har: Har;
  cookies: HarCookie[];
  metadata: RecordingMetadata;
  summary: string;
}

export interface WrittenArtifacts {
  dir: string;
  harPath: string;
  harGzPath: string;
  cookiesPath: string;
  metadataPath: string;
  summaryPath: string;
  zipPath: string;
  /** Byte size of the assembled .zip bundle. */
  zipBytes: number;
  /** Split-part basenames (`<dir>.zip.001`, …) when the .zip exceeds the 20 MB
   *  transfer cap; empty when the single .zip fits and no split was needed. */
  zipParts: string[];
}

export async function writeArtifacts(input: WriteArtifactsInput): Promise<WrittenArtifacts> {
  const dir = recordingDirPath(input.dirName);
  await fs.mkdir(dir, { recursive: true });

  const harPath = path.join(dir, "session.har");
  const harGzPath = path.join(dir, "session.har.gz");
  const cookiesPath = path.join(dir, "cookies.json");
  const metadataPath = path.join(dir, "metadata.json");
  const summaryPath = path.join(dir, "summary.md");
  const zipPath = path.join(dir, `${input.dirName}.zip`);

  const harJson = JSON.stringify(input.har);
  await fs.writeFile(harPath, harJson);
  await fs.writeFile(harGzPath, await gzipAsync(Buffer.from(harJson)));
  await fs.writeFile(cookiesPath, JSON.stringify(input.cookies, null, 2));
  await fs.writeFile(metadataPath, JSON.stringify(input.metadata, null, 2));
  await fs.writeFile(summaryPath, input.summary);

  await createZip(zipPath, [
    { name: "session.har", path: harPath },
    { name: "cookies.json", path: cookiesPath },
    { name: "metadata.json", path: metadataPath },
    { name: "summary.md", path: summaryPath },
  ]);

  // The single .zip is kept for local use; oversized bundles are ALSO emitted as
  // ≤20 MB parts so they can be transferred through size-capped channels.
  const zipBytes = (await fs.stat(zipPath)).size;
  const zipParts = await splitIntoParts(zipPath, SPLIT_PART_BYTES);

  return { dir, harPath, harGzPath, cookiesPath, metadataPath, summaryPath, zipPath, zipBytes, zipParts };
}

export async function readHar(dir: string): Promise<Har> {
  const raw = await fs.readFile(path.join(recordingDirPath(dir), "session.har"), "utf8");
  return JSON.parse(raw) as Har;
}

export async function readCookies(dir: string): Promise<HarCookie[]> {
  try {
    const raw = await fs.readFile(path.join(recordingDirPath(dir), "cookies.json"), "utf8");
    return JSON.parse(raw) as HarCookie[];
  } catch {
    return [];
  }
}

export async function readMetadata(dir: string): Promise<RecordingMetadata | undefined> {
  try {
    const raw = await fs.readFile(path.join(recordingDirPath(dir), "metadata.json"), "utf8");
    return JSON.parse(raw) as RecordingMetadata;
  } catch {
    return undefined;
  }
}

export async function writeMetadata(dir: string, metadata: RecordingMetadata): Promise<void> {
  await fs.writeFile(path.join(recordingDirPath(dir), "metadata.json"), JSON.stringify(metadata, null, 2));
}

export async function writeSummary(dir: string, summary: string): Promise<void> {
  await fs.writeFile(path.join(recordingDirPath(dir), "summary.md"), summary);
}

// ---------------------------------------------------------------------------
// summary.md — a human "how to reconstruct this session" guide.
// ---------------------------------------------------------------------------

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const AUTH_RE = /(login|logout|auth|oauth|token|session|signin|sign-in|sso|account|password|otp|2fa|mfa)/i;

export function buildSummaryMarkdown(har: Har, meta: RecordingMetadata, cookies: HarCookie[]): string {
  const entries = har.log.entries;
  const hostCounts = new Map<string, number>();
  for (const e of entries) {
    const h = hostOf(e.request.url);
    if (h) hostCounts.set(h, (hostCounts.get(h) ?? 0) + 1);
  }
  const topHosts = [...hostCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

  const notable = entries.filter(
    (e: HarEntry) =>
      e.request.method !== "GET" ||
      AUTH_RE.test(e.request.url) ||
      (e.response.status >= 300 && e.response.status < 400) ||
      e.response.status >= 400,
  );

  const httpOnly = cookies.filter((c) => c.httpOnly);
  const cookieDomains = new Map<string, number>();
  for (const c of cookies) {
    const d = c.domain ?? "";
    cookieDomains.set(d, (cookieDomains.get(d) ?? 0) + 1);
  }

  const webSockets = entries.filter((e: HarEntry) => e._webSocketMessages);
  const wsFrameTotal = webSockets.reduce((n, e) => n + (e._webSocketMessages?.length ?? 0), 0);

  const lines: string[] = [];
  lines.push(`# Recording — ${meta.title ?? meta.host ?? meta.url}`);
  lines.push("");
  lines.push(`> WARNING: this package contains **live session cookies and tokens**. Do not share it.`);
  lines.push("");
  lines.push("## Session");
  lines.push("");
  lines.push(`- **ID**: \`${meta.id}\``);
  if (meta.label) lines.push(`- **Label**: ${meta.label}`);
  lines.push(`- **Initial URL**: ${meta.url}`);
  if (meta.host) lines.push(`- **Primary host**: ${meta.host}`);
  lines.push(`- **Started**: ${meta.startedAt}`);
  if (meta.stoppedAt) lines.push(`- **Stopped**: ${meta.stoppedAt}`);
  if (meta.durationMs != null) lines.push(`- **Duration**: ${(meta.durationMs / 1000).toFixed(1)} s`);
  lines.push(`- **Requests captured**: ${meta.requestCount}`);
  lines.push(`- **Profile**: ${meta.profile} · **bodies captured**: ${meta.captureBodies ? "yes" : "no"}`);
  if (meta.browser) lines.push(`- **Browser**: ${meta.browser.name} ${meta.browser.version}`);
  lines.push("");

  if (meta.checkpoints.length) {
    lines.push("## Checkpoints");
    lines.push("");
    for (const c of meta.checkpoints) lines.push(`- \`${c.at}\` — ${c.label}`);
    lines.push("");
  }

  lines.push("## Hosts contacted");
  lines.push("");
  for (const [h, n] of topHosts) lines.push(`- \`${h}\` — ${n} requests`);
  lines.push("");

  lines.push("## Notable requests (auth / POST / redirect / errors)");
  lines.push("");
  if (notable.length === 0) {
    lines.push("_No non-GET or authentication requests found._");
  } else {
    lines.push("| # | method | status | URL |");
    lines.push("|---|--------|--------|-----|");
    for (const e of notable.slice(0, 60)) {
      const idx = entries.indexOf(e);
      const url = e.request.url.length > 120 ? e.request.url.slice(0, 117) + "…" : e.request.url;
      lines.push(`| ${idx} | ${e.request.method} | ${e.response.status} | ${url.replace(/\|/g, "%7C")} |`);
    }
  }
  lines.push("");

  if (webSockets.length) {
    lines.push("## WebSocket");
    lines.push("");
    lines.push(`- **Connections**: ${webSockets.length} · **frames captured**: ${wsFrameTotal}`);
    for (const e of webSockets.slice(0, 20)) {
      const idx = entries.indexOf(e);
      lines.push(`- #${idx} \`${e.request.url}\` — ${e._webSocketMessages?.length ?? 0} frames`);
    }
    lines.push("");
    lines.push("Frames are stored on each entry under `_webSocketMessages` (Chrome DevTools convention).");
    lines.push("");
  }

  lines.push("## Cookies");
  lines.push("");
  lines.push(`- **Total**: ${cookies.length} (of which **http-only**: ${httpOnly.length})`);
  for (const [d, n] of [...cookieDomains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    lines.push(`- \`${d || "(no domain)"}\` — ${n}`);
  }
  lines.push("");
  lines.push("The full jar (http-only included) is in `cookies.json`. The same cookies also appear");
  lines.push("in the `Cookie`/`Set-Cookie` headers of the HAR entries.");
  lines.push("");

  lines.push("## Reconstruction");
  lines.push("");
  lines.push("1. Open `session.har` in a client (Insomnia, Postman, browser devtools, a script).");
  lines.push("2. To replay the authenticated session, inject the cookies from `cookies.json`");
  lines.push("   (http-only ones are included — usually lost by other exporters).");
  lines.push("3. The authentication requests are listed above: replay them in the order shown.");
  lines.push("4. `metadata.json` carries checkpoints, hosts and notes useful for the replay.");
  lines.push("");

  lines.push("## Transfer (large file)");
  lines.push("");
  lines.push("The full HAR can be very large. The package is the `*.zip` in this folder; if it");
  lines.push("exceeds **20 MB** (the cap of many upload channels) it is split into numbered parts");
  lines.push("`*.zip.001`, `*.zip.002`, … (each ≤ 20 MB).");
  lines.push("");
  lines.push("To transfer it: send **all** the parts, then **rejoin them BEFORE opening the HAR**:");
  lines.push("");
  lines.push("```bash");
  lines.push("cat *.zip.*  > bundle.zip      # rejoin in numeric order");
  lines.push("unzip bundle.zip              # extracts session.har and the other files");
  lines.push("```");
  lines.push("");
  lines.push("Windows (PowerShell): `cmd /c copy /b part1+part2+... bundle.zip`.");
  lines.push("Keep the parts in numeric order; do not open a single part on its own.");
  lines.push("");

  if (meta.notes.length) {
    lines.push("## Notes");
    lines.push("");
    for (const n of meta.notes) lines.push(`- ${n}`);
    lines.push("");
  }

  return lines.join("\n");
}
