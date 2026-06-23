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
  return { content: [{ type: "text", text: `Errore: ${msg}` }], isError: true };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

server.registerTool(
  "start_recording",
  {
    title: "Start recording",
    description:
      "Start recording a browsing session and capture ALL network traffic to/from a website as a HAR. Use this whenever the user wants to record a session, capture traffic/requests for a site, sniff/inspect API calls, or grab a HAR or cookies for a site. Opens Chrome (headful) and captures via browser-level CDP: pages, iframes, workers and service workers, including http-only cookies and WebSocket frames. The user navigates and logs in manually. With attachToPort it connects to an already-running Chrome (started with --remote-debugging-port) instead of launching a new one. Returns a recordingId.",
    inputSchema: {
      url: z.string().optional().describe("Initial URL / site to open and capture traffic for (optional: without it, starts blank and captures whatever the user navigates to)."),
      label: z.string().optional().describe("Short label (e.g. 'fineco login') also used in the recording name."),
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
      "Stop capture and assemble the complete HAR (http-only cookies included). Use when the user is done recording or wants to save the captured traffic. Names the folder and writes .har/.har.gz/.zip/summary.md/cookies.json/metadata.json, then updates the index. The browser stays open.",
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
// Prompts = interactive menu of the recommended workflow. MCP clients (Claude
// Code / Desktop) render these as selectable items, so the user gets a guided
// menu instead of having to remember the tool sequence. Labels are in Italian
// (this is the human-facing menu); the body steers Claude through the tools.
// ---------------------------------------------------------------------------

const userMsg = (text: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
});

server.registerPrompt(
  "guida",
  {
    title: "📋 Guida: registra e analizza una sessione",
    description: "Menu con gli step consigliati: avvia → naviga → checkpoint → ferma/analizza → chiudi.",
  },
  () =>
    userMsg(
      [
        'Fai da guida per il server MCP "har-recorder". Mostra all\'utente questo menu con gli step consigliati e poi agisci in base alla sua scelta:',
        "",
        "1. ▶️  Avvia registrazione — `start_recording({ url?, label? })`. Si apre Chrome (headful): l'utente naviga e fa login a mano. La cattura parte subito: pagine, iframe, worker, service worker, cookie http-only e frame WebSocket.",
        '2. 🚩  (opzionale) Segna checkpoint — `mark_checkpoint({ label })` nei passaggi chiave (es. "login fatto"): migliora la segmentazione e il nome del file.',
        "3. ⏹️  Ferma e analizza — `stop_recording()` assembla l'HAR (.har/.zip/summary.md/cookies.json). Poi analizza DOVE è andato l'utente con `list_requests` (resourceType=document e method=POST) e `get_cookies`.",
        "4. ❌  Chiudi il browser — `close_browser()`.",
        "",
        "⚠️  IMPORTANTE: chiudere il browser mentre la registrazione è ANCORA ATTIVA scarta la cattura non salvata (l'HAR non viene assemblato). Esegui SEMPRE `stop_recording` PRIMA di `close_browser`. Se l'utente chiede di chiudere mentre sta ancora registrando, avvisalo e proponi: prima fermo e salvo, poi chiudo.",
        "",
        "Chiedi all'utente quale step vuole, oppure parti dal punto 1 se sta iniziando ora.",
      ].join("\n"),
    ),
);

server.registerPrompt(
  "avvia-registrazione",
  {
    title: "▶️ Avvia registrazione",
    description: "Apre Chrome e inizia a catturare il traffico (opzionale: sito da aprire).",
    argsSchema: {
      sito: z.string().optional().describe("URL/sito iniziale da aprire (opzionale)."),
      etichetta: z.string().optional().describe("Etichetta breve per la registrazione (opzionale)."),
    },
  },
  (args) => {
    const parts: string[] = [];
    if (args.sito) parts.push(`url: ${JSON.stringify(args.sito)}`);
    if (args.etichetta) parts.push(`label: ${JSON.stringify(args.etichetta)}`);
    const call = parts.length ? `start_recording({ ${parts.join(", ")} })` : "start_recording()";
    return userMsg(
      `Avvia una registrazione di sessione chiamando ${call}. Poi spiega all'utente che Chrome è aperto, che deve navigare e fare login a mano, e che stai catturando tutto. Ricordagli che per salvare dovrà dire "ferma" (stop_recording) PRIMA di chiudere il browser.`,
    );
  },
);

server.registerPrompt(
  "segna-checkpoint",
  {
    title: "🚩 Segna checkpoint",
    description: "Marca un passaggio nella registrazione attiva (es. 'login fatto').",
    argsSchema: {
      etichetta: z.string().describe("Etichetta del checkpoint (es. 'login fatto')."),
    },
  },
  (args) =>
    userMsg(
      `Segna un checkpoint nella registrazione attiva chiamando mark_checkpoint({ label: ${JSON.stringify(args.etichetta)} }).`,
    ),
);

server.registerPrompt(
  "ferma-e-analizza",
  {
    title: "⏹️ Ferma e analizza dove sono andato",
    description: "Ferma la cattura, assembla l'HAR e ricostruisce il percorso di navigazione.",
  },
  () =>
    userMsg(
      [
        "Ferma la registrazione attiva con `stop_recording()`.",
        "Poi analizza DOVE è andato l'utente:",
        '- `list_requests` con resourceType="document" per le navigazioni di pagina;',
        '- `list_requests` con method="POST" per azioni/form/login;',
        "- `get_cookies` per capire se è stata aperta una sessione autenticata.",
        "Riassumi: percorso (ricerca → siti visitati → login sì/no), host contattati e dove sono salvati gli artefatti.",
        "NON chiudere il browser (resta aperto per ispezione) salvo richiesta esplicita dell'utente.",
      ].join("\n"),
    ),
);

server.registerPrompt(
  "chiudi-browser",
  {
    title: "❌ Chiudi il browser",
    description: "Chiude Chrome. Se una registrazione è ancora attiva, salva prima l'HAR.",
  },
  () =>
    userMsg(
      [
        "Chiudi il browser della registrazione.",
        '⚠️ Se una registrazione è ANCORA ATTIVA (status "recording"), chiuderlo scarta la cattura non salvata.',
        "Quindi: controlla prima con `get_session_status`. Se è ancora in corso, avvisa l'utente ed esegui `stop_recording` PRIMA (così l'HAR viene salvato), poi `close_browser`. Se è già stata fermata, chiama direttamente `close_browser`.",
      ].join("\n"),
    ),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`${SERVER_NAME} v${SERVER_VERSION} pronto (stdio).`);

  const shutdown = async (signal: string) => {
    log(`ricevuto ${signal}, chiusura…`);
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
