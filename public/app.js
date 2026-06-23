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
const state = { recordings: [], selected: null, meta: null, loaded: {}, activeId: null, openId: null };

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
    list.appendChild(el("div", { class: "err", text: "Error: " + err.message }));
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
    list.appendChild(el("div", { class: "muted", text: "No recordings." }));
    return;
  }
  for (const r of items) {
    const live = !!r.live;
    const niceName = r.title || r.label || r.host || r.name;
    const item = el("div", {
      class: "rec-item" + (state.selected === r.recordingId ? " active" : "") + (live ? " live" : ""),
      dataset: { id: r.recordingId },
      onclick: () => selectRecording(r.recordingId),
    }, [
      live
        ? el("span", { class: "ri-live" }, [el("span", { class: "live-pulse" }), "REC"])
        : el("button", { class: "ri-del", title: "Delete from disk", text: "Delete", onclick: (e) => { e.stopPropagation(); deleteRecording(r.recordingId, niceName); } }),
      el("div", { class: "ri-title", text: niceName }),
      el("div", { class: "ri-sub", text: (r.host || hostOf(r.url) || "—") + " · " + fmtDate(r.startedAt) }),
      el("div", { class: "ri-stats" }, [
        el("span", { text: (r.requestCount ?? 0) + " req" }),
        el("span", { text: (r.cookieCount ?? 0) + " cookies" }),
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
    $("#d-title").textContent = "Error";
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
  if (m.live) add(el("span", { class: "badge rec" }, [el("b", { text: "REC" })]));
  add(badgeKV("requests", m.requestCount));
  if (m.cookieCount != null) add(badgeKV("cookies", m.cookieCount));
  if (m.httpOnlyCookieCount) add(badgeKV("http-only", m.httpOnlyCookieCount));
  add(badgeKV("duration", fmtDur(m.durationMs)));
  add(badgeKV("profile", m.profile));
  if (m.zipBytes) add(badgeKV("zip", fmtBytes(m.zipBytes)));
  if (m.zipParts && m.zipParts.length) add(el("span", { class: "badge warn", text: "split x" + m.zipParts.length }));
  $("#d-delete").hidden = !!m.live; // can't delete a recording while it's still recording
  $("#d-claude").hidden = !!m.live; // files/handoff are only available once stopped
}
function badgeKV(k, v) { return el("span", { class: "badge" }, [k + " ", el("b", { text: String(v ?? "—") })]); }

function renderOverview() {
  const m = state.meta;
  const panel = $('.panel[data-panel="overview"]');
  panel.innerHTML = "";

  const cards = el("div", { class: "cards" }, [
    card("ID", metaId(m), true),
    card("Initial URL", m.url || "—", true),
    card("Browser", m.browser ? m.browser.name + " " + m.browser.version : "—", true),
    card("Response bodies", m.captureBodies ? "yes" : "no"),
    card("Started", fmtDate(m.startedAt), true),
    card("Stopped", m.live ? "in progress…" : fmtDate(m.stoppedAt), true),
  ]);
  panel.appendChild(cards);

  if (m.live && m.lastRequestUrl) {
    panel.appendChild(section("Last request", el("div", { class: "chips" }, el("span", { class: "chip", text: m.lastRequestUrl }))));
  }
  if (m.live && m.targets && m.targets.length) {
    panel.appendChild(section("Active targets", el("div", { class: "chips" },
      m.targets.slice(0, 30).map((t) => el("span", { class: "chip", text: (t.type || "?") + ": " + (t.title || t.url || "—") })))));
  }
  if (m.hosts && m.hosts.length) {
    panel.appendChild(section("Hosts contacted", el("div", { class: "chips" }, m.hosts.slice(0, 40).map((h) => el("span", { class: "chip", text: h })))));
  }
  if (m.checkpoints && m.checkpoints.length) {
    panel.appendChild(section("Checkpoints", el("ul", { class: "ov-list" },
      m.checkpoints.map((c) => el("li", {}, [el("code", { text: c.at }), " — " + c.label])))));
  }
  if (m.titles && m.titles.length) {
    panel.appendChild(section("Page titles", el("ul", { class: "ov-list" }, m.titles.slice(0, 20).map((t) => el("li", { text: t })))));
  }
  if (m.notes && m.notes.length) {
    panel.appendChild(section("Notes", el("ul", { class: "ov-list" }, m.notes.map((n) => el("li", { text: n })))));
  }
  if (!m.live) {
    const box = el("div", { class: "downloads", text: "Loading…" });
    panel.appendChild(section("Download", box));
    loadFiles(metaId(m), box);
  }
}

const KIND_LABEL = { zip: "Bundle (.zip)", part: "Split part", har: "HAR", "har.gz": "HAR (gzip)", cookies: "Cookies", summary: "Summary", metadata: "Metadata", other: "File" };

async function loadFiles(id, box) {
  try {
    const data = await getJSON("/api/recordings/" + encodeURIComponent(id) + "/files");
    box.textContent = "";
    if (!data.files.length) { box.appendChild(el("div", { class: "muted", text: "No files." })); return; }
    for (const f of data.files) {
      const href = "/api/recordings/" + encodeURIComponent(id) + "/file/" + encodeURIComponent(f.name);
      box.appendChild(el("div", { class: "dl-row" }, [
        el("span", { class: "dl-kind", text: KIND_LABEL[f.kind] || f.kind }),
        el("span", { class: "dl-name", title: f.name, text: f.name }),
        el("span", { class: "dl-size", text: fmtBytes(f.bytes) }),
        el("a", { class: "btn ghost sm", href, download: f.name, text: "Download" }),
      ]));
    }
    if (data.files.some((f) => f.kind === "part")) {
      box.appendChild(el("p", { class: "hint", text: "Split parts (≤20 MB each) are meant for uploading to Claude; rejoin them before opening the HAR. Use \"Send to Claude\" for the ready prompt." }));
    }
  } catch (err) {
    box.textContent = "";
    box.appendChild(el("div", { class: "err", text: "Error: " + err.message }));
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
  body.appendChild(el("tr", {}, el("td", { colspan: "7", class: "loading", text: "Loading…" })));
  try {
    const data = await getJSON("/api/recordings/" + encodeURIComponent(state.selected) + "/requests?" + params);
    if (initial) populateRequestFilters(data.requests);
    renderRequests(data);
    state.loaded.requests = true;
  } catch (err) {
    body.innerHTML = "";
    body.appendChild(el("tr", {}, el("td", { colspan: "7", class: "err", text: "Error: " + err.message })));
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
  $("#req-count").textContent = data.matched + " / " + data.total + (data.matched > data.requests.length ? "  (showing " + data.requests.length + ")" : "");
  if (!data.requests.length) {
    body.appendChild(el("tr", {}, el("td", { colspan: "7", class: "muted", text: "No requests." })));
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
  $("#drawer-title").textContent = "Request #" + index;
  const content = $("#drawer-content");
  content.innerHTML = "";
  content.appendChild(el("div", { class: "loading", text: "Loading…" }));
  try {
    const e = await getJSON("/api/recordings/" + encodeURIComponent(state.selected) + "/request?index=" + index);
    renderRequestDetail(e, index);
  } catch (err) {
    content.innerHTML = "";
    content.appendChild(el("div", { class: "err", text: "Error: " + err.message }));
  }
}

function renderRequestDetail(e, index) {
  $("#drawer-title").textContent = "#" + index + "  " + e.request.method + "  " + (e.response.status || "");
  const content = $("#drawer-content");
  content.innerHTML = "";

  content.appendChild(kvSection("General", [
    ["URL", e.request.url],
    ["Method", e.request.method],
    ["Status", e.response.status + " " + (e.response.statusText || "")],
    ["Type", e._resourceType || "—"],
    ["Mime", e.response.content.mimeType || "—"],
    ["Remote IP", e.serverIPAddress || "—"],
    ["From service worker", e._fromServiceWorker ? "yes" : "no"],
    ["From cache", e._fromDiskCache ? "yes" : "no"],
    e._error ? ["Error", e._error] : null,
  ]));

  if (e.request.queryString && e.request.queryString.length) {
    content.appendChild(kvSection("Query string", e.request.queryString.map((q) => [q.name, q.value])));
  }
  content.appendChild(headerSection("Request headers", e.request.headers));
  if (e.request.postData && e.request.postData.text != null) {
    content.appendChild(bodySection("POST data (" + (e.request.postData.mimeType || "") + ")", e.request.postData.text));
  }
  content.appendChild(headerSection("Response headers", e.response.headers));

  if (e.request.cookies && e.request.cookies.length) {
    content.appendChild(kvSection("Cookies sent", e.request.cookies.map((c) => [c.name, c.value])));
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
      const preview = isB64 ? "(binary, base64 — " + fmtBytes(c.size) + ")" : c.text;
      const sect = bodySection("Response body (" + (c.mimeType || "").split(";")[0] + ")", preview.length > 50000 ? preview.slice(0, 50000) + "\n…(truncated)" : preview);
      if (e._bodyTruncated) sect.appendChild(el("p", { class: "hint", text: "Body truncated at capture." }));
      content.appendChild(sect);
    } else {
      content.appendChild(kvSection("Response body", [["", "(no body captured — " + fmtBytes(c.size) + ")"]]));
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
  const sect = el("div", { class: "kv-section" }, [el("h4", { text: "WebSocket — " + frames.length + " frames" })]);
  const box = el("pre", { class: "body-box" });
  box.textContent = frames.slice(0, 200).map((f) => {
    const dir = f.type === "send" || f.fromClient ? "->" : "<-";
    const data = typeof f.data === "string" ? f.data : JSON.stringify(f.data);
    return dir + " " + (data.length > 400 ? data.slice(0, 400) + "…" : data);
  }).join("\n");
  sect.appendChild(box);
  if (truncated || frames.length > 200) sect.appendChild(el("p", { class: "hint", text: "Showing the first " + Math.min(200, frames.length) + " frames." }));
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
  body.appendChild(el("tr", {}, el("td", { colspan: "8", class: "loading", text: "Loading…" })));
  try {
    const q = domain ? "?domain=" + encodeURIComponent(domain) : "";
    const data = await getJSON("/api/recordings/" + encodeURIComponent(state.selected) + "/cookies" + q);
    renderCookies(data);
    state.loaded.cookies = true;
  } catch (err) {
    body.innerHTML = "";
    body.appendChild(el("tr", {}, el("td", { colspan: "8", class: "err", text: "Error: " + err.message })));
  }
}

function renderCookies(data) {
  const body = $("#cookie-body");
  body.innerHTML = "";
  $("#cookie-count").textContent = data.total + " cookies · " + data.httpOnly + " http-only · " + data.secure + " secure";
  const reveal = $("#c-reveal").checked;
  if (!data.cookies.length) {
    body.appendChild(el("tr", {}, el("td", { colspan: "8", class: "muted", text: "No cookies." })));
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
function boolCell(v) { return el("span", { class: v ? "yes" : "no", text: v ? "yes" : "—" }); }

$("#c-apply").addEventListener("click", loadCookies);
$("#c-domain").addEventListener("keydown", (e) => { if (e.key === "Enter") loadCookies(); });
$("#c-reveal").addEventListener("change", () => { if (state.loaded.cookies) loadCookies(); });

// ===========================================================================
// summary
// ===========================================================================
async function loadSummary() {
  const pre = $("#summary-pre");
  pre.textContent = "Loading…";
  if (state.meta && state.meta.live) { pre.textContent = "The summary is generated when the recording is stopped."; return; }
  try {
    const res = await fetch("/api/recordings/" + encodeURIComponent(state.selected) + "/summary");
    pre.textContent = res.ok ? await res.text() : "summary.md not available.";
    state.loaded.summary = true;
  } catch (err) {
    pre.textContent = "Error: " + err.message;
  }
}

// ===========================================================================
// control: delete a recording from disk
// ===========================================================================
async function deleteRecording(id, name) {
  if (!confirm("Permanently delete from disk?\n\n" + (name || id) + "\n\nThis removes the HAR, cookies, summary and zip. It cannot be undone.")) return;
  try {
    await postJSON("/api/recordings/" + encodeURIComponent(id) + "/delete", {});
    toast("Recording deleted.", "ok");
    if (state.selected === id) {
      state.selected = null;
      state.meta = null;
      $("#detail").hidden = true;
      $("#empty").hidden = false;
    }
    await loadRecordings();
  } catch (e) {
    toast(e.message, "err");
  }
}
$("#d-delete").addEventListener("click", () => {
  if (!state.selected || (state.meta && state.meta.live)) return;
  deleteRecording(state.selected, state.meta ? (state.meta.title || state.meta.label || state.meta.host || metaId(state.meta)) : state.selected);
});

// ===========================================================================
// control: send to Claude (continuation prompt + split parts to attach)
// ===========================================================================
function closeClaude() { $("#claude-modal").hidden = true; }
for (const c of document.querySelectorAll("[data-claude-close]")) c.addEventListener("click", closeClaude);

async function sendToClaude() {
  if (!state.selected || (state.meta && state.meta.live)) return;
  const id = state.selected;
  try {
    const data = await getJSON("/api/recordings/" + encodeURIComponent(id) + "/claude-prompt");
    $("#claude-prompt").value = data.prompt;
    const parts = $("#claude-parts");
    parts.textContent = "";
    if (data.split && data.parts.length) {
      parts.appendChild(el("h4", { class: "parts-h", text: "Attach these parts to Claude (≤20 MB each)" }));
      for (const name of data.parts) {
        const href = "/api/recordings/" + encodeURIComponent(id) + "/file/" + encodeURIComponent(name);
        parts.appendChild(el("div", { class: "dl-row" }, [
          el("span", { class: "dl-name", title: name, text: name }),
          el("a", { class: "btn ghost sm", href, download: name, text: "Download" }),
        ]));
      }
      if (data.reconstruct) parts.appendChild(el("p", { class: "hint", text: "Rejoin before opening: " + data.reconstruct }));
    } else {
      parts.appendChild(el("p", { class: "hint", text: "Small recording — Claude can read it directly at the path in the prompt, or use the har-recorder MCP tools." }));
    }
    $("#claude-modal").hidden = false;
  } catch (err) {
    toast(err.message, "err");
  }
}
$("#d-claude").addEventListener("click", sendToClaude);

$("#claude-copy").addEventListener("click", async () => {
  const text = $("#claude-prompt").value;
  try {
    await navigator.clipboard.writeText(text);
    toast("Prompt copied to clipboard.", "ok");
  } catch (_) {
    // fallback: select the textarea so the user can copy manually
    const ta = $("#claude-prompt");
    ta.focus();
    ta.select();
    toast("Press Cmd/Ctrl+C to copy.", "ok");
  }
});

// ===========================================================================
// control: live bar + status polling
// ===========================================================================
let lastActiveId = null;
async function refreshStatus() {
  let s;
  try { s = await getJSON("/api/status"); } catch (_) { return; }
  const recording = !!s && s.status === "recording";
  // After Stop the session lingers in memory with the browser still open — keep a
  // calm bar so there is always a way to close that window from the UI.
  const stoppedOpen = !!s && s.status === "stopped" && s.browserOpen;
  const bar = $("#live-bar");

  if (recording || stoppedOpen) {
    bar.hidden = false;
    bar.classList.toggle("open", !recording);
    $("#live-pulse").classList.toggle("static", !recording);
    state.activeId = recording ? s.recordingId : null; // only set while truly recording
    state.openId = s.recordingId; // session held in memory (closeable)
    const host = hostOf(s.url || "") || s.label || s.recordingId;
    $("#live-host").textContent = recording ? host : "Browser still open · " + host;
    $("#live-sub").textContent = recording
      ? (s.lastRequestUrl || s.url || "(waiting for traffic…)")
      : "Recording saved — close the browser when you're done.";
    $("#live-stats").hidden = !recording;
    $("#live-reqs").textContent = s.requestCount ?? 0;
    $("#live-dur").textContent = fmtDur(s.durationMs);
    $("#lb-checkpoint").hidden = !recording;
    $("#lb-stop").hidden = !recording;
  } else {
    bar.hidden = true;
    state.activeId = null;
    state.openId = null;
  }
  const now = recording ? s.recordingId : null;
  if (now !== lastActiveId) { lastActiveId = now; loadRecordings(); }
}

$("#lb-checkpoint").addEventListener("click", async () => {
  if (!state.activeId) return;
  const label = prompt("Checkpoint label:", "login done");
  if (!label) return;
  try { await postJSON("/api/recordings/" + encodeURIComponent(state.activeId) + "/checkpoint", { label }); toast("Checkpoint marked: " + label, "ok"); }
  catch (e) { toast(e.message, "err"); }
});

$("#lb-stop").addEventListener("click", async () => {
  if (!state.activeId) return;
  const id = state.activeId;
  $("#lb-stop").disabled = true;
  try {
    toast("Assembling the HAR…");
    const r = await postJSON("/api/recordings/" + encodeURIComponent(id) + "/stop", {});
    toast("Saved: " + r.name + " — " + r.requestCount + " requests.", "ok");
    await refreshStatus();
    await loadRecordings();
    selectRecording(r.recordingId);
  } catch (e) { toast(e.message, "err"); }
  finally { $("#lb-stop").disabled = false; }
});

$("#lb-close").addEventListener("click", async () => {
  const id = state.openId;
  if (!id) return;
  // Only warn when a capture is still running (closing would discard it).
  if (state.activeId === id && !confirm("Close the browser?\nThe recording is still active — the unsaved capture will be lost. Use Stop & save first.")) return;
  try {
    await postJSON("/api/recordings/" + encodeURIComponent(id) + "/close", {});
    toast("Browser closed.", "ok");
    await refreshStatus();
    await loadRecordings();
  } catch (e) { toast(e.message, "err"); }
});

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
    toast("Recording started — browse in the opened browser.", "ok");
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
// boot
// ===========================================================================
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  $("#drawer").hidden = true;
  closeModal();
  closeClaude();
});
$("#rec-filter").addEventListener("input", renderRecordings);

loadRecordings();
refreshStatus();
setInterval(refreshStatus, 2000);
