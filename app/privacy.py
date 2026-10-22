"""Change checking, personal-data detection, true redaction and previews.

Mirrors docs/app/layout.js in the browser version. Everything works on bytes in
memory; nothing is written to disk.
"""
from __future__ import annotations

import base64
import io
import re
import unicodedata

from .layout_edit import _W, _docx_roots, _para_text, _replace_range, find_span, norm, tokens

# ---------------------------------------------------------------- checking changes


def _word_spans(text: str):
    out = []
    for m in re.finditer(r"\S+", text):
        t = norm(m.group())
        if t:
            out.append((t, m.start(), m.end()))
    return out


def locate(doc_text: str, find: str) -> str | None:
    """'exact', 'close' or None: is this FIND text in the document?"""
    words = _word_spans(doc_text)
    needle = tokens(find)
    hay = [w[0] for w in words]
    span = find_span(hay, needle)
    if not span:
        return None
    return "exact" if hay[span[0]:span[1]] == needle else "close"


def _lcs(a, b):
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b, 1):
            cur.append(prev[j - 1] + 1 if x == y else max(prev[j], cur[-1]))
        prev = cur
    return prev[-1]


def closest_passage(doc_text: str, find: str) -> str | None:
    """The passage of the document most like `find`, in the document's own words."""
    words = _word_spans(doc_text)
    needle = tokens(find)
    n = len(needle)
    if not n or not words:
        return None
    wanted = set(needle)
    best, span = 0.0, None
    for length in (n - 2, n - 1, n, n + 1, n + 2, n + 4):
        if length < 1:
            continue
        for i in range(len(words) - length + 1):
            window = [w[0] for w in words[i:i + length]]
            if sum(t in wanted for t in window) / max(length, n) <= best * 0.9:
                continue
            r = 2 * _lcs(window, needle) / (length + n)
            if r > best:
                best, span = r, (i, i + length)
    if not span or best < 0.35:
        return None
    return doc_text[words[span[0]][1]:words[span[1] - 1][2]]


REPAIR_SYSTEM = ("You correct FIND/REPLACE edits so they match a document exactly. For each change, set FIND to the "
                 "closest text from the document, copied exactly, and write REPLACE so it applies the same edit to that "
                 "text. Reply only with FIND:/REPLACE: pairs, in the same order, separated by an empty line.")


def repair_prompt(items: list[tuple[dict, str]]) -> str:
    return "\n\n".join(
        f"Change {k}\nYour FIND: {c['find']}\nClosest text in the document: {near}\nYour REPLACE: {c['replace']}"
        for k, (c, near) in enumerate(items, 1))


# ---------------------------------------------------------------- personal data

def _iban_ok(raw: str) -> bool:
    s = re.sub(r"\s+", "", raw).upper()
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{10,30}", s):
        return False
    r = "".join(str(ord(c) - 55) if c.isalpha() else c for c in s[4:] + s[:4])
    return int(r) % 97 == 1


def _luhn(raw: str) -> bool:
    d = re.sub(r"\D", "", raw)
    if not 13 <= len(d) <= 19:
        return False
    total = 0
    for i, ch in enumerate(reversed(d)):
        x = int(ch)
        if i % 2:
            x *= 2
            x = x - 9 if x > 9 else x
        total += x
    return total % 10 == 0


def _phone_ok(v: str) -> bool:
    n = len(re.sub(r"\D", "", v))
    return 7 <= n <= 15 and not re.fullmatch(r"\d{1,2}\.\d{1,2}\.\d{2,4}", v.strip())


_UP = r"[^\W\d_a-zß-ÿ]"  # an uppercase letter (approximation that works for Latin scripts)
_NAME_WORD = rf"(?:{_UP}[^\W\d_]*?[a-zß-ÿ]+(?:['’-]{_UP}?[a-zß-ÿ]+)*)"

PII_RULES = [
    ("email", re.compile(r"[\w.%+-]+@[\w-]+(?:\.[\w-]+)+"), None, 0),
    ("iban", re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b"), _iban_ok, 0),
    ("card", re.compile(r"\b\d(?:[ -]?\d){12,18}\b"), _luhn, 0),
    ("phone", re.compile(r"(?:(?:\+|00)\d{1,3}[\s./-]?(?:\(0\)[\s./-]?)?|\b0)\d{2,5}(?:[\s./-]?\d{2,8}){1,4}\b"), _phone_ok, 0),
    ("birthdate", re.compile(r"(?:geb(?:oren)?\.?(?:\s+am)?|Geburtsdatum:?|date of birth:?|born(?:\s+on)?|DOB:?|né(?:e)? le)\s*"
                             r"(\d{1,2}[./-]\s?\d{1,2}[./-]\s?\d{2,4}|\d{1,2}\.?\s+\w+\s+\d{4})", re.I), None, 1),
    ("id", re.compile(r"(?:Steuer-?ID|Steuer-?Identifikationsnummer|Steuernummer|Sozialversicherungsnummer|SV-Nummer|"
                      r"Personalausweis(?:nummer)?|Ausweisnummer|Reisepass(?:nummer)?|Passport(?: No\.?| number)?|Tax ID|"
                      r"Social Security(?: Number)?|SSN|Versichertennummer|Personalnummer)\s*[:#]?\s*([A-Z0-9][A-Z0-9 /-]{4,24}[A-Z0-9])",
                      re.I), None, 1),
    ("name", re.compile(rf"\b(?:Frau|Herrn?|Hr\.|Fr\.|Dr\.|Prof\.|Mr\.?|Mrs\.?|Ms\.?|Mme|Madame|Monsieur)\s+(?:(?:Dr|Prof)\.\s+)?"
                        rf"({_NAME_WORD}(?:[ -]{_NAME_WORD}){{0,2}})"), None, 1),
    ("name", re.compile(rf"\b(?:Name|Vorname|Nachname|Ansprechpartner(?:in)?|Contact|Nom)\s*:\s*({_NAME_WORD}(?:[ -]{_NAME_WORD}){{0,3}})"),
     None, 1),
    ("address", re.compile(r"[A-ZÄÖÜ][\w.-]*(?:straße|strasse|str\.|weg|gasse|platz|allee|ring|damm|ufer|chaussee|steig|pfad|"
                           r"street|st\.|road|avenue|lane|rue)\s+\d+\s?[a-zA-Z]?(?:\s*[,\n]\s*\d{5}\s+[A-ZÄÖÜ][\w-]+"
                           r"(?:\s(?:am|an der|im|in der)\s[A-ZÄÖÜ][\w-]+)?)?"), None, 0),
    ("address", re.compile(r"\b\d{5}\s+[A-ZÄÖÜ][\w-]+(?:\s(?:am|an der|im|in der)\s[A-ZÄÖÜ][\w-]+)?"),
     lambda v: not re.match(r"\d{5}\s+(?:Euro|EUR|Stück|Mitarbeiter|Kunden)", v), 0),
]


def detect_pii(text: str) -> list[dict]:
    found: dict[str, dict] = {}
    for kind, rx, check, group in PII_RULES:
        for m in rx.finditer(text):
            v = (m.group(group) if group else m.group()).strip().rstrip(".,;:")
            if not v or (check and not check(v)):
                continue
            if kind == "phone" and any(f["type"] in ("iban", "card") and v in f["value"] for f in found.values()):
                continue
            found.setdefault(v, {"type": kind, "value": v})
    items = list(found.values())
    return [a for a in items if not any(b is not a and len(b["value"]) > len(a["value"]) and a["value"] in b["value"]
                                        for b in items)]


PII_SYSTEM = ("You find personal data in documents. Reply only with lines in the format TYPE: exact text. TYPE is NAME "
              "(a person's name) or ADDRESS (a street address with house number, or a postcode with city). Copy each item "
              "exactly as written in the document. Do not list company names, job titles or dates. If there is nothing, "
              "reply NONE.")


def pii_user_prompt(text: str) -> str:
    return (f"Document:\n<document>\n{text}\n</document>\n\n"
            "List every person's name and every address in this document.")


def parse_pii_answer(answer: str, text: str) -> list[dict]:
    out = []
    for line in answer.splitlines():
        m = re.match(r"^\s*[-*]?\s*(NAME|ADDRESS)\s*:\s*(.+?)\s*$", line, re.I)
        if not m:
            continue
        value = m.group(2).strip().strip("\"'„“”")
        if len(value) > 2 and value in text:  # only what is really in the document
            out.append({"type": "name" if m.group(1).upper() == "NAME" else "address", "value": value})
    return out


def redact_pdf(data: bytes, terms: list[str]) -> tuple[bytes, list[int], list[dict]]:
    import pymupdf

    doc = pymupdf.open(stream=data, filetype="pdf")
    counts = [0] * len(terms)
    marks = []
    for page in doc:
        hit_any = False
        seen = set()
        # OCR text layers (Tesseract's GlyphLessFont) are narrower than the printed letters: pad more.
        scanned = any(span.get("font") == "GlyphLessFont" for b in page.get_text("dict")["blocks"]
                      for line in b.get("lines", []) for span in line["spans"])
        for i, term in enumerate(terms):
            # PyMuPDF's search ignores case, so one search finds every spelling.
            prev = None
            for quads in page.search_for(term, quads=True, flags=pymupdf.TEXT_DEHYPHENATE):
                r = quads.rect
                # one match can come back as several boxes (one per word or line): count it once
                same_hit = prev is not None and (
                    (abs(r.y0 - prev.y0) < 2 and 0 <= r.x0 - prev.x1 < r.height * 2.5) or (0 <= r.y0 - prev.y1 < r.height))
                prev = r
                key = (round(r.x0), round(r.y0), round(r.x1), round(r.y1))
                if key in seen:
                    continue
                seen.add(key)
                px = r.height * 0.6 if scanned else 0.5
                py = r.height * 0.25 if scanned else 0.5
                r = pymupdf.Rect(r.x0 - px, r.y0 - py, r.x1 + px, r.y1 + py)
                page.add_redact_annot(r, fill=(0, 0, 0))
                marks.append({"page": page.number, "rect": [r.x0, r.y0, r.x1, r.y1]})
                counts[i] += 0 if same_hit else 1
                hit_any = True
        if hit_any:
            page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_PIXELS, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)
    doc.set_metadata({})
    try:
        doc.del_xml_metadata()
    except Exception:  # noqa: BLE001
        pass
    out = doc.tobytes(garbage=4, deflate=True, clean=True)
    doc.close()
    return out, counts, marks


def redact_docx(data: bytes, terms: list[str]) -> tuple[bytes, list[int]]:
    import zipfile

    from docx import Document

    document = Document(io.BytesIO(data))
    counts = [0] * len(terms)
    roots = list(_docx_roots(document))
    part_names = ("footnotes", "endnotes", "comments")
    for rel in document.part.rels.values():
        if any(n in rel.reltype for n in part_names) and hasattr(rel.target_part, "element"):
            roots.append(rel.target_part.element)
    for root in roots:
        for p in root.iter(_W + "p"):
            for i, term in enumerate(terms):
                while True:
                    ts, text = _para_text(p)
                    at = text.lower().find(term.lower())
                    if at < 0:
                        break
                    _replace_range(ts, at, at + len(term), "█" * max(3, min(len(term), 12)))
                    counts[i] += 1
    cp = document.core_properties
    for attr in ("author", "last_modified_by", "title", "subject", "keywords", "comments", "category"):
        try:
            setattr(cp, attr, "")
        except Exception:  # noqa: BLE001
            pass
    buf = io.BytesIO()
    document.save(buf)
    # app.xml carries Company/Manager; python-docx does not expose them.
    src = zipfile.ZipFile(io.BytesIO(buf.getvalue()))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            raw = src.read(item.filename)
            if item.filename in ("docProps/app.xml", "docProps/custom.xml"):
                x = raw.decode("utf-8")
                x = re.sub(r"<(Company|Manager)>[^<]*</\1>", r"<\1></\1>", x)
                x = re.sub(r"<vt:lpwstr>[^<]*</vt:lpwstr>", "<vt:lpwstr></vt:lpwstr>", x) if "custom" in item.filename else x
                raw = x.encode("utf-8")
            dst.writestr(item, raw)
    return out.getvalue(), counts


# ---------------------------------------------------------------- previews

def pdf_text(data: bytes) -> str:
    import pymupdf

    doc = pymupdf.open(stream=data, filetype="pdf")
    text = "\n".join(page.get_text("text") for page in doc)
    doc.close()
    return text


def render_pages(data: bytes, pages: list[int], zoom: float = 1.6) -> list[dict]:
    import pymupdf

    doc = pymupdf.open(stream=data, filetype="pdf")
    out = []
    for p in pages:
        if 0 <= p < doc.page_count:
            page = doc[p]
            pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
            out.append({"page": p, "png": base64.b64encode(pix.tobytes("png")).decode(),
                        "width": page.rect.width, "height": page.rect.height})
    doc.close()
    return out


def docx_html(data: bytes) -> str:
    import mammoth

    return mammoth.convert_to_html(io.BytesIO(data)).value


def preview(kind: str, before: bytes, after: bytes, marks: list[dict], highlight: list[str] | None = None) -> dict:
    if kind == "pdf":
        pages = sorted({m["page"] for m in marks if "page" in m})[:4] or [0]
        return {"kind": "pdf", "marks": [m for m in marks if "page" in m],
                "after": render_pages(after, pages), "before": render_pages(before, pages)}
    if kind in ("xlsx", "pptx"):
        from . import office
        to_html = office.xlsx_html if kind == "xlsx" else office.pptx_html
        return {"kind": "html", "after_html": to_html(after, highlight), "before_html": to_html(before)}
    return {"kind": "docx", "after_html": docx_html(after), "before_html": docx_html(before)}


def redact(kind: str, data: bytes, terms: list[str]) -> tuple[bytes, list[int], list[dict]]:
    if kind == "pdf":
        return redact_pdf(data, terms)
    if kind == "docx":
        out, counts = redact_docx(data, terms)
        return out, counts, []
    from . import office
    out, counts = (office.xlsx_redact if kind == "xlsx" else office.pptx_redact)(data, terms)
    return out, counts, []


def unicode_safe(text: str) -> str:
    return unicodedata.normalize("NFC", text)
