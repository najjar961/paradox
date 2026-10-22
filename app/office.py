"""Excel (.xlsx) and PowerPoint (.pptx): read, edit in place, redact, preview.

Edits work on the files' XML directly, so formatting, formulas, charts and
images are left exactly as they were. Everything happens in memory.
"""
from __future__ import annotations

import html
import io
import re
import zipfile

from lxml import etree

from .layout_edit import find_span, norm, tokens

S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
R_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
BLOCK = "█"


def _zip(data: bytes) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(data))


def _rewrite(data: bytes, changed: dict[str, bytes]) -> bytes:
    src = _zip(data)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            dst.writestr(item, changed.get(item.filename, src.read(item.filename)))
    return out.getvalue()


def _scrub_props(z: zipfile.ZipFile, changed: dict[str, bytes]) -> None:
    for name in ("docProps/core.xml", "docProps/app.xml", "docProps/custom.xml"):
        if name not in z.namelist():
            continue
        x = z.read(name).decode("utf-8")
        x = re.sub(r"<((?:dc:creator|cp:lastModifiedBy|Company|Manager|dc:title|dc:subject|cp:keywords|dc:description))>"
                   r"[^<]*</\1>", r"<\1></\1>", x)
        if name.endswith("custom.xml"):
            x = re.sub(r"<vt:lpwstr>[^<]*</vt:lpwstr>", "<vt:lpwstr></vt:lpwstr>", x)
        changed[name] = x.encode("utf-8")


# ---------------------------------------------------------------- Excel

def _col(ref: str) -> str:
    return re.match(r"[A-Z]+", ref).group()


def _sheets(z: zipfile.ZipFile) -> list[tuple[str, str]]:
    """(sheet name, part path) in workbook order."""
    wb = etree.fromstring(z.read("xl/workbook.xml"))
    rels = etree.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    target = {r.get("Id"): r.get("Target") for r in rels}
    out = []
    for sh in wb.iter(S + "sheet"):
        t = target.get(sh.get(R_NS + "id"), "")
        out.append((sh.get("name"), "xl/" + t.lstrip("/").removeprefix("xl/")))
    return out


def _shared(z: zipfile.ZipFile):
    if "xl/sharedStrings.xml" not in z.namelist():
        return None, []
    root = etree.fromstring(z.read("xl/sharedStrings.xml"))
    return root, [ "".join(t.text or "" for t in si.iter(S + "t")) for si in root.iter(S + "si")]


def xlsx_cells(data: bytes, limit_rows: int = 2000):
    """[(sheet, [(ref, text, is_formula)])]"""
    z = _zip(data)
    _, strings = _shared(z)
    out = []
    for name, path in _sheets(z):
        root = etree.fromstring(z.read(path))
        cells = []
        for n, row in enumerate(root.iter(S + "row")):
            if n >= limit_rows:
                break
            for c in row.iter(S + "c"):
                ref, typ = c.get("r"), c.get("t")
                f, v = c.find(S + "f"), c.find(S + "v")
                if typ == "s" and v is not None:
                    text = strings[int(v.text)]
                elif typ == "inlineStr":
                    text = "".join(t.text or "" for t in c.iter(S + "t"))
                else:
                    text = v.text if v is not None and v.text is not None else ""
                if f is not None and not text:
                    text = "=" + (f.text or "")
                if text != "":
                    cells.append((ref, text, f is not None))
        out.append((name, cells))
    return out


def xlsx_text(data: bytes) -> str:
    parts = []
    for name, cells in xlsx_cells(data):
        rows: dict[int, list[str]] = {}
        for ref, text, _ in cells:
            rows.setdefault(int(re.search(r"\d+", ref).group()), []).append(f"{ref}: {text}")
        parts.append(f"Sheet: {name}\n" + "\n".join(" | ".join(v) for _, v in sorted(rows.items())))
    return "\n\n".join(parts)


def _num(s: str) -> float | None:
    s = s.strip().replace("€", "").replace("EUR", "").replace("%", "").strip()
    if not re.fullmatch(r"-?[\d.,\s']+", s) or not re.search(r"\d", s):
        return None
    s = s.replace(" ", "").replace("'", "")
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".") if re.search(r",\d{1,2}$", s) else s.replace(",", "")
    elif s.count(".") > 1 or re.search(r"\.\d{3}$", s):
        s = s.replace(".", "")
    try:
        return float(s)
    except ValueError:
        return None


def _fmt_num(x: float) -> str:
    return str(int(x)) if x == int(x) else repr(x)


def _set_text(node, new: str) -> None:
    ts = list(node.iter(S + "t"))
    if not ts:
        return
    ts[0].text = new
    ts[0].set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    for t in ts[1:]:
        t.text = ""


def xlsx_apply(data: bytes, changes: list[dict]) -> tuple[bytes, list[dict]]:
    z = _zip(data)
    sroot, strings = _shared(z)
    sis = list(sroot.iter(S + "si")) if sroot is not None else []
    sheets = [(name, path, etree.fromstring(z.read(path))) for name, path in _sheets(z)]
    report = []
    touched_strings, touched_sheets = False, set()
    for i, ch in enumerate(changes):
        find, repl = ch["find"].strip(), ch["replace"].strip()
        ok = False
        # 1) whole cell or part of a cell's text (shared or inline strings)
        for k, text in enumerate(strings):
            if norm(text) == norm(find) or (len(find) > 2 and find in text):
                new = repl if norm(text) == norm(find) else text.replace(find, repl)
                _set_text(sis[k], new)
                strings[k] = new
                ok = touched_strings = True
        for name, path, root in sheets:
            for c in root.iter(S + "c"):
                if c.get("t") == "inlineStr":
                    text = "".join(t.text or "" for t in c.iter(S + "t"))
                    if norm(text) == norm(find) or (len(find) > 2 and find in text):
                        _set_text(c, repl if norm(text) == norm(find) else text.replace(find, repl))
                        ok = True
                        touched_sheets.add(path)
        # 2) numbers: match the value, write the new value (formulas are left alone and recalculated)
        old_n, new_n = _num(find), _num(repl)
        if not ok and old_n is not None and new_n is not None:
            for name, path, root in sheets:
                for c in root.iter(S + "c"):
                    v = c.find(S + "v")
                    if c.get("t") in (None, "n") and c.find(S + "f") is None and v is not None and v.text:
                        try:
                            if abs(float(v.text) - old_n) < 1e-9:
                                v.text = _fmt_num(new_n)
                                ok = True
                                touched_sheets.add(path)
                        except ValueError:
                            pass
        report.append({"index": i, "ok": ok, "reason": None if ok else "not found in the file", "note": None, "mark": None})
    changed: dict[str, bytes] = {}
    if touched_strings and sroot is not None:
        changed["xl/sharedStrings.xml"] = etree.tostring(sroot, xml_declaration=True, encoding="UTF-8", standalone=True)
    for name, path, root in sheets:
        if path in touched_sheets:
            changed[path] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    if changed:
        _force_recalc(z, changed)
    return _rewrite(data, changed), report


def _force_recalc(z: zipfile.ZipFile, changed: dict[str, bytes]) -> None:
    """Ask Excel/LibreOffice to recalculate formulas when the file is opened."""
    wb = etree.fromstring(changed.get("xl/workbook.xml") or z.read("xl/workbook.xml"))
    calc = wb.find(S + "calcPr")
    if calc is None:
        calc = etree.SubElement(wb, S + "calcPr")
    calc.set("fullCalcOnLoad", "1")
    changed["xl/workbook.xml"] = etree.tostring(wb, xml_declaration=True, encoding="UTF-8", standalone=True)
    # cached formula results are now stale: drop them so viewers don't show old totals
    for path in [p for p in z.namelist() if p.startswith("xl/worksheets/") and p.endswith(".xml")]:
        root = etree.fromstring(changed.get(path) or z.read(path))
        dirty = False
        for c in root.iter(S + "c"):
            if c.find(S + "f") is not None and c.find(S + "v") is not None:
                c.remove(c.find(S + "v"))
                dirty = True
        if dirty:
            changed[path] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    if "xl/calcChain.xml" in z.namelist():
        changed["xl/calcChain.xml"] = z.read("xl/calcChain.xml")


NAME_HEADERS = re.compile(r"^(?:vor-?|nach-?|familien-?)?name|^verantwortlich|^ansprechpartner|^kontakt(?:person)?$|^mitarbeiter|"
                          r"^kunde|^person|^bearbeiter|^inhaber|^contact|^owner|^employee|^customer|^full name|^first name|"
                          r"^last name|^nom|^prénom", re.I)


def xlsx_name_cells(data: bytes) -> list[str]:
    """Values in columns whose header says they hold people's names (Name, Verantwortlich, Contact, ...)."""
    out: list[str] = []
    for _, cells in xlsx_cells(data):
        header_cols: dict[str, int] = {}
        for ref, text, is_f in cells:
            row = int(re.search(r"\d+", ref).group())
            if not is_f and NAME_HEADERS.search(text.strip()) and len(text) < 40:
                header_cols.setdefault(_col(ref), row)
        for ref, text, is_f in cells:
            col, row = _col(ref), int(re.search(r"\d+", ref).group())
            v = text.strip()
            if col in header_cols and row > header_cols[col] and not is_f and v and _num(v) is None \
                    and 2 < len(v) < 60 and "@" not in v and v not in out:
                out.append(v)
    return out


def xlsx_redact(data: bytes, terms: list[str]) -> tuple[bytes, list[int]]:
    z = _zip(data)
    sroot, strings = _shared(z)
    counts = [0] * len(terms)
    changed: dict[str, bytes] = {}

    def scrub(text: str) -> str:
        for i, term in enumerate(terms):
            n = text.lower().count(term.lower())
            if n:
                counts[i] += n
                text = re.sub(re.escape(term), BLOCK * max(3, min(len(term), 12)), text, flags=re.I)
        return text

    if sroot is not None:
        for si, text in zip(sroot.iter(S + "si"), strings):
            new = scrub(text)
            if new != text:
                _set_text(si, new)
        changed["xl/sharedStrings.xml"] = etree.tostring(sroot, xml_declaration=True, encoding="UTF-8", standalone=True)
    for _, path in _sheets(z):
        root = etree.fromstring(z.read(path))
        dirty = False
        for c in root.iter(S + "c"):
            if c.get("t") == "inlineStr":
                text = "".join(t.text or "" for t in c.iter(S + "t"))
                new = scrub(text)
                if new != text:
                    _set_text(c, new)
                    dirty = True
            elif c.get("t") in (None, "n") and c.find(S + "v") is not None and c.find(S + "f") is None:
                v = c.find(S + "v")
                if v.text and any(_num(t) is not None and _num(t) == _num(v.text) for t in terms):
                    v.text = "0"
                    dirty = True
        if dirty:
            changed[path] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    for name in [n for n in z.namelist() if n.startswith("xl/comments") or n.startswith("xl/threadedComments")]:
        x = z.read(name).decode("utf-8")
        changed[name] = scrub(x).encode("utf-8")
    _scrub_props(z, changed)
    return _rewrite(data, changed), counts


def xlsx_html(data: bytes, highlight: list[str] | None = None, max_rows: int = 60, max_cols: int = 12) -> str:
    out = []
    for name, cells in xlsx_cells(data, max_rows):
        grid: dict[int, dict[str, str]] = {}
        cols: list[str] = []
        for ref, text, _ in cells:
            col, row = _col(ref), int(re.search(r"\d+", ref).group())
            grid.setdefault(row, {})[col] = text
            if col not in cols:
                cols.append(col)
        cols = sorted(cols, key=lambda c: (len(c), c))[:max_cols]
        rows = []
        for r in sorted(grid)[:max_rows]:
            tds = []
            for c in cols:
                v = grid[r].get(c, "")
                cell = html.escape(v)
                if highlight and any(h and h in v for h in highlight):
                    cell = f'<mark class="pv-hl">{cell}</mark>'
                tds.append(f"<td>{cell}</td>")
            rows.append(f"<tr><th>{r}</th>{''.join(tds)}</tr>")
        head = "".join(f"<th>{c}</th>" for c in cols)
        out.append(f'<h3>{html.escape(name)}</h3><table class="pv-sheet"><tr><th></th>{head}</tr>{"".join(rows)}</table>')
    return "".join(out)


# ---------------------------------------------------------------- PowerPoint

def _slides(z: zipfile.ZipFile) -> list[str]:
    pres = etree.fromstring(z.read("ppt/presentation.xml"))
    rels = etree.fromstring(z.read("ppt/_rels/presentation.xml.rels"))
    target = {r.get("Id"): r.get("Target") for r in rels}
    out = []
    for sid in pres.iter(P + "sldId"):
        t = target.get(sid.get(R_NS + "id"), "")
        out.append("ppt/" + t.lstrip("/").removeprefix("ppt/"))
    return out


def _paras(root):
    for p in root.iter(A + "p"):
        ts = list(p.iter(A + "t"))
        yield p, ts, "".join(t.text or "" for t in ts)


def pptx_slides(data: bytes) -> list[list[str]]:
    z = _zip(data)
    out = []
    for path in _slides(z):
        root = etree.fromstring(z.read(path))
        out.append([text for _, _, text in _paras(root) if text.strip()])
    return out


def pptx_text(data: bytes) -> str:
    return "\n\n".join(f"Slide {i}\n" + "\n".join(lines) for i, lines in enumerate(pptx_slides(data), 1))


def _replace_range(ts, start: int, end: int, new: str) -> None:
    pos, placed = 0, False
    for t in ts:
        txt = t.text or ""
        a, b = pos, pos + len(txt)
        pos = b
        if b <= start or a >= end:
            continue
        lo, hi = max(start - a, 0), min(end - a, len(txt))
        t.text = txt[:lo] + (new if not placed else "") + txt[hi:]
        placed = True
    if not placed and ts and start == end:
        ts[-1].text = (ts[-1].text or "") + new


def _replace_minimal(ts, start: int, end: int, new: str) -> None:
    from difflib import SequenceMatcher

    old = "".join(t.text or "" for t in ts)[start:end]
    a, b = re.findall(r"\s+|\S+", old), re.findall(r"\s+|\S+", new)
    oa, ob = [0], [0]
    for x in a:
        oa.append(oa[-1] + len(x))
    for x in b:
        ob.append(ob[-1] + len(x))
    for tag, i1, i2, j1, j2 in reversed(SequenceMatcher(None, a, b, autojunk=False).get_opcodes()):
        if tag != "equal":
            _replace_range(ts, start + oa[i1], start + oa[i2], new[ob[j1]:ob[j2]])


def pptx_apply(data: bytes, changes: list[dict]) -> tuple[bytes, list[dict]]:
    z = _zip(data)
    slides = [(path, etree.fromstring(z.read(path))) for path in _slides(z)]
    touched = set()
    report = []
    for i, ch in enumerate(changes):
        hay, where = [], []
        for si, (path, root) in enumerate(slides):
            for p, ts, text in _paras(root):
                for m in re.finditer(r"\S+", text):
                    t = norm(m.group())
                    if t:
                        hay.append(t)
                        where.append((si, p, m.start(), m.end()))
        span = find_span(hay, tokens(ch["find"]))
        if not span:
            report.append({"index": i, "ok": False, "reason": "not found in the file", "note": None, "mark": None})
            continue
        s0, p0, a, _ = where[span[0]]
        s1, p1, _, b = where[span[1] - 1]
        if p0 is not p1:
            report.append({"index": i, "ok": False, "reason": "the text spans several text boxes or lines; change each separately",
                           "note": None, "mark": None})
            continue
        ts = list(p0.iter(A + "t"))
        _replace_minimal(ts, a, b, ch["replace"].strip())
        touched.add(slides[s0][0])
        report.append({"index": i, "ok": True, "reason": None, "note": None, "mark": {"slide": s0}})
    changed = {path: etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
               for path, root in slides if path in touched}
    return _rewrite(data, changed), report


def pptx_redact(data: bytes, terms: list[str]) -> tuple[bytes, list[int]]:
    z = _zip(data)
    counts = [0] * len(terms)
    changed: dict[str, bytes] = {}
    parts = [p for p in z.namelist() if re.match(r"ppt/(slides/slide|notesSlides/notesSlide|comments/)\S*\.xml$", p)]
    for path in parts:
        root = etree.fromstring(z.read(path))
        dirty = False
        for p, ts, _ in list(_paras(root)):
            for i, term in enumerate(terms):
                while True:
                    text = "".join(t.text or "" for t in ts)
                    at = text.lower().find(term.lower())
                    if at < 0:
                        break
                    _replace_range(ts, at, at + len(term), BLOCK * max(3, min(len(term), 12)))
                    counts[i] += 1
                    dirty = True
        if dirty:
            changed[path] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    _scrub_props(z, changed)
    return _rewrite(data, changed), counts


def pptx_html(data: bytes, highlight: list[str] | None = None) -> str:
    out = []
    for i, lines in enumerate(pptx_slides(data), 1):
        items = []
        for k, line in enumerate(lines):
            cell = html.escape(line)
            if highlight and any(h and h in line for h in highlight):
                cell = f'<mark class="pv-hl">{cell}</mark>'
            items.append(f"<h3>{cell}</h3>" if k == 0 else f"<p>{cell}</p>")
        out.append(f'<section class="pv-slide"><span class="pv-num">Slide {i}</span>{"".join(items)}</section>')
    return "".join(out)
