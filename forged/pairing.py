"""Short-lived numeric pairing.

Typing a 32-character token on a phone keyboard is miserable, and the VM and Android side
don't share a clipboard. So the daemon prints a six-digit code that can be exchanged for the
real token: short-lived, attempt-limited, and only useful to something already on this LAN.
"""
from __future__ import annotations

import secrets
import time

TTL_SECONDS = 600
MAX_ATTEMPTS = 5


class Pairing:
    def __init__(self) -> None:
        self.code = f"{secrets.randbelow(1_000_000):06d}"
        self.expires_at = time.time() + TTL_SECONDS
        self.attempts = 0

    @property
    def active(self) -> bool:
        return time.time() < self.expires_at and self.attempts < MAX_ATTEMPTS

    def check(self, candidate: str) -> bool:
        if not self.active:
            return False
        self.attempts += 1
        return secrets.compare_digest(candidate.strip(), self.code)

    def renew(self) -> str:
        self.__init__()
        return self.code
