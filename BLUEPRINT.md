# BLUEPRINT — HAR Recorder MCP

Documento di architettura e decisioni tecniche. Il README copre l'uso; qui sta il
**perché** e il **come**.

## 1. Problema

Gli HAR exporter comuni (estensioni "Save as HAR", DevTools export, librerie HAR)
perdono pezzi che servono per **ricostruire una sessione autenticata**:

1. **Cookie http-only mancanti** — Chrome rimuove gli header sensibili
   (`Cookie` in richiesta, `Set-Cookie` in risposta) dagli eventi di rete
   "normali". Un exporter che ascolta solo `Network.requestWillBeSent` /
   `Network.responseReceived` non li vede.
2. **Recording che non parte** — molti tool catturano solo dopo che la pagina è
   già caricata, perdendo la prima navigazione (spesso il redirect di login/SSO).
3. **Fetch dei service worker assenti** — il traffico originato dal service
   worker (e da iframe out-of-process, worker dedicati) vive in target separati.

Obiettivo: un MCP server che apre un **Chrome reale headful**, lascia che sia
**l'utente** a navigare e fare login, e produce un HAR **completo di tutto**.

## 2. Decisione di fondo: Playwright per pilotare, CDP raw per catturare

| | Scelta | Perché |
|---|---|---|
| Avvio / lifecycle browser | **Playwright** `launchPersistentContext` (o `connectOverCDP` in attach) | Chrome headful robusto, profilo persistente (login conservati), popup, download, navigazione. |
| Cattura di rete | **CDP raw a livello browser** (WebSocket diretto) | Unico modo per (a) gli header raw con http-only e (b) l'auto-attach *flatten* a TUTTI i target. L'astrazione per-pagina di Playwright non espone il routing per `sessionId`. |

Playwright lancia Chrome con `--remote-debugging-port=0`; leggiamo l'endpoint da
`<userDataDir>/DevToolsActivePort` e ci colleghiamo con un client CDP raw
(`src/cdp.ts`, `RawCdp`) che parla il protocollo *flatten* — eventi con
`sessionId`, comandi instradabili a una sessione figlia. Pipe di Playwright e
porta TCP coesistono senza conflitti.

## 3. Cookie http-only via eventi `*ExtraInfo`

Chrome instrada gli header sensibili **solo** in due eventi dedicati:

- `Network.requestWillBeSentExtraInfo` → header `Cookie` reale + `associatedCookies`
  (tutti i cookie inviati, http-only inclusi).
- `Network.responseReceivedExtraInfo` → header raw di risposta, **`Set-Cookie`
  compreso** (http-only inclusi).

Il recorder fonde questi con gli eventi normali per `requestId`. Gli eventi
arrivano in **qualunque ordine**: ogni entry è un accumulatore in una `Map`,
completata su `loadingFinished`/`loadingFailed`. I redirect (stesso `requestId`,
campo `redirectResponse`) diventano entry distinte.

## 4. Catturare TUTTO: auto-attach flatten a livello browser

Sul client CDP raw (`CdpCaptureCoordinator`):

```
Target.setAutoAttach({autoAttach:true, waitForDebuggerOnStart:true, flatten:true})
```

a livello browser. Per ogni `Target.attachedToTarget` (page, iframe,
service_worker, worker, shared_worker):

1. `attachCapture(sessionFacade(sessionId))` — wiring degli eventi `Network.*`;
2. registra i listener `attachedToTarget`/`targetInfoChanged` **anche su quella
   sessione** (vedi gotcha sotto);
3. `Network.enable` + `Target.setAutoAttach` ricorsivo sulla sessione;
4. `Runtime.runIfWaitingForDebugger` per rilasciare il target.

Due gotcha che sono costati sangue e che il codice documenta:

- **Deadlock del debugger.** Un target appena creato è *in pausa*
  (`waitForDebuggerOnStart`); Chrome non risponde a `Network.enable` finché non lo
  rilasci. Quindi i comandi sono **fire-and-forget**: l'ordine FIFO per-sessione
  garantisce che `Network.enable` sia processato prima dell'esecuzione del target,
  senza attendere (un `await Network.enable` prima del release ⇒ deadlock).
- **I listener devono ricorrere come `setAutoAttach`.** L'`attachedToTarget` di un
  target figlio (es. un service worker agganciato come figlio della pagina) arriva
  **sulla sessione del genitore**, non a livello browser. Se ascolti solo a
  livello browser, non rilasci quella sessione del SW → il SW resta in pausa
  (attende il release di *tutte* le sue sessioni) → non esegue mai → niente fetch.
  Perciò registriamo i listener `attachedToTarget` su **ogni** sessione.

**Dedup.** Un service worker si aggancia spesso su due sessioni (browser-level +
figlio-pagina) e ne emette gli eventi su entrambe. Usiamo `pageId = targetId`
come namespace delle entry: gli eventi duplicati delle due sessioni
**confluiscono nella stessa entry** invece di raddoppiare.

## 5. "Parte da subito"

`coordinator.start()` (auto-attach) e `Network.enable` sulla prima pagina
avvengono **prima** di `page.goto(url)`; `waitForFirstPage()` lo assicura. Il
primo redirect di login non si perde.

## 6. Modalità attach (registrare senza lanciare)

`start_recording({ attachToPort })` non lancia un browser: si collega a un Chrome
**già avviato dall'utente** con `--remote-debugging-port=PORT`, via
`connectOverCDP` (controllo Playwright) + `RawCdp` sullo stesso endpoint
(`/json/version` → `webSocketDebuggerUrl`). `close_browser` in questo caso
**disconnette** senza chiudere il browser dell'utente.

## 7. Naming, stop, query

- **Naming** (`src/naming.ts`): `<ts>__<host>__<label/checkpoint…>__<titolo>`,
  es. `2026-06-22_143052__fineco-it__login__dashboard`.
- **Stop**: `Network.getAllCookies` (jar completo http-only) → `buildHar` (HAR 1.2,
  timings CDP→HAR) → naming (titoli letti live da Playwright) → `summary.md` →
  `writeArtifacts` (har/.gz/.zip/metadata/cookies) → `index.json`. Il browser
  resta aperto.
- **Query** (`list_requests`/`get_request`/`get_cookies`): operano su un HAR
  costruito (snapshot live se attivo, altrimenti riletto da disco) — Claude
  ispeziona migliaia di richieste senza versare l'HAR nel contesto.

## 8. Struttura del codice

```
src/
├── index.ts      # entry MCP: registra i 10 tool (stdio)
├── config.ts     # root, path .recording/, profilo, limiti
├── log.ts        # log su stderr (stdout riservato a JSON-RPC)
├── cdp.ts        # RawCdp (WebSocket flatten) + CdpCaptureCoordinator (auto-attach)
├── capture.ts    # CaptureStore + wiring eventi CDP Network.* (incl. ExtraInfo)
├── har.ts        # tipi HAR, build HAR, timings CDP→HAR, parsing cookie, query
├── naming.ts     # slug + nome descrittivo
├── storage.ts    # index.json, packaging (gz/zip), metadata, summary.md
└── manager.ts    # RecordingManager: lifecycle Playwright + orchestrazione
test/
├── smoke.mjs     # boot del server, superficie dei 10 tool (no browser)
└── e2e.mjs       # http-only + SERVICE WORKER + WEBSOCKET end-to-end (headless, server locale)
```

## 9. Sicurezza

- `.recording/` è in `.gitignore`: contiene **cookie/token vivi**.
- Profilo `fresh` ⇒ `userDataDir` temporaneo, rimosso a `close_browser`.
- Body cap a `MAX_BODY_BYTES` (12 MB); le entry troncate sono marcate
  `_bodyTruncated`.

## 10. Limitazioni note / roadmap

- **WebSocket**: handshake **e** frame dei messaggi catturati via
  `Network.webSocketFrame*`, salvati per entry in `_webSocketMessages`
  (convenzione Chrome DevTools). Cap a `MAX_WS_FRAMES` (5000) e
  `MAX_WS_FRAME_BYTES` (64 KB per frame); l'eccesso è marcato
  `_webSocketMessagesTruncated`.
- **Una sessione browser viva alla volta** (il profilo persistente ha un lock
  singolo). `start` chiude un eventuale browser rimasto aperto da uno stop.
- **Conteggio byte SW duplicato (lieve)**: se un SW emette `dataReceived` su due
  sessioni, i byte possono sommarsi; l'identità della richiesta resta corretta
  (merge per `targetId`+`requestId`).
- **Modalità attach**: richiede che l'utente avvii Chrome con
  `--remote-debugging-port`; non si può agganciare un Chrome "normale" già aperto
  senza quel flag.
