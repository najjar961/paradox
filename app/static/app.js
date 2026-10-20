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

function renderDocs(pending = []) {
  const docs = state.current?.documents || [];
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
    li.append(name, meta, del);
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
  try {
    const res = await api(`/api/workspaces/${ws.id}/chat`, {
      method: "POST", body: { message: text }, raw: true, signal: controller.signal,
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
