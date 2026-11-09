# Goals — feature spec (draft, branch `goals`)

Kids save part of what they earn towards specific things. Agreed with Noan 2026-11-03.

## How the money works

- **Separate pot per goal.** Goal money leaves the spendable balance. Total = balance + all goal pots.
- **Parent creates goals.** Kids can't create or edit them.
- **Several goals per kid**, each with **one percentage** (e.g. Bike 30%, Lego 20%). Total across a kid's active goals can't exceed 100%.
- **The percentage applies to:** chore earnings (per-chore approvals, or the cycle payout in per-cycle mode), reward approvals, milestone bonuses.
- **Manual top-ups:** a parent can move extra money into a goal at any time (from the kid's balance, or as new money).
- **Parent match (optional per goal):** e.g. parent adds R1 for every R2 the kid saves into the goal. Match money goes straight into the pot.
- **Goal reached:** kid gets a celebration, automatic saving to that goal stops (its % flows back to the balance), parent gets a push notification and taps **Bought it**, which records the money as spent.
- **Withdrawals:** parent only. **Cancel goal** returns the pot to the kid's balance.
- **Tree growth and savings milestones ignore goal money** — it's earmarked to be spent. Only when a goal is cancelled does that money join the balance and start counting.
- **Parent holds goal money.** Goal pots are left out of "amount owed" on Distributions and out of the Reconciliation comparison.
- **Points mode:** same thing, in points.

## Parent side

- New **Goals** page in the menu, listing every kid's goals.
- Create / edit: goal name, target amount, photo (upload or take one), which kid, percentage, optional match.
- Per goal: progress, top up, withdraw, cancel, **Bought it** (once reached).
- Push notification when a goal is reached.

## Kid side

- **Top blue panel:** under the big savings number, a "Goals" line with % achieved. With several goals, the combined % (total saved across goals ÷ total of targets).
- **Goals section** on the dashboard, below Today's Chores and above Bonuses and Rewards: one card per goal with photo, name, progress bar, amount saved / target.
- Celebration when a goal is reached.

## "Since you last logged in" pop-up (new, ships with this build)

When a kid logs in and a parent has approved anything since their last visit, show a summary:
- What was approved (chores, rewards, bonuses) and the total earned.
- The split: how much went to their balance and how much to each goal.

## Decided 2026-11-03 (round 2)

- **Match applies to the automatic percentage only**, not manual top-ups.
- **History:** the moment a goal is achieved or cancelled it moves to a history list, labelled *Achieved* or *Cancelled* (same pattern as rewards). Active list then shows only goals still in progress.
- **Photos:** same rules as chore photos.
- **Kid goal cards** reuse the Bonuses card style (name + progress line + %), rearranged to fit the photo alongside the progress.

## Build notes

- SQL: `supabase/migrations/20261103120000_add_goals.sql` — new `goals` and `goal_entries` tables, plus `transactions.goal_id`. Run by hand in the Supabase SQL editor.
- Photos reuse the `chore-photos` bucket and its rules (`<user id>/goal-<id>-….webp`), so no storage setup is needed and the account purge already clears them.
- Money into a goal = a negative `goal` transaction on the balance + a `goal_entries` row on the pot. Out (withdraw / cancel) = a positive `goal_return` transaction. Match money only touches the pot. This keeps "amount owed" and Reconciliation right without changing them.
- Push kind `goal` added to `api/push-send.js`.
- Vercel preview builds of this branch use the **live** database. Test on a test family account, not a real one: approving a chore in the preview moves money into a pot that the live app doesn't know about yet.
- "New feature" pop-up for existing families: `WHATS_NEW` in app/index.html now announces Goals (replaces the chore-pause one). `launchedAt` is the go-live moment (2026-11-03 17:20 SAST), so only families who signed up before then see it.
- Add goal form (2026-11-09, after Donne Close's goal sat at 0% with R0 while her son had R703 saved): optional "Start with money from savings" moves money in on creation (can finish the goal at once); the share field must be filled in (blank used to save silently as 0%); typing 0% shows a note that the goal only grows by hand.
