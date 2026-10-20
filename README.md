# Paradox

**Chat with your documents. Store nothing.**

[![tests](https://github.com/najjar961/paradox/actions/workflows/tests.yml/badge.svg)](https://github.com/najjar961/paradox/actions/workflows/tests.yml)
![license](https://img.shields.io/badge/license-AGPL--3.0-blue)
![self-hosted](https://img.shields.io/badge/self--hosted-docker-2f6f5e)

Paradox is a self-hosted, multi-user AI assistant for confidential documents. Upload PDFs, Word files or notes, ask questions, and get answers that cite the exact passage they came from. Documents, embeddings and chat history live only in server RAM for the length of a login session and are dropped on sign-out, after an idle timeout, at a maximum session age, or when the server stops. Run it with a local model through Ollama and your files never leave your own machine.

![Paradox answering a question with a citation](docs/screenshots/chat-light.png)

<details>
<summary>Dark mode and login</summary>

![Dark mode](docs/screenshots/chat-dark.png)
![Login](docs/screenshots/login.png)

</details>

## Features

- Multi-user login (accounts from a read-only `users.yaml` of bcrypt hashes)
- Several workspaces per user, each with its own documents, chat and custom instructions
- Upload PDF, DOCX, TXT, Markdown, CSV, JSON, HTML and log files
- Ask anything about a document, or ask Paradox to edit it ("rewrite this more formally", "fix the typos") and copy or download the result
- Short documents are read in full; large ones are searched by passage. Answers stream live with clickable `[1]` citations
- Model choice: **Ollama** (fully local), **OpenAI** or any OpenAI-compatible server, or **Anthropic**
- Light and dark mode, works on mobile

## How "no data storing" is enforced

| Layer | What happens |
|---|---|
| Storage | No database. Everything lives in Python objects tied to a session token. |
| Uploads | Files are sent as a raw request body and parsed from memory (`BytesIO`). The multipart parser is not used, because it spools large files to temp files on disk. |
| Session end | Sign-out, `SESSION_IDLE_MINUTES` idle, `SESSION_MAX_HOURS` age, or shutdown destroys the session and empties its workspaces. A background reaper runs every minute. |
| Logs | Uvicorn access log is off. The app never logs document or chat content. |
| Browser | `Cache-Control: no-store` on every response; nothing is put in `localStorage`. |
| Container | `read_only: true` root filesystem; the only writable path is a RAM-backed `tmpfs`. |
| Tests | `test_nothing_written_to_disk` spies on `open()` during upload and chat and fails if anything is written. |

**Honest limits:** Python cannot securely zero freed memory, so wiped data stays in RAM until it is overwritten; if the host swaps, RAM can reach disk (disable swap or use encrypted swap). If you choose OpenAI or Anthropic, your document chunks and questions are sent to that provider and are subject to their retention policy. Use Ollama for a fully local setup.

## Security measures

- bcrypt password hashes; constant-time check for unknown usernames
- Login rate limit per client and username (`LOGIN_MAX_ATTEMPTS` per `LOGIN_WINDOW_SECONDS`)
- Session cookie is `HttpOnly`, `Secure`, `SameSite=Strict`; random 256-bit tokens; new token on every login
- CSRF token required in the `X-CSRF-Token` header on all state-changing requests
- Strict Content Security Policy (no inline scripts), `X-Frame-Options: DENY`, HSTS, `nosniff`, no referrer
- Per-session isolation: every workspace lookup is scoped to the caller's session
- Upload size cap, file type allow-list, chunk and workspace quotas per session
- Prompt-injection hardening: document text is wrapped in `<source>` tags, any attempt inside a document to close or forge those tags is neutralised, and the model is told to treat sources as data
- Model output is HTML-escaped before the minimal Markdown rendering, so documents cannot inject script into the page
- API docs (`/docs`, `/openapi.json`) are disabled

## Quick start (Docker, local models)

```bash
cp .env.example .env
cp users.example.yaml users.yaml
python scripts/hash_password.py alice     # paste the printed line into users.yaml
docker compose up -d --build
docker compose exec ollama ollama pull llama3.2
docker compose exec ollama ollama pull nomic-embed-text
```

Open http://localhost:8000. For plain-http local testing set `COOKIE_SECURE=false` in `.env`, otherwise the browser will not keep the session cookie. For anything beyond localhost, put a TLS reverse proxy (Caddy, Traefik, nginx) in front and keep `COOKIE_SECURE=true`.

The example users file contains a `demo` account with password `change-me-please`. Delete it before exposing the app.

## Run without Docker

```bash
pip install -r requirements.txt
cp users.example.yaml users.yaml
COOKIE_SECURE=false uvicorn --factory app.main:create_app --port 8000 --no-access-log
```

To try the UI with no model at all: `LLM_PROVIDER=echo EMBED_PROVIDER=hash`.

## Using hosted models

```env
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-5-5
ANTHROPIC_API_KEY=...
EMBED_PROVIDER=openai          # Anthropic has no embeddings API; or keep ollama
EMBED_MODEL=text-embedding-3-small
OPENAI_API_KEY=...
```

## Tests

```bash
pip install pytest
python -m pytest -q
```

They cover login and rate limiting, cookie flags, CSRF, the full upload/retrieve/chat flow, DOCX and PDF parsing, upload limits, isolation between users, wipe on logout and idle expiry, the no-disk-writes check, prompt delimiter forging, and chunking.

## Layout

```
app/
  main.py        routes, auth dependencies, security headers, streaming chat
  store.py       in-memory sessions, workspaces, vector search (numpy cosine)
  ingest.py      text extraction from bytes and chunking
  providers.py   Ollama / OpenAI / Anthropic chat and embeddings
  rag.py         prompt assembly and citations
  auth.py        users file and login rate limiter
  static/        single-page UI (vanilla JS, no build step)
scripts/hash_password.py
tests/test_app.py
```

## Scaling note

Sessions live in one process's memory, so run a single worker (the default). Several replicas would need sticky sessions at the load balancer. Vector search is brute-force numpy, which is fast up to tens of thousands of chunks per user; the per-session chunk quota keeps it in that range.

## Contributing

Issues and pull requests are welcome. Run `python -m pytest -q` before opening a PR; CI runs the same tests and a Docker build. For security problems, see [SECURITY.md](SECURITY.md) and report them privately.

## Licence

Paradox is licensed under the [GNU AGPL-3.0](LICENSE). You can use, modify and self-host it freely. If you offer a modified version to others over a network, you must make your source code available to those users under the same licence.

For a commercial licence without these terms, or a managed installation, get in touch.

## Website

The landing page is [`docs/index.html`](docs/index.html). To put it online for free, open the repository's **Settings → Pages**, choose **Deploy from a branch**, then branch `main` and folder `/docs`. It will be live at `https://najjar961.github.io/paradox/`.
