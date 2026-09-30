"""Session host: the half that must not be restarted.

The daemon used to be one process owning both the HTTP surface and the Claude session. The
session's CLI runs as a child of that process, so restarting to pick up a change in a request
handler also killed the conversation -- every backend edit cost the user their in-flight turn,
truncated mid-sentence.

This process owns only the durable half: the event bus, the outbox, and the session itself. It
listens on loopback and never needs restarting for a change to the web layer. `server.py` runs
separately and proxies to it, so restarting *that* costs nothing.

Handlers are imported from `server` rather than reimplemented -- same code, different app, so
the two halves cannot drift apart.

Run:  python -m forged.host --cwd /home/droid/forge
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import time

from aiohttp import web

from . import config

config.strip_inherited_env()

from . import server as S  # noqa: E402  (must follow the env strip)
from .chats import ChatManager  # noqa: E402

log = logging.getLogger("forged.host")

# Loopback only. Auth lives in the public layer; nothing off-device can reach this.
HOST_BIND = "127.0.0.1"
HOST_PORT = int(os.environ.get("FORGE_SESSION_PORT", "8788"))


async def _publish(request: web.Request) -> web.Response:
    """Publish an event raised by the web layer onto the session bus."""
    body = await request.json()
    kind = body.get("kind")
    if not kind:
        return web.json_response({"error": "missing kind"}, status=400)
    request.app["bus"].publish(kind, **(body.get("data") or {}))
    return web.json_response({"ok": True})


async def _prompt(request: web.Request) -> web.Response:
    """Classify and start a fresh chat's subprocess before its first turn goes in.

    A no-op for a chat already running -- ensure_started checks that first -- so this
    costs nothing on every subsequent message.
    """
    body = await request.json()
    text = (body.get("text") or "").strip()
    if text:
        await request.app["chats"].ensure_started(text)
    return await S.prompt(request)   # re-parses the same (cached) body; not a second read


async def request_reload(request: web.Request) -> web.Response:
    """Mark the host for restart. The host chooses when; see _reload_when_idle."""
    body = await request.json() if request.can_read_body else {}
    request.app["reload_files"] = (body or {}).get("files") or []
    request.app["reload_pending"] = True
    log.info("reload requested for %s", request.app["reload_files"])
    return web.json_response({"ok": True})


async def _reload_when_idle(app: web.Application) -> None:
    """Restart this process at the next natural gap, not the moment code changed.

    A restart costs nothing but its timing. The conversation is resumed from the persisted
    session_id, so an idle restart is invisible; a mid-turn one truncates a reply. So the
    rule is simply: wait for the gap.

    Two consecutive idle checks, not one, because the instant between a turn finishing and
    a queued follow-up starting also reads as idle.
    """
    idle_ticks = 0
    while True:
        await asyncio.sleep(1.0)
        if not app.get("reload_pending"):
            idle_ticks = 0
            continue

        session = app.get("session")
        busy = session is None or session.busy or not session.idle_for_reload()
        if busy:
            idle_ticks = 0
            continue
        idle_ticks += 1
        if idle_ticks < 2:
            continue

        app["reload_pending"] = False
        log.info("applying backend reload now that the session is idle")
        # Tell the clients first: the UI holds its send button for the couple of seconds
        # the socket is down, which is the whole difference between "seamless" and "my
        # message vanished".
        app["bus"].publish("backend_reloading", files=app.get("reload_files") or [])
        await asyncio.sleep(1.0)
        try:
            proc = await asyncio.create_subprocess_exec(
                "sudo", "-n", "systemd-run", "--on-active=1",
                f"--unit=forge-hotreload-{int(time.time())}", "--collect",
                "systemctl", "restart", "forge-session",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            _, err = await proc.communicate()
            if proc.returncode != 0:
                log.error("could not schedule restart: %s", err.decode()[:200])
        except Exception:
            log.exception("could not schedule restart")


async def list_chats(request: web.Request) -> web.Response:
    chats = request.app["chats"]
    # Decay runs on read rather than on a timer: the list is the only place it is observable,
    # and a background task that archives things while nobody is looking is harder to trust
    # and no more correct.
    chats.decay()
    items = chats.list_public()

    q = (request.query.get("q") or "").strip().lower()
    if q:
        # Search is the archive's interface, so searching necessarily includes archived
        # chats -- excluding them would make archiving equivalent to deleting.
        items = [c for c in items
                 if q in (c.get("title") or "").lower()
                 or q in (c.get("preview") or "").lower()]
    elif request.query.get("archived") == "1":
        # Only the archived ones. Returning everything made "Archived" a superset of
        # "Recents", so the two filters differed by what they added rather than by what they
        # showed -- and the chat you went looking for was buried under the ones you had just
        # put away.
        items = [c for c in items if c.get("archived")]
    else:
        items = [c for c in items if not c.get("archived")]

    # Never materialise the whole archive. Browsing thousands of rows is useless to a reader
    # and expensive to everyone -- the JSON, the DOM nodes and their listeners all scale with
    # it. The archive's interface is search; this page exists so that "show me the recent
    # ones" stays possible, not so the list can be walked to the end.
    total = len(items)
    try:
        limit = min(int(request.query.get("limit", 50)), 200)
        offset = max(int(request.query.get("offset", 0)), 0)
    except ValueError:
        limit, offset = 50, 0
    page = items[offset:offset + limit]

    return web.json_response({
        "items": page,
        "total": total,
        "has_more": offset + len(page) < total,
        "next_offset": offset + len(page),
        "duplicates": chats.duplicates() if not q and not offset else [],
        "archived_count": sum(1 for c in chats.index["chats"] if c.get("archived")),
    })


async def flag_chat(request: web.Request) -> web.Response:
    body = await request.json()
    try:
        meta = request.app["chats"].set_flag(
            request.match_info["id"],
            pinned=body.get("pinned"), archived=body.get("archived"))
    except KeyError:
        return web.json_response({"error": "no such chat"}, status=404)
    return web.json_response({"ok": True, "pinned": meta.get("pinned"),
                              "archived": meta.get("archived")})


async def new_chat(request: web.Request) -> web.Response:
    meta = request.app["chats"].create()
    await request.app["chats"].switch(meta["id"])
    return web.json_response(meta)


async def delete_chat(request: web.Request) -> web.Response:
    chat_id = request.match_info["id"]
    try:
        await request.app["chats"].delete(chat_id)
    except KeyError:
        return web.json_response({"error": "no such chat"}, status=404)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response({"ok": True})


async def switch_chat(request: web.Request) -> web.Response:
    chat_id = request.match_info["id"]
    try:
        await request.app["chats"].switch(chat_id)
    except KeyError:
        return web.json_response({"error": "no such chat"}, status=404)
    return web.json_response({"ok": True})


def create_host_app(cwd: str, model: str | None = None) -> web.Application:
    # No auth middleware: this socket is loopback-only and the public layer already
    # authenticated whoever is proxying to it.
    app = web.Application()
    # ChatManager sets app["bus"] / app["session"] itself, pointed at whichever chat is
    # active -- every handler below reads those two keys and needs no chat-awareness at all.
    app["chats"] = ChatManager(app, cwd=cwd)

    # Exactly the routes that touch session or bus state. Everything else -- static files,
    # builds, shell, media -- stays in the web layer, where losing it on restart costs nothing.
    app.add_routes([
        web.get("/health", S.health),
        web.get("/events", S.events),
        web.get("/state", S.state),
        web.post("/prompt", _prompt),
        web.post("/permission", S.permission),
        web.post("/turn/resolve", S.resolve_turn),
        web.post("/ask", S.answer_ask),
        web.get("/history", S.history),
        web.post("/interrupt", S.interrupt),
        # Registered here as well as in server, because this is the half that owns the
        # conversation and so the only half that can restart it. Adding it only to
        # server's table left it 404ing from both ports: the front proxied it correctly
        # and the session host had never heard of it.
        web.post("/compact", S.compact_session),
        web.post("/model", S.set_model),
        # The UI watcher lives in the web process but its events must reach the clients,
        # who subscribe to *this* bus. Without this, hot reload silently stops working.
        web.post("/publish", _publish),
        web.get("/chats", list_chats),
        web.post("/chats/new", new_chat),
        web.post("/chats/{id}/switch", switch_chat),
        web.delete("/chats/{id}", delete_chat),
        web.post("/chats/{id}/flag", flag_chat),
        web.post("/reload", request_reload),
    ])

    async def start(a: web.Application) -> None:
        await a["chats"].start_active()
        a["reload_pending"] = False
        a["reloader"] = asyncio.create_task(_reload_when_idle(a))

    async def stop(a: web.Application) -> None:
        a["reloader"].cancel()
        await a["session"].stop()

    app.on_startup.append(start)
    app.on_cleanup.append(stop)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(prog="forged.host")
    parser.add_argument("--cwd", default=str(config.REPO))
    parser.add_argument("--model", default=None)
    parser.add_argument("--port", type=int, default=HOST_PORT)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config.ensure_dirs()

    app = create_host_app(cwd=args.cwd, model=args.model)
    print(f"\n  Forge session host on http://{HOST_BIND}:{args.port} (loopback only)\n")
    web.run_app(app, host=HOST_BIND, port=args.port, print=None, shutdown_timeout=2)


if __name__ == "__main__":
    main()
