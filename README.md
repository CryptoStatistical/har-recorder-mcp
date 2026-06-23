# HAR Recorder MCP

MCP server that lets Claude **record real, user-driven browsing sessions**
(logins included) and produce **complete** HAR files — http-only cookies
included, request/response headers, post-data and response bodies,
**traffic from pages, iframes, workers, service workers and WebSocket frames**.

It fixes the usual gaps of existing HAR exporters: missing http-only cookies,
recordings that never start, absent service-worker fetches. Capture runs via
**browser-level CDP auto-attach** (not per-page), so it catches every target.
See [`BLUEPRINT.md`](./BLUEPRINT.md).

## Quickstart

```bash
npm install
npm run build
```

The server uses **Google Chrome** when available (best for real logins) and
falls back to Playwright's Chromium. To force/install the latter:

```bash
npm run install:browser   # playwright install chromium
```

Register the server in your MCP client (Claude Desktop / Claude Code):

```json
{
  "mcpServers": {
    "har-recorder": {
      "command": "node",
      "args": ["/absolute/path/to/har-recorder-mcp/dist/index.js"],
      "env": { "HAR_RECORDER_ROOT": "/path/to/your/project" }
    }
  }
}
```

`HAR_RECORDER_ROOT` decides where `.recording/` is created (default: the client's
cwd). `HAR_RECORDER_HEADLESS=1` forces headless mode (handy for CI/tests).

### Attach mode (record an already-open browser)

Besides launching Chrome, the server can **attach to a Chrome the user is already
using**, as long as it was started with remote debugging:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
```

Then `start_recording({ attachToPort: 9222 })`: it records without launching
anything; `close_browser` only disconnects (it does not close the user's browser).

## Simple usage (natural language)

Tool descriptions are in English and tuned for triggering, so a plain
natural-language prompt — in any language — is enough to invoke them:

- _"record a session and capture the traffic to fineco.it"_ → `start_recording`
- _"stop and save the HAR"_ → `stop_recording`
- _"show the POST requests to /api"_ → `list_requests`
- _"give me the http-only cookies"_ → `get_cookies`

## Prompt menu (guided steps)

Besides the tools, the server exposes **MCP prompts** that show up as a selectable
menu in the client (Claude Code / Desktop) — a guided workflow you can click
through instead of remembering the tool order:

| Prompt | What it does |
|--------|--------------|
| `guida` | Shows the recommended steps (start → navigate → checkpoint → stop/analyze → close). |
| `avvia-registrazione` | Starts a recording (optional `sito`, `etichetta`). |
| `segna-checkpoint` | Marks a checkpoint (`etichetta`). |
| `ferma-e-analizza` | Stops capture and reconstructs where you went. |
| `chiudi-browser` | Closes Chrome — saves the HAR first if a recording is still active. |

> ⚠️ Closing the browser while a recording is still **active** discards the unsaved
> capture (the HAR is never assembled). The `chiudi-browser` and `guida` prompts
> enforce `stop_recording` **before** `close_browser`, so nothing is lost.

Menu labels are in Italian; the prompt bodies steer Claude through the tools.

## Workflow

1. Claude → `start_recording(url, label?)` → Chrome opens (headful), capture
   starts in the background, returns a `recordingId`.
2. **You** navigate and log in inside the browser. (Claude may ask whether a login
   is needed, persistent vs clean profile, whether to capture bodies.)
3. (optional) `mark_checkpoint("login done")` to segment and improve the name.
4. Claude → `stop_recording(recordingId)` → assembles the HAR, names it from
   titles/host/checkpoints, creates the `.zip` and the `summary.md`.
5. Claude can query the capture with `list_requests` / `get_request` /
   `get_cookies` without dumping the whole HAR into context.

## Output

```
.recording/
├── index.json
├── 2026-06-22_143052__fineco-it__login__dashboard/
│   ├── session.har          # complete HAR (http-only included)
│   ├── session.har.gz
│   ├── 2026-06-22_..._dashboard.zip   # deliverable package
│   ├── metadata.json
│   ├── summary.md           # reconstruction guide
│   └── cookies.json         # full cookie jar (incl. http-only)
└── .chrome-profile/         # persistent profile (logins kept)
```

## ⚠️ Security

`.recording/` contains **live session tokens and cookies**. It is already in
`.gitignore`. Don't share the zips. Use `profile: "fresh"` for isolated captures.

## Available tools

| Tool | Description |
|------|-------------|
| `start_recording` | Opens Chrome headful (or attaches via `attachToPort`) and starts complete CDP capture of every target. `{ url?, label?, profile?, captureBodies?, channel?, attachToPort? }` |
| `get_session_status` | Live status (duration, request count, pages, checkpoints). `{ recordingId? }` |
| `mark_checkpoint` | Marks a step (e.g. "login done"). `{ label, recordingId? }` |
| `stop_recording` | Assembles HAR + zip + summary + cookie jar. `{ recordingId? }` |
| `list_recordings` | Lists known recordings. |
| `list_requests` | Filterable summary list, without dumping the HAR. `{ recordingId, method?, status?, urlContains?, mimeType?, resourceType?, limit?, offset? }` |
| `get_request` | Full HAR entry for a request (WebSocket frames in `_webSocketMessages`). `{ recordingId, index? \| requestId? \| urlContains? }` |
| `get_cookies` | Cookie jar (http-only included), filterable by domain. `{ recordingId, domain? }` |
| `annotate_recording` | Adds a note (to metadata + summary). `{ recordingId, note }` |
| `close_browser` | Closes Chrome (and cleans up the `fresh` profile). `{ recordingId? }` |

## Development

```bash
npm run build       # compile TypeScript → dist/
npm run dev         # watch mode
npm test            # smoke test of the MCP server (no browser)
npm run test:e2e    # headless e2e: http-only cookies + service worker + WebSocket frames
```
