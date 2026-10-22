"""RAM-only state. Nothing in this module ever touches disk.

Every login creates a Session. All documents, vectors and chat history live
inside that Session object and are dropped when the user logs out, when the
session is idle too long, when it reaches its maximum age, or when the
process stops. There is no database and no persistence layer.
"""
from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass, field

import numpy as np


@dataclass
class Chunk:
    doc_id: str
    doc_name: str
    index: int
    text: str


@dataclass
class Document:
    id: str
    name: str
    chars: int
    chunks: int
    kind: str = ""          # "pdf", "docx", "xlsx" or "pptx" when the original is kept for editing
    editable: bool = False  # in-place text edits keep the layout
    scanned: bool = False   # text came from OCR (redaction yes, text edits no)
    form: bool = False      # PDF with fillable fields


@dataclass
class Workspace:
    id: str
    name: str
    system_prompt: str = ""
    documents: dict[str, Document] = field(default_factory=dict)
    texts: dict[str, str] = field(default_factory=dict, repr=False)  # full text per document
    originals: dict[str, bytes] = field(default_factory=dict, repr=False)  # original PDF/DOCX bytes, RAM only
    chunks: list[Chunk] = field(default_factory=list)
    vectors: np.ndarray | None = None  # shape (n_chunks, dim), L2-normalised
    history: list[dict] = field(default_factory=list)  # {"role", "content"}
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, doc: Document, chunks: list[Chunk], vectors: np.ndarray, text: str = "",
            original: bytes | None = None) -> None:
        with self.lock:
            if self.vectors is not None and self.vectors.shape[1] != vectors.shape[1]:
                raise ValueError("Embedding dimension changed; create a new workspace.")
            self.documents[doc.id] = doc
            self.texts[doc.id] = text
            if original is not None:
                self.originals[doc.id] = original
            self.chunks.extend(chunks)
            self.vectors = vectors if self.vectors is None else np.vstack([self.vectors, vectors])

    def remove(self, doc_id: str) -> bool:
        with self.lock:
            if doc_id not in self.documents:
                return False
            del self.documents[doc_id]
            self.texts.pop(doc_id, None)
            self.originals.pop(doc_id, None)
            keep = [i for i, c in enumerate(self.chunks) if c.doc_id != doc_id]
            self.chunks = [self.chunks[i] for i in keep]
            self.vectors = self.vectors[keep] if keep and self.vectors is not None else None
            return True

    def total_chars(self) -> int:
        return sum(len(t) for t in self.texts.values())

    def full_documents(self) -> list[tuple[str, str]]:
        with self.lock:
            return [(self.documents[i].name, t) for i, t in self.texts.items() if i in self.documents]

    def search(self, query_vec: np.ndarray, k: int) -> list[tuple[Chunk, float]]:
        with self.lock:
            if self.vectors is None or not self.chunks:
                return []
            scores = self.vectors @ query_vec
            k = min(k, len(self.chunks))
            top = np.argpartition(-scores, k - 1)[:k]
            top = top[np.argsort(-scores[top])]
            return [(self.chunks[i], float(scores[i])) for i in top]

    def summary(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "system_prompt": self.system_prompt,
            "documents": [d.__dict__ for d in self.documents.values()],
            "history": self.history,
        }


@dataclass
class Session:
    token: str
    csrf: str
    username: str
    created: float
    last_seen: float
    workspaces: dict[str, Workspace] = field(default_factory=dict)

    def chunk_count(self) -> int:
        return sum(len(w.chunks) for w in self.workspaces.values())

    def wipe(self) -> None:
        for ws in self.workspaces.values():
            ws.chunks.clear()
            ws.history.clear()
            ws.documents.clear()
            ws.texts.clear()
            ws.originals.clear()
            ws.vectors = None
        self.workspaces.clear()


class SessionStore:
    def __init__(self, idle_seconds: int, max_age_seconds: int):
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()
        self.idle_seconds = idle_seconds
        self.max_age_seconds = max_age_seconds

    def create(self, username: str) -> Session:
        now = time.time()
        s = Session(
            token=secrets.token_urlsafe(32),
            csrf=secrets.token_urlsafe(32),
            username=username,
            created=now,
            last_seen=now,
        )
        ws = Workspace(id=secrets.token_hex(8), name="My workspace")
        s.workspaces[ws.id] = ws
        with self._lock:
            self._sessions[s.token] = s
        return s

    def get(self, token: str | None) -> Session | None:
        if not token:
            return None
        with self._lock:
            s = self._sessions.get(token)
        if s is None:
            return None
        now = time.time()
        if now - s.last_seen > self.idle_seconds or now - s.created > self.max_age_seconds:
            self.destroy(token)
            return None
        s.last_seen = now
        return s

    def destroy(self, token: str) -> None:
        with self._lock:
            s = self._sessions.pop(token, None)
        if s:
            s.wipe()

    def reap(self) -> int:
        now = time.time()
        with self._lock:
            expired = [
                t for t, s in self._sessions.items()
                if now - s.last_seen > self.idle_seconds or now - s.created > self.max_age_seconds
            ]
        for t in expired:
            self.destroy(t)
        return len(expired)

    def count(self) -> int:
        with self._lock:
            return len(self._sessions)
