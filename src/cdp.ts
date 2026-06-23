import fs from "node:fs/promises";
import path from "node:path";
import { attachCapture, cdpCookieToHar } from "./capture.js";
import type { CaptureStore, CdpLike, HarCookie } from "./capture.js";
import { logError } from "./log.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal CDP client over a raw WebSocket. Unlike Playwright's per-page
 * CDPSession, this speaks the *flatten* protocol directly: events carry a
 * `sessionId` and commands can target a child session by id. That is what lets
 * us auto-attach to — and capture network from — every target in the browser,
 * including service workers and out-of-process iframes.
 */
export class RawCdp {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private handlers = new Map<string, Set<(params: any, sessionId?: string) => void>>();
  private closed = false;
  private manualClose = false;

  async connect(wsUrl: string): Promise<void> {
    this.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`CDP websocket non raggiungibile: ${wsUrl}`));
    });
    this.ws.onmessage = (ev: MessageEvent) => this.dispatch(String(ev.data));
    this.ws.onclose = () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error("Connessione CDP chiusa"));
      this.pending.clear();
    };
  }

  private dispatch(data: string): void {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      const set = this.handlers.get(`${msg.sessionId ?? ""}:${msg.method}`);
      if (set) {
        for (const h of set) {
          try {
            h(msg.params, msg.sessionId);
          } catch (err) {
            logError("cdp handler", err);
          }
        }
      }
    }
  }

  send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    if (this.closed) return Promise.reject(new Error("CDP chiuso"));
    const id = this.nextId++;
    const payload: any = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(method: string, handler: (params: any, sessionId?: string) => void, sessionId?: string): void {
    const key = `${sessionId ?? ""}:${method}`;
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(handler);
  }

  /** A CdpLike facade bound to a child session (used by attachCapture). */
  sessionFacade(sessionId: string): CdpLike {
    return {
      on: (method, handler) => this.on(method, handler as any, sessionId),
      send: (method, params) => this.send(method, params, sessionId),
    };
  }

  close(): void {
    this.manualClose = true;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// Targets that carry network traffic we want in the HAR.
const NETWORK_TARGET_TYPES = new Set(["page", "iframe", "service_worker", "worker", "shared_worker"]);
const NETWORK_ENABLE = { maxTotalBufferSize: 200_000_000, maxResourceBufferSize: 100_000_000 };
const PAGE_TYPES = new Set(["page"]);

/**
 * Drives browser-wide capture: auto-attaches to every target (flatten), enables
 * Network on each, wires it into the CaptureStore, and recurses so nested
 * iframes/workers are caught too. De-dupes by targetId so a target reachable via
 * two sessions isn't counted twice.
 */
export class CdpCaptureCoordinator {
  private attachedTargets = new Set<string>();
  private processedSessions = new Set<string>();
  private firstPageSession?: string;
  private firstPageResolve?: () => void;
  private firstPagePromise: Promise<void>;

  constructor(private cdp: RawCdp, private store: CaptureStore) {
    this.firstPagePromise = new Promise((res) => (this.firstPageResolve = res));
  }

  async start(): Promise<void> {
    // Browser-level: catches top-level targets (pages, browser-scoped workers).
    // Per-session listeners for child targets are added in onAttached.
    this.cdp.on("Target.attachedToTarget", (p) => void this.onAttached(p));
    this.cdp.on("Target.targetInfoChanged", (p) => this.onInfoChanged(p));
    await this.cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  }

  /** Resolve once a real page target is live (so we don't navigate too early). */
  async waitForFirstPage(timeoutMs = 3000): Promise<void> {
    await Promise.race([this.firstPagePromise, sleep(timeoutMs)]);
  }

  private async onAttached(params: any, _parentSession?: string): Promise<void> {
    const sessionId: string = params.sessionId;
    const info = params.targetInfo ?? {};
    const type: string = info.type;
    const targetId: string = info.targetId;
    try {
      if (NETWORK_TARGET_TYPES.has(type) && !this.processedSessions.has(sessionId)) {
        this.processedSessions.add(sessionId);
        // pageId = targetId so the SAME target reached via two sessions (a service
        // worker attaches both browser-level AND as a page child) writes into the
        // same entries — duplicate events merge instead of double-listing.
        const pageId = targetId;
        if (!this.attachedTargets.has(targetId)) {
          this.attachedTargets.add(targetId);
          this.store.pages.push({ id: pageId, type, url: info.url ?? "", title: info.title, startedWallTime: Date.now() / 1000 });
          if (PAGE_TYPES.has(type) && !this.firstPageSession) {
            this.firstPageSession = sessionId;
            this.firstPageResolve?.();
          }
        }
        attachCapture(this.cdp.sessionFacade(sessionId), this.store, pageId);
        // CRITICAL: a child target's attachedToTarget arrives on its PARENT session,
        // not browser-level. So we must listen for attach/info events on THIS
        // session too — otherwise a service worker that attaches as a page child is
        // never released (it waits for ALL its debugger sessions) and never runs.
        this.cdp.on("Target.attachedToTarget", (p) => void this.onAttached(p), sessionId);
        this.cdp.on("Target.targetInfoChanged", (p) => this.onInfoChanged(p), sessionId);
        // FIRE-AND-FORGET, order matters. A freshly created target is paused at
        // start and Chrome won't ACK Network.enable until we release it — awaiting
        // it before runIfWaitingForDebugger would deadlock. Same-session commands
        // run FIFO, so enable → setAutoAttach still take effect before the run below.
        this.cdp.send("Network.enable", NETWORK_ENABLE, sessionId).catch(() => {});
        this.cdp
          .send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)
          .catch(() => {});
      }
    } catch (err) {
      logError("onAttached", err);
    } finally {
      // ALWAYS release (fire-and-forget), or a paused target hangs forever.
      this.cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
    }
  }

  private onInfoChanged(params: any): void {
    const info = params.targetInfo ?? {};
    const p = this.store.pages.find((pp) => pp.id === info.targetId);
    if (p) {
      if (info.title) p.title = info.title;
      if (info.url) p.url = info.url;
    }
  }

  async cookieJar(): Promise<HarCookie[]> {
    // Network.getAllCookies (on a page session) returns the whole jar incl http-only.
    if (this.firstPageSession) {
      try {
        const res = await this.cdp.send("Network.getAllCookies", {}, this.firstPageSession);
        if (res?.cookies) return (res.cookies as unknown[]).map((c) => cdpCookieToHar(c));
      } catch (err) {
        logError("getAllCookies", err);
      }
    }
    // Fallback: browser-level Storage.getCookies.
    try {
      const res = await this.cdp.send("Storage.getCookies", {});
      if (res?.cookies) return (res.cookies as unknown[]).map((c) => cdpCookieToHar(c));
    } catch (err) {
      logError("Storage.getCookies", err);
    }
    return [];
  }

  async browserInfo(): Promise<{ name: string; version: string }> {
    try {
      const v = await this.cdp.send("Browser.getVersion", {});
      const product = (v.product as string) ?? "Chrome";
      const i = product.indexOf("/");
      return i >= 0 ? { name: product.slice(0, i), version: product.slice(i + 1) } : { name: product, version: "" };
    } catch {
      return { name: "Chrome", version: "" };
    }
  }
}

/** Read the CDP ws endpoint Chrome wrote to <userDataDir>/DevToolsActivePort. */
export async function readDevtoolsWs(userDataDir: string, retries = 30): Promise<string> {
  for (let i = 0; i < retries; i++) {
    try {
      const content = await fs.readFile(path.join(userDataDir, "DevToolsActivePort"), "utf8");
      const [portLine, pathLine] = content.split("\n");
      const port = portLine.trim();
      if (port) return `ws://127.0.0.1:${port}${(pathLine ?? "").trim()}`;
    } catch {
      /* not written yet */
    }
    await sleep(100);
  }
  throw new Error("DevToolsActivePort non trovato: impossibile aprire l'endpoint CDP raw.");
}

/** Resolve the browser-level ws endpoint from an existing debugging port. */
export async function browserWsFromPort(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  const json = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!json.webSocketDebuggerUrl) throw new Error(`Nessun webSocketDebuggerUrl su 127.0.0.1:${port}/json/version`);
  return json.webSocketDebuggerUrl;
}
