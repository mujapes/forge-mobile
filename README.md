# Forge

**A Claude Code client that runs on your phone, with an interface that can rewrite itself
while you are using it.**

Forge is a daemon plus a web UI plus a thin Android shell. The daemon runs inside Android's
Linux Terminal (a real Debian VM on the device), drives the Claude Agent SDK, and serves a
single-page UI over the local network. The Android app is a `WebView` with a foreground service,
notifications and screen capture attached. Everything is on the phone; nothing but the model
traffic leaves it.

The thing that makes it different from a chat client is the last sentence of the tagline. The
UI's source sits on a writable filesystem that the model can reach, and the running page can
take an edit to that source **without reloading** — so "this button is too small" becomes a
change you watch happen, mid-conversation, with the transcript and your half-typed message
still there. The interface stops being something shipped to you and becomes something you
negotiate with.

## The reload ladder

This is the core design idea, and the rule is: **push every change down to the cheapest rung
that can carry it.** Rungs 1 and 2 cost nothing and are safe in the middle of a running turn.

| rung | changing | cost | what survives |
|---|---|---|---|
| 1. `style.css` | colour, spacing, type, layout | a `<link>` swap | everything |
| 2. `render.js` | markup, markdown, message and tool-card shape | a `<script>` re-eval | everything; new messages get the new markup |
| 3. `app.js`, `index.html` | state, listeners, gestures, streaming | page reload, held until idle | draft and scroll are restored; live turn output is not |
| 4. `forged/` | the daemon | process restart, held until idle | the conversation (session resume); the socket drops ~2s |

A file watcher in `forged/server.py` notices the edit, **syntax-checks any changed `.js` before
announcing it**, and publishes `ui_error` instead of `ui_reload` if the edit would break the
page — so a bad edit cannot replace a working UI with a blank rectangle. Rungs 3 and 4 wait for
the session to go idle rather than interrupting a turn.

Two rules keep rung 2 safe, and both are load-bearing:

- **`render.js` contains pure functions only.** Text in, HTML string out. No state, no
  listeners, no DOM references, no timers. A pure function has nothing to tear down, so
  swapping it cannot orphan a node or strand a half-dead handler.
- **`app.js` keeps a fallback renderer.** `render.js` is a separate fetch and can 404 mid-edit.
  Escaped plain text is a poor renderer but a legible one, so a broken edit degrades the UI
  instead of emptying it.

`docs/claude-frontend.md` has the longer version, including why `render.js` is a classic script
rather than an ES module.

## What's in here

```
forged/       the daemon: HTTP + SSE, event log, sessions, chats, router, APK builds
forge-ui/     the interface: index.html, app.js, render.js, style.css
forge-app/    the Android shell: WebView, foreground service, notifications, captures
tools/        gen_app_config.py — bakes host + token into the APK's resources
docs/         design notes
```

Notable pieces, for anyone reading the source:

- **`forged/events.py`** — every event is appended to a log on disk, so a page reload (or the
  VM being killed) replays history rather than losing it.
- **`forged/chats.py`** — independent conversations, each with its own model and history. Only
  one subprocess is live at a time; the VM has under 1 GB of RAM. A new chat classifies its
  first message with a cheap model call to pick a model, because a fresh chat has no transcript
  to reprocess — see `docs/forge-optimization.md` on why mid-conversation model switching is
  expensive.
- **`forged/outbox.py`** — an interrupted turn is preserved rather than lost.
- **`forge-ui/app.js`** — the transcript is windowed, so a long conversation stays responsive on
  a phone; the on-screen keyboard is drawn *in the page* so that it hot-reloads too.
- **`forge-app/.../MainActivity.java`** — a JS bridge that lets the hot-reloading UI launch
  intents, post notifications and read media, so new capabilities usually need no rebuild.

## Requirements

- An Android device running the **Linux Terminal** (Android 15+ on supported hardware), or any
  Linux box on the same network.
- Python 3.11+, `aiohttp`, and the Claude Agent SDK, plus a Claude subscription or API key.
- For building the APK: `aapt2`, a JDK, `d8.jar`, and `framework-res.apk`. Paths are
  environment-overridable in `forged/build_apk.sh` — it deliberately avoids Gradle, because the
  device is arm64 and the usual SDK binaries are not.

## Running it

```sh
python3 -m venv .venv && .venv/bin/pip install aiohttp claude-agent-sdk
./run.sh                       # prints the VM's LAN address; serves on :8787
```

Open `http://<address>:8787` in a browser, or install the APK and pair it. The unit files
(`forge.service`, `forge-session.service`) are examples — edit the paths in them for your
layout.

## Security, and please read this part

**The daemon executes arbitrary commands.** That is what a Claude Code client is. So:

- Access is gated by a token, exchanged once via a short-lived pairing code. Treat that token
  as equivalent to shell access.
- `tools/gen_app_config.py` bakes the host and token into `forge-app/res/values/config.xml`.
  **That file is gitignored and must stay that way.**
- `run.sh` binds `0.0.0.0` because the Android side connects over the VM's LAN address rather
  than loopback. On an untrusted network, don't.
- There is no TLS. This is designed for a phone talking to a VM on the same device, where the
  traffic never reaches a radio.

## Status

Working and used daily, but shaped by one person's phone rather than by a release process.

**This repository is a published checkpoint, not a live mirror.** Development happens in a
private tree and lands here when a milestone is worth showing, so the history is a series of
snapshots rather than a commit-by-commit record. That means `main` is always a state that ran,
but it may be behind, and a fast-forward can cover a lot of ground at once.

Known rough edges:

- A rung-2 swap does not re-render messages already on screen; a restyle appears from the next
  message down. The source events for the resident window live on the daemon, not in the page.
- `forged/server.py` carries some routes for sibling apps that are not in this repository. They
  are unused here.
- No tests to speak of. The verification that exists is a file watcher's syntax check and a
  client that reports its own JS exceptions back to the daemon log.

## Licence

0BSD — no conditions at all, not even attribution. See `LICENSE`.
