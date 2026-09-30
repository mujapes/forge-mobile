"""APK builds, streamed to the UI line by line.

Output goes to /mnt/shared, which is /sdcard, so the finished APK is immediately visible to
Android's package installer without any transfer step.
"""
from __future__ import annotations

import asyncio
import time
from pathlib import Path

from . import config
from .events import EventBus

SCRIPT = config.REPO / "forged" / "build_apk.sh"


async def run(project: str, bus: EventBus) -> None:
    project_dir = (config.REPO / project).resolve()
    if not project_dir.is_relative_to(config.REPO) or not project_dir.is_dir():
        bus.publish("build_end", ok=False, error=f"no such project: {project}")
        return

    config.APK_OUT.mkdir(parents=True, exist_ok=True)
    out = config.APK_OUT / f"{project_dir.name}.apk"
    started = time.monotonic()
    bus.publish("build_start", project=project, output=str(out))

    proc = await asyncio.create_subprocess_exec(
        "bash", str(SCRIPT), str(project_dir), str(out),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    assert proc.stdout
    async for raw in proc.stdout:
        bus.publish("build_log", line=raw.decode(errors="replace").rstrip())
    code = await proc.wait()

    bus.publish("build_end",
                ok=code == 0,
                apk=str(out) if code == 0 and out.exists() else None,
                android_path=_android_path(out) if code == 0 else None,
                seconds=round(time.monotonic() - started, 1))


def _android_path(path: Path) -> str:
    """/mnt/shared is the VM's view of /sdcard; the app needs the Android-side path."""
    return str(path).replace("/mnt/shared", "/sdcard", 1)
