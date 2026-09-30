#!/bin/bash
# Start the Forge daemon so the phone can reach it.
#
# Binds all interfaces: the Android side connects over the VM's LAN address, not loopback.
# Access is gated by the token, which the app obtains once via the printed pairing code.

cd "$(dirname "$0")"

IP=$(ip -4 -brief addr show enp0s13 2>/dev/null | awk '{print $3}' | cut -d/ -f1)
echo "VM address: ${IP:-unknown}"

exec env FORGE_HOST=0.0.0.0 FORGE_PORT="${FORGE_PORT:-8787}" \
    .venv/bin/python -m forged --cwd "$PWD" "$@"
