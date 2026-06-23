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

## Install as an MCP server

Register the built server (`dist/index.js`) with your MCP client. Use an
**absolute path** for both `node` and the script — MCP clients often launch with a
minimal environment. Find your node path with `which node` (e.g. `/opt/homebrew/bin/node`).

### Claude Code (CLI)

```bash
claude mcp add har-recorder -s user -- /opt/homebrew/bin/node /absolute/path/to/har-recorder-mcp/dist/index.js
```

- `-s user` → available in every project. Use `-s local` for the current project only,
  or `-s project` to share it via a committed `.mcp.json`.
- Verify with `claude mcp list` (should show `har-recorder … ✔ Connected`).
- A newly added server is loaded in the **next** Claude Code session (restart/reconnect).

### Claude Desktop (JSON)

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`) and add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "har-recorder": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/har-recorder-mcp/dist/index.js"],
      "env": {
        "HAR_RECORDER_ROOT": "/path/to/recordings",
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

Then **restart Claude Desktop** to load it.

`HAR_RECORDER_ROOT` decides where `.recording/` is created (default: the client's
cwd — set it explicitly for Desktop, whose cwd is unpredictable).
`HAR_RECORDER_HEADLESS=1` forces headless mode (handy for CI/tests).

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
| `guide` | Shows the recommended steps (start → navigate → checkpoint → stop/analyze → close). |
| `start-recording` | Starts a recording (optional `site`, `label`). |
| `mark-checkpoint` | Marks a checkpoint (`label`). |
| `stop-and-analyze` | Stops capture and reconstructs where you went. |
| `close-browser` | Closes Chrome — saves the HAR first if a recording is still active. |

> ⚠️ Closing the browser while a recording is still **active** discards the unsaved
> capture (the HAR is never assembled). The `close-browser` and `guide` prompts
> enforce `stop_recording` **before** `close_browser`, so nothing is lost.

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
│   ├── 2026-06-22_..._dashboard.zip   # deliverable package (split into .zip.001… if >20 MB)
│   ├── metadata.json
│   ├── summary.md           # reconstruction guide
│   └── cookies.json         # full cookie jar (incl. http-only)
└── .chrome-profile/         # persistent profile (logins kept)
```

### Large bundles (transfer split)

A full HAR can be large. If the `.zip` exceeds **20 MB** (a common upload cap),
`stop_recording` also writes it as numbered parts — `<name>.zip.001`,
`<name>.zip.002`, … each ≤ 20 MB — and returns a `transfer` block listing them
plus the rejoin command. Send **all** parts, then reconstruct **before** opening
the HAR:

```bash
cat <name>.zip.*  > <name>.zip      # rejoin in numeric order
unzip <name>.zip                    # extracts session.har and the rest
```

Windows (PowerShell): `cmd /c copy /b <name>.zip.001+<name>.zip.002 <name>.zip`.
`summary.md` carries the same steps; the single `.zip` is kept too for local use.

## ⚠️ Security

`.recording/` contains **live session tokens and cookies**. It is already in
`.gitignore`. Don't share the zips. Use `profile: "fresh"` for isolated captures.

## Available tools

| Tool | Description |
|------|-------------|
| `start_recording` | Opens Chrome headful (or attaches via `attachToPort`) and starts complete CDP capture of every target. `{ url?, label?, profile?, captureBodies?, channel?, attachToPort? }` |
| `get_session_status` | Live status (duration, request count, pages, checkpoints). `{ recordingId? }` |
| `mark_checkpoint` | Marks a step (e.g. "login done"). `{ label, recordingId? }` |
| `stop_recording` | Assembles HAR + zip + summary + cookie jar; splits the zip into ≤20 MB parts (`.zip.001…`) when it is large and returns a `transfer` block to rejoin them. `{ recordingId? }` |
| `list_recordings` | Lists known recordings. |
| `list_requests` | Filterable summary list, without dumping the HAR. `{ recordingId, method?, status?, urlContains?, mimeType?, resourceType?, limit?, offset? }` |
| `get_request` | Full HAR entry for a request (WebSocket frames in `_webSocketMessages`). `{ recordingId, index? \| requestId? \| urlContains? }` |
| `get_cookies` | Cookie jar (http-only included), filterable by domain. `{ recordingId, domain? }` |
| `annotate_recording` | Adds a note (to metadata + summary). `{ recordingId, note }` |
| `close_browser` | Closes Chrome (and cleans up the `fresh` profile). `{ recordingId? }` |

## Web dashboard

A local web UI to **drive and inspect recordings** from the browser — a second
front-end alongside the MCP tools, built on the same engine.

```bash
npm run build
npm run ui          # serves http://127.0.0.1:4477 and opens it in your browser
```

**Control**

- **＋ Nuova registrazione** — start a capture (url, label, persistent/fresh
  profile, capture-bodies, plus advanced `channel` / `attachToPort`). Chrome opens
  and capture begins.
- **Live bar** — while a recording is active: live duration & request count, plus
  🚩 Checkpoint, ⏹ Stop & save (assembles the HAR), ✕ Close browser.

**Inspect** (live *or* on-disk)

- **Sidebar**: every recording (newest first, filterable); the active one is
  flagged `● REC`.
- **Overview**: metadata, hosts, checkpoints, notes, browser, bundle size.
- **Richieste**: filterable request table (method / status / type / url); click a
  row for the full HAR entry — headers, query, post-data, cookies, response body
  and WebSocket frames.
- **Cookie**: full jar (http-only included); values masked until you tick
  *mostra valori*.
- **Summary**: the recording's `summary.md`.

> The dashboard is a **separate process** from the MCP server, so it owns its own
> recording engine: it fully controls the sessions **it** launches; sessions
> started via MCP show up here only once stopped (read from `.recording/`). Run
> one capture at a time on the `persistent` profile (Chrome can't share it).

Binds to `127.0.0.1` only and refuses cross-origin POSTs — the recordings hold
live session tokens and the endpoint can launch a browser, so it must never be
reachable off loopback. Set `HAR_RECORDER_UI_PORT` to change the port,
`HAR_RECORDER_UI_NO_OPEN=1` to not auto-open the browser, and `HAR_RECORDER_ROOT`
to point it at a different `.recording/` location.

## Development

```bash
npm run build       # compile TypeScript → dist/
npm run dev         # watch mode
npm test            # smoke test (MCP tool surface) + bundle-split unit test (no browser)
npm run test:e2e    # headless e2e: http-only cookies + service worker + WebSocket frames
```
