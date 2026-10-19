"""User accounts come from a read-only YAML file of bcrypt hashes.

The app never writes this file, so there is no signup flow and no user data
stored by the app itself. Admins add users with scripts/hash_password.py.
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

import bcrypt
import yaml

# Used when the username does not exist so timing does not reveal valid names.
_DUMMY_HASH = bcrypt.hashpw(b"not-a-real-password", bcrypt.gensalt(rounds=12))


class UserDirectory:
    def __init__(self, path: str):
        self.path = path
        self._users: dict[str, bytes] = {}
        self.reload()

    def reload(self) -> None:
        with open(self.path, "r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
        users = data.get("users") or {}
        if not isinstance(users, dict):
            raise ValueError("users file must contain a 'users' mapping of name -> bcrypt hash")
        self._users = {str(k): str(v).encode() for k, v in users.items()}

    def verify(self, username: str, password: str) -> bool:
        stored = self._users.get(username)
        candidate = password.encode()[:72]  # bcrypt limit
        if stored is None:
            bcrypt.checkpw(candidate, _DUMMY_HASH)
            return False
        try:
            return bcrypt.checkpw(candidate, stored)
        except ValueError:
            return False

    def __len__(self) -> int:
        return len(self._users)


class LoginLimiter:
    """Sliding-window limit on failed logins per (client, username)."""

    def __init__(self, max_attempts: int, window_seconds: int):
        self.max_attempts = max_attempts
        self.window = window_seconds
        self._fails: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def _trim(self, q: deque, now: float) -> None:
        while q and now - q[0] > self.window:
            q.popleft()

    def blocked(self, key: str) -> bool:
        now = time.time()
        with self._lock:
            q = self._fails[key]
            self._trim(q, now)
            return len(q) >= self.max_attempts

    def fail(self, key: str) -> None:
        with self._lock:
            self._fails[key].append(time.time())

    def reset(self, key: str) -> None:
        with self._lock:
            self._fails.pop(key, None)
