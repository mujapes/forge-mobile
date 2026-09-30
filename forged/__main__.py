"""Entry point. Strips inherited Claude env before anything spawns a child."""
from __future__ import annotations

import argparse
import logging

from aiohttp import web

from . import config

config.strip_inherited_env()

from .server import create_app  # noqa: E402  (must follow the env strip)


def main() -> None:
    parser = argparse.ArgumentParser(prog="forged")
    parser.add_argument("--host", default=config.HOST)
    parser.add_argument("--port", type=int, default=config.PORT)
    parser.add_argument("--cwd", default=str(config.REPO))
    parser.add_argument("--model", default=None)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config.ensure_dirs()

    app = create_app(cwd=args.cwd, model=args.model)

    print(f"\n  Forge daemon on http://{args.host}:{args.port}")
    print(f"  Browser:      http://{args.host}:{args.port}/?token={app['token']}")
    print(f"  Pairing code: {app['pairing'].code}   (valid 10 minutes)\n")

    # /events is a long-lived stream, and aiohttp's default shutdown waits 60s for open
    # connections to drain -- so restarting the web layer, which is supposed to be the
    # free half of the split, took minutes with a browser attached. The client reconnects
    # with Last-Event-ID and misses nothing, so cutting the stream costs nothing at all.
    web.run_app(app, host=args.host, port=args.port, print=None, shutdown_timeout=2)


if __name__ == "__main__":
    main()
