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
      "Apre Chrome (headful) e avvia la cattura di rete COMPLETA via CDP a livello browser: pagine, iframe, worker e service worker, cookie http-only inclusi. L'utente naviga e fa login a mano. Con attachToPort si connette invece a un Chrome già in esecuzione (avviato con --remote-debugging-port), senza lanciarne uno nuovo.",
    inputSchema: {
      url: z.string().optional().describe("URL iniziale da aprire (opzionale: senza, parte da pagina vuota / cattura ciò che l'utente naviga)."),
      label: z.string().optional().describe("Etichetta breve (es. 'fineco login') usata anche per il nome."),
      profile: z.enum(["persistent", "fresh"]).optional().describe("persistent (default) | fresh. Ignorato in modalità attach."),
      captureBodies: z.boolean().optional().describe("Cattura i body delle risposte (default true)."),
      channel: z.string().optional().describe("Canale browser Playwright, es. 'chrome' | 'msedge'. Default: prova chrome poi chromium."),
      attachToPort: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Porta CDP di un Chrome già avviato (chrome --remote-debugging-port=PORT). Registra senza lanciare il browser."),
    },
  },
  async (args) => run(() => manager.start(args)),
);

server.registerTool(
  "get_session_status",
  {
    title: "Session status",
    description: "Stato della registrazione attiva (o di una passata via recordingId): durata, n. richieste, pagine, checkpoint.",
    inputSchema: {
      recordingId: z.string().optional().describe("Se omesso, usa la registrazione attiva."),
    },
  },
  async (args) => run(() => manager.status(args.recordingId)),
);

server.registerTool(
  "mark_checkpoint",
  {
    title: "Mark checkpoint",
    description: "Segna un checkpoint nella registrazione attiva (es. 'login fatto'). Usato per segmentare e migliorare il nome del file.",
    inputSchema: {
      label: z.string().describe("Etichetta del checkpoint."),
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
      "Ferma la cattura, assembla l'HAR completo (cookie http-only inclusi), nomina la cartella, scrive .har/.har.gz/.zip/summary.md/cookies.json/metadata.json e aggiorna l'indice. Il browser resta aperto.",
    inputSchema: {
      recordingId: z.string().optional().describe("Se omesso, ferma la registrazione attiva."),
    },
  },
  async (args) => run(() => manager.stop(args.recordingId)),
);

server.registerTool(
  "list_recordings",
  {
    title: "List recordings",
    description: "Elenca tutte le registrazioni note (dall'indice .recording/index.json).",
    inputSchema: {},
  },
  async () => run(() => manager.listRecordings()),
);

server.registerTool(
  "list_requests",
  {
    title: "List requests",
    description:
      "Elenca (in forma sintetica) le richieste di una registrazione, senza riversare l'HAR intero nel contesto. Filtri opzionali per metodo/status/url/mime/tipo. Funziona anche live.",
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
      "Ritorna l'entry HAR completa (header, cookie, post-data, body) di una singola richiesta, selezionata per indice, requestId o sottostringa di URL.",
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
    description: "Ritorna il cookie jar completo (http-only inclusi) di una registrazione, con filtro opzionale per dominio. Live se la registrazione è attiva.",
    inputSchema: {
      recordingId: z.string(),
      domain: z.string().optional().describe("Filtra per sottostringa di dominio."),
    },
  },
  async (args) => run(() => manager.getCookies(args.recordingId, args.domain)),
);

server.registerTool(
  "annotate_recording",
  {
    title: "Annotate recording",
    description: "Aggiunge una nota a una registrazione (live o su disco). Le note finiscono in metadata.json e nel summary.md.",
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
    description: "Chiude la finestra Chrome della registrazione. Se il profilo era 'fresh', rimuove anche il profilo temporaneo.",
    inputSchema: {
      recordingId: z.string().optional(),
    },
  },
  async (args) => run(() => manager.closeBrowser(args.recordingId)),
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
