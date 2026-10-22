// Layout-preserving edits for Paradox Lite: apply FIND/REPLACE changes to the original
// PDF or Word file inside the browser. Mirrors app/layout_edit.py in the self-hosted version.
//
// PDF:  the affected lines are removed with a real redaction (the old text is gone from the
//       file, not covered) and the new text is drawn in the same place, size and colour,
//       using the PDF's own font when it has every needed letter.
// DOCX: only the words that change are replaced inside the existing runs, so bold, colours,
//       styles, tables, headers and footers stay as they were.

// ------------------------------------------------------------------ parsing

const CHANGE_RE = /FIND\s*:\s*([\s\S]+?)\s*\n\s*REPLACE\s*:[ \t]*([\s\S]*?)(?=\n\s*FIND\s*:|\n\s*-{3,}\s*(?:\n|$)|$)/gi;
const WRAP = "\"'`„“”‚‘’«»";

function unwrap(s) {
  s = s.trim();
  while (s.length >= 2 && WRAP.includes(s[0]) && WRAP.includes(s[s.length - 1])) s = s.slice(1, -1).trim();
  return s;
}

export function parseChanges(answer) {
  const text = answer.replace(/\r\n/g, "\n").replace(/\*\*|__/g, "");
  const changes = [];
  for (const m of text.matchAll(CHANGE_RE)) {
    const find = unwrap(m[1]), replace = unwrap(m[2]);
    if (find && find !== replace) changes.push({ find, replace });
  }
  const first = text.search(/FIND\s*:/i);
  return { intro: first > 0 ? text.slice(0, first).trim() : "", changes };
}

// ------------------------------------------------------------------ matching

const TRANS = { "‘": "'", "’": "'", "‚": "'", "‛": "'", "“": '"', "”": '"', "„": '"',
  "«": '"', "»": '"', "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-",
  " ": " ", "­": "", "ﬁ": "fi", "ﬂ": "fl" };
const EDGE = /^[.,;:!?"'()[\]{}<>*_]+|[.,;:!?"'()[\]{}<>*_]+$/g;

export function norm(token) {
  const t = token.normalize("NFKC").replace(/[‘’‚‛“”„«»‐-— ­ﬁﬂ]/g, (c) => TRANS[c]).toLowerCase();
  return t.replace(EDGE, "") || t;
}

export function tokens(text) {
  return text.split(/\s+/).map(norm).filter(Boolean);
}

function lcs(a, b) {
  const m = b.length;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[m];
}

const PUNCT = ".,;:!?\"')]}»“”’";
const OPEN = "\"'([{«„‚“‘";
const esc = (x) => x.replace(/[\\\]\[^-]/g, "\\$&");

export function keptPunct(firstWord, lastWord, find) {
  find = find.trim();
  const l = new RegExp(`^[${esc(OPEN)}]+`).exec(firstWord);
  const t = new RegExp(`[${esc(PUNCT)}]+$`).exec(lastWord);
  return [l && !find.startsWith(l[0]) ? l[0] : "", t && !find.endsWith(t[0]) ? t[0] : ""];
}

export function findSpan(hay, needle) {
  const n = needle.length;
  if (!n || !hay.length) return null;
  outer: for (let i = 0; i + n <= hay.length; i++) {
    for (let k = 0; k < n; k++) if (hay[i + k] !== needle[k]) continue outer;
    return [i, i + n];
  }
  if (n < 3) return null;
  const anchors = new Set([...needle.slice(0, 3), ...needle.slice(-3)]);
  let best = 0, span = null;
  for (const len of new Set([n - 2, n - 1, n, n + 1, n + 2])) {
    if (len < 1) continue;
    for (let i = 0; i + len <= hay.length; i++) {
      if (!anchors.has(hay[i]) && !anchors.has(hay[i + len - 1])) continue;
      const window = hay.slice(i, i + len);
      const r = (2 * lcs(window, needle)) / (len + n);
      if (r > best) { best = r; span = [i, i + len]; }
    }
  }
  return best >= 0.8 ? span : null;
}

// Token-level diff opcodes (like Python's difflib get_opcodes), via LCS.
function diffOps(a, b) {
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  const push = (tag, i1, i2, j1, j2) => {
    const last = ops[ops.length - 1];
    if (last && last[0] === tag) { last[2] = i2; last[4] = j2; } else ops.push([tag, i1, i2, j1, j2]);
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { push("equal", i, i + 1, j, j + 1); i++; j++; }
    else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) { push("change", i, i, j, j + 1); j++; }
    else { push("change", i, i + 1, j, j); i++; }
  }
  return ops;
}

// ------------------------------------------------------------------ PDF

function rectOf(ws) {
  return { x0: Math.min(...ws.map((w) => w.x0)), y0: Math.min(...ws.map((w) => w.y0)),
    x1: Math.max(...ws.map((w) => w.x1)), y1: Math.max(...ws.map((w) => w.y1)) };
}

function pageWords(page) {
  const words = [];
  let block = -1, line = -1, cur = null;
  const flush = () => { if (cur && cur.t.trim()) words.push(cur); cur = null; };
  const st = page.toStructuredText("preserve-whitespace");
  st.walk({
    beginTextBlock() { block++; },
    beginLine() { flush(); line++; },
    endLine() { flush(); },
    onChar(c, origin, font, size, quad, color) {
      if (/\s/.test(c)) { flush(); return; }
      const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
      const r = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      if (!cur) cur = { t: "", ...r, line, block, font, size, color, oy: origin[1] };
      cur.t += c;
      cur.x0 = Math.min(cur.x0, r.x0); cur.y0 = Math.min(cur.y0, r.y0);
      cur.x1 = Math.max(cur.x1, r.x1); cur.y1 = Math.max(cur.y1, r.y1);
    },
  });
  flush();
  return words;
}

function units(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], nx = words[i + 1];
    if (nx && w.t.endsWith("-") && w.t.length > 2 && nx.line !== w.line && /\p{L}/u.test(w.t[w.t.length - 2])) {
      out.push([norm(w.t.slice(0, -1) + nx.t), i, i + 1]); i++;
    } else out.push([norm(w.t), i, i]);
  }
  return out.filter((u) => u[0]);
}

function wrapText(text, measure, width) {
  const lines = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let cur = "";
    for (const w of words) {
      const cand = cur ? `${cur} ${w}` : w;
      if (measure(cand) <= width) { cur = cand; continue; }
      if (cur) lines.push(cur);
      if (measure(w) <= width) { cur = w; continue; }
      let piece = "";
      for (const ch of w) {
        if (measure(piece + ch) > width && piece) { lines.push(piece); piece = ch; } else piece += ch;
      }
      cur = piece;
    }
    lines.push(cur);
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines;
}

function toRgb(color) {
  if (!color || !color.length) return [0, 0, 0];
  if (color.length === 1) return [color[0], color[0], color[0]];
  if (color.length === 4) { const [c, m, y, k] = color; return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]; }
  return color.slice(0, 3);
}

function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

const fmt = (n) => (Math.round(n * 1000) / 1000).toString();

function hasAll(font, text) {
  for (const ch of text) if (!/\s/.test(ch) && !font.encodeCharacter(ch)) return false;
  return true;
}

function fontKey(name) {
  return (name.split("+").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function applyPdfChange(mupdf, doc, change, ctx) {
  const all = [];
  for (let p = 0; p < doc.countPages(); p++) {
    const page = doc.loadPage(p);
    for (const w of pageWords(page)) all.push({ ...w, page: p });
  }
  const us = units(all);
  const span = findSpan(us.map((u) => u[0]), tokens(change.find));
  if (!span) return "not found in the file";
  const i0 = us[span[0]][1], i1 = us[span[1] - 1][2];
  if (all[i0].page !== all[i1].page) return "the text runs across two pages; change each page separately";
  const pno = all[i0].page;
  const page = doc.loadPage(pno);
  const ctm = page.getTransform();
  if (Math.abs(ctm[1]) > 1e-6 || Math.abs(ctm[2]) > 1e-6) return "rotated pages are not supported yet";

  const offset = all.findIndex((w) => w.page === pno);
  const pw = all.filter((w) => w.page === pno);
  const j0 = i0 - offset, j1 = i1 - offset;
  const lineKeys = [...new Set(pw.slice(j0, j1 + 1).map((w) => w.line))];
  const first = lineKeys[0], last = lineKeys[lineKeys.length - 1];
  const prefix = pw.filter((w, k) => w.line === first && k < j0).map((w) => w.t).join(" ");
  const suffix = pw.filter((w, k) => w.line === last && k > j1).map((w) => w.t).join(" ");
  const [lead, trail] = keptPunct(pw[j0].t, pw[j1].t, change.find);
  const replacement = change.replace.trim() ? lead + change.replace.trim() + trail : "";
  const newText = [prefix, replacement, suffix].filter(Boolean).join(" ");

  const allKeys = [...new Set(pw.map((w) => w.line))];
  const rects = new Map(allKeys.map((k) => [k, rectOf(pw.filter((w) => w.line === k))]));
  const lineRects = lineKeys.map((k) => rects.get(k));

  // Visual paragraphs: consecutive lines sharing a left edge (or centre) with a small gap.
  const order = [...allKeys].sort((a, b) => rects.get(a).y0 - rects.get(b).y0 || rects.get(a).x0 - rects.get(b).x0);
  const groups = [], groupOf = new Map();
  for (const k of order) {
    const r = rects.get(k);
    let target = null;
    for (const g of groups) {
      const q = rects.get(g[g.length - 1]);
      const gap = r.y0 - q.y1;
      const same = Math.abs(r.x0 - q.x0) < 2 || Math.abs((r.x0 + r.x1) / 2 - (q.x0 + q.x1) / 2) < 1.5;
      if (same && gap > -1 && gap < 0.6 * Math.max(q.y1 - q.y0, 1) && Math.min(r.x1, q.x1) > Math.max(r.x0, q.x0)) { target = g; break; }
    }
    if (!target) { target = []; groups.push(target); }
    target.push(k);
    groupOf.set(k, target);
  }
  const blockLines = [...new Set(lineKeys.flatMap((k) => groupOf.get(k)))].sort((a, b) => rects.get(a).y0 - rects.get(b).y0);
  const blockRects = blockLines.map((k) => rects.get(k));

  const area = { x0: Math.min(...lineRects.map((r) => r.x0)), y0: lineRects[0].y0,
    x1: Math.max(...blockRects.map((r) => r.x1), ...lineRects.map((r) => r.x1)), y1: lineRects[lineRects.length - 1].y1 };
  const bx0 = Math.min(...blockRects.map((r) => r.x0)), bx1 = Math.max(...blockRects.map((r) => r.x1));
  const lefts = blockRects.every((r) => Math.abs(r.x0 - bx0) < 1.5);
  const rights = blockRects.every((r) => Math.abs(r.x1 - bx1) < 1.5);
  const full = blockRects.slice(0, -1).filter((r) => Math.abs(r.x1 - bx1) < 2 && Math.abs(r.x0 - bx0) < 2);
  const lastR = blockRects[blockRects.length - 1];
  const pageW = page.getBounds()[2] - page.getBounds()[0];
  // The column's right edge: the furthest any line starting at this paragraph's left edge reaches.
  const sameColumn = [...rects.values()].filter((r) => Math.abs(r.x0 - bx0) < 2);
  const columnRight = Math.max(...sameColumn.map((r) => r.x1));
  const atColumnRight = sameColumn.filter((r) => Math.abs(r.x1 - columnRight) < 2).length;
  const justified = (blockRects.length > 2 && lefts && full.length === blockRects.length - 1 && lastR.x1 < bx1 - 0.05 * (bx1 - bx0))
    || (blockRects.length === 2 && lefts && Math.abs(blockRects[0].x1 - columnRight) < 2 && atColumnRight >= 2
      && lastR.x1 < bx1 - 0.05 * (bx1 - bx0) && blockRects[0].x1 - blockRects[0].x0 > pageW * 0.5);
  const lastIsParaEnd = blockLines.indexOf(last) === blockLines.length - 1;
  let align = "left";
  if (!justified) {
    if (blockRects.length > 1) {
      if (rights && !lefts) align = "right";
      else if (!lefts && !rights && blockRects.every((r) => Math.abs((r.x0 + r.x1) / 2 - (bx0 + bx1) / 2) < 1.5)) align = "center";
    } else {
      const r = lineRects[0];
      const others = allKeys.filter((k) => !lineKeys.includes(k)).map((k) => rects.get(k));
      const nR = others.filter((o) => Math.abs(o.x1 - r.x1) < 1.5).length;
      const nL = others.filter((o) => Math.abs(o.x0 - r.x0) < 1.5).length;
      const nC = others.filter((o) => Math.abs((o.x0 + o.x1) / 2 - (r.x0 + r.x1) / 2) < 1.5).length;
      if (nR > nL && nR >= nC) align = "right"; else if (nC > nL && nC > nR) align = "center";
    }
  }
  const band = (w) => !lineKeys.includes(w.line) && w.y1 > area.y0 + 1 && w.y0 < area.y1 - 1;
  if (align === "left" && !justified) {
    const right = pw.filter((w) => band(w) && w.x0 >= area.x1 - 0.5);
    area.x1 = Math.max(area.x1, right.length ? Math.min(...right.map((w) => w.x0)) - 6 : Math.max(...pw.map((w) => w.x1)));
  } else if (align === "right") {
    const left = pw.filter((w) => band(w) && w.x1 <= area.x0 + 0.5);
    area.x0 = Math.min(area.x0, left.length ? Math.max(...left.map((w) => w.x1)) + 6 : Math.min(...pw.map((w) => w.x0)));
  }

  const w0 = pw[j0];
  const size = w0.size;
  let ratio = 1.2;
  if (blockRects.length > 1) {
    const gap = (blockRects[blockRects.length - 1].y0 - blockRects[0].y0) / (blockRects.length - 1);
    ratio = Math.min(Math.max(gap / size, 1.05), 1.8);
  }

  // Font: the PDF's own, else a built-in look-alike, else a Unicode font.
  const fname = w0.font.getName();
  const serif = /times|serif|roman|georgia|garamond|cambria|minion|book antiqua|palatino/i.test(fname) && !/sans/i.test(fname);
  const bold = w0.font.isBold() || /bold|black/i.test(fname);
  let font = null, scaleFix = 1;
  if (hasAll(w0.font, newText)) font = w0.font;
  if (!font) {
    // A font with the same letter widths (Calibri -> Carlito, Arial -> Liberation Sans, ...).
    const sub = await ctx.substitute(fname, bold);
    if (sub && hasAll(sub, newText)) font = sub;
  }
  if (!font) {
    const base = new mupdf.Font(serif ? (bold ? "Times-Bold" : "Times-Roman") : (bold ? "Helvetica-Bold" : "Helvetica"));
    if (hasAll(base, newText)) font = base;
    else {
      const uni = await ctx.load(bold ? "DejaVuSans-Bold.ttf" : "DejaVuSans.ttf");
      if (uni && hasAll(uni, newText)) font = uni;
    }
    if (!font) return "the new text uses characters no available font has";
    const sample = pw.filter((w) => lineKeys.includes(w.line));
    const origW = sample.reduce((a, w) => a + (w.x1 - w.x0), 0);
    const ours = sample.reduce((a, w) => a + measureWith(font, w.t, size), 0);
    if (ours) scaleFix = Math.min(Math.max(origW / ours, 0.85), 1.15);
  }

  const fits = (height, s, slack = 0.3) => {
    const lines = wrapText(newText, (t) => measureWith(font, t, s), area.x1 - area.x0);
    const needed = (lines.length - 1) * size * ratio * (s / size) + s * 1.15;
    return [lines, needed <= height + s * slack];
  };
  let plan = null;
  const base = size * scaleFix;
  for (const sc of [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7]) {
    const [lines, ok] = fits(area.y1 - area.y0, base * sc);
    if (ok) { plan = [lines, base * sc]; break; }
  }
  if (!plan) {
    const below = pw.filter((w) => w.y0 >= area.y1 - 1 && w.x1 > area.x0 && w.x0 < area.x1 && !lineKeys.includes(w.line)).map((w) => w.y0);
    const limit = below.length ? Math.min(...below) - size * 0.35 : page.getBounds()[3] - 36;
    for (const sc of [1, 0.9, 0.8, 0.7]) {
      const [lines, ok] = fits(limit - area.y0, base * sc, -0.1);
      if (ok) { plan = [lines, base * sc]; break; }
    }
  }
  if (!plan) return "the new text is too long for the space in the layout";
  const [lines, s] = plan;

  // Remove the old lines for real.
  for (const r of lineRects) {
    const inset = (r.y1 - r.y0) * 0.18;
    const annot = page.createAnnotation("Redact");
    annot.setRect([r.x0 - 0.5, r.y0 + inset, r.x1 + 0.5, r.y1 - inset]);
  }
  page.applyRedactions(false, 0, 0, 0);

  // Draw the new text in PDF coordinates.
  const inv = invert(page.getTransform());
  const toPdf = (x, y) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]];
  const fontName = ctx.register(doc, page, font);
  const [r, g, b] = toRgb(w0.color);
  const firstLineWords = pw.filter((w) => w.line === first);
  let y = Math.abs(s - size) < 0.01 ? firstLineWords[0].oy : lineRects[0].y0 + s * 0.8;
  const step = s < size ? size * ratio * (s / size) : size * ratio;
  const width = area.x1 - area.x0;
  const ops = [`q BT /${fontName} ${fmt(s)} Tf ${fmt(r)} ${fmt(g)} ${fmt(b)} rg`];
  const hexOf = (text) => { let h = ""; for (const ch of text) h += font.encodeCharacter(ch).toString(16).padStart(4, "0"); return h; };
  const put = (x, yy, text) => {
    const [px, py] = toPdf(x, yy);
    ops.push(`1 0 0 1 ${fmt(px)} ${fmt(py)} Tm <${hexOf(text)}> Tj`);
  };
  // Justified line as one TJ: real space glyphs (so copy/paste works) plus the extra gap.
  const putJustified = (x, yy, words, gap) => {
    const [px, py] = toPdf(x, yy);
    const space = font.encodeCharacter(" ") ? measureWith(font, " ", s) : 0;
    const extra = -((gap - space) / s) * 1000;
    const parts = words.map((w, k) => `<${hexOf(w)}>` + (k < words.length - 1 ? (space ? ` <${hexOf(" ")}>` : "") + ` ${fmt(extra)}` : ""));
    ops.push(`1 0 0 1 ${fmt(px)} ${fmt(py)} Tm [${parts.join(" ")}] TJ`);
  };
  lines.forEach((line, n) => {
    const isLast = n === lines.length - 1;
    let justify = justified && line && (!isLast || !lastIsParaEnd);
    if (isLast && justified && !lastIsParaEnd && lines.length < lineRects.length) justify = false;
    if (line) {
      const words = line.split(/\s+/);
      const mw = (t) => measureWith(font, t, s);
      const gap = words.length > 1 ? (width - words.reduce((a, w) => a + mw(w), 0)) / (words.length - 1) : 0;
      if (justify && words.length > 1 && gap > mw(" ") * 0.6) {
        putJustified(area.x0, y, words, gap);
      } else {
        const lw = mw(line);
        const x = area.x0 + (align === "right" ? width - lw : align === "center" ? (width - lw) / 2 : 0);
        put(x, y, line);
      }
    }
    y += step;
  });
  ops.push("ET Q");
  ctx.appendContent(doc, page, ops.join("\n"));
  if (s < size * 0.92) change._note = "set in a smaller size so it fits the original space";
  change._mark = { page: pno, rect: [area.x0, area.y0, area.x1, Math.max(area.y1, y - step + s * 0.3)] };
  return null;
}

function measureWith(font, text, size) {
  let w = 0;
  for (const ch of text) w += font.advanceGlyph(font.encodeCharacter(ch));
  return w * size;
}

const FAMILIES = [ // [match in the PDF font name, regular file, bold file]
  ["calibri", "Carlito-Regular.ttf", "Carlito-Bold.ttf"], ["carlito", "Carlito-Regular.ttf", "Carlito-Bold.ttf"],
  ["arial", "LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf"], ["helvetica", "LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf"],
  ["liberationsans", "LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf"],
  ["timesnewroman", "LiberationSerif-Regular.ttf", "LiberationSerif-Bold.ttf"], ["times", "LiberationSerif-Regular.ttf", "LiberationSerif-Bold.ttf"],
  ["liberationserif", "LiberationSerif-Regular.ttf", "LiberationSerif-Bold.ttf"],
  ["dejavusans", "DejaVuSans.ttf", "DejaVuSans-Bold.ttf"],
];

// loadFont(file) returns the bytes of a font from the bundled fonts folder (or null).
export async function applyPdf(mupdf, bytes, changes, { loadFont } = {}) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  if (doc.needsPassword?.()) throw new Error("This PDF is password-protected.");
  let n = 0;
  const fontRefs = new Map(), loaded = new Map();
  const ctx = {
    async load(file) {
      if (!loaded.has(file)) {
        let f = null;
        try { const b = loadFont && await loadFont(file); if (b) f = new mupdf.Font(file.replace(/\.ttf$/, ""), b); } catch { f = null; }
        loaded.set(file, f);
      }
      return loaded.get(file);
    },
    async substitute(name, bold) {
      const key = fontKey(name);
      const fam = FAMILIES.find(([m]) => key.includes(m));
      return fam ? this.load(bold ? fam[2] : fam[1]) : null;
    },
    register(d, page, font) {
      let ref = fontRefs.get(font);
      if (!ref) { ref = d.addFont(font); fontRefs.set(font, ref); }
      const pageObj = page.getObject();
      let res = pageObj.get("Resources");
      if (res.isNull()) {
        const inherited = pageObj.getInheritable("Resources");
        res = d.newDictionary();
        if (!inherited.isNull()) inherited.forEach((v, k) => res.put(k, v));
        pageObj.put("Resources", res);
      }
      let fonts = res.get("Font");
      if (fonts.isNull()) { fonts = d.newDictionary(); res.put("Font", fonts); }
      let name;
      do { name = `PdxF${++n}`; } while (!fonts.get(name).isNull());
      fonts.put(name, ref);
      return name;
    },
    appendContent(d, page, content) {
      const pageObj = page.getObject();
      const old = pageObj.get("Contents");
      const arr = d.newArray();
      const enc = new TextEncoder();
      arr.push(d.addStream(enc.encode("q\n"), d.newDictionary()));
      if (old.isArray()) old.forEach((v) => arr.push(v)); else if (!old.isNull()) arr.push(old);
      arr.push(d.addStream(enc.encode("\nQ\n"), d.newDictionary()));
      arr.push(d.addStream(enc.encode(content), d.newDictionary()));
      pageObj.put("Contents", arr);
    },
  };
  const report = [];
  for (let i = 0; i < changes.length; i++) {
    const ch = { ...changes[i] };
    let err;
    try { err = await applyPdfChange(mupdf, doc, ch, ctx); }
    catch (e) { console.error(e); err = "could not be applied"; }
    report.push({ index: i, ok: !err, reason: err || null, note: ch._note || null, mark: ch._mark || null });
  }
  const out = doc.saveToBuffer("garbage=compact,compress").asUint8Array().slice();
  doc.destroy?.();
  return { bytes: out, report };
}

// ------------------------------------------------------------------ DOCX

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const list = (nl) => { const out = []; for (let i = 0; i < nl.length; i++) out.push(nl.item ? nl.item(i) : nl[i]); return out; };

function paraText(p) {
  const ts = list(p.getElementsByTagNameNS(W, "t"));
  return [ts, ts.map((t) => t.textContent || "").join("")];
}

function setText(t, text) {
  t.textContent = text;
  t.setAttributeNS(XML_NS, "xml:space", "preserve");
}

function replaceRange(ts, start, end, text) {
  const bounds = [];
  let pos = 0;
  for (const t of ts) { const len = (t.textContent || "").length; bounds.push([pos, pos + len]); pos += len; }
  if (start === end) {
    for (let k = 0; k < ts.length; k++) {
      const [a, b] = bounds[k];
      if ((a <= start && start < b) || (start === b && k === ts.length - 1) || (a <= start && start <= b && b > a)) {
        const txt = ts[k].textContent || "";
        setText(ts[k], txt.slice(0, start - a) + text + txt.slice(start - a));
        return;
      }
    }
    return;
  }
  let placed = false;
  ts.forEach((t, k) => {
    const [a, b] = bounds[k];
    if (b <= start || a >= end) return;
    const txt = t.textContent || "";
    const lo = Math.max(start - a, 0), hi = Math.min(end - a, txt.length);
    setText(t, txt.slice(0, lo) + (placed ? "" : text) + txt.slice(hi));
    placed = true;
  });
}

function replaceMinimal(ts, start, end, text) {
  const old = ts.map((t) => t.textContent || "").join("").slice(start, end);
  const a = old.match(/\s+|\S+/g) || [], b = text.match(/\s+|\S+/g) || [];
  const oa = [0], ob = [0];
  a.forEach((x) => oa.push(oa[oa.length - 1] + x.length));
  b.forEach((x) => ob.push(ob[ob.length - 1] + x.length));
  const ops = diffOps(a, b);
  for (let k = ops.length - 1; k >= 0; k--) {
    const [tag, i1, i2, j1, j2] = ops[k];
    if (tag !== "equal") replaceRange(ts, start + oa[i1], start + oa[i2], text.slice(ob[j1], ob[j2]));
  }
}

export async function applyDocx(JSZip, bytes, changes, xml = { DOMParser: globalThis.DOMParser, XMLSerializer: globalThis.XMLSerializer }) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n))
    .sort((x, y) => (x === "word/document.xml" ? -1 : y === "word/document.xml" ? 1 : x.localeCompare(y)));
  const docs = {};
  for (const n of names) docs[n] = new xml.DOMParser().parseFromString(await zip.file(n).async("string"), "application/xml");
  const report = [];
  changes.forEach((ch, i) => {
    const paras = names.flatMap((n) => list(docs[n].getElementsByTagNameNS(W, "p")));
    const hay = [], where = [];
    paras.forEach((p, pi) => {
      const [, text] = paraText(p);
      for (const m of text.matchAll(/\S+/g)) {
        const t = norm(m[0]);
        if (t) { hay.push(t); where.push([pi, m.index, m.index + m[0].length]); }
      }
    });
    const span = findSpan(hay, tokens(ch.find));
    if (!span) { report.push({ index: i, ok: false, reason: "not found in the file", note: null }); return; }
    let [p0, s0] = where[span[0]], [p1, , e1] = where[span[1] - 1];
    const repl = ch.replace.trim();
    const [lead, trail] = keptPunct(paraText(paras[p0])[1].slice(s0, where[span[0]][2]),
      paraText(paras[p1])[1].slice(where[span[1] - 1][1], e1), ch.find);
    s0 += lead.length;
    e1 -= trail.length;
    if (p0 === p1) {
      replaceMinimal(paraText(paras[p0])[0], s0, e1, repl);
    } else {
      let pieces = repl.split(/\n\s*\n/).map((x) => x.trim());
      const involved = [];
      for (let pi = p0; pi <= p1; pi++) involved.push(pi);
      if (pieces.length !== involved.length) pieces = [pieces.filter(Boolean).join(" "), ...new Array(involved.length - 1).fill("")];
      involved.forEach((pi, k) => {
        const [ts, text] = paraText(paras[pi]);
        replaceMinimal(ts, pi === p0 ? s0 : 0, pi === p1 ? e1 : text.length, pieces[k]);
        if (pi !== p0 && !paraText(paras[pi])[1].trim() && paras[pi].parentNode) paras[pi].parentNode.removeChild(paras[pi]);
      });
    }
    report.push({ index: i, ok: true, reason: null, note: null });
  });
  for (const n of names) zip.file(n, new xml.XMLSerializer().serializeToString(docs[n]));
  return { bytes: await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }), report };
}


// ------------------------------------------------------------------ checking changes

// Words of a text with their character offsets, for mapping matches back to the original wording.
function wordSpans(text) {
  const out = [];
  for (const m of text.matchAll(/\S+/g)) {
    const t = norm(m[0]);
    if (t) out.push({ t, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// Is this FIND text in the document? Returns "exact", "close" or null.
export function locate(docText, find) {
  const words = wordSpans(docText);
  const needle = tokens(find);
  if (!needle.length) return null;
  const hay = words.map((w) => w.t);
  const span = findSpan(hay, needle);
  if (!span) return null;
  const exact = span[1] - span[0] === needle.length && needle.every((t, k) => hay[span[0] + k] === t);
  return exact ? "exact" : "close";
}

// The passage of the document that looks most like `find`, in the document's own words.
export function closestPassage(docText, find) {
  const words = wordSpans(docText);
  const needle = tokens(find);
  const n = needle.length;
  if (!n || !words.length) return null;
  const set = new Set(needle);
  let best = 0, span = null;
  for (const len of [n - 2, n - 1, n, n + 1, n + 2, n + 4]) {
    if (len < 1) continue;
    for (let i = 0; i + len <= words.length; i++) {
      let hits = 0;
      for (let k = i; k < i + len; k++) if (set.has(words[k].t)) hits++;
      if (hits / Math.max(len, n) <= best * 0.9) continue;
      const r = (2 * lcs(words.slice(i, i + len).map((w) => w.t), needle)) / (len + n);
      if (r > best) { best = r; span = [i, i + len]; }
    }
  }
  if (!span || best < 0.35) return null;
  return { text: docText.slice(words[span[0]].start, words[span[1] - 1].end), score: best };
}

// ------------------------------------------------------------------ personal data

function ibanValid(raw) {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let m = 0;
  for (const d of r) m = (m * 10 + Number(d)) % 97;
  return m === 1;
}

function luhn(raw) {
  const d = raw.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let x = Number(d[d.length - 1 - i]);
    if (i % 2) { x *= 2; if (x > 9) x -= 9; }
    sum += x;
  }
  return sum % 10 === 0;
}

const PII_RULES = [
  { type: "email", re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu },
  { type: "iban", re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, check: ibanValid },
  { type: "card", re: /\b\d(?:[ -]?\d){12,18}\b/g, check: luhn },
  { type: "phone", re: /(?:(?:\+|00)\d{1,3}[\s./-]?(?:\(0\)[\s./-]?)?|\b0)\d{2,5}(?:[\s./-]?\d{2,8}){1,4}\b/g,
    check: (v) => { const n = v.replace(/\D/g, "").length; return n >= 7 && n <= 15 && !/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(v.trim()); } },
  { type: "birthdate", re: /(?:geb(?:oren)?\.?(?:\s+am)?|Geburtsdatum:?|date of birth:?|born(?:\s+on)?|DOB:?|né(?:e)? le)\s*(\d{1,2}[./-]\s?\d{1,2}[./-]\s?\d{2,4}|\d{1,2}\.?\s+\p{L}+\s+\d{4})/giu, group: 1 },
  { type: "id", re: /(?:Steuer-?ID|Steuer-?Identifikationsnummer|Steuernummer|Sozialversicherungsnummer|SV-Nummer|Personalausweis(?:nummer)?|Ausweisnummer|Reisepass(?:nummer)?|Passport(?: No\.?| number)?|Tax ID|Social Security(?: Number)?|SSN|Versichertennummer|Personalnummer)\s*[:#]?\s*([A-Z0-9][A-Z0-9 /-]{4,24}[A-Z0-9])/giu, group: 1 },
];

// Names after a salutation or a "Name:" label, and street addresses / postcodes with a city.
const NAME_WORD = "\\p{Lu}\\p{Ll}+(?:['’-]\\p{Lu}?\\p{Ll}+)*";
PII_RULES.push(
  { type: "name", re: new RegExp(`(?:\\b(?:Frau|Herrn?|Hr\\.|Fr\\.|Dr\\.|Prof\\.|Mr\\.?|Mrs\\.?|Ms\\.?|Mme|M\\.|Madame|Monsieur)\\s+(?:(?:Dr|Prof)\\.\\s+)?)(${NAME_WORD}(?:[ -]${NAME_WORD}){0,2})`, "gu"), group: 1 },
  { type: "name", re: new RegExp(`(?:\\b(?:Name|Vorname|Nachname|Ansprechpartner(?:in)?|Contact|Nom)\\s*:\\s*)(${NAME_WORD}(?:[ -]${NAME_WORD}){0,3})`, "gu"), group: 1 },
  { type: "address", re: /\p{Lu}[\p{L}.-]*(?:straße|strasse|str\.|weg|gasse|platz|allee|ring|damm|ufer|chaussee|steig|pfad|street|st\.|road|avenue|lane|rue)\s+\d+\s?[a-zA-Z]?(?:\s*[,\n]\s*\d{5}\s+\p{Lu}[\p{L}-]+(?:\s(?:am|an der|im|in der)\s\p{Lu}[\p{L}-]+)?)?/gu },
  { type: "address", re: /\b\d{5}\s+\p{Lu}[\p{L}-]+(?:\s(?:am|an der|im|in der)\s\p{Lu}[\p{L}-]+)?/gu,
    check: (v) => !/^\d{5}\s+(?:Euro|EUR|Stück|Mitarbeiter|Kunden)/.test(v) },
);

export const PII_LABELS = {
  name: "Names", address: "Addresses", email: "Email addresses", phone: "Phone numbers", iban: "Bank accounts (IBAN)",
  card: "Card numbers", birthdate: "Dates of birth", id: "ID and tax numbers", custom: "Your own words",
};

// Pattern-based detection: exact strings as they appear in the text.
export function detectPII(text) {
  const found = new Map();
  for (const rule of PII_RULES) {
    for (const m of text.matchAll(rule.re)) {
      const v = (rule.group ? m[rule.group] : m[0]).trim().replace(/[.,;:]+$/, "");
      if (!v || (rule.check && !rule.check(v))) continue;
      if (rule.type === "phone" && [...found.values()].some((f) => (f.type === "iban" || f.type === "card") && f.value.includes(v))) continue;
      if (!found.has(v)) found.set(v, { type: rule.type, value: v });
    }
  }
  // Drop items already covered by a longer item (e.g. "64283 Darmstadt" inside a full address).
  const all = [...found.values()];
  return all.filter((a) => !all.some((b) => b !== a && b.value.length > a.value.length && b.value.includes(a.value)));
}

// Prompt that asks the model for names and addresses; the answer is checked against the text.
export function piiPrompt(text) {
  return [
    { role: "system", content: "You find personal data in documents. Reply only with lines in the format TYPE: exact text. TYPE is NAME (a person's name) or ADDRESS (a street address with house number, or a postcode with city). Copy each item exactly as written in the document. Do not list company names, job titles or dates. If there is nothing, reply NONE." },
    { role: "user", content: `Document:\n<document>\n${text}\n</document>\n\nList every person's name and every address in this document.` },
  ];
}

export function parsePiiAnswer(answer, text) {
  const out = [];
  for (const line of answer.split("\n")) {
    const m = /^\s*[-*]?\s*(NAME|ADDRESS)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const value = m[2].replace(/^["'„“]|["'“”]$/g, "").trim();
    // Only keep what is really in the document, word for word.
    if (value.length > 2 && text.includes(value)) out.push({ type: m[1].toLowerCase() === "name" ? "name" : "address", value });
  }
  return out;
}

function caseVariants(term) {
  const v = new Set([term]);
  if (/\p{L}/u.test(term)) {
    v.add(term.toLowerCase());
    v.add(term.toUpperCase());
    v.add(term.replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()));
  }
  return [...v];
}

// Black out every occurrence of each term for real, and wipe the document's metadata.
export function redactPdf(mupdf, bytes, terms) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const counts = terms.map(() => 0);
  const marks = [];
  for (let p = 0; p < doc.countPages(); p++) {
    const page = doc.loadPage(p);
    let any = false;
    const seen = new Set();
    terms.forEach((term, i) => {
      for (const variant of caseVariants(term)) {
        for (const hit of page.search(variant)) {
          const key = hit.map((q) => q.map(Math.round).join(",")).join("|");
          if (seen.has(key)) continue;
          seen.add(key);
          for (const q of hit) {
            const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
            const r = [Math.min(...xs) - 0.5, Math.min(...ys) - 0.5, Math.max(...xs) + 0.5, Math.max(...ys) + 0.5];
            page.createAnnotation("Redact").setRect(r);
            marks.push({ page: p, rect: r });
          }
          counts[i]++;
          any = true;
        }
      }
    });
    // black boxes, blank out image pixels under them, keep line art, remove the text
    if (any) page.applyRedactions(true, 2, 0, 0);
  }
  for (const key of ["info:Title", "info:Author", "info:Subject", "info:Keywords", "info:Creator", "info:Producer"]) {
    try { doc.setMetaData(key, ""); } catch { /* not present */ }
  }
  try {
    const root = doc.getTrailer().get("Root");
    if (!root.isNull() && !root.get("Metadata").isNull()) root.delete("Metadata");
  } catch { /* no XMP */ }
  const out = doc.saveToBuffer("garbage=compact,compress,clean").asUint8Array().slice();
  return { bytes: out, counts, marks };
}

export async function redactDocx(JSZip, bytes, terms, xml = { DOMParser: globalThis.DOMParser, XMLSerializer: globalThis.XMLSerializer }) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(n));
  const counts = terms.map(() => 0);
  for (const n of names) {
    const dom = new xml.DOMParser().parseFromString(await zip.file(n).async("string"), "application/xml");
    for (const p of list(dom.getElementsByTagNameNS(W, "p"))) {
      terms.forEach((term, i) => {
        for (;;) {
          const [ts, text] = paraText(p);
          const at = text.toLowerCase().indexOf(term.toLowerCase());
          if (at < 0) break;
          replaceRange(ts, at, at + term.length, "\u2588".repeat(Math.max(3, Math.min(term.length, 12))));
          counts[i]++;
        }
      });
    }
    zip.file(n, new xml.XMLSerializer().serializeToString(dom));
  }
  // Document properties often name the author and company.
  for (const n of ["docProps/core.xml", "docProps/app.xml", "docProps/custom.xml"]) {
    const f = zip.file(n);
    if (!f) continue;
    let x = await f.async("string");
    x = x.replace(/<((?:dc:creator|cp:lastModifiedBy|Company|Manager|dc:title|dc:subject|cp:keywords|dc:description))>[^<]*<\/\1>/g, "<$1></$1>");
    if (n === "docProps/custom.xml") x = x.replace(/<vt:lpwstr>[^<]*<\/vt:lpwstr>/g, "<vt:lpwstr></vt:lpwstr>");
    zip.file(n, x);
  }
  return { bytes: await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }), counts };
}

// ------------------------------------------------------------------ preview

// PNG images of the given pages, with optional highlight rectangles in page coordinates.
export function renderPages(mupdf, bytes, pages, scale = 1.6) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const out = [];
  for (const p of pages) {
    if (p < 0 || p >= doc.countPages()) continue;
    const page = doc.loadPage(p);
    const b = page.getBounds();
    const pm = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    out.push({ page: p, png: pm.asPNG().slice(), width: b[2] - b[0], height: b[3] - b[1] });
  }
  return out;
}
