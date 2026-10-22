// Excel (.xlsx) and PowerPoint (.pptx) in the browser: read, edit in place, redact, preview.
// Mirrors app/office.py. Edits work on the files' XML, so formatting, formulas, charts and
// images stay exactly as they were.

import { findSpan, norm, tokens } from "./layout.js";

const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const BLOCK = "█";

const all = (root, ns, tag) => Array.from(root.getElementsByTagNameNS(ns, tag));
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function open(JSZip, bytes, xml) {
  const zip = await JSZip.loadAsync(bytes);
  const read = async (name) => new xml.DOMParser().parseFromString(await zip.file(name).async("string"), "application/xml");
  const has = (name) => !!zip.file(name);
  const write = (name, dom) => zip.file(name, new xml.XMLSerializer().serializeToString(dom));
  return { zip, read, has, write };
}

async function scrubProps(f) {
  for (const n of ["docProps/core.xml", "docProps/app.xml", "docProps/custom.xml"]) {
    if (!f.has(n)) continue;
    let x = await f.zip.file(n).async("string");
    x = x.replace(/<((?:dc:creator|cp:lastModifiedBy|Company|Manager|dc:title|dc:subject|cp:keywords|dc:description))>[^<]*<\/\1>/g, "<$1></$1>");
    if (n.endsWith("custom.xml")) x = x.replace(/<vt:lpwstr>[^<]*<\/vt:lpwstr>/g, "<vt:lpwstr></vt:lpwstr>");
    f.zip.file(n, x);
  }
}

const out = (f) => f.zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
const defaultXml = () => ({ DOMParser: globalThis.DOMParser, XMLSerializer: globalThis.XMLSerializer });

// ------------------------------------------------------------------ Excel

async function sheets(f) {
  const wb = await f.read("xl/workbook.xml");
  const rels = await f.read("xl/_rels/workbook.xml.rels");
  const target = {};
  for (const r of Array.from(rels.getElementsByTagName("Relationship"))) target[r.getAttribute("Id")] = r.getAttribute("Target");
  return all(wb, S, "sheet").map((sh) => {
    const t = (target[sh.getAttributeNS(R, "id")] || "").replace(/^\//, "").replace(/^xl\//, "");
    return { name: sh.getAttribute("name"), path: `xl/${t}` };
  });
}

async function shared(f) {
  if (!f.has("xl/sharedStrings.xml")) return { dom: null, sis: [], strings: [] };
  const dom = await f.read("xl/sharedStrings.xml");
  const sis = all(dom, S, "si");
  return { dom, sis, strings: sis.map((si) => all(si, S, "t").map((t) => t.textContent || "").join("")) };
}

function setText(node, ns, text) {
  const ts = all(node, ns, "t");
  if (!ts.length) return;
  ts[0].textContent = text;
  ts[0].setAttributeNS(XML_NS, "xml:space", "preserve");
  for (const t of ts.slice(1)) t.textContent = "";
}

const colOf = (ref) => /^[A-Z]+/.exec(ref)[0];
const rowOf = (ref) => Number(/\d+/.exec(ref)[0]);

async function cells(f, limitRows = 2000) {
  const { strings } = await shared(f);
  const result = [];
  for (const sh of await sheets(f)) {
    const dom = await f.read(sh.path);
    const list = [];
    all(dom, S, "row").slice(0, limitRows).forEach((row) => {
      for (const c of all(row, S, "c")) {
        const ref = c.getAttribute("r"), t = c.getAttribute("t");
        const fEl = all(c, S, "f")[0], v = all(c, S, "v")[0];
        let text;
        if (t === "s" && v) text = strings[Number(v.textContent)] ?? "";
        else if (t === "inlineStr") text = all(c, S, "t").map((x) => x.textContent || "").join("");
        else text = v ? v.textContent || "" : "";
        if (fEl && !text) text = `=${fEl.textContent || ""}`;
        if (text !== "") list.push({ ref, text, formula: !!fEl });
      }
    });
    result.push({ name: sh.name, cells: list });
  }
  return result;
}

export async function xlsxText(JSZip, bytes, xml = defaultXml()) {
  const f = await open(JSZip, bytes, xml);
  return (await cells(f)).map(({ name, cells: cs }) => {
    const rows = new Map();
    for (const c of cs) {
      const r = rowOf(c.ref);
      if (!rows.has(r)) rows.set(r, []);
      rows.get(r).push(`${c.ref}: ${c.text}`);
    }
    return `Sheet: ${name}\n` + [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.join(" | ")).join("\n");
  }).join("\n\n");
}

export function parseNum(s) {
  s = String(s).trim().replace(/€|EUR|%/g, "").trim();
  if (!/^-?[\d.,\s']+$/.test(s) || !/\d/.test(s)) return null;
  s = s.replace(/[\s']/g, "");
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  else if ((s.match(/\./g) || []).length > 1 || /\.\d{3}$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function forceRecalc(f) {
  const wb = await f.read("xl/workbook.xml");
  let calc = all(wb, S, "calcPr")[0];
  if (!calc) { calc = wb.createElementNS(S, "calcPr"); wb.documentElement.appendChild(calc); }
  calc.setAttribute("fullCalcOnLoad", "1");
  f.write("xl/workbook.xml", wb);
  for (const name of Object.keys(f.zip.files).filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n))) {
    const dom = await f.read(name);
    let dirty = false;
    for (const c of all(dom, S, "c")) {
      const v = all(c, S, "v")[0];
      if (all(c, S, "f").length && v) { c.removeChild(v); dirty = true; }
    }
    if (dirty) f.write(name, dom);
  }
}

export async function xlsxApply(JSZip, bytes, changes, xml = defaultXml()) {
  const f = await open(JSZip, bytes, xml);
  const sh = await shared(f);
  const docs = [];
  for (const s of await sheets(f)) docs.push({ ...s, dom: await f.read(s.path), dirty: false });
  let stringsDirty = false;
  const report = changes.map((ch, i) => {
    const find = ch.find.trim(), repl = ch.replace.trim();
    let ok = false;
    const hit = (text) => norm(text) === norm(find) || (find.length > 2 && text.includes(find));
    const next = (text) => (norm(text) === norm(find) ? repl : text.split(find).join(repl));
    sh.strings.forEach((text, k) => {
      if (hit(text)) { const n = next(text); setText(sh.sis[k], S, n); sh.strings[k] = n; ok = stringsDirty = true; }
    });
    for (const d of docs) {
      for (const c of all(d.dom, S, "c")) {
        if (c.getAttribute("t") !== "inlineStr") continue;
        const text = all(c, S, "t").map((x) => x.textContent || "").join("");
        if (hit(text)) { setText(c, S, next(text)); ok = d.dirty = true; }
      }
    }
    const oldN = parseNum(find), newN = parseNum(repl);
    if (!ok && oldN !== null && newN !== null) {
      for (const d of docs) {
        for (const c of all(d.dom, S, "c")) {
          const t = c.getAttribute("t"), v = all(c, S, "v")[0];
          if ((t === null || t === "n") && !all(c, S, "f").length && v && v.textContent && Math.abs(Number(v.textContent) - oldN) < 1e-9) {
            v.textContent = String(newN);
            ok = d.dirty = true;
          }
        }
      }
    }
    return { index: i, ok, reason: ok ? null : "not found in the file", note: null, mark: null };
  });
  if (stringsDirty) f.write("xl/sharedStrings.xml", sh.dom);
  for (const d of docs) if (d.dirty) f.write(d.path, d.dom);
  if (report.some((r) => r.ok)) await forceRecalc(f);
  return { bytes: await out(f), report };
}

const NAME_HEADERS = /^(?:vor-?|nach-?|familien-?)?name|^verantwortlich|^ansprechpartner|^kontakt(?:person)?$|^mitarbeiter|^kunde|^person|^bearbeiter|^inhaber|^contact|^owner|^employee|^customer|^full name|^first name|^last name|^nom|^prénom/i;

export async function xlsxNameCells(JSZip, bytes, xml = defaultXml()) {
  const f = await open(JSZip, bytes, xml);
  const found = [];
  for (const { cells: cs } of await cells(f)) {
    const headers = new Map();
    for (const c of cs) if (!c.formula && c.text.length < 40 && NAME_HEADERS.test(c.text.trim()) && !headers.has(colOf(c.ref))) headers.set(colOf(c.ref), rowOf(c.ref));
    for (const c of cs) {
      const v = c.text.trim();
      if (headers.has(colOf(c.ref)) && rowOf(c.ref) > headers.get(colOf(c.ref)) && !c.formula && v && parseNum(v) === null
        && v.length > 2 && v.length < 60 && !v.includes("@") && !found.includes(v)) found.push(v);
    }
  }
  return found;
}

function scrubber(terms, counts) {
  return (text) => {
    terms.forEach((term, i) => {
      const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const n = (text.match(re) || []).length;
      if (n) { counts[i] += n; text = text.replace(re, BLOCK.repeat(Math.max(3, Math.min(term.length, 12)))); }
    });
    return text;
  };
}

export async function xlsxRedact(JSZip, bytes, terms, xml = defaultXml()) {
  const f = await open(JSZip, bytes, xml);
  const counts = terms.map(() => 0);
  const scrub = scrubber(terms, counts);
  const sh = await shared(f);
  if (sh.dom) {
    sh.strings.forEach((text, k) => { const n = scrub(text); if (n !== text) setText(sh.sis[k], S, n); });
    f.write("xl/sharedStrings.xml", sh.dom);
  }
  for (const s of await sheets(f)) {
    const dom = await f.read(s.path);
    let dirty = false;
    for (const c of all(dom, S, "c")) {
      if (c.getAttribute("t") !== "inlineStr") continue;
      const text = all(c, S, "t").map((x) => x.textContent || "").join("");
      const n = scrub(text);
      if (n !== text) { setText(c, S, n); dirty = true; }
    }
    if (dirty) f.write(s.path, dom);
  }
  for (const n of Object.keys(f.zip.files).filter((x) => /^xl\/(comments|threadedComments)/.test(x))) {
    f.zip.file(n, scrub(await f.zip.file(n).async("string")));
  }
  await scrubProps(f);
  return { bytes: await out(f), counts };
}

export async function xlsxHtml(JSZip, bytes, highlight = [], xml = defaultXml()) {
  const f = await open(JSZip, bytes, xml);
  return (await cells(f, 60)).map(({ name, cells: cs }) => {
    const grid = new Map(), cols = [];
    for (const c of cs) {
      const col = colOf(c.ref), r = rowOf(c.ref);
      if (!grid.has(r)) grid.set(r, {});
      grid.get(r)[col] = c.text;
      if (!cols.includes(col)) cols.push(col);
    }
    cols.sort((a, b) => a.length - b.length || a.localeCompare(b));
    const use = cols.slice(0, 12);
    const rows = [...grid.keys()].sort((a, b) => a - b).slice(0, 60).map((r) => `<tr><th>${r}</th>${use.map((c) => {
      const v = grid.get(r)[c] || "";
      const cell = esc(v);
      return `<td>${highlight.some((h) => h && v.includes(h)) ? `<mark class="pv-hl">${cell}</mark>` : cell}</td>`;
    }).join("")}</tr>`).join("");
    return `<h3>${esc(name)}</h3><table class="pv-sheet"><tr><th></th>${use.map((c) => `<th>${c}</th>`).join("")}</tr>${rows}</table>`;
  }).join("");
}

// ------------------------------------------------------------------ PowerPoint

async function slidePaths(f) {
  const pres = await f.read("ppt/presentation.xml");
  const rels = await f.read("ppt/_rels/presentation.xml.rels");
  const target = {};
  for (const r of Array.from(rels.getElementsByTagName("Relationship"))) target[r.getAttribute("Id")] = r.getAttribute("Target");
  return all(pres, P, "sldId").map((s) => `ppt/${(target[s.getAttributeNS(R, "id")] || "").replace(/^\//, "").replace(/^ppt\//, "")}`);
}

const paras = (dom) => all(dom, A, "p").map((p) => {
  const ts = all(p, A, "t");
  return { p, ts, text: ts.map((t) => t.textContent || "").join("") };
});

export async function pptxSlides(JSZip, bytes, xml = defaultXml()) {
  const f = await open(JSZip, bytes, xml);
  const res = [];
  for (const path of await slidePaths(f)) res.push(paras(await f.read(path)).map((x) => x.text).filter((t) => t.trim()));
  return res;
}

export async function pptxText(JSZip, bytes, xml = defaultXml()) {
  return (await pptxSlides(JSZip, bytes, xml)).map((lines, i) => `Slide ${i + 1}\n${lines.join("\n")}`).join("\n\n");
}

function replaceRange(ts, start, end, text) {
  let pos = 0, placed = false;
  for (const t of ts) {
    const txt = t.textContent || "";
    const a = pos, b = pos + txt.length;
    pos = b;
    if (b <= start || a >= end) continue;
    const lo = Math.max(start - a, 0), hi = Math.min(end - a, txt.length);
    t.textContent = txt.slice(0, lo) + (placed ? "" : text) + txt.slice(hi);
    placed = true;
  }
  if (!placed && ts.length && start === end) ts[ts.length - 1].textContent += text;
}

function diffOps(a, b) {
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  const push = (tag, i1, i2, j1, j2) => { const l = ops[ops.length - 1]; if (l && l[0] === tag) { l[2] = i2; l[4] = j2; } else ops.push([tag, i1, i2, j1, j2]); };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { push("equal", i, i + 1, j, j + 1); i++; j++; }
    else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) { push("change", i, i, j, j + 1); j++; }
    else { push("change", i, i + 1, j, j); i++; }
  }
  return ops;
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

export async function pptxApply(JSZip, bytes, changes, xml = defaultXml()) {
  const f = await open(JSZip, bytes, xml);
  const slides = [];
  for (const path of await slidePaths(f)) slides.push({ path, dom: await f.read(path), dirty: false });
  const report = changes.map((ch, i) => {
    const hay = [], where = [];
    slides.forEach((s, si) => {
      for (const para of paras(s.dom)) {
        for (const m of para.text.matchAll(/\S+/g)) {
          const t = norm(m[0]);
          if (t) { hay.push(t); where.push({ si, para, start: m.index, end: m.index + m[0].length }); }
        }
      }
    });
    const span = findSpan(hay, tokens(ch.find));
    if (!span) return { index: i, ok: false, reason: "not found in the file", note: null, mark: null };
    const w0 = where[span[0]], w1 = where[span[1] - 1];
    if (w0.para !== w1.para) return { index: i, ok: false, reason: "the text spans several text boxes or lines; change each separately", note: null, mark: null };
    replaceMinimal(w0.para.ts, w0.start, w1.end, ch.replace.trim());
    slides[w0.si].dirty = true;
    return { index: i, ok: true, reason: null, note: null, mark: { slide: w0.si } };
  });
  for (const s of slides) if (s.dirty) f.write(s.path, s.dom);
  return { bytes: await out(f), report };
}

export async function pptxRedact(JSZip, bytes, terms, xml = defaultXml()) {
  const f = await open(JSZip, bytes, xml);
  const counts = terms.map(() => 0);
  for (const name of Object.keys(f.zip.files).filter((n) => /^ppt\/(slides\/slide|notesSlides\/notesSlide|comments\/)[^/]*\.xml$/.test(n))) {
    const dom = await f.read(name);
    let dirty = false;
    for (const para of paras(dom)) {
      terms.forEach((term, i) => {
        for (;;) {
          const text = para.ts.map((t) => t.textContent || "").join("");
          const at = text.toLowerCase().indexOf(term.toLowerCase());
          if (at < 0) break;
          replaceRange(para.ts, at, at + term.length, BLOCK.repeat(Math.max(3, Math.min(term.length, 12))));
          counts[i]++;
          dirty = true;
        }
      });
    }
    if (dirty) f.write(name, dom);
  }
  await scrubProps(f);
  return { bytes: await out(f), counts };
}

export async function pptxHtml(JSZip, bytes, highlight = [], xml = defaultXml()) {
  return (await pptxSlides(JSZip, bytes, xml)).map((lines, i) => `<section class="pv-slide"><span class="pv-num">Slide ${i + 1}</span>${lines.map((l, k) => {
    const cell = esc(l);
    const v = highlight.some((h) => h && l.includes(h)) ? `<mark class="pv-hl">${cell}</mark>` : cell;
    return k === 0 ? `<h3>${v}</h3>` : `<p>${v}</p>`;
  }).join("")}</section>`).join("");
}
