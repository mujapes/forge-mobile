"""The Claude session: one long-lived conversation, driven by the Agent SDK.

Built on the assumption that the process will die unexpectedly. The session id is written to
disk as soon as it is known, so a restart resumes the same conversation rather than starting a
fresh one. Prompts are queued, and the queue is persisted the moment something enters it, so a
crash between "user hit send" and "Claude replied" doesn't silently swallow the turn.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from claude_agent_sdk import (
    ClaudeAgentOptions,
    ClaudeSDKClient,
    PermissionResultAllow,
    PermissionResultDeny,
)

from . import config
from .events import EventBus, normalize
from .router import Router
from .outbox import DONE, IN_FLIGHT, INTERRUPTED, Outbox

log = logging.getLogger("forged.session")

RETRY_DELAY_SECONDS = 3

# "Not specified" and "deliberately no session yet" are different answers, and conflating
# them made every new chat resume the first conversation: chats.py passes None to mean
# "fresh chat, no transcript", which the default-loading branch read as "unspecified" and
# answered with the global session id.
_UNSET = object()

# Mobile data drops constantly, so the UI needs to distinguish "your connection is flaky"
# from "the backend is broken" -- they call for very different user reactions.
_NETWORK_HINTS = ("connection", "network", "timeout", "timed out", "unreachable",
                  "dns", "getaddrinfo", "reset by peer", "ssl", "429", "503", "502")


def _classify(exc: Exception) -> str:
    text = f"{type(exc).__name__} {exc}".lower()
    return "network" if any(h in text for h in _NETWORK_HINTS) else "backend"


class PermissionRequest:
    def __init__(self, req_id: str, tool_name: str, tool_input: dict, ctx: Any) -> None:
        self.id = req_id
        self.tool_name = tool_name
        self.tool_input = tool_input
        self.future: asyncio.Future = asyncio.get_event_loop().create_future()
        self.payload = {
            "request_id": req_id,
            "tool_name": tool_name,
            "display_name": getattr(ctx, "display_name", None) or tool_name,
            "description": getattr(ctx, "description", None),
            "reason": getattr(ctx, "decision_reason", None),
            "tool_use_id": getattr(ctx, "tool_use_id", None),
            "input": _jsonable(tool_input),
            "suggestions": [_suggestion(s) for s in (getattr(ctx, "suggestions", None) or [])],
        }


def _suggestion(s: Any) -> dict[str, Any]:
    """A consent option the CLI itself proposed -- becomes a button in the UI."""
    # `rules` was omitted, so every addRules suggestion reached the UI indistinguishable from
    # the next and fell back to the same generic label -- two buttons both reading "Allow more".
    rules = [
        {"toolName": getattr(r, "tool_name", None) or getattr(r, "toolName", None),
         "ruleContent": getattr(r, "rule_content", None) or getattr(r, "ruleContent", None)}
        for r in (getattr(s, "rules", None) or [])
    ]
    return {
        "type": getattr(s, "type", None),
        "mode": getattr(s, "mode", None),
        "directories": getattr(s, "directories", None),
        "behavior": getattr(s, "behavior", None),
        "destination": getattr(s, "destination", None),
        "rules": rules or None,
    }


def _jsonable(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return json.loads(json.dumps(value, default=str))


class ClaudeSession:
    """One conversation. Multiple can exist (see chats.py); each owns its own outbox, its
    own session_id, and its own persisted event log, so one chat's history never bleeds
    into another's context.

    All the per-chat identity is constructor-overridable but defaults to the original
    single-conversation globals, so existing single-chat callers (and the pre-multi-chat
    on-disk state) keep working unchanged.
    """

    def __init__(self, bus: EventBus, cwd: str, model: str | None = None, *,
                session_id: Any = _UNSET, outbox: Outbox | None = None,
                effort: str | None = None,
                on_session_id: Any = None) -> None:
        self.bus = bus
        self.cwd = cwd
        self.model = model or config.load_model()
        # Explicit None means "start a new conversation"; only an omitted argument falls
        # back to the single-chat global.
        self.session_id = (config.load_session_id() if session_id is _UNSET else session_id)
        # Where a freshly learned session_id gets written. Per-chat callers pass their own
        # chat's file; the default preserves the original single-conversation location.
        self._on_session_id = on_session_id or config.save_session_id
        # Set by compact(); read at the end of a turn to drop the client and reconnect
        # without a resume id. A flag rather than a cancellation because a turn in flight
        # must be allowed to finish -- compacting mid-answer would lose the answer.
        self._recycle = False
        self.pending: dict[str, PermissionRequest] = {}
        self.asks: dict[str, asyncio.Future] = {}  # AskUserQuestion awaiting a choice
        self.auto_approve = config.load_auto_approve()
        # Picks the model by what the work needs; usage only caps it near the limit.
        self.router = Router()
        self.effort = effort if effort is not None else config.load_effort()
        # Each rate_limit event carries a single window, so hold the last known value of each
        # and republish the merged set -- otherwise the 7-day figure erases the 5-hour one.
        self.rate_limits: dict[str, Any] = {}
        self.busy = False
        self.outbox = outbox if outbox is not None else Outbox()
        self._queue: asyncio.Queue[dict] = asyncio.Queue()
        self._client: ClaudeSDKClient | None = None
        self._req_counter = 0
        # Tool calls in the turn currently running; the router's only measure of what a
        # turn actually became rather than what it was predicted to be.
        self._turn_tools = 0
        self._task: asyncio.Task | None = None

    @property
    def started(self) -> bool:
        """False for a chat that has been switched to but has not taken its first prompt
        yet -- the point at which a fresh chat picks its model and actually spawns a CLI."""
        return self._task is not None

    def start(self) -> None:
        unsent, interrupted = self.outbox.recover()
        for entry in unsent:
            self._queue.put_nowait(entry)
        for entry in interrupted:
            # Claude may or may not have handled this one; let the user decide rather than
            # risking a duplicate turn.
            self.bus.publish("turn_interrupted", id=entry["id"], text=entry["text"])
        self._task = asyncio.create_task(self._run_forever())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()

    async def submit(self, text: str) -> None:
        entry = self.outbox.add(text)
        await self._queue.put(entry)
        self.bus.publish("user_message", text=text, id=entry["id"])

    def idle_for_reload(self) -> bool:
        """No turn running and nothing waiting to run.

        `busy` alone is not enough: a prompt can sit in the queue for a moment before the
        run loop picks it up, and restarting in that window loses it silently.
        """
        return not self.busy and self._queue.empty() and not self.pending

    async def set_model(self, model: str | None) -> None:
        self.model = model
        config.save_model(model)
        if self._client:
            await self._client.set_model(model)
        self.bus.publish("model_changed", model=model or "default")

    async def interrupt(self) -> None:
        if self._client:
            await self._client.interrupt()
            self.bus.publish("interrupted")

    def answer_permission(self, request_id: str, allow: bool,
                          suggestion_index: int | None = None) -> bool:
        req = self.pending.pop(request_id, None)
        if req is None or req.future.done():
            return False
        req.future.set_result((allow, suggestion_index))
        return True

    async def _ask_user(self, tool_input: dict):
        """Render AskUserQuestion ourselves and feed the choice back as the tool result.

        The CLI's own AskUserQuestion UI needs a terminal, which there isn't one of here -- it
        just reports that nobody answered, so every question Claude asked was invisible and
        unanswerable. Deny-with-message is the only channel the SDK offers for returning text
        to Claude, so the "denial" carries the answer.
        """
        self._req_counter += 1
        req_id = f"ask-{self._req_counter}"
        future: asyncio.Future = asyncio.get_event_loop().create_future()
        self.asks[req_id] = future
        questions = tool_input.get("questions") or []
        self.bus.publish("ask_request", id=req_id, questions=questions)
        try:
            answers = await future
        finally:
            self.asks.pop(req_id, None)
        self.bus.publish("ask_resolved", id=req_id)

        if not answers:
            return PermissionResultDeny(
                message="The user dismissed the question without answering.", interrupt=False)
        lines = [f"{q}: {a}" for q, a in answers.items()]
        return PermissionResultDeny(
            message="The user answered:\n" + "\n".join(lines), interrupt=False)

    def answer_ask(self, req_id: str, answers: dict | None) -> bool:
        future = self.asks.get(req_id)
        if future is None or future.done():
            return False
        future.set_result(answers or {})
        return True

    async def _can_use_tool(self, tool_name: str, tool_input: dict, ctx: Any):
        if tool_name == "AskUserQuestion":
            return await self._ask_user(tool_input)

        # Auto-approve without prompting. A genuine question still reaches the user above,
        # which is the distinction that matters: consent for an ambiguous *decision*, not a
        # tap for every shell command.
        if self.auto_approve:
            return PermissionResultAllow()

        self._req_counter += 1
        req = PermissionRequest(f"perm-{self._req_counter}", tool_name, tool_input, ctx)
        self.pending[req.id] = req
        self.bus.publish("permission_request", **req.payload)

        allow, suggestion_index = await req.future
        self.bus.publish("permission_resolved", request_id=req.id, allowed=allow)

        if not allow:
            return PermissionResultDeny(message="Denied from Forge", interrupt=False)

        updates = None
        suggestions = getattr(ctx, "suggestions", None) or []
        if suggestion_index is not None and 0 <= suggestion_index < len(suggestions):
            updates = [suggestions[suggestion_index]]
        return PermissionResultAllow(updated_permissions=updates)

    def _options(self) -> ClaudeAgentOptions:
        return ClaudeAgentOptions(
            cwd=self.cwd,
            model=self.model,
            permission_mode="default",
            # How hard the model works per turn. Lowered by the budget as limits tighten.
            effort=self.effort,
            can_use_tool=self._can_use_tool,
            include_partial_messages=True,
            resume=self.session_id,
            setting_sources=["user", "project", "local"],
            # A single tool result larger than the default 1MB kills the message reader
            # outright ("JSON message exceeded maximum buffer size"), which has already
            # dropped ten turns. Reading a screenshot or a long file easily exceeds it.
            max_buffer_size=16 * 1024 * 1024,
        )

    async def _run_forever(self) -> None:
        while True:
            try:
                await self._run_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.exception("session died")
                self.busy = False
                self.bus.publish("disconnected", error=str(exc), layer=_classify(exc))
                self._fail_pending()
                await asyncio.sleep(RETRY_DELAY_SECONDS)

    def _fail_pending(self) -> None:
        """A dead CLI can never answer these; unblock them rather than leaking waiters."""
        for req in list(self.pending.values()):
            if not req.future.done():
                req.future.set_result((False, None))
        self.pending.clear()
        for future in list(self.asks.values()):
            if not future.done():
                future.set_result({})
        self.asks.clear()

    async def _run_once(self) -> None:
        async with ClaudeSDKClient(options=self._options()) as client:
            self._client = client
            self.bus.publish("connected", resumed=bool(self.session_id))
            try:
                while True:
                    entry = await self._queue.get()
                    await self._apply_routing(entry["text"])
                    self.busy = True
                    self._turn_tools = 0
                    self.outbox.mark(entry["id"], IN_FLIGHT)
                    self.bus.publish("turn_start", id=entry["id"])
                    completed = False
                    try:
                        await client.query(entry["text"])
                        async for msg in client.receive_response():
                            self._emit(msg)
                        self.outbox.mark(entry["id"], DONE)
                        completed = True
                    finally:
                        self.busy = False
                        # The router guesses before a turn and, until now, never found out
                        # what the turn became. Tool calls are the honest measure of that:
                        # a turn that ran a dozen was real work whatever it was phrased
                        # like. Fed back here so the next guess is informed by it.
                        try:
                            self.router.note_outcome(self._turn_tools)
                        except Exception:
                            pass
                        if not completed:
                            # A hard usage-limit cutoff (or any other mid-turn crash) raises
                            # out of client.query()/receive_response() before DONE is ever
                            # written, and recover()'s IN_FLIGHT->INTERRUPTED promotion only
                            # runs on a fresh daemon *process* start -- not on this same
                            # process reconnecting after the exception below. Left alone,
                            # the entry sat at IN_FLIGHT forever: invisible to /state, absent
                            # from outbox.interrupted(), and turn_end still fired normally on
                            # the way out, so the UI saw a clean turn boundary with no
                            # content and no error. That is indistinguishable from "did
                            # nothing" -- which is exactly what got reported: the first
                            # message sent while still over a usage window silently vanished,
                            # repeating for every message until the window actually reset.
                            # Marking it INTERRUPTED here, in the same place DONE already is,
                            # routes it through the machinery that already exists for this
                            # (turn_interrupted -> renderInterrupted in the UI) instead of
                            # requiring a full restart to surface it at all.
                            self.outbox.mark(entry["id"], INTERRUPTED)
                            self.bus.publish("turn_interrupted", id=entry["id"],
                                            text=entry["text"])
                        self.bus.publish("turn_end", id=entry["id"])
                    if self._recycle:
                        # Compaction. Returning here drops the client, and _run_forever
                        # immediately opens a new one -- with resume=None, because the id
                        # was cleared before the flag was set. Anything still queued is
                        # untouched and becomes the first turn of the fresh session, which
                        # is how the handover note gets in.
                        self._recycle = False
                        self.bus.publish("compacted", at=time.time())
                        return
            finally:
                self._client = None

    async def compact(self, seed_text: str) -> None:
        """Throw away the transcript, keep the thread.

        The id is cleared first and the flag set second, so that however the turn loop is
        scheduled the reconnect can never pick up the old conversation. The seed is queued
        rather than sent, because the current client is about to be discarded and anything
        handed to it now would go into the session being abandoned.
        """
        self.session_id = None
        try:
            self._on_session_id(None)
        except Exception as exc:                      # persisting is best effort
            log.warning("compact: could not clear stored session id: %s", exc)
        await self.submit(seed_text)
        self._recycle = True

    async def _apply_routing(self, prompt: str) -> None:
        """Move to the rung this turn calls for, if it has changed.

        Only the model is switched live: effort is fixed when the client connects, so it is
        persisted and takes effect on the next reconnect rather than forcing one here. A
        reconnect mid-session to change one setting would cost more than the setting saves.
        """
        choice = self.router.choose(prompt, self.rate_limits)
        if not choice:
            return
        model, effort = choice["model"], choice["effort"]

        if effort != self.effort:
            self.effort = effort
            config.save_effort(effort)

        if model != (self.model or "default"):
            try:
                await self.set_model(model)
            except Exception as exc:
                log.warning("budget: could not switch to %s: %s", model, exc)
                return

        self.bus.publish("routing", model=model, effort=effort,
                         score=choice.get("score"),
                         reason=choice.get("reason", ""),
                         utilisation=choice.get("utilisation"),
                         capped=choice.get("capped_by_usage", False))

    def _emit(self, msg: Any) -> None:
        for kind, data in normalize(msg):
            if kind == "tool_start":
                self._turn_tools += 1
            if kind == "rate_limit":
                self.rate_limits.update(data.get("windows") or {})
                data = {"windows": dict(self.rate_limits)}
            if kind == "session" and data.get("session_id"):
                sid = data["session_id"]
                if sid != self.session_id:
                    self.session_id = sid
                    self._on_session_id(sid)
            self.bus.publish(kind, **data)
