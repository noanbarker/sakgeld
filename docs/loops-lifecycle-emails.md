# Loops lifecycle emails

Plain-English map of every automated email, what triggers it, and which code
fires the trigger. Rebuilt September 2026. Loops workspace: https://app.loops.so

Day 0 = the moment Paddle or Paystack confirms the trial (server-side
`trial_started` event from the billing webhooks in `api/`).

## Trial journey (calendar-based, adaptive)

Workflow `trial_onboarding_v2`, trigger `trial_started`. Every email after the
welcome only sends while the account is still trialing and not cancelling.

| Day | Email | Only if |
|---|---|---|
| 0 | Welcome to Sprout, your 14-day trial starts today | always |
| 1 | Start small: choose 3 chores | chore count is 0 |
| 2 | Tonight, let them mark one chore done | no chore completed yet |
| 5 | Make saving something they can actually see | trialing |

Workflow `trial_conversion_v2`, trigger `trial_started`: day 7 "One week in,
how is it going?" (trialing, not cancelling). It mentions the trial end date
and plan in passing; there is deliberately no separate "trial ends soon" email.

Workflow `activation_rescue_v2`, trigger `trial_started`. Each one targets a
family stuck at a specific step:

| Day | Email | Only if |
|---|---|---|
| 4 | You are about five minutes from having Sprout set up | children count is 0 |
| 9 | Give Sprout one small job to do | children but chore count is 0 |
| 11 | Try one chore all the way through today | chores but none approved |

## Behaviour-triggered

| Workflow | Trigger | Email |
|---|---|---|
| `first_completion_v1` | `first_chore_completed`, no approval yet | Approve it and watch the tree grow |
| `first_approval_v1` | `first_chore_approved` | You just paid out their first pocket money |
| `founder_feedback_activated` | `first_chore_approved` + 24 h | Can I ask you one quick Sprout question? |
| `founder_feedback_cancelled` | `trial_cancelled` + 18 h | What made Sprout not quite right for you? |
| `founder_feedback_paid` | `subscription_activated` + 10 days | What should we make better next? |
| `payment_failed_v1` | `payment_failed` (Paystack) | Your Sprout payment didn't go through |
| `payment_last_day_v1` | `payment_retry_failed` with attempt 3 (day 7 of retries) | Your Sprout access ends soon |
| `winback_v1` | `account_cancelled` + 30 days, still cancelled | Your family's Sprout history is deleted soon |

Transactional (sent directly by the webhooks, not workflows): TXN-03 trial
cancelled, TXN-04 subscription activated, TXN-05 paid subscription cancelled.

Paddle customers get Paddle's own payment-failure emails, so the two payment
workflows only ever fire for Paystack (South African) accounts.

## Contact properties the filters depend on

Set to zero/false at the first `trial_started` by both webhooks, then updated by
`api/loops-track.js` as the parent uses the app: `childrenCount`, `choreCount`,
`hasCompletedChore`, `hasApprovedChore`. Without the zeros, "equals 0" filters
never match a contact that has done nothing, which is exactly who the rescue
emails are for.

Other properties the emails read: `accessEndsAtDisplay` (human-readable date
on payment events), `deletionDate` (60 days after cancellation, from
`purgeDateFrom` in `lib/billing-notifications.js`), `wasPaying`, `attempt`.

Loops only accepts contact properties that already exist in the workspace, so
create the property in Audience before sending it from code. Date-typed
properties reject human-readable dates: send ISO strings to those and use a
separate `...Display` string property for email copy.

## Links

Every button links to the app with `utm_source=loops&utm_medium=email` plus
`utm_campaign=<workflow>` and `utm_content=<email>`, so PostHog can show which
email brought a parent back into the app.

## Known limits

- Loops timers count from the trigger; there is no "send at 18:30" option.
- Trigger frequency is "every time" for the payment and win-back workflows and
  "one time per contact" for the trial ones.
- A stray, unused event pattern named `d` exists in Loops settings (created by
  accident, cannot be deleted from the UI). Harmless.
