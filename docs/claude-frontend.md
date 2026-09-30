# The Claude frontend: a UI that evolves while you are using it

The goal, in one sentence: **an interface the model can change mid-conversation, without the
conversation being interrupted to do it.** Everything below is downstream of that.

"Clone the Claude app UI in a hot-reload webview" and "embed a Linux filesystem in the app"
sound like two projects. They are one. A UI can only be edited live if its source is on a
writable filesystem the model can reach, *and* the running page can take the edit without
losing state. Either half alone gives nothing: a writable filesystem with a reloading page
costs you the transcript on every tweak, and a clean-reloading page with read-only assets has
nothing to reload.

## What already exists (do not rebuild this)

Forge is already most of the stack, which was not obvious until the code was read:

- `forged/` — daemon, SSE event bus, persisted event log, session resume, per-chat subprocesses.
- `forge-app/` — the Android shell: a `WebView`, a foreground service that keeps the stream
  alive while backgrounded, notifications, captures, APK installs, `/diag` self-reporting.
- `forged/server.py` — a UI file watcher that syntax-checks any changed `.js` **before**
  announcing it, and publishes `ui_error` instead of `ui_reload` when an edit would break the
  page. A broken edit therefore cannot replace a working UI with a blank one.
- `forge-ui/app.js` — `swapStyles()`, which repaints CSS in place with zero state loss, plus
  draft restore, a held-until-idle reload, and a whitelist so unrelated JSON drops in
  `forge-ui/` stop nuking the composer.

The code even names the one remaining gap itself:

> *A full reload was only ever needed because JS cannot be replaced live.*

## The reload ladder

The design principle: **push every change down to the cheapest rung that can carry it.** Rungs
1 and 2 are free — they cost no reload, lose nothing, and are safe mid-turn.

| rung | changing | cost | what survives |
|---|---|---|---|
| 1. `style.css` | colour, spacing, type, layout | `swapStyles()` — a `<link>` swap | everything |
| 2. `render.js` | markup, markdown, bubble and card shape | `swapRender()` — a `<script>` re-eval | everything; new messages get new markup |
| 3. `app.js` / `index.html` | state, listeners, gestures, streaming | page reload, held until idle | draft and scroll are restored; live turn output is not |
| 4. `forged/` | the daemon itself | process restart, held until idle | the conversation (session resume); the socket drops for ~2s |

Rung 2 is the new one. `render.js` is a classic script assigning `window.FR`, and `app.js`
reaches it through hoisted forwarder functions, so **every call site is unchanged** —
`md(x)` still means `md(x)`.

Two rules keep rung 2 safe, and both are load-bearing:

- **`render.js` holds pure functions only.** Text in, HTML string out. No state, no listeners,
  no DOM refs, no timers. A pure function has nothing to tear down, so a swap cannot orphan a
  node or leave a half-dead handler. The worst a bad edit can do is render the *next* message
  wrongly.
- **`app.js` keeps a fallback.** `render.js` is a separate fetch, so it can 404 mid-edit. With
  no fallback the transcript would render as nothing and the page would look dead rather than
  degraded. Escaped plain text is a poor renderer but a legible one.

Why a classic script and not an ES module: a module needs `await import()`, so the binding does
not exist until boot's first await — and `boot()` in `app.js` already carries a comment about a
`let` declared further down the file sitting in its temporal dead zone. That hazard is real in
this file. A plain `<script>` before `app.js` is evaluated synchronously and sidesteps it.

**Not yet done:** a swap does not re-render messages already on screen. Those need their source
events, and the windowing deliberately keeps those on the daemon rather than in the page. So a
restyle currently appears from the next message down. Re-rendering the resident window is the
obvious phase 2.

## Cloning the Claude app UI

Good news that falls out of the ladder: **most of this is rung 1 and 2, so it is already free.**
Colour, type, spacing, bubble shape, code-block chrome, the composer — CSS and `render.js`.

The parts that are genuinely structural, and therefore rung 3:

- message grouping and turn boundaries
- the artifact / side-panel pattern
- model and mode pickers
- attachment handling

So sequence it: restyle first (free, visible immediately, reversible), structure second.

## The Linux filesystem backend

### Why it is worth it

1. **The filesystem is the memory hierarchy.** Chat is ephemeral; files are not. Notes, drafts,
   plans and generated code survive the context window, and retrieval becomes `grep` rather
   than embeddings. This is the cheapest real memory available, and this repo already runs on
   it — `docs/` *is* the long-term memory of the project.
2. **Capability surface becomes the package manager, not the roadmap.** `ffmpeg`, `git`,
   `pdftotext`, `chromium --headless` are features you do not have to write. `tools/shot` and
   `tools/meme` exist only because that was true.
3. **Meta-adaptation, which is the actual prize.** Writable UI source + state-preserving reload
   = "the send button is too small" → the model edits `style.css` → it changes under your
   finger, conversation intact. The interface stops being a thing shipped *to* the user and
   becomes a thing negotiated *with* them. Neither half delivers this alone.
4. **Self-instrumentation.** The model can read its own logs, its own transcripts, its own past
   decisions. `journalctl -u forge | grep "client diag"` has already turned a vague bug report
   into an exact stack frame without a screenshot.

### The finding that decides the architecture

**A sideloaded app cannot create its own VM.** `MANAGE_VIRTUAL_MACHINE` is restricted to
privileged/platform apps — in Android 14 it was privileged-only, and AVF is documented as being
for privileged and platform developers. So "hand-roll a Linux VM that is smaller and wider than
the native Terminal" is not blocked by effort or ambition; it is blocked by a permission we
cannot hold. Worth one `/diag` round trip to confirm on this device before treating as final,
but plan around it.

That leaves three real options, and they are not interchangeable:

| approach | exec | size | cost |
|---|---|---|---|
| bundled static binaries in the APK's `lib/` dir | allowed (ships inside the APK) | small — a few MB per tool | no `apt`, no distro, hand-picked tools |
| proot / Termux-style rootfs in app storage | **blocked** for modern `targetSdk` (unverified — check before depending on it); Termux's low `targetSdk` is downstream of exactly this | tens to hundreds of MB | syscall emulation, pinned `targetSdk`, no Play |
| the device's native Linux Terminal (AVF) | real kernel, real `exec`, `apt` works | zero download — already on the device | manual setup flow; ~1GB RAM; **Android reclaims it** |

That last cost is not theoretical. This VM has been killed by Android to free memory for a
foreground app, and the outage ran 37 minutes — not because recovery is slow (3 seconds) but
because nothing announced it. See CLAUDE.md.

### The recommended shape: tier it

Mirrors the sonnet/opus rule already in CLAUDE.md — rest low, escalate deliberately.

- **Tier 0 — API direct.** Plain chat against the Anthropic API. No Linux, no setup, works on
  any device, tiny download. This is the "simple version of the app."
- **Tier 1 — bundled tools.** A real scratchpad filesystem in app storage plus a handful of
  static binaries in the APK's native lib dir. Buys files, `git`, `ffmpeg` without a distro.
- **Tier 2 — Claude Code CLI via the native Terminal.** Guided setup, then full agentic
  capability. This is Forge today.

Tier 0 must be genuinely useful on its own, because Tier 2 asks the user to install a Terminal
and run commands, and most people will not. And per CLAUDE.md's sideload rule: the restricted
path is the *upgrade*, never the requirement. Tier 2 must never become load-bearing for Tier 0.

## Sources

- [AVF framework API README](https://android.googlesource.com/platform/packages/modules/Virtualization/+/refs/tags/aml_net_351410000/libs/framework-virtualization/README.md)
- [AVF overview](https://source.android.com/docs/core/virtualization)
- [Virtual Machines as a core Android Primitive](https://android-developers.googleblog.com/2023/12/virtual-machines-as-core-android-primitive.html)
- [`<permission>` protection levels](https://developer.android.com/guide/topics/manifest/permission-element)
