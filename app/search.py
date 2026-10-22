"""Hybrid search: keywords (BM25) and meaning (embeddings), fused by rank.

Keyword search finds exact terms, names and numbers ("§ 4", "IBAN", "36 Monate").
Meaning search finds passages that say the same thing in other words
("How long can I cancel?" -> "Die Kündigungsfrist beträgt drei Monate").
Reciprocal rank fusion combines both lists without having to compare their scores.
"""
from __future__ import annotations

import math
import re
from collections import Counter

import numpy as np

STOP = set((
    "der die das den dem des und oder aber in im an am auf aus bei mit nach von vor zu zum zur für über unter ist "
    "sind war ein eine einer eines einem einen nicht auch als wie was wer wo steht stehen hat haben es ich du sie er "
    "wir ihr mein meine mir mich sich kann können wird werden dass bitte "
    "the a an and or but in on at to of for with from by is are was were be it this that what which who how does "
    "do my me can will please "
    "le la les un une des et ou mais dans sur pour avec par est sont que qui quoi"
).split())

_WORD = re.compile(r"[^\W_]+", re.UNICODE)
RRF_K = 60
POOL = 30  # candidates taken from each list before fusing


def tokens(text: str) -> list[str]:
    return [t for t in _WORD.findall(text.lower()) if len(t) > 1 and t not in STOP]


class BM25:
    def __init__(self, docs: list[list[str]], k1: float = 1.2, b: float = 0.75):
        self.k1, self.b = k1, b
        self.tf = [Counter(d) for d in docs]
        self.len = [len(d) for d in docs]
        self.avg = (sum(self.len) / len(docs)) if docs else 1.0
        self.df: Counter = Counter()
        for c in self.tf:
            self.df.update(c.keys())
        self.n = len(docs)

    def scores(self, query: list[str]) -> np.ndarray:
        out = np.zeros(self.n, dtype=np.float32)
        for t in set(query):
            df = self.df.get(t)
            if not df:
                continue
            idf = math.log(1 + (self.n - df + 0.5) / (df + 0.5))
            for i, c in enumerate(self.tf):
                f = c.get(t)
                if f:
                    norm = self.k1 * (1 - self.b + self.b * self.len[i] / (self.avg or 1))
                    out[i] += idf * f * (self.k1 + 1) / (f + norm)
        return out


def fuse(vector_scores: np.ndarray | None, keyword_scores: np.ndarray, k: int) -> list[tuple[int, float, str]]:
    """Return [(index, fused score 0..1, "meaning"|"keywords"|"both")], best first."""
    n = len(keyword_scores)
    ranks: dict[int, float] = {}
    found: dict[int, set] = {}

    def add(scores: np.ndarray, label: str, positive_only: bool):
        order = np.argsort(-scores)[:POOL]
        for r, i in enumerate(order):
            if positive_only and scores[i] <= 0:
                break
            ranks[int(i)] = ranks.get(int(i), 0.0) + 1.0 / (RRF_K + r + 1)
            found.setdefault(int(i), set()).add(label)

    if vector_scores is not None and len(vector_scores) == n:
        add(vector_scores, "meaning", False)
    add(keyword_scores, "keywords", True)
    best = 2.0 / (RRF_K + 1)  # rank 1 in both lists
    top = sorted(ranks.items(), key=lambda kv: -kv[1])[:k]
    return [(i, round(s / best, 3), "both" if len(found[i]) == 2 else next(iter(found[i]))) for i, s in top]
