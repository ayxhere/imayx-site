"use strict";
/* AyX Group Admin SPA — all data comes from the real API at API_BASE.
   Auth: HttpOnly session cookie (ayx_admin) + X-CSRF-Token header.
   The CSRF token is kept in memory with a sessionStorage fallback; nothing
   sensitive is ever written to localStorage. All user content is rendered via
   textContent/DOM building — never innerHTML with untrusted data. */

const API_BASE = "https://api.imayx.in/v1";
const CSRF_KEY = "ayx_csrf_token";

let csrfToken = null;
try { csrfToken = sessionStorage.getItem(CSRF_KEY); } catch (e) { /* storage unavailable */ }

function setCsrf(token) {
  csrfToken = token || null;
  try {
    if (token) sessionStorage.setItem(CSRF_KEY, token);
    else sessionStorage.removeItem(CSRF_KEY);
  } catch (e) { /* storage unavailable */ }
}

/* ---------------- errors ---------------- */
class ApiError extends Error {
  constructor(status, code, message, data) {
    super(message || ("Request failed (" + status + ")"));
    this.name = "ApiError";
    this.status = status;
    this.code = code || null;
    this.data = data || null; // raw parsed body, e.g. lockout retry_after_seconds
  }
}
class AuthError extends Error {
  constructor() { super("Not authenticated"); this.name = "AuthError"; }
}

/* ---------------- tiny DOM kit (XSS-safe: textContent only) ---------------- */
function $(sel, root) { return (root || document).querySelector(sel); }

function el(tag, attrs) {
  const node = document.createElement(tag);
  const kids = Array.prototype.slice.call(arguments, 2);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const val = attrs[key];
      if (val == null || val === false) continue;
      if (key === "text") node.textContent = val;
      else if (key === "class") node.className = val;
      else if (key.slice(0, 2) === "on" && typeof val === "function") {
        node.addEventListener(key.slice(2), val);
      } else if (key === "html") {
        throw new Error("innerHTML is not allowed for dynamic content");
      } else node.setAttribute(key, val);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString();
}
function fmtBytes(n) {
  if (n == null || isNaN(n)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = Number(n), i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + " " + units[i];
}
function shortId(id) {
  if (!id) return "—";
  const s = String(id);
  return s.length > 18 ? s.slice(0, 10) + "…" + s.slice(-6) : s;
}

/* ---------------- toast ---------------- */
function toast(msg, kind) {
  const root = $("#toast-root");
  const t = el("div", { class: "toast " + (kind || "info"), text: msg, role: "status" });
  root.append(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 320); }, 3600);
}

/* ---------------- modal ---------------- */
function openModal(wide) {
  const overlay = el("div", { class: "modal-overlay" });
  const box = el("div", { class: "modal" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true" });
  overlay.append(box);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  }
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);
  $("#modal-root").append(overlay);
  return { overlay, box, close };
}

function confirmDialog(opts) {
  return new Promise((resolve) => {
    const { box, close } = openModal(false);
    box.append(
      el("h3", { class: "modal-title", text: opts.title || "Are you sure?" }),
      el("p", { class: "modal-body muted", text: opts.body || "This action cannot be undone." })
    );
    const row = el("div", { class: "modal-actions" });
    const cancelBtn = el("button", {
      class: "btn", text: "Cancel",
      onclick: () => { close(); resolve(false); }
    });
    const okBtn = el("button", {
      class: "btn " + (opts.danger === false ? "primary" : "danger"),
      text: opts.confirmText || "Delete",
      onclick: () => { close(); resolve(true); }
    });
    row.append(cancelBtn, okBtn);
    box.append(row);
    okBtn.focus();
  });
}

/* ---------------- API client ---------------- */
async function api(path, opts) {
  opts = opts || {};
  const method = (opts.method || "GET").toUpperCase();
  const headers = {};
  let body;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    body = opts.form; // FormData — browser sets the multipart boundary
  }
  if (csrfToken && method !== "GET" && method !== "HEAD") {
    headers["X-CSRF-Token"] = csrfToken;
  }
  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body, credentials: "include" });
  } catch (e) {
    throw new Error("Could not reach the API at " + API_BASE + ". Check your connection and that api.imayx.in is reachable.");
  }
  if (res.status === 401 && !opts.allow401) throw new AuthError();
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!res.ok) {
    const err = (data && data.error) || {};
    let message = err.message || ("Request failed (HTTP " + res.status + ")");
    if (res.status === 429) message = "Too many requests — please wait a moment and try again.";
    else if (res.status === 403 && err.code === "csrf_mismatch") message = "Security token mismatch. Please sign in again.";
    throw new ApiError(res.status, err.code || null, message, data);
  }
  return data;
}

/* Authenticated binary fetch (media previews) — cookies ride along via credentials:include */
async function apiBlob(path) {
  let res;
  try {
    res = await fetch(API_BASE + path, { credentials: "include" });
  } catch (e) {
    throw new Error("Could not reach the API.");
  }
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new ApiError(res.status, null, "Media request failed (HTTP " + res.status + ")");
  return await res.blob();
}

/* ---------------- view states ---------------- */
function viewLoading(root, label) {
  root.replaceChildren(el("div", { class: "state" },
    el("div", { class: "big", text: "⏳" }),
    el("div", { text: label || "Loading…" })));
}
function viewError(root, err, retry) {
  const msg = err instanceof Error ? err.message : String(err);
  const box = el("div", { class: "state" },
    el("div", { class: "big", text: "⚠️" }),
    el("div", { text: "Something went wrong." }),
    el("div", { class: "muted", text: msg }));
  if (retry) box.append(el("button", { class: "btn", text: "Retry", onclick: retry }));
  root.replaceChildren(box);
}
function viewEmpty(root, icon, text) {
  root.replaceChildren(el("div", { class: "state" },
    el("div", { class: "big", text: icon || "📭" }),
    el("div", { text: text || "Nothing here yet." })));
}

function badge(text, kind) {
  return el("span", { class: "badge " + (kind || "info"), text: text });
}
function statusBadge(status) {
  const map = {
    draft: "draft", scheduled: "scheduled", published: "published", archived: "archived",
    pending: "pending", resolved: "resolved", spam: "spam",
    active: "active", revoked: "revoked"
  };
  const label = status ? String(status) : "—";
  return badge(label, map[label] || "info");
}

function pager(meta, onGo) {
  meta = meta || {};
  const page = Number(meta.page) || 1;
  const per = Number(meta.per_page) || 20;
  const total = Number(meta.total) || 0;
  const pages = Math.max(1, Math.ceil(total / per));
  const wrap = el("div", { class: "pager" });
  wrap.append(el("span", { text: "Page " + page + " of " + pages + " · " + total + " total" }));
  const prev = el("button", { class: "btn small", text: "← Prev", disabled: page <= 1, onclick: () => onGo(page - 1) });
  const next = el("button", { class: "btn small", text: "Next →", disabled: page >= pages, onclick: () => onGo(page + 1) });
  wrap.append(prev, next);
  return wrap;
}

function dataTable(headers, rows) {
  const table = el("table");
  const thead = el("thead");
  const hr = el("tr");
  headers.forEach((h) => hr.append(el("th", { text: h })));
  thead.append(hr);
  const tbody = el("tbody");
  rows.forEach((cells) => {
    const tr = el("tr");
    cells.forEach((c) => {
      const td = el("td");
      if (c instanceof Node) td.append(c);
      else td.textContent = c == null ? "—" : String(c);
      tr.append(td);
    });
    tbody.append(tr);
  });
  table.append(thead, tbody);
  return el("div", { class: "table-wrap" }, table);
}

/* ---------------- shell / routing ---------------- */
const TITLES = {
  overview: "Overview", announcements: "Announcements", push: "Push",
  status: "Statuses", inbox: "Inbox", installations: "Installations",
  media: "Media", audit: "Audit logs", security: "Security"
};
const ROUTES = {}; // filled below by view renderers
let renderSeq = 0;

function currentRoute() {
  const h = (location.hash || "").replace(/^#\/?/, "").split("?")[0];
  return TITLES[h] ? h : "overview";
}

function render() {
  const seq = ++renderSeq;
  const route = currentRoute();
  $("#page-title").textContent = TITLES[route];
  document.querySelectorAll("#side-nav a").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("data-route") === route);
  });
  closeSidebar();
  const root = $("#view");
  const fn = ROUTES[route];
  if (!fn) { viewError(root, new Error("Unknown view."), () => render()); return; }
  Promise.resolve()
    .then(() => fn(root, seq))
    .catch((err) => {
      if (seq !== renderSeq) return; // a newer render took over
      if (err instanceof AuthError) { toLogin(); return; }
      viewError(root, err, () => render());
    });
}

function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#scrim").classList.remove("on");
}

/* ---------------- auth screens ---------------- */
let totpChallenge = null; // short-lived login challenge, memory only — never persisted

function lockoutMessage(err) {
  // 423 { error: { code: "account_locked", retry_after_seconds } }
  if (err instanceof ApiError && err.status === 423) {
    const secs = err.data && err.data.error && err.data.error.retry_after_seconds;
    const mins = secs != null ? Math.max(1, Math.ceil(Number(secs) / 60)) : null;
    return "Account temporarily locked — try again in " + (mins != null ? mins + " minute" + (mins === 1 ? "" : "s") : "a few minutes") + ".";
  }
  return null;
}

function showLogin(note) {
  renderSeq++; // invalidate any in-flight view renders
  totpChallenge = null;
  $("#app").hidden = true;
  const lv = $("#login-view");
  lv.hidden = false;
  $("#login-form").hidden = false;
  $("#totp-step").hidden = true;
  $("#totp-code").value = "";
  $("#totp-error").hidden = true;
  const noteEl = $("#login-api-note");
  if (note) { noteEl.textContent = note; noteEl.hidden = false; }
  else noteEl.hidden = true;
  $("#login-error").hidden = true;
  setTimeout(() => $("#login-user").focus(), 50);
}
function toLogin(note) {
  setCsrf(null);
  showLogin(note);
}
function enterApp() {
  $("#login-view").hidden = true;
  $("#app").hidden = false;
  if (!location.hash) location.hash = "#/overview";
  updateInboxBadge();
  render();
}

/* Unread-messages badge on the Inbox nav item. Defensive: the dashboard may
   not report messages_unread on older backend builds — then the badge stays hidden. */
async function updateInboxBadge() {
  const badgeEl = $("#nav-inbox-badge");
  try {
    const d = await api("/admin/dashboard");
    const n = d.messages_unread != null ? d.messages_unread : null;
    if (n != null && Number(n) > 0) {
      badgeEl.textContent = String(n);
      badgeEl.hidden = false;
    } else {
      badgeEl.hidden = true;
    }
  } catch (e) {
    badgeEl.hidden = true; // never show a stale/guessed count
  }
}

async function doLogin(ev) {
  ev.preventDefault();
  const errBox = $("#login-error");
  const btn = $("#login-submit");
  errBox.hidden = true;
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const data = await api("/admin/login", {
      method: "POST",
      allow401: true,
      json: { username: $("#login-user").value.trim(), password: $("#login-pass").value }
    });
    if (!data || (!data.csrf_token && !data.totp_required)) throw new Error("Unexpected login response from the server.");
    if (data.totp_required) {
      // Password was correct — second factor required. Challenge lives in memory only.
      totpChallenge = data.challenge || null;
      $("#login-pass").value = "";
      showTotpStep();
      return;
    }
    setCsrf(data.csrf_token);
    $("#login-pass").value = "";
    enterApp();
  } catch (err) {
    const locked = lockoutMessage(err);
    // Generic message on purpose: never reveal whether the username exists.
    errBox.textContent = locked
      ? locked
      : err instanceof ApiError && err.status === 401
        ? "Invalid username or password."
        : (err.message || "Sign-in failed.");
    errBox.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
}

function showTotpStep() {
  $("#login-form").hidden = true;
  $("#totp-step").hidden = false;
  $("#totp-error").hidden = true;
  $("#totp-code").value = "";
  setTimeout(() => $("#totp-code").focus(), 50);
}

async function doTotpVerify(ev) {
  ev.preventDefault();
  const code = $("#totp-code").value.replace(/\D/g, "");
  const errBox = $("#totp-error");
  const btn = $("#totp-submit");
  if (code.length !== 6) {
    errBox.textContent = "Enter the 6-digit code.";
    errBox.hidden = false;
    return;
  }
  errBox.hidden = true;
  btn.disabled = true;
  btn.textContent = "Verifying…";
  try {
    const data = await api("/admin/login/totp", {
      method: "POST",
      allow401: true,
      json: { challenge: totpChallenge, code }
    });
    if (!data || !data.csrf_token) throw new Error("Unexpected response from the server.");
    totpChallenge = null;
    setCsrf(data.csrf_token);
    enterApp();
  } catch (err) {
    const locked = lockoutMessage(err);
    errBox.textContent = locked
      ? locked
      : err instanceof ApiError && err.status === 401
        ? "Invalid code. Try again."
        : (err.message || "Verification failed.");
    errBox.hidden = false;
    $("#totp-code").value = "";
    $("#totp-code").focus();
  } finally {
    btn.disabled = false;
    btn.textContent = "Verify";
  }
}

async function doLogout() {
  try { await api("/admin/logout", { method: "POST" }); } catch (e) { /* best effort */ }
  toLogin("You have been signed out.");
}

/* ---------------- boot ---------------- */
function wireShell() {
  $("#login-form").addEventListener("submit", doLogin);
  $("#totp-form").addEventListener("submit", doTotpVerify);
  $("#totp-code").addEventListener("input", () => {
    const c = $("#totp-code");
    c.value = c.value.replace(/\D/g, "").slice(0, 6);
    if (c.value.length === 6) {
      // Auto-submit once a full code is entered/pasted.
      const form = $("#totp-form");
      if (form.requestSubmit) form.requestSubmit();
      else doTotpVerify({ preventDefault: () => {} });
    }
  });
  $("#totp-back").addEventListener("click", () => showLogin());
  $("#logout-btn").addEventListener("click", doLogout);
  $("#menu-btn").addEventListener("click", () => {
    $("#sidebar").classList.add("open");
    $("#scrim").classList.add("on");
  });
  $("#scrim").addEventListener("click", closeSidebar);
  document.querySelectorAll("#side-nav a").forEach((a) => {
    a.addEventListener("click", () => closeSidebar());
  });
  window.addEventListener("hashchange", () => { if (!$("#app").hidden) render(); });
}

async function boot() {
  wireShell();
  if (!csrfToken) { showLogin(); return; }
  // We have a CSRF token from this tab's session — verify the session is still alive.
  try {
    await api("/admin/dashboard");
    enterApp();
  } catch (err) {
    if (err instanceof AuthError) showLogin();
    else showLogin("Could not reach the API (" + (err.message || "network error") + "). You can still try signing in.");
  }
}

document.addEventListener("DOMContentLoaded", boot);

/* ================= Overview ================= */
const ui = {
  announcements: { page: 1, status: "" },
  inbox: { page: 1, status: "", read: "", archived: "", q: "", openId: null },
  installations: { page: 1, q: "" },
  status: { tab: "published" },
  media: {},
  audit: { page: 1 },
  security: {}
};

async function viewOverview(root, seq) {
  viewLoading(root, "Loading dashboard…");
  const d = await api("/admin/dashboard");
  if (seq !== renderSeq) return;

  const head = el("div", { class: "view-head" },
    el("div", null,
      el("h2", { text: "Overview" }),
      el("p", { text: "Live numbers from the AyX Group database. Nothing here is sample data." })));

  const cards = el("div", { class: "cards" });
  const stat = (label, value, cls) =>
    el("div", { class: "stat" }, el("div", { class: "v" + (cls ? " " + cls : ""), text: String(value) }), el("div", { class: "l", text: label }));
  cards.append(
    stat("Registered installations", d.installations_total ?? "—"),
    stat("Active (7d)", d.installations_active_7d ?? "—", "ok"),
    stat("Online now", d.installations_online ?? "—", "ok"),
    stat("Published announcements", d.announcements_published ?? "—"),
    stat("Active statuses", d.statuses_active ?? "—"),
    stat("Unread messages", d.messages_unread != null ? d.messages_unread : (d.messages_pending ?? "—"), ((d.messages_unread != null ? d.messages_unread : d.messages_pending) > 0 ? "warn" : "")),
    stat("Push failures (24h)", d.push_failures_24h ?? "—", (d.push_failures_24h > 0 ? "bad" : ""))
  );

  root.replaceChildren(head, cards);

  // FCM configuration badge
  const fcm = d.fcm_configured;
  const fcmPanel = el("div", { class: "panel" },
    el("h3", { text: "Push delivery" }),
    fcm === true
      ? el("p", null, badge("FCM configured", "published"), el("span", { class: "muted", text: " Push notifications are being delivered via Firebase Cloud Messaging." }))
      : fcm === false
        ? el("p", null, badge("FCM not configured", "pending"), el("span", { class: "muted", text: " The backend reports FCM is not configured — push jobs are recorded as skipped, never faked. Add FCM_SERVICE_ACCOUNT_JSON on the server to enable delivery." }))
        : el("p", { class: "muted", text: "The backend did not report FCM status. Check the server configuration." }));
  root.append(fcmPanel);

  // Recent admin activity
  const activity = Array.isArray(d.recent_activity) ? d.recent_activity : [];
  const panel = el("div", { class: "panel" }, el("h3", { text: "Recent admin activity" }));
  if (!activity.length) {
    panel.append(el("p", { class: "muted", text: "No admin activity recorded yet." }));
  } else {
    panel.append(dataTable(
      ["Time", "Actor", "Action", "Target", "Result"],
      activity.map((a) => [fmtDate(a.created_at), a.actor || "—", a.action || "—", a.target || "—", a.result || "—"])
    ));
  }
  root.append(panel);
}
ROUTES.overview = viewOverview;

/* ================= Announcements ================= */
const ANN_STATUSES = ["", "draft", "scheduled", "published", "archived"];

async function viewAnnouncements(root, seq) {
  const st = ui.announcements;
  const head = el("div", { class: "view-head" },
    el("div", null,
      el("h2", { text: "Announcements" }),
      el("p", { text: "Create, preview, publish, archive and delete official announcements. Publishing can optionally trigger a push to all active installations." })),
    el("button", { class: "btn primary", text: "+ New announcement", onclick: () => openAnnouncementEditor(null, () => render()) }));

  const toolbar = el("div", { class: "toolbar" });
  const filter = el("select", { "aria-label": "Filter by status" });
  ANN_STATUSES.forEach((s) => filter.append(el("option", { value: s, text: s === "" ? "All statuses" : s, selected: st.status === s || undefined })));
  filter.addEventListener("change", () => { st.status = filter.value; st.page = 1; render(); });
  toolbar.append(el("span", { class: "muted", text: "Status:" }), filter);

  const list = el("div");
  root.replaceChildren(head, toolbar, list);
  viewLoading(list, "Loading announcements…");

  const qs = new URLSearchParams({ page: String(st.page), per_page: "10" });
  if (st.status) qs.set("status", st.status);
  const res = await api("/admin/announcements?" + qs.toString());
  if (seq !== renderSeq) return;
  const items = (res && res.data) || [];
  list.replaceChildren();
  if (!items.length) {
    list.append(el("div", { class: "state" }, el("div", { class: "big", text: "📭" }), el("div", { text: "No announcements found." })));
  } else {
    items.forEach((a) => list.append(announcementCard(a)));
  }
  list.append(pager(res && res.meta, (p) => { st.page = p; render(); }));
}
ROUTES.announcements = viewAnnouncements;

function announcementCard(a) {
  const card = el("div", { class: "item-card" });
  const top = el("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" });
  top.append(el("h4", { text: a.title || "(untitled)" }), statusBadge(a.status));
  card.append(top);
  card.append(el("div", { class: "meta", text:
    "Created " + fmtDate(a.created_at) +
    (a.published_at ? " · Published " + fmtDate(a.published_at) : "") +
    (a.scheduled_at ? " · Scheduled for " + fmtDate(a.scheduled_at) : "") +
    (a.updated_at ? " · Updated " + fmtDate(a.updated_at) : "")
  }));
  if (a.body) card.append(el("div", { class: "body clamp", text: a.body }));

  // Delivery info, only if the API actually provided it — never invented.
  const dj = a.push_job || a.delivery || null;
  if (dj && typeof dj === "object") {
    const bits = [];
    if (dj.status) bits.push("push: " + dj.status);
    if (dj.sent != null) bits.push("sent: " + dj.sent);
    if (dj.failed != null) bits.push("failed: " + dj.failed);
    if (dj.reason) bits.push("reason: " + dj.reason);
    if (bits.length) card.append(el("div", { class: "meta", text: "Delivery — " + bits.join(" · ") }));
  }

  const actions = el("div", { class: "actions" });
  actions.append(el("button", { class: "btn small", text: "Preview", onclick: () => openAnnouncementPreview(a) }));
  actions.append(el("button", { class: "btn small", text: "Edit", onclick: () => openAnnouncementEditor(a, () => render()) }));
  if (a.status === "draft" || a.status === "scheduled") {
    actions.append(el("button", { class: "btn small primary", text: "Publish…", onclick: () => openPublishModal(a) }));
  }
  if (a.status === "published") {
    actions.append(el("button", { class: "btn small", text: "Archive", onclick: () => doArchiveAnnouncement(a) }));
  }
  actions.append(el("button", { class: "btn small danger", text: "Delete", onclick: () => doDeleteAnnouncement(a) }));
  card.append(actions);
  return card;
}

function announcementFormModal(existing) {
  return new Promise((resolve) => {
    const { box, close } = openModal(true);
    box.append(el("h3", { class: "modal-title", text: existing ? "Edit announcement" : "New announcement" }));
    const titleI = el("input", { type: "text", maxlength: "200", value: (existing && existing.title) || "", placeholder: "Announcement title" });
    const bodyI = el("textarea", { placeholder: "Announcement body…", text: (existing && existing.body) || "" });
    let schedVal = "";
    if (existing && existing.scheduled_at) {
      const d = new Date(existing.scheduled_at);
      if (!isNaN(d.getTime())) {
        const p = (n) => String(n).padStart(2, "0");
        schedVal = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
      }
    }
    const schedI = el("input", { type: "datetime-local", value: schedVal });
    box.append(
      el("label", null, "Title", titleI),
      el("label", null, "Body", bodyI),
      el("label", null, "Schedule for later (optional)", schedI),
      el("p", { class: "muted", text: "Leave the schedule empty to keep it as a draft until you publish." })
    );
    const previewBox = el("div", { class: "preview-box", hidden: true });
    const row = el("div", { class: "modal-actions" });
    const prevBtn = el("button", {
      class: "btn ghost", text: "Preview",
      onclick: () => {
        previewBox.hidden = !previewBox.hidden;
        if (!previewBox.hidden) {
          previewBox.replaceChildren(
            el("h4", { text: titleI.value.trim() || "(untitled)" }),
            el("p", { text: bodyI.value.trim() || "(empty body)" }));
        }
      }
    });
    const cancelBtn = el("button", { class: "btn ghost", text: "Cancel", onclick: () => { close(); resolve(null); } });
    const saveBtn = el("button", { class: "btn primary", text: existing ? "Save changes" : "Create draft" });
    saveBtn.addEventListener("click", async () => {
      const title = titleI.value.trim(), body = bodyI.value.trim();
      if (!title) { toast("Title is required.", "err"); return; }
      if (!body) { toast("Body is required.", "err"); return; }
      let scheduled_at = null;
      if (schedI.value) {
        const d = new Date(schedI.value);
        if (isNaN(d.getTime())) { toast("Invalid scheduled date.", "err"); return; }
        scheduled_at = d.toISOString();
      }
      saveBtn.disabled = true;
      try {
        let result;
        if (existing) {
          result = await api("/admin/announcements/" + encodeURIComponent(existing.id), {
            method: "PATCH", json: { title, body, scheduled_at }
          });
        } else {
          result = await api("/admin/announcements", { method: "POST", json: { title, body, scheduled_at } });
        }
        close();
        resolve(result && result.data ? result.data : result);
      } catch (err) {
        if (err instanceof AuthError) { close(); toLogin(); resolve(null); return; }
        toast(err.message || "Save failed.", "err");
        saveBtn.disabled = false;
      }
    });
    row.append(prevBtn, cancelBtn, saveBtn);
    box.append(row);
    setTimeout(() => titleI.focus(), 50);
  });
}

async function openAnnouncementEditor(existing, onDone) {
  const saved = await announcementFormModal(existing);
  if (saved) { toast(existing ? "Announcement updated." : "Draft created.", "ok"); onDone(); }
}

function openAnnouncementPreview(a) {
  const { box, close } = openModal(true);
  box.append(
    el("h3", { class: "modal-title", text: "Preview" }),
    el("div", { class: "preview-box" },
      el("h4", { text: a.title || "(untitled)" }),
      el("p", { text: a.body || "(empty body)" }),
      el("p", { class: "muted", text: "Status: " + (a.status || "—") + (a.published_at ? " · Published " + fmtDate(a.published_at) : "") })
    ),
    el("div", { class: "modal-actions" },
      el("button", { class: "btn", text: "Close", onclick: close }))
  );
}

function openPublishModal(a) {
  const { box, close } = openModal(false);
  box.append(el("h3", { class: "modal-title", text: "Publish announcement" }));
  box.append(el("p", { class: "modal-body muted", text: "“" + (a.title || "(untitled)") + "” will become visible to all active installations." }));
  const notify = el("input", { type: "checkbox", checked: true, id: "pub-notify" });
  const pt = el("input", { type: "text", maxlength: "80", value: (a.title || "").slice(0, 80), placeholder: "Notification title" });
  const pb = el("input", { type: "text", maxlength: "180", value: (a.body || "").slice(0, 180), placeholder: "Notification body" });
  const pushFields = el("div", null,
    el("label", null, "Push title", pt),
    el("label", null, "Push body", pb),
    el("p", { class: "muted", text: "Broadcast pushes never include private user messages." }));
  notify.addEventListener("change", () => { pushFields.style.display = notify.checked ? "" : "none"; });
  box.append(
    el("label", { class: "check-row" }, notify, el("span", { text: "Send push notification to active installations" })),
    pushFields
  );
  const row = el("div", { class: "modal-actions" });
  const cancelBtn = el("button", { class: "btn ghost", text: "Cancel", onclick: close });
  const goBtn = el("button", { class: "btn primary", text: "Publish now" });
  goBtn.addEventListener("click", async () => {
    goBtn.disabled = true;
    try {
      const payload = { notify: notify.checked };
      if (notify.checked) {
        if (pt.value.trim()) payload.push_title = pt.value.trim();
        if (pb.value.trim()) payload.push_body = pb.value.trim();
      }
      const res = await api("/admin/announcements/" + encodeURIComponent(a.id) + "/publish", { method: "POST", json: payload });
      close();
      const dj = res && (res.push_job || res.delivery);
      if (dj && dj.status) toast("Published. Push job status: " + dj.status + ".", "ok");
      else if (notify.checked) toast("Published. Push job recorded — check its status under Push.", "ok");
      else toast("Published.", "ok");
      render();
    } catch (err) {
      if (err instanceof AuthError) { close(); toLogin(); return; }
      toast(err.message || "Publish failed.", "err");
      goBtn.disabled = false;
    }
  });
  row.append(cancelBtn, goBtn);
  box.append(row);
}

async function doArchiveAnnouncement(a) {
  const ok = await confirmDialog({
    title: "Archive announcement",
    body: "“" + (a.title || "(untitled)") + "” will be hidden from clients but kept in the database. Continue?",
    confirmText: "Archive", danger: false
  });
  if (!ok) return;
  try {
    await api("/admin/announcements/" + encodeURIComponent(a.id) + "/archive", { method: "POST", json: {} });
    toast("Announcement archived.", "ok");
    render();
  } catch (err) {
    if (err instanceof AuthError) { toLogin(); return; }
    toast(err.message || "Archive failed.", "err");
  }
}

async function doDeleteAnnouncement(a) {
  const ok = await confirmDialog({
    title: "Delete announcement",
    body: "Permanently delete “" + (a.title || "(untitled)") + "”? Clients will sync this deletion. This cannot be undone.",
    confirmText: "Delete"
  });
  if (!ok) return;
  try {
    await api("/admin/announcements/" + encodeURIComponent(a.id), { method: "DELETE" });
    toast("Announcement deleted.", "ok");
    render();
  } catch (err) {
    if (err instanceof AuthError) { toLogin(); return; }
    toast(err.message || "Delete failed.", "err");
  }
}

/* ================= Push =================
   Contract note: push is part of the announcement publish payload; there is
   no dedicated GET /admin/push-jobs list or POST /admin/push-jobs/{id}/retry
   endpoint in the shared contract. Retrying a failed push is therefore done
   as a re-publish (POST /admin/announcements/{id}/publish {notify:true}),
   which creates a fresh push job. This view documents that honestly. */
async function viewPush(root, seq) {
  viewLoading(root, "Loading push status…");
  let dash = null;
  try { dash = await api("/admin/dashboard"); }
  catch (err) { if (seq !== renderSeq) return; throw err; }
  if (seq !== renderSeq) return;

  const head = el("div", { class: "view-head" },
    el("div", null,
      el("h2", { text: "Push notifications" }),
      el("p", { text: "Push is sent through Firebase Cloud Messaging when you publish an announcement with notifications enabled. Broadcast pushes never include private user messages." })));
  root.replaceChildren(head);

  const fcm = dash.fcm_configured;
  const cfgPanel = el("div", { class: "panel" }, el("h3", { text: "FCM configuration" }));
  if (fcm === true) {
    cfgPanel.append(el("p", null, badge("FCM configured", "published"),
      el("span", { class: "muted", text: " The backend has a service-account credential and will attempt delivery." })));
  } else if (fcm === false) {
    cfgPanel.append(el("p", null, badge("FCM not configured", "pending"),
      el("span", { class: "muted", text: " Set FCM_SERVICE_ACCOUNT_JSON on the API server to enable push. Until then, publish jobs are recorded as skipped — delivery is never faked." })));
  } else {
    cfgPanel.append(el("p", { class: "muted", text: "The backend did not report FCM configuration status." }));
  }
  const fails = dash.push_failures_24h;
  cfgPanel.append(el("p", { class: "muted", text: "Push delivery failures in the last 24h: " + (fails != null ? fails : "—") }));
  root.append(cfgPanel);

  const howPanel = el("div", { class: "panel" }, el("h3", { text: "How push works here" }));
  const ul = el("ul", { class: "explainer" });
  [
    "Open an announcement and choose “Publish…” with “Send push notification” enabled.",
    "The server creates a push job and attempts delivery to every active installation's registered FCM token.",
    "Temporary failures are retried by the server; permanent failures are recorded in the job receipts.",
    "Clients also sync content on their own schedule, so a missed or disabled notification never loses an announcement.",
    "“Read” is never claimed from a send — only actual delivery receipts count."
  ].forEach((t) => ul.append(el("li", { text: t })));
  howPanel.append(ul);
  root.append(howPanel);

  // Retry = re-publish. List published announcements so the admin can re-send push.
  const retryPanel = el("div", { class: "panel" },
    el("h3", { text: "Retry a failed push" }),
    el("p", { class: "muted", text: "The contract has no standalone push-job retry endpoint, so a retry re-publishes the announcement with notifications enabled. Delivery receipts stay honest: this creates a new attempt, it does not rewrite history." }));
  const list = el("div");
  retryPanel.append(list);
  root.append(retryPanel);
  list.append(el("p", { class: "muted", text: "Loading published announcements…" }));
  try {
    const res = await api("/admin/announcements?status=published&page=1&per_page=10");
    if (seq !== renderSeq) return;
    const items = (res && res.data) || [];
    list.replaceChildren();
    if (!items.length) {
      list.append(el("p", { class: "muted", text: "No published announcements to retry." }));
    } else {
      items.forEach((a) => {
        const row = el("div", { class: "item-card" });
        row.append(
          el("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" },
            el("h4", { text: a.title || "(untitled)" }), statusBadge(a.status)),
          el("div", { class: "meta", text: "Published " + fmtDate(a.published_at) })
        );
        const actions = el("div", { class: "actions" });
        const btn = el("button", { class: "btn small", text: "Re-send push" });
        btn.addEventListener("click", async () => {
          const ok = await confirmDialog({
            title: "Re-send push notification",
            body: "Send the push notification for “" + (a.title || "(untitled)") + "” again to all active installations?",
            confirmText: "Re-send", danger: false
          });
          if (!ok) return;
          btn.disabled = true;
          try {
            await api("/admin/announcements/" + encodeURIComponent(a.id) + "/publish",
              { method: "POST", json: { notify: true, push_title: (a.title || "").slice(0, 80), push_body: (a.body || "").slice(0, 180) } });
            toast("Push re-sent. A new delivery attempt was recorded.", "ok");
          } catch (err) {
            if (err instanceof AuthError) { toLogin(); return; }
            toast(err.message || "Re-send failed.", "err");
          } finally { btn.disabled = false; }
        });
        actions.append(btn);
        row.append(actions);
        list.append(row);
      });
    }
  } catch (err) {
    if (err instanceof AuthError) { toLogin(); return; }
    list.replaceChildren(el("p", { class: "muted", text: "Could not load published announcements: " + err.message }));
  }
}
ROUTES.push = viewPush;

/* ================= Statuses ================= */
const STATUS_KINDS = ["text", "image", "video"];
const MAX_UPLOAD = 25 * 1024 * 1024;

async function viewStatus(root, seq) {
  const st = ui.status;
  const head = el("div", { class: "view-head" },
    el("div", null,
      el("h2", { text: "Statuses" }),
      el("p", { text: "Publish text, image or video statuses with an expiry. Deleting a status creates a sync event so clients remove it — deletion is enforced through server sync, not by recalling notifications." })));
  root.replaceChildren(head);

  // Tabs: Drafts / Published / Archived
  const tabs = el("div", { class: "tabs" });
  [["draft", "Drafts"], ["published", "Published"], ["archived", "Archived"]].forEach(([key, label]) => {
    const t = el("button", { class: "tab" + (st.tab === key ? " active" : ""), text: label });
    t.addEventListener("click", () => { st.tab = key; render(); });
    tabs.append(t);
  });
  root.append(tabs);

  // Upload form
  const form = el("div", { class: "panel" }, el("h3", { text: "New status" }));
  const kindSel = el("select", { "aria-label": "Status kind" });
  STATUS_KINDS.forEach((k) => kindSel.append(el("option", { value: k, text: k[0].toUpperCase() + k.slice(1) })));
  const textI = el("textarea", { placeholder: "Status text…", maxlength: "500" });
  const fileI = el("input", { type: "file", accept: "image/*,video/*" });
  const fileWrap = el("label", { hidden: true }, "Media file (max 25 MB)", fileI);
  const expiryI = el("input", { type: "number", min: "1", max: "720", value: "24" });
  const previewBox = el("div", { class: "preview-box", hidden: true });
  let objectUrl = null;

  kindSel.addEventListener("change", () => {
    const isText = kindSel.value === "text";
    textI.closest("label").hidden = false; // text is always allowed alongside media
    fileWrap.hidden = isText;
    previewBox.hidden = true;
  });

  function showPreview() {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    previewBox.replaceChildren();
    const kind = kindSel.value;
    previewBox.append(el("h4", { text: "Preview (" + kind + ")" }));
    if (textI.value.trim()) previewBox.append(el("p", { text: textI.value.trim() }));
    const f = fileI.files && fileI.files[0];
    if (f && kind !== "text") {
      objectUrl = URL.createObjectURL(f);
      if (kind === "image") previewBox.append(el("img", { src: objectUrl, alt: "Status preview", style: "max-width:100%;border-radius:10px;margin-top:8px" }));
      else previewBox.append(el("video", { src: objectUrl, controls: true, style: "max-width:100%;border-radius:10px;margin-top:8px" }));
    }
    if (!textI.value.trim() && !(f && kind !== "text")) {
      previewBox.append(el("p", { class: "muted", text: "Nothing to preview yet." }));
    }
    previewBox.hidden = false;
  }

  async function submitStatus(saveAs, btn) {
    const kind = kindSel.value;
    const text = textI.value.trim();
    const file = fileI.files && fileI.files[0];
    const expiryHours = Math.max(1, Math.min(720, parseInt(expiryI.value, 10) || 24));
    if (kind === "text" && !text) { toast("Text status needs some text.", "err"); return; }
    if (kind !== "text" && !file) { toast("Please choose a media file.", "err"); return; }
    if (file && file.size > MAX_UPLOAD) { toast("File is larger than 25 MB.", "err"); return; }
    if (file && kind === "image" && !file.type.startsWith("image/")) { toast("Please choose an image file.", "err"); return; }
    if (file && kind === "video" && !file.type.startsWith("video/")) { toast("Please choose a video file.", "err"); return; }
    btn.disabled = true;
    try {
      const fd = new FormData();
      fd.append("kind", kind);
      if (text) { fd.append("text", text); fd.append("caption", text); } // caption = text per API; text kept for older backends
      if (file) fd.append("file", file);
      fd.append("expiry_hours", String(expiryHours));
      fd.append("status", saveAs); // "draft" | "published"
      await api("/admin/statuses", { method: "POST", form: fd });
      toast(saveAs === "draft" ? "Draft saved." : "Status published.", "ok");
      textI.value = ""; fileI.value = ""; expiryI.value = "24"; previewBox.hidden = true;
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
      render();
    } catch (err) {
      if (err instanceof AuthError) { toLogin(); return; }
      toast(err.message || "Save failed.", "err");
    } finally { btn.disabled = false; }
  }

  const draftBtn = el("button", { class: "btn", text: "Save as draft" });
  draftBtn.addEventListener("click", () => submitStatus("draft", draftBtn));
  const pubBtn = el("button", { class: "btn primary", text: "Publish status" });
  pubBtn.addEventListener("click", () => submitStatus("published", pubBtn));

  form.append(
    el("label", null, "Kind", kindSel),
    el("label", null, "Text / caption (optional for image/video)", textI),
    fileWrap,
    el("label", null, "Expires after (hours, default 24)", expiryI),
    el("div", { class: "btn-row" },
      el("button", { class: "btn", text: "Preview", onclick: showPreview }),
      draftBtn,
      pubBtn),
    previewBox
  );
  root.append(form);

  // List (filtered by the active tab)
  const tabLabel = st.tab === "draft" ? "Draft" : st.tab === "archived" ? "Archived" : "Published";
  const listPanel = el("div", { class: "panel" }, el("h3", { text: tabLabel + " statuses" }));
  const list = el("div");
  listPanel.append(list);
  root.append(listPanel);
  list.append(el("p", { class: "muted", text: "Loading statuses…" }));
  try {
    const res = await api("/admin/statuses?status=" + encodeURIComponent(st.tab));
    if (seq !== renderSeq) return;
    const items = (res && res.data) || (Array.isArray(res) ? res : []);
    list.replaceChildren();
    if (!items.length) {
      list.append(el("p", { class: "muted", text: "No statuses yet." }));
    } else {
      items.forEach((s) => list.append(statusCard(s)));
    }
  } catch (err) {
    if (err instanceof AuthError) { toLogin(); return; }
    list.replaceChildren(el("p", { class: "muted", text: "Could not load statuses: " + err.message }));
  }
}
ROUTES.status = viewStatus;

function expiryText(iso) {
  if (!iso) return "No expiry set";
  const d = new Date(iso), now = new Date();
  if (isNaN(d.getTime())) return "—";
  const ms = d.getTime() - now.getTime();
  if (ms <= 0) return "Expired";
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60), m = mins % 60;
  const days = Math.floor(h / 24);
  if (days > 0) return "Expires in " + days + "d " + (h % 24) + "h";
  if (h > 0) return "Expires in " + h + "h " + m + "m";
  return "Expires in " + m + "m";
}

function statusCard(s) {
  const card = el("div", { class: "item-card" });
  card.append(el("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" },
    el("h4", { text: "Status · " + (s.kind || "—") }),
    s.status ? statusBadge(s.status) : (s.expires_at ? badge(new Date(s.expires_at) > new Date() ? "active" : "expired", new Date(s.expires_at) > new Date() ? "published" : "archived") : null)));

  const caption = s.caption != null ? s.caption : s.text;
  const captionWrap = el("div");
  if (caption) captionWrap.append(el("div", { class: "body", text: caption }));
  card.append(captionWrap);

  const mediaUrl = s.media_url || (s.media_id ? "/media/" + encodeURIComponent(s.media_id) : null);
  if (mediaUrl && s.kind !== "text") {
    const holder = el("div", { class: "muted", text: "Loading preview…" });
    card.append(holder);
    apiBlob(mediaUrl).then((blob) => {
      const url = URL.createObjectURL(blob);
      holder.replaceChildren();
      if (s.kind === "image") holder.append(el("img", { src: url, alt: "Status image", style: "max-width:100%;border-radius:10px" }));
      else holder.append(el("video", { src: url, controls: true, style: "max-width:100%;border-radius:10px" }));
    }).catch(() => {
      holder.textContent = "Preview unavailable.";
    });
  }
  card.append(el("div", { class: "meta", text: "Created " + fmtDate(s.created_at) + (s.published_at ? " · Published " + fmtDate(s.published_at) : "") }));
  card.append(el("div", { class: "countdown", text: "⏳ " + expiryText(s.expires_at) + (s.expires_at ? " (" + fmtDate(s.expires_at) + ")" : "") }));

  const actions = el("div", { class: "actions" });

  // Inline caption editing
  const editBtn = el("button", { class: "btn small", text: "Edit caption" });
  editBtn.addEventListener("click", () => {
    const form = el("div", { class: "inline-form" });
    const input = el("textarea", { maxlength: "500", text: caption || "" });
    const save = el("button", { class: "btn small primary", text: "Save" });
    const cancel = el("button", { class: "btn small ghost", text: "Cancel", onclick: () => { form.remove(); editBtn.disabled = false; } });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await api("/admin/statuses/" + encodeURIComponent(s.id), { method: "PATCH", json: { caption: input.value.trim() } });
        toast("Caption updated.", "ok");
        render();
      } catch (err) {
        if (err instanceof AuthError) { toLogin(); return; }
        if (err instanceof ApiError && err.status === 404) toast("This backend build does not support caption editing yet.", "info");
        else toast(err.message || "Update failed.", "err");
        save.disabled = false;
      }
    });
    form.append(input, save, cancel);
    captionWrap.append(form);
    editBtn.disabled = true;
    input.focus();
  });
  actions.append(editBtn);

  // Publish / unpublish / archive transitions — only when the backend reports
  // a lifecycle status; older backends keep the previous button set.
  const st = (s.status || "").toLowerCase();
  if (s.status) {
    if (st === "draft") {
      const p = el("button", { class: "btn small primary", text: "Publish" });
      p.addEventListener("click", () => statusTransition(s, "publish", "Published."));
      actions.append(p);
    }
    if (st === "published") {
      const u = el("button", { class: "btn small", text: "Unpublish" });
      u.addEventListener("click", () => statusTransition(s, "unpublish", "Unpublished — hidden from clients."));
      actions.append(u);
    }
    if (st !== "archived") {
      const a = el("button", { class: "btn small", text: "Archive" });
      a.addEventListener("click", async () => {
        const ok = await confirmDialog({
          title: "Archive status",
          body: "Archive this status? It will be hidden from clients but kept in the database.",
          confirmText: "Archive", danger: false
        });
        if (ok) statusTransition(s, "archive", "Archived.");
      });
      actions.append(a);
    }
  }

  const del = el("button", { class: "btn small danger", text: "Delete" });
  del.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Delete status",
      body: "Delete this status? Clients will remove it on their next sync. Already-displayed notifications cannot be recalled instantly.",
      confirmText: "Delete"
    });
    if (!ok) return;
    try {
      await api("/admin/statuses/" + encodeURIComponent(s.id), { method: "DELETE" });
      toast("Status deleted.", "ok");
      render();
    } catch (err) {
      if (err instanceof AuthError) { toLogin(); return; }
      toast(err.message || "Delete failed.", "err");
    }
  });
  actions.append(del);
  card.append(actions);
  return card;
}

async function statusTransition(s, action, doneMsg) {
  try {
    await api("/admin/statuses/" + encodeURIComponent(s.id) + "/" + action, { method: "POST", json: {} });
    toast(doneMsg, "ok");
    render();
  } catch (err) {
    if (err instanceof AuthError) { toLogin(); return; }
    if (err instanceof ApiError && err.status === 404) toast("This backend build does not support that action yet.", "info");
    else toast(err.message || "Action failed.", "err");
  }
}

/* ================= Private inbox ================= */
const MSG_STATUSES = ["", "pending", "resolved", "spam"];

async function viewInbox(root, seq) {
  const st = ui.inbox;
  if (st.openId) { await viewConversation(root, seq, st.openId); return; }

  const head = el("div", { class: "view-head" },
    el("div", null,
      el("h2", { text: "Inbox" }),
      el("p", { text: "Private user messages. Visible only to signed-in admins — a user can only ever see their own messages." })));

  // Filter chips: All / Unread / Read / Archived
  const chips = el("div", { class: "chips" });
  const chipDefs = [
    ["all", "All", st.read === "" && st.archived === ""],
    ["unread", "Unread", st.read === "false" && st.archived === "false"],
    ["read", "Read", st.read === "true" && st.archived === "false"],
    ["archived", "Archived", st.archived === "true"]
  ];
  chipDefs.forEach(([key, label, active]) => {
    const c = el("button", { class: "chip" + (active ? " active" : ""), text: label });
    c.addEventListener("click", () => {
      if (key === "all") { st.read = ""; st.archived = ""; }
      else if (key === "unread") { st.read = "false"; st.archived = "false"; }
      else if (key === "read") { st.read = "true"; st.archived = "false"; }
      else { st.read = ""; st.archived = "true"; }
      st.page = 1;
      render();
    });
    chips.append(c);
  });

  const toolbar = el("div", { class: "toolbar" });
  const filter = el("select", { "aria-label": "Filter by status" });
  MSG_STATUSES.forEach((s) => filter.append(el("option", { value: s, text: s === "" ? "All statuses" : s, selected: st.status === s || undefined })));
  filter.addEventListener("change", () => { st.status = filter.value; st.page = 1; render(); });
  const search = el("input", { type: "text", placeholder: "Search messages…", value: st.q, "aria-label": "Search messages" });
  toolbar.append(chips, el("span", { class: "muted", text: "Status:" }), filter, search);

  const list = el("div");
  root.replaceChildren(head, toolbar, list);

  let debounce = null;
  search.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { st.q = search.value.trim(); st.page = 1; render(); }, 450);
  });

  viewLoading(list, "Loading messages…");

  const qs = new URLSearchParams({ page: String(st.page), per_page: "15" });
  if (st.status) qs.set("status", st.status);
  if (st.read !== "") qs.set("read", st.read);
  if (st.archived !== "") qs.set("archived", st.archived);
  if (st.q) qs.set("q", st.q);
  const res = await api("/admin/messages?" + qs.toString());
  if (seq !== renderSeq) return;
  const items = (res && res.data) || [];
  list.replaceChildren();
  if (!items.length) {
    list.append(el("div", { class: "state" }, el("div", { class: "big", text: "📭" }), el("div", { text: "No messages." })));
  } else {
    items.forEach((m) => {
      // Only mark unread when the backend actually reports read state;
      // older backends without read_at keep the previous neutral rendering.
      const tracksRead = m && Object.prototype.hasOwnProperty.call(m, "read_at");
      const unread = tracksRead && !m.read_at && !m.archived;
      const card = el("div", { class: "item-card" });
      const topRow = el("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" });
      if (unread) topRow.append(el("span", { class: "unread-dot", title: "Unread" }));
      topRow.append(statusBadge(m.status));
      if (m.archived) topRow.append(badge("archived", "archived"));
      if (m.kind) topRow.append(badge(m.kind, "info"));
      topRow.append(el("span", { class: "mono muted", text: "from " + shortId(m.installation_id) }));
      card.append(topRow);
      card.append(el("div", { class: "body clamp", text: m.body || "", style: unread ? "font-weight:600" : "" }));
      card.append(el("div", { class: "meta", text: fmtDate(m.created_at) + (m.reply_count != null ? " · " + m.reply_count + " replies" : "") }));
      card.append(el("div", { class: "actions" },
        el("button", { class: "btn small", text: "Open conversation", onclick: () => { st.openId = m.id; render(); } })));
      list.append(card);
    });
  }
  list.append(pager(res && res.meta, (p) => { st.page = p; render(); }));
}
ROUTES.inbox = viewInbox;

async function viewConversation(root, seq, id) {
  const st = ui.inbox;
  viewLoading(root, "Loading conversation…");
  const m = await api("/admin/messages/" + encodeURIComponent(id));
  if (seq !== renderSeq) return;
  const msg = (m && m.data) || m || {};

  const head = el("div", { class: "view-head" },
    el("div", null,
      el("h2", { text: "Conversation" }),
      el("p", null, el("span", { class: "mono", text: "Installation " + (msg.installation_id || "—") }))),
    el("button", { class: "btn ghost", text: "← Back to inbox", onclick: () => { st.openId = null; render(); } }));
  root.replaceChildren(head);

  const panel = el("div", { class: "panel" });
  panel.append(el("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" },
    statusBadge(msg.status), msg.kind ? badge(msg.kind, "info") : null,
    msg.archived ? badge("archived", "archived")
      : (Object.prototype.hasOwnProperty.call(msg, "read_at") ? (msg.read_at ? badge("read", "resolved") : badge("unread", "pending")) : null),
    el("span", { class: "muted", text: fmtDate(msg.created_at) })));

  const thread = el("div", { class: "thread" });
  thread.append(el("div", { class: "msg user" }, el("div", { text: msg.body || "" }), el("div", { class: "t", text: "User · " + fmtDate(msg.created_at) })));
  const replies = Array.isArray(msg.replies) ? msg.replies : [];
  replies.forEach((r) => {
    thread.append(el("div", { class: "msg admin" }, el("div", { text: r.body || "" }), el("div", { class: "t", text: "Admin · " + fmtDate(r.created_at) })));
  });
  panel.append(thread);

  // Reply box
  const replyI = el("textarea", { placeholder: "Write a reply…", maxlength: "2000" });
  const sendBtn = el("button", { class: "btn primary", text: "Send reply" });
  sendBtn.addEventListener("click", async () => {
    const body = replyI.value.trim();
    if (!body) { toast("Reply cannot be empty.", "err"); return; }
    sendBtn.disabled = true;
    try {
      await api("/admin/messages/" + encodeURIComponent(id) + "/replies", { method: "POST", json: { body } });
      toast("Reply sent.", "ok");
      render();
    } catch (err) {
      if (err instanceof AuthError) { toLogin(); return; }
      toast(err.message || "Reply failed.", "err");
      sendBtn.disabled = false;
    }
  });
  panel.append(el("div", { class: "reply-row" }, replyI, sendBtn));

  // Status + moderation actions
  const actions = el("div", { class: "btn-row" });
  [["pending", "Mark pending"], ["resolved", "Mark resolved"], ["spam", "Mark spam"]].forEach(([val, label]) => {
    const b = el("button", { class: "btn small", text: label, disabled: msg.status === val });
    b.addEventListener("click", async () => {
      try {
        await api("/admin/messages/" + encodeURIComponent(id) + "/status", { method: "POST", json: { status: val } });
        toast("Message marked as " + val + ".", "ok");
        render();
      } catch (err) {
        if (err instanceof AuthError) { toLogin(); return; }
        toast(err.message || "Update failed.", "err");
      }
    });
    actions.append(b);
  });
  // Read / archive flags
  const readBtn = el("button", { class: "btn small", text: msg.read_at ? "Mark unread" : "Mark read" });
  readBtn.addEventListener("click", () => setMessageFlag(id, "read", !msg.read_at));
  const archBtn = el("button", { class: "btn small", text: msg.archived ? "Unarchive" : "Archive" });
  archBtn.addEventListener("click", () => setMessageFlag(id, "archive", !msg.archived));
  actions.append(readBtn, archBtn);
  if (msg.installation_id) {
    const revokeBtn = el("button", { class: "btn small danger", text: "Revoke installation" });
    revokeBtn.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Revoke installation",
        body: "Revoke installation " + shortId(msg.installation_id) + "? Its credentials stop working immediately. Use for abuse only.",
        confirmText: "Revoke"
      });
      if (!ok) return;
      try {
        await api("/admin/installations/" + encodeURIComponent(msg.installation_id) + "/revoke", { method: "POST", json: {} });
        toast("Installation revoked.", "ok");
        render();
      } catch (err) {
        if (err instanceof AuthError) { toLogin(); return; }
        toast(err.message || "Revoke failed.", "err");
      }
    });
    actions.append(revokeBtn);
  }
  panel.append(actions);
  root.append(panel);
}

/* ================= Installations ================= */
async function setMessageFlag(id, kind, value) {
  const ep = kind === "read" ? "read" : "archive";
  try {
    await api("/admin/messages/" + encodeURIComponent(id) + "/" + ep, {
      method: "POST",
      json: kind === "read" ? { read: !!value } : { archived: !!value }
    });
    toast(
      kind === "read" ? (value ? "Marked as read." : "Marked as unread.")
                      : (value ? "Archived." : "Unarchived."),
      "ok"
    );
    updateInboxBadge();
    render();
  } catch (err) {
    if (err instanceof AuthError) { toLogin(); return; }
    if (err instanceof ApiError && err.status === 404) toast("This backend build does not support that action yet.", "info");
    else toast(err.message || "Update failed.", "err");
  }
}

async function viewInstallations(root, seq) {
  const st = ui.installations;
  const head = el("div", { class: "view-head" },
    el("div", null,
      el("h2", { text: "Installations" }),
      el("p", { text: "Anonymous app installations. App installations with phone number and device name. No WhatsApp chats or message content are collected." })));
  const toolbar = el("div", { class: "toolbar" });
  const search = el("input", { type: "text", placeholder: "Search by installation ID…", value: st.q, "aria-label": "Search installations" });
  toolbar.append(search);
  const list = el("div");
  root.replaceChildren(head, toolbar, list);

  let debounce = null;
  search.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { st.q = search.value.trim(); st.page = 1; render(); }, 450);
  });

  viewLoading(list, "Loading installations…");
  const qs = new URLSearchParams({ page: String(st.page), per_page: "15" });
  if (st.q) qs.set("q", st.q);
  const res = await api("/admin/installations?" + qs.toString());
  if (seq !== renderSeq) return;
  const items = (res && res.data) || [];
  list.replaceChildren();
  if (!items.length) {
    list.append(el("div", { class: "state" }, el("div", { class: "big", text: "📱" }), el("div", { text: "No installations found." })));
  } else {
    list.append(dataTable(
      ["Online", "Installation", "Label", "Phone", "Device", "App version", "Last seen", "Status", "Push token", "Actions"],
      items.map((ins) => {
        const iid = ins.id || ins.installation_id;
        const online = ins.online === true;
        const onlineCell = el("span", { title: online ? "Online now" : "Offline / no recent heartbeat" },
          el("span", { class: "dot" + (online ? " on" : "") }));

        const idCell = el("span", null);
        const code = el("code", { class: "mono", text: shortId(iid) });
        code.title = String(iid || "");
        idCell.append(code);

        const labelCell = el("span", { class: "label-edit" });
        const labelText = el("span", { text: ins.display_label || "—", class: ins.display_label ? "" : "muted" });
        const editBtn = el("button", { class: "icon-btn", text: "✎", title: "Edit label", "aria-label": "Edit display label" });
        editBtn.addEventListener("click", () => openLabelEditor(ins, labelText));
        labelCell.append(labelText, editBtn);

        const revoked = ins.status === "revoked" || ins.revoked === true;
        const blocked = ins.blocked === true;
        const statusCell = el("span", { style: "display:inline-flex;gap:6px;flex-wrap:wrap" });
        if (blocked) {
          const b = badge("blocked", "revoked");
          if (ins.blocked_reason) b.title = "Reason: " + ins.blocked_reason;
          statusCell.append(b);
        } else if (revoked) {
          statusCell.append(badge("revoked", "revoked"));
        } else {
          statusCell.append(badge(ins.status || "active", "active"));
        }

        const actions = el("span", { style: "display:inline-flex;gap:6px;flex-wrap:wrap" });
        const blockBtn = el("button", {
          class: "btn small " + (blocked ? "" : "danger"),
          text: blocked ? "Unblock" : "Block",
          title: blocked ? "Remove the block" : "Block this installation (requires a reason)"
        });
        blockBtn.addEventListener("click", () => blocked ? doUnblockInstallation(ins) : openBlockDialog(ins));
        const btn = el("button", {
          class: "btn small " + (revoked ? "" : "danger"),
          text: revoked ? "Unrevoke" : "Revoke"
        });
        btn.addEventListener("click", () => toggleRevoke(ins, revoked));
        actions.append(blockBtn, btn);

        const pushState = ins.push_token === true || ins.has_push_token === true ? "registered"
          : (ins.push_token === false || ins.has_push_token === false ? "none" : "—");
        return [
          onlineCell,
          idCell,
          labelCell,
          ins.phone_number || "—",
          ins.device_name || "—",
          ins.app_version || "—",
          fmtDate(ins.last_seen_at || ins.last_sync_at || ins.last_sync),
          statusCell,
          pushState === "registered" ? badge("registered", "published") : pushState,
          actions
        ];
      })
    ));
  }
  list.append(pager(res && res.meta, (p) => { st.page = p; render(); }));
}
ROUTES.installations = viewInstallations;

async function toggleRevoke(ins, revoked) {
  const id = ins.id || ins.installation_id;
  const action = revoked ? "unrevoke" : "revoke";
  const ok = await confirmDialog({
    title: (revoked ? "Unrevoke" : "Revoke") + " installation",
    body: (revoked ? "Restore access for" : "Revoke access for") + " installation " + shortId(id) + "?",
    confirmText: revoked ? "Unrevoke" : "Revoke",
    danger: !revoked
  });
  if (!ok) return;
  try {
    await api("/admin/installations/" + encodeURIComponent(id) + "/" + action, { method: "POST", json: {} });
    toast("Installation " + action + "d.", "ok");
    render();
  } catch (err) {
    if (err instanceof AuthError) { toLogin(); return; }
    toast(err.message || "Action failed.", "err");
  }
}

function openLabelEditor(ins, labelTextNode) {
  const id = ins.id || ins.installation_id;
  const { box, close } = openModal(false);
  box.append(el("h3", { class: "modal-title", text: "Display label" }));
  box.append(el("p", { class: "modal-body muted", text: "A friendly name for installation " + shortId(id) + ". Visible only to admins." }));
  const input = el("input", { type: "text", maxlength: "80", value: ins.display_label || "", placeholder: "e.g. Test device — Pixel" });
  box.append(el("label", null, "Label", input));
  const row = el("div", { class: "modal-actions" });
  const cancelBtn = el("button", { class: "btn ghost", text: "Cancel", onclick: close });
  const saveBtn = el("button", { class: "btn primary", text: "Save label" });
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const res = await api("/admin/installations/" + encodeURIComponent(id) + "/label", {
        method: "PUT", json: { display_label: input.value.trim() }
      });
      const newLabel = (res && (res.display_label || (res.data && res.data.display_label))) ?? input.value.trim();
      if (labelTextNode) {
        labelTextNode.textContent = newLabel || "—";
        labelTextNode.classList.toggle("muted", !newLabel);
      }
      toast("Label saved.", "ok");
      close();
    } catch (err) {
      if (err instanceof AuthError) { close(); toLogin(); return; }
      if (err instanceof ApiError && err.status === 404) toast("This backend build does not support labels yet.", "info");
      else toast(err.message || "Save failed.", "err");
      saveBtn.disabled = false;
    }
  });
  row.append(cancelBtn, saveBtn);
  box.append(row);
  setTimeout(() => input.focus(), 50);
}

function openBlockDialog(ins) {
  const id = ins.id || ins.installation_id;
  const { box, close } = openModal(false);
  box.append(el("h3", { class: "modal-title", text: "Block installation" }));
  box.append(el("p", { class: "modal-body muted", text: "Blocking stops installation " + shortId(id) + " from using AyX Group. A reason is required and is recorded in the audit log." }));
  const reasonI = el("textarea", { placeholder: "Reason for blocking (required)…", maxlength: "500" });
  box.append(el("label", null, "Reason", reasonI));
  const row = el("div", { class: "modal-actions" });
  const cancelBtn = el("button", { class: "btn ghost", text: "Cancel", onclick: close });
  const goBtn = el("button", { class: "btn danger", text: "Block installation" });
  goBtn.addEventListener("click", async () => {
    const reason = reasonI.value.trim();
    if (!reason) { toast("A reason is required to block an installation.", "err"); reasonI.focus(); return; }
    goBtn.disabled = true;
    try {
      await api("/admin/installations/" + encodeURIComponent(id) + "/block", { method: "POST", json: { reason } });
      toast("Installation blocked.", "ok");
      close();
      render();
    } catch (err) {
      if (err instanceof AuthError) { close(); toLogin(); return; }
      if (err instanceof ApiError && err.status === 404) toast("This backend build does not support blocking yet.", "info");
      else toast(err.message || "Block failed.", "err");
      goBtn.disabled = false;
    }
  });
  row.append(cancelBtn, goBtn);
  box.append(row);
  setTimeout(() => reasonI.focus(), 50);
}

async function doUnblockInstallation(ins) {
  const id = ins.id || ins.installation_id;
  const ok = await confirmDialog({
    title: "Unblock installation",
    body: "Remove the block on installation " + shortId(id) + "?",
    confirmText: "Unblock", danger: false
  });
  if (!ok) return;
  try {
    await api("/admin/installations/" + encodeURIComponent(id) + "/unblock", { method: "POST", json: {} });
    toast("Installation unblocked.", "ok");
    render();
  } catch (err) {
    if (err instanceof AuthError) { toLogin(); return; }
    if (err instanceof ApiError && err.status === 404) toast("This backend build does not support unblocking yet.", "info");
    else toast(err.message || "Unblock failed.", "err");
  }
}

/* ================= Media library ================= */
async function viewMedia(root, seq) {
  const head = el("div", { class: "view-head" },
    el("div", null,
      el("h2", { text: "Media library" }),
      el("p", { text: "Uploaded status assets. Protected media is only served to authorized clients." })),
    el("button", { class: "btn", text: "Clean up orphans", onclick: cleanupOrphans }));
  const grid = el("div", { class: "media-grid" });
  root.replaceChildren(head, grid);
  grid.append(el("p", { class: "muted", text: "Loading media…" }));
  try {
    const res = await api("/admin/media");
    if (seq !== renderSeq) return;
    const items = (res && res.data) || (Array.isArray(res) ? res : []);
    grid.replaceChildren();
    if (!items.length) {
      grid.replaceChildren(el("div", { class: "state" }, el("div", { class: "big", text: "🖼️" }), el("div", { text: "No media uploaded yet." })));
      return;
    }
    items.forEach((m) => grid.append(mediaCard(m)));
  } catch (err) {
    if (err instanceof AuthError) { toLogin(); return; }
    grid.replaceChildren(el("p", { class: "muted", text: "Could not load media: " + err.message }));
  }
}
ROUTES.media = viewMedia;

function mediaCard(m) {
  const id = m.id || m.media_id;
  const card = el("div", { class: "media-card" });
  const prev = el("div", { class: "prev", text: "loading…" });
  card.append(prev);
  const mime = m.mime_type || m.mime || "";
  const path = "/media/" + encodeURIComponent(id);
  apiBlob(path).then((blob) => {
    const url = URL.createObjectURL(blob);
    prev.replaceChildren();
    if (mime.startsWith("image/") || blob.type.startsWith("image/")) {
      prev.append(el("img", { src: url, alt: "Media preview", loading: "lazy" }));
    } else if (mime.startsWith("video/") || blob.type.startsWith("video/")) {
      prev.append(el("video", { src: url, preload: "metadata", muted: true }));
    } else {
      prev.textContent = mime || "file";
    }
  }).catch(() => { prev.textContent = "preview unavailable"; });

  const meta = el("div", { class: "m" });
  meta.append(el("div", { class: "mono", text: shortId(id) }));
  meta.append(el("div", { text: (mime || "unknown type") + " · " + fmtBytes(m.size_bytes != null ? m.size_bytes : m.size) }));
  meta.append(el("div", { text: fmtDate(m.created_at) }));
  card.append(meta);
  const del = el("button", { class: "btn small danger", text: "Delete" });
  del.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Delete media",
      body: "Delete this asset? The server refuses if it is still referenced by a status.",
      confirmText: "Delete"
    });
    if (!ok) return;
    try {
      await api("/admin/media/" + encodeURIComponent(id), { method: "DELETE" });
      toast("Media deleted.", "ok");
      render();
    } catch (err) {
      if (err instanceof AuthError) { toLogin(); return; }
      if (err instanceof ApiError && err.status === 409) toast("Still referenced by a status — delete the status first.", "err");
      else toast(err.message || "Delete failed.", "err");
    }
  });
  card.append(el("div", { class: "row" }, del));
  return card;
}

async function cleanupOrphans() {
  const ok = await confirmDialog({
    title: "Clean up orphaned media",
    body: "Ask the server to delete media files that are no longer referenced by any status or announcement. Continue?",
    confirmText: "Clean up", danger: false
  });
  if (!ok) return;
  try {
    const res = await api("/admin/media/cleanup", { method: "POST", json: {} });
    const n = res && (res.deleted != null ? res.deleted : res.count);
    toast(n != null ? "Cleanup done — " + n + " orphaned file(s) removed." : "Cleanup done.", "ok");
    render();
  } catch (err) {
    if (err instanceof AuthError) { toLogin(); return; }
    if (err instanceof ApiError && err.status === 404) {
      toast("This backend build does not expose an orphan-cleanup endpoint yet.", "info");
    } else toast(err.message || "Cleanup failed.", "err");
  }
}

/* ================= Security: 2FA + sessions ================= */
async function viewSecurity(root, seq) {
  const head = el("div", { class: "view-head" },
    el("div", null,
      el("h2", { text: "Security" }),
      el("p", { text: "Two-factor authentication and active admin sessions. Secrets are never stored in the browser beyond this tab's session." })));
  root.replaceChildren(head);

  // --- 2FA card ---
  const tfa = el("div", { class: "panel" }, el("h3", { text: "Two-factor authentication" }));
  const tfaBody = el("div");
  tfa.append(tfaBody);
  root.append(tfa);
  tfaBody.append(el("p", { class: "muted", text: "Checking 2FA status…" }));
  render2fa(tfaBody, seq);

  // --- Sessions card ---
  const sess = el("div", { class: "panel" }, el("h3", { text: "Active sessions" }));
  const sessBody = el("div");
  sess.append(sessBody);
  root.append(sess);
  sessBody.append(el("p", { class: "muted", text: "Loading sessions…" }));
  renderSessions(sessBody, seq);
}
ROUTES.security = viewSecurity;

async function render2fa(body, seq) {
  let enabled = null;
  try {
    const st = await api("/admin/2fa/status");
    if (seq !== renderSeq) return;
    enabled = !!(st && (st.enabled === true || st.totp_enabled === true));
  } catch (err) {
    if (seq !== renderSeq) return;
    if (err instanceof AuthError) { toLogin(); return; }
    if (err instanceof ApiError && err.status === 404) {
      body.replaceChildren(el("p", { class: "muted", text: "This backend build does not report 2FA status. Setup may still work — try it below." }));
      body.append(tfaSetupButton(body));
      return;
    }
    body.replaceChildren(el("p", { class: "muted", text: "Could not check 2FA status: " + err.message }));
    return;
  }
  body.replaceChildren();
  const row = el("p", null,
    el("span", { text: "Status: " }),
    enabled ? badge("2FA enabled", "published") : badge("2FA disabled", "pending"));
  body.append(row);
  if (enabled) {
    const disBtn = el("button", { class: "btn danger", text: "Disable 2FA…" });
    disBtn.addEventListener("click", () => open2faDisable(body));
    body.append(el("div", { class: "btn-row" }, disBtn),
      el("p", { class: "muted", text: "Disabling requires your current password." }));
  } else {
    body.append(el("div", { class: "btn-row" }, tfaSetupButton(body)),
      el("p", { class: "muted", text: "After setup, sign-in will ask for a 6-digit code in addition to your password." }));
  }
}

function tfaSetupButton(body) {
  const btn = el("button", { class: "btn primary", text: "Set up 2FA…" });
  btn.addEventListener("click", () => open2faSetup(body));
  return btn;
}

async function open2faSetup(body) {
  const { box, close } = openModal(true);
  box.append(el("h3", { class: "modal-title", text: "Set up two-factor authentication" }));
  box.append(el("p", { class: "modal-body muted", text: "Setting up… " }));
  try {
    const res = await api("/admin/2fa/setup", { method: "POST", json: {} });
    const secret = res && res.secret;
    const url = res && res.otpauth_url;
    if (!secret) throw new Error("The server did not return a 2FA secret.");
    box.replaceChildren(
      el("h3", { class: "modal-title", text: "Set up two-factor authentication" }),
      el("p", { class: "modal-body muted", text: "1. Open your authenticator app and add this account:" })
    );
    if (url) {
      const link = el("a", { href: url, text: "Open in authenticator app", target: "_blank", rel: "noopener" });
      link.style.color = "var(--accent2)";
      link.style.fontWeight = "600";
      box.append(el("p", null, link));
    }
    box.append(el("p", { class: "modal-body muted", text: "2. Or enter this secret manually (keep it private):" }));
    const secretInput = el("input", { type: "text", readonly: true, value: secret, "aria-label": "2FA secret", onclick: (e) => e.target.select() });
    const copyBtn = el("button", { class: "btn small", text: "Copy" });
    copyBtn.addEventListener("click", async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(secret);
        else { secretInput.select(); document.execCommand("copy"); }
        toast("Secret copied.", "ok");
      } catch (e) { toast("Copy failed — select the secret manually.", "err"); }
    });
    box.append(el("div", { class: "secret-row" }, secretInput, copyBtn));
    box.append(el("p", { class: "modal-body muted", text: "3. Enter a 6-digit code from the app to verify and enable:" }));
    const codeI = el("input", { type: "text", inputmode: "numeric", pattern: "[0-9]*", maxlength: "6", placeholder: "123456", "aria-label": "Verification code" });
    codeI.style.cssText = "text-align:center;font-size:20px;letter-spacing:8px;font-weight:700";
    box.append(el("label", null, "Verification code", codeI));
    const row = el("div", { class: "modal-actions" });
    const cancelBtn = el("button", { class: "btn ghost", text: "Cancel", onclick: close });
    const verifyBtn = el("button", { class: "btn primary", text: "Verify & enable" });
    verifyBtn.addEventListener("click", async () => {
      const code = codeI.value.replace(/\D/g, "");
      if (code.length !== 6) { toast("Enter the 6-digit code.", "err"); return; }
      verifyBtn.disabled = true;
      try {
        await api("/admin/2fa/verify", { method: "POST", json: { code } });
        toast("Two-factor authentication enabled.", "ok");
        close();
        render2fa(body, renderSeq);
      } catch (err) {
        if (err instanceof AuthError) { close(); toLogin(); return; }
        toast(err.message || "Verification failed.", "err");
        verifyBtn.disabled = false;
      }
    });
    row.append(cancelBtn, verifyBtn);
    box.append(row);
    setTimeout(() => codeI.focus(), 50);
  } catch (err) {
    if (err instanceof AuthError) { close(); toLogin(); return; }
    if (err instanceof ApiError && err.status === 404) {
      close();
      toast("This backend build does not support 2FA setup yet.", "info");
    } else {
      box.replaceChildren(
        el("h3", { class: "modal-title", text: "Set up two-factor authentication" }),
        el("p", { class: "modal-body", text: "Setup failed: " + err.message }),
        el("div", { class: "modal-actions" }, el("button", { class: "btn", text: "Close", onclick: close })));
    }
  }
}

function open2faDisable(body) {
  const { box, close } = openModal(false);
  box.append(el("h3", { class: "modal-title", text: "Disable two-factor authentication" }));
  box.append(el("p", { class: "modal-body muted", text: "Enter your current password to confirm." }));
  const passI = el("input", { type: "password", autocomplete: "current-password", "aria-label": "Current password" });
  box.append(el("label", null, "Password", passI));
  const row = el("div", { class: "modal-actions" });
  const cancelBtn = el("button", { class: "btn ghost", text: "Cancel", onclick: close });
  const goBtn = el("button", { class: "btn danger", text: "Disable 2FA" });
  goBtn.addEventListener("click", async () => {
    if (!passI.value) { toast("Password is required.", "err"); return; }
    goBtn.disabled = true;
    try {
      await api("/admin/2fa/disable", { method: "POST", json: { password: passI.value } });
      toast("Two-factor authentication disabled.", "ok");
      close();
      render2fa(body, renderSeq);
    } catch (err) {
      if (err instanceof AuthError) { close(); toLogin(); return; }
      if (err instanceof ApiError && err.status === 404) toast("This backend build does not support 2FA yet.", "info");
      else toast(err.message || "Disable failed.", "err");
      goBtn.disabled = false;
    }
  });
  row.append(cancelBtn, goBtn);
  box.append(row);
  setTimeout(() => passI.focus(), 50);
}

async function renderSessions(body, seq) {
  let sessions = null;
  try {
    const res = await api("/admin/sessions");
    if (seq !== renderSeq) return;
    sessions = (res && res.data) || (Array.isArray(res) ? res : []);
  } catch (err) {
    if (seq !== renderSeq) return;
    if (err instanceof AuthError) { toLogin(); return; }
    if (err instanceof ApiError && err.status === 404) {
      body.replaceChildren(el("p", { class: "muted", text: "This backend build does not expose a session list yet. Use “Sign out” to end this session." }));
      return;
    }
    body.replaceChildren(el("p", { class: "muted", text: "Could not load sessions: " + err.message }));
    return;
  }
  body.replaceChildren();
  if (!sessions.length) {
    body.append(el("p", { class: "muted", text: "No active sessions reported." }));
  } else {
    body.append(dataTable(
      ["Device / browser", "IP", "Created", "Expires", "Actions"],
      sessions.map((s) => {
        const ua = s.user_agent || s.ua || "";
        const shortUa = ua.length > 42 ? ua.slice(0, 42) + "…" : ua;
        const uaCell = el("span", null);
        const uaSpan = el("span", { text: shortUa || "—" });
        uaSpan.title = ua || "";
        uaCell.append(uaSpan);
        if (s.current === true || s.is_current === true) uaCell.append(el("span", { text: " " }), badge("This session", "info"));
        const act = el("span", null);
        if (!(s.current === true || s.is_current === true)) {
          const rb = el("button", { class: "btn small danger", text: "Revoke" });
          rb.addEventListener("click", () => revokeSession(s.id, false));
          act.append(rb);
        } else {
          act.append(el("span", { class: "muted", text: "—" }));
        }
        return [uaCell, s.ip || "—", fmtDate(s.created_at), fmtDate(s.expires_at), act];
      })
    ));
  }
  const row = el("div", { class: "btn-row" });
  const othersBtn = el("button", { class: "btn", text: "Revoke all other sessions" });
  othersBtn.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Revoke other sessions",
      body: "End every admin session except this one? You will stay signed in here.",
      confirmText: "Revoke others", danger: false
    });
    if (!ok) return;
    try {
      await api("/admin/sessions/revoke-all", { method: "POST", json: { except_current: true } });
      toast("All other sessions revoked.", "ok");
      renderSessions(body, renderSeq);
    } catch (err) {
      if (err instanceof AuthError) { toLogin(); return; }
      if (err instanceof ApiError && err.status === 404) toast("This backend build does not support bulk revocation yet.", "info");
      else toast(err.message || "Revocation failed.", "err");
    }
  });
  const allBtn = el("button", { class: "btn danger", text: "Sign out everywhere" });
  allBtn.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Sign out everywhere",
      body: "End ALL admin sessions, including this one? You will be signed out immediately.",
      confirmText: "Sign out everywhere"
    });
    if (!ok) return;
    try {
      await api("/admin/sessions/revoke-all", { method: "POST", json: {} });
    } catch (err) { /* best effort — still sign out locally */ }
    toLogin("All sessions were revoked. Please sign in again.");
  });
  row.append(othersBtn, allBtn);
  body.append(row);
}

async function revokeSession(id, silent) {
  if (!id) return;
  try {
    await api("/admin/sessions/" + encodeURIComponent(id), { method: "DELETE" });
    if (!silent) { toast("Session revoked.", "ok"); render(); }
  } catch (err) {
    if (err instanceof AuthError) { toLogin(); return; }
    if (err instanceof ApiError && err.status === 404) toast("This backend build does not support session revocation yet.", "info");
    else toast(err.message || "Revocation failed.", "err");
  }
}

/* ================= Audit logs ================= */
async function viewAudit(root, seq) {
  const st = ui.audit;
  const head = el("div", { class: "view-head" },
    el("div", null,
      el("h2", { text: "Audit logs" }),
      el("p", { text: "Sign-ins, publishes, edits, deletes, replies and revocations — who did what, and when." })));
  const list = el("div");
  root.replaceChildren(head, list);
  viewLoading(list, "Loading audit logs…");
  const res = await api("/admin/audit-logs?page=" + st.page + "&per_page=20");
  if (seq !== renderSeq) return;
  const items = (res && res.data) || [];
  list.replaceChildren();
  if (!items.length) {
    list.append(el("div", { class: "state" }, el("div", { class: "big", text: "🧾" }), el("div", { text: "No audit entries yet." })));
  } else {
    list.append(dataTable(
      ["Time", "Actor", "Action", "Target", "Result", "IP"],
      items.map((a) => [
        fmtDate(a.created_at), a.actor || "—", a.action || "—", a.target || "—",
        a.result || "—", a.ip ? String(a.ip).slice(0, 16) + (String(a.ip).length > 16 ? "…" : "") : "—"
      ])
    ));
  }
  list.append(pager(res && res.meta, (p) => { st.page = p; render(); }));
}
ROUTES.audit = viewAudit;
