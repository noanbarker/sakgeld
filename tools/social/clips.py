"""
The storyboard: what each social clip shows, beat by beat.

This is the file to edit when the story changes. build.py is the engine and
should not need touching to add a clip, reorder a beat, or change what gets
typed into a field.

A beat is one app screen and, optionally, something that moves. Beats are joined
by a crossfade.

    scene   which screen, by name — see SCENES in seed.js
    y       how far down the screen to sit; "end" is as far as it goes
    hold    seconds to rest once it has finished moving (default 1.8)

A simple beat takes at most one movement:

    tap:    "<target>"      a finger presses that, then the beat ends
    scroll: (from, to)      pans down the screen — a real scroll, not a cut
    count:  (from, to)      the child's balance climbs, tree and all
    pin:    (from, to)      PIN dots fill in, one digit at a time

A beat that fills in a form uses `steps` instead: a list of small moves, each of
which may scroll, then press something, then change the screen, then rest. The
state carries from step to step.

    {"set": {...}}                  change scene parameters
    {"type": ("name", "Zoe")}       type it out, a letter at a time
                                    ("rate": 0.06 for a quicker typist)
    {"tap": "<target>", "hold": 0.4}

Tap targets are never coordinates. Either a label — `text:Done!` — or anything a
CSS selector reaches: `#k-name`, or `[onclick*="pickKidColor('coral')"]`, since
the colour swatches and icon tiles each carry their value in their onclick.
seed.js measures the real element, so a finger follows its button when the
layout changes.
"""

# A chore that is not already in the family's list, so the last section reads as
# adding a new one rather than editing what is there.
CYCLE_CHORE = {"mode": "per_cycle", "cname": "Tidy Room",
               "cdesc": "Clothes away, floor clear", "cicon": "2"}

CLIPS = {
    # ── 1 ───────────────────────────────────────────────────────────────────
    # Adding a child and adding a chore are two clips, not one. Filling in both
    # forms at a pace anyone can follow runs to twelve seconds or more, and
    # nothing here is allowed past seven.
    #
    # Presses land on the decisions — Add Kid, the colour, the avatar, Add — and
    # not on every field before typing into it. Tapping a box to type in it is
    # true to life but tells a viewer nothing, and each press costs half a
    # second the clip does not have.
    "add-child": {
        "title": "Adding a child",
        "beats": [
            {"scene": "parent-kids-1", "tap": "text:+ Add Kid", "hold": 0.5},

            {"scene": "add-kid",
             "params": {"name": "", "kpin": "", "dob": "", "colour": "", "avatar": ""},
             "steps": [
                 {"hold": 0.25},
                 {"type": ("name", "Zoe"), "hold": 0.2},
                 {"type": ("kpin", "1234"), "hold": 0.2},
                 {"set": {"dob": "2018-07-02"}, "hold": 0.35},
                 {"tap": "[onclick*=\"pickKidColor('coral')\"]"},
                 {"set": {"colour": "coral"}, "hold": 0.25},
                 {"tap": "[onclick*=\"pickEmoji('9')\"]"},
                 {"set": {"avatar": "9"}, "hold": 0.35},
                 {"y": "end", "tap": "text:Add", "hold": 0.5},
             ]},

            {"scene": "parent-kids-2", "hold": 1.3},
        ],
    },

    # ── 2 ───────────────────────────────────────────────────────────────────
    "add-chore": {
        "title": "Adding a chore",
        "beats": [
            {"scene": "without-makebed", "tap": "text:+ Add Chore", "hold": 0.5},

            # Make Bed, so the chore added here is the one the child marks done
            # and the parent then approves. The icon picker opens on the bed, so
            # this press lands on the tile that is already chosen: it depresses
            # and rings, but nothing switches.
            {"scene": "add-chore",
             "params": {"cname": "", "cdesc": "", "cval": "", "cicon": ""},
             "steps": [
                 {"hold": 0.25},
                 {"type": ("cname", "Make Bed"), "hold": 0.2},
                 {"type": ("cdesc", "Make your bed every morning"), "rate": 0.04, "hold": 0.2},
                 {"type": ("cval", "5"), "hold": 0.3},
                 {"y": "end", "hold": 0.2},
                 {"tap": "[onclick*=\"pickEmoji('1')\"]"},
                 {"set": {"cicon": "1"}, "hold": 0.5},
                 {"tap": "text:Add", "hold": 0.5},
             ]},

            {"scene": "parent-chores", "hold": 1.3},
        ],
    },

    # ── 3 ───────────────────────────────────────────────────────────────────
    "kid-login": {
        "title": "The child signs in",
        "beats": [
            {"scene": "home", "tap": "text:Liam", "hold": 0.9},

            # The keys really are pressed, one at a time, and the dots fill in
            # behind them. Quicker presses than elsewhere — four in a row at the
            # usual half-second reads as hesitation rather than a PIN.
            {"scene": "kid-pin", "params": {"pin": 0}, "steps": [
                {"hold": 0.25},
                {"tap": "text:1", "secs": 0.3}, {"set": {"pin": 1}},
                {"tap": "text:2", "secs": 0.3}, {"set": {"pin": 2}},
                {"tap": "text:3", "secs": 0.3}, {"set": {"pin": 3}},
                {"tap": "text:4", "secs": 0.3}, {"set": {"pin": 4}, "hold": 0.9},
            ]},

            # Lands exactly where mark-done begins, so the two run together
            # without a seam in the full-flow reel.
            {"scene": "kid-today", "scroll": (0, 300), "hold": 2.0},
        ],
    },

    # ── 4 ───────────────────────────────────────────────────────────────────
    "mark-done": {
        "title": "A chore gets marked Done",
        "beats": [
            {"scene": "kid-today", "y": 300, "tap": "text:Done!", "hold": 1.1},
            {"scene": "kid-done", "scroll": (300, "end"), "hold": 2.6},
        ],
    },

    # ── 5 ───────────────────────────────────────────────────────────────────
    "approve": {
        "title": "The parent approves",
        "beats": [
            # Liam's Approve all, and only his — his sister's chore stays in the
            # queue, which is what makes the point that approving is per child.
            # Each child's button carries their id in its onclick, which is what
            # makes it addressable; HERO in seed.js decides whose it is.
            # 170 rather than "end": the screen gets shorter once his group
            # clears, so "as far as it goes" would mean two different places and
            # the page would appear to jump between the two beats. This offset
            # is valid for both, and holds the queue and the balances in one
            # shot — so his balance can be seen moving by exactly the R5 that
            # was just approved.
            {"scene": "parent-queue", "y": 170, "hold": 1.2},
            {"scene": "parent-queue", "y": 170,
             "tap": "[onclick*=\"approveAllForKid('k1')\"]", "hold": 1.6},
            {"scene": "parent-approved", "y": 170, "hold": 3.0},
        ],
    },

    # ── 6 ───────────────────────────────────────────────────────────────────
    "growing": {
        "title": "The balance climbs and the tree grows",
        "beats": [
            # One rand at a time, in whole rand, across the point where the tree
            # grows. Slow enough to read the figure change.
            #
            # It starts at 485 because that is exactly where the approval left
            # him — 480, plus the R5 Make Bed is worth. Starting anywhere else
            # makes the reel jump between one section and the next.
            {"scene": "kid-balance", "count": (485, 505), "rate": 0.2, "hold": 2.4},
        ],
    },

    # ── 7 ───────────────────────────────────────────────────────────────────
    # Steps 3 and 4 of the four-step story, in one clip: the dashboard, and the
    # chore being marked done on it. `mark-done` above is the same moment
    # without the opening pan, which the six-part reel does not need because
    # `kid-login` has already panned there.
    "child-done": {
        "title": "The child does the chore",
        "beats": [
            # The chore tiles are the thing worth seeing and they sit below the
            # fold on a phone, so the clip opens by panning down to them.
            {"scene": "kid-today", "scroll": (0, 300), "hold": 0.6},
            {"scene": "kid-today", "y": 300, "tap": "text:Done!", "hold": 1.1},
            {"scene": "kid-done", "scroll": (300, "end"), "hold": 2.4},
        ],
    },

    # ── 8 ───────────────────────────────────────────────────────────────────
    # The twenty-second loop, to a brief: chores are already there, one gets
    # done, the parent approves it, and it turns up in the child's history.
    #
    # No sign-up, no PIN pad and no form. It opens on the product already in
    # use, and every beat after that is one step of the loop that makes it
    # work. The seven sections of the brief are the seven comments below.
    #
    # Ten beats, not seven: a press and what it causes cannot share a beat,
    # because the press has to be drawn on the screen as it stands *before* the
    # change it makes. Each join also costs a crossfade, which is why the holds
    # add up to more than twenty seconds and the clip does not.
    "chore-loop": {
        "title": "Set, done, approved — the whole loop",
        "beats": [
            # 0–2s · the child's list, already there
            {"scene": "kid-today", "hold": 2.2},

            # 2–5s · resting on the chores themselves, which sit below the fold
            {"scene": "kid-today", "scroll": (0, 300), "hold": 2.6},

            # 5–8s · Done!, on Make Bed
            {"scene": "kid-today", "y": 300, "tap": "text:Done!", "hold": 2.4},

            # 8–11s · and it moves to Waiting for approval, further down
            {"scene": "kid-done", "scroll": (300, "end"), "hold": 2.6},

            # 11–14s · the parent's side, with it sitting in the queue
            {"scene": "parent-queue", "y": 170, "hold": 3.0},

            # 14–17s · approved — his sister's chore stays where it is
            {"scene": "parent-queue", "y": 170,
             "tap": "[onclick*=\"approveAllForKid('k1')\"]", "hold": 1.6},
            {"scene": "parent-approved", "y": 170, "hold": 2.2},

            # 17–20s · back in the child's dashboard, from the top so it is
            # plain whose screen this is, then down to the history, the button
            # pressed, and the row it was all about pointed at.
            #
            # The rest at the top is its own beat and cannot be folded into the
            # scroll below it, which begins moving on its first frame. Without
            # it the only sight of "Hi, Liam · R 485" is mid-crossfade, half
            # dissolved into the parent's screen — which is not being back in
            # the child's dashboard, it is passing through it.
            {"scene": "kid-approved", "hold": 0.9},
            {"scene": "kid-approved", "scroll": (0, "end"), "hold": 0.4},
            {"scene": "kid-approved", "y": "end", "tap": "text:Show history", "hold": 0.3},
            # 950 puts the History heading a third of the way down, so the newest
            # row lands near the middle of the screen with the ones behind it
            # visible underneath — the point being that this is a running record.
            {"scene": "kid-history", "y": 950, "ring": "history:Make Bed", "hold": 2.8},
        ],
    },

    # ── 9 ───────────────────────────────────────────────────────────────────
    # The two allowance systems, to a brief. Sprout can pay per chore or per
    # cycle, and the choice changes what the app asks a parent for — so the
    # clip is built as a matched pair: the same three questions asked twice,
    # once under each system, and answered differently.
    #
    #     the setting          →  the setting again
    #     an amount per chore  →  an amount per child, per week
    #     a chore has a value  →  a chore has a weighting instead
    #
    # The ring does the work here. Nothing on these screens moves on its own,
    # and the differences are a field present in one form and absent from the
    # other — which nobody watching a silent clip will spot unless it is
    # pointed at.
    "allowance-systems": {
        "title": "Per chore, or per cycle",
        "beats": [
            # · the parent's own settings, and the door marked Allowance System
            {"scene": "settings", "hold": 2.2},
            {"scene": "settings", "tap": "text:Allowance System", "hold": 0.5},

            # · system one: every chore carries its own amount
            {"scene": "allowance", "hold": 1.8},
            {"scene": "allowance", "ring": "[onclick*=\"chooseAllowanceMode('per_chore')\"]",
             "hold": 3.0},

            # · so the chore form asks for a value, and the list shows one
            #   against every chore
            {"scene": "add-chore", "params": {"cval": ""}, "steps": [
                {"hold": 0.4},
                {"type": ("cval", "5"), "hold": 1.0},
            ]},
            {"scene": "add-chore", "params": {"cval": "5"}, "ring": "#c-val", "hold": 2.6},
            {"scene": "parent-chores", "hold": 3.0},

            # · back through the same door, to change the model itself
            {"scene": "settings", "hold": 1.8},
            {"scene": "settings", "tap": "text:Allowance System", "hold": 0.5},

            # · system two. The press is drawn on the screen as it stands before
            #   it, which is why choosing and having chosen are two beats.
            {"scene": "allowance",
             "tap": "[onclick*=\"chooseAllowanceMode('per_cycle')\"]", "hold": 0.5},
            {"scene": "allowance", "params": {"mode": "per_cycle"}, "hold": 1.8},

            # · and a card appears at the bottom that was not there before: how
            #   long a cycle runs, and when this one ends
            {"scene": "allowance", "params": {"mode": "per_cycle"},
             "scroll": (0, "end"), "ring": "card:Cycle Length", "hold": 3.0},

            # · the amount has moved. It is asked for once, on the child.
            {"scene": "add-kid", "params": {"mode": "per_cycle", "kcycle": ""}, "steps": [
                {"hold": 0.5},
                {"type": ("kcycle", "50"), "hold": 1.0},
            ]},
            {"scene": "add-kid", "params": {"mode": "per_cycle"},
             "ring": "#k-cycle-amount", "hold": 2.8},

            # · so the chore form no longer asks for money at all. There is no
            #   value field on this screen — the shot is as much about what is
            #   missing as about the weighting that replaced it, which is why it
            #   rests on the whole form before pointing at anything.
            {"scene": "add-chore", "params": CYCLE_CHORE, "hold": 2.0},
            {"scene": "add-chore", "params": CYCLE_CHORE,
             "tap": "[onclick*=\"setWeight(2)\"]", "hold": 0.5},
            {"scene": "add-chore", "params": dict(CYCLE_CHORE, cweight="2"),
             "ring": "[onclick*=\"setWeight(2)\"]", "hold": 2.6},
        ],
    },

    # ── the reels ───────────────────────────────────────────────────────────
    # One continuous flow, built from the six above rather than copied out of
    # them — so reworking a section updates the reel too, and the sections can
    # never quietly drift apart from it.
    #
    # The order is the story: the family is set up, the child does a chore, the
    # parent approves it, the savings grow.
    "full": {
        "title": "The whole story, end to end",
        "join": ["add-child", "add-chore", "kid-login", "mark-done", "approve", "growing"],
    },

    # The four-step cut: the parent sets a chore, the child does it, the parent
    # approves it, the savings grow. No sign-up and no PIN pad — it opens on the
    # product doing its job. Runs a little over twenty seconds.
    "chore-to-savings": {
        "title": "Chore to savings, in four steps",
        "join": ["add-chore", "child-done", "approve", "growing"],
    },
}

# The balances the tick-up passes through are in Rand. The dollar cut runs the
# same story at dollar-sized amounts, so it needs its own pair — and it starts
# where its own approval left off, the same way the Rand one does.
COUNT_USD = {"growing": (48, 56)}
