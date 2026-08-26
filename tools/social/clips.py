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

# Typed out at the pace a parent actually types, which is what makes the setup
# clip read as someone using the app rather than a slideshow of finished states.
CHORE_DESC = "Colours and whites"

CLIPS = {
    # ── 1 ───────────────────────────────────────────────────────────────────
    "setup": {
        "title": "Setting up a child and a chore",
        "beats": [
            # The parent opens Add Kid.
            {"scene": "parent-kids-1", "tap": "text:+ Add Kid", "hold": 0.3},

            # ... and fills it in. Every field starts empty; colour and avatar
            # start on the app's own defaults, because that is what you really
            # see before you pick.
            {"scene": "add-kid",
             "params": {"name": "", "kpin": "", "dob": "", "colour": "", "avatar": ""},
             "steps": [
                 {"hold": 0.5},
                 {"tap": "#k-name"},
                 {"type": ("name", "Zoe"), "hold": 0.45},
                 {"tap": "#k-pin"},
                 {"type": ("kpin", "1234"), "hold": 0.45},
                 {"tap": "#k-dob"},
                 {"set": {"dob": "2018-07-02"}, "hold": 0.7},
                 {"tap": "[onclick*=\"pickKidColor('coral')\"]"},
                 {"set": {"colour": "coral"}, "hold": 0.6},
                 {"tap": "[onclick*=\"pickEmoji('7')\"]"},
                 {"set": {"avatar": "7"}, "hold": 0.7},
                 {"y": "end", "tap": "text:Add", "hold": 0.3},
             ]},

            {"scene": "parent-kids-2", "hold": 1.8},

            # The same again for a chore. Sort Laundry rather than Make Bed,
            # because the icon picker opens on the bed — so adding the bed chore
            # would show a finger landing on a tile that was already chosen.
            {"scene": "without-laundry", "tap": "text:+ Add Chore", "hold": 0.3},

            {"scene": "add-chore",
             "params": {"cname": "", "cdesc": "", "cval": "", "cicon": ""},
             "steps": [
                 {"hold": 0.5},
                 {"tap": "#c-name"},
                 {"type": ("cname", "Sort Laundry"), "hold": 0.4},
                 {"tap": "#c-desc"},
                 {"type": ("cdesc", CHORE_DESC), "rate": 0.065, "hold": 0.4},
                 {"tap": "#c-val"},
                 {"type": ("cval", "15"), "hold": 0.6},
                 # Down to the icon library, which brings the Add button with it.
                 {"y": "end", "hold": 0.5},
                 {"tap": "[onclick*=\"pickEmoji('4')\"]"},
                 {"set": {"cicon": "4"}, "hold": 0.9},
                 {"tap": "text:Add", "hold": 0.3},
             ]},

            {"scene": "parent-chores", "hold": 2.4},
        ],
    },

    # ── 2 ───────────────────────────────────────────────────────────────────
    "kid-login": {
        "title": "The child signs in",
        "beats": [
            {"scene": "home", "tap": "text:Zoe", "hold": 0.8},
            {"scene": "kid-pin", "pin": (0, 4), "hold": 0.8},
            {"scene": "kid-today", "scroll": (0, 300), "hold": 2.0},
        ],
    },

    # ── 3 ───────────────────────────────────────────────────────────────────
    "mark-done": {
        "title": "A chore gets marked Done",
        "beats": [
            {"scene": "kid-today", "y": 280, "tap": "text:Done!", "hold": 0.7},
            {"scene": "kid-done", "scroll": (280, "end"), "hold": 2.4},
        ],
    },

    # ── 4 ───────────────────────────────────────────────────────────────────
    "approve": {
        "title": "The parent approves",
        "beats": [
            {"scene": "parent-queue", "y": 390, "tap": "text:Approve all", "hold": 0.8},
            {"scene": "parent-approved-liam", "y": 390, "hold": 2.4},
        ],
    },

    # ── 5 ───────────────────────────────────────────────────────────────────
    "growing": {
        "title": "The balance climbs and the tree grows",
        "beats": [
            {"scene": "kid-balance", "count": (455, 515), "hold": 2.6},
        ],
    },
}

# The balances the tick-up passes through are in Rand. The dollar cut runs the
# same story at dollar-sized amounts, so it needs its own pair.
COUNT_USD = {"growing": (44, 52)}
