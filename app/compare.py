"""Compare two versions of a document.

The exact comparison is done here, not by the model: paragraphs are aligned
first, then the words inside changed passages. The model only gets the list of
real differences to explain, so it cannot invent a change or miss one that is
in the list.
"""
from __future__ import annotations

import html
import re
from difflib import SequenceMatcher

_WS = re.compile(r"[ \t ]+")
_TOKEN = re.compile(r"\s+|[^\s]+")
CONTEXT_WORDS = 12
MAX_PROMPT_CHARS = 14000


def paragraphs(text: str) -> list[str]:
    paras = []
    for block in re.split(r"\n\s*\n", text.replace("\r", "")):
        # Lines inside a paragraph are often just PDF line breaks; join them.
        p = _WS.sub(" ", " ".join(line.strip() for line in block.split("\n"))).strip()
        if p:
            paras.append(p)
    return paras


def _key(p: str) -> str:
    return re.sub(r"\W+", " ", p.lower()).strip()


def _words(text: str) -> list[str]:
    return _TOKEN.findall(text)


def word_diff(old: str, new: str) -> list[dict]:
    a, b = _words(old), _words(new)
    sm = SequenceMatcher(None, a, b, autojunk=False)
    parts: list[dict] = []

    def push(op: str, t: str):
        if not t:
            return
        if parts and parts[-1]["op"] == op:
            parts[-1]["t"] += t
        else:
            parts.append({"op": op, "t": t})

    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            push("=", "".join(a[i1:i2]))
        else:
            push("-", "".join(a[i1:i2]))
            push("+", "".join(b[j1:j2]))
    # A changed whitespace-only run reads better as unchanged.
    for p in parts:
        if p["op"] != "=" and not p["t"].strip():
            p["op"] = "="
    merged: list[dict] = []
    for p in parts:
        if merged and merged[-1]["op"] == p["op"]:
            merged[-1]["t"] += p["t"]
        else:
            merged.append(p)
    return merged


def diff(old_text: str, new_text: str) -> dict:
    """Blocks of {"type": "same", "text"} or {"type": "change", "old", "new", "parts"}."""
    a, b = paragraphs(old_text), paragraphs(new_text)
    sm = SequenceMatcher(None, [_key(p) for p in a], [_key(p) for p in b], autojunk=False)
    blocks: list[dict] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for p in b[j1:j2]:
                blocks.append({"type": "same", "text": p})
            continue
        olds, news = a[i1:i2], b[j1:j2]
        # Pair similar paragraphs inside the changed region, in order.
        if len(olds) * len(news) > 2500:  # largely rewritten: no point pairing
            blocks.extend([_change(o, "") for o in olds] + [_change("", n) for n in news])
            continue
        j = 0
        for o in olds:
            best, best_r = None, 0.45
            for jj in range(j, len(news)):
                m = SequenceMatcher(None, _key(o), _key(news[jj]), autojunk=False)
                r = m.ratio() if m.quick_ratio() > best_r else 0
                if r > best_r:
                    best, best_r = jj, r
            if best is None:
                blocks.append(_change(o, ""))
                continue
            for n in news[j:best]:
                blocks.append(_change("", n))
            blocks.append(_change(o, news[best]))
            j = best + 1
        for n in news[j:]:
            blocks.append(_change("", n))
    changes = [x for x in blocks if x["type"] == "change"]
    count = lambda op: sum(len(p["t"].split()) for c in changes for p in c["parts"] if p["op"] == op)
    return {
        "blocks": blocks,
        "stats": {
            "changes": len(changes),
            "added_words": count("+"),
            "removed_words": count("-"),
            "paragraphs_old": len(a),
            "paragraphs_new": len(b),
            "identical": not changes,
        },
    }


def _change(old: str, new: str) -> dict:
    if old and new:
        parts = word_diff(old, new)
    elif old:
        parts = [{"op": "-", "t": old}]
    else:
        parts = [{"op": "+", "t": new}]
    return {"type": "change", "old": old, "new": new, "parts": parts}


def _snippet(parts: list[dict]) -> tuple[str, str]:
    """Short before/after text around the changed words, for the model."""
    keep = []
    for i, p in enumerate(parts):
        if p["op"] == "=":
            w = p["t"].split()
            first, last = i == 0, i == len(parts) - 1
            if len(w) > 2 * CONTEXT_WORDS and not (first or last):
                t = " ".join(w[:CONTEXT_WORDS]) + " … " + " ".join(w[-CONTEXT_WORDS:])
            elif first and len(w) > CONTEXT_WORDS:
                t = "… " + " ".join(w[-CONTEXT_WORDS:])
            elif last and len(w) > CONTEXT_WORDS:
                t = " ".join(w[:CONTEXT_WORDS]) + " …"
            else:
                t = p["t"].strip()
            keep.append(("=", t))
        else:
            keep.append((p["op"], p["t"].strip()))
    before = " ".join(t for op, t in keep if op != "+" and t)
    after = " ".join(t for op, t in keep if op != "-" and t)
    return before, after


def change_list(result: dict, limit: int = MAX_PROMPT_CHARS) -> str:
    lines, used, shown = [], 0, 0
    changes = [b for b in result["blocks"] if b["type"] == "change"]
    for n, c in enumerate(changes, start=1):
        if not c["old"]:
            entry = f"{n}. ADDED paragraph: {c['new']}"
        elif not c["new"]:
            entry = f"{n}. REMOVED paragraph: {c['old']}"
        else:
            before, after = _snippet(c["parts"])
            entry = f"{n}. CHANGED\n   before: {before}\n   after:  {after}"
        if used + len(entry) > limit and shown:
            break
        lines.append(entry[:limit])
        used += len(entry)
        shown += 1
    rest = len(changes) - shown
    if rest > 0:
        lines.append(f"({rest} more changes not listed here.)")
    return "\n".join(lines)


COMPARE_RULES = (
    "You are comparing two versions of a document. The exact list of differences was computed by software and "
    "is complete; the document text itself is not shown. Explain what changed and what it means for the reader. "
    "Start with a one-sentence verdict. Then list the important changes first: amounts, prices, dates, deadlines, "
    "durations, obligations, rights, parties, conditions. Group small wording or typo fixes into one line at the end. "
    "Quote the old and new values exactly. Refer to changes by their number like [3]. "
    "Never mention a change that is not in the list. If the list is empty, say the two documents have the same text."
)


def compare_message(old_name: str, new_name: str, result: dict, question: str) -> str:
    st = result["stats"]
    body = change_list(result) if not st["identical"] else "(no differences)"
    return (
        f"Older version: {old_name}\nNewer version: {new_name}\n"
        f"{st['changes']} changed passages, {st['added_words']} words added, {st['removed_words']} words removed.\n"
        f"<differences>\n{body}\n</differences>\n\nMy request: {question}"
    )


def to_html(result: dict, context: int = 1) -> str:
    """Readable diff: changed passages with a little unchanged text around them."""
    blocks = result["blocks"]
    show = [b["type"] == "change" for b in blocks]
    near = [any(show[max(0, i - context):i + context + 1]) for i in range(len(blocks))]
    out, hidden, n = [], 0, 0
    for i, b in enumerate(blocks):
        if b["type"] == "change":
            n += 1
        if not near[i]:
            hidden += 1
            continue
        if hidden:
            out.append(f'<p class="cmp-skip">{hidden} unchanged paragraph{"s" if hidden > 1 else ""}</p>')
            hidden = 0
        if b["type"] == "same":
            out.append(f'<p class="cmp-same">{html.escape(b["text"])}</p>')
        else:
            cls = "cmp-add" if not b["old"] else "cmp-del" if not b["new"] else "cmp-chg"
            inner = "".join(
                html.escape(p["t"]) if p["op"] == "=" else
                f'<{"del" if p["op"] == "-" else "ins"}>{html.escape(p["t"])}</{"del" if p["op"] == "-" else "ins"}>'
                for p in b["parts"])
            out.append(f'<p class="cmp-change {cls}" data-n="{n}">{inner}</p>')
    if hidden:
        out.append(f'<p class="cmp-skip">{hidden} unchanged paragraph{"s" if hidden > 1 else ""}</p>')
    return "\n".join(out)
