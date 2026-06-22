import path from "node:path";

export const SERVER_NAME = "har-recorder";
export const SERVER_VERSION = "0.1.0";

/**
 * Root under which `.recording/` lives. Controlled by HAR_RECORDER_ROOT so the
 * MCP client can pin recordings to a specific project regardless of the
 * server's working directory. Falls back to the process cwd.
 */
export function resolveRoot(): string {
  const env = process.env.HAR_RECORDER_ROOT?.trim();
  return env && env.length > 0 ? path.resolve(env) : process.cwd();
}

export function recordingRoot(): string {
  return path.join(resolveRoot(), ".recording");
}

export function indexPath(): string {
  return path.join(recordingRoot(), "index.json");
}

/** Persistent Chrome profile dir (keeps logins between recordings). */
export function persistentProfileDir(): string {
  return path.join(recordingRoot(), ".chrome-profile");
}

/** Max bytes of a single response body we keep in the HAR (larger ⇒ truncated). */
export const MAX_BODY_BYTES = 12 * 1024 * 1024;

/** Caps for WebSocket capture so a chatty socket can't blow up memory / the HAR. */
export const MAX_WS_FRAMES = 5000;
export const MAX_WS_FRAME_BYTES = 64 * 1024;
