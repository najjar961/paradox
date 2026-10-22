"""Paradox: a multi-user, RAM-only document chat server."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import re
import secrets
from pathlib import Path
from urllib.parse import unquote

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .auth import LoginLimiter, UserDirectory
from .config import Settings, load_settings
from .export import clean_text, to_docx, to_pdf
from . import layout_edit, privacy
from .ingest import IngestError, chunk_text, extension, extract_text, SUPPORTED
from .providers import ChatModel, Embedder, ProviderError
from .rag import build_system_prompt, build_user_message, citations, document_citations
from .store import Chunk, Document, Session, SessionStore, Workspace

COOKIE = "pdx_session"
STATIC = Path(__file__).parent / "static"

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; "
    "frame-ancestors 'none'; form-action 'self'"
)


# ---------------------------------------------------------------- schemas

class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class WorkspaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class WorkspacePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    system_prompt: str | None = Field(default=None, max_length=4000)


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    keep_layout: bool = False


class ChangeIn(BaseModel):
    find: str = Field(min_length=1, max_length=8000)
    replace: str = Field(default="", max_length=8000)


class ApplyIn(BaseModel):
    changes: list[ChangeIn] = Field(min_length=1, max_length=50)


class RedactIn(BaseModel):
    terms: list[str] = Field(min_length=1, max_length=200)


class ExportIn(BaseModel):
    text: str = Field(min_length=1, max_length=200_000)
    format: str = Field(pattern="^(pdf|docx|txt)$")
    filename: str = Field(default="paradox", max_length=120)


# ---------------------------------------------------------------- app factory

def create_app(settings: Settings | None = None) -> FastAPI:
    s = settings or load_settings()
    users = UserDirectory(s.users_file)
    store = SessionStore(s.session_idle_minutes * 60, s.session_max_hours * 3600)
    limiter = LoginLimiter(s.login_max_attempts, s.login_window_seconds)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.http = httpx.AsyncClient()
        app.state.embedder = Embedder(s, app.state.http)
        app.state.chat = ChatModel(s, app.state.http)

        async def reaper():
            while True:
                await asyncio.sleep(60)
                store.reap()

        task = asyncio.create_task(reaper())
        try:
            yield
        finally:
            task.cancel()
            for token in list(store._sessions):  # wipe everything on shutdown
                store.destroy(token)
            await app.state.http.aclose()

    app = FastAPI(title="Paradox", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = s
    app.state.store = store
    app.state.users = users

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        h = response.headers
        h["Content-Security-Policy"] = CSP
        h["X-Content-Type-Options"] = "nosniff"
        h["X-Frame-Options"] = "DENY"
        h["Referrer-Policy"] = "no-referrer"
        h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        h["Cross-Origin-Opener-Policy"] = "same-origin"
        h["Cache-Control"] = "no-store"
        if s.cookie_secure:
            h["Strict-Transport-Security"] = "max-age=31536000"
        return response

    # ------------------------------------------------------------ deps

    def current_session(request: Request) -> Session:
        sess = store.get(request.cookies.get(COOKIE))
        if sess is None:
            raise HTTPException(401, "Not logged in or session expired.")
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            sent = request.headers.get("x-csrf-token", "")
            if not secrets.compare_digest(sent, sess.csrf):
                raise HTTPException(403, "Missing or invalid CSRF token.")
        return sess

    def workspace(ws_id: str, sess: Session = Depends(current_session)) -> Workspace:
        ws = sess.workspaces.get(ws_id)
        if ws is None:
            raise HTTPException(404, "Workspace not found.")
        return ws

    # ------------------------------------------------------------ pages

    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(STATIC / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/api/health")
    async def health():
        return {"ok": True, "llm": s.llm_provider, "embeddings": s.embed_provider}

    # ------------------------------------------------------------ auth

    @app.post("/api/login")
    async def login(body: LoginIn, request: Request):
        client = request.client.host if request.client else "?"
        key = f"{client}|{body.username.lower()}"
        if limiter.blocked(key):
            raise HTTPException(429, "Too many failed attempts. Try again later.")
        ok = await asyncio.to_thread(users.verify, body.username, body.password)
        if not ok:
            limiter.fail(key)
            raise HTTPException(401, "Invalid username or password.")
        limiter.reset(key)
        old = request.cookies.get(COOKIE)
        if old:
            store.destroy(old)
        sess = store.create(body.username)
        resp = JSONResponse(_me(sess))
        resp.set_cookie(
            COOKIE, sess.token, httponly=True, secure=s.cookie_secure, samesite="strict",
            max_age=s.session_max_hours * 3600, path="/",
        )
        return resp

    @app.post("/api/logout")
    async def logout(request: Request, sess: Session = Depends(current_session)):
        store.destroy(sess.token)
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(COOKIE, path="/")
        return resp

    def _me(sess: Session) -> dict:
        return {
            "username": sess.username,
            "csrf": sess.csrf,
            "idle_minutes": s.session_idle_minutes,
            "max_upload_mb": s.max_upload_mb,
            "supported": sorted(SUPPORTED),
            "model": s.llm_model,
            "provider": s.llm_provider,
        }

    @app.get("/api/me")
    async def me(sess: Session = Depends(current_session)):
        return _me(sess)

    # ------------------------------------------------------------ workspaces

    @app.get("/api/workspaces")
    async def list_workspaces(sess: Session = Depends(current_session)):
        return [w.summary() for w in sess.workspaces.values()]

    @app.post("/api/workspaces")
    async def create_workspace(body: WorkspaceIn, sess: Session = Depends(current_session)):
        if len(sess.workspaces) >= s.max_workspaces_per_user:
            raise HTTPException(400, f"Limit of {s.max_workspaces_per_user} workspaces reached.")
        ws = Workspace(id=secrets.token_hex(8), name=body.name.strip())
        sess.workspaces[ws.id] = ws
        return ws.summary()

    @app.patch("/api/workspaces/{ws_id}")
    async def update_workspace(body: WorkspacePatch, ws: Workspace = Depends(workspace)):
        if body.name is not None:
            ws.name = body.name.strip()
        if body.system_prompt is not None:
            ws.system_prompt = body.system_prompt
        return ws.summary()

    @app.delete("/api/workspaces/{ws_id}")
    async def delete_workspace(ws_id: str, sess: Session = Depends(current_session)):
        ws = sess.workspaces.pop(ws_id, None)
        if ws is None:
            raise HTTPException(404, "Workspace not found.")
        ws.chunks.clear(); ws.history.clear(); ws.vectors = None
        return {"ok": True}

    @app.delete("/api/workspaces/{ws_id}/history")
    async def clear_history(ws: Workspace = Depends(workspace)):
        ws.history.clear()
        return {"ok": True}

    # ------------------------------------------------------------ documents

    @app.post("/api/workspaces/{ws_id}/documents")
    async def upload(request: Request, ws: Workspace = Depends(workspace),
                     sess: Session = Depends(current_session)):
        # Raw body upload (not multipart) so the bytes never get spooled to a temp file.
        name = unquote(request.headers.get("x-filename", "")).strip()[:200]
        name = name.replace("/", "_").replace("\\", "_")
        if not name:
            raise HTTPException(400, "Missing X-Filename header.")
        if extension(name) not in SUPPORTED:
            raise HTTPException(415, f"Unsupported file type. Allowed: {', '.join(sorted(SUPPORTED))}")
        limit = s.max_upload_mb * 1024 * 1024
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            raise HTTPException(413, f"File is larger than {s.max_upload_mb} MB.")
        buf = bytearray()
        async for part in request.stream():
            buf.extend(part)
            if len(buf) > limit:
                raise HTTPException(413, f"File is larger than {s.max_upload_mb} MB.")
        try:
            raw = bytes(buf)
            text = await asyncio.to_thread(extract_text, name, raw)
        except IngestError as exc:
            raise HTTPException(422, str(exc)) from exc
        finally:
            buf.clear()

        pieces = chunk_text(text, s.chunk_size, s.chunk_overlap)
        if sess.chunk_count() + len(pieces) > s.max_chunks_per_user:
            raise HTTPException(400, "This session's document limit is reached. Remove some documents first.")
        try:
            vectors = await request.app.state.embedder.embed(pieces)
        except ProviderError as exc:
            raise HTTPException(502, str(exc)) from exc

        kind = extension(name).lstrip(".")
        editable = kind in ("pdf", "docx")
        doc = Document(id=secrets.token_hex(8), name=name, chars=len(text), chunks=len(pieces),
                       kind=kind if editable else "", editable=editable)
        chunks = [Chunk(doc.id, name, i, t) for i, t in enumerate(pieces)]
        try:
            ws.add(doc, chunks, vectors, text, raw if editable else None)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return doc.__dict__

    @app.post("/api/workspaces/{ws_id}/documents/{doc_id}/apply")
    async def apply_changes(doc_id: str, body: ApplyIn, ws: Workspace = Depends(workspace)):
        """Apply FIND/REPLACE changes to the original file and send it back. Nothing is kept."""
        doc = ws.documents.get(doc_id)
        original = ws.originals.get(doc_id)
        if doc is None or original is None:
            raise HTTPException(404, "This document can't be edited in place. Only PDF and Word files can.")
        changes = [c.model_dump() for c in body.changes]
        try:
            data, report = await asyncio.to_thread(layout_edit.apply, doc.kind, original, changes)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        stem = re.sub(r"[^\w\-. ]", "_", doc.name.rsplit(".", 1)[0]).strip(" ._") or "document"
        media = "application/pdf" if doc.kind == "pdf" else \
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        return Response(data, media_type=media, headers={
            "Content-Disposition": f'attachment; filename="{stem}_edited.{doc.kind}"',
            "X-Paradox-Report": json.dumps(report, ensure_ascii=True),
            "Access-Control-Expose-Headers": "X-Paradox-Report",
        })

    def _editable(ws: Workspace, doc_id: str):
        doc = ws.documents.get(doc_id)
        original = ws.originals.get(doc_id)
        if doc is None or original is None:
            raise HTTPException(404, "Only PDF and Word files can be edited or redacted.")
        return doc, original

    def _file_json(doc, data: bytes, suffix: str, extra: dict) -> dict:
        stem = re.sub(r"[^\w\-. ]", "_", doc.name.rsplit(".", 1)[0]).strip(" ._") or "document"
        return {"filename": f"{stem}_{suffix}.{doc.kind}", "file": base64.b64encode(data).decode(), **extra}

    @app.post("/api/workspaces/{ws_id}/documents/{doc_id}/preview")
    async def preview_changes(doc_id: str, body: ApplyIn, ws: Workspace = Depends(workspace)):
        """Apply the changes in memory and return the edited file plus page previews."""
        doc, original = _editable(ws, doc_id)
        changes = [c.model_dump() for c in body.changes]
        try:
            data, report = await asyncio.to_thread(layout_edit.apply, doc.kind, original, changes)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        marks = [r["mark"] for r in report if r.get("ok") and r.get("mark")]
        pv = await asyncio.to_thread(privacy.preview, doc.kind, original, data, marks)
        highlight = [c["replace"] for c, r in zip(changes, report) if r["ok"]]
        return _file_json(doc, data, "edited", {"report": report, "preview": pv, "highlight": highlight})

    @app.post("/api/workspaces/{ws_id}/documents/{doc_id}/pii")
    async def find_personal_data(doc_id: str, request: Request, ws: Workspace = Depends(workspace)):
        """Personal data found by patterns, plus names and addresses found by the model (checked against the text)."""
        doc, original = _editable(ws, doc_id)
        text = await asyncio.to_thread(privacy.pdf_text, original) if doc.kind == "pdf" else ws.texts[doc_id]
        items = privacy.detect_pii(text)
        model_used = False
        try:
            reply = await request.app.state.chat.complete(privacy.PII_SYSTEM, [{"role": "user",
                                                          "content": privacy.pii_user_prompt(text[:s.full_doc_chars])}])
            known = {i["value"] for i in items}
            items += [i for i in privacy.parse_pii_answer(reply, text) if i["value"] not in known]
            model_used = True
        except ProviderError:
            pass
        return {"items": items, "model_used": model_used}

    @app.post("/api/workspaces/{ws_id}/documents/{doc_id}/redact")
    async def redact(doc_id: str, body: RedactIn, ws: Workspace = Depends(workspace)):
        """Remove the given terms for real (PDF redaction / Word replacement) and wipe metadata. Nothing is kept."""
        doc, original = _editable(ws, doc_id)
        terms = [t.strip() for t in body.terms if t.strip()]
        if doc.kind == "pdf":
            data, counts, marks = await asyncio.to_thread(privacy.redact_pdf, original, terms)
        else:
            (data, counts), marks = await asyncio.to_thread(privacy.redact_docx, original, terms), []
        pv = await asyncio.to_thread(privacy.preview, doc.kind, original, data, marks)
        return _file_json(doc, data, "redacted", {"counts": counts, "preview": pv, "highlight": ["\u2588\u2588\u2588"]})

    @app.delete("/api/workspaces/{ws_id}/documents/{doc_id}")
    async def remove_document(doc_id: str, ws: Workspace = Depends(workspace)):
        if not ws.remove(doc_id):
            raise HTTPException(404, "Document not found.")
        return {"ok": True}

    # ------------------------------------------------------------ chat

    @app.post("/api/workspaces/{ws_id}/chat")
    async def chat(body: ChatIn, request: Request, ws: Workspace = Depends(workspace)):
        question = body.message.strip()
        hits: list = []
        full_docs: list[tuple[str, str]] = []
        if ws.chunks and ws.total_chars() <= s.full_doc_chars:
            # Small enough: give the model the whole text, so it can summarise or edit it.
            full_docs = ws.full_documents()
            sources = document_citations(full_docs)
        elif ws.chunks:
            # Include the previous user turn so follow-ups ("and the second one?") still retrieve well.
            prev = next((m["content"] for m in reversed(ws.history) if m["role"] == "user"), "")
            query = f"{prev[:500]}\n{question}" if prev and len(question) < 60 else question
            try:
                qv = (await request.app.state.embedder.embed([query]))[0]
            except ProviderError as exc:
                raise HTTPException(502, str(exc)) from exc
            hits = ws.search(qv, s.top_k)
            sources = citations(hits)
        else:
            sources = []

        layout = body.keep_layout and bool(ws.originals)
        system = build_system_prompt(ws.system_prompt, f"{s.llm_model} (via {s.llm_provider})", layout)
        history = ws.history[-2 * s.history_turns:]
        # History keeps plain questions; only the current turn carries the document text.
        user_msg = build_user_message(question, hits, bool(ws.chunks), full_docs)
        messages = [*history, {"role": "user", "content": user_msg}]
        model: ChatModel = request.app.state.chat

        async def check_changes(answer: str):
            """Verify every FIND exists in an editable document; ask the model once to fix the rest."""
            changes = layout_edit.parse_changes(answer)
            if not changes:
                return None
            docs = [d for d in ws.documents.values() if d.id in ws.originals]
            if not docs:
                return {"doc_id": None, "changes": [{**c, "status": "fail", "message": "No editable file."} for c in changes]}
            target = max(docs, key=lambda d: sum(bool(privacy.locate(ws.texts[d.id], c["find"])) for c in changes))
            text = ws.texts[target.id]
            out = []
            missing = []
            for c in changes:
                where = privacy.locate(text, c["find"])
                if where:
                    out.append({**c, "status": "ok", "message": "Found in your document." if where == "exact"
                                else "Found in your document (wording differs slightly)."})
                else:
                    near = privacy.closest_passage(text, c["find"])
                    out.append({**c, "status": "fail", "message": "This text isn't in your document."})
                    if near:
                        missing.append((len(out) - 1, near))
            if missing:
                try:
                    reply = await model.complete(privacy.REPAIR_SYSTEM, [{"role": "user", "content": privacy.repair_prompt(
                        [(changes[i], near) for i, near in missing])}])
                    fixed = layout_edit.parse_changes(reply)
                except ProviderError:
                    fixed = []
                for k, (i, _) in enumerate(missing):
                    f = fixed[k] if k < len(fixed) else None
                    if f and privacy.locate(text, f["find"]):
                        out[i] = {**f, "status": "fixed", "message": "Corrected to match your document."}
            return {"doc_id": target.id, "changes": out}

        async def events():
            yield json.dumps({"type": "sources", "sources": sources}) + "\n"
            answer: list[str] = []
            finished = failed = False
            try:
                async for piece in model.stream(system, messages):
                    if await request.is_disconnected():
                        break  # user pressed Stop: leaving the loop closes the model request
                    answer.append(piece)
                    yield json.dumps({"type": "token", "text": piece}) + "\n"
                else:
                    finished = True
            except ProviderError as exc:
                failed = True
                yield json.dumps({"type": "error", "message": str(exc)}) + "\n"
            finally:
                # Keep what was written so far (also when stopped), so follow-ups still make sense.
                if not failed and answer:
                    text = "".join(answer) + ("" if finished else "\n\n[stopped]")
                    ws.history.append({"role": "user", "content": question})
                    ws.history.append({"role": "assistant", "content": text})
            if finished and layout:
                checked = await check_changes("".join(answer))
                if checked is not None:
                    yield json.dumps({"type": "changes", **checked}) + "\n"
            if finished:
                yield json.dumps({"type": "done"}) + "\n"

        return StreamingResponse(events(), media_type="application/x-ndjson",
                                 headers={"X-Accel-Buffering": "no"})

    # ------------------------------------------------------------ export

    @app.post("/api/export")
    async def export(body: ExportIn, sess: Session = Depends(current_session)):
        """Build a file from an answer in memory and send it back. Nothing is kept."""
        text = clean_text(body.text)
        stem = re.sub(r"[^\w\-. ]", "_", body.filename).strip(" ._") or "paradox"
        if body.format == "pdf":
            data = await asyncio.to_thread(to_pdf, text, stem)
            media = "application/pdf"
        elif body.format == "docx":
            data = await asyncio.to_thread(to_docx, text)
            media = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        else:
            data = text.encode("utf-8")
            media = "text/plain; charset=utf-8"
        return Response(data, media_type=media, headers={
            "Content-Disposition": f'attachment; filename="{stem}.{body.format}"'})

    return app
# Run with: uvicorn --factory app.main:create_app
