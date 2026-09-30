"""HTTP surface: SSE out, JSON in, static UI.

Auth is a single shared token. EventSource cannot set headers, so the token is accepted from
an Authorization header, a query parameter, or a cookie -- the UI is opened once with the
token in the URL, sets a cookie, and drops it from the address bar thereafter.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import mimetypes
import os
import secrets
import time
from pathlib import Path

from aiohttp import web

from . import build, compact, config
from .exec import Runner
from .events import CLOSED, EventBus
from .pairing import Pairing
from .session import ClaudeSession

log = logging.getLogger("forged.server")

COOKIE = "forge_token"
HEARTBEAT_SECONDS = 20


def _authorized(request: web.Request) -> bool:
    token: str = request.app["token"]
    header = request.headers.get("Authorization", "")
    candidates = [
        header[7:] if header.startswith("Bearer ") else "",
        request.query.get("token", ""),
        request.cookies.get(COOKIE, ""),
    ]
    return any(hmac.compare_digest(c, token) for c in candidates if c)


@web.middleware
async def auth_middleware(request: web.Request, handler):
    if request.path in ("/health", "/pair"):
        return await handler(request)
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    return await handler(request)


async def health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def pair(request: web.Request) -> web.Response:
    """Exchange a six-digit code for the token. Deliberately unauthenticated."""
    body = await request.json()
    pairing = request.app["pairing"]
    if not pairing.check(str(body.get("code", ""))):
        remaining = max(0, 5 - pairing.attempts) if pairing.active else 0
        log.warning("failed pairing attempt from %s", request.remote)
        return web.json_response({"error": "bad code", "attempts_left": remaining},
                                 status=403)
    return web.json_response({"token": request.app["token"]})


async def events(request: web.Request) -> web.StreamResponse:
    bus: EventBus = request.app["bus"]
    try:
        after = int(request.headers.get("Last-Event-ID")
                    or request.query.get("last_event_id") or 0)
    except ValueError:
        after = 0

    response = web.StreamResponse(headers={
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    })
    await response.prepare(request)

    queue, missed = bus.subscribe(after_id=after)
    try:
        for ev in missed:
            await response.write(ev.sse(replay=True))
        while True:
            try:
                ev = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                await response.write(b": heartbeat\n\n")
                continue
            if ev is CLOSED:
                break       # bus retired (chat switched); ending the response makes the
                            # browser reconnect, and it lands on the new chat's bus
            await response.write(ev.sse())
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    finally:
        bus.unsubscribe(queue)
    return response


async def prompt(request: web.Request) -> web.Response:
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        return web.json_response({"error": "empty prompt"}, status=400)
    session: ClaudeSession = request.app["session"]
    await session.submit(text)
    return web.json_response({"ok": True})


async def history(request: web.Request) -> web.Response:
    """Older transcript events, so the UI can scroll back past its replay window."""
    try:
        before = int(request.query.get("before", 0))
        after = int(request.query.get("after", 0))
        limit = min(int(request.query.get("limit", 150)), 500)
    except ValueError:
        return web.json_response({"error": "bad params"}, status=400)
    bus: EventBus = request.app["bus"]
    # `after` pages forward, for a client that has discarded newer nodes to bound its memory
    # and is now scrolling back down towards the live tail.
    items = bus.page_after(after, limit) if after else bus.page(before, limit)
    return web.json_response({"items": items})


# Built into the CLI rather than discoverable on disk, so they have to be listed. /help is
# left out: it is answered by the CLI's REPL, which this client is not, so it would arrive
# as a sentence rather than a command.
BUILTIN_COMMANDS = [
    # Handled by the client, not the session: the CLI's REPL owns these and the agent never
    # sees them, so Forge answers them itself rather than listing commands that do nothing.
    ("model", "Switch model, or open the picker: /model sonnet"),
    ("effort", "Set reasoning effort: /effort high"),
    ("clear", "Start a new chat with fresh context"),
    ("compact", "Summarise this chat and restart it with a fraction of the context"),
    ("chats", "Open the chat drawer"),
    ("settings", "Open settings"),
    ("code-review", "Review the current diff for bugs and cleanups"),
    ("simplify", "Clean up the changed code: reuse, simplification, efficiency"),
    ("security-review", "Security review of the pending changes"),
    ("loop", "Run a prompt on a recurring interval"),
    ("schedule", "Create or manage scheduled cloud agents"),
    ("run", "Launch the project's app to see a change working"),
    ("init", "Write a CLAUDE.md for this codebase"),
    ("claude-api", "Reference for the Claude API: models, pricing, params"),
    ("dataviz", "Guidance before writing any chart or dashboard code"),
    ("update-config", "Configure hooks, permissions and settings.json"),
    ("fewer-permission-prompts", "Add an allowlist for common read-only calls"),
    ("keybindings-help", "Customise keyboard shortcuts"),
]


def _skill_dirs() -> list[Path]:
    """Every place a skill can come from, whether or not it currently exists."""
    home = Path.home() / ".claude"
    return [
        home / "skills",
        config.REPO / ".claude" / "skills",
        home / "commands",
        config.REPO / ".claude" / "commands",
    ]


def _read_front_matter(path: Path) -> tuple[str, str]:
    """(name, description) from a SKILL.md, falling back to the directory name."""
    name, desc = path.parent.name, ""
    try:
        text = path.read_text(errors="replace")[:4000]
    except OSError:
        return name, desc
    if text.startswith("---"):
        block = text.split("---", 2)[1] if text.count("---") >= 2 else ""
        for line in block.splitlines():
            if line.startswith("name:"):
                name = line[5:].strip() or name
            elif line.startswith("description:"):
                desc = line[12:].strip()
    return name, desc


async def commands(request: web.Request) -> web.Response:
    """Slash commands available to the session, for the composer's picker.

    Read from disk rather than hardcoded, because skills arrive by syncing and by installing
    plugins -- a list baked into the client would be wrong the first time either happens.
    """
    found: dict[str, str] = {}
    for root in _skill_dirs():
        if not root.is_dir():
            continue
        for skill in root.rglob("SKILL.md"):
            name, desc = _read_front_matter(skill)
            found.setdefault(name, desc)
        for cmd in root.glob("*.md"):
            found.setdefault(cmd.stem, "")

    for name, desc in BUILTIN_COMMANDS:
        found.setdefault(name, desc)

    items = [{"name": n, "description": (found[n] or "")[:140]} for n in sorted(found)]
    return web.json_response({"items": items})


async def diag(request: web.Request) -> web.Response:
    """Let the app report facts about its Android side that the VM cannot see.

    The guest has no view of the host's package list, so things like the Linux Terminal's
    package name can only be discovered by the APK and sent back here.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "expected json"}, status=400)
    log.info("client diag: %s", json.dumps(body, default=str)[:2000])
    return web.json_response({"ok": True})


async def uistate(request: web.Request) -> web.Response:
    """Save a compact text dump of the on-screen UI, for Claude to Read by path.

    Mirrors how screenshots are attached (see openShots/attach in app.js): the client
    never uploads bytes, it just gets a path back and names it in the prompt. A DOM/
    accessibility-style text dump is far cheaper for Claude to process than an image of
    the same screen and, unlike a screenshot, is exact about strings -- no OCR needed and
    nothing to misread. Capped well under the 2000-char /diag log truncation since this
    can be a full page dump, not a one-line fact.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "expected json"}, status=400)
    text = str(body.get("text") or "")[:40_000]
    if not text.strip():
        return web.json_response({"error": "empty dump"}, status=400)
    label = "".join(c for c in str(body.get("label") or "state") if c.isalnum() or c in "-_")[:40] or "state"
    d = config.STATE_DIR / "uistate"
    d.mkdir(parents=True, exist_ok=True)
    # Whole-second timestamps collide on rapid successive captures (seen in testing: a
    # tight loop of writes silently overwrote all but the last). time_ns plus a short
    # random suffix makes every dump its own file regardless of how fast it is retaken.
    path = d / f"{label}-{time.time_ns()}-{secrets.token_hex(3)}.txt"
    path.write_text(text)
    # Dumps are cheap to make and easy to forget about; keep only the recent ones so this
    # directory doesn't grow forever on a device that's already tight on storage.
    old = sorted(d.glob("*.txt"), key=lambda p: p.stat().st_mtime, reverse=True)[20:]
    for p in old:
        p.unlink(missing_ok=True)
    return web.json_response({"ok": True, "path": str(path), "bytes": len(text)})


async def new_pairing_code(request: web.Request) -> web.Response:
    """Mint a fresh pairing code. Authenticated, unlike /pair itself.

    Codes last ten minutes and are only printed at startup, so pairing a phone any later than
    that meant restarting the daemon just to read a new one off the log.
    """
    pairing: Pairing = request.app["pairing"]
    code = pairing.renew()
    log.info("pairing code renewed on request: %s", code)
    return web.json_response({"code": code, "expires_in": 600})


async def answer_ask(request: web.Request) -> web.Response:
    """Deliver the user's AskUserQuestion choices back to the waiting tool call."""
    body = await request.json()
    req_id = (body.get("id") or "").strip()
    answers = body.get("answers")
    if not req_id:
        return web.json_response({"error": "missing id"}, status=400)
    if answers is not None and not isinstance(answers, dict):
        return web.json_response({"error": "answers must be an object"}, status=400)
    session: ClaudeSession = request.app["session"]
    return web.json_response({"ok": session.answer_ask(req_id, answers)})


async def resolve_turn(request: web.Request) -> web.Response:
    """Mark an interrupted turn as dealt with, so it stops reappearing on every restart."""
    body = await request.json()
    entry_id = (body.get("id") or "").strip()
    if not entry_id:
        return web.json_response({"error": "missing id"}, status=400)
    session: ClaudeSession = request.app["session"]
    return web.json_response({"ok": session.outbox.resolve(entry_id)})


async def permission(request: web.Request) -> web.Response:
    body = await request.json()
    request_id = body.get("request_id")
    allow = bool(body.get("allow"))
    index = body.get("suggestion_index")
    session: ClaudeSession = request.app["session"]
    ok = session.answer_permission(request_id, allow,
                                   int(index) if index is not None else None)
    if not ok:
        return web.json_response({"error": "no such pending request"}, status=404)
    return web.json_response({"ok": True})


async def compact_session(request: web.Request) -> web.Response:
    """Replace the transcript with a handover note and carry on in the same chat.

    The gap this fills: every turn re-uploads the whole conversation, so a long session's
    cost per turn grows with its own history until it is spending a large share of a usage
    window to say anything at all. The CLI's REPL solves that with /compact; Forge drives
    the SDK instead, which has no such option, so the only lever here was /clear -- and
    throwing away the thread to save money is not a trade anyone wants to make repeatedly.

    Summarising happens before anything is discarded. If it fails, the session is left
    exactly as it was.
    """
    session: ClaudeSession = request.app["session"]
    # The active chat's own log, or the single-chat one outside split mode. Read through
    # the chats object rather than assumed, because each chat keeps a separate transcript
    # and compacting the wrong one would summarise a conversation nobody is having.
    chats = request.app.get("chats")
    path = Path.home() / ".forge" / "events.jsonl"
    if chats is not None and getattr(chats, "active_id", None):
        try:
            path = Path(chats._meta(chats.active_id)["events_path"])
        except Exception as exc:
            log.warning("compact: falling back to the default log: %s", exc)

    summary = await asyncio.get_running_loop().run_in_executor(
        None, lambda: compact.summarise(path))
    if not summary:
        return web.json_response(
            {"ok": False, "error": "nothing substantial to summarise"}, status=400)

    await session.compact(compact.seed(summary))
    log.info("compact: %d chars of summary, session restarting", len(summary))
    return web.json_response({"ok": True, "summary": summary})


async def interrupt(request: web.Request) -> web.Response:
    await request.app["session"].interrupt()
    return web.json_response({"ok": True})


async def state(request: web.Request) -> web.Response:
    """Everything needed to redraw after a reconnect. The UI holds no authoritative state."""
    session: ClaudeSession = request.app["session"]
    bus: EventBus = request.app["bus"]
    return web.json_response({
        "session_id": session.session_id,
        "busy": session.busy,
        "last_event_id": bus.last_id,
        "pending_permissions": [r.payload for r in session.pending.values()],
        "cwd": session.cwd,
        # So the gauge is populated on load instead of waiting for the next transition event.
        "rate_limits": session.rate_limits,
        "effort": getattr(session, "effort", None),
        # Authoritative list, so the UI can ignore replayed turn_interrupted events without
        # ever losing a genuine one.
        "interrupted_turns": [{"id": e["id"], "text": e["text"]}
                              for e in session.outbox.interrupted()],
        # Absent outside split mode: multi-chat needs the session host to hold more than
        # one conversation, which only exists there.
        "chat_id": getattr(request.app.get("chats"), "active_id", None),
        "model": session.model,
    })


# Roots the UI may browse and display. Anything outside these is refused outright rather
# than filtered, so a path traversal cannot reach the VM's own files.
MEDIA_ROOTS = (
    Path("/mnt/shared/Pictures"),
    Path("/mnt/shared/DCIM"),
    Path("/mnt/shared/Download"),
)

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

# The picker draws a 3-column grid of ~120px tiles. Serving the originals meant ~10 MB and
# 24 full-size PNG decodes per open, so the grid sat on placeholder text for seconds and the
# filenames underneath were all anyone could see. Downscale instead, and cache to disk.
THUMB_DIR = config.STATE_DIR / "thumbs"
THUMB_WIDTHS = frozenset({160, 240, 360})  # whitelisted: an open width is an unbounded cache


def _within_media(path: Path) -> bool:
    return any(path.is_relative_to(root) for root in MEDIA_ROOTS)


async def _thumbnail(src: Path, width: int) -> Path | None:
    """Downscale via ffmpeg, memoised on disk. None if it cannot be produced."""
    try:
        mtime_ns = src.stat().st_mtime_ns
    except OSError:
        return None
    # The source mtime is part of the key, so a cache hit can never be stale and the
    # response is safe to mark immutable.
    key = hashlib.sha256(f"{src}|{mtime_ns}|{width}".encode()).hexdigest()[:32]
    out = THUMB_DIR / f"{key}.jpg"
    if out.exists():
        return out

    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f"{key}.{os.getpid()}.tmp.jpg")
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-v", "error", "-y", "-i", str(src),
            "-vf", f"scale={width}:-2:flags=bilinear", "-frames:v", "1", "-q:v", "5", str(tmp),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
    except (OSError, ValueError):
        tmp.unlink(missing_ok=True)
        return None
    except asyncio.CancelledError:
        tmp.unlink(missing_ok=True)
        raise

    if proc.returncode != 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        return None
    # Atomic, so two concurrent requests for the same tile cannot serve a half-written file.
    tmp.replace(out)
    return out


async def screenshots(request: web.Request) -> web.Response:
    """Recent screenshots, newest first -- the fastest way to show Claude what you mean."""
    try:
        limit = min(int(request.query.get("limit", 24)), 100)
    except ValueError:
        limit = 24

    found: list[tuple[float, Path]] = []
    for root in MEDIA_ROOTS:
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if path.suffix.lower() in IMAGE_SUFFIXES and path.is_file():
                try:
                    found.append((path.stat().st_mtime, path))
                except OSError:
                    continue

    found.sort(reverse=True)
    return web.json_response({"items": [
        {"path": str(p), "name": p.name, "mtime": mtime}
        for mtime, p in found[:limit]
    ]})


CAPTURE_DIR = Path("/mnt/shared/Download/forge/captures")


async def captures(request: web.Request) -> web.Response:
    """Recent captures, newest first.

    A capture is a pair of files sharing a stem: the .txt is the payload Claude actually
    reads (accessibility tree, or an event log for a recording) and the .jpg exists so the
    picker has something recognisable to show and so colour and shape survive -- the tree
    carries neither. The text is the point; the image is the thumbnail and the colour channel
    at once, which is why it is listed as a property of the capture rather than as its own
    item the way /screenshots does it.
    """
    try:
        limit = min(int(request.query.get("limit", 24)), 100)
    except ValueError:
        limit = 24

    items = []
    if CAPTURE_DIR.is_dir():
        for txt in CAPTURE_DIR.glob("*.txt"):
            try:
                st = txt.stat()
            except OSError:
                continue
            jpg = txt.with_suffix(".jpg")
            items.append({
                "stem": txt.stem,
                "text": str(txt),
                "image": str(jpg) if jpg.is_file() else None,
                "mtime": st.st_mtime,
                "bytes": st.st_size,
                # "rec-" is written by a recording and "cap-" by a single shot; the picker
                # shows them differently and the prefix is the only thing that separates them.
                "kind": "rec" if txt.name.startswith("rec-") else "shot",
            })
    items.sort(key=lambda i: i["mtime"], reverse=True)
    return web.json_response({"items": items[:limit]})


async def media(request: web.Request) -> web.StreamResponse:
    raw = request.query.get("path", "")
    try:
        target = Path(raw).resolve()
    except (OSError, ValueError):
        raise web.HTTPBadRequest()
    if not _within_media(target) or not target.is_file():
        raise web.HTTPNotFound()

    try:
        width = int(request.query.get("w", 0))
    except ValueError:
        width = 0
    if width in THUMB_WIDTHS:
        thumb = await _thumbnail(target, width)
        if thumb is not None:
            return web.FileResponse(thumb, headers={
                "Content-Type": "image/jpeg",
                "Cache-Control": "private, max-age=31536000, immutable",
            })
        # Thumbnailing is an optimisation; fall through to the original rather than 404.

    ctype, _ = mimetypes.guess_type(target.name)
    return web.FileResponse(target, headers={"Content-Type": ctype or "application/octet-stream"})


async def projects(request: web.Request) -> web.Response:
    """Anything with a manifest is buildable, so discovery beats configuration."""
    found = []
    for manifest in config.REPO.rglob("AndroidManifest.xml"):
        if ".venv" in manifest.parts or "build" in manifest.parts:
            continue
        rel = manifest.parent.relative_to(config.REPO)
        apk = config.APK_OUT / f"{manifest.parent.name}.apk"
        found.append({
            "project": str(rel),
            "name": manifest.parent.name,
            "built_at": apk.stat().st_mtime if apk.exists() else None,
        })
    found.sort(key=lambda p: p["project"])
    return web.json_response({"items": found})


async def run_build(request: web.Request) -> web.Response:
    body = await request.json() if request.can_read_body else {}
    project = body.get("project") or "forge-app"
    bus: EventBus = request.app["bus"]
    asyncio.create_task(build.run(project, bus))
    return web.json_response({"ok": True, "project": project})


async def run_exec(request: web.Request) -> web.Response:
    body = await request.json()
    command = (body.get("command") or "").strip()
    if not command:
        return web.json_response({"error": "empty command"}, status=400)
    bus: EventBus = request.app["bus"]
    asyncio.create_task(request.app["runner"].run(command, bus))
    return web.json_response({"ok": True})


async def cancel_exec(request: web.Request) -> web.Response:
    return web.json_response({"ok": request.app["runner"].cancel()})


async def set_model(request: web.Request) -> web.Response:
    """Switching down to a cheaper model is the main lever against usage limits."""
    body = await request.json()
    session: ClaudeSession = request.app["session"]

    # Effort is the second axis, and it behaves differently from the model: the SDK reads it
    # once when the CLI subprocess spawns, so there is no live setter to call. Persisting it
    # is the whole implementation -- it takes hold the next time a session starts. Sent on
    # its own, so a caller can change one axis without restating the other.
    effort = (body.get("effort") or "").strip()
    if effort:
        if effort not in ("low", "medium", "high", "xhigh", "max"):
            return web.json_response({"error": "unknown effort"}, status=400)
        session.effort = effort
        config.save_effort(effort)
        session.bus.publish("effort_changed", effort=effort)

    model = (body.get("model") or "").strip()
    if model:
        if model not in ("opus", "sonnet", "haiku", "default"):
            return web.json_response({"error": "unknown model"}, status=400)
        await session.set_model(None if model == "default" else model)

    if not model and not effort:
        return web.json_response({"error": "nothing to set"}, status=400)

    chats = request.app.get("chats")
    if chats is not None:
        chats.note_manual_override(model=model or None, effort=effort or None)
    return web.json_response({"ok": True, "model": model, "effort": effort})


async def ui(request: web.Request) -> web.StreamResponse:
    rel = request.match_info.get("path") or "index.html"
    root = config.UI_DIR.resolve()
    target = (root / rel).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise web.HTTPNotFound()

    ctype, _ = mimetypes.guess_type(target.name)
    response = web.FileResponse(target, headers={
        "Content-Type": ctype or "application/octet-stream",
        "Cache-Control": "no-store",
    })
    if request.query.get("token"):
        response.set_cookie(COOKIE, request.app["token"], httponly=True,
                            samesite="Lax", max_age=60 * 60 * 24 * 365)
    return response


CHECK_JS = config.REPO / "tools" / "check_js.js"


async def _js_error(path: Path) -> str | None:
    """Returns a syntax error message, or None if the file parses.

    Claude edits this UI while the user is looking at it, so a broken file must not be
    reloaded into -- a blank screen removes the very means of asking for a fix.
    """
    if not CHECK_JS.exists():
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            "qjs", "--std", str(CHECK_JS), str(path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await proc.communicate()
    except (OSError, FileNotFoundError):
        return None  # No checker available; don't block reloads on its absence.
    return out.decode(errors="replace").strip() if proc.returncode else None


async def watch_ui(app: web.Application) -> None:
    """Hot edit: when a UI file settles, tell connected clients to reload.

    Polling rather than inotify because the tree is tiny and it keeps this feature
    dependency-free. Changes are debounced: a save burst would otherwise fire a reload per
    file and visibly flash the page several times in a row.
    """
    bus: EventBus = app["bus"]
    root = config.UI_DIR
    # Poll finely but demand a longer stretch of stillness: Claude rewriting several files
    # takes seconds, and a reload fired mid-sequence flashes the page and can even load a
    # half-written tree. 0.5s * 5 = 2.5s of quiet before anything reloads.
    poll_interval = 0.5
    quiet_required = 5

    def snapshot() -> dict[str, float]:
        return {str(p): p.stat().st_mtime for p in root.rglob("*") if p.is_file()}

    def diff(before: dict[str, float], after: dict[str, float]) -> set[str]:
        changed = set(before) ^ set(after)
        changed |= {p for p in after if p in before and after[p] != before[p]}
        return changed

    previous = snapshot()
    settling: set[str] = set()
    quiet_ticks = 0

    while True:
        await asyncio.sleep(poll_interval)
        try:
            current = snapshot()
        except OSError:
            continue

        if current != previous:
            settling |= diff(previous, current)
            previous = current
            quiet_ticks = 0
            continue

        if not settling:
            continue

        quiet_ticks += 1
        if quiet_ticks < quiet_required:
            continue

        changed, settling, quiet_ticks = settling, set(), 0
        try:
            await announce(app, changed)
        except Exception:
            # A crash here used to kill the watcher task silently -- asyncio discards the
            # exception when nothing awaits the task, so hot reload simply stopped working
            # with nothing in the log. Never again: log it and keep watching.
            log.exception("UI watcher failed to announce a change")


async def announce(app: web.Application, changed: set[str]) -> None:
    broken = []
    for raw in changed:
        path = Path(raw)
        if path.suffix == ".js" and path.is_file():
            err = await _js_error(path)
            if err:
                broken.append(f"{path.name}: {err}")

    names = sorted({Path(p).name for p in changed})[:10]
    if broken:
        # Hold the reload and report it, rather than replacing a working UI with a blank one.
        await publish_event(app, "ui_error", errors=broken, files=names)
    else:
        await publish_event(app, "ui_reload", files=names, at=time.time())


async def watch_backend(app: web.Application) -> None:
    """Hot edit for the half that cannot hot-edit: mark the session host for reload.

    Python caches modules at import, so a changed file under forged/ is invisible until the
    process restarts -- and that process owns the CLI subprocess, so restarting it mid-turn
    kills the turn. The conversation itself survives (session_id is persisted and resumed),
    which means the only real cost of a restart is its *timing*. So this does not restart
    anything: it tells the host a reload is wanted, and the host picks the moment.

    Only meaningful when split. In single-process mode the thing to restart is us, and a
    process that restarts itself on every edit to its own source is a crash loop.
    """
    if not SESSION_URL:
        return
    root = config.REPO / "forged"
    poll_interval, quiet_required = 0.5, 5

    def snapshot() -> dict[str, float]:
        return {str(p): p.stat().st_mtime for p in root.rglob("*.py") if p.is_file()}

    previous = snapshot()
    settling: set[str] = set()
    quiet_ticks = 0

    while True:
        await asyncio.sleep(poll_interval)
        try:
            current = snapshot()
        except OSError:
            continue
        if current != previous:
            settling |= set(previous) ^ set(current)
            settling |= {p for p in current if p in previous and current[p] != previous[p]}
            previous = current
            quiet_ticks = 0
            continue
        if not settling:
            continue
        quiet_ticks += 1
        if quiet_ticks < quiet_required:
            continue

        changed, settling, quiet_ticks = settling, set(), 0
        # A syntax error would restart the host into a process that cannot start. Same
        # reasoning as the JS check above: hold the reload and say so.
        broken = []
        for raw in sorted(changed):
            path = Path(raw)
            if not path.is_file():
                continue
            try:
                compile(path.read_text(), str(path), "exec")
            except SyntaxError as exc:
                broken.append(f"{path.name}: line {exc.lineno}: {exc.msg}")
            except OSError:
                pass
        if broken:
            await publish_event(app, "ui_error", errors=broken,
                                files=sorted({Path(p).name for p in changed}))
            continue

        try:
            import aiohttp
            timeout = aiohttp.ClientTimeout(total=5)
            async with aiohttp.ClientSession(timeout=timeout) as client:
                await client.post(SESSION_URL + "/reload",
                                  json={"files": sorted({Path(p).name for p in changed})})
        except Exception as exc:
            log.warning("could not request a session-host reload: %s", exc)


async def on_startup(app: web.Application) -> None:
    if app["session"] is not None:
        app["session"].start()
    app["watcher"] = asyncio.create_task(watch_ui(app))
    app["backend_watcher"] = asyncio.create_task(watch_backend(app))


async def on_cleanup(app: web.Application) -> None:
    app["watcher"].cancel()
    app["backend_watcher"].cancel()
    if app["session"] is not None:
        await app["session"].stop()


# Set to the session host's address to run split: this process keeps the public surface and
# forwards anything touching the conversation, so restarting it no longer kills a turn.
# Unset, everything runs in one process exactly as before.
SESSION_URL = os.environ.get("FORGE_SESSION_URL", "").rstrip("/")

# ---------------------------------------------------------------------------- cable
#
# The slow half of the cable app's adaptation loop. The app posts what happened and
# polls for the policy to run; a tuner reads the first and writes the second. Both are
# plain files on disk rather than daemon state, deliberately: the daemon is restarted
# often and is not the owner of any of this, and a file is something a human or an agent
# can read, diff and revert without going through an API.

CABLE_DIR = Path.home() / ".forge" / "cable"
CABLE_CONFIG = CABLE_DIR / "config.json"
CABLE_LOG = CABLE_DIR / "sessions.jsonl"
# The app drops telemetry rather than retrying, so a bounded log cannot be outrun; this
# only guards against a long-lived daemon slowly filling a small device's disk.
CABLE_LOG_MAX = 4 * 1024 * 1024


async def cable_config(request: web.Request) -> web.Response:
    """The live tuning policy. Absent file means the app keeps its compiled-in defaults."""
    try:
        if CABLE_CONFIG.exists():
            return web.Response(text=CABLE_CONFIG.read_text(),
                                content_type="application/json")
    except OSError as exc:
        log.warning("cable config unreadable: %s", exc)
    return web.json_response({"version": 0, "label": "built-in"})


CABLE_PLUGINS = CABLE_DIR / "plugins"
CABLE_CARDS = CABLE_DIR / "cards.json"
CABLE_ASK = CABLE_DIR / "ask.json"


async def cable_ask(request: web.Request) -> web.Response:
    """A theme typed on the phone, for the next batch.

    Only recorded here, never acted on: generation spends money and belongs to the
    process the user started, not to a daemon that happens to be running. The watcher
    picks this up, uses it, and clears it.
    """
    try:
        body = await request.json()
        about = str(body.get("about", ""))[:120].strip()
    except Exception:
        return web.json_response({"ok": False}, status=400)
    if not about:
        return web.json_response({"ok": False, "error": "empty"}, status=400)
    CABLE_DIR.mkdir(parents=True, exist_ok=True)
    CABLE_ASK.write_text(json.dumps({"about": about, "at": time.time()}) + "\n")
    log.info("cable ask: %s", about)
    return web.json_response({"ok": True, "about": about})



async def cable_cards(request: web.Request) -> web.Response:
    """The feed's content, as specs rather than media.

    Served whole rather than paged: a full queue is a few kilobytes, and the app holding
    all of it means a dead daemon costs nothing until the queue is actually exhausted.
    """
    try:
        if CABLE_CARDS.is_file():
            return web.Response(text=CABLE_CARDS.read_text(),
                                content_type="application/json")
    except OSError as exc:
        log.warning("cable cards unreadable: %s", exc)
    return web.json_response({"next_id": 1, "cards": []})



async def cable_plugins(request: web.Request) -> web.Response:
    """The list of loadable surfaces. Written by tools/build_plugin.sh, never by hand."""
    manifest = CABLE_PLUGINS / "manifest.json"
    try:
        if manifest.exists():
            return web.Response(text=manifest.read_text(), content_type="application/json")
    except OSError as exc:
        log.warning("cable plugin manifest unreadable: %s", exc)
    return web.json_response({"plugins": []})


async def cable_plugin(request: web.Request) -> web.Response:
    """One compiled plugin. Name is matched against the manifest rather than used as a
    path: this reads a file chosen by the caller, and the manifest is the allowlist."""
    name = request.match_info.get("name", "")
    manifest = CABLE_PLUGINS / "manifest.json"
    try:
        known = {p.get("name") for p in json.loads(manifest.read_text()).get("plugins", [])}
    except (OSError, ValueError):
        known = set()
    stem = name[:-4] if name.endswith(".dex") else name
    if stem not in known:
        return web.json_response({"error": "unknown plugin"}, status=404)
    path = CABLE_PLUGINS / (stem + ".dex")
    if not path.is_file():
        return web.json_response({"error": "not built"}, status=404)
    return web.Response(body=path.read_bytes(),
                        content_type="application/octet-stream")


async def cable_telemetry(request: web.Request) -> web.Response:
    """Append one batch of samples. Never rejects: a lost batch is worth less than a
    client that starts retrying into a daemon that is already unhappy."""
    try:
        body = await request.text()
        if len(body) > 512 * 1024:
            return web.json_response({"ok": False, "reason": "too large"}, status=413)
        CABLE_DIR.mkdir(parents=True, exist_ok=True)
        if CABLE_LOG.exists() and CABLE_LOG.stat().st_size > CABLE_LOG_MAX:
            CABLE_LOG.replace(CABLE_LOG.with_suffix(".jsonl.1"))
        line = json.dumps({"at": time.time(), "batch": json.loads(body)})
        with CABLE_LOG.open("a") as fh:
            fh.write(line + "\n")
    except Exception as exc:
        log.warning("cable telemetry rejected: %s", exc)
        return web.json_response({"ok": False}, status=400)
    return web.json_response({"ok": True})


# Routes whose state lives in the session host.
PROXIED = (
    ("GET", "/events"), ("GET", "/state"), ("GET", "/history"),
    ("POST", "/prompt"), ("POST", "/permission"), ("POST", "/turn/resolve"),
    ("POST", "/ask"), ("POST", "/interrupt"), ("POST", "/model"),
    # Registered in host.py since the session host owns the transcript, but the frontend
    # is what the phone talks to -- left out of this list it 404s, which looked like the
    # route was missing rather than merely unreachable.
    ("POST", "/compact"),
    ("GET", "/chats"), ("POST", "/chats/new"), ("POST", "/chats/{id}/switch"),
    ("DELETE", "/chats/{id}"), ("POST", "/chats/{id}/flag"),
)


async def publish_event(app: web.Application, kind: str, **data) -> None:
    """Raise an event on whichever bus the clients are actually listening to.

    Single process: the local bus. Split: the host's, because that is what /events serves --
    publishing locally would drop the event on the floor.
    """
    if not SESSION_URL:
        app["bus"].publish(kind, **data)
        return
    import aiohttp
    try:
        timeout = aiohttp.ClientTimeout(total=5)
        async with aiohttp.ClientSession(timeout=timeout) as client:
            await client.post(SESSION_URL + "/publish",
                              json={"kind": kind, "data": data})
    except Exception as exc:
        log.warning("could not publish %s to session host: %s", kind, exc)


def _proxy_handler(path: str):
    """Forward one route to the session host, streaming if the response is a stream."""
    async def handler(request: web.Request) -> web.StreamResponse:
        import aiohttp
        body = await request.read() if request.can_read_body else None
        # request.path, not the closed-over `path`: a route like /chats/{id}/switch has a
        # dynamic segment, and the actual incoming path is what the host needs to see.
        # Identical to `path` for every route that has no dynamic segment.
        target = request.path
        # No total timeout: /events is a long-lived stream by design.
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=5)
        try:
            async with aiohttp.ClientSession(timeout=timeout) as client:
                async with client.request(
                        request.method, SESSION_URL + target,
                        params=request.rel_url.query, data=body,
                        headers={"Content-Type": "application/json"}) as upstream:

                    ctype = upstream.headers.get("Content-Type", "")
                    if ctype.startswith("text/event-stream"):
                        out = web.StreamResponse(status=upstream.status, headers={
                            "Content-Type": "text/event-stream",
                            "Cache-Control": "no-cache",
                            "Connection": "keep-alive",
                            "X-Accel-Buffering": "no",
                        })
                        await out.prepare(request)
                        async for chunk in upstream.content.iter_any():
                            await out.write(chunk)
                        return out

                    payload = await upstream.read()
                    return web.Response(body=payload, status=upstream.status,
                                        content_type="application/json")
        except (ConnectionResetError, asyncio.CancelledError):
            raise
        except Exception as exc:
            # The host being down is the one failure the UI cannot diagnose on its own.
            log.warning("session host unreachable for %s: %s", path, exc)
            return web.json_response(
                {"error": "session host unavailable", "detail": str(exc)}, status=503)
    return handler


def create_app(cwd: str, model: str | None = None) -> web.Application:
    app = web.Application(middlewares=[auth_middleware])
    bus = EventBus(persist_path=config.STATE_DIR / "events.jsonl")
    app["bus"] = bus
    app["token"] = config.load_token()
    app["split"] = bool(SESSION_URL)
    # In split mode the real session lives in the host process; this one would only compete
    # for the same session id and outbox file.
    app["session"] = None if SESSION_URL else ClaudeSession(bus, cwd=cwd, model=model)
    app["pairing"] = Pairing()
    app["runner"] = Runner()

    if SESSION_URL:
        for method, path in PROXIED:
            app.router.add_route(method, path, _proxy_handler(path))

    routes = [
        web.get("/health", health),
        web.post("/pair", pair),
        web.post("/pair/new", new_pairing_code),
        web.post("/diag", diag),
        web.post("/uistate", uistate),
        web.get("/captures", captures),
        web.get("/cable/config", cable_config),
        web.post("/cable/telemetry", cable_telemetry),
        web.get("/cable/plugins", cable_plugins),
        web.get("/cable/cards", cable_cards),
        web.post("/cable/ask", cable_ask),
        web.get("/cable/plugin/{name}", cable_plugin),
        web.get("/commands", commands),
        web.post("/build", run_build),
        web.get("/screenshots", screenshots),
        web.get("/projects", projects),
        web.post("/exec", run_exec),
        web.post("/exec/cancel", cancel_exec),
        web.get("/media", media),
        web.get("/", ui),
        web.get("/ui/{path:.*}", ui),
    ]
    if not SESSION_URL:
        routes[2:2] = [
            web.get("/events", events),
            web.get("/state", state),
            web.post("/prompt", prompt),
            web.post("/permission", permission),
            web.post("/turn/resolve", resolve_turn),
            web.post("/ask", answer_ask),
            web.get("/history", history),
            web.post("/interrupt", interrupt),
            web.post("/compact", compact_session),
            web.post("/model", set_model),
        ]
    app.add_routes(routes)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app
