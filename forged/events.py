"""Event bus and normalization.

The SDK emits a firehose shaped around the API wire format. The UI wants a small, stable
vocabulary it can render directly. Normalizing here means the UI never parses SDK types, so
an SDK change lands in one file.

Every event gets a monotonic id and is kept in a ring buffer, so a client that drops its
connection can reconnect with Last-Event-ID and replay what it missed rather than losing the
middle of a response.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger("forged.events")

REPLAY_BUFFER = 2000

# A page load replays history so the conversation survives a restart, but replaying
# everything does not scale: the log reached 747 events / 2.7MB in a day, and a phone has to
# parse and render all of it before the UI is usable. Cap what a cold client receives.
COLD_REPLAY_LIMIT = 250

# Persisted so a daemon restart -- an OOM kill, a crash -- leaves the conversation on screen
# instead of an empty feed. Token-level deltas are skipped: a full "text" event follows every
# stream, so replaying deltas would triple the file for no visible gain.
# "Transient" means two different things here, both of which must not be replayed:
#   - high-volume deltas, where a full event follows anyway
#   - momentary control signals. Persisting ui_reload caused an infinite reload loop: every
#     page load replayed it, which reloaded the page, which replayed it again.
TRANSIENT_KINDS = {"text_delta", "thinking", "message_stop", "build_log",
                   "ui_reload", "ui_error"}


@dataclass
class Event:
    id: int
    kind: str
    data: dict[str, Any] = field(default_factory=dict)

    def sse(self, replay: bool = False) -> bytes:
        body = {"kind": self.kind, **self.data}
        if replay:
            body["replay"] = True
        payload = json.dumps(body, separators=(",", ":"))
        return f"id: {self.id}\ndata: {payload}\n\n".encode()


# Pushed to every subscriber when a bus is retired, so open streams end instead of going
# quiet. A silently dead stream is worse than a dropped one: the client has no error to
# react to, so it never reconnects and simply shows nothing forever.
CLOSED = object()


class EventBus:
    def __init__(self, persist_path: Path | None = None) -> None:
        self._next_id = 1
        self._buffer: list[Event] = []
        self._subscribers: set[asyncio.Queue[Event]] = set()
        self._path = persist_path
        if persist_path:
            self._restore()

    def _restore(self) -> None:
        try:
            lines = self._path.read_text().splitlines()[-REPLAY_BUFFER:]
        except OSError:
            return
        for line in lines:
            try:
                raw = json.loads(line)
            except ValueError:
                continue
            ev = Event(raw["id"], raw["kind"], raw.get("data", {}))
            self._buffer.append(ev)
            self._next_id = max(self._next_id, ev.id + 1)
        if self._buffer:
            log.info("restored %d events from disk", len(self._buffer))

    def page_after(self, after_id: int, limit: int) -> list[dict[str, Any]]:
        """Transcript events NEWER than after_id, oldest-first.

        The mirror of page(). Scrollback used to be one-directional because the client kept
        every node it had ever rendered, so coming back down was always free. Once the
        client is allowed to discard its newer nodes to bound memory, it needs a way to ask
        for them again -- and asking downwards is this.
        """
        out: list[dict[str, Any]] = []
        if self._path is not None:
            try:
                with self._path.open() as fh:
                    for line in fh:
                        try:
                            raw = json.loads(line)
                        except ValueError:
                            continue
                        if raw.get("id", 0) <= after_id:
                            continue
                        item = {"kind": raw["kind"], **(raw.get("data") or {})}
                        item["event_id"] = raw["id"]      # assigned last; see page()
                        out.append(item)
                        if len(out) >= limit:
                            break
            except OSError:
                out = []
        if not out:
            for ev in self._buffer:
                if ev.id <= after_id:
                    continue
                item = {"kind": ev.kind, **ev.data}
                item["event_id"] = ev.id
                out.append(item)
        return out[:limit]

    def page(self, before_id: int, limit: int) -> list[dict[str, Any]]:
        """Transcript events older than before_id, oldest-first.

        Reads the persisted log rather than the in-memory ring: scrollback should not stop at
        whatever happens to still be buffered. The file is append-only and small enough that
        a full scan per request is cheaper than maintaining an index.
        """
        out: list[dict[str, Any]] = []
        if self._path is not None:
            try:
                with self._path.open() as fh:
                    for line in fh:
                        try:
                            raw = json.loads(line)
                        except ValueError:
                            continue
                        if before_id and raw.get("id", 0) >= before_id:
                            continue
                        item = {"kind": raw["kind"], **(raw.get("data") or {})}
                        # event_id assigned last and under its own name: a tool_use event
                        # carries its own "id" in data, which silently clobbered the envelope
                        # id and sent a toolu_... string back as the paging cursor.
                        item["event_id"] = raw["id"]
                        out.append(item)
            except OSError:
                out = []
        if not out:
            for ev in self._buffer:
                if before_id and ev.id >= before_id:
                    continue
                item = {"kind": ev.kind, **ev.data}
                item["event_id"] = ev.id
                out.append(item)
        return out[-limit:]

    def _append(self, ev: Event) -> None:
        if not self._path or ev.kind in TRANSIENT_KINDS:
            return
        try:
            with self._path.open("a") as fh:
                fh.write(json.dumps({"id": ev.id, "kind": ev.kind, "data": ev.data},
                                    default=str) + "\n")
        except OSError:
            pass  # Never let a full disk take the daemon down.

    def publish(self, kind: str, **data: Any) -> Event:
        ev = Event(self._next_id, kind, data)
        self._next_id += 1
        self._buffer.append(ev)
        if len(self._buffer) > REPLAY_BUFFER:
            del self._buffer[: len(self._buffer) - REPLAY_BUFFER]
        self._append(ev)
        for q in self._subscribers:
            q.put_nowait(ev)
        return ev

    def subscribe(self, after_id: int = 0) -> tuple[asyncio.Queue[Event], list[Event]]:
        """after_id 0 replays the whole buffer, which is how a reloaded page gets its
        history back -- including after a hot edit reloads the UI mid-conversation."""
        q: asyncio.Queue[Event] = asyncio.Queue()
        self._subscribers.add(q)
        missed = [e for e in self._buffer if e.id > after_id]
        if not after_id:
            missed = missed[-COLD_REPLAY_LIMIT:]
        return q, missed

    def unsubscribe(self, q: asyncio.Queue[Event]) -> None:
        self._subscribers.discard(q)

    def close(self) -> None:
        """Retire this bus: end every open stream so clients reconnect to the live one."""
        for q in list(self._subscribers):
            q.put_nowait(CLOSED)
        self._subscribers.clear()

    @property
    def last_id(self) -> int:
        return self._next_id - 1


def _block_kind(block: Any) -> str:
    return type(block).__name__


def normalize(msg: Any) -> list[tuple[str, dict[str, Any]]]:
    """SDK message -> zero or more (kind, data) pairs for the UI."""
    out: list[tuple[str, dict[str, Any]]] = []
    cls = type(msg).__name__

    if cls == "SystemMessage":
        sub = getattr(msg, "subtype", None)
        if sub == "init":
            d = getattr(msg, "data", {}) or {}
            out.append(("session", {
                "session_id": d.get("session_id"),
                "model": d.get("model"),
                "cwd": d.get("cwd"),
                "tools": d.get("tools", []),
            }))
        elif sub == "thinking_tokens":
            d = getattr(msg, "data", {}) or {}
            out.append(("thinking", {"tokens": d.get("estimated_tokens")}))

    elif cls == "StreamEvent":
        ev = getattr(msg, "event", {}) or {}
        et = ev.get("type")
        if et == "content_block_delta":
            delta = ev.get("delta", {}) or {}
            if delta.get("type") == "text_delta":
                out.append(("text_delta", {"text": delta.get("text", "")}))
        elif et == "content_block_start":
            cb = ev.get("content_block", {}) or {}
            if cb.get("type") == "tool_use":
                out.append(("tool_start", {"id": cb.get("id"), "name": cb.get("name")}))
        elif et == "message_stop":
            out.append(("message_stop", {}))

    elif cls == "AssistantMessage":
        for block in getattr(msg, "content", []) or []:
            bk = _block_kind(block)
            if bk == "TextBlock":
                out.append(("text", {"text": getattr(block, "text", "")}))
            elif bk == "ToolUseBlock":
                out.append(("tool_use", {
                    "id": getattr(block, "id", None),
                    "name": getattr(block, "name", None),
                    "input": getattr(block, "input", {}),
                }))

    elif cls == "UserMessage":
        # Our own input echoed back under --replay-user-messages; not a new message.
        content = getattr(msg, "content", None)
        if isinstance(content, list):
            for block in content:
                if _block_kind(block) == "ToolResultBlock":
                    raw = getattr(block, "content", None)
                    out.append(("tool_result", {
                        "tool_use_id": getattr(block, "tool_use_id", None),
                        "is_error": bool(getattr(block, "is_error", False)),
                        "content": _stringify(raw),
                    }))

    elif cls == "ResultMessage":
        out.append(("result", {
            "session_id": getattr(msg, "session_id", None),
            "cost_usd": getattr(msg, "total_cost_usd", None),
            "duration_ms": getattr(msg, "duration_api_ms", None),
            "is_error": bool(getattr(msg, "is_error", False)),
        }))

    elif cls == "RateLimitEvent":
        info = getattr(msg, "rate_limit_info", None)
        windows = _rate_windows(info)
        if windows:
            out.append(("rate_limit", {"windows": windows}))

    return out


def _rate_windows(info: Any) -> dict[str, Any]:
    """RateLimitInfo -> {window_name: {utilization, resets_at, status}}.

    This used to look for `unifiedWindows` inside `info.__dict__`. The SDK's RateLimitInfo is
    a flat dataclass -- status / resets_at / rate_limit_type / utilization / raw -- so that key
    was never present, the result was always empty, and the `if windows:` guard upstream meant
    a rate_limit event was never published even once. Hence a gauge permanently showing a dash.

    The CLI reports one window per event, so callers must merge successive events rather than
    expect a whole picture from any single one.
    """
    if info is None:
        return {}

    raw = info if isinstance(info, dict) else (getattr(info, "raw", None) or {})

    # Keep honouring a batched shape if a future CLI sends every window at once.
    unified = raw.get("unifiedWindows") or raw.get("unified_windows") or {}
    if isinstance(unified, dict) and unified:
        return {
            name: {
                "utilization": w.get("utilization"),
                "resets_at": w.get("resetsAt") or w.get("resets_at"),
                "status": w.get("status"),
            }
            for name, w in unified.items() if isinstance(w, dict)
        }

    def field(attr: str, wire: str) -> Any:
        if isinstance(info, dict):
            return info.get(wire, info.get(attr))
        value = getattr(info, attr, None)
        return value if value is not None else raw.get(wire)

    name = field("rate_limit_type", "rateLimitType")
    utilization = field("utilization", "utilization")
    if not name or utilization is None:
        return {}
    return {name: {
        "utilization": utilization,
        "resets_at": field("resets_at", "resetsAt"),
        "status": field("status", "status"),
    }}


def _stringify(raw: Any) -> str:
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    if isinstance(raw, list):
        parts = []
        for item in raw:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
            else:
                parts.append(json.dumps(item, default=str))
        return "\n".join(parts)
    return json.dumps(raw, default=str)
