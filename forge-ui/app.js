/* Forge UI.
 *
 * Holds no authoritative state: everything needed to redraw comes from the daemon on
 * reconnect. That is what makes a backend crash a visual blip rather than lost work.
 */
'use strict';

const feed = document.getElementById('feed');
const pending = document.getElementById('pending');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const dot = document.getElementById('dot');
const gaugeFill = document.getElementById('gauge5h');
const gaugeLabel = document.getElementById('gaugeLabel');
const gauge = document.getElementById('gauge');
const sheet = document.getElementById('sheet');
const shots = document.getElementById('shots');
const caps = document.getElementById('caps');
const attachedBar = document.getElementById('attached');
const sheetTitle = document.getElementById('sheetTitle');
const list = document.getElementById('list');
const titleBtn = document.getElementById('title');
const backdrop = document.getElementById('backdrop');
const shell = document.getElementById('shell');
const shellOut = document.getElementById('shellOut').firstElementChild;
const shellIn = document.getElementById('shellIn');
const activity = document.getElementById('activity');
const activityText = document.getElementById('activityText');
const activityTime = document.getElementById('activityTime');

let attachments = [];  // absolute paths Claude will read
let queuedSends = [];
let currentModel = '';
let currentEffort = '';
/* True between creating a chat and sending its first message. In that window a model or
   effort pick is a *preset*: the subprocess has not spawned, so both apply cleanly and
   the pick suppresses the haiku classification instead of racing it. */
let presetMode = false;
let currentChatId = null;
let chosenModel = '';

let lastEventId = 0;
const COLD_REPLAY = 800;   // replayed on a cold load; most land straight in the attic
let source = null;
let retryDelay = 1000;
let reconnectNotice = null;   // pending 'Reconnecting…' banner, cancelled if we beat it
const loadedAt = Date.now();
let current = null;      // in-flight assistant bubble
let currentText = '';
let renderQueued = false;
let lastHtml = '';
let builds = new Map();  // project -> card element

/* Activity strip. The elapsed counter is the point: a static label cannot distinguish
   "still working" from "died three minutes ago", which is the whole complaint. */
let busyNow = false;
let reloadWhenIdle = false;

/* A held reload must never land on someone mid-sentence.
 *
 * Reported three times in one day: text vanishing a few seconds after they started typing. The
 * shape is always the same -- Claude edits a UI file during a turn, so the reload is deferred;
 * the user starts composing their next message while the turn finishes, as anyone would; the
 * turn ends seconds later and the held location.reload() fires straight into their typing.
 *
 * Restoring the draft across the reload (which now happens) makes it survivable, not
 * acceptable: a reload mid-word still drops the caret, the scroll position and the keyboard.
 * A stale UI costs nothing by comparison, so unsent text outranks a pending refresh, and the
 * banner stays tappable for whenever they are ready. */
function composerHasText() {
  try { return !!fText(input).trim(); } catch { return false; }
}
let turnStartedAt = 0;
let activityTimer = null;
// Cleared whenever a turn genuinely ends, so a reconcile never fires against a later,
// unrelated turn and hides an indicator that is correctly showing.
let activityWatchdog = null;

/* Present only inside the APK shell; absent in a browser tab. Every call is optional, so the
   UI behaves identically either way. */
/* Named nativeShell, not shell: `shell` is already the Shell sheet element above. */
const nativeShell = window.Forge || null;
function shellCall(name, arg) {
  try {
    if (nativeShell && typeof nativeShell[name] === 'function') nativeShell[name](arg);
  } catch {}
}

function activityShow(label) {
  if (!turnStartedAt) turnStartedAt = Date.now();
  activity.hidden = false;
  activityText.textContent = label;
  if (!activityTimer) activityTimer = setInterval(activityTick, 1000);
  activityTick();
}

function activityTick() {
  const s = Math.round((Date.now() - turnStartedAt) / 1000);
  activityTime.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function activityHide() {
  activity.hidden = true;
  turnStartedAt = 0;
  clearInterval(activityTimer);
  activityTimer = null;
  clearTimeout(activityWatchdog);
  activityWatchdog = null;
}
const tools = new Map(); // tool_use_id -> card element

/* ---------- renderer forwarders ---------- */
/* The bodies of these live in render.js, so they can be replaced while the page keeps running;
   this is the seam. See render.js for why it is a classic script rather than a module.

   Hoisted function declarations, deliberately, rather than `let` bindings assigned during
   boot: a call from anywhere is then safe at any time, including from code that runs before
   boot's first await. That hazard is not hypothetical here -- boot() already carries a comment
   about a `let` further down this file being in its temporal dead zone. And every existing
   call site stays untouched: md(x) still means md(x).

   The fallback matters more than it looks. render.js is a separate fetch, so it can be missing
   or broken for one edit; with no fallback the whole transcript would render as nothing and
   the page would look dead rather than degraded. Escaped plain text is a poor renderer but a
   legible one, which keeps a bad edit from costing the conversation. */
function escFallback(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function esc(s) {
  return window.FR ? window.FR.esc(s) : escFallback(s);
}

function md(src) {
  if (window.FR) return window.FR.md(src);
  return '<p>' + escFallback(src).replace(/\n/g, '<br>') + '</p>';
}

/* ---------- feed helpers ---------- */
function atBottom() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
}
function scroll(force) {
  if (force || atBottom()) feed.scrollTop = feed.scrollHeight;
}
/* Windowed transcript.
 *
 * Layout cost scales with how many nodes are *in the document*, not how many exist. So old
 * messages are detached and parked rather than destroyed: a detached node costs memory but
 * no layout, which is the expensive part. Scrolling up re-attaches them in batches, so
 * scrollback is unlimited within the session and needs no network round trip.
 */
/* Sized for memory, not for avoiding fetches. /history is a local HTTP call to a daemon on
   the same device reading a local file -- no radio, no tokens, sub-millisecond -- so the
   usual reason to cache transcript in the page does not apply here. Holding 300 live nodes
   and 800 parked ones bought nothing and cost every byte of it.

   MAX_ATTIC of zero means nothing is kept detached at all: scrolling either way re-reads
   from the daemon, and what is resident is bounded by the window alone, whatever the
   conversation's length. */
/* Sized in screen heights, not in nodes or events.
 *
 * A page of 40 events was often less than one screenful of transcript, because most events
 * do not become a node: tool_start and tool_result fold into the card tool_use already
 * made, rate limits and status render nothing at all. So a single fling outran several
 * fetches and the reader saw a stutter of loading bars. Node count is no better a proxy --
 * a collapsed tool card is 44px and a long reply is 400.
 *
 * Height is the thing both limits actually care about, so measure that. One fetch covers a
 * fling; the window holds a few of them before shedding.
 */
const FETCH_SCREENS = 3;    // how much transcript one fetch should deliver
const WINDOW_SCREENS = 8;   // how much may stay resident
const MAX_FETCHES = 4;      // guard: a page of unrenderable events must not loop forever
const RESTORE_BATCH = 40;
const PAGE = 120;           // events per request; the loop below decides how many requests

/* Floored, because clientHeight collapses when the keyboard is up. At ~300px visible, a
   window of 8 screens is 2400px and a fetch target is 900px -- so the window held barely
   any transcript and refilled constantly. The limits should describe the conversation, not
   how much of it the keyboard is covering. */
const screenH = () => Math.max(feed.clientHeight || 0, 420);
const maxFeedPx = () => WINDOW_SCREENS * screenH();

/* Trimming and anchoring both move scrollTop/scrollHeight, and the browser dispatches a
   scroll event for that exactly as if a finger had done it. The handler then fetched at
   whichever edge the trim had just exposed -- so loadOlder's trim summoned loadNewer, whose
   trim summoned loadOlder, forever, with no one touching the screen. Both spinners stayed
   up and the transcript froze.
 *
 * So: programmatic movement is fenced, and the handler ignores scroll events caused by it.
 * A deadline rather than a counter deliberately: a counter that fails to balance -- or whose
 * release is a rAF that never fires because the tab is in the background -- wedges scrollback
 * off for the session with nothing in the log. A deadline cannot get stuck, and the 250ms it
 * costs a real scroll is a debounce we wanted anyway. */
/* One history fetch at a time, in either direction.
 *
 * Each loader guarded only against re-entering *itself*, so a scroll event during loadOlder
 * could start loadNewer alongside it -- and then each one's closing trim discarded exactly
 * what the other had just fetched. The log showed the equilibrium plainly: before=19609 and
 * after=19816, the same two cursors alternating once a second forever, the feed pinned on
 * the same 206 events. Guarding each direction separately cannot prevent that; the
 * exclusion has to span both. */
let histBusy = false;
let adjustUntil = 0;

/* A ceiling on history fetches, independent of whatever logic is asking for them.
 *
 * This loop has now been built twice from two different causes, and both times it ran at
 * roughly two requests a second, unattended, until the page was reloaded. The specific
 * causes are fixed above; this is the thing that makes the *class* of failure survivable,
 * because it does not depend on my having found the last one. */
const FETCH_WINDOW_MS = 10000;
const FETCH_CEILING = 12;
const fetchTimes = [];
function fetchBudgetOk() {
  const now = Date.now();
  while (fetchTimes.length && now - fetchTimes[0] > FETCH_WINDOW_MS) fetchTimes.shift();
  if (fetchTimes.length >= FETCH_CEILING) {
    if (!fetchBudgetOk.warned) {
      fetchBudgetOk.warned = true;
      console.warn('history fetch ceiling hit — throttling; this indicates a scroll loop');
      banner('Scrollback throttled — it was fetching in a loop. Reload to reset.', null, true);
    }
    return false;
  }
  fetchTimes.push(now);
  return true;
}
/* Always extend, never shorten. The rAF re-anchor calls beginAdjust after a load has
   already called settleAdjust, and an assignment there cut a 600ms fence down to 250. */
function beginAdjust() { adjustUntil = Math.max(adjustUntil, Date.now() + 250); }
function endAdjust() { adjustUntil = Math.max(adjustUntil, Date.now() + 250); }
// Longer after a load: the trim that ends one lands several screens of layout, and the
// scroll events from settling that must not read as the reader asking for more.
function settleAdjust() { adjustUntil = Math.max(adjustUntil, Date.now() + 600); }
const adjusting = () => Date.now() < adjustUntil;
/* The DOM window was always bounded; the attic was not. Detached nodes were kept forever,
   so a long session grew without limit even though layout stayed fast -- the cost moved
   from paint to memory rather than going away. The attic is a cache, not the record: the
   daemon has every event on disk and /history pages both ways, so anything dropped here can
   be asked for again. */
const MAX_ATTIC = 0;       // park nothing; the daemon is the cache
const attic = [];          // detached OLDER nodes (above the window), oldest -> newest
const atticBelow = [];     // detached NEWER nodes (below the window), oldest -> newest

function eidOf(el) { return el && el.dataset.eid ? +el.dataset.eid : 0; }

/* Discarding from the far end of an attic is only safe if we also move the cursor that says
   where to resume fetching -- otherwise the next fetch pages past the hole it just made. */
function capAttics() {
  // The cursor is always the id of the outermost node still present -- parked if there is
  // one, otherwise the feed's own edge. Reading it off the retained side rather than the
  // discarded one is what keeps this correct when the attic is empty, which at MAX_ATTIC 0
  // is always.
  while (attic.length > MAX_ATTIC) {
    attic.shift();
    const id = eidOf(attic[0] || feed.firstElementChild);
    if (id) { historyOldest = id; historyDone = false; }
  }
  while (atticBelow.length > MAX_ATTIC) {
    atticBelow.pop();
    tailFrom = eidOf(atticBelow[atticBelow.length - 1] || feed.lastElementChild);
  }
}

/* Trim past the limit, not to it. Stopping exactly at the boundary leaves the opposite edge
   one node away from being eligible, so a fetch at one end immediately qualified the other
   -- the oscillation the log caught. Shedding to 70% buys a margin that a fetch has to
   genuinely cross before anything happens. */
const TRIM_TO = 0.7;

/* The element currently at the top of the viewport. Trims anchor on it and refuse to remove
   it, so nothing on screen is ever discarded and the view can be put back exactly. */
function visibleAnchor() {
  const edge = feed.getBoundingClientRect().top + 1;
  for (const kid of feed.children) {
    if (kid.getBoundingClientRect().bottom > edge) return kid;
  }
  return null;
}

/* Removing content above the viewport shifts everything up under the reader.
 *
 * The browser used to compensate for that itself -- overflow-anchor is on by default -- and
 * turning it off so it would stop fighting my insert anchoring silently took the protection
 * off removals too, which had never needed any of their own. That is why scrolling down kept
 * snapping back: every trim pulled the transcript up by however much it had just discarded.
 *
 * So trims now anchor exactly as inserts do: keep one visible element visually still. */
function trimFeed() {
  const limit = maxFeedPx();
  if (feed.scrollHeight <= limit) return;
  beginAdjust();
  const floor = limit * TRIM_TO;
  const ref = visibleAnchor();
  const was = ref ? ref.getBoundingClientRect().top : 0;
  while (feed.scrollHeight > floor && feed.childElementCount > 4) {
    const n = feed.firstElementChild;
    if (!n || n === ref) break;          // never discard what is on screen
    feed.removeChild(n);
    attic.push(n);
  }
  if (ref && ref.isConnected) feed.scrollTop += ref.getBoundingClientRect().top - was;
  capAttics();
  endAdjust();
}

function add(el) {
  const hint = feed.querySelector('.hint');
  if (hint) hint.remove();
  // Every node needs an id, not just the ones from /history: the attic discards from both
  // ends, and a node with no id cannot tell the fetch cursor where the hole starts.
  if (!el.dataset.eid && lastEventId) el.dataset.eid = lastEventId;
  // Measured BEFORE the append: afterwards scrollHeight already counts the new node while
  // scrollTop does not, so atBottom() reads false even when following the live tail.
  const following = atBottom();
  // If newer nodes are parked below the window, this one belongs behind them -- appending it
  // to the feed directly would render it out of order.
  // Not just "is anything parked below" -- with nothing parked there can still be a gap
  // between the feed's last node and the live tail. Appending into that gap renders the
  // transcript out of order with no sign anything is missing.
  if (atticBelow.length || tailFrom) {
    atticBelow.push(el);
    capAttics();
    return el;
  }
  feed.appendChild(el);
  // Only trim while following. Trimming under someone reading back would yank content out
  // from under them mid-scroll.
  if (following) trimFeed();
  updateJumpBtn();
  // Pass it through: a node taller than atBottom()'s 120px tolerance would otherwise stop
  // the transcript following the live tail.
  scroll(following);
  return el;
}

/* Shed from the bottom to pay for what scrolling up adds at the top. Without this the window
   only ever grows: loading history would walk straight back into the lag it was meant to fix. */
function trimBottom() {
  const limit = maxFeedPx();
  if (feed.scrollHeight <= limit) return;
  beginAdjust();
  const floor = limit * TRIM_TO;
  // Removing below the viewport moves nothing, so this needs no anchoring -- only the same
  // refusal to discard anything currently on screen.
  const bottom = feed.getBoundingClientRect().bottom;
  while (feed.scrollHeight > floor && feed.childElementCount > 4) {
    const n = feed.lastElementChild;
    if (!n || n.getBoundingClientRect().top < bottom) break;
    feed.removeChild(n);
    atticBelow.unshift(n);
  }
  capAttics();
  endAdjust();
}

/* Removing or adding at the bottom leaves everything above it untouched, so unlike
   restoreOlder this needs no scroll anchoring. */
function restoreNewer() {
  if (!atticBelow.length) return;
  const batch = atticBelow.splice(0, RESTORE_BATCH);
  const frag = document.createDocumentFragment();
  for (const n of batch) frag.appendChild(n);
  feed.appendChild(frag);
}

function restoreOlder() {
  if (!attic.length) return;
  const batch = attic.splice(-RESTORE_BATCH);      // newest-parked first, order preserved
  const before = feed.scrollHeight;
  const frag = document.createDocumentFragment();
  for (const n of batch) frag.appendChild(n);
  feed.insertBefore(frag, feed.firstElementChild);
  // Anchor the viewport: without this, prepending content jumps the user somewhere else.
  feed.scrollTop += feed.scrollHeight - before;
}

function attachToolToggle(card) {
  card.querySelector('.thead').addEventListener('click', () => {
    const body = card.querySelector('.tbody');
    body.hidden = !body.hidden;
    card.querySelector('.tcaret').textContent = body.hidden ? '\u25b8' : '\u25be';
  });
}

/* ---------- older history, fetched on demand ---------- */
/* The attic only holds what this page has already drawn. The cold replay is smaller than the
   window, so the attic is usually empty and scrolling up has nothing to give back -- the
   older transcript has to come from the daemon. */
let historyOldest = 0;        // lowest event id currently on screen
let tailFrom = 0;             // highest event id we discarded off the bottom, 0 if none
let tailLoading = false;
let historyLoading = false;
let historyDone = false;
let historyRetryAt = 0;    // cooldown after a failed fetch

function nodeForEvent(e, results) {
  if (e.kind === 'user_message') return node('msg user', esc(e.text || ''));
  if (e.kind === 'text' && (e.text || '').trim()) return node('msg claude', md(e.text));
  if (e.kind === 'tool_use') {
    const card = node('tool');
    card.innerHTML = `<div class="thead">
        <span class="tname">${esc(e.name || 'tool')}</span>
        <span class="tdesc">${esc(describe(e.input))}</span>
        <span class="tcaret">\u25b8</span>
      </div><div class="tbody" hidden></div>`;
    const out = results[e.id];
    if (out !== undefined) {
      card.querySelector('.tbody').innerHTML =
        `<pre><code>${esc(String(out).slice(0, 20000) || '(no output)')}</code></pre>`;
    }
    attachToolToggle(card);
    return card;
  }
  return null;
}

/* Floated over the feed rather than inserted into it.
 *
 * As a feed child it was part of the scrolled content, so every page had to compensate for
 * its height, and moving it back to the top after each insert shifted everything below it
 * by its own height again -- uncompensated, four times per load. A loading indicator has no
 * business being in the scroll flow it is reporting on. Positioned from the feed's own
 * rect, so it needs no guesses about header or composer heights. */
function histNote(text, spinning, where) {
  const id = where === 'bottom' ? 'histnote-b' : 'histnote';
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.className = 'histnote floating';
    document.body.appendChild(el);
  }
  const r = feed.getBoundingClientRect();
  if (where === 'bottom') {
    el.style.bottom = (window.innerHeight - r.bottom + 10) + 'px';
    el.style.top = '';
  } else {
    el.style.top = (r.top + 10) + 'px';
    el.style.bottom = '';
  }
  el.innerHTML = (spinning ? '<span class="histspin"></span>' : '') +
                 `<span>${esc(text)}</span>`;
  return el;
}

function clearHistNote(where) {
  const el = document.getElementById(where === 'bottom' ? 'histnote-b' : 'histnote');
  if (el) el.remove();
}

async function loadOlder() {
  if (histBusy || historyLoading || historyDone || Date.now() < historyRetryAt) return;
  if (!fetchBudgetOk()) return;
  histBusy = historyLoading = true;
  beginAdjust();
  histNote('Loading earlier messages\u2026', true);
  try {
    // Keep paging until a fling's worth of transcript has landed. One request is not one
    // screenful: a page can be mostly tool_result and status events that render nothing,
    // and stopping there is what produced a stutter of loading bars per swipe.
    const target = FETCH_SCREENS * screenH();
    let gained = 0;
    for (let i = 0; i < MAX_FETCHES && gained < target; i++) {
      // Anchor on a real element's position in the viewport, not on scrollHeight. Feed
      // children carry content-visibility: auto, so their heights are estimates until they
      // are actually rendered -- scrollHeight measured right after an insert is a guess, and
      // anchoring to a guess is what threw the reader somewhere else in the transcript.
      // Keeping one element visually still is exact, and converges if re-run.
      // The element under the viewport top, not simply the first child: after the first
      // page the first child is far above the screen, and anchoring on something the reader
      // cannot see makes any error in its estimated height a visible jump.
      const cursor = eidOf(feed.firstElementChild) || historyOldest;
      const r = await fetch(`/history?before=${cursor}&limit=${PAGE}`);
      if (!r.ok) {
        // Not permanent -- one bad fetch must not switch scrollback off for the session.
        // But back off, or a repeatable failure turns every scroll into a request (this
        // sent 180 in two minutes).
        historyRetryAt = Date.now() + (r.status >= 400 && r.status < 500 ? 30000 : 3000);
        break;
      }
      const { items } = await r.json();
      if (!items || !items.length) {
        historyDone = true;
        break;
      }

      // tool_result arrives as its own event; pair it back onto the card it belongs to.
      const results = {};
      for (const e of items) {
        if (e.kind === 'tool_result' && e.tool_use_id) results[e.tool_use_id] = e.content;
      }
      const frag = document.createDocumentFragment();
      for (const e of items) {
        const n = nodeForEvent(e, results);
        if (n) { n.dataset.eid = e.event_id; frag.appendChild(n); }
      }
      historyOldest = items[0].event_id;   // envelope id, not a tool's own id
      if (!frag.childElementCount) continue;   // nothing renderable; page further back

      /* Two distinct things, which I had collapsed into one variable and broken both.
       *
       * WHERE to insert is always the very front: this is older history, and putting it in
       * front of the *visible* element instead left everything already scrolled above the
       * viewport sitting above content older than itself. An out-of-order transcript reads
       * as violent jumping, because the position you are restored to is measured against a
       * sequence that no longer makes sense.
       *
       * WHAT to measure against is the visible element -- but measured here, not before the
       * fetch. A round trip is long enough to scroll through, so an anchor captured before
       * it has already moved by the time it is used. */
      const anchor = visibleAnchor() || feed.firstElementChild;
      const was = anchor ? anchor.getBoundingClientRect().top : 0;
      const before = feed.scrollHeight;
      feed.insertBefore(frag, feed.firstElementChild);
      if (anchor) feed.scrollTop += anchor.getBoundingClientRect().top - was;
      gained += feed.scrollHeight - before;
      // Images and late layout can move things again a frame later; the same correction is
      // idempotent, so simply repeat it.
      if (anchor) requestAnimationFrame(() => {
        if (!anchor.isConnected) return;
        feed.scrollTop += anchor.getBoundingClientRect().top - was;
        beginAdjust();
      });
      beginAdjust();   // the fence must outlive the whole loop, not just its first request
    }
    clearHistNote();
    if (historyDone) histNote('Beginning of the conversation', false);
  } catch {
    clearHistNote();                         // transient: allow another attempt
  } finally {
    settleAdjust();
    lastTop = feed.scrollTop;   // the anchor moved us; direction is measured from here on
    historyLoading = histBusy = false;
  }
}


/* The mirror of loadOlder. Only reachable once the attic has started discarding: with an
   unbounded attic, coming back down was always free and this could not exist. */
async function loadNewer() {
  if (histBusy || tailLoading || !tailFrom) return;
  if (!fetchBudgetOk()) return;
  histBusy = tailLoading = true;
  beginAdjust();
  histNote('Loading newer messages\u2026', true, 'bottom');
  try {
    const target = FETCH_SCREENS * screenH();
    let gained = 0;
    for (let i = 0; i < MAX_FETCHES && gained < target && tailFrom; i++) {
      const cursor = eidOf(feed.lastElementChild) || tailFrom;
      const r = await fetch(`/history?after=${cursor}&limit=${PAGE}`);
      if (!r.ok) break;
      const { items } = await r.json();
      if (!items || !items.length) { tailFrom = 0; break; }

      const results = {};
      for (const e of items) {
        if (e.kind === 'tool_result' && e.tool_use_id) results[e.tool_use_id] = e.content;
      }
      const frag = document.createDocumentFragment();
      for (const e of items) {
        const n = nodeForEvent(e, results);
        if (n) { n.dataset.eid = e.event_id; frag.appendChild(n); }
      }
      const last = items[items.length - 1].event_id;
      // Caught up with the live tail: from here the SSE stream takes over again.
      tailFrom = last >= lastEventId ? 0 : last;
      if (!frag.childElementCount) continue;

      const before = feed.scrollHeight;
      // Appending leaves everything above untouched, so unlike loadOlder this needs no
      // scroll anchoring at all.
      feed.appendChild(frag);
      gained += feed.scrollHeight - before;
      beginAdjust();
    }
  } catch {
    // Transient. Leave tailFrom alone so the next scroll tries again.
  } finally {
    clearHistNote('bottom');
    settleAdjust();
    lastTop = feed.scrollTop;
    tailLoading = histBusy = false;
  }
}

function nearBottom() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 600;
}

/* Direction decides everything.
 *
 * Previously both edges were tested on every scroll event, so when the window was short
 * enough for "within 400px of the top" and "within 600px of the bottom" to be true at once,
 * the handler alternated between them on its own. And each loader trimmed the far end when
 * it finished, which manufactured precisely the condition the opposite loader fires on. A
 * fetch caused a trim and a trim caused a fetch.
 *
 * So the coupling is cut in both places: loads no longer trim at all, and a scroll only
 * ever looks at the edge it is actually travelling towards. Trimming happens behind you,
 * fetching ahead of you, and neither can trigger the other.
 */
let lastTop = 0;

feed.addEventListener('scroll', () => {
  const top = feed.scrollTop;
  // Record the position even when ignoring the event. Anchoring a prepend moves scrollTop by
  // several screens, and those events are fenced -- so returning before this left lastTop at
  // a pre-load value, and the next real scroll compared against it and concluded the reader
  // was heading *down*. That ran the downward branch, whose trim discards from the top: the
  // page just fetched was thrown away immediately. The access log showed it as a cursor
  // moving two events instead of a hundred and twenty.
  const goingUp = top < lastTop;
  lastTop = top;
  if (adjusting()) return;          // our own trim/anchor, not a finger

  // At an extreme edge scrollTop stops changing, so there is no direction to read -- which
  // is why hitting the top and staying there loaded nothing until you nudged back down and
  // up again. The edge itself is the intent.
  const atTop = top <= 2;
  const atEnd = atBottom();

  if (goingUp || atTop) {
    if (top < 400) {
      let guard = 6;
      while (feed.scrollTop < 400 && attic.length && guard-- > 0) restoreOlder();
      if (!attic.length) loadOlder();
    }
    trimBottom();                   // shed what is now behind us
    updateJumpBtn();
  } else if (!goingUp || atEnd) {   // else-if: one edge per event, never both
    if (nearBottom()) {
      let guard = 6;
      while (nearBottom() && atticBelow.length && guard-- > 0) restoreNewer();
      if (!atticBelow.length && tailFrom) loadNewer();
      else if (!atticBelow.length && atBottom()) trimFeed();
    }
    trimFeed();
    updateJumpBtn();
  }
}, { passive: true });

/* The scroll handler cannot see a boundary, because a boundary produces no scroll events.
 *
 * Once scrollTop reaches 0 it stops changing, so no further events fire however hard you
 * flick -- the handler is simply never called, and the atTop check I added last round sat in
 * a function nothing was invoking. That is why nudging back the other way was still
 * required: it was the only way to generate an event at all.
 *
 * scrollend fires when scrolling finishes, momentum included, which is exactly the moment to
 * ask whether we came to rest against an edge. touchend is the fallback for engines without
 * it. Gesture-driven rather than timed on purpose: a timer resting at the top would keep
 * pulling history in forever while you read, whereas this needs a new gesture each time.
 */
let edgeRetry = null;
function checkEdges() {
  clearTimeout(edgeRetry);
  updateJumpBtn();
  if (histBusy) return;
  // Landing inside the fence -- easy to do, since a load holds it for 600ms and a second
  // flick arrives well inside that -- used to drop the request entirely, and no further
  // event was coming to revive it. That is the half of the time it did nothing. The fence
  // is time-bounded, so waiting it out terminates.
  if (adjusting()) { edgeRetry = setTimeout(checkEdges, 120); return; }
  if (feed.scrollTop < 400) {
    if (attic.length) restoreOlder(); else loadOlder();
  } else if (nearBottom()) {
    if (atticBelow.length) restoreNewer();
    else if (tailFrom) loadNewer();
  }
}

if ('onscrollend' in window) feed.addEventListener('scrollend', checkEdges, { passive: true });
else feed.addEventListener('touchend', () => setTimeout(checkEdges, 160), { passive: true });

/* ---------- jump to newest ---------- */
/* With a bounded window the newest message is often simply not in the page, so "scroll to
   the bottom" would only reach the bottom of what happens to be loaded. This reloads the
   tail outright rather than paging down to it, which is both faster and exact. */
const jumpBtn = document.getElementById('jumpNewest');

function pageFragment(items) {
  // tool_result arrives as its own event; pair it back onto the card it belongs to.
  const results = {};
  for (const e of items) {
    if (e.kind === 'tool_result' && e.tool_use_id) results[e.tool_use_id] = e.content;
  }
  const frag = document.createDocumentFragment();
  for (const e of items) {
    const n = nodeForEvent(e, results);
    if (n) { n.dataset.eid = e.event_id; frag.appendChild(n); }
  }
  return frag;
}

function updateJumpBtn() {
  const behind = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
  // Either the tail is genuinely absent from the page, or it is present but a long way
  // below. Both mean the same thing to the reader.
  jumpBtn.hidden = !(tailFrom || behind > 2 * screenH());
}

async function jumpToNewest() {
  if (histBusy) return;
  histBusy = true;
  beginAdjust();
  histNote('Jumping to newest\u2026', true, 'bottom');
  try {
    const r = await fetch(`/history?before=${(lastEventId || 0) + 1}&limit=${PAGE}`);
    if (!r.ok) { banner('Could not load the newest messages.'); return; }
    const { items } = await r.json();

    // Replace rather than append: everything resident is older than what is arriving, and
    // keeping it would just be a window that has to be trimmed away immediately anyway.
    feed.innerHTML = '';
    attic.length = 0;
    atticBelow.length = 0;
    tailFrom = 0;
    historyDone = false;
    if (items && items.length) {
      feed.appendChild(pageFragment(items));
      historyOldest = items[0].event_id;
    }
    feed.scrollTop = feed.scrollHeight;
  } catch {
    banner('Could not load the newest messages.');
  } finally {
    clearHistNote('bottom');
    settleAdjust();
    lastTop = feed.scrollTop;
    histBusy = false;
    updateJumpBtn();
  }
}

jumpBtn.onclick = jumpToNewest;

function node(cls, html) {
  const d = document.createElement('div');
  d.className = cls;
  if (html !== undefined) d.innerHTML = html;
  return d;
}

function userBubble(text) { add(node('msg user', esc(text))); }

function ensureAssistant() {
  if (!current) {
    currentText = '';
    current = add(node('msg claude', ''));
  }
  return current;
}

function finishAssistant() {
  flushRender();
  current = null;
  currentText = '';
  lastHtml = '';
}

/* Streaming used to assign innerHTML on every token, which tore down and rebuilt the whole
   message subtree tens of times a second -- on a phone that reads as flickering. Coalesce to
   one render per animation frame, and only touch the DOM when the markup actually changes. */
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(flushRender);
}

function flushRender() {
  renderQueued = false;
  if (!current) return;
  const html = md(currentText);
  if (html === lastHtml) return;
  lastHtml = html;
  const wasAtBottom = atBottom();
  current.innerHTML = html;
  if (wasAtBottom) scroll(true);
}

/* ---------- events ---------- */
const handlers = {
  connected(e) {
    setDot('live');
    banner(e.resumed ? null : null);
  },
  disconnected(e) {
    setDot('dead');
    // 143/SIGTERM is a deliberate `systemctl restart`, not a failure. Reporting it as
    // "Backend stopped: Command failed" makes a planned restart look like a crash, which is
    // alarming precisely when nothing is actually wrong.
    const err = String(e.error || '');
    const planned = /\b143\b|SIGTERM/.test(err);
    banner(planned
      ? 'Forge is restarting — your turn is saved and will resume in a moment.'
      : e.layer === 'network'
        ? 'Lost the connection to Claude — likely mobile signal. Your turn is saved and will retry.'
        : `Backend stopped: ${err || 'unknown'}. Restarting…`);
  },
  turn_interrupted(e) { renderInterrupted(e); },
  session(e) {
    // session/init reports the configured default, not the model actually in use, so an
    // explicit choice must not be overwritten by it.
    if (e.model && !chosenModel) currentModel = short(e.model);
    renderTitle();
  },
  model_changed(e) {
    chosenModel = e.model === 'default' ? '' : e.model;
    currentModel = chosenModel || currentModel;
    renderTitle();
    banner(null);
  },
  user_message(e) { finishAssistant(); userBubble(e.text); },
  turn_start(e) {
    setDot('busy');
    if (e.replay) return;   // replayed history must not resurrect a long-finished turn
    busyNow = true;
    turnStartedAt = Date.now();
    activityShow('Thinking…');
    shellCall('keepAwake', true);
  },
  turn_end(e) {
    setDot('live');
    finishAssistant();
    if (e.replay) return;
    busyNow = false;
    activityHide();
    shellCall('keepAwake', false);
    // A reload held during the turn lands here, once it can no longer erase live output --
    // unless it would erase a half-typed message instead. Then it keeps waiting.
    if (reloadWhenIdle && !composerHasText()) reloadNow('held-until-idle');
  },
  // Published all along, but nothing listened: the earliest possible signal that a tool
  // is starting, ahead of the completed assistant message.
  tool_start(e) {
    if (e.replay) return;
    activityShow(e.name || 'Working…');
  },
  thinking(e) {
    if (e.replay) return;
    activityShow(e.tokens ? `Thinking… ${e.tokens} tokens` : 'Thinking…');
  },
  text_delta(e) {
    ensureAssistant();
    currentText += e.text;
    scheduleRender();
  },
  text(e) {
    // Full block; only use it if deltas didn't already build this message.
    if (!currentText.trim() && e.text) {
      ensureAssistant();
      currentText = e.text;
      flushRender();
    }
  },
  tool_use(e) {
    finishAssistant();
    const card = node('tool');
    // Plain divs, not <details>/<summary>. Firefox refuses to render a <summary> whose
    // display is overridden away from list-item, which silently collapsed every tool card
    // to its 1px border -- the "weird grey lines". A div cannot fail that way.
    card.innerHTML = `<div class="thead">
        <span class="tname">${esc(e.name || 'tool')}</span>
        <span class="tdesc">${esc(describe(e.input))}</span>
        <span class="tcaret">▸</span>
      </div><div class="timg"></div><div class="tbody" hidden></div>`;
    attachToolToggle(card);
    // A Read of an image file is the one tool result whose text is useless -- it's the
    // picture you wanted. /media already serves anything under the three whitelisted media
    // roots, live in the running daemon right now, so this needs no backend change.
    if (e.name === 'Read') {
      const p = (e.input && e.input.file_path) || '';
      if (/\.(png|jpe?g|webp|gif)$/i.test(p)
          && /^\/mnt\/shared\/(Pictures|DCIM|Download)\//.test(p)) {
        card.dataset.img = p;
      }
    }
    add(card);
    if (e.id) tools.set(e.id, card);
    // Name plus target: "Bash" alone does not tell you what is taking 40 seconds.
    if (!e.replay) activityShow(`${e.name || 'tool'} · ${describe(e.input)}`.slice(0, 60));
  },
  tool_result(e) {
    if (!e.replay && busyNow) activityShow('Working…');
    const card = tools.get(e.tool_use_id);
    if (!card) return;
    if (e.is_error) card.classList.add('err');
    const full = e.content || '';
    let body = full.slice(0, 20000);
    // The image goes in .timg, which is never hidden -- a click to expand just to see the
    // picture you asked for is the exact UX complaint this replaced.
    if (card.dataset.img) {
      card.querySelector('.timg').innerHTML =
        `<img class="tool-img" src="/media?path=${encodeURIComponent(card.dataset.img)}">`;
    } else {
      // A Read of an image the CLI returns as a raw {"type":"image", source:{data:...}}
      // blob -- whitelisted /media root or not, the bytes already crossed the wire to get
      // here, so there's nothing left to save by refusing to render them. Pull the base64
      // straight out client-side and show it; no backend round trip needed. (Slice above is
      // display-length only -- unbounded here since base64 easily exceeds 20000 chars.)
      //
      // data and media_type are matched independently, not as one ordered pattern: the real
      // payload puts "data" *before* "media_type" ({"type":"base64","data":"...","media_type":
      // "image/png"}), the opposite of the order this originally assumed, so the combined
      // regex never matched and the image silently never rendered.
      if (/"type":\s*"image"/.test(full)) {
        const dm = full.match(/"data":\s*"([^"]+)"/);
        const tm = full.match(/"media_type":\s*"([^"]+)"/);
        if (dm) {
          const mediaType = tm ? tm[1] : 'image/png';
          card.querySelector('.timg').innerHTML =
            `<img class="tool-img" src="data:${esc(mediaType)};base64,${dm[1]}">`;
          body = '(image shown above)';
        }
      }
    }
    card.querySelector('.tbody').innerHTML =
      `<pre><code>${esc(body || '(no output)')}</code></pre>`;
    scroll();
  },
  ask_request(e) { renderAsk(e); },
  ask_resolved(e) {
    const el = document.getElementById(`ask-${e.id}`);
    if (el) el.remove();
  },
  permission_request(e) { renderPermission(e); },
  permission_resolved(e) {
    const el = document.getElementById(`perm-${e.request_id}`);
    if (el) el.remove();
  },
  result(e) {
    finishAssistant();
    if (e.is_error) banner('That turn ended with an error.');
  },
  rate_limit(e) { renderGauge(e.windows); },
  classifying(e) {
    if (!e.replay) activityShow('Choosing a model for this chat…');
  },
  classified(e) {
    currentModel = short(e.model);
    renderTitle();
    if (!e.replay) banner(`New chat: ${e.model} · ${e.effort} (${e.label})`);
  },
  routing(e) {
    // Never change what the session costs without saying so: a quietly downgraded model
    // looks like Claude suddenly getting worse for no reason.
    routingNote = e;
    if (!e.replay) {
      banner(e.capped
        ? `${Math.round((e.utilisation || 0) * 100)}% of the window used — capped to `
          + `${e.model} · ${e.effort}`
        : `Routed to ${e.model} · ${e.effort} (${e.reason || 'complexity'})`);
    }
  },
  exec_start() { if (shell.hidden) openShell(); },
  exec_log(e) { shellWrite(e.line); },
  exec_end(e) {
    if (e.error) shellWrite(e.error, 'code-bad');
    else shellWrite(`exit ${e.code} · ${e.seconds}s`, e.ok ? 'code-ok' : 'code-bad');
  },
  build_start(e) { startBuild(e); },
  build_log(e) { appendBuild(e.line); },
  build_end(e) { endBuild(e); },
  ui_reload(e) {
    // Replayed events are history, not instructions -- acting on one reloads the page,
    // which replays it again. Also refuse to reload right after loading: that shape is a
    // loop whatever caused it.
    if (e.replay) return;
    if (Date.now() - loadedAt < 3000) return;
    // Reloading mid-turn throws away the live transcript and the activity strip, so the
    // user watches the screen blank out and has no idea whether work is still running.
    // Editing UI files *while* Claude works is the normal case here, not the rare one.
    // CSS never needs a reload, so style changes apply instantly even mid-turn.
    /* Only the files this page is actually made of may reload it.
     *
     * The watcher announces every change anywhere under forge-ui/, and that directory holds
     * far more than the app: routing-advice.json rewritten by the forge-route-advisor timer
     * every hour at :17, routing-meta/-architect.json, the cable-debug drops, the generated
     * docs/*.html. This page loads none of them -- but none of them end in .css either, so
     * each write fell straight through to location.reload() and took the composer with it.
     * No turn, no edit, no visible cause: just typing erased on the hour. That is the bug.
     *
     * A whitelist, not a blacklist of data files: the next tool to drop something in here
     * must not silently start reloading the page again. */
    const files = (e.files || []).filter(
      (f) => f === 'app.js' || f === 'index.html' || f === 'style.css'
          || f === 'render.js');
    if (!files.length) return;
    /* Two of these can be replaced in place, and a change confined to them costs nothing at
       all -- no reload, no lost transcript, no held banner, not even mid-turn. Since the look
       of the interface lives almost entirely in those two files, that is most UI work. */
    const soft = files.filter(f => f === 'style.css' || f === 'render.js');
    if (soft.length === files.length) {
      if (soft.includes('style.css')) swapStyles();
      if (soft.includes('render.js')) swapRender();
      return;
    }
    // JS and HTML do need one: the running code cannot be swapped out underneath itself.
    if (busyNow || composerHasText()) {
      reloadWhenIdle = true;
      banner('UI updated — tap to refresh when you are ready.',
             () => reloadNow('banner-tap', files));
      return;
    }
    reloadNow('ui-file-changed', files);
  },
  ui_error(e) {
    if (e.replay) return;
    // The edit that just landed would have broken the page, so the reload was held.
    banner('UI edit has a syntax error — reload held. ' + (e.errors || []).join(' | '),
           null, true);
  },
  /* Replace every visible character with a random CJK one, in place.
   *
   * In place is the whole trick. Two CSS attempts displaced the layout, and the cause was not
   * the text: giving every element `position: relative` so an ::after could overlay it
   * re-anchors every absolutely-positioned descendant -- .kglow, .chat-row::before, the
   * drawer, the virtual list's spacers. Mutating the text nodes themselves adds no elements,
   * changes no positioning, and preserves the character count, so structure survives exactly.
   *
   * CSS could never have done this part: it can insert a fixed string, but it cannot read
   * existing text and transform it. Hence an event rather than a stylesheet edit -- which
   * also means firing costs no reload, so it lands instantly even mid-turn.
   */
  zh(e) {
    if (e.replay) return;
    runZh(Math.min(e.ms || 5000, 20000));
  },
  /* The session host is about to restart to pick up a backend change. It only ever does
     this while idle, so nothing is lost -- but the socket drops for a second or two, and a
     message sent into that gap would disappear. Hold the composer and say why. */
  backend_reloading(e) {
    if (e.replay) return;
    setBackendReloading(true);
  },
};

let reloadTimer = null;
function setBackendReloading(on) {
  document.body.classList.toggle('reloading', on);
  sendBtn.disabled = on;
  clearTimeout(reloadTimer);
  if (on) {
    // A failsafe, not the mechanism: normally the reconnect clears this. If the host fails
    // to come back, an input locked forever is worse than one unlocked too early.
    reloadTimer = setTimeout(() => setBackendReloading(false), 12000);
  }
}

let zhActive = false;

function runZh(ms) {
  if (zhActive) return;
  zhActive = true;
  const snaps = new Map();
  const rnd = () => String.fromCharCode(0x4e00 + ((Math.random() * 0x51a5) | 0));

  function mangle(root) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) {
      if (snaps.has(n) || !n.nodeValue.trim()) continue;
      snaps.set(n, n.nodeValue);
      // One character out for one character in, so every line keeps its length and nothing
      // rewraps. Whitespace is preserved for the same reason.
      n.nodeValue = n.nodeValue.replace(/\S/g, rnd);
    }
  }
  mangle(document.body);

  /* Scrolling during the effect renders nodes that did not exist when it started.
   *
   * The transcript window is only eight screens: scrolling back detaches what you leave and
   * fetches what you arrive at, so the page you scroll into is built fresh, in English, while
   * everything around it is Chinese. Streaming replies and restored attic nodes arrive the
   * same way. Observing childList catches all of them from one place -- and since the
   * mangling writes nodeValue rather than replacing nodes, it cannot retrigger itself.
   */
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType === 3) {
          if (!snaps.has(node) && node.nodeValue.trim()) {
            snaps.set(node, node.nodeValue);
            node.nodeValue = node.nodeValue.replace(/\S/g, rnd);
          }
        } else if (node.nodeType === 1) {
          mangle(node);
        }
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  document.body.classList.add('zh');
  setTimeout(() => {
    obs.disconnect();
    // Restoring a node the window has since discarded is harmless: it is detached, so the
    // write lands nowhere and costs nothing.
    for (const [node, text] of snaps) node.nodeValue = text;
    document.body.classList.remove('zh');
    zhActive = false;
  }, ms);
}

function short(model) {
  return String(model).replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function describe(inp) {
  if (!inp) return '';
  if (typeof inp === 'string') return inp;
  return inp.command || inp.file_path || inp.pattern || inp.path ||
         inp.description || JSON.stringify(inp).slice(0, 120);
}

/* ---------- permission cards ---------- */
/* Every suggestion the CLI offers is a distinct grant, so every button has to read
   differently. Two identically-labelled buttons is worse than one: it makes the choice look
   broken and the safer option indistinguishable from the broader one. */
const SCOPE = {
  session: 'this session',
  localSettings: 'this project',
  projectSettings: 'this project, shared',
  userSettings: 'always',
};

function labelFor(s) {
  if (s.type === 'setMode' && s.mode === 'acceptEdits') return 'Allow edits this session';
  if (s.type === 'setMode') return `Mode: ${s.mode}`;
  if (s.type === 'addDirectories' && s.directories) {
    const d = s.directories[0] || '';
    return `Always allow ${d.split('/').pop() || d}/`;
  }
  const scope = SCOPE[s.destination];
  if (s.type === 'addRules' && s.rules && s.rules.length) {
    const r = s.rules[0];
    const rule = r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;
    const verb = s.behavior === 'deny' ? 'Deny' : 'Allow';
    const extra = s.rules.length > 1 ? ` +${s.rules.length - 1}` : '';
    return scope ? `${verb} ${rule}${extra} — ${scope}` : `${verb} ${rule}${extra}`;
  }
  return scope ? `Allow more — ${scope}` : 'Allow more';
}

/* Last resort: if two suggestions still collide, number them rather than ship twins. */
function labelsFor(suggestions) {
  const labels = suggestions.map(labelFor);
  const seen = new Map();
  labels.forEach(l => seen.set(l, (seen.get(l) || 0) + 1));
  const used = new Map();
  return labels.map((l, i) => {
    if (seen.get(l) === 1) return l;
    const n = (used.get(l) || 0) + 1;
    used.set(l, n);
    const s = suggestions[i];
    return `${l} (${s.destination || s.type || n})`;
  });
}

function renderPermission(e) {
  const card = node('perm');
  card.id = `perm-${e.request_id}`;
  const sugg = labelsFor(e.suggestions || []).map((label, i) =>
    `<button data-i="${i}">${esc(label)}</button>`).join('');
  card.innerHTML = `
    <h4>${esc(e.display_name || e.tool_name)} needs permission</h4>
    ${e.description ? `<div class="path">${esc(e.description)}</div>` : ''}
    ${e.reason ? `<div class="why">${esc(e.reason)}</div>` : ''}
    <div class="btns">
      <button class="allow" data-allow="1">Allow once</button>
      ${sugg}
      <button class="deny" data-deny="1">Deny</button>
    </div>`;

  card.addEventListener('click', ev => {
    const b = ev.target.closest('button');
    if (!b) return;
    card.querySelectorAll('button').forEach(x => x.disabled = true);
    const body = { request_id: e.request_id, allow: !b.dataset.deny };
    if (b.dataset.i !== undefined) body.suggestion_index = +b.dataset.i;
    post('/permission', body);
  });

  pending.appendChild(card);
  scroll(true);
}

/* ---------- AskUserQuestion ---------- */
/* Claude's questions used to arrive as a bare "AskUserQuestion needs permission" card with the
   payload as raw JSON, and no way to answer -- so every question was silently unanswerable.
   Render the options as buttons and post the choice back. */
function renderAsk(e) {
  const card = node('ask');
  card.id = `ask-${e.id}`;
  const questions = e.questions || [];
  const picked = {};

  card.innerHTML = questions.map((q, qi) => `
    <div class="askq" data-q="${qi}">
      <h4>${esc(q.question || '')}</h4>
      <div class="askopts">
        ${(q.options || []).map((o, oi) => `
          <button data-q="${qi}" data-o="${oi}">
            <span class="asklabel">${esc(o.label || '')}</span>
            ${o.description ? `<span class="askdesc">${esc(o.description)}</span>` : ''}
          </button>`).join('')}
      </div>
      <!-- Always offered: the listed options are Claude's guesses, and the right answer is
           routinely none of them. Typing here overrides any selected option. -->
      <input class="askfree" data-q="${qi}" placeholder="…or write your own answer"
             autocapitalize="sentences" autocorrect="on">
    </div>`).join('') +
    `<div class="btns">
       <button class="allow" data-send="1" disabled>Answer</button>
       <button class="deny" data-skip="1">Skip</button>
     </div>`;

  const sendBtn2 = card.querySelector('[data-send]');

  // A typed answer wins over any highlighted option, and re-enables Answer on its own.
  const refresh = () => {
    sendBtn2.disabled = questions.some(qq => !picked[qq.question]);
  };
  card.addEventListener('input', ev => {
    const box = ev.target.closest('.askfree');
    if (!box) return;
    const qi = +box.dataset.q;
    const q = questions[qi] || {};
    const text = box.value.trim();
    const group = card.querySelector(`.askq[data-q="${qi}"]`);
    if (text) {
      group.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      picked[q.question] = text;
    } else {
      delete picked[q.question];
    }
    refresh();
  });

  card.addEventListener('click', ev => {
    const b = ev.target.closest('button');
    if (!b) return;

    if (b.dataset.skip) {
      card.querySelectorAll('button').forEach(x => x.disabled = true);
      post('/ask', { id: e.id, answers: null });
      return;
    }
    if (b.dataset.send) {
      card.querySelectorAll('button').forEach(x => x.disabled = true);
      post('/ask', { id: e.id, answers: picked });
      return;
    }
    const qi = +b.dataset.q, oi = +b.dataset.o;
    const q = questions[qi] || {};
    const multi = !!q.multiSelect;
    const group = card.querySelector(`.askq[data-q="${qi}"]`);
    const free = group.querySelector('.askfree');
    if (free) free.value = '';        // tapping an option clears a half-typed answer
    if (!multi) group.querySelectorAll('button').forEach(x => x.classList.remove('on'));
    b.classList.toggle('on', multi ? !b.classList.contains('on') : true);

    const chosen = [...group.querySelectorAll('button.on')]
      .map(x => (q.options[+x.dataset.o] || {}).label);
    if (chosen.length) picked[q.question] = chosen.join(', ');
    else delete picked[q.question];
    // Every question needs an answer before this can be sent back.
    sendBtn2.disabled = questions.some(qq => !picked[qq.question]);
  });

  pending.appendChild(card);
  scroll(true);
}

/* ---------- interrupted turns ---------- */
/* Deliberately not auto-resent: the session resumes, so Claude may already have handled it
   and resending would duplicate the turn. The user decides. */
function renderInterrupted(e) {
  const card = node('perm');
  card.id = `intr-${e.id}`;
  card.innerHTML = `
    <h4>This turn was interrupted</h4>
    <div class="why">Interrupted mid-turn — a restart, a dropped connection, or a usage
      limit cutting the reply short. It may or may not have been processed — resend only
      if Claude never replied.</div>
    <div class="path">${esc((e.text || '').slice(0, 200))}</div>
    <div class="btns">
      <button class="allow" data-resend="1">Resend</button>
      <button class="deny" data-drop="1">Dismiss</button>
    </div>`;
  card.addEventListener('click', ev => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.resend) post('/prompt', { text: e.text });
    // Clear it server-side too. Dismiss used to only remove the card, so the entry stayed
    // INTERRUPTED on disk and came straight back after the next restart.
    post('/turn/resolve', { id: e.id });
    card.remove();
  });
  pending.appendChild(card);
  scroll(true);
}

/* ---------- build cards ---------- */
function startBuild(e) {
  const card = node('build');
  card.innerHTML = `<div class="head"><span>Building ${esc(e.project)}</span>
                    <span class="state">…</span></div><pre><code></code></pre>`;
  add(card);
  builds.set('current', card);
}
function appendBuild(line) {
  const card = builds.get('current');
  if (!card) return;
  const code = card.querySelector('code');
  code.textContent += line + '\n';
  code.parentElement.scrollTop = code.parentElement.scrollHeight;
  scroll();
}
function endBuild(e) {
  const card = builds.get('current');
  if (!card) return;
  const state = card.querySelector('.state');
  state.textContent = e.ok ? `done in ${e.seconds}s` : 'failed';
  state.className = 'state ' + (e.ok ? 'ok' : 'bad');
  if (e.ok && e.android_path) {
    const a = document.createElement('a');
    a.className = 'install';
    a.textContent = 'Install APK';
    a.href = '#';
    a.onclick = ev => {
      ev.preventDefault();
      if (window.Forge && window.Forge.install) window.Forge.install(e.android_path);
      else banner(`Open ${e.android_path} in Files to install.`);
    };
    card.appendChild(a);
  }
  builds.delete('current');
  scroll();
}

/* ---------- chrome ---------- */
function setDot(state) { dot.className = 'dot ' + state; }

/* Transient by default, sticky only where the condition outlives the message.
 *
 * Every banner used to persist until something else happened to replace it, so a one-off
 * notice -- "Clipboard is empty", "Could not delete" -- stayed on screen indefinitely. The
 * ones that should persist are the ones describing a state you are still in: a dead
 * connection, a held reload, a queued send. Those pass sticky, and are cleared explicitly
 * when the state ends.
 */
let bannerTimer = null;

function banner(msg, onTap, sticky) {
  clearTimeout(bannerTimer);
  const old = document.getElementById('banner');
  if (old) old.remove();
  if (!msg) return;
  const b = node('banner', esc(msg));
  b.id = 'banner';
  // A tappable banner is an action to take, so it waits for the user either way.
  if (!sticky && !onTap) bannerTimer = setTimeout(() => banner(null), 4500);
  if (onTap) {
    // A pending update the user cannot trigger themselves is a trap: if the turn never
    // reaches turn_end (a restart kills it first), the reload never comes and they are
    // stranded on stale code with no way out.
    b.classList.add('tappable');
    b.addEventListener('click', onTap);
  }
  pending.prepend(b);
}

/* Swapping the <link> repaints in place: transcript, scroll position and the in-flight turn
   all survive. A full reload was only ever needed because JS cannot be replaced live. */
function swapStyles() {
  const link = document.querySelector('link[rel="stylesheet"]');
  if (!link) return;
  const fresh = link.cloneNode(false);
  fresh.href = `/ui/style.css?v=${Date.now()}`;
  fresh.addEventListener('load', () => link.remove(), { once: true });
  link.parentNode.insertBefore(fresh, link.nextSibling);
}

/* The renderer's twin of swapStyles(), and the reason a markup change no longer costs a reload.
 *
 * Re-evaluating render.js reassigns window.FR, which every call site already reaches through a
 * forwarder, so the next message renders with the new code while the transcript, the scroll
 * position, the composer draft and the in-flight turn are all untouched. Nothing is torn down
 * because there is nothing to tear down: render.js is pure functions by rule.
 *
 * Removing the <script> afterwards does not undo the assignment -- evaluation has already
 * happened -- it only stops <head> collecting one dead tag per edit.
 *
 * What this does NOT do is re-render what is already on screen: messages keep the markup they
 * were built with, so a restyle appears from the next message down. Re-rendering the resident
 * transcript needs the source events, and the windowing deliberately keeps those on the daemon
 * rather than in the page, so it is a separate fetch and a separate job.
 */
function swapRender() {
  const s = document.createElement('script');
  s.src = `/ui/render.js?v=${Date.now()}`;
  s.addEventListener('load', () => s.remove(), { once: true });
  // A renderer that fails to load leaves the previous window.FR in place, so the page keeps
  // working with stale markup. Say so rather than letting the edit look applied.
  s.addEventListener('error', () => {
    s.remove();
    banner('Renderer failed to load — still showing the previous one.', null, true);
  }, { once: true });
  document.head.appendChild(s);
}

/* Live-only events. The authoritative current state for these comes from /state on load
   (pending permissions, interrupted turns), never from replayed history. */
const LIVE_ONLY = new Set([
  'exec_start', 'exec_log', 'exec_end',
  'turn_interrupted', 'permission_request', 'permission_resolved',
  'ask_request', 'ask_resolved', 'classifying',
]);

/* Windows arrive one at a time, so accumulate rather than replace. */
let gaugeWindows = {};
let routingNote = null;

function resetsIn(ts) {
  if (!ts) return '';
  // The CLI sends seconds; tolerate milliseconds so a unit change doesn't print "in 20000h".
  const ms = (ts > 1e12 ? ts : ts * 1000) - Date.now();
  if (ms <= 0) return '';
  const mins = Math.round(ms / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/* Human labels for the CLI's window names, and the order to show them in. */
const WINDOW_LABELS = {
  five_hour: '5-hour',
  seven_day: '7-day (all models)',
  seven_day_opus: '7-day (Opus)',
  seven_day_sonnet: '7-day (Sonnet)',
  overage: 'Overage',
};
const WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'overage'];

let lastWindows = null;

function untilReset(resetsAt) {
  if (!resetsAt) return '';
  const secs = resetsAt - Math.floor(Date.now() / 1000);
  if (secs <= 0) return 'resetting';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return h ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

function openUsage() {
  showSheet('Usage limits', 'list');
  if (!lastWindows || !Object.keys(lastWindows).length) {
    list.innerHTML = `<div class="empty">No usage data yet. Claude reports limits when
      they change, so this fills in as you use the session.</div>`;
    return;
  }
  if (routingNote) {
    const r = routingNote;
    list.innerHTML = `<div class="usage"><div class="usage-top">
        <span>Routing</span><span class="usage-pct">${esc(r.model)} · ${esc(r.effort)}</span>
      </div><div class="usage-sub">${esc(r.note || '')}</div></div>`;
  }
  const names = WINDOW_ORDER.filter(n => lastWindows[n])
    .concat(Object.keys(lastWindows).filter(n => !WINDOW_ORDER.includes(n)));
  list.innerHTML += names.map(name => {
    const w = lastWindows[name];
    const pct = Math.round((w.utilization || 0) * 100);
    const when = untilReset(w.resets_at);
    // Shown as used/remaining because "how much is left" is the actual question.
    return `<div class="usage">
      <div class="usage-top">
        <span>${esc(WINDOW_LABELS[name] || name)}</span>
        <span class="usage-pct">${100 - pct}% left</span>
      </div>
      <div class="usage-bar"><span style="width:${pct}%"></span></div>
      <div class="usage-sub">${pct}% used${when ? ` · ${esc(when)}` : ''}</div>
    </div>`;
  }).join('');
}

function renderGauge(windows) {
  lastWindows = windows || lastWindows;
  Object.assign(gaugeWindows, windows || {});
  const entries = Object.entries(gaugeWindows)
    .filter(([, w]) => w && typeof w.utilization === 'number');
  if (!entries.length) return;

  // Show the window closest to its limit: that is the one that will actually stop you.
  const [name, w] = entries.reduce((a, b) => (b[1].utilization > a[1].utilization ? b : a));
  const pct = Math.round(w.utilization * 100);
  gauge.hidden = false;
  gaugeFill.style.width = Math.min(pct, 100) + '%';
  gauge.classList.toggle('warn', pct >= 70 && pct < 90);
  gauge.classList.toggle('hot', pct >= 90);

  const short = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d opus',
                  seven_day_sonnet: '7d sonnet', overage: 'overage' }[name] || name;
  const left = resetsIn(w.resets_at);
  gaugeLabel.textContent = `${short} ${pct}%` + (left ? ` · ${left}` : '');
  gauge.title = entries
    .map(([n, x]) => `${n}: ${Math.round(x.utilization * 100)}% used` +
                     (resetsIn(x.resets_at) ? `, resets in ${resetsIn(x.resets_at)}` : ''))
    .join('\n');
}

function renderTitle() {
  titleBtn.textContent = currentModel ? `Forge · ${currentModel}` : 'Forge';
}

/* ---------- sheets ---------- */
function closeSheet() {
  setTimeout(renderCaret, 0);
  sheet.hidden = true;
  backdrop.hidden = true;
}

function showSheet(title, mode) {
  setTimeout(renderCaret, 0);
  sheetTitle.textContent = title;
  sheet.hidden = false;
  backdrop.hidden = false;
  shots.hidden = mode !== 'shots';
  caps.hidden = mode !== 'caps';
  list.hidden = mode !== 'list';
  shell.hidden = mode !== 'shell';
}

function openShell() {
  showSheet('Shell', 'shell');
  shellIn.focus();
}

function shellWrite(text, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text + '\n';
  shellOut.appendChild(span);
  shellOut.parentElement.scrollTop = shellOut.parentElement.scrollHeight;
}

function runShell() {
  const command = shellIn.value.trim();
  if (!command) return;
  shellWrite('$ ' + command, 'code-ok');
  shellIn.value = '';
  post('/exec', { command });
}

/* Switching down a model is the main lever against usage limits, so it lives one tap from
   the conversation rather than buried in settings. */
/* Grouped, because three different kinds of thing were rendering identically: a one-shot
   action, a persistent toggle and an exclusive choice all looked like the same row. Nothing
   told you that tapping "opus" picks one of four, while tapping "Reload interface" just
   happens. Sections separate the kinds; a tick marks what is currently chosen; toggles carry
   their own state on the right. */
/* ---------- settings sheet ---------- */
/* Model and effort used to be nine rows stacked in the root sheet, which buried the two
   toggles and the one action underneath them and made the whole thing a wall. A settings
   screen should show the current state and let you go and change it, not enumerate every
   option you are not choosing. */

const MODELS = [
  ['opus', 'Most capable. Burns the limit fastest.'],
  ['sonnet', 'Close on code. Much cheaper per turn.'],
  ['haiku', 'Fast and cheapest. Good for small edits.'],
  ['default', 'Whatever your Claude config specifies.'],
];
const EFFORTS = [
  ['low', 'Minimal thinking, fastest replies.'],
  ['medium', 'Moderate thinking.'],
  ['high', 'Deep reasoning. This is the default.'],
  ['xhigh', 'Extended depth. Opus only; falls back to high elsewhere.'],
  ['max', 'Maximum effort.'],
];

function modelLabel() {
  const m = chosenModel || currentModel || '';
  const hit = MODELS.find(([n]) => m.startsWith(n));
  return hit ? hit[0] : (m || 'default');
}

function section(text) {
  const h = document.createElement('div');
  h.className = 'list-head';
  h.textContent = text;
  list.appendChild(h);
}

/* Shows the setting and its current value on one line, and opens the picker. The value on
   the right is the point: it is what you came to check most of the time. */
function summary(label, value, onOpen) {
  const b = document.createElement('button');
  b.className = 'row-summary';
  b.innerHTML = `<span class="row-body">${esc(label)}</span>`
    + `<span class="row-value">${esc(value)}</span><span class="row-chev">\u203a</span>`;
  b.onclick = onOpen;
  list.appendChild(b);
}

function toggleRow(label, sub, on, onFlip) {
  const b = document.createElement('button');
  b.className = 'row-toggle';
  b.innerHTML = `<span class="row-body">${esc(label)}<span class="sub">${esc(sub)}</span></span>`
    + `<span class="row-state ${on ? 'on' : ''}">${on ? 'On' : 'Off'}</span>`;
  b.onclick = onFlip;
  list.appendChild(b);
}

/* One picker for both axes. They differ only in their options, what counts as selected, and
   what to POST -- so writing it twice would have been two places to fix every later time. */
function openPicker(kind) {
  const isModel = kind === 'model';
  showSheet(isModel ? 'Model' : 'Reasoning effort', 'list');
  list.innerHTML = '';

  const back = document.createElement('button');
  back.className = 'row-back';
  back.innerHTML = '\u2039 Settings';
  back.onclick = openModels;
  list.appendChild(back);

  if (!isModel) {
    // Effort is read once when the CLI subprocess spawns, so on a running chat it applies to
    // the next one. On an unstarted chat nothing has spawned and the pick simply is its effort.
    section(presetMode ? 'Applies to this new chat' : 'Applies when a chat next starts');
  } else if (presetMode) {
    section('Presetting this new chat');
  }

  const options = isModel ? MODELS : EFFORTS;
  const btns = [];
  for (const [name, blurb] of options) {
    const sel = isModel ? modelLabel() === name : currentEffort === name;
    const b = document.createElement('button');
    if (sel) b.className = 'current';
    b.innerHTML = `<span class="row-tick">${sel ? '\u2713' : ''}</span>`
      + `<span class="row-body">${esc(name)}<span class="sub">${esc(blurb)}</span></span>`;
    b.onclick = () => {
      if (isModel) {
        // Reflect the tap at once: waiting for model_changed to return left the title
        // showing the old model, which reads as the pick having been rejected.
        if (name !== 'default') { currentModel = short(name); renderTitle(); }
        chosenModel = name === 'default' ? '' : name;
        post('/model', { model: name });
      } else {
        currentEffort = name;
        post('/model', { effort: name });
      }
      for (const o of btns) {
        o.classList.remove('current');
        o.querySelector('.row-tick').textContent = '';
      }
      b.classList.add('current');
      b.querySelector('.row-tick').textContent = '\u2713';
    };
    btns.push(b);
    list.appendChild(b);
  }

  const done = document.createElement('button');
  done.className = 'list-done';
  done.textContent = 'Done';
  done.onclick = closeSheet;
  list.appendChild(done);
}

function openModels() {
  showSheet('Settings', 'list');
  list.innerHTML = '';

  section('Model & effort');
  summary('Model', modelLabel(), () => openPicker('model'));
  summary('Reasoning effort', currentEffort || 'high', () => openPicker('effort'));

  section('Interface');
  toggleRow('Immersive mode', 'Hide the status and navigation bars', immersiveOn, () => {
    setImmersive(!immersiveOn);
    closeSheet();
  });
  if (nativeShell) {
    toggleRow('In-app keyboard',
              'Drawn in the page: hot-reloads, has a symbol row, no dictation',
              !prefersNative, () => { setKbdPreference(prefersNative); closeSheet(); });
  }

  section('Actions');
  const reload = document.createElement('button');
  reload.innerHTML = '<span class="row-body">Reload interface'
    + '<span class="sub">Fetch the latest UI and redraw</span></span>';
  reload.onclick = () => {
    closeSheet();
    if (nativeShell) shellCall('reload'); else location.reload();
  };
  list.appendChild(reload);

  const done = document.createElement('button');
  done.className = 'list-done';
  done.textContent = 'Done';
  done.onclick = closeSheet;
  list.appendChild(done);
}

/* The only durable switch between the two keyboards, and the only way back from the symbol
   row's escape hatch. */
function setKbdPreference(useInApp) {
  prefersNative = !useInApp;
  try { localStorage.setItem('forge.kbd', useInApp ? '1' : '0'); } catch {}
  // Editable only for the system keyboard: that is the whole trade. In-app mode gives up
  // native editing to be rid of the insertion handle and the text drag that came with it.
  setComposerEditable(!useInApp);
  for (const el of FIELDS) el.setAttribute('inputmode', useInApp ? 'none' : 'text');
  kbdSetOn(useInApp, true);
  if (!useInApp) {
    kbd.hidden = true;
    // Re-acquire focus so the system keyboard is actually summoned: inputmode is consulted
    // when focus is gained, never while it is held.
    const el = kbdTarget();
    el.blur();
    setTimeout(() => el.focus({ preventScroll: true }), 0);
  }
}

/* Fires for the system keyboard too, which edits the element directly rather than going
   through kbdInsert. */
document.getElementById('input').addEventListener('input', () => updateCmdMenu());

/* ---------- copying from the transcript ----------
 *
 * Suppressing the action mode is per-WebView, so it removed Copy from the whole page, not
 * just the composer -- selecting a reply left nothing to act on. The composer could replace
 * it because its text is one flat string; a transcript is nested markup, and a general
 * selection engine over that is a great deal of machinery for a phone.
 *
 * Blocks are what actually gets copied here anyway: a reply, a code block, a tool's output.
 * So a long press offers those directly, which is fewer gestures than selecting them by hand
 * would have been even when that worked.
 */
function blockAt(target) {
  if (!target || !target.closest) return null;
  // Innermost first: inside a code block you almost never want the whole message.
  return target.closest('pre, .tool .tbody, .msg.user, .msg.claude, .build');
}

function labelFor(el) {
  if (el.tagName === 'PRE') return 'Copy code';
  if (el.classList.contains('tbody')) return 'Copy output';
  if (el.classList.contains('user')) return 'Copy your message';
  return 'Copy reply';
}

function flashCopied(el) {
  el.classList.add('copied');
  setTimeout(() => el.classList.remove('copied'), 420);
}

let feedPressTimer = null;
const cancelFeedPress = () => { clearTimeout(feedPressTimer); feedPressTimer = null; };

feed.addEventListener('touchstart', (ev) => {
  const t = ev.touches[0];
  const block = blockAt(ev.target);
  if (!block) return;
  feedPressTimer = setTimeout(() => {
    swallowClick = true;
    txtTarget = null;
    txtMenu.innerHTML = '';

    const add = (label, text, extra) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => {
        txtMenu.hidden = true;
        copyOut(text);
        flashCopied(extra || block);
      };
      txtMenu.appendChild(b);
    };

    add(labelFor(block), block.innerText.trim());
    // A code block inside a reply: offer the reply too, since the press landed on both.
    const outer = block.parentElement && block.parentElement.closest('.msg.claude, .tool');
    if (outer && outer !== block) {
      add(outer.classList.contains('tool') ? 'Copy whole card' : 'Copy whole reply',
          outer.innerText.trim(), outer);
    }

    txtMenu.hidden = false;
    const w = txtMenu.offsetWidth || 200;
    txtMenu.style.left =
      Math.max(8, Math.min(window.innerWidth - w - 8, t.clientX - w / 2)) + 'px';
    txtMenu.style.top = Math.max(8, t.clientY - 58) + 'px';
  }, 450);
}, { passive: true });

feed.addEventListener('touchmove', cancelFeedPress, { passive: true });
feed.addEventListener('touchend', cancelFeedPress, { passive: true });

/* ---------- slash command picker ----------
 *
 * Typing / in an empty composer offers the commands this session actually has. The list
 * comes from the daemon, which reads it off disk, because skills arrive by syncing and by
 * installing plugins -- a list baked into the client would be stale the first time either
 * happened.
 *
 * Only at the very start of the message: a slash anywhere else is a path, and paths are
 * most of what gets typed here.
 */
const cmdMenu = document.createElement('div');
cmdMenu.className = 'cmd-menu';
cmdMenu.hidden = true;
document.body.appendChild(cmdMenu);

let commandList = null;
let cmdIndex = 0;

async function loadCommands() {
  if (commandList) return commandList;
  try {
    const r = await fetch('/commands');
    commandList = r.ok ? (await r.json()).items || [] : [];
  } catch {
    commandList = [];
  }
  return commandList;
}

function hideCmdMenu() { cmdMenu.hidden = true; }

async function updateCmdMenu() {
  const el = document.getElementById('input');
  const text = fText(el);
  const m = /^\/([a-zA-Z0-9-]*)$/.exec(text);
  if (!m) { hideCmdMenu(); return; }

  const items = (await loadCommands())
    .filter((c) => c.name.startsWith(m[1]))
    .slice(0, 8);
  if (!items.length) { hideCmdMenu(); return; }

  cmdIndex = 0;
  cmdMenu.innerHTML = '';
  for (const c of items) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="cmd-name">/${esc(c.name)}</span>`
      + (c.description ? `<span class="cmd-desc">${esc(c.description)}</span>` : '');
    b.onclick = () => {
      fSetText(el, '/' + c.name + ' ');
      fSetSel(el, c.name.length + 2);
      hideCmdMenu();
      saveDraft();
    };
    cmdMenu.appendChild(b);
  }

  // Above the composer, like every other popup here, and never over the transcript's tail.
  const box = document.getElementById('composer').getBoundingClientRect();
  cmdMenu.hidden = false;
  cmdMenu.style.bottom = (window.innerHeight - box.top + 6) + 'px';
}

/* ---------- text actions ---------- */
/* Native owns selection; this owns the one case native refuses.
 *
 * Three arrangements were tried. Both at once overlapped. Fully native has no Paste on an
 * empty field -- the case that started this. Fully in-page suppressed the action mode, and
 * Chromium ties the selection handles to it, so killing the bar killed the ability to select
 * text at all, which also took Cut with it.
 *
 * The split that works follows from when each side acts: Android starts a selection action
 * mode only when there is text to select, and does nothing on an empty field. So this fires
 * only on an empty field, where nothing else will, and stays out of the way entirely once
 * there is anything to select.
 */
const txtMenu = document.createElement('div');
txtMenu.className = 'txt-menu';
txtMenu.hidden = true;
document.body.appendChild(txtMenu);

let txtTarget = null;

function hideTxtMenu() { clearSelUI(); }

function txtFields() {
  return ['input', 'chatSearch', 'shellIn']
    .map((id) => document.getElementById(id)).filter(Boolean);
}

function applyEdit(el, value, caret) {
  markDeliberateClear();   // Cut can legitimately empty the field
  fSetText(el, value);
  fSetSel(el, caret, caret);
  // Writing .value fires no input event, so the composer would not resize and the search box
  // would not re-run its query. Same reason it must save its own draft here: nothing else will.
  if (el.id === 'input') { autosize(); saveDraft(); }
  else el.dispatchEvent(new Event('input', { bubbles: true }));
}

/* Chromium drags selected text.
 *
 * Long-pressing on a selection and moving even a few pixels starts a native text drag, which
 * drops a copy at the caret -- so a hold that wandered slightly duplicated whatever was
 * selected, repeatedly. It is unrelated to the action mode, so suppressing that did nothing
 * for it. We own selection now, and a drag inside the composer means "adjust the selection",
 * never "move the text".
 */
for (const el of ['input', 'chatSearch', 'shellIn']
     .map((id) => document.getElementById(id)).filter(Boolean)) {
  el.addEventListener('dragstart', (ev) => ev.preventDefault());
  el.addEventListener('drop', (ev) => ev.preventDefault());
}

/* Character offset under a touch. Only possible because the composer is an editable div:
   in a textarea the text is not in the DOM and caretRangeFromPoint returns the element. */
function offsetFromPoint(el, x, y) {
  const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
  if (!r || !el.contains(r.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}

/* A word is a run of non-space. Deliberately not \w: paths, flags and URLs are single units
   to anyone selecting them, and splitting "--on-active" into three is never what was meant. */
function wordAt(text, i) {
  let a = Math.min(i, Math.max(0, text.length - 1));
  let b = a;
  if (!text.length) return [0, 0];
  if (!/\S/.test(text[a] || '')) { a = Math.max(0, a - 1); b = a; }
  while (a > 0 && /\S/.test(text[a - 1])) a--;
  while (b < text.length && /\S/.test(text[b])) b++;
  return [a, b];
}

/* Viewport rects of the selection's two ends, for placing the handles and the menu. */
function selEdges() {
  const el = document.getElementById('input');
  if (el && !el.isContentEditable) {
    // Measured from our own offsets, for the same reason we paint from them: there is no
    // browser selection here to ask.
    if (ceSelEnd <= ceCaret) return null;
    const a = rangeAt(el, ceCaret, ceCaret);
    const b = rangeAt(el, ceSelEnd, ceSelEnd);
    return [a.getClientRects()[0] || a.getBoundingClientRect(),
            b.getClientRects()[0] || b.getBoundingClientRect()];
  }
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const a = r.cloneRange(); a.collapse(true);
  const b = r.cloneRange(); b.collapse(false);
  const ra = a.getClientRects()[0] || a.getBoundingClientRect();
  const rb = b.getClientRects()[0] || b.getBoundingClientRect();
  return [ra, rb];
}

function placeTxtMenu(x, y) {
  txtMenu.hidden = false;
  // Above the touch and inside the viewport: under the thumb it cannot be read, past the
  // edge it cannot be reached.
  const w = txtMenu.offsetWidth || 200;
  txtMenu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2)) + 'px';
  txtMenu.style.top = Math.max(8, y - 58) + 'px';
}

function copyOut(text) {
  const res = native.clipboard({ op: 'set', text });
  // Belt and braces: whichever transport exists should end up holding it, so a later paste
  // finds it through either.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try { navigator.clipboard.writeText(text).catch(() => {}); } catch {}
  }
  if (!res && !(navigator.clipboard && navigator.clipboard.writeText)) {
    banner('Could not reach the clipboard.');
  }
}

function buildTxtMenu(el) {
  const v = fText(el);
  const [start, end] = fSel(el);
  const hasSel = end > start;
  const actions = [];
  if (hasSel) {
    actions.push(['Cut', () => {
      copyOut(v.slice(start, end));
      applyEdit(el, v.slice(0, start) + v.slice(end), start);
      clearSelUI();
    }]);
    actions.push(['Copy', () => {
      copyOut(v.slice(start, end));
      clearSelUI();
    }]);
  }
  actions.push(['Paste', async () => {
    /* Two sources, because either can be unavailable.
     *
     * The bridge is the reliable one inside the APK -- the guest and Android share no
     * clipboard otherwise -- but it returns null when the page is open in a plain browser,
     * and navigator.clipboard is the other way round: present in the browser, and in a
     * WebView it can reject outright depending on permissions. Trying one and reporting
     * "Clipboard is empty" on failure blamed the clipboard for a missing transport. */
    let text = '';
    const res = native.clipboard({ op: 'get' });
    if (res && res.text) text = res.text;
    if (!text && navigator.clipboard && navigator.clipboard.readText) {
      try { text = (await navigator.clipboard.readText()) || ''; } catch {}
    }
    if (!text) {
      banner(res ? 'Clipboard is empty.' : 'Cannot read the clipboard from here.');
      return;
    }
    applyEdit(el, v.slice(0, start) + text + v.slice(end), start + text.length);
    clearSelUI();
  }]);
  if (v.length && !(start === 0 && end === v.length)) {
    actions.push(['Select all', () => {
      // Re-read rather than using the snapshot this menu was built from: a handle drag or an
      // edit between building and tapping would make that length wrong, and selecting to a
      // stale end is exactly "Select all does not select all".
      el.focus({ preventScroll: true });
      fSetSel(el, 0, fText(el).length);
      showSelUI(el);
    }]);
  }

  txtMenu.innerHTML = '';
  for (const [label, fn] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { txtMenu.hidden = true; el.focus({ preventScroll: true }); fn(); };
    txtMenu.appendChild(b);
  }
}

/* ---- our own selection handles ----
 * Chromium draws its handles as part of the action mode, so owning selection means drawing
 * them. Two divs at the selection's ends, dragged to move that end while the other stays put.
 */
const handles = [0, 1].map((i) => {
  const h = document.createElement('div');
  h.className = 'sel-handle';
  h.hidden = true;
  document.body.appendChild(h);
  h.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    h.setPointerCapture(ev.pointerId);
    h.dragging = true;
  });
  h.addEventListener('pointermove', (ev) => {
    if (!h.dragging || !txtTarget) return;
    const at = offsetFromPoint(txtTarget, ev.clientX, ev.clientY - 14);
    if (at === null) return;
    const [s, e] = fSel(txtTarget);
    // Dragging one end past the other swaps which is which, exactly as it should.
    const next = i === 0 ? [Math.min(at, e), e] : [s, Math.max(at, s)];
    fSetSel(txtTarget, next[0], next[1]);
    positionHandles();
  });
  h.addEventListener('pointerup', () => {
    h.dragging = false;
    if (txtTarget) { buildTxtMenu(txtTarget); positionHandles(); }
  });
  return h;
});

function positionHandles() {
  paintSelection();
  const edges = selEdges();
  if (!edges) return;
  const [a, b] = edges;
  const [s0, e0] = txtTarget ? fSel(txtTarget) : [0, 0];
  if (e0 <= s0) {                      // collapsed: two handles on one caret is just clutter
    handles[0].hidden = handles[1].hidden = true;
    return;
  }
  handles[0].hidden = handles[1].hidden = false;
  handles[0].style.left = (a.left - 11) + 'px';
  handles[0].style.top = a.bottom + 'px';
  handles[1].style.left = (b.left - 11) + 'px';
  handles[1].style.top = b.bottom + 'px';
  /* Above the composer, not above the selection.
   *
   * The composer sits at the bottom of the screen, so "just above the selected word" is the
   * row of action chips -- the menu landed on Screenshot, Shell, Build APK and Stop. Pinning
   * it above the composer costs nothing: the space up there is transcript, which is already
   * scrolled away from whatever is being edited. */
  const top = document.getElementById('composer').getBoundingClientRect().top;
  placeTxtMenu((a.left + b.right) / 2, top - 6);
}

function clearSelUI() {
  handles[0].hidden = handles[1].hidden = true;
  txtMenu.hidden = true;
  txtTarget = null;
  ceSelEnd = ceCaret;
  paintSelection();
  renderCaret();
}

function showSelUI(el) {
  txtTarget = el;
  buildTxtMenu(el);
  positionHandles();
}

function showTxtMenu(el, x, y) {
  el.focus({ preventScroll: true });
  txtTarget = el;
  const v = fText(el);
  if (!v.length) {
    // Nothing to select: the menu is Paste alone, at the finger.
    buildTxtMenu(el);
    placeTxtMenu(x, y);
    handles[0].hidden = handles[1].hidden = true;
    return;
  }
  // Select the word under the finger, which is what a long press means everywhere else.
  const at = offsetFromPoint(el, x, y);
  const [a, b] = at === null ? [0, v.length] : wordAt(v, at);
  fSetSel(el, a, b);
  showSelUI(el);
}

for (const el of txtFields()) {
  let timer = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('touchstart', (ev) => {
    const t = ev.touches[0];
    timer = setTimeout(() => {
      swallowClick = true;
      showTxtMenu(el, t.clientX, t.clientY);
    }, 450);
  }, { passive: true });
  el.addEventListener('touchmove', cancel, { passive: true });
  el.addEventListener('touchend', cancel, { passive: true });
}

document.addEventListener('pointerdown', (ev) => {
  if (txtMenu.hidden && handles[0].hidden) return;
  // The transcript's copy menu has no selection behind it, so there is nothing to preserve.
  if (!txtTarget && !txtMenu.contains(ev.target)) { txtMenu.hidden = true; return; }
  if (txtMenu.contains(ev.target) || handles.includes(ev.target)) return;
  /* A key press must not clear the selection, because replacing it is the entire point.
   *
   * This handler fires on any pointerdown outside the menu, and a keyboard key is outside
   * the menu -- so the selection was gone before the keypress arrived, and typing inserted
   * at the caret instead of replacing what was selected. Backspace the same. The menu and
   * handles still go; only the offsets survive, long enough for the edit to consume them. */
  if (ev.target.closest && ev.target.closest('#kbd')) {
    txtMenu.hidden = true;
    handles[0].hidden = handles[1].hidden = true;
    return;
  }
  clearSelUI();
}, true);

/* ---------- chat drawer ---------- */
const drawer = document.getElementById('drawer');
const chatList = document.getElementById('chatList');

const DRAWER_W = () => drawer.getBoundingClientRect().width || 300;

/* Last list we successfully fetched. Painting it synchronously is the difference between
   the drawer arriving full and the drawer arriving with "Loading..." in it -- the slide is
   160ms and a round trip is not reliably faster than that on this link. */
let chatCache = null;

function openDrawer() {
  setTimeout(renderCaret, 0);
  drawer.style.transform = '';
  if (chatTotal) renderWindow();              // instant, from what is held
  drawer.classList.add('open');
  backdrop.hidden = false;
  refreshChats();                             // then reconcile in the background
}

function closeDrawer() {
  setTimeout(renderCaret, 0);
  drawer.style.transform = '';
  drawer.classList.remove('open');
  if (sheet.hidden) backdrop.hidden = true;   // the sheet may still want it
}

const chatSearch = document.getElementById('chatSearch');
const dupHint = document.getElementById('dupHint');
let showArchived = false;
let searchTimer = null;

/* Send UI exceptions to the daemon log.
 *
 * The guest cannot see the browser's console, so every JS error so far has been diagnosed by
 * inference from screenshots -- which is how a stuck spinner took three rounds to explain.
 * /diag already exists for exactly this: facts the VM cannot observe, reported by the client.
 * One line in journalctl beats any amount of reasoning about what might have thrown.
 */
function reportError(where, err) {
  try {
    const payload = {
      kind: 'ui_error', where,
      message: String((err && err.message) || err),
      stack: String((err && err.stack) || '').slice(0, 800),
      url: location.pathname,
    };
    fetch('/diag', { method: 'POST', headers: { 'content-type': 'application/json' },
                     body: JSON.stringify(payload) }).catch(() => {});
  } catch {}
}

window.addEventListener('error', ev => reportError('window', ev.error || ev.message));
window.addEventListener('unhandledrejection',
  ev => reportError('promise', ev.reason));

/* ---------- virtualised chat list ----------
 *
 * The same idea as the transcript window, but a far simpler mechanism, because rows here are
 * a uniform height. In the transcript a node is anywhere from 44px to 400px and its height is
 * unknown until it renders, which is what made anchoring hard enough to get wrong five times.
 * A list of fixed-height rows can be computed exactly instead: total height is count * ROW_H,
 * the rows to show are derived from scrollTop by arithmetic, and unloaded regions are plain
 * spacer divs. Nothing is anchored because nothing ever moves.
 *
 * Pages are fetched on demand and evicted once they are far from view, so both the DOM and
 * the memory stay flat no matter how many thousands of chats exist.
 */
const ROW_H = 54;           // must match .chat-list button in the stylesheet
const CHAT_PAGE = 50;
const KEEP_PAGES = 3;       // around the viewport; the rest is discarded and re-fetched

const pages = new Map();    // pageIndex -> array of chats
let chatTotal = 0;
let chatMeta = null;        // last response's counters
let pageLoading = new Set();

const topSpacer = document.createElement('div');
const botSpacer = document.createElement('div');
const rowHost = document.createElement('div');
const stickyLabel = document.createElement('div');
stickyLabel.className = 'bucket sticky';

/* Bumped on every reset. A request in flight when the filter changes would otherwise land
   in the new view's page map -- archived rows appearing under Recents, or a stale `total`
   sizing the spacers for a set that is no longer displayed. The response cannot be
   cancelled, so it is stamped and discarded on arrival instead. */
let listGen = 0;

/* Each filter keeps its own scroll position. Sharing one was the actual hazard in sharing a
   virtual list: the page cache is cleared on every switch, but scrollTop was not, so
   arriving in a five-item Archived view while scrolled to row 300 of Recents left the window
   asking for rows that do not exist -- nothing rendered, a 16,000px spacer held scrollHeight
   open so the browser never clamped back, and the list stayed blank permanently. */
const listMemory = new Map();          // 'recents' | 'archived' -> { total, scrollTop }
const listKey = () => (showArchived ? 'archived' : 'recents');

function rememberList() {
  if (chatSearch.value.trim()) return; // search is ephemeral; it has no position worth keeping
  listMemory.set(listKey(), { total: chatTotal, scrollTop: chatList.scrollTop });
}

function resetChatList() {
  listGen++;
  pages.clear();
  pageLoading.clear();
  chatTotal = 0;
  chatOffset = 0;
  chatList.scrollTop = 0;
}
let chatOffset = 0;

async function refreshChats() {
  resetChatList();
  // Restore this filter's position before fetching, using the total it had last time so the
  // spacers are the right size immediately. The fetch corrects both a moment later.
  const mem = chatSearch.value.trim() ? null : listMemory.get(listKey());
  let idx = 0;
  if (mem && mem.total) {
    chatTotal = mem.total;
    renderWindow();
    chatList.scrollTop = mem.scrollTop;
    idx = Math.floor(mem.scrollTop / ROW_H / CHAT_PAGE);
  }
  await loadPage(idx, true, 0, true);
}

/* Retries 5xx, because the session host restarting is now a normal event.
 *
 * The auto-reload deliberately bounces the host at idle, and for the second or two it is
 * down the proxy has nothing to forward to. Reporting that as "Couldn't load chats (503)"
 * with no retry turns a two-second gap into a dead drawer that stays dead until reopened --
 * the failure looks permanent because the UI made it permanent. */
async function loadPage(idx, initial, attempt, force) {
  attempt = attempt || 0;
  const gen = listGen;
  if ((pages.has(idx) && !force) || pageLoading.has(idx)) return;
  pageLoading.add(idx);
  let retryIn = 0;
  const q = (chatSearch.value || '').trim();
  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    else if (showArchived) params.set('archived', '1');
    params.set('offset', String(idx * CHAT_PAGE));
    params.set('limit', String(CHAT_PAGE));
    const r = await fetch('/chats?' + params.toString());
    if (!r.ok) {
      if (r.status >= 500 && attempt < 5) {
        retryIn = 500 + attempt * 500;
        if (initial) chatList.innerHTML = '<div class="empty">Reconnecting…</div>';
      } else if (initial) {
        chatList.innerHTML = `<div class="empty">Couldn't load chats (${r.status}).</div>`;
      }
      return;
    }
    const data = await r.json();
    if (gen !== listGen) return;        // the filter changed while this was in flight
    /* Rendering gets its own catch, because a failure here is not a failure to fetch and
       must not be retried as one. pages.set has already happened by the time render runs, so
       the retry hits the `pages.has(idx)` guard at the top, returns immediately, and the
       chain dies -- leaving whatever message was on screen there permanently. That is how a
       transient "Reconnecting..." became a stuck one. */
    try {
      pages.set(idx, data.items || []);
      chatTotal = data.total || 0;
      chatMeta = data;
      chatCache = data.items || [];       // the drawer's instant-repaint cache
      if (initial) renderDupHint(data.duplicates || []);
      renderWindow();
    } catch (err) {
      reportError('chat-list render', err);
      chatList.innerHTML =
        `<div class="empty">Chat list failed to render.<br>${esc(String(err && err.message))}</div>`;
    }
  } catch {
    if (attempt < 5) {
      retryIn = 500 + attempt * 500;
      if (initial) chatList.innerHTML = '<div class="empty">Reconnecting…</div>';
    } else if (initial) {
      chatList.innerHTML = '<div class="empty">Couldn\'t reach the daemon.</div>';
    }
  } finally {
    pageLoading.delete(idx);
    if (retryIn && gen === listGen) {
      setTimeout(() => { if (gen === listGen) loadPage(idx, initial, attempt + 1, true); },
                 retryIn);
    }
  }
}

/* Suggests, never acts. A duplicate is usually evidence that finding the old chat was harder
   than starting a new one, so the fix offered is to put one away -- never to merge
   transcripts, which would destroy the thing you might have wanted from it. */
function renderDupHint(dups) {
  if (!dups || !dups.length) { dupHint.hidden = true; return; }
  const d = dups[0];
  dupHint.hidden = false;
  dupHint.innerHTML = '';
  const t = document.createElement('div');
  t.textContent = `\u201c${d.drop_title}\u201d looks like \u201c${d.keep_title}\u201d`;
  const b = document.createElement('button');
  b.textContent = 'Archive the older one';
  b.onclick = async () => {
    await post(`/chats/${d.drop}/flag`, { archived: true });
    refreshChats();
  };
  dupHint.append(t, b);
}

let searchDebounce = null;
chatSearch.oninput = () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(refreshChats, 180);
};

function bucketOf(c, now) {
  if (c.pinned) return 'Pinned';
  const d = (now - c.last_active_at * 1000) / 86400000;
  if (d < 1) return 'Today';
  if (d < 2) return 'Yesterday';
  if (d < 7) return 'Previous 7 days';
  return 'Older';
}

/* One sticky label instead of inline headers. Headers between rows would break the uniform
   height the arithmetic depends on, and a label that tells you where you are is what the
   headers were for anyway. */
function renderWindow() {
  if (!chatTotal) {
    chatList.innerHTML = '<div class="empty">' +
      (chatSearch.value.trim() ? 'Nothing matches.' : 'No chats yet.') + '</div>';
    return;
  }
  if (!chatList.contains(rowHost)) {
    chatList.innerHTML = '';
    chatList.append(topSpacer, rowHost, botSpacer);
  }

  const view = chatList.clientHeight || 500;
  // Clamped to what exists. Belt and braces alongside the per-filter positions above: any
  // route to an out-of-range scrollTop must degrade to "show the end", never to a blank
  // list propped open by its own spacer.
  const maxFirst = Math.max(0, chatTotal - 1);
  const first = Math.min(maxFirst, Math.max(0, Math.floor(chatList.scrollTop / ROW_H) - 5));
  const last = Math.min(chatTotal, Math.ceil((chatList.scrollTop + view) / ROW_H) + 5);

  const firstPage = Math.floor(first / CHAT_PAGE);
  const lastPage = Math.floor(Math.max(0, last - 1) / CHAT_PAGE);
  for (let i = firstPage; i <= lastPage; i++) loadPage(i);

  // Evict pages the reader has left behind. This is the whole point: without it the map
  // grows to the size of the archive and we have simply moved the leak.
  for (const key of [...pages.keys()]) {
    if (key < firstPage - KEEP_PAGES || key > lastPage + KEEP_PAGES) pages.delete(key);
  }

  rowHost.innerHTML = '';
  let rendered = 0;
  const now = Date.now();
  for (let i = first; i < last; i++) {
    const c = (pages.get(Math.floor(i / CHAT_PAGE)) || [])[i % CHAT_PAGE];
    if (!c) break;                       // page still in flight; spacer covers it
    rowHost.appendChild(chatRow(c));
    rendered++;
  }
  topSpacer.style.height = (first * ROW_H) + 'px';
  botSpacer.style.height = Math.max(0, (chatTotal - first - rendered) * ROW_H) + 'px';

  const top = (pages.get(firstPage) || [])[first % CHAT_PAGE];
  stickyLabel.textContent = top ? bucketOf(top, now) : '';
  if (!chatList.parentNode.contains(stickyLabel)) {
    chatList.parentNode.insertBefore(stickyLabel, chatList);
  }
  stickyLabel.hidden = !!chatSearch.value.trim();

  renderFilters();
}

const fRecents = document.getElementById('fRecents');
const fArchived = document.getElementById('fArchived');

/* Always present, never conditional. The old toggle only rendered when something had
   already been archived, so before the first chat aged out there was no way to reach the
   archive at all -- and no way to discover that archiving existed. A filter you can see is
   also documentation. */
function renderFilters() {
  fRecents.classList.toggle('on', !showArchived);
  fArchived.classList.toggle('on', showArchived);
  const n = chatMeta && chatMeta.archived_count;
  fArchived.textContent = n ? `Archived (${n})` : 'Archived';
}

fRecents.onclick = () => {
  if (!showArchived) return;
  rememberList(); showArchived = false; renderFilters(); refreshChats();
};
fArchived.onclick = () => {
  if (showArchived) return;
  rememberList(); showArchived = true; renderFilters(); refreshChats();
};

chatList.addEventListener('scroll', () => { renderWindow(); rememberList(); },
                          { passive: true });

/* Swipe RIGHT to delete, not left.
 *
 * Left is already taken: on an open drawer a leftward drag closes it, and two gestures that
 * start identically and diverge on distance is how you delete a conversation while trying
 * to put the drawer away. Rightward is unclaimed -- the drawer clamps to its open position
 * and ignores it -- so the two can never be confused.
 */
function chatRow(c) {
  const row = document.createElement('div');
  row.className = 'chat-row';
  const b = document.createElement('button');
  b.className = (c.active ? 'current' : '') + (c.archived ? ' archived' : '');
  b.textContent = (c.pinned ? '📌 ' : '') + (c.title || 'New chat');

  // Long press for the menu. Pin and archive are rare and deliberate, so they belong behind
  // a deliberate gesture rather than taking permanent space on every row.
  let pressTimer = null;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  b.addEventListener('touchstart', () => {
    pressTimer = setTimeout(() => { pressTimer = null; rowMenu(row, c); }, 450);
  }, { passive: true });
  b.addEventListener('touchmove', cancelPress, { passive: true });
  b.addEventListener('touchend', cancelPress, { passive: true });
  b.onclick = async () => {
    closeDrawer();
    if (c.active) return;
    await post(`/chats/${c.id}/switch`, {});
    await loadChatState();
    refreshChats();
  };
  row.appendChild(b);

  // The first conversation's files predate chats and are referenced by three other paths;
  // the server refuses to delete it, so do not offer a gesture that can only fail -- and
  // do not paint the red layer behind it either, which is what `deletable` gates.
  if (c.id === 'default') return row;
  row.className = 'chat-row deletable';

  let sx = 0, sy = 0, on = false;
  b.addEventListener('touchstart', ev => {
    sx = ev.touches[0].clientX; sy = ev.touches[0].clientY; on = false;
  }, { passive: true });
  b.addEventListener('touchmove', ev => {
    const dx = ev.touches[0].clientX - sx;
    const dy = Math.abs(ev.touches[0].clientY - sy);
    if (dx < 0) return;
    if (!on) {
      if (dx < DRAG_MIN || dy > dx) return;   // vertical: it is a scroll
      on = true;
      b.style.transition = 'none';
    }
    b.style.transform = `translateX(${Math.min(dx, 120)}px)`;
    b.style.opacity = String(Math.max(.3, 1 - dx / 200));
  }, { passive: true });
  b.addEventListener('touchend', ev => {
    const dx = ev.changedTouches[0].clientX - sx;
    b.style.transition = ''; b.style.transform = ''; b.style.opacity = '';
    if (on && dx > 88) askDelete(row, c);
    on = false;
  }, { passive: true });
  return row;
}

/* Row actions float over the list, anchored to the row.
 *
 * They used to replace the row's contents, which was fine when the list was ordinary DOM.
 * The virtual list derives every position from a fixed row height, so a row that grows to
 * fit a menu puts every spacer and every index below it out by exactly how much it grew --
 * and the fixed height that prevents that instead clipped the menu. Floating it sidesteps
 * both: the list geometry never changes at all. */
const rowPop = document.getElementById('rowPop');

function closeRowPop() { rowPop.hidden = true; rowPop.innerHTML = ''; }

function openRowPop(row, title, buttons) {
  const dr = drawer.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  rowPop.innerHTML = '';
  const t = document.createElement('div');
  t.className = 'pop-title';
  t.textContent = title;
  const wrap = document.createElement('div');
  wrap.className = 'pop-btns';
  for (const [label, cls, fn] of buttons) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = fn;
    wrap.appendChild(b);
  }
  rowPop.append(t, wrap);
  rowPop.hidden = false;
  // Clamp inside the drawer: a row near the bottom would otherwise open its menu off-screen.
  const h = rowPop.offsetHeight;
  const top = Math.min(Math.max(8, rr.top - dr.top), dr.height - h - 8);
  rowPop.style.top = top + 'px';
}

// Any tap outside dismisses it, including one that lands on another row.
document.addEventListener('pointerdown', ev => {
  if (!rowPop.hidden && !rowPop.contains(ev.target)) closeRowPop();
}, true);

function rowMenu(row, c) {
  const flag = async (body) => {
    closeRowPop();
    await post(`/chats/${c.id}/flag`, body);
    refreshChats();
  };
  openRowPop(row, c.title || 'New chat', [
    [c.pinned ? 'Unpin' : 'Pin', '', () => flag({ pinned: !c.pinned })],
    [c.archived ? 'Unarchive' : 'Archive', '', () => flag({ archived: !c.archived })],
    ['Delete', 'danger', () => askDelete(row, c)],
  ]);
}

/* Deleting a transcript has no undo, so the swipe (or the menu) only arms it and a second
   deliberate tap does it. */
function askDelete(row, c) {
  openRowPop(row, `Delete “${c.title || 'New chat'}”? This cannot be undone.`, [
    ['Cancel', '', closeRowPop],
    ['Delete', 'danger', async () => {
      closeRowPop();
      try {
        const r = await fetch(`/chats/${c.id}`, { method: 'DELETE' });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error || ('HTTP ' + r.status));
        }
      } catch (err) {
        banner('Could not delete — ' + err.message);
      }
      // Indices shift when a row goes, and the window is addressed by index, so re-read.
      await refreshChats();
      // Deleting the active chat switches the host to another one, so the transcript on
      // screen is no longer the transcript the server is serving.
      if (c.active) await loadChatState();
    }],
  ]);
}


/* Creating a chat is not the same as having one. The subprocess does not spawn until the
   first message (the model is fixed at spawn, so it waits for something to classify), which
   means a new chat looks inert -- no greeting, no model in the title bar. Tapping + twice
   used to leave two identical dead "New chat" rows. So: reuse an existing unstarted chat
   rather than making another, and say plainly what the blank screen is waiting for. */
document.getElementById('newChat').onclick = async () => {
  closeDrawer();
  const active = (chatCache || []).find(c => c.active);
  const spare = (chatCache || []).find(c => !c.classified && !c.active);
  if (active && !active.classified) {
    // Already sitting in an unused chat. Making a second one would be indistinguishable
    // from the first, which is how three identical "New chat" rows appeared.
    showNewChatHint();
    return;
  }
  try {
    if (spare) await post(`/chats/${spare.id}/switch`, {});
    else await post('/chats/new', {});
  } catch (e) {
    banner('Could not start a new chat — ' + e.message);
    return;
  }
  await loadChatState();
  refreshChats();                   // repaints in place; the cache is replaced, not blanked
  showNewChatHint();
};

function showNewChatHint() {
  presetMode = true;
  feed.innerHTML =
    '<div class="msg claude"><p class="thinking">New chat. Nothing is running yet — the '
    + 'model is picked from your first message.</p>'
    + '<button id="presetChat" class="linkbtn">Or set the model and effort yourself →</button>'
    + '</div>';
  document.getElementById('presetChat').onclick = openModels;
}
document.getElementById('drawerSettings').onclick = () => { closeDrawer(); openModels(); };

/* One gesture handler, not two.
 *
 * There used to be a document-level pair for "swipe in from the edge" and a drawer-level
 * pair for "swipe an open drawer closed", sharing the same dragX/isDrag globals. Touch
 * events hit the drawer first and then bubble to document, so on an open drawer BOTH
 * touchmove handlers ran on every frame -- and the document one, which writes last and
 * therefore wins, computes the fully-closed offset. The drawer snapped shut under your
 * finger and sprang back on release. Two handlers cooperating through shared mutable state
 * is the bug; one state machine that knows which case it is in cannot have it.
 *
 * Edge-swipe-to-open is safe here only because this device uses three-button navigation.
 * Under gesture navigation the left edge belongs to the system back gesture.
 */
const EDGE_PX = 22;
const DRAG_MIN = 12;          // below this it is a tap or a vertical scroll, not a drag
let g = null;                 // the one in-flight gesture, or null

document.addEventListener('touchstart', ev => {
  g = null;
  if (ev.touches.length !== 1) return;
  const t = ev.touches[0];
  const open = drawer.classList.contains('open');
  if (!open && t.clientX > EDGE_PX) return;   // closed: only the edge starts it
  g = { x: t.clientX, y: t.clientY, open, active: false,
        // A rightward drag starting on a chat row belongs to swipe-to-delete, not to us.
        onRow: open && !!(ev.target.closest && ev.target.closest('.chat-list button')) };
}, { passive: true });

document.addEventListener('touchmove', ev => {
  if (!g) return;
  const dx = ev.touches[0].clientX - g.x;
  const dy = Math.abs(ev.touches[0].clientY - g.y);
  if (g.onRow && dx > 0) return;              // let the row own it
  if (!g.active) {
    // A mostly-vertical movement is a scroll; claiming it would make the list feel sticky.
    if (Math.abs(dx) < DRAG_MIN || dy > Math.abs(dx)) return;
    g.active = true;
    drawer.classList.add('dragging');
  }
  const w = DRAWER_W();
  // Track the finger rather than animating, so the drawer feels attached to it.
  drawer.style.transform = `translateX(${
    g.open ? Math.min(0, dx) : Math.min(0, -w + Math.max(0, dx))}px)`;
}, { passive: true });

document.addEventListener('touchend', ev => {
  if (!g) return;
  const dx = ev.changedTouches[0].clientX - g.x;
  const { open, active } = g;
  g = null;
  drawer.classList.remove('dragging');
  drawer.style.transform = '';
  if (!active) return;                        // a tap is not a gesture
  if (open) { if (dx < -DRAWER_W() * 0.3) closeDrawer(); }
  else if (dx > DRAWER_W() * 0.4) openDrawer();
}, { passive: true });

async function openProjects() {
  showSheet('Build which project?', 'list');
  list.innerHTML = '';
  try {
    const r = await fetch('/projects');
    const { items } = await r.json();
    if (!items.length) {
      list.innerHTML = '<div class="empty">Nothing buildable found.</div>';
      return;
    }
    for (const item of items) {
      const b = document.createElement('button');
      const when = item.built_at
        ? `last built ${new Date(item.built_at * 1000).toLocaleString()}`
        : 'never built';
      b.innerHTML = `${esc(item.name)}<span class="sub">${esc(item.project)} · ${esc(when)}</span>`;
      b.onclick = () => { post('/build', { project: item.project }); closeSheet(); };
      list.appendChild(b);
    }
  } catch {
    list.innerHTML = '<div class="empty">Could not list projects.</div>';
  }
}

/* ---------- screenshots as input ---------- */
/* Showing Claude a screenshot is faster than describing a screen, and this device produces
   them constantly. Paths are passed by reference -- the VM already sees /sdcard directly, so
   no image data crosses the socket. */
async function openShots() {
  showSheet('Recent screenshots', 'shots');
  shots.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const r = await fetch('/screenshots?limit=24');
    const { items } = await r.json();
    if (!items.length) {
      shots.innerHTML = '<div class="empty">No screenshots found.</div>';
      return;
    }
    shots.innerHTML = '';
    for (const item of items) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      // Thumbnail, not the original: the grid is ~120px wide and the originals are ~400 KB each.
      img.src = `/media?path=${encodeURIComponent(item.path)}&w=240`;
      // A gridful decodes at once without these; the picker is the other place a
      // burst of bitmaps can push Android into reclaiming the VM.
      img.loading = 'lazy';
      img.decoding = 'async';
      // Deliberately empty. Every filename here starts "Screenshot_2026" and truncates to the
      // same string, so alt text rendered nine identical unreadable tiles while loading.
      img.alt = '';
      img.title = item.name;
      img.onclick = () => { attach(item.path); closeSheet(); };
      shots.appendChild(img);
    }
  } catch {
    shots.innerHTML = '<div class="empty">Could not load screenshots.</div>';
  }
}

function attach(path) {
  if (attachments.includes(path)) return;
  attachments.push(path);
  renderAttachments();
}

function renderAttachments() {
  attachedBar.innerHTML = '';
  attachedBar.hidden = attachments.length === 0;
  for (const path of attachments) {
    const fig = document.createElement('figure');
    if (path.endsWith('.txt')) {
      // A UI-state dump, not an image -- there is nothing to thumbnail and no decode
      // cost to worry about, so just show what it is.
      fig.classList.add('attach-text');
      fig.textContent = '📋 UI state';
      fig.title = path;
    } else {
      const img = document.createElement('img');
      /* A thumbnail, like the picker grid already asks for.
       *
       * This chip is 56px tall and was loading the original: a 4000x3000 screenshot decodes to
       * roughly 48MB of bitmap in the WebView regardless of the box it is drawn in. Attach a
       * few and Android reclaims memory from the largest process available, which is the
       * Terminal VM -- so the backend vanished and the UI reported a lost connection. Nothing
       * was ever being uploaded; the preview alone was enough to kill the machine. */
      img.src = `/media?path=${encodeURIComponent(path)}&w=160`;
      img.loading = 'lazy';
      img.decoding = 'async';
      fig.appendChild(img);
    }
    const rm = document.createElement('button');
    rm.textContent = '✕';
    rm.onclick = () => {
      attachments = attachments.filter(p => p !== path);
      renderAttachments();
    };
    fig.append(rm);
    attachedBar.appendChild(fig);
  }
}

/* ---------- UI state as text, instead of a screenshot ----------
   A screenshot is a picture OF the interface; this is the interface, serialised. Claude
   reads it as plain text (a few hundred tokens) instead of an image (~1500+, and lossy
   about exact strings -- OCR was never involved). Only visible, on-screen elements are
   walked, each contributing its own text plus anything a screen reader would announce
   about it (role, value, placeholder), one per line, indented by nesting depth. */
const STATE_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'SVG', 'LINK', 'META', 'NOSCRIPT']);

function isVisible(el) {
  if (el.hidden) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
}

function ownText(el) {
  let s = '';
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) s += n.textContent;
  }
  return s.replace(/\s+/g, ' ').trim();
}

function describeNode(el) {
  const bits = [el.tagName.toLowerCase()];
  const role = el.getAttribute('role') || (el.tagName === 'BUTTON' ? 'button'
             : el.tagName === 'A' ? 'link' : el.tagName === 'INPUT' ? (el.type || 'input')
             : '');
  if (role) bits.push(`role=${role}`);
  if (el.id) bits.push(`#${el.id}`);
  if (el.className && typeof el.className === 'string') {
    const c = el.className.trim().split(/\s+/).slice(0, 2).join('.');
    if (c) bits.push(`.${c}`);
  }
  const label = el.getAttribute('aria-label') || el.getAttribute('title');
  if (label) bits.push(`label="${label}"`);
  if ('value' in el && el.value) bits.push(`value="${String(el.value).slice(0, 80)}"`);
  if (el.placeholder) bits.push(`placeholder="${el.placeholder}"`);
  if (el.disabled) bits.push('disabled');
  const text = ownText(el);
  if (text) bits.push(`"${text.slice(0, 200)}"`);
  return bits.join(' ');
}

function walkState(el, depth, out, budget) {
  if (out.length >= budget.lines || depth > 14) return;
  if (STATE_SKIP_TAGS.has(el.tagName)) return;
  if (!isVisible(el)) return;
  const line = describeNode(el);
  // Skip pure layout wrappers: a div/span contributing no text, id, class, role or value
  // of its own is noise -- its children get walked regardless, so nothing is lost.
  const bare = /^(div|span) *$/.test(line);
  if (!bare) out.push('  '.repeat(depth) + line);
  for (const child of el.children) {
    walkState(child, bare ? depth : depth + 1, out, budget);
    if (out.length >= budget.lines) return;
  }
}

function dumpUIState() {
  const out = [];
  out.push(`# ${document.title || 'forge'}  ${location.pathname}  ${new Date().toISOString()}`);
  walkState(document.body, 0, out, { lines: 400 });
  return out.join('\n');
}

/* ---------- captures ----------
   A capture is a pair of files: the .txt Claude actually reads, and a small .jpg that is
   both the thumbnail here and the colour/shape channel there. The list shows the image
   because a wall of timestamps is unrecognisable, but the text is the payload -- so the
   size shown is the text's, not the picture's. */
async function openCaptures() {
  showSheet('Captures', 'caps');
  caps.innerHTML = '<div class="empty">Loading…</div>';
  let items = [];
  try {
    const r = await fetch('/captures?limit=24');
    items = (await r.json()).items || [];
  } catch {
    caps.innerHTML = '<div class="empty">Could not load captures.</div>';
    return;
  }

  caps.innerHTML = '';
  // Capturing this screen needs no APK and no permissions, so it is always offered --
  // it is also the only capture that can read the Forge UI's own DOM rather than the
  // accessibility tree's view of it.
  const here = document.createElement('button');
  here.className = 'cap-here';
  here.textContent = '＋ Capture this screen now';
  here.onclick = async () => { await captureState(); closeSheet(); };
  caps.appendChild(here);

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No device captures yet. Use Shot or Rec in the notification shade.';
    caps.appendChild(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'cap-grid';
  for (const item of items) {
    const cell = document.createElement('button');
    cell.className = 'cap-cell';
    if (item.image) {
      const img = document.createElement('img');
      img.src = `/media?path=${encodeURIComponent(item.image)}&w=160`;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      cell.appendChild(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'cap-noimg';
      ph.textContent = item.kind === 'rec' ? '⏺' : '▢';
      cell.appendChild(ph);
    }
    // A recording and a shot can look identical -- same screen, one frame each -- so the
    // kind has to be marked rather than inferred from the picture.
    if (item.kind === 'rec') {
      const badge = document.createElement('span');
      badge.className = 'cap-badge';
      badge.textContent = '⏺ REC';
      cell.appendChild(badge);
    }
    const cap = document.createElement('span');
    cap.className = 'cap-when';
    cap.textContent = ago(item.mtime);
    cell.appendChild(cap);
    cell.onclick = () => {
      // Both halves, when both exist: the text for exact strings and positions, the image
      // for colour and shape. Attaching only one loses a requirement.
      attach(item.text);
      if (item.image) attach(item.image);
      closeSheet();
    };
    grid.appendChild(cell);
  }
  caps.appendChild(grid);
}

/* The thumbnail says which capture it is; the time says which of two similar ones. Nothing
   else about a capture is worth screen space here -- the text half is written for Claude to
   read and is meaningless to look at, so its size and path stay out of the picker. */
function ago(mtime) {
  const s = Math.max(0, (Date.now() - mtime * 1000) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(mtime * 1000).toLocaleDateString();
}

async function captureState() {
  const text = dumpUIState();
  try {
    const r = await fetch('/uistate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'state', text }),
    });
    const data = await r.json();
    if (!r.ok || !data.path) { banner('Could not capture UI state.'); return; }
    attach(data.path);
  } catch {
    banner('Could not reach the backend to capture UI state.');
  }
}

/* ---------- transport ---------- */
async function post(path, body) {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (r.ok) banner(null);          // a success proves the backend is reachable again
    else banner(`Request failed (${r.status}).`);
    return r.ok;
  } catch (err) {
    banner('Cannot reach the backend. Your text is saved.', null, true);
    return false;
  }
}

function connect() {
  if (source) source.close();
  source = new EventSource(`/events?last_event_id=${lastEventId}`);
  source.onmessage = ev => {
    lastEventId = +ev.lastEventId || lastEventId;
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    // Replayed events are history. Transcript content (text, tool cards, builds) should
    // redraw; anything that opens a sheet or asks the user to act must not fire again, or
    // every reload reopens the Shell over old output and resurrects dismissed prompts.
    if (data.replay && LIVE_ONLY.has(data.kind)) return;
    const fn = handlers[data.kind];
    if (fn) fn(data);
  };
  source.onopen = () => {
    clearTimeout(reconnectNotice);    // beat the banner to it; nothing to announce
    banner(null);                     // connection restored; any stale error is now a lie
    setBackendReloading(false);       // the host is back; the composer is safe again
    retryDelay = 1000;
    flushQueuedSends();
    // Re-sync on every reconnect, not just at page load. A permission raised while the tab
    // was backgrounded arrives as a live event we were not there to receive, so without this
    // the request is invisible forever and the turn appears to hang.
    syncState();
  };
  source.onerror = () => {
    setDot('dead');
    /* The banner waits; the reconnect does not.
     *
     * Android suspends the WebView's sockets while the app is backgrounded, so every switch
     * to another app and back kills the stream and reconnects within a second. Announcing
     * that immediately meant a red alarm on every return to the app, for a failure that had
     * already fixed itself -- which is what made it feel like an upload problem rather than
     * ordinary app switching. Nothing is hidden: a reconnect that genuinely takes a while
     * still says so, just after it has earned the right to. */
    clearTimeout(reconnectNotice);
    reconnectNotice = setTimeout(() => {
      banner(`Reconnecting in ${Math.round(retryDelay / 1000)}s…`, null, true);
    }, 2500);
    source.close();
    setTimeout(connect, retryDelay);
    // Back off gradually: on flaky mobile data, hammering the socket drains battery
    // without reconnecting any sooner.
    retryDelay = Math.min(retryDelay * 1.8, 20000);
  };
}

/* The daemon is authoritative about whether work is in flight and what it is waiting on. */
async function syncState() {
  try {
    const r = await fetch('/state');
    if (!r.ok) return;
    const s = await r.json();

    for (const p of s.pending_permissions || []) {
      if (!document.getElementById(`perm-${p.request_id}`)) renderPermission(p);
    }
    for (const el of pending.querySelectorAll('.perm[id^="perm-"]')) {
      const id = el.id.slice(5);
      const live = (s.pending_permissions || []).some(p => p.request_id === id);
      if (!live) el.remove();        // answered elsewhere, or the daemon restarted
    }

    // interrupted_turns used to be read only on initial chat load, never on an ordinary
    // reconnect. That was fine while the only source of an interrupted entry was a full
    // daemon restart, which always forces a page reload anyway -- but a mid-turn crash now
    // also lands here (see session.py's _run_once), and that kind can happen while the tab
    // is sitting open with no reload in sight. Without this, the live turn_interrupted
    // event was the only way the card could ever appear, and if that event was missed --
    // for instance because the EventSource itself was mid-reconnect at the exact moment the
    // interruption fired -- the message vanished with nothing left to show for it.
    for (const t of s.interrupted_turns || []) {
      if (!document.getElementById(`intr-${t.id}`)) renderInterrupted(t);
    }

    setDot(s.busy ? 'busy' : 'live');

    // The dot used to be re-synced here but the activity strip was not, so a turn that ended
    // while the tab was backgrounded left the spinner turning and the timer climbing forever
    // next to a green dot -- the UI contradicting itself about whether anything was running.
    busyNow = !!s.busy;
    if (!busyNow) {
      activityHide();
      if (reloadWhenIdle && !composerHasText()) reloadNow('held-until-idle-resync');
    } else if (activity.hidden) {
      activityShow('Working…');       // reconnected mid-turn; elapsed restarts from here
    }

    if (s.rate_limits) renderGauge(s.rate_limits);
  } catch {}
}

/* ---------- composer ---------- */
let autosizeTimer = null;
/* ---------- our own caret ----------
 *
 * A non-editable element has no caret, so with the in-app keyboard there is nothing on screen
 * to say where the next character lands. This draws one: a bar positioned from the same
 * offset-to-Range machinery the selection uses, so it can never disagree with where text is
 * actually inserted.
 *
 * It exists only in that mode. With the system keyboard the field is editable again and
 * Android draws its own, insertion handle and all -- which is the price of that fallback
 * working, and worth paying for it.
 */
let ceCaret = 0;
let ceSelEnd = 0;           // end of our selection; equal to ceCaret when there is none
let swallowClick = false;   // set by a long press, consumed by the click it produces
const caretEl = document.createElement('div');
caretEl.className = 'ce-caret';
caretEl.hidden = true;
document.body.appendChild(caretEl);

/* Our own highlight, rather than the browser's.
 *
 * Handing a Range to window.getSelection() makes Chromium start its selection UI, which then
 * asks for an action mode -- and since we refuse that, it abandons the selection. That is the
 * highlight appearing for one frame and the native picker flashing before both vanish. There
 * is no way to have the browser paint a selection without also inviting its UI, so the
 * selection stops being the browser's: we hold the offsets and draw the rectangles.
 */
const selLayer = document.createElement('div');
selLayer.className = 'sel-layer';
document.body.appendChild(selLayer);

function paintSelection() {
  const el = document.getElementById('input');
  selLayer.innerHTML = '';
  if (!el || el.isContentEditable || ceSelEnd <= ceCaret) return;
  const rects = rangeAt(el, ceCaret, ceSelEnd).getClientRects();
  const clip = el.getBoundingClientRect();
  for (const r of rects) {
    if (!r.width || !r.height) continue;
    const d = document.createElement('div');
    // Clipped to the field: a long selection scrolled inside the box would otherwise paint
    // over the transcript above it.
    const top = Math.max(r.top, clip.top);
    const bottom = Math.min(r.bottom, clip.bottom);
    if (bottom <= top) continue;
    d.style.left = r.left + 'px';
    d.style.top = top + 'px';
    d.style.width = r.width + 'px';
    d.style.height = (bottom - top) + 'px';
    selLayer.appendChild(d);
  }
}

function renderCaret() {
  const el = document.getElementById('input');
  if (!el || el.isContentEditable || !kbdOn) { caretEl.hidden = true; return; }
  /* Anything covering the composer hides it. The caret is position: fixed, so it happily
     blinked on top of the Settings sheet and the drawer -- a "type here" bar over a menu
     with nothing to type into. */
  const sheetEl = document.getElementById('sheet');
  const drawerEl = document.getElementById('drawer');
  if ((sheetEl && !sheetEl.hidden) || (drawerEl && drawerEl.classList.contains('open'))) {
    caretEl.hidden = true;
    return;
  }
  if (ceSelEnd > ceCaret) {
    caretEl.hidden = true;            // a selection shows itself; a caret would be noise
    return;
  }
  const n = fText(el).length;
  const at = Math.max(0, Math.min(ceCaret, n));
  const r = rangeAt(el, at, at);
  const rect = r.getClientRects()[0] || r.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  // An empty field has no text node to measure, so fall back to the box's own inset.
  const left = rect && rect.width + rect.height > 0 ? rect.left : box.left + 16;
  const top = rect && rect.width + rect.height > 0 ? rect.top : box.top + 12;
  const h = rect && rect.height ? rect.height : 20;
  caretEl.style.left = left + 'px';
  caretEl.style.top = top + 'px';
  caretEl.style.height = h + 'px';
  caretEl.hidden = false;
  // Restart the blink on every move, so the caret is solid at the moment you look for it.
  caretEl.style.animation = 'none';
  void caretEl.offsetWidth;
  caretEl.style.animation = '';
}

/* Tap to place the caret. An editable element does this itself; a non-editable one needs
   the offset resolved and stored, which is the same lookup the long press already uses. */
document.getElementById('input').addEventListener('click', (ev) => {
  const el = ev.currentTarget;
  if (el.isContentEditable) return;
  /* Opening the keyboard was the focus handler's job, and a non-editable div cannot take
     focus -- so tapping the composer did nothing at all and the only way in was to open
     another field and come back. In this mode the tap is the gesture, not the focus. */
  if (!kbdOn && !prefersNative) kbdSetOn(true);
  /* A long press is followed by a click, and this handler collapses the selection to a
     caret -- so the highlight appeared for a frame and then vanished, leaving two handles
     around nothing. The gesture that already acted swallows the click it generated. */
  if (swallowClick) { swallowClick = false; return; }
  const at = offsetFromPoint(el, ev.clientX, ev.clientY);
  fSetSel(el, at === null ? fText(el).length : at);
});

/* The field is editable exactly when the system keyboard needs to type into it. */
function setComposerEditable(on) {
  const el = document.getElementById('input');
  if (!el) return;
  if (on) {
    el.setAttribute('contenteditable', 'plaintext-only');
    el.removeAttribute('tabindex');
  } else {
    el.removeAttribute('contenteditable');
    // Focusable without being editable, so document.activeElement still reports it and
    // kbdTarget() keeps routing keys here rather than falling back to the composer by luck.
    el.setAttribute('tabindex', '0');
  }
  renderCaret();
}

/* ---------- text field abstraction ----------
 *
 * The composer is a contenteditable div and the other two fields are <input>. Rather than
 * branch at every call site, everything goes through these four. Offsets are plain character
 * indices in both cases, so the rest of the code never learns which kind it is holding.
 *
 * innerText for reading, textContent for writing: innerText normalises whatever the browser
 * built -- <br>, nested divs -- back to \n, while textContent with white-space: pre-wrap
 * renders a \n as a line break without creating elements. Reading and writing through the
 * same property would round-trip a newline into markup.
 */
/* By tag, not by contenteditable.
 *
 * Editability is now a mode: with the in-app keyboard the composer is NOT editable, so the
 * browser draws no caret, no insertion handle and starts no text drag -- the page owns all
 * three. Switching to the system keyboard makes it editable again, because a keyboard that
 * cannot type into the field is not a fallback. Keying off isContentEditable would make
 * every text helper change meaning when that toggle flips. */
function isDiv(el) { return el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA'; }
function isCE(el) { return isDiv(el); }

/* Read the same way fSetSel walks, or offsets mean two different things.
 *
 * innerText normalises a <br> into a newline, but fSetSel counts characters by walking text
 * nodes, where a <br> contributes nothing. Any divergence shifts every offset after it --
 * which is a highlight landing on the wrong characters, and Select all stopping short of the
 * end. Both functions now agree that an offset is a character index into the concatenated
 * text nodes, and nothing else. */
function ceText(el) {
  let out = '';
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) out += n.nodeValue;
  return out;
}

function fText(el) { return isCE(el) ? ceText(el) : el.value; }

function fSetText(el, v) {
  if (isCE(el)) el.textContent = v;
  else el.value = v;
}

/** Character offsets of the selection, or the caret twice over when there is none. */
function fSel(el) {
  if (!isCE(el)) {
    const a = el.selectionStart ?? el.value.length;
    return [a, el.selectionEnd ?? a];
  }
  if (!el.isContentEditable) {
    const n = fText(el).length;
    const a = Math.max(0, Math.min(ceCaret, n));
    return [a, Math.max(a, Math.min(ceSelEnd, n))];
  }
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode) || sel.isCollapsed) {
    if (!el.isContentEditable) {
      const n = fText(el).length;
      const a = Math.max(0, Math.min(ceCaret, n));
      const b = Math.max(a, Math.min(ceSelEnd, n));
      return [a, b];
    }
    if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) {
      const n = fText(el).length;
      return [n, n];
    }
  }
  const r = sel.getRangeAt(0);
  const pre = r.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  const start = pre.toString().length;
  return [start, start + r.toString().length];
}

/* Offsets to a Range, by walking text nodes. The single definition of what an offset means,
   shared by selection, the caret and handle placement. */
function rangeAt(el, start, end) {
  el.normalize();
  const range = document.createRange();
  range.setStart(el, 0);
  range.setEnd(el, 0);
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let seen = 0, node, placedStart = false;
  while ((node = walk.nextNode())) {
    const len = node.nodeValue.length;
    if (!placedStart && seen + len >= start) {
      range.setStart(node, start - seen);
      placedStart = true;
    }
    if (placedStart && seen + len >= end) {
      range.setEnd(node, end - seen);
      break;
    }
    seen += len;
  }
  return range;
}

function fSetSel(el, start, end) {
  const len = fText(el).length;
  start = Math.max(0, Math.min(start, len));
  end = Math.max(start, Math.min(end ?? start, len));
  if (!isCE(el)) {
    try { el.setSelectionRange(start, end); } catch {}
    return;
  }
  ceCaret = start;
  ceSelEnd = end;
  const sel = window.getSelection();
  if (el.isContentEditable) {
    // Editable means the system keyboard is in use and Android owns all of this.
    sel.removeAllRanges();
    sel.addRange(rangeAt(el, start, end));
  } else {
    // Ours. Telling the browser would invite the UI we went to some trouble to remove.
    sel.removeAllRanges();
    paintSelection();
  }
  renderCaret();
}

function autosize() {
  // Reading scrollHeight right after writing height forces a synchronous layout of the whole
  // document. Once per animation frame is still once per keystroke when typing quickly, and
  // against a long transcript that is the lag. Resize after typing settles instead -- the box
  // growing 120ms late is imperceptible; a keystroke arriving 120ms late is not.
  // A contenteditable div is a block: it already grows with its content, and CSS caps it at
  // 40vh with its own scrollbar. Writing an explicit height on top of that fights the layout
  // rather than driving it, so there is nothing to do here any more.
  if (isCE(input)) return;
  clearTimeout(autosizeTimer);
  autosizeTimer = setTimeout(() => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
  }, 120);
}

/* ---------- draft safety ----------
 *
 * Two keys, not one. forge.draft is the live composer and goes empty whenever the composer
 * does. forge.draft.backup is the last non-empty thing that was in it and is cleared by one
 * thing only: a message actually being sent.
 *
 * So anything that empties the composer *without* sending -- a reload, a WebView the shell
 * restarted, a bug in this file -- destroys the live copy and leaves the backup sitting there
 * to be restored. This deliberately does not depend on knowing what did it. The composer has
 * now been erased by three different mechanisms, two of them found only by accident, and
 * guarding the text costs twenty lines and covers the ones still unfound. */
const DRAFT = 'forge.draft';
const DRAFT_BACKUP = 'forge.draft.backup';

function saveDraft() {
  try {
    const t = fText(input);
    localStorage.setItem(DRAFT, t);
    if (t.trim()) localStorage.setItem(DRAFT_BACKUP, JSON.stringify({ text: t, at: Date.now() }));
  } catch {}
}

/** The composer was emptied on purpose -- a send, or a local command that consumed the text. */
function clearDraft() {
  try { localStorage.removeItem(DRAFT); localStorage.removeItem(DRAFT_BACKUP); } catch {}
}

/** The last unsent message, if there is one worth offering back. */
function backupDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_BACKUP) || 'null');
    if (!d || !d.text || !d.text.trim()) return null;
    // Yesterday's draft is not what they were typing; restoring it would be its own surprise.
    if (Date.now() - (d.at || 0) > 12 * 3600 * 1000) return null;
    return d.text;
  } catch { return null; }
}

/* Deleting text on purpose must not look like the bug. Any backspace, cut or send stamps this,
   and the watchdog below stands down for a moment afterwards. */
let clearedOnPurpose = 0;
function markDeliberateClear() { clearedOnPurpose = Date.now(); }

/* Last resort, and the only part of this that does not care why.
 *
 * If a composer holding real text goes empty between two ticks, and nothing deliberate
 * happened just before, that is the bug -- whatever the bug turns out to be -- and the text
 * goes straight back in. Cheap: one string read against a field that is almost always short. */
let lastComposerText = '';
setInterval(() => {
  let now;
  try { now = fText(input); } catch { return; }
  const was = lastComposerText;
  lastComposerText = now;
  if (now.trim() || was.trim().length < 12) return;       // still has text, or nothing lost
  if (Date.now() - clearedOnPurpose < 2500) return;       // they emptied it themselves
  const rescued = backupDraft();
  if (!rescued) return;
  fSetText(input, rescued);
  ceCaret = ceSelEnd = rescued.length;
  lastComposerText = rescued;
  autosize();
  renderCaret();
  banner('Your message came back — the composer was cleared without sending.');
}, 700);

/* Commands the CLI's REPL owns, which never reach the agent.
 *
 * /model and friends are handled by the interactive prompt, not by the session, so sending
 * one from here would arrive as a sentence rather than an instruction. Forge has its own
 * model switching and its own chats, so rather than listing commands that quietly do
 * nothing -- or hiding them and leaving the gap -- the client answers them itself.
 */
async function runLocalCommand(text) {
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim().toLowerCase();

  if (cmd === '/model' || cmd === '/effort') {
    const valid = cmd === '/model'
      ? ['opus', 'sonnet', 'haiku', 'default']
      : ['low', 'medium', 'high', 'xhigh', 'max'];
    if (!arg) { openPicker(cmd === '/model' ? 'model' : 'effort'); return true; }
    if (!valid.includes(arg)) {
      banner(`${cmd} takes one of: ${valid.join(', ')}`);
      return true;
    }
    if (cmd === '/model') {
      if (arg !== 'default') { currentModel = short(arg); renderTitle(); }
      chosenModel = arg === 'default' ? '' : arg;
      await post('/model', { model: arg });
      banner(`Model: ${arg}`);
    } else {
      currentEffort = arg;
      await post('/model', { effort: arg });
      banner(`Effort: ${arg} — applies when a chat next starts`);
    }
    return true;
  }

  if (cmd === '/clear' || cmd === '/new') {
    document.getElementById('newChat').click();
    return true;
  }

  if (cmd === '/compact') {
    // Summarise and restart the session in place. The transcript is what makes a long
    // chat expensive -- every turn re-uploads it -- and this is the only way to shed it
    // without also shedding the thread, which is what /clear does.
    banner('Compacting — summarising this chat…');
    try {
      const r = await post('/compact', {});
      banner(r && r.ok ? 'Compacted. The next turn starts from a handover note.'
                       : `Compact failed: ${(r && r.error) || 'unknown'}`);
    } catch (e) {
      banner(`Compact failed: ${e}`);
    }
    return true;
  }

  if (cmd === '/chats') { openDrawer(); return true; }
  if (cmd === '/settings') { openModels(); return true; }
  /* These three lost their chips when the action row was cut back to Docs and Stop. The
     buttons were the only way to reach any of them, and Build APK in particular is how a
     new APK gets installed from the phone at all -- so the capability moves here rather
     than disappearing with the button. */
  if (cmd === '/leer' || cmd === '/afrikaans') { location.href = '/ui/leer.html'; return true; }
  if (cmd === '/build') { openProjects(); return true; }
  if (cmd === '/shots') { openShots(); return true; }
  if (cmd === '/shell') { openShell(); return true; }
  return false;
}

async function send() {
  presetMode = false;   // the subprocess is about to spawn; picks stop being presets
  const text = fText(input).trim();
  if (!text && !attachments.length) return;
  markDeliberateClear();   // the composer is about to empty, and this one is meant to

  if (text.startsWith('/') && !attachments.length) {
    if (await runLocalCommand(text)) {
      fSetText(input, '');
      hideCmdMenu();
      clearDraft();           // the command consumed it; there is nothing to recover
      lastComposerText = '';
      renderCaret();
      return;
    }
  }

  // Claude's Read tool takes a path, so naming the files is enough -- no upload needed.
  const refs = attachments.map(p => p.endsWith('.txt')
    ? `Read this UI state dump: ${p}`
    : `Look at this image: ${p}`).join('\n');
  const payload = [refs, text].filter(Boolean).join('\n\n');

  const sent = attachments;
  fSetText(input, '');
  hideCmdMenu();
  attachments = [];
  renderAttachments();
  autosize();
  saveDraft();

  const ok = await post('/prompt', { text: payload });
  if (ok) {
    // Show the indicator here rather than waiting for the turn_start event to come back
    // over SSE. It used to depend entirely on that event, which meant any delay or miss
    // in the stream -- and Android suspends the WebView's sockets whenever the app is
    // backgrounded, which voice dictation does constantly -- left the screen looking
    // identical to nothing having happened. Sending is the moment the user needs the
    // feedback, and it is a fact we already know locally without asking the server.
    //
    // turn_start still fires and is still authoritative; calling activityShow twice is
    // harmless, and the watchdog below reconciles the case where the turn never starts
    // so an optimistic spinner can never outlive the thing it is reporting on.
    // Delivered. This is the one thing that retires the backup copy.
    clearDraft();
    lastComposerText = '';
    activityShow('Thinking…');
    clearTimeout(activityWatchdog);
    activityWatchdog = setTimeout(syncState, 10000);
  } else {
    // Restarts take ~90s. Rather than making the user watch for the dot to go green and
    // press send again, hold the turn and deliver it on reconnect.
    queuedSends.push(payload);
    fSetText(input, text);
    attachments = sent;
    renderAttachments();
    autosize();
    saveDraft();
    banner('Backend restarting — your message will send automatically.', null, true);
  }
}

async function flushQueuedSends() {
  while (queuedSends.length) {
    const payload = queuedSends[0];
    const ok = await post('/prompt', { text: payload });
    if (!ok) return;
    queuedSends.shift();
    if (fText(input).trim() && payload.endsWith(fText(input).trim())) {
      fSetText(input, '');
      autosize();
      saveDraft();
    }
  }
}

input.addEventListener('input', () => { autosize(); saveDraft(); });

/* Save again on the way out. localStorage writes reach disk asynchronously, so a process the
   system kills outright can lose the last one; these fire while the page is still alive and
   are the last chance to get it down before Android takes the WebView. */
document.addEventListener('visibilitychange', () => { if (document.hidden) saveDraft(); });
window.addEventListener('pagehide', saveDraft);
window.addEventListener('blur', saveDraft);
sendBtn.addEventListener('click', send);
gauge.addEventListener('click', openUsage);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && e.ctrlKey) { e.preventDefault(); send(); }
});

document.getElementById('plus').addEventListener('click', e => {
  e.preventDefault();
  openCaptures();
});

/* Hide the action row while composing, to give the transcript that strip back.
 *
 * The blur is deliberately re-checked on the next tick rather than acted on directly: a tap
 * on an in-app keyboard key can take focus for an instant, and reacting to that blur
 * immediately makes the row flash back on every single keypress. Re-reading activeElement
 * after the dust settles distinguishes "focus left the composer" from "focus bounced". */
function setComposing(on) {
  document.body.classList.toggle('composing', on);
}
input.addEventListener('focus', () => setComposing(true));
input.addEventListener('blur', () => {
  setTimeout(() => {
    const a = document.activeElement;
    if (a === input) return;
    if (kbd && !kbd.hidden && kbd.contains(a)) return;
    setComposing(false);
  }, 0);
});

document.querySelector('.actions').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  if (b.dataset.act === 'interrupt') post('/interrupt', {});
  if (b.dataset.act === 'build') openProjects();
  if (b.dataset.act === 'shots') openShots();
  if (b.dataset.act === 'shell') openShell();
  // A plain navigation, not a sheet like the others: the docs page is its own static
  // page (forge-ui/docs.html), not a view built into this one, so there is nothing here
  // for a sheet to hold open. It carries the session's own cookie automatically since it
  // is only ever reached by navigating from inside the already-authenticated app.
  if (b.dataset.act === 'docs') location.href = '/ui/docs.html';
});

document.getElementById('sheetClose').onclick = closeSheet;
backdrop.onclick = () => { closeSheet(); closeDrawer(); };
titleBtn.onclick = openDrawer;
document.getElementById('shellRun').onclick = runShell;
shellIn.addEventListener('keydown', e => { if (e.key === 'Enter') runShell(); });

/* ---------- (re)loading a chat's state ---------- */
/* Shared by first load and by switching chats: switching is deliberately "load a
   different chat" rather than its own code path, so it inherits cold-load's windowing,
   replay-cap and history-paging behaviour for free instead of a second, divergent copy. */
/* No `fresh` flag any more, and that is the fix, not a tidy-up.
 *
 * It used to mean "start from the newest event and replay nothing", and chat switching
 * passed it. So switching into a chat wiped the feed, subscribed from the live edge, and
 * showed an empty transcript for a conversation with ten megabytes of history behind it --
 * indistinguishable, on screen, from the chat having been deleted.
 *
 * There is no caller that wants it. A brand new chat has last_event_id 0, so the backfill
 * clamps to 0 and costs nothing; every other chat wants exactly what a cold boot wants.
 * Removing the parameter is what stops it being passed wrongly again.
 */
async function loadChatState() {
  presetMode = false;
  if (source) source.close();
  feed.innerHTML = '';
  pending.innerHTML = '';
  tools.clear();
  attic.length = 0;
  atticBelow.length = 0;
  historyDone = false;
  tailFrom = 0;                 // an id from the previous chat's log means nothing here
  tailLoading = false;
  if (typeof updateJumpBtn === 'function') updateJumpBtn();
  finishAssistant();

  try {
    const r = await fetch('/state');
    if (r.ok) {
      const s = await r.json();
      lastEventId = Math.max(0, (s.last_event_id || 0) - COLD_REPLAY);
      historyOldest = lastEventId;
      (s.pending_permissions || []).forEach(renderPermission);
      (s.interrupted_turns || []).forEach(renderInterrupted);
      if (s.rate_limits) renderGauge(s.rate_limits);
      setDot(s.busy ? 'busy' : 'live');
      currentChatId = s.chat_id || null;
      if (s.model) { currentModel = short(s.model); renderTitle(); }
      if (s.effort) currentEffort = s.effort;
    }
  } catch {}

  connect();
}

/* ---------- boot ---------- */
(async function boot() {
  /* Restore the caret with the text, not just the text.
   *
   * The in-app keyboard keeps the caret in ceCaret, not in the DOM, so a restored draft used
   * to come back with the caret still at 0 -- the next keystroke landed at the *start* of the
   * paragraph. It went unnoticed only because in-app typing never reached the draft at all, so
   * what got restored was almost always empty. Now that it does, this matters.
   *
   * Assigned directly rather than through fSetSel: that reaches renderCaret, and kbdOn is
   * declared further down this file, so this early it is still in its temporal dead zone. */
  try {
    let draft = localStorage.getItem(DRAFT) || '';
    let rescued = false;
    /* An empty live draft after a reload is the suspicious case, not the normal one: the
       composer is usually empty because the last message was sent, and sending clears the
       backup too. A backup that outlived its draft means the page went down holding text. */
    if (!draft.trim()) {
      const b = backupDraft();
      if (b) { draft = b; rescued = true; }
    }
    fSetText(input, draft);
    ceCaret = ceSelEnd = draft.length;
    lastComposerText = draft;
    autosize();
    if (rescued) setTimeout(() => banner('Recovered the message you were typing.'), 800);
  } catch {}

  // Drop the token from the address bar once the cookie is set.
  if (location.search.includes('token=')) {
    history.replaceState({}, '', location.pathname);
  }

  // Replaying all 2000 buffered events rebuilt the entire session's DOM on every load,
  // which is what made typing lag: each keystroke's reflow had to walk all of it.
  // A few hundred events is far more transcript than anyone scrolls back through.
  await loadChatState();
})();

/* ---------- in-page keyboard ---------- */
/* Rendered here rather than by Android so the entire interface, keyboard included, reloads
   with a file save. The tradeoff is that everything the system keyboard gives away free --
   dictation, autocorrect, swipe, emoji -- has to be replaced deliberately. Dictation comes
   back through the APK bridge (`voiceInput`); the rest is a conscious loss.
   The system keyboard is reachable from Settings, so a bug here can never lock the user out
   of typing -- but it is no longer a key in the symbol row, where it was mistapped into a
   permanent opt-out. */
const kbd = document.getElementById('kbd');

const KBD_LETTERS = [
  ['q','w','e','r','t','y','u','i','o','p'],
  ['a','s','d','f','g','h','j','k','l'],
  ['⇧','z','x','c','v','b','n','m','⌫'],
];
/* The characters phone keyboards bury two layers deep but a shell needs constantly. */
const KBD_SYMBOLS = [
  ['1','2','3','4','5','6','7','8','9','0'],
  ['@','#','$','_','&','-','+','(',')','/'],
  ['=\\<','*','"',"'",':',';','!','?','⌫'],
];
/* Third layer, same as Gboard's: reached from =\< . */
const KBD_SYMBOLS2 = [
  ['~','`','|','•','√','π','÷','×','¶','∆'],
  ['£','¢','€','¥','^','°','=','{','}','\\'],
  ['?123','%','©','®','™','✓','[',']','⌫'],
];
/* Native prints the digits as hints above the top letter row; copying that keeps the
   number row discoverable without spending a row on it. */
const KBD_HINTS = ['1','2','3','4','5','6','7','8','9','0'];

let kbdShift = false;
let kbdCaps = false;
let lastShiftTap = 0;
let kbdLayer = 'letters';
let kbdOn = false;
/* Whether the system keyboard is preferred over the in-page one. Module scope and mutable
   because it has to be reversible from Settings -- see setKbdPreference. */
let prefersNative = (() => {
  try { return localStorage.getItem('forge.kbd') === '0'; } catch { return false; }
})();

function kbdKey(label, cls, wide, hint) {
  // The glow is its own element so the press can be a pure opacity change: background-color
  // on the button repaints on the main thread, opacity on a promoted layer does not.
  return `<button class="k${cls ? ' ' + cls : ''}"${wide ? ` style="flex:${wide}"` : ''}
           data-k="${esc(label)}"><span class="kglow"></span>${
             hint ? `<span class="khint">${esc(hint)}</span>` : ''
           }<span class="klabel">${esc(label)}</span></button>`;
}

function renderKbd() {
  const rows = kbdLayer === 'letters' ? KBD_LETTERS
             : kbdLayer === 'symbols' ? KBD_SYMBOLS : KBD_SYMBOLS2;
  /* The shell symbol row is gone: ~ / - _ | * ` $ { } [ ] < > existed for typing code, which
     is not what this keyboard is for. They remain two taps away on the 123 layer, and the row
     was costing 32px of screen on every keystroke to save that. */
  let html = '';

  rows.forEach((row, ri) => {
    html += '<div class="krow">' + row.map((c, ci) => {
      const shifted = kbdLayer === 'letters' && (kbdShift || kbdCaps) && /^[a-z]$/.test(c);
      const label = shifted ? c.toUpperCase() : c;
      const cls = (c === '⇧') ? ('kmod' + (kbdCaps ? ' caps' : kbdShift ? ' on' : ''))
                : (c === '⌫' || c === '=\\<' || c === '?123') ? 'kmod' : '';
      // Digits sit above the top letter row, as they do natively.
      const hint = (kbdLayer === 'letters' && ri === 0) ? KBD_HINTS[ci] : '';
      return kbdKey(label, cls, (c === '⇧' || c === '⌫') ? 1.5 : 1, hint);
    }).join('') + '</div>';
  });

  html += `<div class="krow">
      ${kbdKey(kbdLayer === 'letters' ? '123' : 'abc', 'kmod', 1.3)}
      ${kbdKey(',', '', 1)}
      ${kbdKey(' ', 'kspace', 4.6)}
      ${kbdKey('.', '', 1)}
      ${kbdKey('⏎', 'ksend', 1.5)}
    </div>`;
  kbd.innerHTML = html;
}

/* Every text field in the page, not just the composer.
 *
 * The in-page keyboard was wired directly to #input, so any other field fell through to the
 * system IME -- and adding a search box to the drawer was enough to bring the native
 * keyboard back, because nothing suppressed it there. Suppressing without retargeting would
 * have been worse: a field you cannot type into at all. */
const FIELDS = [input, chatSearch, document.getElementById('shellIn')].filter(Boolean);

function kbdTarget() {
  const a = document.activeElement;
  return FIELDS.includes(a) ? a : input;
}

/* Insert at the caret rather than appending: the user can tap to reposition mid-message. */
function kbdInsert(text) {
  const el = kbdTarget();
  const v = fText(el);
  const [start, end] = fSel(el);
  // Fast path: typing at the end, which is almost always.
  if (start === v.length && end === v.length) {
    fSetText(el, v + text);
    fSetSel(el, v.length + text.length);
  } else {
    fSetText(el, v.slice(0, start) + text + v.slice(end));
    fSetSel(el, start + text.length);
  }
  afterKbdEdit(el);
}

function kbdBackspace() {
  const el = kbdTarget();
  markDeliberateClear();   // deleting your own text must never look like the bug
  const v = fText(el);
  const [start, end] = fSel(el);
  if (start !== end) {
    fSetText(el, v.slice(0, start) + v.slice(end));
    fSetSel(el, start);
  } else if (start > 0) {
    fSetText(el, v.slice(0, start - 1) + v.slice(start));
    fSetSel(el, start - 1);
  }
  afterKbdEdit(el);
}

/* Only the composer grows, and only the search box needs to re-run its query -- the keyboard
   writes to .value directly, which fires no input event of its own. Composer edits also skip
   the native 'input' listener entirely, so this is the only place that persists them -- miss
   it and a reload (UI hot-reload, backend restart, "Reload interface") restores the composer
   from a draft that never saw anything typed on the in-app keyboard, silently wiping it. */
function afterKbdEdit(el) {
  if (el === input) { autosize(); renderCaret(); updateCmdMenu(); saveDraft(); }
  else el.dispatchEvent(new Event('input', { bubbles: true }));
}

/* Guards the focus handler while we deliberately blur and refocus. */
let suppressFocus = false;

/* inputmode is read when an element *acquires* focus, not while it holds it. So setting it to
   "none" on an already-focused input does not retract a system keyboard that is already open
   -- which is how both keyboards ended up on screen at once, typically after a reload restored
   focus before this script ran. Blur and refocus so the new value is actually consulted. */
function dismissSystemKeyboard() {
  const el = document.activeElement;
  if (!FIELDS.includes(el)) return;
  suppressFocus = true;
  el.blur();
  setTimeout(() => {
    el.focus({ preventScroll: true });
    setTimeout(() => { suppressFocus = false; }, 60);
  }, 0);
}

/* `persist` is deliberately opt-in.
 *
 * The keyboard key in the symbol row used to write the preference, so one mistap disabled
 * the in-page keyboard permanently -- on every field, across reloads, with no visible way
 * back. Diagnostics showed exactly that: nativeShell true, inputMode "text". An escape hatch
 * you cannot climb back out of is a trapdoor. The key now applies for this session only, and
 * the durable choice lives in Settings where it can be seen and reversed. */
function kbdSetOn(on, persist) {
  kbdOn = on;
  setTimeout(renderCaret, 0);   // the caret only exists while the in-app keyboard is up
  if (persist) { try { localStorage.setItem('forge.kbd', on ? '1' : '0'); } catch {} }
  kbd.hidden = !on;
  // Set before any refocus, so the reacquired focus sees the value we want.
  for (const el of FIELDS) el.setAttribute('inputmode', on ? 'none' : 'text');
  if (on) {
    renderKbd();
    dismissSystemKeyboard();
  }
}

/* Shift used to re-render the whole keyboard on every press, rebuilding ~40 buttons mid-type.
   Relabel in place instead. */
function updateShift() {
  if (kbdLayer !== 'letters') return;
  const upper = kbdShift || kbdCaps;
  for (const b of kbd.querySelectorAll('button')) {
    const k = b.dataset.k;
    if (!/^[a-zA-Z]$/.test(k)) continue;
    b.dataset.k = upper ? k.toUpperCase() : k.toLowerCase();
    const label = b.querySelector('.klabel');
    if (label) label.textContent = b.dataset.k;
  }
  const sh = kbd.querySelector('[data-k="\u21e7"]');
  if (sh) {
    sh.classList.toggle('on', kbdShift && !kbdCaps);
    sh.classList.toggle('caps', kbdCaps);
  }
}

function kbdPress(k) {
  if (k === '\u21e7') {
    // Double-tap locks caps, as on the system keyboard.
    const now = Date.now();
    if (now - lastShiftTap < 400) { kbdCaps = true; kbdShift = false; }
    else if (kbdCaps) { kbdCaps = false; kbdShift = false; }
    else { kbdShift = !kbdShift; }
    lastShiftTap = now;
    updateShift();
    return;
  }
  if (k === '\u232b')  { kbdBackspace(); return; }
  if (k === '123')      { kbdLayer = 'symbols'; renderKbd(); return; }
  if (k === 'abc')      { kbdLayer = 'letters'; renderKbd(); return; }
  if (k === '=\\<')     { kbdLayer = 'symbols2'; renderKbd(); return; }
  if (k === '?123')     { kbdLayer = 'symbols'; renderKbd(); return; }
  if (k === '\u23ce')  { send(); return; }
  kbdInsert(k);
  // Caps lock survives a keypress; a one-shot shift does not.
  if (kbdShift && !kbdCaps && kbdLayer === 'letters') { kbdShift = false; updateShift(); }
  return k.length;
}

/* Take back what a press inserted, when the press turns out to be a swipe. */
function undoInsert(n) {
  const [start] = fSel(input);
  if (!n || start < n) return;
  const v = fText(input);
  fSetText(input, v.slice(0, start - n) + v.slice(start));
  fSetSel(input, start - n, start - n);
  autosize();
  saveDraft();
}

/* Hold-to-repeat, the way a real keyboard behaves. Without it, deleting a wrong word means
   tapping backspace once per character. */
let repeatDelay = null, repeatTimer = null;
function stopRepeat() {
  clearTimeout(repeatDelay); clearInterval(repeatTimer);
  repeatDelay = repeatTimer = null;
  for (const b of kbd.querySelectorAll('.down')) b.classList.remove('down');
}

/* Highlight on touch, commit on release.
   Committing on pointerdown felt instant but meant a system gesture that merely *starts* on a
   key types it -- swiping up from the bottom edge to reveal the navigation bar begins on the
   spacebar. The highlight still lands on contact, so it reads as immediate either way, and
   moving more than a few pixels abandons the press. */
/* Per-pointer press state.
   A single set of globals meant a second thumb landing mid-tap overwrote the first, and one
   finger's release cancelled the other's press -- which reads as dropped keys when typing
   quickly with both thumbs. */
const presses = new Map();

/* Only an upward flick cancels, and only a decisive one.
   The gesture being defended against is the swipe up from the bottom edge. A 16px threshold
   in any direction also caught ordinary thumb roll, so legitimate keystrokes were being
   undone -- the "missed keypresses". Sideways movement no longer cancels at all. */
const CANCEL_UP_PX = 30;
const CANCEL_SIDE_PX = 60;
const MIN_HIGHLIGHT_MS = 70;

function releasePress(id, undo) {
  const st = presses.get(id);
  if (!st) return;
  presses.delete(id);
  if (undo && st.inserted) undoInsert(st.inserted);
  // Hold the highlight briefly: a fast tap can otherwise be released before the press has
  // painted, so the key never visibly lights and the keyboard feels unresponsive.
  const held = performance.now() - st.at;
  const clear = () => {
    const g = st.btn.firstElementChild;
    if (g) g.style.opacity = '0';
    st.btn.classList.remove('down');
  };
  if (held < MIN_HIGHLIGHT_MS) setTimeout(clear, MIN_HIGHLIGHT_MS - held);
  else clear();
  if (st.key === '\u232b') stopRepeat();
}

function abandonPress() {
  for (const id of [...presses.keys()]) releasePress(id, false);
  stopRepeat();
}

/* Commit on touch, undo only on a deliberate upward flick. */
kbd.addEventListener('pointerdown', ev => {
  const b = ev.target.closest('button');
  if (!b) return;
  ev.preventDefault();          // keeps focus, and the caret, in the composer
  const key = b.dataset.k;
  // First statement that touches the DOM: the visual response should not queue behind the
  // text insertion. An inline opacity write on a promoted layer skips style recalc entirely.
  const glow = b.firstElementChild;
  if (glow) glow.style.opacity = '1';
  measurePaint();
  const t0 = performance.now();
  const inserted = kbdPress(key) || 0;
  recordKeyTiming(performance.now() - t0);
  presses.set(ev.pointerId, { key, btn: b, x: ev.clientX, y: ev.clientY,
                              inserted, at: performance.now() });
  if (key === '\u232b') {
    repeatDelay = setTimeout(() => {
      repeatTimer = setInterval(kbdBackspace, 55);
    }, 380);
  }
});

kbd.addEventListener('pointermove', ev => {
  const st = presses.get(ev.pointerId);      // only this finger's own movement counts
  if (!st) return;
  const dy = ev.clientY - st.y;
  if (dy < -CANCEL_UP_PX || Math.abs(ev.clientX - st.x) > CANCEL_SIDE_PX) {
    releasePress(ev.pointerId, true);
  }
});

kbd.addEventListener('pointerup', ev => releasePress(ev.pointerId, false));
kbd.addEventListener('pointercancel', ev => releasePress(ev.pointerId, false));
kbd.addEventListener('pointerleave', abandonPress);
window.addEventListener('blur', abandonPress);

/* Called by the APK after Android's speech recogniser returns. */
window.forgeVoiceResult = function (text) {
  if (text) kbdInsert(text.trim() + ' ');
};

/* Only takes over inside the APK shell. In a browser the system keyboard is the better
   option -- it still has dictation, and there is no bridge to replace it. */
if (nativeShell) {
  document.body.classList.add('in-app');
  setComposerEditable(prefersNative);
  for (const el of FIELDS) el.setAttribute('inputmode', 'none');
  // A reload can restore focus to a field before this runs, which opens the system keyboard.
  // Drop that focus so the next tap acquires it cleanly with inputmode already set.
  if (FIELDS.includes(document.activeElement)) document.activeElement.blur();
  if (prefersNative) for (const el of FIELDS) el.setAttribute('inputmode', 'text');
  for (const el of FIELDS) {
    el.addEventListener('focus', () => {
      if (suppressFocus || prefersNative) return;
      if (!kbdOn) kbdSetOn(true);
      else dismissSystemKeyboard();
    });
  }

  /* Returning to the app restores focus to the composer, and Android opens its keyboard on
     the way in -- inputmode is only consulted as focus is acquired, and that happened while
     we were backgrounded. Re-assert it on the way back. */
  const reassert = () => {
    if (prefersNative || document.hidden) return;
    for (const el of FIELDS) el.setAttribute('inputmode', 'none');
    if (kbdOn) dismissSystemKeyboard();
  };
  document.addEventListener('visibilitychange', reassert);
  window.addEventListener('focus', reassert);
  window.addEventListener('pageshow', reassert);
}

/* Pull-to-refresh is gone for good.
   It fights infinite scroll for the same gesture -- reaching the top and continuing to drag
   is how you ask for older messages, not for a reload. Reload lives in the title menu. */

/* ---------- native primitives ---------- */
/* Thin wrappers over the APK bridge. Everything here is hot-reloadable: adding a new Android
   capability used to mean a rebuild and an install tap, but these four primitives compose, so
   new behaviour is now a JS change like any other.
   Every call is safe in a plain browser tab -- it just returns null. */
const native = {
  available: !!nativeShell,

  /** Facts the VM cannot see: "device" | "packages" | "notifications". */
  query(what) {
    if (!nativeShell || !nativeShell.query) return null;
    try { return JSON.parse(nativeShell.query(what)); } catch { return null; }
  },

  /** Any intent. launch({package}) opens an app; launch({action, uri, type, extras}) is raw. */
  launch(spec) {
    if (!nativeShell || !nativeShell.launch) return null;
    try { return JSON.parse(nativeShell.launch(JSON.stringify(spec))); } catch { return null; }
  },

  /** notify({title, text, channel:'alert'|'status', id, ongoing}) */
  notify(spec) {
    if (!nativeShell || !nativeShell.notify) return null;
    try { return JSON.parse(nativeShell.notify(JSON.stringify(spec))); } catch { return null; }
  },

  /** file({op:'read'|'write'|'list'|'exists'|'delete', path, data}) */
  file(spec) {
    if (!nativeShell || !nativeShell.file) return null;
    try { return JSON.parse(nativeShell.file(JSON.stringify(spec))); } catch { return null; }
  },

  /** window({keepAwake, statusBar:'#000', navBar:'#000', immersive}) -- any subset. */
  window(spec) {
    if (!nativeShell || !nativeShell.window) return null;
    try { return JSON.parse(nativeShell.window(JSON.stringify(spec))); } catch { return null; }
  },

  /** Request a manifest-declared runtime permission. Re-query to see the result. */
  permission(name) {
    if (!nativeShell || !nativeShell.permission) return null;
    try { return JSON.parse(nativeShell.permission(name)); } catch { return null; }
  },

  /** clipboard({op:'get'}) or clipboard({op:'set', text}). */
  clipboard(spec) {
    if (!nativeShell || !nativeShell.clipboard) return null;
    try { return JSON.parse(nativeShell.clipboard(JSON.stringify(spec))); } catch { return null; }
  },

  vibrate(ms) { shellCall('vibrate', ms | 0); },

  /** Share a file out through Android's share sheet. */
  share(path, mime) {
    return native.launch({
      action: 'android.intent.action.SEND', type: mime || '*/*',
      extras: { 'android.intent.extra.STREAM': 'file://' + path },
      chooser: true, title: 'Share',
    });
  },
};
window.native = native;   // reachable from the console and from future UI code

/* ---------- immersive mode ---------- */
/* Sticky immersive: the bars hide, and a swipe from the edge brings them back temporarily --
   so this hides chrome without trapping anyone in the app. Stored locally and applied on
   load, toggled from the title menu, revertable without a rebuild. */
let immersiveOn = localStorage.getItem('forge.immersive') === '1';

function applyImmersive() {
  native.window({ immersive: immersiveOn });
  applyNavPad();
}

/* Immersive hides the navigation bar, so the keyboard can run to the bottom edge; without it
   the bar is permanently there and the last row has to clear it. */
function applyNavPad() {
  // 46px cleared the bar with a visible band of dead space still under the last key row.
  // 26px still clears it; the rest was slack.
  document.documentElement.style.setProperty('--navpad', immersiveOn ? '8px' : '26px');
}

function setImmersive(on) {
  immersiveOn = !!on;
  localStorage.setItem('forge.immersive', immersiveOn ? '1' : '0');
  applyImmersive();
}

if (nativeShell) applyImmersive();
else applyNavPad();

/* Back closes whatever is open before it leaves the page. Native hands Back over first, so
   this is a JS concern now rather than something baked into the APK. */
window.forgeOnBack = function () {
  if (drawer.classList.contains('open')) { closeDrawer(); return true; }
  if (!sheet.hidden) { closeSheet(); return true; }
  if (kbdOn) { kbdSetOn(false); return true; }
  const banner = document.getElementById('banner');
  if (banner) { banner.remove(); return true; }
  return false;
};

/* ---------- client-side error reporting ---------- */
/* A JS exception on the phone is invisible: no console, no devtools, and the symptom is
   usually just "a feature stopped working" several sections later. Ship errors to the daemon
   log instead, where `journalctl -u forge | grep "client diag"` can see them. */
function reportDiag(payload) {
  try {
    fetch('/diag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {}
}

/* Every reload the page chooses to do says so on the way out.
 *
 * A deliberate reload and an Android-killed WebView are indistinguishable afterwards: both
 * leave a fresh boot_state and an empty composer. fetch does not survive unload, so this goes
 * by beacon. If a wipe ever shows a boot_state with no "reloading" line immediately before it,
 * the page did not choose to go -- the shell restarted it, which is a different bug entirely
 * and lives on the Android side, not in here. That distinction has cost hours of guessing. */
function reloadNow(reason, files) {
  let draftLen = -1;
  try { draftLen = fText(input).length; } catch {}
  try {
    navigator.sendBeacon('/diag', new Blob(
      [JSON.stringify({ kind: 'reloading', reason, files: files || null, draftLen })],
      { type: 'application/json' }));
  } catch {}
  location.reload();
}

window.addEventListener('error', ev => {
  reportDiag({
    kind: 'js_error',
    message: String(ev.message || ''),
    source: String(ev.filename || '').split('/').pop(),
    line: ev.lineno, col: ev.colno,
    stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 900) : null,
  });
});
window.addEventListener('unhandledrejection', ev => {
  reportDiag({ kind: 'js_rejection', reason: String(ev.reason).slice(0, 900) });
});

/* One-shot snapshot of the things that decide whether the in-page keyboard takes over.
   Every one of these was guessed at least once today; now the page just says. */
setTimeout(() => {
  reportDiag({
    kind: 'boot_state',
    nativeShell: !!nativeShell,
    bridgeMethods: nativeShell ? Object.keys(nativeShell).length : 0,
    hasWindowFn: !!(nativeShell && nativeShell.window),
    kbdElement: !!document.getElementById('kbd'),
    kbdOn: typeof kbdOn === 'undefined' ? 'undefined' : kbdOn,
    inputMode: input.getAttribute('inputmode'),
    immersive: typeof immersiveOn === 'undefined' ? 'undefined' : immersiveOn,
    ua: navigator.userAgent.slice(0, 60),
    /* Why this load happened, and what the composer came back with.
     *
     * "Typing gets wiped at random" has no visible cause on screen: the page reloads, the
     * transcript replays from SSE within a second, and all that is left is an empty box. These
     * two fields say whether a reload happened at all and whether the draft survived it, which
     * is the difference between a lost-draft bug and something erasing the field in place. */
    nav: (performance.getEntriesByType('navigation')[0] || {}).type || 'unknown',
    // A dead-silent notification shade has two very different causes -- the service crashing
    // before it posts anything, or the OS dropping a valid post because the permission was
    // never granted -- and only one of them is visible from Settings without a phone in hand.
    // This answers it from here instead of another round of "can you check Settings".
    notificationsEnabled: (native.query('notifications') || {}).enabled,
    draftLen: (() => { try { return (localStorage.getItem('forge.draft') || '').length; }
                       catch { return -1; } })(),
  });
}, 1500);


/* ---------- keypress timing ---------- */
/* Typing feels slow and there is no profiler on this device, so the page measures itself:
   how long the handler takes, and how big the transcript is while it does. */
let keyTimes = [];
function recordKeyTiming(ms) {
  keyTimes.push(ms);
  if (keyTimes.length < 25) return;
  const sorted = keyTimes.slice().sort((a, b) => a - b);
  reportDiag({
    kind: 'key_timing',
    samples: keyTimes.length,
    median_ms: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
    p90_ms: +sorted[Math.floor(sorted.length * 0.9)].toFixed(2),
    max_ms: +Math.max(...keyTimes).toFixed(2),
    feed_nodes: feed.childElementCount,
    attic: attic.length,
  });
  keyTimes = [];
}


/* ---------- paint latency ---------- */
/* How long after the touch can the browser actually show anything? The handler itself was
   measured at ~2ms, so if the highlight still trails the finger the time is going somewhere
   between the press and the next frame -- which is what this measures. */
let paintSamples = [];
function measurePaint() {
  const t = performance.now();
  requestAnimationFrame(() => {
    paintSamples.push(performance.now() - t);
    if (paintSamples.length < 25) return;
    const sorted = paintSamples.slice().sort((a, b) => a - b);
    reportDiag({
      kind: 'paint_latency',
      samples: paintSamples.length,
      median_ms: +sorted[Math.floor(sorted.length / 2)].toFixed(1),
      p90_ms: +sorted[Math.floor(sorted.length * 0.9)].toFixed(1),
      max_ms: +Math.max(...paintSamples).toFixed(1),
    });
    paintSamples = [];
  });
}
