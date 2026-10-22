// Compare two versions of a document, in the browser.
// Same approach as the self-hosted app (app/compare.py): the exact differences are
// computed here, paragraph by paragraph and then word by word. The AI only gets the
// list of real changes to explain, so it cannot invent one.

const CONTEXT_WORDS = 12;
const MAX_PROMPT_CHARS = 9000;

export function paragraphs(text) {
  return text.replace(/\r/g, "").split(/\n\s*\n/)
    .map((b) => b.split("\n").map((l) => l.trim()).join(" ").replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean);
}

const key = (p) => p.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const words = (t) => t.match(/\s+|\S+/g) || [];

// Myers' diff on two arrays. Returns opcodes like Python's difflib:
// [tag, i1, i2, j1, j2] with tag "equal" | "replace" | "delete" | "insert".
export function opcodes(a, b, maxD = 4000) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const N = A.length, M = B.length, max = N + M;
  const edits = []; // per position: "=" | "-" | "+"
  if (N && M) {
    const off = max + 1;
    let v = new Int32Array(2 * max + 3);
    const trace = [];
    let found = false;
    for (let d = 0; d <= Math.min(max, maxD) && !found; d++) {
      trace.push(v.slice(off - d - 1, off + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && A[x] === B[y]) { x++; y++; }
        v[off + k] = x;
        if (x >= N && y >= M) { found = true; break; }
      }
    }
    if (!found) {
      // Too different to align cheaply: everything in the middle is a replacement.
      return mergeOps([...(pre ? [["equal", 0, pre, 0, pre]] : []), ["replace", pre, pre + N, pre, pre + M],
        ...(suf ? [["equal", pre + N, a.length, pre + M, b.length]] : [])]);
    }
    // Walk back through the saved frontiers.
    let x = N, y = M;
    for (let d = trace.length - 1; d > 0; d--) {
      const t = trace[d]; const at = (k) => t[k + d + 1];
      const k = x - y;
      const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
      const prevX = at(prevK), prevY = prevX - prevK;
      while (x > prevX && y > prevY) { edits.push("="); x--; y--; }
      edits.push(prevK === k + 1 ? "+" : "-");
      if (prevK === k + 1) y--; else x--;
    }
    while (x > 0 && y > 0) { edits.push("="); x--; y--; }
    edits.reverse();
  } else {
    for (let i = 0; i < N; i++) edits.push("-");
    for (let j = 0; j < M; j++) edits.push("+");
  }
  const ops = [];
  if (pre) ops.push(["equal", 0, pre, 0, pre]);
  let i = pre, j = pre;
  let k = 0;
  while (k < edits.length) {
    if (edits[k] === "=") {
      const i0 = i, j0 = j;
      while (k < edits.length && edits[k] === "=") { i++; j++; k++; }
      ops.push(["equal", i0, i, j0, j]);
    } else {
      const i0 = i, j0 = j;
      while (k < edits.length && edits[k] !== "=") { if (edits[k] === "-") i++; else j++; k++; }
      ops.push([i > i0 && j > j0 ? "replace" : i > i0 ? "delete" : "insert", i0, i, j0, j]);
    }
  }
  if (suf) ops.push(["equal", a.length - suf, a.length, b.length - suf, b.length]);
  return mergeOps(ops);
}

function mergeOps(ops) {
  const out = [];
  for (const o of ops) {
    if (o[1] === o[2] && o[3] === o[4]) continue;
    const last = out[out.length - 1];
    if (last && last[0] === "equal" && o[0] === "equal") { last[2] = o[2]; last[4] = o[4]; } else out.push([...o]);
  }
  return out;
}

function ratio(a, b) {
  const x = a.split(" "), y = b.split(" ");
  if (!x.length && !y.length) return 1;
  let same = 0;
  for (const [tag, i1, i2] of opcodes(x, y, 400)) if (tag === "equal") same += i2 - i1;
  return (2 * same) / (x.length + y.length);
}

export function wordDiff(oldText, newText) {
  const a = words(oldText), b = words(newText);
  const parts = [];
  const push = (op, t) => {
    if (!t) return;
    const last = parts[parts.length - 1];
    if (last && last.op === op) last.t += t; else parts.push({ op, t });
  };
  for (const [tag, i1, i2, j1, j2] of opcodes(a, b)) {
    if (tag === "equal") push("=", a.slice(i1, i2).join(""));
    else { push("-", a.slice(i1, i2).join("")); push("+", b.slice(j1, j2).join("")); }
  }
  for (const p of parts) if (p.op !== "=" && !p.t.trim()) p.op = "=";
  const merged = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last && last.op === p.op) last.t += p.t; else merged.push({ ...p });
  }
  return merged;
}

function change(oldP, newP) {
  const parts = oldP && newP ? wordDiff(oldP, newP) : oldP ? [{ op: "-", t: oldP }] : [{ op: "+", t: newP }];
  return { type: "change", old: oldP, new: newP, parts };
}

export function diff(oldText, newText) {
  const a = paragraphs(oldText), b = paragraphs(newText);
  const ka = a.map(key), kb = b.map(key);
  const blocks = [];
  for (const [tag, i1, i2, j1, j2] of opcodes(ka, kb)) {
    if (tag === "equal") { for (const p of b.slice(j1, j2)) blocks.push({ type: "same", text: p }); continue; }
    const olds = a.slice(i1, i2), news = b.slice(j1, j2);
    if (olds.length * news.length > 2500) {
      for (const o of olds) blocks.push(change(o, ""));
      for (const n of news) blocks.push(change("", n));
      continue;
    }
    let j = 0;
    for (const o of olds) {
      let best = -1, bestR = 0.45;
      for (let jj = j; jj < news.length; jj++) {
        const r = ratio(key(o), key(news[jj]));
        if (r > bestR) { best = jj; bestR = r; }
      }
      if (best < 0) { blocks.push(change(o, "")); continue; }
      for (const n of news.slice(j, best)) blocks.push(change("", n));
      blocks.push(change(o, news[best]));
      j = best + 1;
    }
    for (const n of news.slice(j)) blocks.push(change("", n));
  }
  const changes = blocks.filter((x) => x.type === "change");
  const count = (op) => changes.reduce((s, c) => s + c.parts.filter((p) => p.op === op)
    .reduce((t, p) => t + p.t.split(/\s+/).filter(Boolean).length, 0), 0);
  return {
    blocks,
    stats: { changes: changes.length, added_words: count("+"), removed_words: count("-"),
      paragraphs_old: a.length, paragraphs_new: b.length, identical: !changes.length },
  };
}

function snippet(parts) {
  const keep = parts.map((p, i) => {
    if (p.op !== "=") return [p.op, p.t.trim()];
    const w = p.t.split(/\s+/).filter(Boolean);
    const first = i === 0, last = i === parts.length - 1;
    let t;
    if (w.length > 2 * CONTEXT_WORDS && !first && !last) t = w.slice(0, CONTEXT_WORDS).join(" ") + " … " + w.slice(-CONTEXT_WORDS).join(" ");
    else if (first && w.length > CONTEXT_WORDS) t = "… " + w.slice(-CONTEXT_WORDS).join(" ");
    else if (last && w.length > CONTEXT_WORDS) t = w.slice(0, CONTEXT_WORDS).join(" ") + " …";
    else t = p.t.trim();
    return ["=", t];
  });
  return [keep.filter(([op, t]) => op !== "+" && t).map(([, t]) => t).join(" "),
    keep.filter(([op, t]) => op !== "-" && t).map(([, t]) => t).join(" ")];
}

export function changeList(result, limit = MAX_PROMPT_CHARS) {
  const changes = result.blocks.filter((b) => b.type === "change");
  const lines = [];
  let used = 0, shown = 0;
  changes.forEach((c, idx) => {
    if (shown < idx) return; // stopped earlier
    const n = idx + 1;
    let entry;
    if (!c.old) entry = `${n}. ADDED paragraph: ${c.new}`;
    else if (!c.new) entry = `${n}. REMOVED paragraph: ${c.old}`;
    else { const [before, after] = snippet(c.parts); entry = `${n}. CHANGED\n   before: ${before}\n   after:  ${after}`; }
    if (used + entry.length > limit && shown) return;
    lines.push(entry.slice(0, limit));
    used += entry.length;
    shown++;
  });
  if (changes.length > shown) lines.push(`(${changes.length - shown} more changes not listed here.)`);
  return lines.join("\n");
}

export const COMPARE_RULES =
  "You are comparing two versions of a document. The exact list of differences was computed by software and " +
  "is complete; the document text itself is not shown. Explain what changed and what it means for the reader. " +
  "Start with a one-sentence verdict. Then list the important changes first: amounts, prices, dates, deadlines, " +
  "durations, obligations, rights, parties, conditions. Group small wording or typo fixes into one line at the end. " +
  "Quote the old and new values exactly. Refer to changes by their number like [3]. " +
  "Never mention a change that is not in the list. If the list is empty, say the two documents have the same text.";

export function compareMessage(oldName, newName, result, question) {
  const st = result.stats;
  const body = st.identical ? "(no differences)" : changeList(result);
  return `Older version: ${oldName}\nNewer version: ${newName}\n` +
    `${st.changes} changed passages, ${st.added_words} words added, ${st.removed_words} words removed.\n` +
    `<differences>\n${body}\n</differences>\n\nMy request: ${question}`;
}

// Builds DOM nodes (no innerHTML), with a little unchanged text around each change.
export function render(result, context = 1) {
  const blocks = result.blocks;
  const show = blocks.map((b) => b.type === "change");
  const near = blocks.map((_, i) => show.slice(Math.max(0, i - context), i + context + 1).some(Boolean));
  const out = [];
  let hidden = 0, n = 0;
  const skip = () => {
    if (!hidden) return;
    const p = document.createElement("p");
    p.className = "cmp-skip";
    p.textContent = window.i18n ? window.i18n.t("{n} unchanged paragraph|{n} unchanged paragraphs", { n: hidden })
      : `${hidden} unchanged paragraph${hidden > 1 ? "s" : ""}`;
    out.push(p);
    hidden = 0;
  };
  blocks.forEach((b, i) => {
    if (b.type === "change") n++;
    if (!near[i]) { hidden++; return; }
    skip();
    const p = document.createElement("p");
    if (b.type === "same") { p.className = "cmp-same"; p.textContent = b.text; out.push(p); return; }
    p.className = "cmp-change " + (!b.old ? "cmp-add" : !b.new ? "cmp-del" : "cmp-chg");
    p.dataset.n = n;
    for (const part of b.parts) {
      if (part.op === "=") p.append(part.t);
      else p.append(Object.assign(document.createElement(part.op === "-" ? "del" : "ins"), { textContent: part.t }));
    }
    out.push(p);
  });
  skip();
  return out;
}

export const COMPARE_WORDS = /(\bcompar|\bvergleich|\bunterschied|\bdifferences?\b|what('?s| has| have)? changed|was (hat|ist) sich\b.*\bge(ä|ae)ndert|welche (ä|ae)nderungen|(ä|ae)nderungen zwischen|changes between|\bdiff\b)/i;

export function detectCompare(text, docs) {
  if (docs.length < 2 || !COMPARE_WORDS.test(text)) return null;
  const t = text.toLowerCase();
  const stem = (n) => n.replace(/\.[^.]+$/, "").toLowerCase();
  const named = docs.filter((d) => t.includes(stem(d.name)) || t.includes(d.name.toLowerCase()));
  const pick = named.length >= 2 ? named.slice(0, 2) : docs.slice(-2);
  return pick.map((d) => d.id);
}
