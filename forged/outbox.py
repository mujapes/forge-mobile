"""Durable prompt queue.

Typed input is the one thing the user cannot regenerate, so it goes to disk the instant it
arrives rather than living only in memory. The file sits under /mnt/shared, which Android can
read even while the VM is down, so unsent work is never trapped inside a dead VM.

Interrupted turns are deliberately *not* auto-resubmitted. Because the session resumes with
--resume, Claude may well have processed a turn that we never saw complete; resending would
duplicate it. Instead the turn is surfaced to the UI as interrupted and the user decides.
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from . import config

QUEUED = "queued"
IN_FLIGHT = "in_flight"
DONE = "done"
INTERRUPTED = "interrupted"


class Outbox:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or (config.SHARED_DIR / "outbox.json")
        self.entries: list[dict] = self._load()

    def _load(self) -> list[dict]:
        try:
            return json.loads(self.path.read_text())
        except (OSError, ValueError):
            return []

    def _save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(self.entries, indent=1))
            tmp.replace(self.path)
        except OSError:
            pass  # A full or unmounted /mnt/shared must not take the daemon down.

    def add(self, text: str) -> dict:
        entry = {"id": uuid.uuid4().hex[:12], "text": text,
                 "status": QUEUED, "at": time.time()}
        self.entries.append(entry)
        self._prune()
        self._save()
        return entry

    def mark(self, entry_id: str, status: str) -> None:
        for e in self.entries:
            if e["id"] == entry_id:
                e["status"] = status
                break
        self._prune()
        self._save()

    def recover(self) -> tuple[list[dict], list[dict]]:
        """After a restart: (never-sent, interrupted-by-*this*-restart).

        Only turns that were actually in flight when the daemon went down are returned. This
        used to return every entry still sitting at INTERRUPTED, which meant each restart
        re-surfaced the whole accumulated history -- one restart produced a screenful of cards
        for turns that had been answered ages ago.
        """
        pending = [e for e in self.entries if e["status"] == QUEUED]
        interrupted = [e for e in self.entries if e["status"] == IN_FLIGHT]
        for e in interrupted:
            e["status"] = INTERRUPTED
        self._save()
        return pending, interrupted

    def interrupted(self) -> list[dict]:
        """Unresolved interrupted turns, for /state. Read-only: unlike recover() this does
        not promote anything, so it is safe to call on every page load."""
        return [e for e in self.entries if e["status"] == INTERRUPTED]

    def resolve(self, entry_id: str) -> bool:
        """The user has dealt with an interrupted turn (resent or dismissed).

        Dismiss used to be client-side only, so the entry stayed INTERRUPTED on disk and came
        back on the next restart no matter how many times it was waved away.
        """
        for e in self.entries:
            if e["id"] == entry_id and e["status"] == INTERRUPTED:
                e["status"] = DONE
                self._prune()
                self._save()
                return True
        return False

    def _prune(self, keep: int = 50) -> None:
        finished = [e for e in self.entries if e["status"] == DONE]
        if len(finished) > keep:
            drop = {id(e) for e in finished[: len(finished) - keep]}
            self.entries = [e for e in self.entries if id(e) not in drop]
