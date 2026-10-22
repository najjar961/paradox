"""Fill in PDF forms (AcroForm fields) in memory.

The model suggests values as JSON from what the user told it and their other
documents; every value is checked against the field (known name, allowed
choice, yes/no for checkboxes) before the user reviews and applies it.
"""
from __future__ import annotations

import json
import re

TYPES = {2: "checkbox", 3: "choice", 4: "choice", 5: "radio", 7: "text", 6: "signature", 1: "button"}


def _label_for(page, rect, words) -> str:
    """The text a person would read as this field's label: left of it on the same line, else just above."""
    import pymupdf

    left = [w for w in words if w[2] <= rect.x0 + 2 and abs((w[1] + w[3]) / 2 - (rect.y0 + rect.y1) / 2) < max(6, rect.height * 0.6)
            and rect.x0 - w[2] < 260]
    if left:
        line = sorted(left, key=lambda w: w[0])
        return " ".join(w[4] for w in line).strip(" :")
    right = [w for w in words if w[0] >= rect.x1 - 2 and abs((w[1] + w[3]) / 2 - (rect.y0 + rect.y1) / 2) < max(6, rect.height * 0.8)
             and w[0] - rect.x1 < 30]
    if right:  # checkboxes usually have their text on the right
        line = [w for w in words if abs(w[1] - right[0][1]) < 3 and w[0] >= rect.x1 - 2]
        return " ".join(w[4] for w in sorted(line, key=lambda w: w[0])).strip(" :")
    above = [w for w in words if 0 < rect.y0 - w[3] < 16 and w[2] > rect.x0 - 4 and w[0] < rect.x1]
    if above:
        return " ".join(w[4] for w in sorted(above, key=lambda w: w[0])).strip(" :")
    return ""


def list_fields(data: bytes) -> list[dict]:
    import pymupdf

    doc = pymupdf.open(stream=data, filetype="pdf")
    out, seen = [], set()
    for page in doc:
        words = page.get_text("words")
        for w in page.widgets() or []:
            kind = TYPES.get(w.field_type, "text")
            if kind in ("button", "signature") or not w.field_name:
                continue
            key = (w.field_name, kind)
            if key in seen and kind != "radio":
                continue
            seen.add(key)
            label = (w.field_label or "").strip() or _label_for(page, w.rect, words) or w.field_name
            field = {"name": w.field_name, "label": label[:120], "type": kind, "page": page.number,
                     "value": w.field_value if kind != "checkbox" else w.field_value not in (None, "", "Off", False)}
            if kind == "choice":
                field["options"] = [c if isinstance(c, str) else c[-1] for c in (w.choice_values or [])]
            if kind == "radio":
                field["options"] = [w.on_state()] if w.on_state() else []
            out.append(field)
    # merge radio buttons that share a name
    merged: dict[str, dict] = {}
    result = []
    for f in out:
        if f["type"] == "radio":
            if f["name"] in merged:
                merged[f["name"]]["options"] += [o for o in f["options"] if o not in merged[f["name"]]["options"]]
                continue
            merged[f["name"]] = f
        result.append(f)
    doc.close()
    return result


FILL_SYSTEM = ("You fill in forms. You get the form's fields and information about the person. Reply with one JSON "
               "object that maps field names to values, and nothing else. Only fill fields you have information for; "
               "leave the rest out. For checkbox fields use true or false. For choice fields use exactly one of the "
               "listed options. Write dates and numbers the way the form's language expects. Never invent personal "
               "data that is not in the information.")


def fill_prompt(fields: list[dict], info: str, documents: str) -> str:
    spec = [{k: f[k] for k in ("name", "label", "type", "options") if k in f} for f in fields]
    parts = [f"Form fields:\n{json.dumps(spec, ensure_ascii=False, indent=1)}"]
    if info.strip():
        parts.append(f"What the person told you:\n<info>\n{info.strip()}\n</info>")
    if documents.strip():
        parts.append(f"The person's other documents:\n<documents>\n{documents.strip()}\n</documents>")
    parts.append("Reply with the JSON object only.")
    return "\n\n".join(parts)


def parse_fill_answer(answer: str, fields: list[dict]) -> dict:
    m = re.search(r"\{.*\}", answer, re.S)
    if not m:
        return {}
    try:
        raw = json.loads(m.group())
    except json.JSONDecodeError:
        return {}
    by_name = {f["name"]: f for f in fields}
    by_label = {f["label"].lower(): f for f in fields}
    out = {}
    for k, v in raw.items():
        f = by_name.get(k) or by_label.get(str(k).lower())
        if not f or v is None:
            continue
        if f["type"] == "checkbox":
            out[f["name"]] = v is True or str(v).strip().lower() in ("true", "yes", "ja", "x", "1", "on")
        elif f["type"] in ("choice", "radio"):
            match = next((o for o in f.get("options", []) if o.lower() == str(v).strip().lower()), None)
            if match:
                out[f["name"]] = match
        else:
            s = str(v).strip()
            if s:
                out[f["name"]] = s[:500]
    return out


def fill(data: bytes, values: dict) -> tuple[bytes, list[dict]]:
    import pymupdf

    doc = pymupdf.open(stream=data, filetype="pdf")
    marks = []
    for page in doc:
        for w in page.widgets() or []:
            if w.field_name not in values:
                continue
            v = values[w.field_name]
            kind = TYPES.get(w.field_type, "text")
            if kind == "checkbox":
                w.field_value = w.on_state() if v else "Off"
            elif kind == "radio":
                w.field_value = w.on_state() if w.on_state() == v else "Off"
            else:
                w.field_value = str(v)
            w.update()
            marks.append({"page": page.number, "rect": [w.rect.x0, w.rect.y0, w.rect.x1, w.rect.y1]})
    out = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    return out, marks
