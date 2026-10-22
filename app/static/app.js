"use strict";

const $ = (sel) => document.querySelector(sel);
const tr = window.i18n.t;
// The server names the first workspace "My workspace"; show that default in the page language.
const wsName = (n) => (n === "My workspace" ? tr(n) : n);
const state = { me: null, workspaces: [], current: null, busy: false };

// ------------------------------------------------------------------ api

async function api(path, { method = "GET", body, headers = {}, raw = false, signal } = {}) {
  const opts = { method, headers: { ...headers }, credentials: "same-origin", signal };
  if (state.me && method !== "GET") opts.headers["X-CSRF-Token"] = state.me.csrf;
  if (body !== undefined) {
    if (body instanceof Blob) {
      opts.body = body;
    } else {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(path, opts);
  if (res.status === 401 && path !== "/api/login") {
    showLogin("Your session ended, so its data was wiped. Please sign in again.");
    throw new Error("unauthorised");
  }
  if (!res.ok) {
    let msg = tr("Request failed ({status})", { status: res.status });
    try { const j = await res.json(); if (j.detail) msg = typeof j.detail === "string" ? j.detail : msg; } catch {}
    throw new Error(msg);
  }
  return raw ? res : res.json();
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = tr(msg);
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3500);
}

// ------------------------------------------------------------------ auth

function showLogin(message = "") {
  state.me = null;
  state.workspaces = [];
  state.current = null;
  $("#messages").replaceChildren();
  $("#app-view").hidden = true;
  $("#login-view").hidden = false;
  $("#login-error").dataset.en = message;
  $("#login-error").textContent = tr(message);
  $("#login-form").password.value = "";
}

async function enterApp(me) {
  state.me = me;
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  $("#who").textContent = me.username;
  $("#idle-note").textContent = tr("Data is wiped on sign-out or after {n} min idle.", { n: me.idle_minutes });
  $("#model-tag").textContent = `${me.provider} · ${me.model}`;
  $("#supported").textContent = `${me.supported.join(" ")} · max ${me.max_upload_mb} MB`;
  await loadWorkspaces();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector("button");
  btn.disabled = true;
  $("#login-error").textContent = "";
  try {
    const me = await api("/api/login", { method: "POST", body: { username: f.username.value.trim(), password: f.password.value } });
    f.password.value = "";
    await enterApp(me);
  } catch (err) {
    $("#login-error").textContent = tr(err.message);
  } finally {
    btn.disabled = false;
  }
});

$("#logout").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  showLogin("Signed out. Your documents and chats were wiped.");
});

// ------------------------------------------------------------------ workspaces

async function loadWorkspaces(selectId) {
  state.workspaces = await api("/api/workspaces");
  const id = selectId || state.current?.id || state.workspaces[0]?.id;
  state.current = state.workspaces.find((w) => w.id === id) || state.workspaces[0] || null;
  renderSidebar();
  renderWorkspace();
}

function renderSidebar() {
  const list = $("#ws-list");
  list.replaceChildren(...state.workspaces.map((w) => {
    const b = document.createElement("button");
    b.textContent = wsName(w.name);
    if (state.current && w.id === state.current.id) b.classList.add("active");
    b.addEventListener("click", () => {
      state.current = w;
      renderSidebar();
      renderWorkspace();
      document.querySelector(".sidebar").classList.remove("open");
    });
    return b;
  }));
}

function renderWorkspace() {
  const ws = state.current;
  if (!ws) {
    $("#ws-title").textContent = tr("No workspace");
    $("#messages").replaceChildren(emptyState(true));
    renderDocs();
    return;
  }
  $("#ws-title").textContent = wsName(ws.name);
  $("#ws-name").value = ws.name;
  $("#ws-prompt").value = ws.system_prompt || "";
  const box = $("#messages");
  box.replaceChildren();
  if (!ws.history.length) box.append(emptyState(false));
  for (const m of ws.history) {
    if (m.role === "user") { box.append(userBubble(m.content)); continue; }
    const stoppedMsg = m.content.endsWith("[stopped]");
    const body = stoppedMsg ? m.content.replace(/\s*\[stopped\]$/, "") : m.content;
    const b = assistantBubble(body);
    if (stoppedMsg) {
      const note = document.createElement("p");
      note.className = "stopped";
      note.textContent = tr("Stopped.");
      b.querySelector(".text").append(note);
    }
    attachActions(b, body, ws.documents[0]?.name);
    renderChanges(b, body, null);
    box.append(b);
  }
  box.scrollTop = box.scrollHeight;
  renderDocs();
}

function emptyState(noWorkspace) {
  const d = document.createElement("div");
  d.className = "empty";
  const h = document.createElement("h3");
  const p = document.createElement("p");
  if (noWorkspace) {
    h.textContent = tr("Create a workspace to begin");
    p.textContent = tr("Use the + button in the sidebar.");
  } else {
    h.textContent = tr("Upload a document, then ask or edit");
    p.textContent = tr("Open Documents to add a PDF, Word file or text. Ask questions, or say “rewrite this more formally” and download the result. Nothing is saved.");
  }
  d.append(h, p);
  return d;
}

$("#new-ws").addEventListener("click", async () => {
  const name = prompt(tr("Workspace name"), tr("New workspace"));
  if (!name || !name.trim()) return;
  try {
    const ws = await api("/api/workspaces", { method: "POST", body: { name: name.trim() } });
    await loadWorkspaces(ws.id);
  } catch (err) { toast(err.message); }
});

$("#ws-title").addEventListener("click", () => { if (state.current) openPanel("settings"); });

$("#save-settings").addEventListener("click", async () => {
  if (!state.current) return;
  try {
    const ws = await api(`/api/workspaces/${state.current.id}`, {
      method: "PATCH", body: { name: $("#ws-name").value.trim() || state.current.name, system_prompt: $("#ws-prompt").value },
    });
    await loadWorkspaces(ws.id);
    toast("Saved for this session.");
  } catch (err) { toast(err.message); }
});

$("#clear-chat").addEventListener("click", async () => {
  if (!state.current) return;
  await api(`/api/workspaces/${state.current.id}/history`, { method: "DELETE" });
  await loadWorkspaces(state.current.id);
});

$("#delete-ws").addEventListener("click", async () => {
  if (!state.current || !confirm(tr("Delete \"{name}\" and everything in it?", { name: state.current.name }))) return;
  await api(`/api/workspaces/${state.current.id}`, { method: "DELETE" });
  state.current = null;
  openPanel(null);
  await loadWorkspaces();
});

// ------------------------------------------------------------------ panels

function openPanel(which) {
  $("#docs-panel").hidden = which !== "docs";
  $("#settings-panel").hidden = which !== "settings";
}
$("#toggle-docs").addEventListener("click", () => openPanel($("#docs-panel").hidden ? "docs" : null));
$("#toggle-settings").addEventListener("click", () => openPanel($("#settings-panel").hidden ? "settings" : null));
$("#menu").addEventListener("click", () => document.querySelector(".sidebar").classList.toggle("open"));

// ------------------------------------------------------------------ documents

function editableDocs() {
  return (state.current?.documents || []).filter((d) => d.editable);
}

function renderDocs(pending = []) {
  const docs = state.current?.documents || [];
  $("#layout-row").hidden = !docs.some((d) => d.editable);
  $("#doc-count").textContent = docs.length;
  const list = $("#doc-list");
  const items = docs.map((d) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = d.name;
    name.title = d.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = tr("{n} chunk|{n} chunks", { n: d.chunks });
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "Remove";
    del.setAttribute("aria-label", `Remove ${d.name}`);
    del.addEventListener("click", async () => {
      await api(`/api/workspaces/${state.current.id}/documents/${d.id}`, { method: "DELETE" });
      await loadWorkspaces(state.current.id);
    });
    const row = document.createElement("div");
    row.className = "doc-row";
    row.append(name, meta, del);
    const tools = document.createElement("div");
    tools.className = "doc-tools";
    if (d.scanned) meta.textContent = tr("scan · text recognised");
    if (d.form) {
      const fill = Object.assign(document.createElement("button"), { type: "button", className: "link-btn", textContent: tr("Fill in form") });
      fill.addEventListener("click", () => openForm(d));
      tools.append(fill);
    }
    if (d.kind) {
      const redact = Object.assign(document.createElement("button"), { type: "button", className: "link-btn", textContent: tr("Remove personal data") });
      redact.addEventListener("click", () => openRedaction(d));
      tools.append(redact);
    }
    if (docs.length > 1) {
      const cmp = Object.assign(document.createElement("button"), { type: "button", className: "link-btn", textContent: tr("Compare") });
      cmp.addEventListener("click", () => openCompare(d));
      tools.append(cmp);
    }
    li.className = "doc-item";
    li.append(row);
    if (tools.childElementCount) li.append(tools);
    return li;
  });
  for (const p of pending) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name pending";
    name.textContent = `${p} — ${tr("processing…")}`;
    li.append(name);
    items.push(li);
  }
  list.replaceChildren(...items);
}

async function uploadFiles(files) {
  if (!state.current || !files.length) return;
  const wsId = state.current.id;
  const pending = [...files].map((f) => f.name);
  renderDocs(pending);
  for (const file of files) {
    try {
      await api(`/api/workspaces/${wsId}/documents`, {
        method: "POST", body: file, headers: { "X-Filename": encodeURIComponent(file.name), "Content-Type": "application/octet-stream" },
      });
    } catch (err) {
      toast(`${file.name}: ${tr(err.message)}`);
    }
    pending.shift();
    if (state.current?.id === wsId) renderDocs(pending);
  }
  await loadWorkspaces(wsId);
}

const drop = $("#drop");
$("#file-input").addEventListener("change", (e) => { uploadFiles([...e.target.files]); e.target.value = ""; });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); uploadFiles([...e.dataTransfer.files]); });

// ------------------------------------------------------------------ chat rendering

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Minimal, safe markdown: everything is escaped first, then a few patterns are re-styled.
function renderMarkdown(src) {
  const blocks = escapeHtml(src).replace(/\n[ \t]*-{3,}[ \t]*(?=\n|$)/g, "\n\n---\n\n").split(/```/);
  return blocks.map((part, i) => {
    if (i % 2 === 1) {
      const body = part.replace(/^[a-zA-Z0-9_-]*\n/, "");
      return `<pre><code>${body}</code></pre>`;
    }
    return part.split(/\n{2,}/).filter((p) => p.trim()).map((p) => {
      if (/^\s*-{3,}\s*$/.test(p)) return '<hr class="sep">';
      let h = p
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[(\d{1,2})\]/g, '<button class="cite" data-cite="$1">$1</button>')
        .replace(/\n/g, "<br>");
      return `<p>${h}</p>`;
    }).join("");
  }).join("");
}

function userBubble(text) {
  const d = document.createElement("div");
  d.className = "msg user";
  d.textContent = text;
  return d;
}

function assistantBubble(text, sources = []) {
  const d = document.createElement("div");
  d.className = "msg assistant";
  const t = document.createElement("div");
  t.className = "text";
  t.innerHTML = renderMarkdown(text);
  d.append(t);
  attachSources(d, sources);
  return d;
}

// Copy and download buttons for an answer. Files are built in server memory and streamed back; nothing is kept.
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function attachActions(msgEl, text, docName) {
  msgEl.querySelector(".actions")?.remove();
  if (!text.trim()) return;
  const stem = `${(docName || "paradox").replace(/\.[^.]+$/, "")}_paradox`;
  const row = document.createElement("div");
  row.className = "actions";

  const copy = document.createElement("button");
  copy.textContent = tr("Copy");
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); copy.textContent = tr("Copied"); }
    catch { copy.textContent = tr("Copy failed"); }
    setTimeout(() => (copy.textContent = tr("Copy")), 1500);
  });
  row.append(copy);

  for (const [fmt, label] of [["pdf", "PDF"], ["docx", "Word"], ["txt", "Text"]]) {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = tr("Download as {format}", { format: label });
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const res = await api("/api/export", { method: "POST", body: { text, format: fmt, filename: stem }, raw: true });
        saveBlob(await res.blob(), `${stem}.${fmt}`);
      } catch (err) {
        if (err.message !== "unauthorised") toast(err.message);
      } finally {
        b.disabled = false;
      }
    });
    row.append(b);
  }
  msgEl.append(row);
}

// ------------------------------------------------------------------ layout-preserving edits

const CHANGE_RE = /FIND\s*:\s*([\s\S]+?)\s*\n\s*REPLACE\s*:[ \t]*([\s\S]*?)(?=\n\s*FIND\s*:|\n\s*-{3,}\s*(?:\n|$)|$)/gi;
const WRAP = "\"'`„“”‚‘’«»";

function unwrap(s) {
  s = s.trim();
  while (s.length >= 2 && WRAP.includes(s[0]) && WRAP.includes(s[s.length - 1])) s = s.slice(1, -1).trim();
  return s;
}

function parseChanges(answer) {
  const text = answer.replace(/\r\n/g, "\n").replace(/\*\*|__/g, "");
  const out = [];
  for (const m of text.matchAll(CHANGE_RE)) {
    const find = unwrap(m[1]), replace = unwrap(m[2]);
    if (find && find !== replace) out.push({ find, replace });
  }
  const first = text.search(/FIND\s*:/i);
  return { intro: first > 0 ? text.slice(0, first).trim() : "", changes: out };
}

// ---- modal

let modalReturn = null;
function el(tag, props = {}, ...children) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children.filter((c) => c != null));
  return n;
}
function openModal(title, body, actions) {
  modalReturn = document.activeElement;
  $("#modal-title").textContent = tr(title);
  $("#modal-body").replaceChildren(...[].concat(body));
  $("#modal-foot").replaceChildren(...[].concat(actions || []));
  $("#modal").hidden = false;
  document.body.classList.add("modal-open");
  $("#modal-close").focus();
}
function closeModal() {
  if ($("#modal").hidden) return;
  $("#modal").hidden = true;
  document.body.classList.remove("modal-open");
  $("#modal-body").replaceChildren();
  modalReturn?.focus?.();
}
$("#modal-close").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

const MIME = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function markText(root, needles, cls) {
  const terms = needles.filter((t) => t && t.trim().length > 1);
  if (!terms.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    for (const t of terms) {
      const i = node.data.indexOf(t);
      if (i < 0) continue;
      const hit = node.splitText(i);
      hit.splitText(t.length);
      const mark = el("mark", { className: cls });
      hit.parentNode.replaceChild(mark, hit);
      mark.append(hit);
      break;
    }
  }
}

// Build Before/After views from the server's preview data.
function previewViews(pv, highlight, black) {
  if (pv.kind === "pdf") {
    const render = (pages) => pages.map((pg) => {
      const img = el("img", { src: `data:image/png;base64,${pg.png}`, alt: tr("Page {n}", { n: pg.page + 1 }) });
      const wrap = el("div", { className: "pv-page" }, img);
      for (const m of pv.marks.filter((x) => x.page === pg.page)) {
        const [x0, y0, x1, y1] = m.rect;
        const box = el("i", { className: black ? "pv-mark pv-black" : "pv-mark" });
        Object.assign(box.style, { left: `${(x0 / pg.width) * 100}%`, top: `${(y0 / pg.height) * 100}%`,
          width: `${((x1 - x0) / pg.width) * 100}%`, height: `${((y1 - y0) / pg.height) * 100}%` });
        wrap.append(box);
      }
      wrap.append(el("span", { className: "pv-num", textContent: tr("Page {n}", { n: pg.page + 1 }) }));
      return wrap;
    });
    return { after: render(pv.after), before: render(pv.before) };
  }
  const html = (h, needles) => {
    const div = el("div", { className: "pv-docx" });
    div.innerHTML = h;
    div.querySelectorAll("script,style,iframe,object").forEach((n) => n.remove());
    markText(div, needles, "pv-hl");
    return [div];
  };
  return { after: html(pv.after_html, highlight), before: html(pv.before_html, []) };
}

function previewView(views, note) {
  const stage = el("div", { className: "pv-stage" });
  const tabA = el("button", { type: "button", className: "seg", textContent: tr("After") });
  const tabB = el("button", { type: "button", className: "seg", textContent: tr("Before") });
  const show = (which) => {
    stage.replaceChildren(...views[which]);
    tabA.setAttribute("aria-pressed", which === "after");
    tabB.setAttribute("aria-pressed", which === "before");
  };
  tabA.addEventListener("click", () => show("after"));
  tabB.addEventListener("click", () => show("before"));
  show("after");
  return [el("div", { className: "pv-bar" }, el("div", { className: "segs" }, tabA, tabB),
    note ? el("span", { className: "muted small", textContent: note }) : null), stage];
}

function downloadButton(result, kind) {
  const b = el("button", { type: "button", className: "primary", textContent: tr("Download {name}", { name: result.filename }) });
  b.addEventListener("click", () => {
    saveBlob(new Blob([b64ToBytes(result.file)], { type: MIME[kind] }), result.filename);
    toast("Your file is downloading.");
  });
  return b;
}

// ---- edits (checked by the server)

function renderChanges(msgEl, answer, checked) {
  const { intro, changes: parsed } = parseChanges(answer.replace(/\s*\[stopped\]$/, ""));
  if (!parsed.length) return;
  const changes = checked?.changes?.length ? checked.changes : parsed.map((c) => ({ ...c, status: "", message: "" }));
  const target = editableDocs().find((d) => d.id === checked?.doc_id) || editableDocs()[0];
  const textEl = msgEl.querySelector(".text");
  textEl.innerHTML = intro ? renderMarkdown(intro) : "";
  msgEl.querySelectorAll(".actions button").forEach((b) => { if (b.textContent !== tr("Copy")) b.remove(); });

  const stamp = Date.now();
  const rows = changes.map((c, i) => {
    const box = el("input", { type: "checkbox", checked: c.status !== "fail", id: `chg-${stamp}-${i}` });
    box.setAttribute("aria-label", tr("Include change {n}", { n: i + 1 }));
    const status = el("span", { className: "chg-status", textContent: tr(c.message || "") });
    const li = el("li", { className: c.status === "fail" ? "fail" : c.status ? "ok" : "" }, box,
      el("label", { htmlFor: box.id }, el("del", { textContent: c.find }), el("ins", { textContent: c.replace || tr("(removed)") }), status));
    return { box, status, li };
  });
  const btn = el("button", { type: "button", className: "primary", textContent: target ? tr("Preview changes to {name}", { name: target.name }) : tr("Preview changes") });
  const actions = el("div", { className: "changes-actions" }, target ? btn
    : el("small", { className: "muted", textContent: tr("Upload the original file to apply these changes.") }));
  textEl.append(el("div", { className: "changes" },
    el("div", { className: "changes-head", textContent: tr("{n} change to your original file|{n} changes to your original file", { n: changes.length }) }),
    el("ol", {}, ...rows.map((r) => r.li)), actions));
  if (!target) return;

  btn.addEventListener("click", async () => {
    const idx = changes.map((_, i) => i).filter((i) => rows[i].box.checked);
    if (!idx.length) { toast("Select at least one change."); return; }
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = tr("Preparing preview…");
    try {
      const res = await api(`/api/workspaces/${state.current.id}/documents/${target.id}/preview`, {
        method: "POST", body: { changes: idx.map((i) => ({ find: changes[i].find, replace: changes[i].replace })) } });
      res.report.forEach((r) => {
        const row = rows[idx[r.index]];
        row.li.className = r.ok ? "ok" : "fail";
        row.status.textContent = r.ok ? (r.note ? tr("Ready, {note}.", { note: tr(r.note) }) : tr("Ready.")) : tr("Can't be applied: {reason}.", { reason: tr(r.reason) });
      });
      const ok = res.report.filter((r) => r.ok).length;
      if (!ok) { toast("None of the changes could be applied. See the list for details."); return; }
      openModal("Preview of your edited file",
        previewView(previewViews(res.preview, res.highlight, false),
          ok < res.report.length ? tr("{ok} of {n} changes applied.", { ok, n: res.report.length }) : tr("Changed text is highlighted.")),
        [el("button", { type: "button", className: "ghost", textContent: tr("Back"), onclick: closeModal }), downloadButton(res, target.kind)]);
    } catch (err) {
      if (err.message !== "unauthorised") toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

// ---- fill in PDF forms

async function openForm(d) {
  let fields;
  try {
    fields = (await api(`/api/workspaces/${state.current.id}/documents/${d.id}/form`)).fields;
  } catch (err) { if (err.message !== "unauthorised") toast(err.message); return; }
  const others = (state.current.documents || []).filter((x) => x.id !== d.id);
  const info = el("textarea", { id: "form-info", rows: 3, maxLength: 8000,
    placeholder: tr("Optional: tell Paradox what to fill in, e.g. your name, address, date of birth.") });
  const useDocs = el("input", { type: "checkbox", id: "form-docs", checked: others.length > 0, disabled: !others.length });
  const suggest = el("button", { type: "button", className: "ghost", textContent: tr("Fill with AI") });
  const inputs = new Map();
  const list = el("div", { className: "form-fields" }, ...fields.map((f, i) => {
    const id = `ff-${i}`;
    let input;
    if (f.type === "checkbox") input = el("input", { type: "checkbox", id, checked: !!f.value });
    else if (f.type === "choice" || f.type === "radio") {
      input = el("select", { id }, el("option", { value: "", textContent: "—" }),
        ...(f.options || []).map((o) => el("option", { value: o, textContent: o, selected: o === f.value })));
    } else input = el("input", { type: "text", id, value: f.value || "", maxLength: 500 });
    inputs.set(f.name, { f, input });
    return el("div", { className: `form-row ${f.type === "checkbox" ? "is-check" : ""}` },
      el("label", { htmlFor: id, textContent: f.label }), input);
  }));
  const go = el("button", { type: "button", className: "primary", textContent: tr("Preview filled form") });
  openModal(tr("Fill in {name}", { name: d.name }),
    [el("div", { className: "form-ai" }, info,
      el("div", { className: "form-ai-row" },
        el("label", { className: "switch", htmlFor: "form-docs" }, useDocs,
          el("span", { textContent: others.length ? tr("Use my other documents ({n})", { n: others.length }) : tr("No other documents uploaded") })),
        suggest)),
     el("p", { className: "small muted", textContent: tr("{n} fields. Check every value before you download.", { n: fields.length }) }), list],
    [el("button", { type: "button", className: "ghost", textContent: tr("Cancel"), onclick: closeModal }), go]);

  suggest.addEventListener("click", async () => {
    suggest.disabled = true;
    suggest.textContent = tr("Filling…");
    try {
      const res = await api(`/api/workspaces/${state.current.id}/documents/${d.id}/form/suggest`,
        { method: "POST", body: { info: info.value, use_documents: useDocs.checked } });
      let n = 0;
      for (const [name, v] of Object.entries(res.values)) {
        const x = inputs.get(name);
        if (!x) continue;
        if (x.f.type === "checkbox") x.input.checked = !!v; else x.input.value = String(v);
        x.input.closest(".form-row").classList.add("ai-filled");
        n++;
      }
      toast(n ? tr("Filled {n} field. Please check it.|Filled {n} fields. Please check them.", { n }) : tr("Paradox found nothing to fill in. Add details above."));
    } catch (err) {
      if (err.message !== "unauthorised") toast(err.message);
    } finally {
      suggest.disabled = false;
      suggest.textContent = tr("Fill with AI");
    }
  });

  go.addEventListener("click", async () => {
    const values = {};
    for (const [name, { f, input }] of inputs) {
      if (f.type === "checkbox") values[name] = input.checked;
      else if (input.value !== "") values[name] = input.value;
    }
    go.disabled = true;
    go.textContent = tr("Filling in…");
    try {
      const res = await api(`/api/workspaces/${state.current.id}/documents/${d.id}/form/fill`, { method: "POST", body: { values } });
      openModal(tr("Preview: {name} filled in", { name: d.name }), previewView(previewViews(res.preview, [], false), "Filled fields are highlighted. The fields stay editable."),
        [el("button", { type: "button", className: "ghost", textContent: tr("Back"), onclick: () => { closeModal(); openForm(d); } }),
         downloadButton(res, "pdf")]);
    } catch (err) {
      if (err.message !== "unauthorised") toast(err.message);
      go.disabled = false;
      go.textContent = tr("Preview filled form");
    }
  });
}

// ---- remove personal data

const PII_LABELS = { name: "Names", address: "Addresses", email: "Email addresses", phone: "Phone numbers",
  iban: "Bank accounts (IBAN)", card: "Card numbers", birthdate: "Dates of birth", id: "ID and tax numbers", custom: "Your own words" };

async function openRedaction(d) {
  const status = el("p", { className: "muted", textContent: tr("Looking for personal data…") });
  const groups = el("div", { className: "pii-groups" });
  const add = el("input", { type: "text", id: "pii-add", placeholder: tr("Add a word or name to remove"), maxLength: 200 });
  const addBtn = el("button", { type: "button", className: "ghost", textContent: tr("Add") });
  const go = el("button", { type: "button", className: "primary", textContent: tr("Preview redaction"), disabled: true });
  openModal(tr("Remove personal data from {name}", { name: d.name }),
    [el("p", { className: "small muted", textContent: tr("Everything you tick is blacked out and removed from the file itself, not just hidden. The author and other hidden properties are wiped too. Automatic detection can miss things, so check the preview and add anything that is still visible.") }),
     status, groups, el("div", { className: "pii-add" }, add, addBtn)],
    [el("button", { type: "button", className: "ghost", textContent: tr("Cancel"), onclick: closeModal }), go]);

  const items = [];
  const lists = new Map();
  const addItem = (type, value) => {
    if (items.some((x) => x.value === value)) return;
    if (!lists.has(type)) {
      const ul = el("ul", {});
      lists.set(type, ul);
      groups.append(el("fieldset", { className: "pii-group" }, el("legend", { textContent: PII_LABELS[type] || type }), ul));
    }
    const id = `pii-${items.length}-${Date.now()}`;
    const box = el("input", { type: "checkbox", checked: true, id });
    lists.get(type).append(el("li", {}, box, el("label", { htmlFor: id, textContent: value })));
    items.push({ value, box });
    go.disabled = false;
  };
  const doAdd = () => { const v = add.value.trim(); if (v) { addItem("custom", v); add.value = ""; add.focus(); } };
  addBtn.addEventListener("click", doAdd);
  add.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doAdd(); } });

  try {
    const res = await api(`/api/workspaces/${state.current.id}/documents/${d.id}/pii`, { method: "POST", body: {} });
    res.items.forEach((x) => addItem(x.type, x.value));
    status.textContent = items.length ? tr("Found {n} item. Untick anything that should stay.|Found {n} items. Untick anything that should stay.", { n: items.length })
      : tr("No personal data found automatically. Add words to remove below.");
    if (!res.model_used) status.textContent += tr(" The AI model was not reachable, so names and addresses were only found by pattern.");
  } catch (err) {
    if (err.message !== "unauthorised") status.textContent = err.message;
  }

  go.addEventListener("click", async () => {
    const terms = items.filter((x) => x.box.checked).map((x) => x.value);
    if (!terms.length) { toast("Select at least one item."); return; }
    go.disabled = true;
    go.textContent = "Redacting…";
    try {
      const res = await api(`/api/workspaces/${state.current.id}/documents/${d.id}/redact`, { method: "POST", body: { terms } });
      const total = res.counts.reduce((a, b) => a + b, 0);
      const missed = terms.filter((_, i) => !res.counts[i]);
      openModal(tr("Preview: {name} without personal data", { name: d.name }),
        previewView(previewViews(res.preview, res.highlight, true),
          tr("{n} place removed.|{n} places removed.", { n: total }) + (missed.length ? " " + tr("Not found in the file: {list}.", { list: missed.join(", ") }) : "")),
        [el("button", { type: "button", className: "ghost", textContent: tr("Back"), onclick: () => { closeModal(); openRedaction(d); } }),
         downloadButton(res, d.kind)]);
    } catch (err) {
      if (err.message !== "unauthorised") toast(err.message);
      go.disabled = false;
      go.textContent = tr("Preview redaction");
    }
  });
}

// ------------------------------------------------------------------ compare two documents

const COMPARE_WORDS = /(\bcompar|\bvergleich|\bunterschied|\bdifferences?\b|what('?s| has| have)? changed|was (hat|ist) sich\b.*\bge(ä|ae)ndert|welche (ä|ae)nderungen|(ä|ae)nderungen zwischen|changes between|\bdiff\b)/i;

function docStem(name) {
  return name.replace(/\.[^.]+$/, "").toLowerCase();
}

// "What changed between v1 and v2?" with two or more documents: compare instead of searching.
function detectCompare(text, docs) {
  if (docs.length < 2 || !COMPARE_WORDS.test(text)) return null;
  const t = text.toLowerCase();
  const named = docs.filter((d) => t.includes(docStem(d.name)) || t.includes(d.name.toLowerCase()));
  const pick = named.length >= 2 ? named.slice(0, 2) : docs.slice(-2);
  return pick.map((d) => d.id); // upload order: the earlier file is treated as the older version
}

async function openCompare(d, otherId) {
  const docs = state.current.documents;
  const others = docs.filter((x) => x.id !== d.id);
  const pickOld = el("select", { id: "cmp-old" });
  const pickNew = el("select", { id: "cmp-new" });
  for (const x of docs) {
    pickOld.append(el("option", { value: x.id, textContent: x.name }));
    pickNew.append(el("option", { value: x.id, textContent: x.name }));
  }
  const other = otherId ? docs.find((x) => x.id === otherId) : others[others.length - 1];
  const dIsOlder = docs.indexOf(d) < docs.indexOf(other);
  pickOld.value = dIsOlder ? d.id : other.id;
  pickNew.value = dIsOlder ? other.id : d.id;
  const swap = el("button", { type: "button", className: "ghost small", textContent: tr("⇄ Swap") });
  const summary = el("p", { className: "cmp-stats muted" });
  const view = el("div", { className: "cmp-view" });
  const explain = el("button", { type: "button", className: "primary", textContent: tr("Explain the changes") });

  async function run() {
    if (pickOld.value === pickNew.value) {
      summary.textContent = tr("Pick two different documents.");
      view.replaceChildren();
      explain.disabled = true;
      return;
    }
    summary.textContent = tr("Comparing…");
    explain.disabled = true;
    try {
      const r = await api(`/api/workspaces/${state.current.id}/compare`, { method: "POST", body: { old_id: pickOld.value, new_id: pickNew.value } });
      const st = r.stats;
      summary.textContent = st.identical
        ? tr("The text of both documents is identical.")
        : tr("{n} changed passage|{n} changed passages", { n: st.changes }) + " · " + tr("{n} words added", { n: st.added_words }) + " · " + tr("{n} words removed", { n: st.removed_words });
      view.innerHTML = r.html; // built server-side from escaped text
      explain.disabled = false;
    } catch (err) {
      summary.textContent = tr(err.message);
    }
  }
  pickOld.addEventListener("change", run);
  pickNew.addEventListener("change", run);
  swap.addEventListener("click", () => { [pickOld.value, pickNew.value] = [pickNew.value, pickOld.value]; run(); });
  explain.addEventListener("click", () => {
    const a = docs.find((x) => x.id === pickOld.value), b = docs.find((x) => x.id === pickNew.value);
    closeModal();
    send(tr("What changed from {a} to {b}, and what does it mean for me?", { a: a.name, b: b.name }), [a.id, b.id]);
  });
  const legend = el("p", { className: "small muted cmp-legend" },
    el("del", { textContent: tr("removed") }), " ", el("ins", { textContent: tr("added") }), " · " + tr("compared word by word on this server"));
  openModal("Compare documents", el("div", { className: "cmp" },
    el("div", { className: "cmp-pick" },
      el("label", {}, el("span", { className: "small muted", textContent: tr("Older version") }), pickOld), swap,
      el("label", {}, el("span", { className: "small muted", textContent: tr("Newer version") }), pickNew)),
    summary, legend, view), [explain]);
  await run();
}

function attachSources(msgEl, sources) {
  msgEl._sources = sources;
  msgEl.querySelector(".sources")?.remove();
  msgEl.querySelector(".source-detail")?.remove();
  if (!sources.length) return;
  const row = document.createElement("div");
  row.className = "sources";
  for (const s of sources) {
    const chip = document.createElement("button");
    chip.className = "source-chip";
    chip.textContent = s.chunk == null ? `[${s.id}] ${s.document} · full document` : `[${s.id}] ${s.document} · part ${s.chunk}`;
    if (s.match) chip.title = matchLabel(s.match);
    chip.addEventListener("click", () => showSource(msgEl, s.id));
    row.append(chip);
  }
  msgEl.append(row);
}

const MATCH = { meaning: "Found by meaning", keywords: "Found by keywords", both: "Found by meaning and keywords" };
const matchLabel = (m) => (MATCH[m] ? tr(MATCH[m]) : "");

function showSource(msgEl, id) {
  const s = (msgEl._sources || []).find((x) => String(x.id) === String(id));
  if (!s) return;
  let box = msgEl.querySelector(".source-detail");
  if (box && box.dataset.id === String(id)) { box.remove(); return; }
  if (!box) { box = document.createElement("div"); box.className = "source-detail"; msgEl.append(box); }
  box.dataset.id = String(id);
  const title = document.createElement("b");
  title.textContent = s.chunk == null
    ? `[${s.id}] ${s.document}, full document (beginning shown)\n`
    : `[${s.id}] ${s.document}, part ${s.chunk} · ${matchLabel(s.match) || "relevance " + s.score}\n`;
  box.replaceChildren(title, document.createTextNode(s.excerpt + (s.chunk == null && s.excerpt.length >= 400 ? "…" : "")));
}

$("#messages").addEventListener("click", (e) => {
  const c = e.target.closest(".cite");
  if (c) showSource(c.closest(".msg"), c.dataset.cite);
});

// ------------------------------------------------------------------ chat send

const input = $("#chat-input");
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; });
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#chat-form").requestSubmit(); }
});

const sendBtn = $("#send");
let controller = null;

function setStreaming(on) {
  state.busy = on;
  sendBtn.textContent = on ? tr("Stop") : tr("Send");
  sendBtn.classList.toggle("stop", on);
  sendBtn.type = on ? "button" : "submit";
  sendBtn.setAttribute("aria-label", on ? tr("Stop the answer") : tr("Send"));
}

sendBtn.addEventListener("click", (e) => {
  if (state.busy && controller) { e.preventDefault(); controller.abort(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.busy && controller) controller.abort();
});

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || state.busy || !state.current) return;
  send(text, detectCompare(text, state.current.documents || []));
});

async function send(text, comparePair = null) {
  if (state.busy || !state.current) return;
  const ws = state.current;
  controller = new AbortController();
  setStreaming(true);
  input.value = "";
  input.style.height = "auto";

  const box = $("#messages");
  box.querySelector(".empty")?.remove();
  box.append(userBubble(text));
  const reply = assistantBubble("");
  const textEl = reply.querySelector(".text");
  textEl.classList.add("cursor");
  box.append(reply);
  box.scrollTop = box.scrollHeight;

  let answer = "";
  let sources = [];
  let stopped = false;
  let checked = null;
  try {
    const res = await api(`/api/workspaces/${ws.id}/chat`, {
      method: "POST", raw: true, signal: controller.signal, body: {
        message: text, keep_layout: !comparePair && !$("#layout-row").hidden && $("#keep-layout").checked,
        ...(comparePair ? { compare: comparePair } : {}),
      },
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === "sources") sources = ev.sources;
        else if (ev.type === "token") { answer += ev.text; textEl.innerHTML = renderMarkdown(answer); }
        else if (ev.type === "changes") checked = ev;
        else if (ev.type === "error") throw new Error(ev.message);
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
        if (nearBottom) box.scrollTop = box.scrollHeight;
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      stopped = true;
    } else if (err.message !== "unauthorised") {
      reply.classList.add("error");
      textEl.textContent = tr(err.message);
      answer = "";
    }
  } finally {
    textEl.classList.remove("cursor");
    if (stopped) {
      const note = document.createElement("p");
      note.className = "stopped";
      note.textContent = answer ? tr("Stopped.") : tr("Stopped before Paradox started writing.");
      textEl.append(note);
    }
    if (answer) {
      attachSources(reply, sources);
      attachActions(reply, answer, sources[0]?.document);
      if (comparePair) attachCompare(reply, comparePair);
      else renderChanges(reply, answer, checked);
      ws.history.push({ role: "user", content: text }, { role: "assistant", content: answer + (stopped ? "\n\n[stopped]" : "") });
    }
    controller = null;
    setStreaming(false);
    input.focus();
  }
}

function attachCompare(msgEl, [oldId, newId]) {
  const docs = state.current.documents;
  const a = docs.find((x) => x.id === oldId), b = docs.find((x) => x.id === newId);
  if (!a || !b) return;
  const btn = el("button", { type: "button", className: "source-chip wide", textContent: tr("Compared {a} → {b} · show differences", { a: a.name, b: b.name }) });
  btn.addEventListener("click", () => openCompare(a, b.id));
  msgEl.append(el("div", { className: "sources" }, btn));
}

// ------------------------------------------------------------------ language

// Re-label the page in place; reloading is avoided so nothing on screen is lost.
function relabel() {
  window.i18n.apply(document);
  const login = $("#login-error");
  if (login.dataset.en) login.textContent = tr(login.dataset.en);
  if (state.me) $("#idle-note").textContent = tr("Data is wiped on sign-out or after {n} min idle.", { n: state.me.idle_minutes });
  if (!state.current) $("#ws-title").textContent = tr("No workspace");
  else $("#ws-title").textContent = wsName(state.current.name);
  renderSidebar();
  const empty = $("#messages .empty");
  if (empty) empty.replaceWith(emptyState(!state.current));
  if (!state.busy) { $("#send").textContent = tr("Send"); }
  else setStreaming(true);
  renderDocs();
  const other = window.i18n.lang === "de" ? "en" : "de";
  $("#lang").textContent = other.toUpperCase();
  $("#lang").setAttribute("aria-label", other === "de" ? "Sprache: Deutsch" : "Language: English");
  $("#lang-login").textContent = other === "de" ? "Deutsch" : "English";
}
const switchLang = () => window.i18n.set(window.i18n.lang === "de" ? "en" : "de");
$("#lang").addEventListener("click", switchLang);
$("#lang-login").addEventListener("click", switchLang);
window.i18n.onChange(relabel);
relabel();

// ------------------------------------------------------------------ boot

(async () => {
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    if (res.ok) await enterApp(await res.json());
    else showLogin();
  } catch {
    showLogin("Server unreachable.");
  }
})();
