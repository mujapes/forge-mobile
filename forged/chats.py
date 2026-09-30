"""Multiple independent conversations, each with its own context and its own model.

A fresh chat gets a one-shot classification, on an empty context, to decide which model
it deserves. The timing is the whole point: a mid-conversation model switch invalidates
the prompt cache and reprocesses the entire transcript at full price (see router.py), but
a brand new chat has no transcript yet, so choosing its model costs nothing.

Whether Anthropic's own apps do something similar is unsettled -- their docs describe a
manual picker, the user reports having seen a model chosen for them, and both can be true
(usage-limit fallback and adaptive effort both look like automatic model choice from the
outside). It does not matter either way: the reason to do this here is the cache
arithmetic above, which holds regardless of what anyone else ships.

Only one chat is ever live. Each conversation is a real `claude` CLI subprocess once
started (see ClaudeSession._run_once), and this VM has under 1GB of RAM -- it has already
OOM-killed a claude process once. Running several concurrently would risk that again for
no benefit a phone user actually has: one person reads and writes one chat at a time.
Switching chats stops the old subprocess and starts (or resumes) the target's.

A brand new chat is not started immediately. Its CLI subprocess would spawn with whatever
model happens to be the fallback, before classification has run -- and the model is an
option to ClaudeAgentOptions read once at subprocess start, so classifying afterwards
would be too late. So a fresh chat sits idle until its first prompt, which is when
`ensure_started` classifies, sets the model, and only then starts it.

Migration is deliberately a no-op. The conversation already running when this shipped
becomes chat "default", and its meta simply points at the exact paths it already used
(~/.forge/events.jsonl, ~/.forge/session_id, the shared outbox) -- nothing is moved or
copied. The safest migration is the one that touches no bytes of a working conversation.
"""
from __future__ import annotations

import json
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

from . import config
from .events import EventBus, normalize
from .outbox import Outbox
from .router import label_to_rung
from .session import ClaudeSession

log = logging.getLogger("forged.chats")

INDEX_PATH = config.STATE_DIR / "chats.json"
CHATS_DIR = config.STATE_DIR / "chats"
LEGACY_ID = "default"

CLASSIFY_SYSTEM = """You triage tasks for a coding assistant. Reply with exactly one line,
in the form:

difficulty | title

difficulty is one of: trivial, light, standard, heavy, extreme.

trivial: a greeting, an acknowledgement, a one-line factual lookup.
light: a small edit, a quick check, a short clarifying question.
standard: a typical bug fix or small feature in an existing codebase.
heavy: building something substantial, a real refactor, non-trivial debugging.
extreme: an entire application from scratch, an architecture decision, or an
open-ended investigation with many unknowns.

Judge the task itself, not how it is phrased. A short message can still be extreme.

title is at most six words naming the subject, as a chat list entry. No quotes, no
trailing full stop. Write it as a label, not a sentence: "Keyboard latency on Android",
not "The user wants help with keyboard latency"."""

# A prompt too short or generic to justify spending even a haiku round trip; the pure
# heuristic already in router.py is confident enough on its own at this end of the scale.
_TRIVIAL_WORDS = 4


async def classify_new_chat(prompt: str, cwd: str) -> tuple[str, str, str, str]:
    """(model, effort, label, title) for a chat's very first message.

    Runs on an empty context, which is what makes this the one place a real model call to
    decide routing is worth its cost: nothing has to be reprocessed if it turns out wrong,
    unlike a mid-conversation switch.
    """
    stripped = prompt.strip()
    fallback_title = (stripped.splitlines()[0][:60] if stripped else "New chat")
    if len(stripped.split()) <= _TRIVIAL_WORDS:
        return "haiku", "low", "trivial (pre-screened, no call spent)", fallback_title

    label = "standard"  # the conservative fallback if the call fails or answers oddly
    title = fallback_title
    try:
        # No `effort` here: it is documented to error on Haiku 4.5 specifically, and this
        # one-word classification has no use for it anyway.
        options = ClaudeAgentOptions(
            cwd=cwd, model="haiku",
            system_prompt=CLASSIFY_SYSTEM,
            max_turns=1, tools=[], setting_sources=[],
        )
        text = ""
        async with ClaudeSDKClient(options=options) as client:
            await client.query(stripped[:4000])   # the ask is the signal; cap it small
            async for msg in client.receive_response():
                for kind, data in normalize(msg):
                    if kind == "text":
                        text += data.get("text", "")
        found = re.search(r"trivial|light|standard|heavy|extreme", text.lower())
        if found:
            label = found.group(0)
        else:
            log.warning("classification returned no label (%r); defaulting to standard", text[:80])
        # Same call, second answer: a titled chat list is worth far more than the raw first
        # sixty characters of whatever was typed, and costs nothing extra to ask for here.
        if "|" in text:
            candidate = text.split("|", 1)[1].strip().strip('"').rstrip(".")
            if candidate:
                title = candidate[:60]
    except Exception:
        log.exception("chat classification failed; defaulting to standard")

    model, effort = label_to_rung(label)
    return model, effort, label, title


class ChatManager:
    """Owns the registry of chats and which one is currently live.

    `app["bus"]` / `app["session"]` always point at the active chat -- existing handlers
    in server.py read those two keys and need no change at all; only the routes that
    manage chats themselves are new.
    """

    def __init__(self, app: Any, cwd: str) -> None:
        self.app = app
        self.cwd = cwd
        self.active_id: str | None = None
        self._dup_cache: tuple[float, list[dict[str, Any]]] | None = None
        self.index: dict[str, Any] = self._load_or_migrate()

    def _load_or_migrate(self) -> dict[str, Any]:
        try:
            return json.loads(INDEX_PATH.read_text())
        except (OSError, ValueError):
            pass
        now = time.time()
        index = {
            "active_id": LEGACY_ID,
            "chats": [{
                "id": LEGACY_ID, "title": "First conversation",
                "created_at": now, "last_active_at": now,
                "model": config.load_model(), "effort": config.load_effort(),
                "classified": True,
                "pinned": True,   # the original conversation is reference, not backlog
                "archived": False, "preview": "", "cwd": config.REPO.as_posix(),
                "events_path": str(config.STATE_DIR / "events.jsonl"),
                "outbox_path": str(config.SHARED_DIR / "outbox.json"),
                "session_id_path": str(config.STATE_DIR / "session_id"),
            }],
        }
        self._write(index)
        return index

    def _write(self, index: dict[str, Any] | None = None) -> None:
        self._dup_cache = None
        index = index if index is not None else self.index
        tmp = INDEX_PATH.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(index, indent=2))
            tmp.replace(INDEX_PATH)
        except OSError:
            pass  # A save that fails should not take a running chat down with it.

    def _meta(self, chat_id: str) -> dict[str, Any]:
        for c in self.index["chats"]:
            if c["id"] == chat_id:
                return c
        raise KeyError(chat_id)

    IDLE_ARCHIVE_DAYS = 7

    def decay(self) -> int:
        """Archive chats nobody has touched in a week.

        Filing is work charged at the worst moment -- while you are busy with the thing you
        would have to file. Decay charges nothing and is right by default, because the honest
        prior for any given chat is that it will never be opened again. Pinning is the one
        manual act, and it exists to *prevent* this rather than to cause anything, so it is
        only asked for on the small fraction where the answer is already obvious.
        """
        cutoff = time.time() - self.IDLE_ARCHIVE_DAYS * 86400
        changed = 0
        for c in self.index["chats"]:
            if c.get("pinned") or c.get("archived") or c["id"] == self.active_id:
                continue
            if c.get("last_active_at", 0) < cutoff:
                c["archived"] = True
                c["archived_at"] = time.time()
                changed += 1
        if changed:
            self._write()
        return changed

    def set_flag(self, chat_id: str, *, pinned: bool | None = None,
                 archived: bool | None = None) -> dict[str, Any]:
        meta = self._meta(chat_id)
        if pinned is not None:
            meta["pinned"] = bool(pinned)
            # Pinning something the decay already took is how you say "that was wrong".
            if pinned:
                meta["archived"] = False
        if archived is not None:
            meta["archived"] = bool(archived)
            if archived:
                meta["archived_at"] = time.time()
                meta["pinned"] = False
        self._write()
        return meta

    def duplicates(self) -> list[dict[str, Any]]:
        """Pairs of live chats that look like the same topic started twice.

        People restart a topic because finding the old chat was harder than opening a new
        one, so the duplicates are a symptom of the list being hard to search rather than of
        carelessness. Word overlap on the title is crude, but it is free and it only ever
        suggests -- nothing acts on it.
        """
        # Only the recent live chats, and only ever this many. The comparison is O(n^2), and
        # measured at 500 live chats it already cost 842ms per request -- at 5000 it is
        # roughly 84 seconds, on a request that has nothing to do with duplicates. Bounding
        # the input is not a compromise here: a chat you have not touched in months is not a
        # candidate for "you just restarted this by accident", so the pairs being dropped are
        # exactly the ones that were never going to match anything worth saying.
        DUP_SCAN = 40

        def words(c: dict[str, Any]) -> set[str]:
            text = f"{c.get('title', '')} {c.get('preview', '')}".lower()
            return {w for w in re.findall(r"[a-z]{4,}", text)}

        now = time.time()
        cached = self._dup_cache
        if cached and now - cached[0] < 60:
            return cached[1]

        live = sorted((c for c in self.index["chats"] if not c.get("archived")),
                      key=lambda c: -c.get("last_active_at", 0))[:DUP_SCAN]
        out = []
        for i, a in enumerate(live):
            wa = words(a)
            if len(wa) < 3:
                continue
            for b in live[i + 1:]:
                wb = words(b)
                if len(wb) < 3:
                    continue
                overlap = len(wa & wb) / len(wa | wb)
                if overlap >= 0.4:
                    older, newer = sorted((a, b), key=lambda c: c["last_active_at"])
                    out.append({"keep": newer["id"], "keep_title": newer["title"],
                                "drop": older["id"], "drop_title": older["title"],
                                "score": round(overlap, 2)})
        out = sorted(out, key=lambda d: -d["score"])[:5]
        self._dup_cache = (now, out)
        return out

    def list_public(self) -> list[dict[str, Any]]:
        return [
            {k: c.get(k) for k in
             ("id", "title", "model", "effort", "created_at", "last_active_at", "classified",
              "pinned", "archived", "preview", "cwd")}
            | {"active": c["id"] == self.active_id}
            # Pinned first, then recency. The client renders this order verbatim and
            # addresses it by index, so the server's order IS the display order -- any
            # client-side regrouping would make offset N mean two different things.
            for c in sorted(self.index["chats"],
                            key=lambda c: (not c.get("pinned"), -c["last_active_at"]))
        ]

    async def start_active(self) -> None:
        await self._activate(self.index.get("active_id", LEGACY_ID))

    async def _activate(self, chat_id: str) -> None:
        meta = self._meta(chat_id)
        bus = EventBus(persist_path=Path(meta["events_path"]))
        outbox = Outbox(path=Path(meta["outbox_path"]))
        sid_path = Path(meta["session_id_path"])

        def on_session_id(sid: str) -> None:
            try:
                sid_path.write_text(sid)
            except OSError:
                pass

        session = ClaudeSession(
            bus, cwd=self.cwd, model=meta.get("model"), effort=meta.get("effort"),
            session_id=sid_path.read_text().strip() if sid_path.exists() else None,
            outbox=outbox, on_session_id=on_session_id,
        )
        self.app["bus"] = bus
        self.app["session"] = session
        self.active_id = chat_id
        self.index["active_id"] = chat_id
        meta["last_active_at"] = time.time()
        self._write()

        # An unclassified chat has no model decided yet, and the model is fixed the moment
        # the CLI subprocess spawns -- so starting now would lock in a guess. It starts
        # itself, correctly, on its first prompt (see ensure_started).
        if meta["classified"]:
            session.start()

    async def switch(self, chat_id: str) -> None:
        if chat_id == self.active_id:
            return
        self._meta(chat_id)  # raises KeyError early if the id is bogus
        old = self.app.get("session")
        if old is not None:
            await old.stop()
        # Retire the outgoing bus so anything still streaming from it ends and reconnects.
        # Without this a switch from anywhere other than the chat button -- deleting the
        # active chat, a second tab, the server moving hosts -- leaves open streams
        # subscribed to a bus nobody publishes to again.
        old_bus = self.app.get("bus")
        if old_bus is not None:
            old_bus.close()
        await self._activate(chat_id)

    def create(self) -> dict[str, Any]:
        chat_id = uuid.uuid4().hex[:10]
        chat_dir = CHATS_DIR / chat_id
        chat_dir.mkdir(parents=True, exist_ok=True)
        now = time.time()
        meta = {
            "id": chat_id, "title": "New chat",
            "created_at": now, "last_active_at": now,
            "model": None, "effort": None, "classified": False,
            "pinned": False, "archived": False, "preview": "", "cwd": self.cwd,
            "events_path": str(chat_dir / "events.jsonl"),
            "outbox_path": str(chat_dir / "outbox.json"),
            "session_id_path": str(chat_dir / "session_id"),
        }
        self.index["chats"].append(meta)
        self._write()
        return meta

    def note_manual_override(self, *, model: str | None = None,
                             effort: str | None = None) -> None:
        """Record a hand-picked model/effort against the *active chat*.

        Without this, /model changed the live client and the global config but left the
        chat's own meta alone -- so switching away and back re-activated the chat from meta
        and silently reverted to whatever classification had chosen. The pick looked like it
        held, right up until you used the feature the picks exist to serve.

        The two axes lock independently. Marking the whole chat "classified" on any pick
        was wrong in both directions: choosing only an effort silently cancelled the model
        classification, and choosing only a model left the effort to be overwritten. They
        are separate decisions and the user makes them with separate taps.
        """
        if not self.active_id:
            return
        try:
            meta = self._meta(self.active_id)
        except KeyError:
            return
        if model:
            meta["model"] = None if model == "default" else model
            meta["model_locked"] = True
        if effort:
            meta["effort"] = effort
            meta["effort_locked"] = True
        self._write()

    async def delete(self, chat_id: str) -> None:
        """Remove a chat and its transcript.

        Deleting the active chat would leave app["bus"]/app["session"] pointing at a chat
        that no longer exists, so it switches away first. The legacy chat is refused
        outright: its paths are the pre-chats files, and "delete" there would mean unlinking
        the original conversation's transcript from under a path three other things still
        reference. There is no undo here, so the one irreversible case is simply not offered.
        """
        if chat_id == LEGACY_ID:
            raise ValueError("the first conversation cannot be deleted")
        meta = self._meta(chat_id)
        if chat_id == self.active_id:
            other = next((c["id"] for c in self.index["chats"] if c["id"] != chat_id), None)
            if other is None:
                raise ValueError("cannot delete the only chat")
            await self.switch(other)

        for key in ("events_path", "outbox_path", "session_id_path"):
            try:
                Path(meta[key]).unlink(missing_ok=True)
            except OSError:
                log.warning("could not remove %s for chat %s", key, chat_id)
        try:
            (CHATS_DIR / chat_id).rmdir()
        except OSError:
            pass  # non-empty or already gone; the registry entry is what matters

        self.index["chats"] = [c for c in self.index["chats"] if c["id"] != chat_id]
        self._write()

    async def ensure_started(self, first_prompt: str) -> None:
        """Called on every /prompt. A no-op for a chat already running; for a fresh one,
        classifies on this exact message, fixes the model, then spawns the subprocess."""
        session: ClaudeSession = self.app["session"]
        if session.started:
            return
        meta = self._meta(self.active_id)

        # Already decided, so there is nothing to classify -- just honour it and start.
        # Without this check a hand-picked model was overwritten on the first message every
        # single time: the user chose sonnet, sent four words, and got haiku, because a
        # four-word prompt is pre-screened straight to haiku and nothing consulted the pick.
        locked_model = meta.get("model_locked")
        locked_effort = meta.get("effort_locked")
        if meta.get("classified") or (locked_model and locked_effort):
            meta["classified"] = True
            self._write()
            session.model, session.effort = meta.get("model"), meta.get("effort")
            session.start()
            return

        self.app["bus"].publish("classifying")
        model, effort, label, title = await classify_new_chat(first_prompt, cwd=self.cwd)
        # A locked axis keeps the user's value; the other one takes the classification.
        if not locked_model:
            meta["model"] = model
        if not locked_effort:
            meta["effort"] = effort
        model, effort = meta["model"], meta["effort"]
        meta["classified"] = True
        meta["title"] = title or "New chat"
        # Searching titles alone misses the thing you actually remember: how you opened.
        meta["preview"] = first_prompt.strip()[:300]
        self._write()
        session.model, session.effort = model, effort
        self.app["bus"].publish("classified", model=model, effort=effort, label=label,
                                title=meta["title"])
        session.start()
