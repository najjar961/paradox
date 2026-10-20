"""Runtime settings, read once from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _bool(name: str, default: bool) -> bool:
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    # Users
    users_file: str = field(default_factory=lambda: os.environ.get("USERS_FILE", "users.yaml"))

    # Chat model: ollama | openai | anthropic | echo (echo = offline test stub)
    llm_provider: str = field(default_factory=lambda: os.environ.get("LLM_PROVIDER", "ollama").lower())
    llm_model: str = field(default_factory=lambda: os.environ.get("LLM_MODEL", "llama3.2"))

    # Embeddings: ollama | openai | hash (hash = offline keyword-hash fallback)
    embed_provider: str = field(default_factory=lambda: os.environ.get("EMBED_PROVIDER", "ollama").lower())
    embed_model: str = field(default_factory=lambda: os.environ.get("EMBED_MODEL", "nomic-embed-text"))

    ollama_url: str = field(default_factory=lambda: os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/"))
    openai_url: str = field(default_factory=lambda: os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/"))
    openai_key: str = field(default_factory=lambda: os.environ.get("OPENAI_API_KEY", ""))
    anthropic_url: str = field(default_factory=lambda: os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/"))
    anthropic_key: str = field(default_factory=lambda: os.environ.get("ANTHROPIC_API_KEY", ""))

    # Sessions & limits
    session_idle_minutes: int = field(default_factory=lambda: _int("SESSION_IDLE_MINUTES", 30))
    session_max_hours: int = field(default_factory=lambda: _int("SESSION_MAX_HOURS", 8))
    max_upload_mb: int = field(default_factory=lambda: _int("MAX_UPLOAD_MB", 15))
    max_chunks_per_user: int = field(default_factory=lambda: _int("MAX_CHUNKS_PER_USER", 5000))
    max_workspaces_per_user: int = field(default_factory=lambda: _int("MAX_WORKSPACES_PER_USER", 10))
    chunk_size: int = field(default_factory=lambda: _int("CHUNK_SIZE", 1000))
    chunk_overlap: int = field(default_factory=lambda: _int("CHUNK_OVERLAP", 150))
    # Documents up to this many characters in total are sent to the model whole,
    # so it can summarise and edit them; bigger collections use passage search.
    full_doc_chars: int = field(default_factory=lambda: _int("FULL_DOC_CHARS", 24000))
    ollama_num_ctx: int = field(default_factory=lambda: _int("OLLAMA_NUM_CTX", 12288))
    top_k: int = field(default_factory=lambda: _int("TOP_K", 5))
    history_turns: int = field(default_factory=lambda: _int("HISTORY_TURNS", 6))

    # Cookies: set COOKIE_SECURE=false only for plain-http local testing
    cookie_secure: bool = field(default_factory=lambda: _bool("COOKIE_SECURE", True))
    login_max_attempts: int = field(default_factory=lambda: _int("LOGIN_MAX_ATTEMPTS", 5))
    login_window_seconds: int = field(default_factory=lambda: _int("LOGIN_WINDOW_SECONDS", 300))


def load_settings() -> Settings:
    return Settings()
