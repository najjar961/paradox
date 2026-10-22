"use strict";

const $ = (sel) => document.querySelector(sel);
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
    let msg = `Request failed (${res.status})`;
    try { const j = await res.json(); if (j.detail) msg = typeof j.detail === "string" ? j.detail : msg; } catch {}
    throw new Error(msg);
  }
  return raw ? res : res.json();
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
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
  $("#login-error").textContent = message;
  $("#login-form").password.value = "";
}

async function enterApp(me) {
  state.me = me;
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  $("#who").textContent = me.username;
  $("#idle-note").textContent = `Data is wiped on sign-out or after ${me.idle_minutes} min idle.`;
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
    $("#login-error").textContent = err.message;
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
    b.textContent = w.name;
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
    $("#ws-title").textContent = "No workspace";
    $("#messages").replaceChildren(emptyState(true));
    renderDocs();
    return;
  }
  $("#ws-title").textContent = ws.name;
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
      note.textContent = "Stopped.";
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
    h.textContent = "Create a workspace to begin";
    p.textContent = "Use the + button in the sidebar.";
  } else {
    h.textContent = "Upload a document, then ask or edit";
    p.textContent = "Open Documents to add a PDF, Word file or text. Ask questions, or say \u201crewrite this more formally\u201d and download the result. Nothing is saved.";
  }
  d.append(h, p);
  return d;
}

$("#new-ws").addEventListener("click", async () => {
  const name = prompt("Workspace name", "New workspace");
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
  if (!state.current || !confirm(`Delete "${state.current.name}" and everything in it?`)) return;
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
    meta.textContent = `${d.chunks} ${d.chunks === 1 ? "chunk" : "chunks"}`;
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "Remove";
    del.setAttribute("aria-label", `Remove ${d.name}`);
    del.addEventListener("click", async () => {
      await api(`/api/workspaces/${state.current.id}/documents/${d.id}`, { method: "DELETE" });
      await loadWorkspaces(state.current.id);
    });
    if (!d.kind) { li.append(name, meta, del); return li; }
    const row = document.createElement("div");
    row.className = "doc-row";
    row.append(name, meta, del);
    const tools = document.createElement("div");
    tools.className = "doc-tools";
    if (d.scanned) meta.textContent = "scan · text recognised";
    if (d.form) {
      const fill = Object.assign(document.createElement("button"), { type: "button", className: "link-btn", textContent: "Fill in form" });
      fill.addEventListener("click", () => openForm(d));
      tools.append(fill);
    }
    const redact = Object.assign(document.createElement("button"), { type: "button", className: "link-btn", textContent: "Remove personal data" });
    redact.addEventListener("click", () => openRedaction(d));
    tools.append(redact);
    li.className = "doc-item";
    li.append(row, tools);
    return li;
  });
  for (const p of pending) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name pending";
    name.textContent = `${p} — processing…`;
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
      toast(`${file.name}: ${err.message}`);
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
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; }
    catch { copy.textContent = "Copy failed"; }
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  });
  row.append(copy);

  for (const [fmt, label] of [["pdf", "PDF"], ["docx", "Word"], ["txt", "Text"]]) {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = `Download as ${label}`;
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
  $("#modal-title").textContent = title;
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
      const img = el("img", { src: `data:image/png;base64,${pg.png}`, alt: `Page ${pg.page + 1}` });
      const wrap = el("div", { className: "pv-page" }, img);
      for (const m of pv.marks.filter((x) => x.page === pg.page)) {
        const [x0, y0, x1, y1] = m.rect;
        const box = el("i", { className: black ? "pv-mark pv-black" : "pv-mark" });
        Object.assign(box.style, { left: `${(x0 / pg.width) * 100}%`, top: `${(y0 / pg.height) * 100}%`,
          width: `${((x1 - x0) / pg.width) * 100}%`, height: `${((y1 - y0) / pg.height) * 100}%` });
        wrap.append(box);
      }
      wrap.append(el("span", { className: "pv-num", textContent: `Page ${pg.page + 1}` }));
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
  const tabA = el("button", { type: "button", className: "seg", textContent: "After" });
  const tabB = el("button", { type: "button", className: "seg", textContent: "Before" });
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
  const b = el("button", { type: "button", className: "primary", textContent: `Download ${result.filename}` });
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
  msgEl.querySelectorAll(".actions button").forEach((b) => { if (b.textContent !== "Copy") b.remove(); });

  const stamp = Date.now();
  const rows = changes.map((c, i) => {
    const box = el("input", { type: "checkbox", checked: c.status !== "fail", id: `chg-${stamp}-${i}` });
    box.setAttribute("aria-label", `Include change ${i + 1}`);
    const status = el("span", { className: "chg-status", textContent: c.message || "" });
    const li = el("li", { className: c.status === "fail" ? "fail" : c.status ? "ok" : "" }, box,
      el("label", { htmlFor: box.id }, el("del", { textContent: c.find }), el("ins", { textContent: c.replace || "(removed)" }), status));
    return { box, status, li };
  });
  const btn = el("button", { type: "button", className: "primary", textContent: target ? `Preview changes to ${target.name}` : "Preview changes" });
  const actions = el("div", { className: "changes-actions" }, target ? btn
    : el("small", { className: "muted", textContent: "Upload the original file to apply these changes." }));
  textEl.append(el("div", { className: "changes" },
    el("div", { className: "changes-head", textContent: `${changes.length} ${changes.length === 1 ? "change" : "changes"} to your original file` }),
    el("ol", {}, ...rows.map((r) => r.li)), actions));
  if (!target) return;

  btn.addEventListener("click", async () => {
    const idx = changes.map((_, i) => i).filter((i) => rows[i].box.checked);
    if (!idx.length) { toast("Select at least one change."); return; }
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Preparing preview…";
    try {
      const res = await api(`/api/workspaces/${state.current.id}/documents/${target.id}/preview`, {
        method: "POST", body: { changes: idx.map((i) => ({ find: changes[i].find, replace: changes[i].replace })) } });
      res.report.forEach((r) => {
        const row = rows[idx[r.index]];
        row.li.className = r.ok ? "ok" : "fail";
        row.status.textContent = r.ok ? (r.note ? `Ready, ${r.note}.` : "Ready.") : `Can't be applied: ${r.reason}.`;
      });
      const ok = res.report.filter((r) => r.ok).length;
      if (!ok) { toast("None of the changes could be applied. See the list for details."); return; }
      openModal("Preview of your edited file",
        previewView(previewViews(res.preview, res.highlight, false),
          ok < res.report.length ? `${ok} of ${res.report.length} changes applied.` : "Changed text is highlighted."),
        [el("button", { type: "button", className: "ghost", textContent: "Back", onclick: closeModal }), downloadButton(res, target.kind)]);
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
    placeholder: "Optional: tell Paradox what to fill in, e.g. your name, address, date of birth." });
  const useDocs = el("input", { type: "checkbox", id: "form-docs", checked: others.length > 0, disabled: !others.length });
  const suggest = el("button", { type: "button", className: "ghost", textContent: "Fill with AI" });
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
  const go = el("button", { type: "button", className: "primary", textContent: "Preview filled form" });
  openModal(`Fill in ${d.name}`,
    [el("div", { className: "form-ai" }, info,
      el("div", { className: "form-ai-row" },
        el("label", { className: "switch", htmlFor: "form-docs" }, useDocs,
          el("span", { textContent: others.length ? `Use my other documents (${others.length})` : "No other documents uploaded" })),
        suggest)),
     el("p", { className: "small muted", textContent: `${fields.length} fields. Check every value before you download.` }), list],
    [el("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: closeModal }), go]);

  suggest.addEventListener("click", async () => {
    suggest.disabled = true;
    suggest.textContent = "Filling…";
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
      toast(n ? `Filled ${n} ${n === 1 ? "field" : "fields"}. Please check them.` : "Paradox found nothing to fill in. Add details above.");
    } catch (err) {
      if (err.message !== "unauthorised") toast(err.message);
    } finally {
      suggest.disabled = false;
      suggest.textContent = "Fill with AI";
    }
  });

  go.addEventListener("click", async () => {
    const values = {};
    for (const [name, { f, input }] of inputs) {
      if (f.type === "checkbox") values[name] = input.checked;
      else if (input.value !== "") values[name] = input.value;
    }
    go.disabled = true;
    go.textContent = "Filling in…";
    try {
      const res = await api(`/api/workspaces/${state.current.id}/documents/${d.id}/form/fill`, { method: "POST", body: { values } });
      openModal(`Preview: ${d.name} filled in`, previewView(previewViews(res.preview, [], false), "Filled fields are highlighted. The fields stay editable."),
        [el("button", { type: "button", className: "ghost", textContent: "Back", onclick: () => { closeModal(); openForm(d); } }),
         downloadButton(res, "pdf")]);
    } catch (err) {
      if (err.message !== "unauthorised") toast(err.message);
      go.disabled = false;
      go.textContent = "Preview filled form";
    }
  });
}

// ---- remove personal data

const PII_LABELS = { name: "Names", address: "Addresses", email: "Email addresses", phone: "Phone numbers",
  iban: "Bank accounts (IBAN)", card: "Card numbers", birthdate: "Dates of birth", id: "ID and tax numbers", custom: "Your own words" };

async function openRedaction(d) {
  const status = el("p", { className: "muted", textContent: "Looking for personal data…" });
  const groups = el("div", { className: "pii-groups" });
  const add = el("input", { type: "text", id: "pii-add", placeholder: "Add a word or name to remove", maxLength: 200 });
  const addBtn = el("button", { type: "button", className: "ghost", textContent: "Add" });
  const go = el("button", { type: "button", className: "primary", textContent: "Preview redaction", disabled: true });
  openModal(`Remove personal data from ${d.name}`,
    [el("p", { className: "small muted", textContent: "Everything you tick is blacked out and removed from the file itself, not just hidden. The author and other hidden properties are wiped too. Automatic detection can miss things, so check the preview and add anything that is still visible." }),
     status, groups, el("div", { className: "pii-add" }, add, addBtn)],
    [el("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: closeModal }), go]);

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
    status.textContent = items.length ? `Found ${items.length} ${items.length === 1 ? "item" : "items"}. Untick anything that should stay.`
      : "No personal data found automatically. Add words to remove below.";
    if (!res.model_used) status.textContent += " The AI model was not reachable, so names and addresses were only found by pattern.";
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
      openModal(`Preview: ${d.name} without personal data`,
        previewView(previewViews(res.preview, res.highlight, true),
          `${total} ${total === 1 ? "place" : "places"} removed.` + (missed.length ? ` Not found in the file: ${missed.join(", ")}.` : "")),
        [el("button", { type: "button", className: "ghost", textContent: "Back", onclick: () => { closeModal(); openRedaction(d); } }),
         downloadButton(res, d.kind)]);
    } catch (err) {
      if (err.message !== "unauthorised") toast(err.message);
      go.disabled = false;
      go.textContent = "Preview redaction";
    }
  });
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
    chip.addEventListener("click", () => showSource(msgEl, s.id));
    row.append(chip);
  }
  msgEl.append(row);
}

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
    : `[${s.id}] ${s.document}, part ${s.chunk} (relevance ${s.score})\n`;
  box.replaceChildren(title, document.createTextNode(s.excerpt + (s.excerpt.length >= 400 ? "…" : "")));
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
  sendBtn.textContent = on ? "Stop" : "Send";
  sendBtn.classList.toggle("stop", on);
  sendBtn.type = on ? "button" : "submit";
  sendBtn.setAttribute("aria-label", on ? "Stop the answer" : "Send");
}

sendBtn.addEventListener("click", (e) => {
  if (state.busy && controller) { e.preventDefault(); controller.abort(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.busy && controller) controller.abort();
});

$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || state.busy || !state.current) return;
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
      method: "POST", body: { message: text, keep_layout: !$("#layout-row").hidden && $("#keep-layout").checked }, raw: true, signal: controller.signal,
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
      textEl.textContent = err.message;
      answer = "";
    }
  } finally {
    textEl.classList.remove("cursor");
    if (stopped) {
      const note = document.createElement("p");
      note.className = "stopped";
      note.textContent = answer ? "Stopped." : "Stopped before Paradox started writing.";
      textEl.append(note);
    }
    if (answer) {
      attachSources(reply, sources);
      attachActions(reply, answer, sources[0]?.document);
      renderChanges(reply, answer, checked);
      ws.history.push({ role: "user", content: text }, { role: "assistant", content: answer + (stopped ? "\n\n[stopped]" : "") });
    }
    controller = null;
    setStreaming(false);
    input.focus();
  }
});

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
