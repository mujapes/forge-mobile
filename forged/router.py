"""Choose the model by what the work needs, and only fall back to rationing near the limit.

Two mechanisms, in that order of priority:

1. **Complexity.** Most turns do not need the largest model. Reading a log, confirming a
   fix, answering "does this look right" -- these are not opus work, and spending opus on
   them is what makes a project run out of headroom before it runs out of ideas.

2. **Remaining usage, as a ceiling.** Only once the window is genuinely filling does this
   start capping what complexity is allowed to ask for. Early on it does nothing.

The constraint that shapes everything here is the prompt cache, and the arithmetic is worse
than it first looks. A switch invalidates the cache, so the next turn reprocesses the whole
context at full price instead of the ~10% a cache read costs. Measured against a real
session: switching down to sonnet costs about 4x an ordinary turn, and roughly six
consecutive cheap turns are needed before it pays for itself. Conversation alternates, so
that run usually never arrives.

Two things follow, and the second matters more than this module does.

First, the resting position is sonnet rather than opus. Staying on sonnet costs about 2.5x
less per turn than staying on opus, permanently, with no switching cost at all -- which is
a larger saving than any routing can win. Opus is escalated *to*, on sustained evidence
that the work needs it, and returned from slowly.

Second, the dominant cost is not which model is answering, it is how much context it is
carrying. Haiku holding 500k of context costs more than opus with a warm cache. Cheap work
therefore belongs in a *cheap session* -- a fresh context of a few thousand tokens -- not in
a cheap model bolted onto an expensive conversation. This module cannot do that; it is a
note for whoever wires up note-processing and other batch work.

Scoring is heuristic and deliberately not a model call. A classifier would be more accurate,
but it would add a process spawn and a round trip to every turn on a 1GB VM, to decide
something the words usually give away.
"""
from __future__ import annotations

import json
import logging
import math
import re
import time
from typing import Any

from . import config

log = logging.getLogger("forged.router")

POLICY_PATH = config.STATE_DIR / "routing.json"

# Ordered cheapest first. Complexity picks an index; usage caps it.
LADDER = [
    {"model": "haiku", "effort": "low"},
    {"model": "sonnet", "effort": "low"},
    {"model": "sonnet", "effort": "high"},
    {"model": "opus", "effort": "medium"},
    {"model": "opus", "effort": "high"},
]

DEFAULT_POLICY: dict[str, Any] = {
    "enabled": True,
    # Complexity score -> rung. A score at or above the key selects that rung.
    "bands": [0.00, 0.20, 0.40, 0.60, 0.80],
    # Highest rung still permitted at each utilisation of the five-hour window. Until 60%
    # this does nothing at all -- that is the point.
    "ceilings": [
        {"at": 0.00, "max_rung": 4},
        {"at": 0.60, "max_rung": 3},
        {"at": 0.75, "max_rung": 2},
        {"at": 0.88, "max_rung": 1},
        {"at": 0.95, "max_rung": 0},
    ],
    # Where to sit when nothing argues otherwise. Sonnet, because permanently sonnet beats
    # opus-with-clever-switching on cost and is close on quality for most of this work.
    "resting_rung": 2,
    # Turns blended into the score. Wide, because the break-even is about six consecutive
    # cheap turns -- a switch on thinner evidence than that loses money.
    "window": 8,
    # How much of the judgement comes from what recent turns actually became, rather than
    # from the words of this one. 0.5 is what the measurement supported; it is a policy
    # value rather than a constant so it can be moved without a deploy.
    "momentum": 0.5,
    # A switch costs roughly four ordinary turns. They have to be rare.
    "min_seconds_between_switches": 900,
    "hysteresis_rungs": 2,
}

# Work that tends to need the strongest model: open-ended, architectural, or diagnostic.
HEAVY = re.compile(r"""\b(
    build|implement|design|architect|refactor|rewrite|migrate|port|
    debug|diagnose|investigate|figure\s+out|work\s+out|why\s+(is|does|did)|
    plan|strategy|approach|trade[- ]?offs?|compare|evaluate|
    optimi[sz]e|profile|benchmark|
    write\s+(a|an|the)?\s*(app|module|service|driver|parser|compiler|game)|
    from\s+scratch|end[- ]to[- ]end|whole|entire|across\s+the
)\b""", re.I | re.X)

# Work that rarely does: confirmations, small edits, lookups.
LIGHT = re.compile(r"""\b(
    typo|rename|tidy|tweak|bump|
    check|look|show|list|read|cat|print|
    yes|yeah|no|nope|ok|okay|thanks|cheers|sure|fine|good|nice|
    what.s\s+(the|this)|where\s+is|when\s+did|which\s+(one|file)|
    revert|undo|again|retry|same
)\b""", re.I | re.X)


def load_policy() -> dict[str, Any]:
    try:
        raw = json.loads(POLICY_PATH.read_text())
    except (OSError, ValueError):
        return DEFAULT_POLICY
    merged = dict(DEFAULT_POLICY)
    merged.update(raw)
    return merged


def save_default_policy() -> None:
    if POLICY_PATH.exists():
        return
    try:
        POLICY_PATH.write_text(json.dumps(DEFAULT_POLICY, indent=2) + "\n")
    except OSError:
        pass


def score_prompt(text: str, policy: dict[str, Any] | None = None) -> tuple[float, str]:
    """Rate 0..1 how much model this turn probably deserves, with the reason why.

    Explicit markers win outright: a leading `!` forces the top of the ladder, `~` the
    bottom. Being able to say "this one is big" is worth more than any heuristic, and the
    cache cost of an escalation is trivial next to getting a large task answered badly.
    """
    stripped = text.strip()
    if stripped.startswith("!"):
        return 1.0, "forced up with !"
    if stripped.startswith("~"):
        return 0.0, "forced down with ~"

    words = len(stripped.split())
    reasons = []

    # Length is the single most reliable signal: long prompts carry more requirements.
    if words <= 4:
        base, why = 0.10, "very short"
    elif words <= 12:
        base, why = 0.30, "short"
    elif words <= 40:
        base, why = 0.50, "medium"
    elif words <= 120:
        base, why = 0.70, "long"
    else:
        base, why = 0.85, "very long"
    reasons.append(why)

    heavy = len(HEAVY.findall(stripped))
    light = len(LIGHT.findall(stripped))

    # Terms the tuner has learned from outcomes, kept in the policy file rather than in
    # this module on purpose. A nightly job that edits its own source can break the daemon
    # it runs inside; one that appends a word to a JSON list can only ever route slightly
    # worse, which is visible in the changelog and revertible in one edit. The cheapest
    # safe surface for something that changes itself unattended is data, never code.
    if policy:
        words = set(re.findall(r"[a-z]{3,}", stripped.lower()))
        heavy += len(words & set(policy.get("heavy_terms") or ()))
        light += len(words & set(policy.get("light_terms") or ()))
    if heavy:
        # A floor, not just a bonus. "build me an app" is eleven words and the hardest
        # thing anyone asks for; scoring it on length alone routed it to sonnet.
        base = max(base, 0.62) + min(0.30, 0.12 * heavy)
        reasons.append(f"{heavy} heavy cue{'s' if heavy > 1 else ''}")
    if light and not heavy:
        base -= min(0.20, 0.08 * light)
        reasons.append(f"{light} light cue{'s' if light > 1 else ''}")

    # Code or paths mean something concrete has to be got exactly right.
    if "```" in stripped or re.search(r"(^|\s)/\w[\w./-]*", stripped):
        base += 0.08
        reasons.append("code or paths")

    return max(0.0, min(1.0, base)), ", ".join(reasons)


# Labels a one-shot haiku classification returns, mapped onto the same ladder the
# per-turn router uses. Kept deliberately conservative -- "standard" (an everyday bug fix
# in an existing codebase) still lands on sonnet, not opus. Reaching opus needs the
# classifier to say this one is genuinely heavy or extreme.
LABEL_RUNGS = {"trivial": 0, "light": 1, "standard": 2, "heavy": 3, "extreme": 4}


def label_to_rung(label: str) -> tuple[str, str]:
    """Pure and SDK-free on purpose, like the rest of this module: the classification call
    itself (which does need the SDK) lives in chats.py and hands its answer through this."""
    rung = LADDER[LABEL_RUNGS.get(label, 2)]
    return rung["model"], rung["effort"]


class Router:
    def __init__(self) -> None:
        self.recent: list[float] = []
        # What the last few turns actually turned out to be, as opposed to what they were
        # predicted to be. Measured on 173 real turns: the previous turn's observed
        # difficulty correlates with the next one at +0.34, where the prompt's own words
        # manage only +0.18 -- so the strongest signal available was the one nothing was
        # reading. Blending the two cut mean prediction error by 21%.
        #
        # The reason is specific to how this thing is used. Scoring leans hardest on
        # prompt length, which assumes long prompts carry big asks. Mid-build the opposite
        # holds: "check rec" and "interface reloaded" are four words that launch a dozen
        # tool calls, because the context is carrying the task and the sentence is only
        # pointing at it. Momentum is what sees that; vocabulary never will.
        self.observed: list[float] = []
        self.current_rung: int | None = None
        self.last_switch = 0.0
        save_default_policy()

    # Roughly where a turn sits between "answered from context" and "long agentic run".
    # Saturating, because the difference between none and six tool calls is the whole
    # signal and the difference between twenty and forty is noise.
    OBSERVED_WINDOW = 4
    TOOLS_FOR_FULL = 18

    def note_outcome(self, tools: int) -> None:
        """Told at the end of each turn what that turn actually cost in work."""
        d = min(1.0, math.log1p(max(0, int(tools))) / math.log1p(self.TOOLS_FOR_FULL))
        self.observed.append(d)
        del self.observed[: max(0, len(self.observed) - self.OBSERVED_WINDOW)]

    @staticmethod
    def _utilisation(rate_limits: dict[str, Any]) -> float:
        window = (rate_limits or {}).get("five_hour") or {}
        value = window.get("utilization")
        return float(value) if isinstance(value, (int, float)) else 0.0

    def _ceiling(self, policy: dict[str, Any], used: float) -> int:
        allowed = len(LADDER) - 1
        for step in policy["ceilings"]:
            if used >= step["at"]:
                allowed = step["max_rung"]
        return allowed

    def choose(self, prompt: str, rate_limits: dict[str, Any]) -> dict[str, Any] | None:
        """The rung to be on for this turn, or None to stay put."""
        policy = load_policy()
        if not policy.get("enabled", True):
            return None

        raw, why = score_prompt(prompt or "", policy)
        forced = why.startswith("forced")

        # Smooth across recent turns: reacting to every message would switch constantly,
        # and each switch throws away the prompt cache.
        self.recent.append(raw)
        del self.recent[: max(0, len(self.recent) - policy["window"])]
        smoothed = raw if forced else sum(self.recent) / len(self.recent)

        # Asymmetric on purpose. Escalating is judged on *this* prompt, because a big task
        # announces itself in one sentence and then occupies many turns -- the switch pays
        # back over the task. Dropping down is judged on the smoothed run, because a few
        # short replies in the middle of hard work are not evidence the work is over.
        judged = max(raw, smoothed) if raw > smoothed else smoothed

        # An explicit ! or ~ is a person stating what they want and must not be argued
        # with; everything else is blended with what recent turns actually became.
        if self.observed and not forced:
            momentum = sum(self.observed) / len(self.observed)
            judged = policy["momentum"] * momentum + (1.0 - policy["momentum"]) * judged

        wanted = 0
        for i, edge in enumerate(policy["bands"]):
            if judged >= edge:
                wanted = i

        # Start from the resting rung rather than the bottom: with nothing to go on, sitting
        # on sonnet is cheaper than any sequence of switches that ends up there anyway.
        if self.current_rung is None:
            self.current_rung = policy["resting_rung"]
            self.last_switch = time.time()   # the resting position holds for a cooldown too

        used = self._utilisation(rate_limits)
        ceiling = self._ceiling(policy, used)
        target = min(wanted, ceiling)
        capped = target < wanted

        if target == self.current_rung:
            return None

        # Only downgrades face hysteresis and the cooldown. An escalation is allowed
        # immediately: the cost of answering a hard question on too small a model is not
        # recoverable, whereas an unnecessary upgrade costs one cache miss.
        if self.current_rung is not None and not forced and target < self.current_rung \
                and not capped:
            # Hysteresis and cooldown apply to *complexity* downgrades only. A usage cap has
            # to take effect immediately: delaying it is exactly how the limit gets hit.
            if self.current_rung - target < policy["hysteresis_rungs"]:
                return None
            if time.time() - self.last_switch < policy["min_seconds_between_switches"]:
                return None

        self.current_rung = target
        self.last_switch = time.time()
        rung = dict(LADDER[target])
        rung.update({
            "score": round(smoothed, 2),
            "reason": why,
            "utilisation": round(used, 3),
            "capped_by_usage": capped,
        })
        log.info("routing: score %.2f (%s) -> %s/%s%s",
                 smoothed, why, rung["model"], rung["effort"],
                 f" (capped, {used:.0%} used)" if capped else "")
        return rung
