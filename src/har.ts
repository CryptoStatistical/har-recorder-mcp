import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import type { CaptureStore, CapturedEntry, CdpResourceTiming, HarCookie, WsMessage } from "./capture.js";

export interface HarHeader {
  name: string;
  value: string;
}
export interface HarNameValue {
  name: string;
  value: string;
}
export interface HarTimings {
  blocked: number;
  dns: number;
  connect: number;
  ssl: number;
  send: number;
  wait: number;
  receive: number;
}
export interface HarEntry {
  pageref?: string;
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: HarCookie[];
    headers: HarHeader[];
    queryString: HarNameValue[];
    postData?: { mimeType: string; text: string };
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: HarCookie[];
    headers: HarHeader[];
    content: { size: number; mimeType: string; text?: string; encoding?: string; compression?: number };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: HarTimings;
  serverIPAddress?: string;
  connection?: string;
  _resourceType?: string;
  _requestId?: string;
  _fromDiskCache?: boolean;
  _fromServiceWorker?: boolean;
  _error?: string;
  _bodyTruncated?: boolean;
  // Chrome DevTools convention for WebSocket frames.
  _webSocketMessages?: WsMessage[];
  _webSocketMessagesTruncated?: boolean;
}
export interface Har {
  log: {
    version: "1.2";
    creator: { name: string; version: string };
    browser?: { name: string; version: string };
    pages: Array<{ startedDateTime: string; id: string; title: string; pageTimings: Record<string, number> }>;
    entries: HarEntry[];
  };
}

export interface HarMeta {
  browser?: { name: string; version: string };
}

function round(v: number): number {
  if (v < 0) return -1;
  return Math.round(v * 100) / 100;
}

/** CDP raw header maps join duplicate headers with "\n" — split them back out. */
function headersToArray(headers?: Record<string, string>): HarHeader[] {
  if (!headers) return [];
  const out: HarHeader[] = [];
  for (const [name, raw] of Object.entries(headers)) {
    const value = raw ?? "";
    if (value.includes("\n")) {
      for (const part of value.split("\n")) out.push({ name, value: part });
    } else {
      out.push({ name, value });
    }
  }
  return out;
}

function findHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function parseSetCookie(str: string): HarCookie {
  const parts = str.split(";").map((s) => s.trim());
  const nv = parts.shift() ?? "";
  const eq = nv.indexOf("=");
  const cookie: HarCookie = {
    name: eq >= 0 ? nv.slice(0, eq) : nv,
    value: eq >= 0 ? nv.slice(eq + 1) : "",
  };
  for (const attr of parts) {
    const i = attr.indexOf("=");
    const key = (i >= 0 ? attr.slice(0, i) : attr).toLowerCase();
    const val = i >= 0 ? attr.slice(i + 1) : "";
    if (key === "path") cookie.path = val;
    else if (key === "domain") cookie.domain = val;
    else if (key === "expires") cookie.expires = val;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "secure") cookie.secure = true;
    else if (key === "samesite") cookie.sameSite = val;
  }
  return cookie;
}

function responseCookies(entry: CapturedEntry): HarCookie[] {
  if (entry.responseCookies?.length) return entry.responseCookies;
  // Set-Cookie from ExtraInfo raw headers carries http-only cookies; fall back to the regular headers.
  const raw = findHeader(entry.responseExtraHeaders, "set-cookie") ?? findHeader(entry.responseHeaders, "set-cookie");
  if (!raw) return [];
  return raw.split("\n").map(parseSetCookie);
}

function requestCookies(entry: CapturedEntry): HarCookie[] {
  if (entry.requestCookies?.length) return entry.requestCookies;
  const cookieHeader = findHeader(entry.requestExtraHeaders, "cookie") ?? findHeader(entry.request?.headers, "cookie");
  if (!cookieHeader) return [];
  return cookieHeader
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return { name: eq >= 0 ? pair.slice(0, eq) : pair, value: eq >= 0 ? pair.slice(eq + 1) : "" };
    });
}

function queryString(url: string): HarNameValue[] {
  try {
    const u = new URL(url);
    return [...u.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function toHarTimings(
  t: CdpResourceTiming | undefined,
  startMono?: number,
  finishMono?: number,
): { timings: HarTimings; time: number } {
  const totalWall = finishMono != null && startMono != null ? (finishMono - startMono) * 1000 : -1;
  if (!t) {
    const wait = totalWall >= 0 ? totalWall : 0;
    return { timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: round(wait), receive: 0 }, time: round(wait) };
  }
  const reqTime = t.requestTime;
  const firstStarts = [t.dnsStart, t.connectStart, t.sendStart].filter((v) => v >= 0);
  const firstActivity = firstStarts.length ? Math.min(...firstStarts) : -1;
  const startGapMs = startMono != null ? Math.max(0, (reqTime - startMono) * 1000) : 0;
  let blocked = firstActivity >= 0 ? startGapMs + firstActivity : -1;

  const dns = t.dnsStart >= 0 && t.dnsEnd >= 0 ? t.dnsEnd - t.dnsStart : -1;
  const connect = t.connectStart >= 0 && t.connectEnd >= 0 ? t.connectEnd - t.connectStart : -1;
  const ssl = t.sslStart >= 0 && t.sslEnd >= 0 ? t.sslEnd - t.sslStart : -1;
  const send = t.sendStart >= 0 && t.sendEnd >= 0 ? Math.max(0, t.sendEnd - t.sendStart) : 0;
  const wait = t.receiveHeadersEnd >= 0 && t.sendEnd >= 0 ? Math.max(0, t.receiveHeadersEnd - t.sendEnd) : 0;
  let receive = 0;
  if (finishMono != null && t.receiveHeadersEnd >= 0) {
    receive = Math.max(0, (finishMono - reqTime) * 1000 - t.receiveHeadersEnd);
  }
  const sum = [blocked, dns, connect, send, wait, receive].reduce((a, b) => a + (b > 0 ? b : 0), 0);
  return {
    timings: {
      blocked: round(blocked),
      dns: round(dns),
      connect: round(connect),
      ssl: round(ssl),
      send: round(send),
      wait: round(wait),
      receive: round(receive),
    },
    time: round(sum),
  };
}

function buildEntry(entry: CapturedEntry, fallbackStart: number): HarEntry {
  const req = entry.request!;
  const httpVersion = entry.protocol ?? "HTTP/1.1";
  const reqHeaders = { ...(req.headers ?? {}), ...(entry.requestExtraHeaders ?? {}) };
  const startedDateTime = entry.wallTime
    ? new Date(entry.wallTime * 1000).toISOString()
    : new Date(fallbackStart).toISOString();
  const { timings, time } = toHarTimings(entry.timing, entry.startMonotonic, entry.finishedMonotonic);

  const postData = req.postData
    ? { mimeType: findHeader(reqHeaders, "content-type") ?? "application/octet-stream", text: req.postData }
    : undefined;

  const bodyText = entry.body?.text;
  const contentSize = entry.dataLength > 0 ? entry.dataLength : entry.body?.base64Encoded ? -1 : bodyText ? Buffer.byteLength(bodyText, "utf8") : 0;

  return {
    pageref: entry.pageId,
    startedDateTime,
    time,
    request: {
      method: req.method,
      url: req.url,
      httpVersion,
      cookies: requestCookies(entry),
      headers: headersToArray(reqHeaders),
      queryString: queryString(req.url),
      postData,
      headersSize: -1,
      bodySize: req.postData ? Buffer.byteLength(req.postData, "utf8") : req.hasPostData ? -1 : 0,
    },
    response: {
      status: entry.status ?? 0,
      statusText: entry.statusText ?? (entry.errorText ? `_${entry.errorText}` : ""),
      httpVersion,
      cookies: responseCookies(entry),
      headers: headersToArray({ ...(entry.responseHeaders ?? {}), ...(entry.responseExtraHeaders ?? {}) }),
      content: {
        size: contentSize,
        mimeType: entry.mimeType ?? "",
        ...(bodyText != null ? { text: bodyText } : {}),
        ...(entry.body?.base64Encoded ? { encoding: "base64" } : {}),
      },
      redirectURL: findHeader(entry.responseHeaders, "location") ?? "",
      headersSize: -1,
      bodySize: entry.encodedDataLength || -1,
    },
    cache: {},
    timings,
    serverIPAddress: entry.remoteIPAddress,
    connection: entry.connectionId != null ? String(entry.connectionId) : undefined,
    _resourceType: entry.resourceType,
    _requestId: entry.requestId,
    _fromDiskCache: entry.fromDiskCache,
    _fromServiceWorker: entry.fromServiceWorker,
    ...(entry.errorText ? { _error: entry.errorText } : {}),
    ...(entry.body?.truncated ? { _bodyTruncated: true } : {}),
    ...(entry.isWebSocket ? { _webSocketMessages: entry.wsMessages ?? [] } : {}),
    ...(entry.wsFramesTruncated ? { _webSocketMessagesTruncated: true } : {}),
  };
}

export function buildHar(store: CaptureStore, meta: HarMeta = {}): Har {
  const entries = store
    .allEntries()
    .filter((e) => e.request)
    .map((e) => buildEntry(e, store.startedAt));
  const pages = store.pages.map((p) => ({
    startedDateTime: new Date(p.startedWallTime ? p.startedWallTime * 1000 : store.startedAt).toISOString(),
    id: p.id,
    title: p.title || p.url,
    pageTimings: {},
  }));
  return {
    log: {
      version: "1.2",
      creator: { name: SERVER_NAME, version: SERVER_VERSION },
      browser: meta.browser,
      pages,
      entries,
    },
  };
}

// ---------------------------------------------------------------------------
// Query helpers — operate on a built HAR so they work for both live captures
// and HARs re-read from disk, without dumping the whole thing into context.
// ---------------------------------------------------------------------------

export interface RequestFilter {
  method?: string;
  status?: number;
  urlContains?: string;
  mimeType?: string;
  resourceType?: string;
  limit?: number;
  offset?: number;
}

export interface RequestSummary {
  index: number;
  method: string;
  status: number;
  url: string;
  resourceType?: string;
  mimeType: string;
  responseBytes: number;
  hasBody: boolean;
  requestId?: string;
}

export function summarizeRequests(har: Har, filter: RequestFilter = {}): { total: number; matched: number; requests: RequestSummary[] } {
  const all = har.log.entries.map((e, index) => ({ e, index }));
  const filtered = all.filter(({ e }) => {
    if (filter.method && e.request.method.toUpperCase() !== filter.method.toUpperCase()) return false;
    if (filter.status != null && e.response.status !== filter.status) return false;
    if (filter.urlContains && !e.request.url.toLowerCase().includes(filter.urlContains.toLowerCase())) return false;
    if (filter.mimeType && !(e.response.content.mimeType ?? "").toLowerCase().includes(filter.mimeType.toLowerCase())) return false;
    if (filter.resourceType && (e._resourceType ?? "").toLowerCase() !== filter.resourceType.toLowerCase()) return false;
    return true;
  });
  const offset = filter.offset ?? 0;
  const limit = filter.limit ?? 100;
  const page = filtered.slice(offset, offset + limit);
  return {
    total: har.log.entries.length,
    matched: filtered.length,
    requests: page.map(({ e, index }) => ({
      index,
      method: e.request.method,
      status: e.response.status,
      url: e.request.url,
      resourceType: e._resourceType,
      mimeType: e.response.content.mimeType,
      responseBytes: e.response.bodySize,
      hasBody: e.response.content.text != null,
      requestId: e._requestId,
    })),
  };
}

/**
 * Reconstruct a cookie jar from the captured traffic — a fallback for when the
 * CDP cookie APIs come back empty (e.g. headful Chrome's deprecated
 * Network.getAllCookies). Response `Set-Cookie` entries are richest (they carry
 * httpOnly/secure/path/domain); request `Cookie` headers fill in anything only
 * ever sent, never set, during the session. Deduped by name + domain.
 */
export function cookiesFromHar(har: Har): HarCookie[] {
  const hostOfUrl = (u: string) => {
    try {
      return new URL(u).hostname;
    } catch {
      return "";
    }
  };
  const norm = (d?: string) => (d ?? "").replace(/^\./, "").toLowerCase();
  const jar = new Map<string, HarCookie>();

  // Set-Cookie responses first (full attributes).
  for (const e of har.log.entries) {
    const host = hostOfUrl(e.request.url);
    for (const c of e.response.cookies ?? []) {
      const domain = c.domain || host;
      jar.set(`${c.name}|${norm(domain)}`, { ...c, domain });
    }
  }
  // Then request cookies (name/value only) for anything not already captured.
  for (const e of har.log.entries) {
    const host = hostOfUrl(e.request.url);
    for (const c of e.request.cookies ?? []) {
      const domain = c.domain || host;
      const key = `${c.name}|${norm(domain)}`;
      if (!jar.has(key)) jar.set(key, { name: c.name, value: c.value, domain });
    }
  }
  return [...jar.values()];
}

export function selectEntry(har: Har, selector: { index?: number; requestId?: string; urlContains?: string }): HarEntry | undefined {
  if (selector.index != null) return har.log.entries[selector.index];
  if (selector.requestId) return har.log.entries.find((e) => e._requestId === selector.requestId);
  if (selector.urlContains) {
    const needle = selector.urlContains.toLowerCase();
    return har.log.entries.find((e) => e.request.url.toLowerCase().includes(needle));
  }
  return undefined;
}
