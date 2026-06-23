import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import type { Browser, BrowserContext } from "playwright";
import { persistentProfileDir, recordingRoot } from "./config.js";
import { CaptureStore } from "./capture.js";
import type { HarCookie } from "./capture.js";
import { browserWsFromPort, CdpCaptureCoordinator, RawCdp, readDevtoolsWs } from "./cdp.js";
import { buildHar, cookiesFromHar, selectEntry, summarizeRequests, webSocketStats } from "./har.js";
import type { Har, HarEntry, RequestFilter, RequestSummaryResult } from "./har.js";
import { log, logError } from "./log.js";
import { deriveRecordingName, hostSlug, timestamp } from "./naming.js";
import {
  buildSummaryMarkdown,
  deleteRecording,
  ensureRecordingRoot,
  findIndexEntry,
  readCookies,
  readHar,
  readIndex,
  readMetadata,
  recordingDirPath,
  upsertIndex,
  writeArtifacts,
  writeMetadata,
  writeSummary,
} from "./storage.js";
import type { Checkpoint, IndexEntry, RecordingMetadata } from "./storage.js";

export type Profile = "persistent" | "fresh";

export interface StartOptions {
  url?: string;
  label?: string;
  profile?: Profile;
  captureBodies?: boolean;
  channel?: string;
  /** Attach to an already-running Chrome on this --remote-debugging-port instead of launching one. */
  attachToPort?: number;
}

interface LiveSession {
  id: string;
  mode: "launch" | "attach";
  label?: string;
  url: string;
  profile: Profile;
  captureBodies: boolean;
  startedAt: Date;
  stoppedAt?: Date;
  checkpoints: Checkpoint[];
  notes: string[];
  store: CaptureStore;
  context: BrowserContext;
  browser?: Browser; // present in attach mode (connectOverCDP)
  cdp: RawCdp;
  coordinator: CdpCaptureCoordinator;
  status: "recording" | "stopped";
  freshProfileDir?: string;
  browserInfo?: { name: string; version: string };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export class RecordingManager {
  private session?: LiveSession;

  async start(opts: StartOptions): Promise<{
    recordingId: string;
    status: string;
    mode: string;
    url?: string;
    profile: Profile;
    captureBodies: boolean;
    message: string;
  }> {
    await ensureRecordingRoot();

    if (this.session) {
      if (this.session.status === "recording") {
        throw new Error(
          `A recording is already active (${this.session.id}). Stop it with stop_recording or close_browser before starting another.`,
        );
      }
      await this.closeBrowser();
    }

    const startedAt = new Date();
    const id = `${timestamp(startedAt)}-${randomBytes(2).toString("hex")}`;
    const profile: Profile = opts.profile ?? "persistent";
    const captureBodies = opts.captureBodies ?? true;
    const store = new CaptureStore(captureBodies);

    let context: BrowserContext;
    let browser: Browser | undefined;
    let cdp: RawCdp;
    let freshProfileDir: string | undefined;
    const mode: "launch" | "attach" = opts.attachToPort ? "attach" : "launch";

    if (mode === "attach") {
      const port = opts.attachToPort!;
      const wsUrl = await browserWsFromPort(port);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      context = browser.contexts()[0] ?? (await browser.newContext());
      cdp = new RawCdp();
      await cdp.connect(wsUrl);
    } else {
      let userDataDir: string;
      if (profile === "fresh") {
        freshProfileDir = path.join(recordingRoot(), `.tmp-profile-${id}`);
        userDataDir = freshProfileDir;
      } else {
        userDataDir = persistentProfileDir();
      }
      await fs.mkdir(userDataDir, { recursive: true });
      context = await this.launchContext(userDataDir, opts.channel);
      const wsUrl = await readDevtoolsWs(userDataDir);
      cdp = new RawCdp();
      await cdp.connect(wsUrl);
    }

    const coordinator = new CdpCaptureCoordinator(cdp, store);
    await coordinator.start();

    const session: LiveSession = {
      id,
      mode,
      label: opts.label,
      url: opts.url ?? "",
      profile,
      captureBodies,
      startedAt,
      checkpoints: [],
      notes: [],
      store,
      context,
      browser,
      cdp,
      coordinator,
      status: "recording",
      freshProfileDir,
    };
    this.session = session;

    try {
      session.browserInfo = await coordinator.browserInfo();
    } catch {
      /* non-fatal */
    }

    // Make sure a page target is attached & Network-enabled before we navigate,
    // so the very first (login/redirect) request isn't missed.
    await coordinator.waitForFirstPage(3000);

    if (opts.url) {
      const page = context.pages()[0] ?? (await context.newPage());
      page
        .goto(opts.url, { waitUntil: "commit", timeout: 60_000 })
        .catch((err) => log("goto warning:", err instanceof Error ? err.message : String(err)));
    }

    await upsertIndex(this.indexEntryFor(session, store.requestCount));

    return {
      recordingId: id,
      status: "recording",
      mode,
      url: opts.url,
      profile,
      captureBodies,
      message:
        mode === "attach"
          ? "Connected to the existing browser. Browse freely: everything is captured (pages, iframes, workers, service workers). Call stop_recording to assemble the HAR."
          : "Chrome is open. Navigate and complete the login manually. Everything is captured (incl. service workers). Use mark_checkpoint for steps, stop_recording for the HAR.",
    };
  }

  private async launchContext(userDataDir: string, channel?: string): Promise<BrowserContext> {
    const baseOpts = {
      // Headful by default (the whole point is a real, user-driven session).
      // HAR_RECORDER_HEADLESS=1 forces headless — handy for CI / pipeline tests.
      headless: process.env.HAR_RECORDER_HEADLESS === "1",
      viewport: null,
      acceptDownloads: true,
      // --remote-debugging-port=0 exposes the CDP endpoint our RawCdp connects to.
      args: ["--disable-blink-features=AutomationControlled", "--remote-debugging-port=0"],
    };
    const channels = channel ? [channel] : ["chrome", undefined];
    let lastErr: unknown;
    for (const ch of channels) {
      try {
        return await chromium.launchPersistentContext(userDataDir, { ...baseOpts, channel: ch as string | undefined });
      } catch (err) {
        lastErr = err;
        log(`launch with channel=${ch ?? "chromium"} failed, trying the next…`);
      }
    }
    throw new Error(
      `Could not launch Chrome/Chromium. Install Google Chrome or run 'npm run install:browser'. Detail: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }

  private indexEntryFor(session: LiveSession, requestCount: number, dir?: string): IndexEntry {
    return {
      id: session.id,
      dir: dir ?? session.id,
      label: session.label,
      url: session.url,
      host: hostOf(session.url),
      status: session.status,
      startedAt: session.startedAt.toISOString(),
      stoppedAt: session.stoppedAt?.toISOString(),
      requestCount,
      webSocketCount: session.store.webSocketCount || undefined,
      webSocketFrameCount: session.store.webSocketFrameCount || undefined,
      notes: session.notes.length ? session.notes : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // status / checkpoint
  // -------------------------------------------------------------------------

  /** Id of the live, still-recording session (if any) — used by control surfaces. */
  activeRecordingId(): string | undefined {
    return this.session?.status === "recording" ? this.session.id : undefined;
  }

  /** True when this manager holds the given recording as its live in-memory session. */
  isLive(id: string): boolean {
    return !!this.session && this.session.id === id;
  }

  async status(id?: string): Promise<unknown> {
    const s = this.session;
    if (s && (!id || id === s.id)) {
      return {
        recordingId: s.id,
        status: s.status,
        mode: s.mode,
        label: s.label,
        url: s.url,
        profile: s.profile,
        captureBodies: s.captureBodies,
        startedAt: s.startedAt.toISOString(),
        durationMs: Date.now() - s.startedAt.getTime(),
        requestCount: s.store.requestCount,
        webSocketCount: s.store.webSocketCount,
        webSocketFrameCount: s.store.webSocketFrameCount,
        inflight: s.store.inflight.size,
        lastRequestUrl: s.store.lastRequestUrl(),
        targets: s.store.pages.map((p) => ({ id: p.id, type: p.type, title: p.title, url: p.url })),
        checkpoints: s.checkpoints,
        notes: s.notes,
        browserOpen: true,
      };
    }
    if (id) {
      const idx = await findIndexEntry(id);
      if (idx) {
        const meta = await readMetadata(idx.dir);
        return { ...idx, browserOpen: false, metadata: meta };
      }
    }
    return { status: "idle", message: "No active recording." };
  }

  markCheckpoint(id: string | undefined, label: string): Checkpoint {
    const s = this.requireRecording(id);
    const cp: Checkpoint = { at: nowIso(), label };
    s.checkpoints.push(cp);
    log(`checkpoint [${s.id}]: ${label}`);
    return cp;
  }

  private requireRecording(id?: string): LiveSession {
    const s = this.session;
    if (!s || s.status !== "recording") throw new Error("No active recording.");
    if (id && id !== s.id) throw new Error(`recordingId ${id} does not match the active session ${s.id}.`);
    return s;
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  async stop(id?: string): Promise<unknown> {
    const s = this.requireRecording(id);
    s.status = "stopped";
    s.stoppedAt = new Date();

    const har = buildHar(s.store, { browser: s.browserInfo });
    // Prefer the live CDP jar; if it comes back empty (e.g. headful Chrome's
    // deprecated getAllCookies), reconstruct it from the captured traffic.
    let cookies = await s.coordinator.cookieJar();
    if (!cookies.length) cookies = cookiesFromHar(har);

    const hosts = this.collectHosts(har);
    // Titles for naming: Playwright gives the live document titles reliably
    // (targetInfoChanged can lag JS-driven title changes). Fall back to captured.
    const titles: string[] = [];
    for (const page of s.context.pages()) {
      try {
        const t = await page.title();
        if (t && t !== "about:blank") titles.push(t);
      } catch {
        /* page closed */
      }
    }
    if (titles.length === 0) {
      titles.push(...s.store.pages.filter((p) => p.type === "page").map((p) => p.title).filter((t): t is string => !!t));
    }
    const dirName = deriveRecordingName({
      startedAt: s.startedAt,
      primaryHost: hostOf(s.url) || hosts[0],
      label: s.label,
      checkpoints: s.checkpoints.map((c) => c.label),
      titles,
    });

    const httpOnlyCount = cookies.filter((c) => c.httpOnly).length;
    const durationMs = s.stoppedAt.getTime() - s.startedAt.getTime();
    const lastTitle = titles[titles.length - 1];
    const wsStats = webSocketStats(har);

    const metadata: RecordingMetadata = {
      id: s.id,
      label: s.label,
      url: s.url,
      host: hostOf(s.url),
      title: lastTitle,
      profile: s.profile,
      captureBodies: s.captureBodies,
      startedAt: s.startedAt.toISOString(),
      stoppedAt: s.stoppedAt.toISOString(),
      durationMs,
      requestCount: har.log.entries.length,
      webSocketCount: wsStats.webSocketCount,
      webSocketFrameCount: wsStats.webSocketFrameCount,
      cookieCount: cookies.length,
      httpOnlyCookieCount: httpOnlyCount,
      hosts,
      titles,
      checkpoints: s.checkpoints,
      notes: s.notes,
      browser: s.browserInfo,
      files: {},
    };

    const summary = buildSummaryMarkdown(har, metadata, cookies);
    const artifacts = await writeArtifacts({ dirName, har, cookies, metadata, summary });

    metadata.files = {
      har: path.basename(artifacts.harPath),
      harGz: path.basename(artifacts.harGzPath),
      cookies: path.basename(artifacts.cookiesPath),
      metadata: path.basename(artifacts.metadataPath),
      summary: path.basename(artifacts.summaryPath),
      zip: path.basename(artifacts.zipPath),
    };
    metadata.zipBytes = artifacts.zipBytes;
    if (artifacts.zipParts.length) metadata.zipParts = artifacts.zipParts;
    await writeMetadata(dirName, metadata);

    await upsertIndex({
      ...this.indexEntryFor(s, har.log.entries.length, dirName),
      title: lastTitle,
      cookieCount: cookies.length,
      webSocketCount: wsStats.webSocketCount || undefined,
      webSocketFrameCount: wsStats.webSocketFrameCount || undefined,
    });

    log(
      `stopped [${s.id}] → ${dirName} (${har.log.entries.length} req, ${cookies.length} cookies, ${wsStats.webSocketFrameCount} ws frames)`,
    );

    const split = artifacts.zipParts.length > 0;
    const zipMB = (artifacts.zipBytes / (1024 * 1024)).toFixed(1);
    const transfer = split
      ? {
          split: true as const,
          zipBytes: artifacts.zipBytes,
          partLimitMB: 20,
          parts: artifacts.zipParts,
          reconstruct: `cat ${dirName}.zip.* > ${dirName}.zip && unzip ${dirName}.zip`,
          note:
            `The ZIP (${zipMB} MB) exceeds 20 MB: it was split into ${artifacts.zipParts.length} parts ` +
            `of ≤20 MB (${dirName}.zip.001…${String(artifacts.zipParts.length).padStart(3, "0")}). ` +
            `To transfer it, send ALL the parts, then rejoin them with the 'reconstruct' command ` +
            `BEFORE opening session.har (the full HAR can be very large).`,
        }
      : {
          split: false as const,
          zipBytes: artifacts.zipBytes,
          partLimitMB: 20,
          note: `The ZIP (${zipMB} MB) is under 20 MB: send it whole (${dirName}.zip), no split needed.`,
        };

    return {
      recordingId: s.id,
      name: dirName,
      status: "stopped",
      requestCount: har.log.entries.length,
      webSocketCount: wsStats.webSocketCount,
      webSocketFrameCount: wsStats.webSocketFrameCount,
      cookieCount: cookies.length,
      httpOnlyCookieCount: httpOnlyCount,
      targetsCaptured: s.store.pages.length,
      durationMs,
      hosts: hosts.slice(0, 10),
      directory: artifacts.dir,
      files: metadata.files,
      transfer,
      message:
        "HAR assembled (all targets: pages, iframes, workers, service workers). The browser stays open: inspect with list_requests/get_request/get_cookies or close it with close_browser." +
        (split
          ? ` Bundle >20 MB: see 'transfer' — send the ${artifacts.zipParts.length} parts ${dirName}.zip.NNN and rejoin them before opening the HAR.`
          : ""),
    };
  }

  private collectHosts(har: Har): string[] {
    const counts = new Map<string, number>();
    for (const e of har.log.entries) {
      const h = hostOf(e.request.url);
      if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
  }

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  async closeBrowser(id?: string): Promise<{ closed: boolean; recordingId?: string }> {
    const s = this.session;
    if (!s || (id && id !== s.id)) return { closed: false };
    try {
      s.cdp.close();
    } catch {
      /* ignore */
    }
    try {
      // attach mode: disconnect (don't kill the user's browser); launch mode: close it.
      if (s.mode === "attach" && s.browser) await s.browser.close();
      else await s.context.close();
    } catch (err) {
      logError("close browser failed", err);
    }
    if (s.freshProfileDir) {
      await fs.rm(s.freshProfileDir, { recursive: true, force: true }).catch(() => {});
    }
    this.session = undefined;
    return { closed: true, recordingId: s.id };
  }

  // -------------------------------------------------------------------------
  // query tools (live snapshot OR on-disk recording)
  // -------------------------------------------------------------------------

  private async resolveHar(id: string): Promise<{ har: Har; live: boolean; dir?: string }> {
    if (this.session && this.session.id === id) {
      return { har: buildHar(this.session.store, { browser: this.session.browserInfo }), live: true };
    }
    const idx = await findIndexEntry(id);
    if (!idx) throw new Error(`Recording not found: ${id}`);
    if (idx.status !== "stopped") throw new Error(`Recording ${id} has not been stopped yet.`);
    return { har: await readHar(idx.dir), live: false, dir: idx.dir };
  }

  async listRecordings(): Promise<unknown> {
    const entries = await readIndex();
    return {
      activeRecordingId: this.session?.status === "recording" ? this.session.id : undefined,
      browserOpen: !!this.session,
      count: entries.length,
      recordings: entries
        .slice()
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
        .map((e) => ({
          recordingId: e.id,
          name: e.dir,
          status: e.status,
          url: e.url,
          host: e.host,
          title: e.title,
          startedAt: e.startedAt,
          stoppedAt: e.stoppedAt,
          requestCount: e.requestCount,
          cookieCount: e.cookieCount,
          webSocketCount: e.webSocketCount,
          webSocketFrameCount: e.webSocketFrameCount,
        })),
    };
  }

  async listRequests(
    id: string,
    filter: RequestFilter,
  ): Promise<RequestSummaryResult & { live: boolean }> {
    const { har, live } = await this.resolveHar(id);
    return { ...summarizeRequests(har, filter), live };
  }

  async getRequest(id: string, selector: { index?: number; requestId?: string; urlContains?: string }): Promise<HarEntry> {
    const { har } = await this.resolveHar(id);
    const entry = selectEntry(har, selector);
    if (!entry) throw new Error("Request not found for the given selector.");
    return entry;
  }

  async getCookies(id: string, domain?: string): Promise<unknown> {
    let cookies: HarCookie[];
    if (this.session && this.session.id === id) {
      cookies = await this.session.coordinator.cookieJar();
      if (!cookies.length) cookies = cookiesFromHar(buildHar(this.session.store, { browser: this.session.browserInfo }));
    } else {
      const idx = await findIndexEntry(id);
      if (!idx) throw new Error(`Recording not found: ${id}`);
      cookies = await readCookies(idx.dir);
      if (!cookies.length) {
        try {
          cookies = cookiesFromHar(await readHar(idx.dir));
        } catch {
          /* no HAR on disk — leave empty */
        }
      }
    }
    const filtered = domain ? cookies.filter((c) => (c.domain ?? "").toLowerCase().includes(domain.toLowerCase())) : cookies;
    return {
      total: filtered.length,
      httpOnly: filtered.filter((c) => c.httpOnly).length,
      secure: filtered.filter((c) => c.secure).length,
      cookies: filtered,
    };
  }

  async annotate(id: string, note: string): Promise<unknown> {
    if (this.session && this.session.id === id && this.session.status === "recording") {
      this.session.notes.push(note);
      return { recordingId: id, note, applied: "live", notes: this.session.notes };
    }
    const idx = await findIndexEntry(id);
    if (!idx) throw new Error(`Recording not found: ${id}`);
    const meta = await readMetadata(idx.dir);
    if (!meta) throw new Error(`metadata.json missing for ${id}.`);
    meta.notes = [...(meta.notes ?? []), note];
    await writeMetadata(idx.dir, meta);
    try {
      const har = await readHar(idx.dir);
      const cookies = await readCookies(idx.dir);
      await writeSummary(idx.dir, buildSummaryMarkdown(har, meta, cookies));
    } catch (err) {
      logError("summary regen failed", err);
    }
    await upsertIndex({ ...idx, notes: meta.notes });
    return { recordingId: id, note, applied: "disk", notes: meta.notes };
  }

  async renameRecording(id: string, name: string): Promise<{ recordingId: string; name: string; applied: "live" | "disk" }> {
    const clean = name.trim();
    if (!clean) throw new Error("Name is required.");
    if (clean.length > 120) throw new Error("Name is too long (max 120 characters).");

    if (this.session && this.session.id === id && this.session.status === "recording") {
      this.session.label = clean;
      await upsertIndex({ ...this.indexEntryFor(this.session, this.session.store.requestCount), label: clean, title: clean });
      return { recordingId: id, name: clean, applied: "live" };
    }

    const idx = await findIndexEntry(id);
    if (!idx) throw new Error(`Recording not found: ${id}`);
    const meta = await readMetadata(idx.dir);
    if (!meta) throw new Error(`metadata.json missing for ${id}.`);
    meta.label = clean;
    meta.title = clean;
    await writeMetadata(idx.dir, meta);
    try {
      const har = await readHar(idx.dir);
      const cookies = await readCookies(idx.dir);
      await writeSummary(idx.dir, buildSummaryMarkdown(har, meta, cookies));
    } catch (err) {
      logError("summary regen failed", err);
    }
    await upsertIndex({ ...idx, label: clean, title: clean });
    return { recordingId: idx.id, name: clean, applied: "disk" };
  }

  /**
   * Permanently delete a recording from disk (and the index). Refuses while it
   * is still recording; if it is the in-memory (stopped) session, the browser is
   * closed first so nothing dangles.
   */
  async deleteRecording(id: string): Promise<{ deleted: boolean; recordingId: string }> {
    if (this.activeRecordingId() === id) {
      throw new Error("The recording is still active: stop it and close the browser before deleting it.");
    }
    const idx = await findIndexEntry(id);
    if (!idx) throw new Error(`Recording not found: ${id}`);
    if (this.session && this.session.id === idx.id) await this.closeBrowser(idx.id);
    await deleteRecording(idx.dir);
    log(`deleted [${idx.id}] → ${idx.dir}`);
    return { deleted: true, recordingId: idx.id };
  }

  async dispose(): Promise<void> {
    if (this.session) await this.closeBrowser();
  }
}

export { hostSlug, recordingDirPath };
