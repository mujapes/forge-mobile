#!/bin/bash
# Start the Forge session host: the half that owns the conversation.
#
# Loopback only. The public surface is run.sh, which proxies here -- so that one can be
# restarted freely without costing the user an in-flight turn.
cd "$(dirname "$0")"
exec env PYTHONUNBUFFERED=1 .venv/bin/python -m forged.host --cwd "$PWD" "$@"
