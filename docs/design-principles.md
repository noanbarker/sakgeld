# Sprout app — design principles

The rulebook for the app (`app/index.html`). Every visual change should trace back to one of these.
Agreed with Noan on 2026-11-02 as the basis of the `app-redesign` branch.

## Principles

1. **One rulebook.** Text sizes, colours, corners, shadows and spacing come from the tokens below. No one-off values.
2. **Every colour has one job.** Green = actions, selection and good news. Red = problems, rejecting, deleting. Amber/gold = bonuses, rewards and things waiting on you (badges). Money amounts are dark ink; money added shows as green "+R". A child's colour = identifies that child, nothing else.
3. **Calm surfaces, illustrations carry the personality.** Faint flat green background, white cards, thin borders, minimal decoration. The mascot, avatars and chore pictures are the fun.
4. **Hierarchy from size and weight, not decoration.** Real sentence-case headings, not small all-caps labels.
5. **Same thing, same look, everywhere.** One button style, one form style, one card style, one list-row style.
6. **Phone first, desktop deliberate.** Desktop uses its width (centred content, larger text, side-by-side layouts) instead of stretching the phone layout.
7. **Plain words.** Sentence case, short, written from the parent's or child's side.

## Decisions

| Topic | Decision |
|---|---|
| Child colour | Accent only: avatar ring, name, thin card edge. Never card fills, money amounts or buttons. |
| Background | Faint flat green tint. No rainbow wash, no corner blobs. Tri-colour stripe once, at the top of the app. |
| Kid screens | Same rules, more playful: bigger pictures and buttons, more of the child's colour. Parent screens calmer. |
| Font | Nunito stays (matches website, Canva brand kit, social). |

## Tokens

### Text sizes
| Token | Phone | Desktop | Use |
|---|---|---|---|
| `--text-xs` | 12px | 12px | badges, timestamps, fine print |
| `--text-sm` | 14px | 14px | secondary text, form labels, meta lines |
| `--text-base` | 16px | 16px | body, list-row titles, inputs, buttons |
| `--text-lg` | 20px | 20px | section headings, card titles that lead |
| `--text-xl` | 24px | 28px | page titles |
| `--text-2xl` | 32px | 36px | big numbers (balances) |

### Weights
400 body · 600 labels and emphasis · 700 headings and buttons · 800 big numbers only.

### Corners
| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 10px | buttons, inputs, chips, icon tiles |
| `--radius-lg` | 16px | cards, sheets, modals |
| `--radius-full` | 9999px | pills, avatars, badges |

### Shadows
| Token | Use |
|---|---|
| `--shadow-card` | resting cards (barely there; the border does the work) |
| `--shadow-overlay` | modals, sheets, menus, toasts |

Buttons have no shadow.
