import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import type { Browser, BrowserContext } from "playwright";
import { persistentProfileDir, recordingRoot } from "./config.js";
import { CaptureStore } from "./capture.js";
import type { HarCookie } from "./capture.js";
import { browserWsFromPort, CdpCaptureCoordinator, RawCdp, readDevtoolsWs } from "./cdp.js";
import { buildHar, selectEntry, summarizeRequests } from "./har.js";
import type { Har, HarEntry, RequestFilter, RequestSummary } from "./har.js";
import { log, logError } from "./log.js";
import { deriveRecordingName, hostSlug, timestamp } from "./naming.js";
import {
  buildSummaryMarkdown,
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
          `Una registrazione è già attiva (${this.session.id}). Ferma con stop_recording o close_browser prima di iniziarne un'altra.`,
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
          ? "Connesso al browser esistente. Naviga liberamente: catturo tutto (pagine, iframe, worker, service worker). stop_recording per assemblare l'HAR."
          : "Chrome è aperto. Naviga e completa il login manualmente. Catturo tutto (incl. service worker). mark_checkpoint per i passaggi, stop_recording per l'HAR.",
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
        log(`launch con channel=${ch ?? "chromium"} fallito, provo il prossimo…`);
      }
    }
    throw new Error(
      `Impossibile avviare Chrome/Chromium. Installa Google Chrome oppure esegui 'npm run install:browser'. Dettaglio: ${
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
      notes: session.notes.length ? session.notes : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // status / checkpoint
  // -------------------------------------------------------------------------

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
    return { status: "idle", message: "Nessuna registrazione attiva." };
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
    if (!s || s.status !== "recording") throw new Error("Nessuna registrazione attiva.");
    if (id && id !== s.id) throw new Error(`recordingId ${id} non corrisponde alla sessione attiva ${s.id}.`);
    return s;
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  async stop(id?: string): Promise<unknown> {
    const s = this.requireRecording(id);
    s.status = "stopped";
    s.stoppedAt = new Date();

    const cookies = await s.coordinator.cookieJar();
    const har = buildHar(s.store, { browser: s.browserInfo });

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
    await writeMetadata(dirName, metadata);

    await upsertIndex({
      ...this.indexEntryFor(s, har.log.entries.length, dirName),
      title: lastTitle,
      cookieCount: cookies.length,
    });

    log(`stopped [${s.id}] → ${dirName} (${har.log.entries.length} req, ${cookies.length} cookies)`);

    return {
      recordingId: s.id,
      name: dirName,
      status: "stopped",
      requestCount: har.log.entries.length,
      cookieCount: cookies.length,
      httpOnlyCookieCount: httpOnlyCount,
      targetsCaptured: s.store.pages.length,
      durationMs,
      hosts: hosts.slice(0, 10),
      directory: artifacts.dir,
      files: metadata.files,
      message:
        "HAR assemblato (tutti i target: pagine, iframe, worker, service worker). Il browser resta aperto: ispeziona con list_requests/get_request/get_cookies o chiudi con close_browser.",
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
    if (!idx) throw new Error(`Registrazione non trovata: ${id}`);
    if (idx.status !== "stopped") throw new Error(`La registrazione ${id} non è ancora stata fermata.`);
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
        })),
    };
  }

  async listRequests(
    id: string,
    filter: RequestFilter,
  ): Promise<{ total: number; matched: number; requests: RequestSummary[]; live: boolean }> {
    const { har, live } = await this.resolveHar(id);
    return { ...summarizeRequests(har, filter), live };
  }

  async getRequest(id: string, selector: { index?: number; requestId?: string; urlContains?: string }): Promise<HarEntry> {
    const { har } = await this.resolveHar(id);
    const entry = selectEntry(har, selector);
    if (!entry) throw new Error("Richiesta non trovata con il selettore fornito.");
    return entry;
  }

  async getCookies(id: string, domain?: string): Promise<unknown> {
    let cookies: HarCookie[];
    if (this.session && this.session.id === id) {
      cookies = await this.session.coordinator.cookieJar();
    } else {
      const idx = await findIndexEntry(id);
      if (!idx) throw new Error(`Registrazione non trovata: ${id}`);
      cookies = await readCookies(idx.dir);
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
    if (!idx) throw new Error(`Registrazione non trovata: ${id}`);
    const meta = await readMetadata(idx.dir);
    if (!meta) throw new Error(`metadata.json mancante per ${id}.`);
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

  async dispose(): Promise<void> {
    if (this.session) await this.closeBrowser();
  }
}

export { hostSlug, recordingDirPath };
