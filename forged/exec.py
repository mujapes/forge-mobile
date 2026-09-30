"""Running a command directly, for the ~5% of the time natural language isn't the fast path.

Deliberately a command runner rather than a terminal emulator: no PTY, no ANSI parsing, no
vendored terminal library. `git status`, `ls`, `cat` all work; `vim` does not, and that is the
right trade for a surface this secondary.

Output is streamed as it arrives so a slow command shows progress rather than appearing hung.
"""
from __future__ import annotations

import asyncio
import time

from . import config
from .events import EventBus

MAX_LINES = 2000
TIMEOUT_SECONDS = 300


class Runner:
    """One command at a time -- concurrent shells on a 959MB VM invite the OOM killer."""

    def __init__(self) -> None:
        self.proc: asyncio.subprocess.Process | None = None

    @property
    def busy(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    async def run(self, command: str, bus: EventBus) -> None:
        if self.busy:
            bus.publish("exec_end", ok=False, error="a command is already running")
            return

        started = time.monotonic()
        bus.publish("exec_start", command=command)
        try:
            self.proc = await asyncio.create_subprocess_exec(
                "bash", "-lc", command,
                cwd=str(config.REPO),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        except OSError as exc:
            bus.publish("exec_end", ok=False, error=str(exc))
            return

        lines = 0
        try:
            async with asyncio.timeout(TIMEOUT_SECONDS):
                assert self.proc.stdout
                async for raw in self.proc.stdout:
                    lines += 1
                    if lines > MAX_LINES:
                        bus.publish("exec_log", line=f"… truncated after {MAX_LINES} lines")
                        break
                    bus.publish("exec_log", line=raw.decode(errors="replace").rstrip())
                code = await self.proc.wait()
        except TimeoutError:
            self.proc.kill()
            bus.publish("exec_end", ok=False, error=f"timed out after {TIMEOUT_SECONDS}s")
            return
        finally:
            proc, self.proc = self.proc, None
            if proc and proc.returncode is None:
                proc.kill()

        bus.publish("exec_end", ok=code == 0, code=code,
                    seconds=round(time.monotonic() - started, 1))

    def cancel(self) -> bool:
        if not self.busy:
            return False
        assert self.proc
        self.proc.kill()
        return True
