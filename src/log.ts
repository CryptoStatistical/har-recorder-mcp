/**
 * MCP stdio servers MUST keep stdout clean for the JSON-RPC protocol.
 * Everything diagnostic goes to stderr.
 */
function fmt(args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a)))
    .join(" ");
}

export function log(...args: unknown[]): void {
  process.stderr.write(`[har-recorder] ${fmt(args)}\n`);
}

export function logError(...args: unknown[]): void {
  process.stderr.write(`[har-recorder][error] ${fmt(args)}\n`);
}
