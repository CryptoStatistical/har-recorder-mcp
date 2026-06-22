// Fast smoke test: boots the MCP server over stdio and checks the tool surface.
// No browser is launched. Run: npm run build && node test/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const expected = [
  "annotate_recording",
  "close_browser",
  "get_cookies",
  "get_request",
  "get_session_status",
  "list_recordings",
  "list_requests",
  "mark_checkpoint",
  "start_recording",
  "stop_recording",
].sort();

let failures = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? "✅" : "❌"} ${msg}`);
  if (!cond) failures++;
};

assert(tools.length === 10, `10 tool esposti (trovati ${tools.length})`);
assert(JSON.stringify(names) === JSON.stringify(expected), "i 10 tool attesi sono tutti presenti");

const list = await client.callTool({ name: "list_recordings", arguments: {} });
assert(!list.isError, "list_recordings risponde senza errore");

const miss = await client.callTool({ name: "get_request", arguments: { recordingId: "nope", index: 0 } });
assert(miss.isError === true, "get_request su id inesistente ritorna isError (server resta vivo)");

await client.close();
console.log(failures === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
