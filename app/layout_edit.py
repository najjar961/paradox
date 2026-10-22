"""Apply text changes to the original PDF or Word file, keeping its layout.

The model answers in "layout mode" with a list of changes:

    FIND: <exact text from the document>
    REPLACE: <new text>

Each change is located in the original file by comparing words (tolerant to
punctuation, quotes, case and small differences), then applied in place:

- PDF:  the affected lines are removed with a true redaction (the old text is
        gone from the file, not just covered) and the new text is written into
        the same area, in the original size and colour, wrapped and shrunk to fit.
- DOCX: the text inside the existing runs is replaced, so fonts, bold, styles,
        tables, headers and footers stay exactly as they were.

Everything happens on bytes in memory. Nothing is written to disk.
"""
from __future__ import annotations

import io
import os
import re
import unicodedata
from difflib import SequenceMatcher

# ---------------------------------------------------------------- parsing

_CHANGE = re.compile(
    r"FIND\s*:\s*(.+?)\s*\n\s*REPLACE\s*:[ \t]*(.*?)(?=\n\s*FIND\s*:|\n\s*-{3,}\s*(?:\n|$)|\Z)",
    re.S | re.I,
)
_WRAP = "\"'`„“”‚‘’«»"


def _unwrap(s: str) -> str:
    s = s.strip()
    while len(s) >= 2 and s[0] in _WRAP and s[-1] in _WRAP:
        s = s[1:-1].strip()
    return s


def parse_changes(answer: str) -> list[dict]:
    text = answer.replace("\r\n", "\n").replace("**", "").replace("__", "")
    out = []
    for m in _CHANGE.finditer(text):
        find, repl = _unwrap(m.group(1)), _unwrap(m.group(2))
        if find and find != repl:
            out.append({"find": find, "replace": repl})
    return out


# ---------------------------------------------------------------- matching

_TRANS = str.maketrans({
    "‘": "'", "’": "'", "‚": "'", "‛": "'",
    "“": '"', "”": '"', "„": '"', "«": '"', "»": '"',
    "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-",
    " ": " ", "­": "", "ﬁ": "fi", "ﬂ": "fl",
})
_EDGE = ".,;:!?\"'()[]{}<>*_"


def norm(token: str) -> str:
    t = unicodedata.normalize("NFKC", token).translate(_TRANS).lower()
    stripped = t.strip(_EDGE)
    return stripped or t


def tokens(text: str) -> list[str]:
    return [t for t in (norm(w) for w in text.split()) if t]


_PUNCT = ".,;:!?\"')]}»“”’"
_OPEN = "\"'([{«„‚“‘"


def kept_punct(first_word: str, last_word: str, find: str) -> tuple[str, str]:
    """Punctuation glued to the matched words that the FIND text itself left out."""
    find = find.strip()
    lead = re.match(r"^[" + re.escape(_OPEN) + r"]+", first_word)
    trail = re.search(r"[" + re.escape(_PUNCT) + r"]+$", last_word)
    lead = lead.group() if lead and not find.startswith(lead.group()) else ""
    trail = trail.group() if trail and not find.endswith(trail.group()) else ""
    return lead, trail


def find_span(hay: list[str], needle: list[str]) -> tuple[int, int] | None:
    """Return (start, end) of needle in hay, exact first, then fuzzy."""
    n = len(needle)
    if not n or not hay:
        return None
    first = needle[0]
    for i in range(len(hay) - n + 1):
        if hay[i] == first and hay[i:i + n] == needle:
            return i, i + n
    if n < 3:
        return None
    anchors = set(needle[:3]) | set(needle[-3:])
    best, best_span = 0.0, None
    for length in sorted({n - 2, n - 1, n, n + 1, n + 2}):
        if length < 1:
            continue
        for i in range(len(hay) - length + 1):
            if hay[i] not in anchors and hay[i + length - 1] not in anchors:
                continue
            r = SequenceMatcher(None, hay[i:i + length], needle, autojunk=False).ratio()
            if r > best:
                best, best_span = r, (i, i + length)
    return best_span if best >= 0.8 else None


# ---------------------------------------------------------------- PDF

_FONT_DIRS = ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu"]


def _unicode_font() -> str | None:
    for d in _FONT_DIRS:
        p = os.path.join(d, "DejaVuSans.ttf")
        if os.path.exists(p):
            return p
    return None


_SYSTEM_DIRS = ["/usr/share/fonts/truetype", "/usr/share/fonts/opentype", "/usr/share/fonts"]
_FAMILIES = [  # (match in PDF font name, file stem prefix of a metric-compatible system font)
    ("calibri", "Carlito"), ("carlito", "Carlito"), ("cambria", "Caladea"), ("caladea", "Caladea"),
    ("arial", "LiberationSans"), ("helvetica", "LiberationSans"), ("liberationsans", "LiberationSans"),
    ("timesnewroman", "LiberationSerif"), ("times", "LiberationSerif"), ("liberationserif", "LiberationSerif"),
    ("couriernew", "LiberationMono"), ("courier", "LiberationMono"),
    ("dejavusanscondensed", "DejaVuSansCondensed"), ("dejavuserif", "DejaVuSerif"), ("dejavusans", "DejaVuSans"),
]
_system_index: dict[str, str] | None = None


def _system_fonts() -> dict[str, str]:
    global _system_index
    if _system_index is None:
        _system_index = {}
        for root in _SYSTEM_DIRS:
            for dirpath, _, files in os.walk(root):
                for f in files:
                    if f.lower().endswith((".ttf", ".otf")):
                        _system_index.setdefault(os.path.splitext(f)[0].lower(), os.path.join(dirpath, f))
    return _system_index


def _system_font(pdf_font: str, bold: bool, italic: bool) -> str | None:
    """A system font with the same letter widths as the PDF's font, if installed."""
    key = _key(pdf_font)
    fonts = _system_fonts()
    for match, stem in _FAMILIES:
        if match in key:
            if stem.startswith("Liberation") or stem in ("Carlito", "Caladea"):
                suffix = "BoldItalic" if bold and italic else "Bold" if bold else "Italic" if italic else "Regular"
                names = [f"{stem}-{suffix}", f"{stem}-Regular"]
            else:
                suffix = "BoldOblique" if bold and italic else "Bold" if bold else "Oblique" if italic else ""
                names = [f"{stem}-{suffix}" if suffix else stem, stem]
            for n in names:
                if n.lower() in fonts:
                    return fonts[n.lower()]
    return None


def _latin1_ok(s: str) -> bool:
    try:
        s.encode("cp1252")
        return True
    except UnicodeEncodeError:
        return False


def _wrap(text: str, measure, width: float) -> list[str]:
    lines: list[str] = []
    for para in text.split("\n"):
        words = para.split()
        if not words:
            lines.append("")
            continue
        cur = ""
        for w in words:
            cand = f"{cur} {w}" if cur else w
            if measure(cand) <= width or not cur:
                if measure(cand) > width and not cur:
                    # single word longer than the line: break it up
                    piece = ""
                    for ch in w:
                        if measure(piece + ch) > width and piece:
                            lines.append(piece)
                            piece = ch
                        else:
                            piece += ch
                    cur = piece
                else:
                    cur = cand
            else:
                lines.append(cur)
                cur = w
        lines.append(cur)
    while lines and not lines[-1]:
        lines.pop()
    return lines


def _page_words(page):
    """Words with position, plus the line/block they belong to."""
    out = []
    for x0, y0, x1, y1, w, b, ln, _ in page.get_text("words", sort=False):
        out.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "t": w, "line": (b, ln), "block": b})
    return out


def _units(words):
    """Matching units: words, with end-of-line hyphenation joined ("Daten-" + "schutz")."""
    units, i = [], 0
    while i < len(words):
        w = words[i]
        nxt = words[i + 1] if i + 1 < len(words) else None
        if (nxt and w["t"].endswith("-") and len(w["t"]) > 2
                and nxt["line"] != w["line"] and w["t"][-2].isalpha()):
            units.append((norm(w["t"][:-1] + nxt["t"]), i, i + 1))
            i += 2
        else:
            units.append((norm(w["t"]), i, i))
            i += 1
    return [u for u in units if u[0]]


def _style_at(page, rect):
    """Font, size, colour and baseline of the text at rect."""
    import pymupdf

    best = None
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                r = pymupdf.Rect(span["bbox"])
                if r.intersects(rect) and span["text"].strip():
                    area = (r & rect).get_area()
                    if not best or area > best[0]:
                        best = (area, span)
    if not best:
        return {"size": 11.0, "color": (0, 0, 0), "bold": False, "italic": False, "serif": False, "baseline": None, "font": ""}
    span = best[1]
    c = span["color"]
    font = span["font"]
    low = font.lower()
    return {
        "size": float(span["size"]),
        "color": ((c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255),
        "bold": bool(span["flags"] & 16) or "bold" in low or "black" in low,
        "italic": bool(span["flags"] & 2) or "italic" in low or "oblique" in low,
        "serif": any(k in low for k in ("times", "serif", "roman", "georgia", "garamond", "cambria", "minion")) and "sans" not in low,
        "baseline": span["origin"][1],
        "font": font,
    }


def _key(name: str) -> str:
    name = name.split("+", 1)[-1]
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _original_font(doc, page, font_name: str, text: str):
    """The PDF's own embedded font, if it contains every character of text."""
    import pymupdf

    want = _key(font_name)
    if not want:
        return None
    for xref, ext, _type, basefont, *_ in page.get_fonts(full=True):
        have = _key(basefont)
        if not have or not (have.startswith(want) or want.startswith(have)):
            continue
        if ext not in ("ttf", "otf", "cff", "pfa", "pfb"):
            continue
        try:
            _, _, _, buf = doc.extract_font(xref)
            if not buf:
                continue
            font = pymupdf.Font(fontbuffer=buf)
        except Exception:  # noqa: BLE001
            continue
        if all(ch.isspace() or font.has_glyph(ord(ch)) for ch in text):
            return font, buf, f"pdx{xref}"
    return None


def _draw_line(page, x0, width, y, text, align, justify, measure, kw):
    if not text:
        return
    if justify and " " in text.strip():
        words = text.split()
        gap = (width - sum(measure(w) for w in words)) / (len(words) - 1)
        if gap > measure(" ") * 0.6:
            x = x0
            for w in words:
                page.insert_text((x, y), w, **kw)
                x += measure(w) + gap
            return
    w = measure(text)
    x = x0 + (width - w if align == "right" else (width - w) / 2 if align == "center" else 0)
    page.insert_text((x, y), text, **kw)


def _apply_pdf_change(doc, change):
    import pymupdf

    words, page_of = [], []
    for pno, page in enumerate(doc):
        for w in _page_words(page):
            words.append(w)
            page_of.append(pno)
    units = _units(words)
    span = find_span([u[0] for u in units], tokens(change["find"]))
    if not span:
        return "not found in the file"
    i0, i1 = units[span[0]][1], units[span[1] - 1][2]
    if page_of[i0] != page_of[i1]:
        return "the text runs across two pages; change each page separately"
    page = doc[page_of[i0]]
    if page.rotation:
        return "rotated pages are not supported yet"

    offset = page_of.index(page_of[i0])
    pw = words[offset:offset + page_of.count(page_of[i0])]
    j0, j1 = i0 - offset, i1 - offset
    line_keys = []
    for w in pw[j0:j1 + 1]:
        if w["line"] not in line_keys:
            line_keys.append(w["line"])
    first, last = line_keys[0], line_keys[-1]
    prefix = [w["t"] for k, w in enumerate(pw) if w["line"] == first and k < j0]
    suffix = [w["t"] for k, w in enumerate(pw) if w["line"] == last and k > j1]
    lead, trail = kept_punct(pw[j0]["t"], pw[j1]["t"], change["find"])
    replacement = change["replace"].strip()
    replacement = (lead + replacement + trail) if replacement else ""
    new_text = " ".join(x for x in [" ".join(prefix), replacement, " ".join(suffix)] if x)

    def line_rect(key):
        ws = [w for w in pw if w["line"] == key]
        return pymupdf.Rect(min(w["x0"] for w in ws), min(w["y0"] for w in ws),
                            max(w["x1"] for w in ws), max(w["y1"] for w in ws))

    line_rects = [line_rect(k) for k in line_keys]
    # Group the page's lines into visual paragraphs (PDF "blocks" are unreliable).
    all_keys = list(dict.fromkeys(w["line"] for w in pw))
    rects = {k: line_rect(k) for k in all_keys}
    order = sorted(all_keys, key=lambda k: (round(rects[k].y0, 1), rects[k].x0))
    group_of: dict = {}
    groups: list[list] = []
    for k in order:
        r = rects[k]
        target = None
        for g in groups:
            q = rects[g[-1]]
            gap = r.y0 - q.y1
            same_edge = abs(r.x0 - q.x0) < 2 or abs((r.x0 + r.x1) / 2 - (q.x0 + q.x1) / 2) < 1.5
            if same_edge and -1 < gap < 0.6 * max(q.height, 1) and min(r.x1, q.x1) > max(r.x0, q.x0):
                target = g
                break
        if target is None:
            target = []
            groups.append(target)
        target.append(k)
        group_of[k] = target
    block_lines = []
    for k in line_keys:
        for k2 in group_of[k]:
            if k2 not in block_lines:
                block_lines.append(k2)
    block_lines.sort(key=lambda k: rects[k].y0)
    block_rects = [rects[k] for k in block_lines]
    area = pymupdf.Rect(min(r.x0 for r in line_rects), line_rects[0].y0,
                        max(max(r.x1 for r in block_rects), max(r.x1 for r in line_rects)), line_rects[-1].y1)

    # Alignment, judged from the whole paragraph (block) the change sits in.
    bx0 = min(r.x0 for r in block_rects)
    bx1 = max(r.x1 for r in block_rects)
    lefts_ok = all(abs(r.x0 - bx0) < 1.5 for r in block_rects)
    rights_ok = all(abs(r.x1 - bx1) < 1.5 for r in block_rects)
    full = [r for r in block_rects[:-1] if abs(r.x1 - bx1) < 2 and abs(r.x0 - bx0) < 2]
    # The column's right edge: the furthest any line starting at this paragraph's left edge reaches.
    column_right = max(r.x1 for r in rects.values() if abs(r.x0 - bx0) < 2)
    justified = (len(block_rects) > 2 and lefts_ok and len(full) == len(block_rects) - 1
                 and block_rects[-1].x1 < bx1 - 0.05 * (bx1 - bx0)) or (
                 len(block_rects) == 2 and lefts_ok and abs(block_rects[0].x1 - column_right) < 2
                 and sum(abs(r.x1 - column_right) < 2 for r in rects.values() if abs(r.x0 - bx0) < 2) >= 2
                 and block_rects[-1].x1 < bx1 - 0.05 * (bx1 - bx0) and block_rects[0].width > page.rect.width * 0.5)
    last_is_para_end = block_lines.index(last) == len(block_lines) - 1
    align = "left"
    if not justified:
        if len(block_rects) > 1:
            if rights_ok and not lefts_ok:
                align = "right"
            elif not lefts_ok and not rights_ok and all(
                    abs((r.x0 + r.x1) / 2 - (bx0 + bx1) / 2) < 1.5 for r in block_rects):
                align = "center"
        else:
            others = [line_rect(k) for k in dict.fromkeys(w["line"] for w in pw) if k not in line_keys]
            r = line_rects[0]
            rights = sum(abs(o.x1 - r.x1) < 1.5 for o in others)
            lefts = sum(abs(o.x0 - r.x0) < 1.5 for o in others)
            centre = sum(abs((o.x0 + o.x1) / 2 - (r.x0 + r.x1) / 2) < 1.5 for o in others)
            if rights > lefts and rights >= centre:
                align = "right"
            elif centre > lefts and centre > rights:
                align = "center"
    if align == "left" and not justified:
        # A left-aligned line may grow to the right, up to the next text on the same band or the right margin.
        band = [w for w in pw if w["line"] not in line_keys and w["y1"] > area.y0 + 1 and w["y0"] < area.y1 - 1
                and w["x0"] >= area.x1 - 0.5]
        right_margin = max(w["x1"] for w in pw)
        area.x1 = max(area.x1, (min(w["x0"] for w in band) - 6) if band else right_margin)
    elif align == "right":
        # A right-aligned line may grow to the left, up to the next text on the same band.
        band = [w for w in pw if w["line"] not in line_keys and w["y1"] > area.y0 + 1 and w["y0"] < area.y1 - 1
                and w["x1"] <= area.x0 + 0.5]
        area.x0 = min(area.x0, (max(w["x1"] for w in band) + 6) if band else min(w["x0"] for w in pw))

    style = _style_at(page, pymupdf.Rect(pw[j0]["x0"], pw[j0]["y0"], pw[j0]["x1"], pw[j0]["y1"]))
    size = style["size"]
    ratio = 1.2
    if len(block_rects) > 1:
        gap = (block_rects[-1].y0 - block_rects[0].y0) / (len(block_rects) - 1)
        ratio = min(max(gap / size, 1.05), 1.8)

    original = _original_font(doc, page, style["font"], new_text)
    system = None if original else _system_font(style["font"], style["bold"], style["italic"])
    if system:
        sys_font = pymupdf.Font(fontfile=system)
        if not all(ch.isspace() or sys_font.has_glyph(ord(ch)) for ch in new_text):
            system = None
    scale_fix = 1.0
    if original:
        font, buf, fontname = original
        kw_font = {"fontname": fontname}
    elif system:
        font = sys_font
        kw_font = {"fontname": "pdx" + _key(os.path.basename(system))[:20], "fontfile": system}
    else:
        fontname = {"ti": "tiro", "tibo": "tibo", "he": "helv", "hebo": "hebo"}[
            ("ti" if style["serif"] else "he") + ("bo" if style["bold"] else "")]
        kw_font = {"fontname": fontname}
        if not _latin1_ok(new_text):
            path = _unicode_font()
            if not path:
                return "the new text uses characters this server has no font for"
            kw_font = {"fontname": "pdxuni", "fontfile": path}
            font = pymupdf.Font(fontfile=path)
        else:
            font = pymupdf.Font(fontname)
        # Unknown font: match the width of the original so lines keep their length.
        sample = [w["t"] for w in pw if w["line"] in line_keys]
        orig_w = sum(w["x1"] - w["x0"] for w in pw if w["line"] in line_keys)
        ours = sum(font.text_length(t, size) for t in sample)
        scale_fix = min(max(orig_w / ours, 0.85), 1.15) if ours else 1.0

    def fits(height, s, slack=0.3):
        lines = _wrap(new_text, lambda t: font.text_length(t, s), area.width)
        needed = (len(lines) - 1) * size * ratio * (s / size) + s * 1.15
        return lines, needed <= height + s * slack

    plan = None
    base = size * scale_fix
    for scale in (1, .95, .9, .85, .8, .75, .7):
        lines, ok = fits(area.height, base * scale)
        if ok:
            plan = (lines, base * scale)
            break
    if not plan:
        below = [w["y0"] for w in pw if w["y0"] >= area.y1 - 1
                 and w["x1"] > area.x0 and w["x0"] < area.x1 and w["line"] not in line_keys]
        limit = min(below) - size * 0.35 if below else page.rect.y1 - 36
        for scale in (1, .9, .8, .7):
            lines, ok = fits(limit - area.y0, base * scale, slack=-0.1)
            if ok:
                plan = (lines, base * scale)
                break
    if not plan:
        return "the new text is too long for the space in the layout"
    lines, s = plan

    for r in line_rects:
        inset = r.height * 0.18
        page.add_redact_annot(pymupdf.Rect(r.x0 - 0.5, r.y0 + inset, r.x1 + 0.5, r.y1 - inset), fill=False)
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)
    if original:
        page.insert_font(fontname=fontname, fontbuffer=original[1])

    if style["baseline"] is not None and abs(s - size) < 0.01:
        y = style["baseline"] - (pw[j0]["y0"] - line_rects[0].y0)
    else:
        y = line_rects[0].y0 + s * font.ascender
    step = size * ratio * (s / size) if s < size else size * ratio
    kw = {"fontsize": s, "color": style["color"], **kw_font}
    measure = lambda t: font.text_length(t, s)  # noqa: E731
    for n, line in enumerate(lines):
        is_last = n == len(lines) - 1
        justify = justified and (not is_last or not last_is_para_end) and line != ""
        if is_last and justified and not last_is_para_end and len(lines) < len(line_rects):
            justify = False
        _draw_line(page, area.x0, area.width, y, line, align, justify, measure, kw)
        y += step
    if s < size * 0.92:
        change["_note"] = "set in a smaller size so it fits the original space"
    change["_mark"] = {"page": page.number, "rect": [area.x0, area.y0, area.x1, max(area.y1, y - step + s * 0.3)]}
    return None


def apply_pdf(data: bytes, changes: list[dict]) -> tuple[bytes, list[dict]]:
    import pymupdf

    doc = pymupdf.open(stream=data, filetype="pdf")
    if doc.needs_pass:
        raise ValueError("This PDF is password-protected.")
    report = []
    for i, ch in enumerate(changes):
        try:
            err = _apply_pdf_change(doc, ch)
        except Exception as exc:  # noqa: BLE001 - one bad change must not stop the others
            err = f"could not be applied ({type(exc).__name__})"
        report.append({"index": i, "ok": err is None, "reason": err, "note": ch.pop("_note", None),
                       "mark": ch.pop("_mark", None)})
    if any(r["ok"] for r in report):
        doc.subset_fonts()
    out = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    return out, report


# ---------------------------------------------------------------- DOCX

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"


def _docx_roots(document):
    roots = [document.element.body]
    seen = set()
    for section in document.sections:
        for hf in (section.header, section.footer, section.first_page_header, section.first_page_footer,
                   section.even_page_header, section.even_page_footer):
            try:
                if hf.is_linked_to_previous:
                    continue
                el = hf._element
            except Exception:  # noqa: BLE001
                continue
            if id(el) not in seen:
                seen.add(id(el))
                roots.append(el)
    return roots


def _para_text(p):
    ts = list(p.iter(_W + "t"))
    return ts, "".join(t.text or "" for t in ts)


def _replace_range(ts, start: int, end: int, new: str) -> None:
    """Replace characters [start, end) of a paragraph, keeping each run's formatting."""
    pos, placed = 0, False
    bounds = []
    for t in ts:
        txt = t.text or ""
        bounds.append((pos, pos + len(txt)))
        pos += len(txt)
    if start == end:  # pure insertion: add to the run the position belongs to
        for t, (a, b) in zip(ts, bounds):
            if a <= start < b or (start == b and t is ts[-1]) or (a <= start <= b and b > a):
                txt = t.text or ""
                t.text = txt[:start - a] + new + txt[start - a:]
                t.set(_XML_SPACE, "preserve")
                return
        return
    for t, (a, b) in zip(ts, bounds):
        if b <= start or a >= end:
            continue
        txt = t.text or ""
        lo, hi = max(start - a, 0), min(end - a, len(txt))
        t.text = txt[:lo] + (new if not placed else "") + txt[hi:]
        placed = True
        t.set(_XML_SPACE, "preserve")


def _replace_minimal(ts, start: int, end: int, new: str) -> None:
    """Swap only the words that differ, so unchanged words keep their own formatting."""
    old = "".join(t.text or "" for t in ts)[start:end]
    a, b = re.findall(r"\s+|\S+", old), re.findall(r"\s+|\S+", new)
    oa, ob = [0], [0]
    for x in a:
        oa.append(oa[-1] + len(x))
    for x in b:
        ob.append(ob[-1] + len(x))
    ops = SequenceMatcher(None, a, b, autojunk=False).get_opcodes()
    for tag, i1, i2, j1, j2 in reversed(ops):
        if tag != "equal":
            _replace_range(ts, start + oa[i1], start + oa[i2], new[ob[j1]:ob[j2]])


def apply_docx(data: bytes, changes: list[dict]) -> tuple[bytes, list[dict]]:
    from docx import Document

    document = Document(io.BytesIO(data))
    report = []
    for i, ch in enumerate(changes):
        paras = [p for root in _docx_roots(document) for p in root.iter(_W + "p")]
        hay, where = [], []
        for pi, p in enumerate(paras):
            _, text = _para_text(p)
            for m in re.finditer(r"\S+", text):
                t = norm(m.group())
                if t:
                    hay.append(t)
                    where.append((pi, m.start(), m.end()))
        span = find_span(hay, tokens(ch["find"]))
        if not span:
            report.append({"index": i, "ok": False, "reason": "not found in the file"})
            continue
        (p0, s0, _), (p1, _, e1) = where[span[0]], where[span[1] - 1]
        new = ch["replace"].strip()
        first_tok = _para_text(paras[p0])[1][s0:where[span[0]][2]]
        last_tok = _para_text(paras[p1])[1][where[span[1] - 1][1]:e1]
        lead, trail = kept_punct(first_tok, last_tok, ch["find"])
        s0 += len(lead)
        e1 -= len(trail)
        if p0 == p1:
            ts, _ = _para_text(paras[p0])
            _replace_minimal(ts, s0, e1, new)
        else:
            pieces = [x.strip() for x in re.split(r"\n\s*\n", new)]
            involved = list(range(p0, p1 + 1))
            if len(pieces) != len(involved):
                pieces = [" ".join(x for x in pieces if x)] + [""] * (len(involved) - 1)
            for k, pi in enumerate(involved):
                ts, text = _para_text(paras[pi])
                a = s0 if pi == p0 else 0
                b = e1 if pi == p1 else len(text)
                _replace_minimal(ts, a, b, pieces[k])
                _, after = _para_text(paras[pi])
                if pi not in (p0,) and not after.strip() and paras[pi].getparent() is not None:
                    paras[pi].getparent().remove(paras[pi])
        report.append({"index": i, "ok": True, "reason": None})
    buf = io.BytesIO()
    document.save(buf)
    return buf.getvalue(), report


def apply(kind: str, data: bytes, changes: list[dict]) -> tuple[bytes, list[dict]]:
    if kind == "pdf":
        return apply_pdf(data, changes)
    if kind == "docx":
        return apply_docx(data, changes)
    raise ValueError("Only PDF and Word files can be edited in place.")
