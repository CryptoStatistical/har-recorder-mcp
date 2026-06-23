#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { log, logError } from "./log.js";
import { RecordingManager } from "./manager.js";

const manager = new RecordingManager();

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
  };
}

function fail(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  logError(msg);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

const MCP_INSTRUCTIONS = [
  "Use har-recorder to capture real user-driven browser traffic as complete HAR files.",
  "Start with start_recording, let the user browse/login in Chrome, then always run stop_recording before close_browser so the HAR is assembled.",
  "Use list_requests before get_request to avoid dumping large HARs into context. WebSocket frames are stored in _webSocketMessages; cookies include http-only values.",
].join(" ");

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    instructions: MCP_INSTRUCTIONS,
  },
);

server.registerTool(
  "start_recording",
  {
    title: "Start recording",
    description:
      "Start recording a browsing session and capture ALL network traffic to/from a website as a HAR. Use this whenever the user wants to record a session, capture traffic/requests for a site, sniff/inspect API calls, or grab a HAR or cookies for a site. Opens Chrome (headful) and captures via browser-level CDP: pages, iframes, workers and service workers, including http-only cookies and WebSocket frames. The user navigates and logs in manually. With attachToPort it connects to an already-running Chrome (started with --remote-debugging-port) instead of launching a new one. Returns a recordingId.",
    inputSchema: {
      url: z.string().optional().describe("Initial URL / site to open and capture traffic for (optional: without it, starts blank and captures whatever the user navigates to)."),
      label: z.string().optional().describe("Short label (e.g. 'login') also used in the recording name."),
      profile: z.enum(["persistent", "fresh"]).optional().describe("persistent (default) keeps logins across sessions | fresh starts clean and isolated. Ignored in attach mode."),
      captureBodies: z.boolean().optional().describe("Capture response bodies (default true)."),
      channel: z.string().optional().describe("Playwright browser channel, e.g. 'chrome' | 'msedge'. Default: try chrome then chromium."),
      attachToPort: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("CDP port of an already-running Chrome (chrome --remote-debugging-port=PORT). Records without launching a browser."),
    },
  },
  async (args) => run(() => manager.start(args)),
);

server.registerTool(
  "get_session_status",
  {
    title: "Session status",
    description: "Status of the active recording (or a past one via recordingId): duration, request count, targets, checkpoints.",
    inputSchema: {
      recordingId: z.string().optional().describe("If omitted, uses the active recording."),
    },
  },
  async (args) => run(() => manager.status(args.recordingId)),
);

server.registerTool(
  "mark_checkpoint",
  {
    title: "Mark checkpoint",
    description: "Mark a checkpoint in the active recording (e.g. 'login done'). Used to segment the session and improve the file name.",
    inputSchema: {
      label: z.string().describe("Checkpoint label."),
      recordingId: z.string().optional(),
    },
  },
  async (args) => run(async () => manager.markCheckpoint(args.recordingId, args.label)),
);

server.registerTool(
  "stop_recording",
  {
    title: "Stop recording",
    description:
      "Stop capture and assemble the complete HAR (http-only cookies included). Use when the user is done recording or wants to save the captured traffic. Names the folder and writes .har/.har.gz/.zip/summary.md/cookies.json/metadata.json, then updates the index. If the .zip bundle exceeds 20 MB it is also split into ≤20 MB parts named `<name>.zip.001`, `<name>.zip.002`, …; the result includes a `transfer` block with the part list and the command to rejoin them (`cat <name>.zip.* > <name>.zip`) — reconstruct the full bundle BEFORE opening the (potentially very large) HAR. The browser stays open.",
    inputSchema: {
      recordingId: z.string().optional().describe("If omitted, stops the active recording."),
    },
  },
  async (args) => run(() => manager.stop(args.recordingId)),
);

server.registerTool(
  "list_recordings",
  {
    title: "List recordings",
    description: "List all known recordings (from the .recording/index.json index).",
    inputSchema: {},
  },
  async () => run(() => manager.listRecordings()),
);

server.registerTool(
  "list_requests",
  {
    title: "List requests",
    description:
      "List a recording's captured requests in summary form, without dumping the whole HAR into context. Optional filters by method/status/url/mime/type. Works live too.",
    inputSchema: {
      recordingId: z.string(),
      method: z.string().optional(),
      status: z.number().int().optional(),
      urlContains: z.string().optional(),
      mimeType: z.string().optional(),
      resourceType: z.string().optional(),
      limit: z.number().int().positive().max(1000).optional().describe("Default 100."),
      offset: z.number().int().min(0).optional(),
    },
  },
  async (args) => {
    const { recordingId, ...filter } = args;
    return run(() => manager.listRequests(recordingId, filter));
  },
);

server.registerTool(
  "get_request",
  {
    title: "Get request",
    description:
      "Return the full HAR entry (headers, cookies, post-data, body; WebSocket frames in _webSocketMessages) for a single captured request, selected by index, requestId or URL substring.",
    inputSchema: {
      recordingId: z.string(),
      index: z.number().int().min(0).optional(),
      requestId: z.string().optional(),
      urlContains: z.string().optional(),
    },
  },
  async (args) => {
    const { recordingId, index, requestId, urlContains } = args;
    return run(() => manager.getRequest(recordingId, { index, requestId, urlContains }));
  },
);

server.registerTool(
  "get_cookies",
  {
    title: "Get cookies",
    description: "Return a recording's full cookie jar (http-only included), with an optional domain filter. Live if the recording is active.",
    inputSchema: {
      recordingId: z.string(),
      domain: z.string().optional().describe("Filter by domain substring."),
    },
  },
  async (args) => run(() => manager.getCookies(args.recordingId, args.domain)),
);

server.registerTool(
  "annotate_recording",
  {
    title: "Annotate recording",
    description: "Add a note to a recording (live or on disk). Notes land in metadata.json and in summary.md.",
    inputSchema: {
      recordingId: z.string(),
      note: z.string(),
    },
  },
  async (args) => run(() => manager.annotate(args.recordingId, args.note)),
);

server.registerTool(
  "rename_recording",
  {
    title: "Rename recording",
    description:
      "Rename a live or saved recording for easier identification in the dashboard, index, metadata and summary. This changes the display title/label, not the artifact directory name.",
    inputSchema: {
      recordingId: z.string(),
      name: z.string().min(1).max(120).describe("New display name for the recording."),
    },
  },
  async (args) => run(() => manager.renameRecording(args.recordingId, args.name)),
);

server.registerTool(
  "close_browser",
  {
    title: "Close browser",
    description: "Close the recording's Chrome window. In attach mode it only disconnects (does not close the user's browser). For a 'fresh' profile it also removes the temporary profile.",
    inputSchema: {
      recordingId: z.string().optional(),
    },
  },
  async (args) => run(() => manager.closeBrowser(args.recordingId)),
);

// ---------------------------------------------------------------------------
// Prompts = an interactive menu of the recommended workflow. MCP clients that
// support prompts render these as selectable items, so the user gets a guided
// menu instead of having to remember the tool sequence. The body steers the
// agent through the tools.
// ---------------------------------------------------------------------------

const userMsg = (text: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
});

server.registerPrompt(
  "guide",
  {
    title: "📋 Guide: record & analyze a session",
    description: "The recommended steps: start → navigate → checkpoint → stop/analyze → close.",
  },
  () =>
    userMsg(
      [
        'Act as the guide for the "har-recorder" MCP server. Show the user this menu of recommended steps, then act on their choice:',
        "",
        "1. ▶️  Start recording — `start_recording({ url?, label? })`. Chrome opens (headful): the user navigates and logs in manually. Capture starts immediately: pages, iframes, workers, service workers, http-only cookies and WebSocket frames.",
        '2. 🚩  (optional) Mark checkpoint — `mark_checkpoint({ label })` at key steps (e.g. "login done"): improves segmentation and the file name.',
        "3. ⏹️  Stop & analyze — `stop_recording()` assembles the HAR (.har/.zip/summary.md/cookies.json). Then analyze WHERE the user went with `list_requests` (resourceType=document and method=POST) and `get_cookies`.",
        "4. ❌  Close the browser — `close_browser()`.",
        "",
        "⚠️  IMPORTANT: closing the browser while a recording is STILL ACTIVE discards the unsaved capture (the HAR is never assembled). ALWAYS run `stop_recording` BEFORE `close_browser`. If the user asks to close while still recording, warn them and propose: stop & save first, then close.",
        "",
        "Ask the user which step they want, or start from step 1 if they are just beginning.",
      ].join("\n"),
    ),
);

server.registerPrompt(
  "start-recording",
  {
    title: "▶️ Start recording",
    description: "Open Chrome and start capturing traffic (optional: a site to open).",
    argsSchema: {
      site: z.string().optional().describe("Initial URL/site to open (optional)."),
      label: z.string().optional().describe("Short label for the recording (optional)."),
    },
  },
  (args) => {
    const parts: string[] = [];
    if (args.site) parts.push(`url: ${JSON.stringify(args.site)}`);
    if (args.label) parts.push(`label: ${JSON.stringify(args.label)}`);
    const call = parts.length ? `start_recording({ ${parts.join(", ")} })` : "start_recording()";
    return userMsg(
      `Start a recording session by calling ${call}. Then tell the user Chrome is open, that they should navigate and log in manually, and that everything is being captured. Remind them that to save they must say "stop" (stop_recording) BEFORE closing the browser.`,
    );
  },
);

server.registerPrompt(
  "mark-checkpoint",
  {
    title: "🚩 Mark checkpoint",
    description: "Mark a step in the active recording (e.g. 'login done').",
    argsSchema: {
      label: z.string().describe("Checkpoint label (e.g. 'login done')."),
    },
  },
  (args) =>
    userMsg(`Mark a checkpoint in the active recording by calling mark_checkpoint({ label: ${JSON.stringify(args.label)} }).`),
);

server.registerPrompt(
  "stop-and-analyze",
  {
    title: "⏹️ Stop & analyze where I went",
    description: "Stop capture, assemble the HAR, and reconstruct the navigation path.",
  },
  () =>
    userMsg(
      [
        "Stop the active recording with `stop_recording()`.",
        "Then analyze WHERE the user went:",
        '- `list_requests` with resourceType="document" for page navigations;',
        '- `list_requests` with method="POST" for actions/forms/login;',
        "- `get_cookies` to tell whether an authenticated session was established.",
        "Summarize: the path (search → sites visited → login yes/no), hosts contacted, and where the artifacts are saved.",
        "Do NOT close the browser (leave it open for inspection) unless the user explicitly asks.",
      ].join("\n"),
    ),
);

server.registerPrompt(
  "close-browser",
  {
    title: "❌ Close the browser",
    description: "Close Chrome. If a recording is still active, save the HAR first.",
  },
  () =>
    userMsg(
      [
        "Close the recording's browser.",
        '⚠️ If a recording is STILL ACTIVE (status "recording"), closing discards the unsaved capture.',
        "So: check first with `get_session_status`. If it is still running, warn the user and run `stop_recording` FIRST (so the HAR is saved), then `close_browser`. If it was already stopped, call `close_browser` directly.",
      ].join("\n"),
    ),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`${SERVER_NAME} v${SERVER_VERSION} ready (stdio).`);

  const shutdown = async (signal: string) => {
    log(`received ${signal}, shutting down…`);
    try {
      await manager.dispose();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logError("fatal", err);
  process.exit(1);
});
