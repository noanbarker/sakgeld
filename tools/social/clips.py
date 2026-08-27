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
            {"scene": "home", "tap": "text:Zoe", "hold": 0.9},

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
            # Zoe's Approve all, not the first one on the screen — that belongs
            # to her brother. Each child's button carries their id in its
            # onclick, which is what makes it addressable.
            # 170 rather than "end": the screen gets shorter once Zoe's group
            # clears, so "as far as it goes" would mean two different places and
            # the page would appear to jump between the two beats. This offset
            # is valid for both, and holds the queue and the balances in one
            # shot — so her balance can be seen moving by exactly the R5 that
            # was just approved.
            {"scene": "parent-queue", "y": 170, "hold": 1.2},
            {"scene": "parent-queue", "y": 170,
             "tap": "[onclick*=\"approveAllForKid('k2')\"]", "hold": 1.6},
            {"scene": "parent-approved-zoe", "y": 170, "hold": 3.0},
        ],
    },

    # ── 6 ───────────────────────────────────────────────────────────────────
    "growing": {
        "title": "The balance climbs and the tree grows",
        "beats": [
            # One rand at a time, in whole rand, across the point where the tree
            # grows. Slow enough to read the figure change.
            {"scene": "kid-balance", "count": (495, 515), "rate": 0.2, "hold": 2.8},
        ],
    },

    # ── the reel ────────────────────────────────────────────────────────────
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
}

# The balances the tick-up passes through are in Rand. The dollar cut runs the
# same story at dollar-sized amounts, so it needs its own pair.
COUNT_USD = {"growing": (46, 54)}
