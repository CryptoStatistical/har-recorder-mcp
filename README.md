# HAR Recorder MCP

Server MCP che permette a Claude di **registrare sessioni di navigazione reali**
(guidate dall'utente, login compresi) e produrre HAR **completi** — cookie
http-only inclusi, header request/response, post-data e body delle risposte,
**traffico di pagine, iframe, worker, service worker e frame WebSocket**.

Risolve i limiti tipici degli HAR exporter esistenti: cookie http-only mancanti,
recording che non parte, fetch dei service worker assenti. La cattura avviene via
**auto-attach CDP a livello browser** (non per-pagina), quindi prende ogni target.
Vedi [`BLUEPRINT.md`](./BLUEPRINT.md).

## Quickstart

```bash
npm install
npm run build
```

Il server usa **Google Chrome** se presente (migliore per i login reali) e
ripiega sul Chromium di Playwright. Per forzare/installare quest'ultimo:

```bash
npm run install:browser   # playwright install chromium
```

Registra il server nel client MCP (Claude Desktop / Claude Code):

```json
{
  "mcpServers": {
    "har-recorder": {
      "command": "node",
      "args": ["/percorso/assoluto/har-recorder-mcp/dist/index.js"],
      "env": { "HAR_RECORDER_ROOT": "/percorso/del/tuo/progetto" }
    }
  }
}
```

`HAR_RECORDER_ROOT` decide dove nasce `.recording/` (default: cwd del client).
`HAR_RECORDER_HEADLESS=1` forza la modalità headless (utile per CI/test).

### Modalità attach (registrare un browser già aperto)

Oltre a lanciare Chrome, il server può **agganciarsi a un Chrome che l'utente sta
già usando**, purché avviato col debugging:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
```

Poi `start_recording({ attachToPort: 9222 })`: registra senza lanciare nulla;
`close_browser` si limita a disconnettersi (non chiude il browser dell'utente).

## Uso semplice (linguaggio naturale)

Le descrizioni dei tool sono in inglese e ottimizzate per il triggering, così
basta un prompt naturale — anche in italiano — per attivarli:

- _"registra una sessione e cattura il traffico verso fineco.it"_ → `start_recording`
- _"fermati e salva l'HAR"_ → `stop_recording`
- _"mostra le richieste POST verso /api"_ → `list_requests`
- _"dammi i cookie http-only"_ → `get_cookies`

## Flusso d'uso

1. Claude → `start_recording(url, label?)` → si apre Chrome (headful), inizia la
   cattura in background, ritorna un `recordingId`.
2. **Tu** navighi e fai login nel browser. (Claude può chiederti se serve login,
   profilo persistente o pulito, se catturare i body.)
3. (opzionale) `mark_checkpoint("login fatto")` per segmentare e migliorare il nome.
4. Claude → `stop_recording(recordingId)` → assembla l'HAR, lo nomina in base a
   titoli/host/checkpoint, crea lo `.zip` e il `summary.md`.
5. Claude può interrogare la cattura con `list_requests` / `get_request` /
   `get_cookies` senza riversare l'HAR intero nel contesto.

## Output

```
.recording/
├── index.json
├── 2026-06-22_143052__fineco-it__login__dashboard/
│   ├── session.har          # HAR completo (http-only inclusi)
│   ├── session.har.gz
│   ├── 2026-06-22_..._dashboard.zip   # pacchetto consegnato
│   ├── metadata.json
│   ├── summary.md           # guida di ricostruzione
│   └── cookies.json         # cookie jar completo (incl. http-only)
└── .chrome-profile/         # profilo persistente (login conservati)
```

## ⚠️ Sicurezza

`.recording/` contiene **token e cookie di sessione vivi**. È già in `.gitignore`.
Non condividere gli zip. Usa `profile: "fresh"` per catture isolate.

## Tool disponibili

| Tool | Descrizione |
|------|-------------|
| `start_recording` | Apre Chrome headful (o si aggancia via `attachToPort`) e avvia la cattura CDP completa di tutti i target. `{ url?, label?, profile?, captureBodies?, channel?, attachToPort? }` |
| `get_session_status` | Stato live (durata, n. richieste, pagine, checkpoint). `{ recordingId? }` |
| `mark_checkpoint` | Segna un passaggio (es. "login fatto"). `{ label, recordingId? }` |
| `stop_recording` | Assembla HAR + zip + summary + cookie jar. `{ recordingId? }` |
| `list_recordings` | Elenca le registrazioni note. |
| `list_requests` | Elenco sintetico filtrabile, senza dumpare l'HAR. `{ recordingId, method?, status?, urlContains?, mimeType?, resourceType?, limit?, offset? }` |
| `get_request` | Entry HAR completa di una richiesta. `{ recordingId, index? \| requestId? \| urlContains? }` |
| `get_cookies` | Cookie jar (http-only inclusi), filtrabile per dominio. `{ recordingId, domain? }` |
| `annotate_recording` | Aggiunge una nota (in metadata + summary). `{ recordingId, note }` |
| `close_browser` | Chiude Chrome (e pulisce il profilo `fresh`). `{ recordingId? }` |

## Sviluppo

```bash
npm run build       # compila TypeScript → dist/
npm run dev         # watch mode
npm test            # smoke test del server MCP (no browser)
npm run test:e2e    # e2e headless: cookie http-only + service worker + frame WebSocket
```
