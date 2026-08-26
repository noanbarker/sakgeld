"""
The storyboard: what each social clip shows, beat by beat.

This is the file to edit when the story changes. build.py is the engine and
should not need touching to add a clip, reword a caption, or reorder a beat.

A beat is one app screen plus, optionally, one thing that moves. Beats are
joined by a crossfade, so the caption above the phone changes with the screen.

    scene   which screen, by name — see SCENES in seed.js
    cap     headline above the phone
    sub     smaller line under the headline
    hold    seconds to rest on the finished state (default 1.4)

One motion per beat, at most:

    tap:    "target"        a finger presses that button, then the beat ends
    scroll: (from, to)      pans down the screen — a real scroll, not a cut
    count:  (from, to)      the child's balance climbs, tree and all
    pin:    (from, to)      PIN dots fill in, one digit at a time

Tap targets are named in TAP_TARGETS in seed.js, which measures the real button
rather than trusting a coordinate written down here.
"""

CLIPS = {
    # ── 1 ───────────────────────────────────────────────────────────────────
    "setup": {
        "title": "Setting up a child and a chore",
        "beats": [
            {"scene": "parent-kids-1", "cap": "Set up in a minute",
             "sub": "Add each child once. That's the hard part done.", "hold": 1.6},
            {"scene": "add-kid", "cap": "Name, avatar, PIN",
             "sub": "Their own way in, picked by them.",
             "scroll": (0, "end"), "tap": "add-kid", "hold": 0.5},
            {"scene": "parent-kids-2", "cap": "Zoe's in",
             "sub": "Add as many children as you have.", "hold": 1.5},
            {"scene": "add-chore", "cap": "Then pick a chore",
             "sub": "Choose an illustration, or photograph the real thing.",
             "scroll": (0, "end"), "tap": "add-chore", "hold": 0.5},
            {"scene": "parent-chores", "cap": "Chores are set",
             "sub": "Every child sees theirs the moment they log in.", "hold": 2.2},
        ],
    },

    # ── 2 ───────────────────────────────────────────────────────────────────
    "kid-login": {
        "title": "The child signs in",
        "beats": [
            {"scene": "home", "cap": "Kids get their own way in",
             "sub": "No email. No password to forget.", "tap": "home", "hold": 0.8},
            {"scene": "kid-pin", "pin": (0, 4), "cap": "Just a PIN",
             "sub": "Four digits they chose themselves.", "hold": 0.8},
            {"scene": "kid-today", "cap": "Today's chores",
             "sub": "What to do, and what it's worth.",
             "scroll": (0, 300), "hold": 2.0},
        ],
    },

    # ── 3 ───────────────────────────────────────────────────────────────────
    "mark-done": {
        "title": "A chore gets marked Done",
        "beats": [
            {"scene": "kid-today", "cap": "One tap when it's done",
             "sub": "No nagging, no arguing about what was finished.",
             "y": 280, "tap": "kid-today", "hold": 0.7},
            {"scene": "kid-done", "cap": "Off to you for a check",
             "sub": "Nothing is paid until a parent says so.",
             "scroll": (280, "end"), "hold": 2.4},
        ],
    },

    # ── 4 ───────────────────────────────────────────────────────────────────
    "approve": {
        "title": "The parent approves",
        "beats": [
            {"scene": "parent-queue", "cap": "You have the last word",
             "sub": "Approve what's really done. Skip what isn't.",
             "y": 390, "tap": "parent-queue", "hold": 0.8},
            {"scene": "parent-approved-liam", "cap": "Approved, and paid",
             "sub": "The balance moves the moment you say so.",
             "y": 390, "hold": 2.4},
        ],
    },

    # ── 5 ───────────────────────────────────────────────────────────────────
    "growing": {
        "title": "The balance climbs and the tree grows",
        "beats": [
            {"scene": "kid-balance", "cap": "They watch it grow",
             "sub": "Saving stops being an abstraction.",
             "count": (455, 515), "hold": 2.6},
        ],
    },
}

# The balances the tick-up passes through are in Rand. The dollar cut runs the
# same story at dollar-sized amounts, so it needs its own pair.
COUNT_USD = {"growing": (44, 52)}
