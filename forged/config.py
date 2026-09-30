"""Paths, identity and the auth token.

State is split by how much it needs to survive. Things the Android side must be able to read
while the VM is down live under /mnt/shared (which is /sdcard); everything else stays in the
VM's own home.
"""
from __future__ import annotations

import json
import os
import secrets
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent

# VM-local state.
STATE_DIR = Path(os.environ.get("FORGE_STATE_DIR", Path.home() / ".forge"))

# Readable from Android even with the VM down -- drafts, pending state, build output.
SHARED_DIR = Path(os.environ.get("FORGE_SHARED_DIR", "/mnt/shared/Download/forge"))

UI_DIR = REPO / "forge-ui"
APK_OUT = SHARED_DIR / "apk"

HOST = os.environ.get("FORGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("FORGE_PORT", "8787"))

# A nested `claude` inherits these and phones home to the parent harness instead of using our
# permission callback. Stripped at process level because ClaudeAgentOptions.env merges rather
# than replaces. Irrelevant under systemd, load-bearing when testing inside a Claude session.
LEAKY_PREFIXES = ("CLAUDE", "AI_AGENT", "COREPACK_ENABLE_AUTO_PIN")


def strip_inherited_env() -> list[str]:
    removed = [k for k in list(os.environ) if k.startswith(LEAKY_PREFIXES)]
    for k in removed:
        del os.environ[k]
    return removed


def ensure_dirs() -> None:
    for d in (STATE_DIR, SHARED_DIR, APK_OUT):
        d.mkdir(parents=True, exist_ok=True)
    STATE_DIR.chmod(0o700)


def load_token() -> str:
    """Stable across restarts so a paired app doesn't need re-pairing after a crash."""
    path = STATE_DIR / "token"
    if path.exists():
        return path.read_text().strip()
    token = secrets.token_urlsafe(24)
    path.write_text(token)
    path.chmod(0o600)
    return token


def load_model() -> str | None:
    path = STATE_DIR / "model"
    if not path.exists():
        return None
    value = path.read_text().strip()
    return value or None


def save_model(model: str | None) -> None:
    (STATE_DIR / "model").write_text(model or "")


def load_auto_approve() -> bool:
    """Auto-approve tool calls without prompting. Defaults to on.

    Deliberately handled inside the can_use_tool callback rather than by setting
    permission_mode="bypassPermissions": that mode stops the callback being invoked at all,
    which would also silence Forge's AskUserQuestion interception and make Claude's questions
    invisible again. Write "0" to this file to go back to being asked.
    """
    path = STATE_DIR / "auto_approve"
    if not path.exists():
        return True
    return path.read_text().strip() not in ("0", "false", "no", "")


def save_auto_approve(enabled: bool) -> None:
    (STATE_DIR / "auto_approve").write_text("1" if enabled else "0")


def load_effort() -> str:
    """How hard the model works per turn. Persisted because it is fixed at connect time."""
    path = STATE_DIR / "effort"
    if not path.exists():
        return "high"
    value = path.read_text().strip()
    return value if value in ("low", "medium", "high", "xhigh", "max") else "high"


def save_effort(effort: str) -> None:
    (STATE_DIR / "effort").write_text(effort)


def load_session_id() -> str | None:
    path = STATE_DIR / "session_id"
    return path.read_text().strip() if path.exists() else None


def save_session_id(session_id: str) -> None:
    (STATE_DIR / "session_id").write_text(session_id)


def load_profile() -> dict[str, Any] | None:
    """Load the operator's profile: their work context and preferences.

    Profile includes: GitHub handle, active projects, tech focus, device constraints,
    and critical operational rules. If profile exists, it's loaded into the session
    so Claude has context about the user without being told repeatedly.
    """
    path = STATE_DIR / "profile.json"
    if not path.exists():
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        print(f"Warning: could not load profile: {e}")
        return None
