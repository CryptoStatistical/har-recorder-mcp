"use strict";

// ---------------------------------------------------------------------------
// tiny DOM helpers — built with textContent so captured data is never injected
// as HTML (recordings can hold arbitrary response bodies / cookie values).
// ---------------------------------------------------------------------------
function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "dataset") Object.assign(node.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
  }
  for (const c of [].concat(children || [])) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}
const $ = (sel) => document.querySelector(sel);

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function fmtBytes(n) {
  if (n == null || n < 0) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString();
}
function fmtDur(ms) {
  if (ms == null) return "—";
  const s = ms / 1000;
  if (s < 1) return Math.round(ms) + " ms";
  if (s < 60) return s.toFixed(1) + " s";
  const m = Math.floor(s / 60);
  return m + "m " + Math.round(s % 60) + "s";
}
function statusClass(s) { return "status-" + Math.floor((s || 0) / 100); }
function hostOf(u) { try { return new URL(u).host; } catch (_) { return ""; } }

let toastTimer;
function toast(msg, kind) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (kind ? " " + kind : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const state = { recordings: [], selected: null, meta: null, loaded: {}, activeId: null };

// ===========================================================================
// recordings sidebar
// ===========================================================================
async function loadRecordings() {
  const list = $("#rec-list");
  try {
    const data = await getJSON("/api/recordings");
    state.recordings = data.recordings;
    state.activeId = data.activeRecordingId || null;
    $("#root-label").textContent = data.root || "";
    list.removeAttribute("aria-busy");
    renderRecordings();
  } catch (err) {
    list.innerHTML = "";
    list.appendChild(el("div", { class: "err", text: "Errore: " + err.message }));
  }
}

function renderRecordings() {
  const filter = ($("#rec-filter").value || "").toLowerCase();
  const list = $("#rec-list");
  list.innerHTML = "";
  const items = state.recordings.filter((r) =>
    !filter || (r.name + " " + (r.title || "") + " " + (r.host || "") + " " + (r.label || "")).toLowerCase().includes(filter)
  );
  if (!items.length) {
    list.appendChild(el("div", { class: "muted", text: "Nessuna registrazione." }));
    return;
  }
  for (const r of items) {
    const live = !!r.live;
    const item = el("div", {
      class: "rec-item" + (state.selected === r.recordingId ? " active" : "") + (live ? " live" : ""),
      dataset: { id: r.recordingId },
      onclick: () => selectRecording(r.recordingId),
    }, [
      live ? el("span", { class: "ri-live" }, [el("span", { class: "live-pulse" }), "REC"]) : null,
      el("div", { class: "ri-title", text: r.title || r.label || r.host || r.name }),
      el("div", { class: "ri-sub", text: (r.host || hostOf(r.url) || "—") + " · " + fmtDate(r.startedAt) }),
      el("div", { class: "ri-stats" }, [
        el("span", { text: (r.requestCount ?? 0) + " req" }),
        el("span", { text: (r.cookieCount ?? 0) + " cookie" }),
      ]),
    ]);
    list.appendChild(item);
  }
}

// ===========================================================================
// selection + overview (handles both on-disk metadata and live status shapes)
// ===========================================================================
function metaId(m) { return m.id || m.recordingId; }

async function selectRecording(id) {
  state.selected = id;
  state.loaded = {};
  clearRequestFilters();
  renderRecordings();
  $("#empty").hidden = true;
  $("#detail").hidden = false;
  activateTab("overview");

  try {
    state.meta = await getJSON("/api/recordings/" + encodeURIComponent(id));
  } catch (err) {
    $("#d-title").textContent = "Errore";
    $("#d-meta").textContent = err.message;
    return;
  }
  renderHeader();
  renderOverview();
  state.loaded.overview = true;
}

function renderHeader() {
  const m = state.meta;
  const host = m.host || hostOf(m.url || "");
  $("#d-title").textContent = m.title || m.label || host || m.url || metaId(m);
  $("#d-meta").textContent = (host || "") + "  ·  " + fmtDate(m.startedAt);

  const badges = $("#d-badges");
  badges.innerHTML = "";
  const add = (n) => badges.appendChild(n);
  if (m.live) add(el("span", { class: "badge rec" }, [el("b", { text: "● REC" })]));
  add(badgeKV("richieste", m.requestCount));
  if (m.cookieCount != null) add(badgeKV("cookie", m.cookieCount));
  if (m.httpOnlyCookieCount) add(badgeKV("http-only", m.httpOnlyCookieCount));
  add(badgeKV("durata", fmtDur(m.durationMs)));
  add(badgeKV("profilo", m.profile));
  if (m.zipBytes) add(badgeKV("zip", fmtBytes(m.zipBytes)));
  if (m.zipParts && m.zipParts.length) add(el("span", { class: "badge warn", text: "split ×" + m.zipParts.length }));
}
function badgeKV(k, v) { return el("span", { class: "badge" }, [k + " ", el("b", { text: String(v ?? "—") })]); }

function renderOverview() {
  const m = state.meta;
  const panel = $('.panel[data-panel="overview"]');
  panel.innerHTML = "";

  const cards = el("div", { class: "cards" }, [
    card("ID", metaId(m), true),
    card("URL iniziale", m.url || "—", true),
    card("Browser", m.browser ? m.browser.name + " " + m.browser.version : "—", true),
    card("Body catturati", m.captureBodies ? "sì" : "no"),
    card("Avviata", fmtDate(m.startedAt), true),
    card("Fermata", m.live ? "in corso…" : fmtDate(m.stoppedAt), true),
  ]);
  panel.appendChild(cards);

  if (m.live && m.lastRequestUrl) {
    panel.appendChild(section("Ultima richiesta", el("div", { class: "chips" }, el("span", { class: "chip", text: m.lastRequestUrl }))));
  }
  if (m.live && m.targets && m.targets.length) {
    panel.appendChild(section("Target attivi", el("div", { class: "chips" },
      m.targets.slice(0, 30).map((t) => el("span", { class: "chip", text: (t.type || "?") + ": " + (t.title || t.url || "—") })))));
  }
  if (m.hosts && m.hosts.length) {
    panel.appendChild(section("Host contattati", el("div", { class: "chips" }, m.hosts.slice(0, 40).map((h) => el("span", { class: "chip", text: h })))));
  }
  if (m.checkpoints && m.checkpoints.length) {
    panel.appendChild(section("Checkpoint", el("ul", { class: "ov-list" },
      m.checkpoints.map((c) => el("li", {}, [el("code", { text: c.at }), " — " + c.label])))));
  }
  if (m.titles && m.titles.length) {
    panel.appendChild(section("Titoli pagina", el("ul", { class: "ov-list" }, m.titles.slice(0, 20).map((t) => el("li", { text: t })))));
  }
  if (m.notes && m.notes.length) {
    panel.appendChild(section("Annotazioni", el("ul", { class: "ov-list" }, m.notes.map((n) => el("li", { text: n })))));
  }
}
function card(k, v, small) { return el("div", { class: "card" }, [el("div", { class: "k", text: k }), el("div", { class: "v" + (small ? " sm" : ""), text: String(v) })]); }
function section(title, body) { return el("div", { class: "ov-section" }, [el("h3", { text: title }), body]); }

// ===========================================================================
// tabs
// ===========================================================================
function activateTab(name) {
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.tab === name);
  for (const p of document.querySelectorAll(".panel")) p.classList.toggle("active", p.dataset.panel === name);
  if (name === "requests") $("#f-refresh").hidden = !(state.meta && state.meta.live);
  if (!state.selected || state.loaded[name]) return;
  if (name === "requests") loadRequests(true);
  else if (name === "cookies") loadCookies();
  else if (name === "summary") loadSummary();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => activateTab(t.dataset.tab)));

// ===========================================================================
// requests
// ===========================================================================
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function clearRequestFilters() {
  $("#f-status").value = ""; $("#f-url").value = "";
  $("#f-method").value = ""; $("#f-type").value = "";
  const tSel = $("#f-type");
  while (tSel.options.length > 1) tSel.remove(1); // rebuilt per recording
}

async function loadRequests(initial) {
  const body = $("#req-body");
  const params = new URLSearchParams();
  if ($("#f-method").value) params.set("method", $("#f-method").value);
  if ($("#f-status").value) params.set("status", $("#f-status").value);
  if ($("#f-type").value) params.set("resourceType", $("#f-type").value);
  if ($("#f-url").value.trim()) params.set("urlContains", $("#f-url").value.trim());
  params.set("limit", "1000");

  body.innerHTML = "";
  body.appendChild(el("tr", {}, el("td", { colspan: "7", class: "loading", text: "Carico…" })));
  try {
    const data = await getJSON("/api/recordings/" + encodeURIComponent(state.selected) + "/requests?" + params);
    if (initial) populateRequestFilters(data.requests);
    renderRequests(data);
    state.loaded.requests = true;
  } catch (err) {
    body.innerHTML = "";
    body.appendChild(el("tr", {}, el("td", { colspan: "7", class: "err", text: "Errore: " + err.message })));
  }
}

function populateRequestFilters(rows) {
  const mSel = $("#f-method");
  if (mSel.options.length <= 1) for (const m of METHODS) mSel.appendChild(el("option", { value: m, text: m }));
  const tSel = $("#f-type");
  if (tSel.options.length <= 1) {
    const types = [...new Set(rows.map((r) => r.resourceType).filter(Boolean))].sort();
    for (const t of types) tSel.appendChild(el("option", { value: t, text: t }));
  }
}

function renderRequests(data) {
  const body = $("#req-body");
  body.innerHTML = "";
  $("#req-count").textContent = data.matched + " / " + data.total + (data.matched > data.requests.length ? "  (mostrate " + data.requests.length + ")" : "");
  if (!data.requests.length) {
    body.appendChild(el("tr", {}, el("td", { colspan: "7", class: "muted", text: "Nessuna richiesta." })));
    return;
  }
  for (const r of data.requests) {
    const isWs = (r.resourceType || "").toLowerCase() === "websocket";
    const row = el("tr", { dataset: { index: r.index }, onclick: () => openRequest(r.index) }, [
      el("td", { class: "cell-mono", text: String(r.index) }),
      el("td", {}, el("span", { class: "method method-" + r.method, text: r.method })),
      el("td", {}, el("span", { class: statusClass(r.status), text: String(r.status || "—") })),
      el("td", {}, el("span", { class: "tag" + (isWs ? " ws" : ""), text: r.resourceType || "—" })),
      el("td", { class: "cell-mono", text: (r.mimeType || "—").split(";")[0] }),
      el("td", { class: "num", text: fmtBytes(r.responseBytes) }),
      el("td", { class: "cell-url", title: r.url, text: r.url }),
    ]);
    body.appendChild(row);
  }
}

$("#f-apply").addEventListener("click", () => loadRequests(false));
$("#f-refresh").addEventListener("click", () => loadRequests(false));
$("#f-url").addEventListener("keydown", (e) => { if (e.key === "Enter") loadRequests(false); });
$("#f-reset").addEventListener("click", () => {
  $("#f-method").value = ""; $("#f-status").value = ""; $("#f-type").value = ""; $("#f-url").value = "";
  loadRequests(false);
});

// ===========================================================================
// request detail drawer
// ===========================================================================
async function openRequest(index) {
  $("#drawer").hidden = false;
  $("#drawer-title").textContent = "Richiesta #" + index;
  const content = $("#drawer-content");
  content.innerHTML = "";
  content.appendChild(el("div", { class: "loading", text: "Carico…" }));
  try {
    const e = await getJSON("/api/recordings/" + encodeURIComponent(state.selected) + "/request?index=" + index);
    renderRequestDetail(e, index);
  } catch (err) {
    content.innerHTML = "";
    content.appendChild(el("div", { class: "err", text: "Errore: " + err.message }));
  }
}

function renderRequestDetail(e, index) {
  $("#drawer-title").textContent = "#" + index + "  " + e.request.method + "  " + (e.response.status || "");
  const content = $("#drawer-content");
  content.innerHTML = "";

  content.appendChild(kvSection("Generale", [
    ["URL", e.request.url],
    ["Metodo", e.request.method],
    ["Status", e.response.status + " " + (e.response.statusText || "")],
    ["Tipo", e._resourceType || "—"],
    ["Mime", e.response.content.mimeType || "—"],
    ["Remote IP", e.serverIPAddress || "—"],
    ["Da service worker", e._fromServiceWorker ? "sì" : "no"],
    ["Da cache", e._fromDiskCache ? "sì" : "no"],
    e._error ? ["Errore", e._error] : null,
  ]));

  if (e.request.queryString && e.request.queryString.length) {
    content.appendChild(kvSection("Query string", e.request.queryString.map((q) => [q.name, q.value])));
  }
  content.appendChild(headerSection("Header richiesta", e.request.headers));
  if (e.request.postData && e.request.postData.text != null) {
    content.appendChild(bodySection("POST data (" + (e.request.postData.mimeType || "") + ")", e.request.postData.text));
  }
  content.appendChild(headerSection("Header risposta", e.response.headers));

  if (e.request.cookies && e.request.cookies.length) {
    content.appendChild(kvSection("Cookie inviati", e.request.cookies.map((c) => [c.name, c.value])));
  }
  if (e.response.cookies && e.response.cookies.length) {
    content.appendChild(kvSection("Set-Cookie", e.response.cookies.map((c) => [c.name, c.value + (c.httpOnly ? "  (httpOnly)" : "")])));
  }

  if (e._webSocketMessages) {
    content.appendChild(wsSection(e._webSocketMessages, e._webSocketMessagesTruncated));
  } else {
    const c = e.response.content;
    if (c.text != null) {
      const isB64 = c.encoding === "base64";
      const preview = isB64 ? "(binario, base64 — " + fmtBytes(c.size) + ")" : c.text;
      const sect = bodySection("Body risposta (" + (c.mimeType || "").split(";")[0] + ")", preview.length > 50000 ? preview.slice(0, 50000) + "\n…(troncato)" : preview);
      if (e._bodyTruncated) sect.appendChild(el("p", { class: "hint", text: "Body troncato in cattura." }));
      content.appendChild(sect);
    } else {
      content.appendChild(kvSection("Body risposta", [["", "(nessun body catturato — " + fmtBytes(c.size) + ")"]]));
    }
  }
}

function kvSection(title, pairs) {
  const dl = el("dl", { class: "kv" });
  for (const p of pairs) {
    if (!p) continue;
    dl.appendChild(el("dt", { text: p[0] }));
    dl.appendChild(el("dd", { text: String(p[1] ?? "") }));
  }
  return el("div", { class: "kv-section" }, [el("h4", { text: title }), dl]);
}
function headerSection(title, headers) { return kvSection(title + " (" + (headers ? headers.length : 0) + ")", (headers || []).map((h) => [h.name, h.value])); }
function bodySection(title, text) { return el("div", { class: "kv-section" }, [el("h4", { text: title }), el("pre", { class: "body-box", text: text })]); }
function wsSection(frames, truncated) {
  const sect = el("div", { class: "kv-section" }, [el("h4", { text: "WebSocket — " + frames.length + " frame" })]);
  const box = el("pre", { class: "body-box" });
  box.textContent = frames.slice(0, 200).map((f) => {
    const dir = f.type === "send" || f.fromClient ? "→" : "←";
    const data = typeof f.data === "string" ? f.data : JSON.stringify(f.data);
    return dir + " " + (data.length > 400 ? data.slice(0, 400) + "…" : data);
  }).join("\n");
  sect.appendChild(box);
  if (truncated || frames.length > 200) sect.appendChild(el("p", { class: "hint", text: "Mostrati i primi " + Math.min(200, frames.length) + " frame." }));
  return sect;
}

for (const c of document.querySelectorAll("[data-close]")) c.addEventListener("click", () => ($("#drawer").hidden = true));

// ===========================================================================
// cookies
// ===========================================================================
async function loadCookies() {
  const body = $("#cookie-body");
  const domain = $("#c-domain").value.trim();
  body.innerHTML = "";
  body.appendChild(el("tr", {}, el("td", { colspan: "8", class: "loading", text: "Carico…" })));
  try {
    const q = domain ? "?domain=" + encodeURIComponent(domain) : "";
    const data = await getJSON("/api/recordings/" + encodeURIComponent(state.selected) + "/cookies" + q);
    renderCookies(data);
    state.loaded.cookies = true;
  } catch (err) {
    body.innerHTML = "";
    body.appendChild(el("tr", {}, el("td", { colspan: "8", class: "err", text: "Errore: " + err.message })));
  }
}

function renderCookies(data) {
  const body = $("#cookie-body");
  body.innerHTML = "";
  $("#cookie-count").textContent = data.total + " cookie · " + data.httpOnly + " http-only · " + data.secure + " secure";
  const reveal = $("#c-reveal").checked;
  if (!data.cookies.length) {
    body.appendChild(el("tr", {}, el("td", { colspan: "8", class: "muted", text: "Nessun cookie." })));
    return;
  }
  for (const c of data.cookies) {
    const val = reveal ? (c.value || "") : "•".repeat(Math.min(12, (c.value || "").length || 3));
    body.appendChild(el("tr", {}, [
      el("td", { class: "cell-mono", text: c.name }),
      el("td", { class: "cell-mono", text: c.domain || "—" }),
      el("td", { class: "cell-mono", text: c.path || "/" }),
      el("td", {}, boolCell(c.httpOnly)),
      el("td", {}, boolCell(c.secure)),
      el("td", { class: "cell-mono", text: c.sameSite || "—" }),
      el("td", { class: "cell-mono", text: c.expires || "session" }),
      el("td", { class: "val", title: reveal ? c.value : "", text: val }),
    ]));
  }
}
function boolCell(v) { return el("span", { class: v ? "yes" : "no", text: v ? "✓" : "—" }); }

$("#c-apply").addEventListener("click", loadCookies);
$("#c-domain").addEventListener("keydown", (e) => { if (e.key === "Enter") loadCookies(); });
$("#c-reveal").addEventListener("change", () => { if (state.loaded.cookies) loadCookies(); });

// ===========================================================================
// summary
// ===========================================================================
async function loadSummary() {
  const pre = $("#summary-pre");
  pre.textContent = "Carico…";
  if (state.meta && state.meta.live) { pre.textContent = "Il summary viene generato allo stop della registrazione."; return; }
  try {
    const res = await fetch("/api/recordings/" + encodeURIComponent(state.selected) + "/summary");
    pre.textContent = res.ok ? await res.text() : "summary.md non disponibile.";
    state.loaded.summary = true;
  } catch (err) {
    pre.textContent = "Errore: " + err.message;
  }
}

// ===========================================================================
// control: new recording modal
// ===========================================================================
function openModal() { $("#m-error").hidden = true; $("#modal").hidden = false; setTimeout(() => $("#m-url").focus(), 30); }
function closeModal() { $("#modal").hidden = true; }
$("#new-rec").addEventListener("click", openModal);
for (const c of document.querySelectorAll("[data-modal-close]")) c.addEventListener("click", closeModal);

$("#new-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = $("#m-submit");
  const errEl = $("#m-error");
  errEl.hidden = true;
  submit.disabled = true;
  const body = {
    url: $("#m-url").value.trim() || undefined,
    label: $("#m-label").value.trim() || undefined,
    profile: $("#m-profile").value,
    captureBodies: $("#m-bodies").checked,
  };
  const ch = $("#m-channel").value.trim();
  if (ch) body.channel = ch;
  const port = $("#m-port").value.trim();
  if (port) body.attachToPort = Number(port);
  try {
    const r = await postJSON("/api/recordings", body);
    closeModal();
    toast("Registrazione avviata — naviga nel browser aperto.", "ok");
    await refreshStatus();
    await loadRecordings();
    selectRecording(r.recordingId);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

// ===========================================================================
// control: live bar + status polling
// ===========================================================================
let lastActiveId = null;
async function refreshStatus() {
  let s;
  try { s = await getJSON("/api/status"); } catch (_) { return; }
  const active = s && s.status === "recording";
  const bar = $("#live-bar");
  if (active) {
    bar.hidden = false;
    state.activeId = s.recordingId;
    $("#live-host").textContent = hostOf(s.url || "") || s.label || s.recordingId;
    $("#live-sub").textContent = s.lastRequestUrl || s.url || "(in attesa di traffico…)";
    $("#live-reqs").textContent = s.requestCount ?? 0;
    $("#live-dur").textContent = fmtDur(s.durationMs);
  } else {
    bar.hidden = true;
    state.activeId = null;
  }
  const now = active ? s.recordingId : null;
  if (now !== lastActiveId) { lastActiveId = now; loadRecordings(); }
}

$("#lb-checkpoint").addEventListener("click", async () => {
  if (!state.activeId) return;
  const label = prompt("Etichetta checkpoint:", "login fatto");
  if (!label) return;
  try { await postJSON("/api/recordings/" + encodeURIComponent(state.activeId) + "/checkpoint", { label }); toast("Checkpoint segnato: " + label, "ok"); }
  catch (e) { toast(e.message, "err"); }
});

$("#lb-stop").addEventListener("click", async () => {
  if (!state.activeId) return;
  const id = state.activeId;
  $("#lb-stop").disabled = true;
  try {
    toast("Assemblo l'HAR…");
    const r = await postJSON("/api/recordings/" + encodeURIComponent(id) + "/stop", {});
    toast("Salvata: " + r.name + " — " + r.requestCount + " richieste.", "ok");
    await refreshStatus();
    await loadRecordings();
    selectRecording(r.recordingId);
  } catch (e) { toast(e.message, "err"); }
  finally { $("#lb-stop").disabled = false; }
});

$("#lb-close").addEventListener("click", async () => {
  if (!state.activeId) return;
  if (!confirm("Chiudere il browser?\nSe la registrazione è ancora attiva, la cattura non salvata va persa. Fai prima Stop & salva.")) return;
  try {
    await postJSON("/api/recordings/" + encodeURIComponent(state.activeId) + "/close", {});
    toast("Browser chiuso.", "ok");
    await refreshStatus();
    await loadRecordings();
  } catch (e) { toast(e.message, "err"); }
});

// ===========================================================================
// boot
// ===========================================================================
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  $("#drawer").hidden = true;
  closeModal();
});
$("#rec-filter").addEventListener("input", renderRecordings);

loadRecordings();
refreshStatus();
setInterval(refreshStatus, 2000);
