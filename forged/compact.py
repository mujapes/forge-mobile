"""Summarise a conversation so the session can be restarted without losing the thread.

Forge has needed this for a long time and did not have it. The CLI's REPL owns /compact, and
Forge does not run the REPL -- it drives the Agent SDK, which exposes forty eight options and
none of them are compaction. So the only lever was /clear, which throws the thread away, and
the practical consequence was watching a long session cost half a usage window per turn with
no way out that kept continuity.

The trick is the same one the REPL uses: replace the transcript with a summary and carry on.
Every turn re-uploads the whole conversation, so the cost of a turn is roughly the size of
the transcript times the number of tool calls in it. Cutting the transcript to a page cuts
every subsequent turn in proportion.

The summary is produced by a separate cheap call rather than by asking the session to
summarise itself. Two reasons, and the second is the important one:

  it costs almost nothing -- haiku, an empty working directory, no tools, no system prompt
  it does not need the answer plumbed back out of a fire-and-forget event stream

Tool results are deliberately excluded. They are the bulk of a transcript and almost none of
their value survives a turn: a build log, a file dump, a directory listing. What matters is
what was asked, what was decided, and what is true now -- and the last of those is better
read from the repository than from a memory of reading it.
"""
from __future__ import annotations

import json
import logging
import os
import pathlib
import subprocess
import tempfile

log = logging.getLogger("forged.compact")

CLAUDE = pathlib.Path.home() / ".local" / "bin" / "claude"

# How much transcript to feed the summariser. Beyond this the oldest material is dropped,
# because a summary of a summary of the beginning is worth less than detail about the end.
MAX_CHARS = 60_000

SYSTEM = ("You write handover notes. Output only the note. No preamble, no sign-off, "
          "no offer to help.")

PROMPT = """Below is a working session between a person and an engineering agent.

Write a handover note so the agent can continue with no other memory of it. Be specific:
names, file paths, decisions and the reasons behind them. Prefer what is still true over
what merely happened.

Cover, in this order and only where there is something to say:

1. WHAT WE ARE BUILDING  one short paragraph
2. STATE  what exists and works right now
3. DECISIONS  choices made and why, especially ones that look arbitrary without the reason
4. OPEN  what was in progress, what is unresolved, what the person last asked for
5. GOTCHAS  things already got wrong once, so they are not got wrong again

Be dense. No filler. Under 700 words.

--- SESSION ---
{body}
--- END ---"""


def transcript(events_path: pathlib.Path, max_chars: int = MAX_CHARS) -> str:
    """The conversation without the machinery.

    Tool calls and their results are skipped entirely. They dominate the byte count and are
    the least useful thing to carry forward -- the repository is a better record of what a
    file contains than a transcript of having read it.
    """
    if not events_path.is_file():
        return ""
    out: list[str] = []
    for line in events_path.read_text(errors="replace").splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        kind = e.get("kind")
        data = e.get("data") or e
        if kind == "user_message":
            text = (data.get("text") or "").strip()
            if text:
                out.append("USER: " + text)
        elif kind == "text":
            text = (data.get("text") or "").strip()
            if text:
                out.append("AGENT: " + text)
        elif kind == "tool_use":
            # One line, so the shape of the work survives without its bulk.
            name = data.get("name") or data.get("tool") or "tool"
            out.append(f"[{name}]")
    body = "\n".join(out)
    if len(body) > max_chars:
        body = "...earlier conversation omitted...\n" + body[-max_chars:]
    return body


def summarise(events_path: pathlib.Path, model: str = "haiku",
              timeout: int = 180) -> str | None:
    """Produce the handover note, or None if it could not be produced.

    Never raises. A failed compaction must leave the session exactly as it was: the caller
    only drops the transcript once there is something to replace it with.
    """
    body = transcript(events_path)
    if len(body) < 400:
        return None
    if not CLAUDE.exists():
        log.warning("compact: no claude binary at %s", CLAUDE)
        return None

    with tempfile.TemporaryDirectory() as tmp:
        cmd = [str(CLAUDE), "-p", PROMPT.format(body=body), "--model", model,
               "--output-format", "json",
               "--system-prompt", SYSTEM,
               "--exclude-dynamic-system-prompt-sections",
               "--effort", "low",
               "--strict-mcp-config",
               "--disallowed-tools",
               "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task"]
        try:
            r = subprocess.run(cmd, cwd=tmp, env=dict(os.environ),
                               capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            log.warning("compact: summariser timed out")
            return None

    if r.returncode != 0:
        log.warning("compact: summariser exited %s: %s", r.returncode, r.stderr[-300:])
        return None
    try:
        text = json.loads(r.stdout).get("result", "")
    except ValueError:
        text = r.stdout
    text = (text or "").strip()
    return text or None


def seed(summary: str) -> str:
    """The first message of the fresh session.

    Framed as context rather than as an instruction, and explicitly tells the agent not to
    act on it. Without that the handover note reads as a list of jobs and the first thing a
    compaction does is start redoing the work it was meant to preserve.
    """
    return (
        "This session was compacted to save context. Everything before this point is gone; "
        "what follows is the handover note from it.\n\n"
        "Do not act on it. Acknowledge in one line and wait.\n\n"
        "--- HANDOVER ---\n" + summary + "\n--- END ---"
    )
