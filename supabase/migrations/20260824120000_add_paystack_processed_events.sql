-- Same job as paddle_processed_events, for the South African rail.
--
-- Paystack retries any webhook we don't answer with a 200: every 3 minutes for
-- the first 4 attempts, then hourly for 72 hours. That is far more aggressive
-- than Paddle, so the odds of the same event arriving twice (or of two copies
-- landing concurrently) are correspondingly higher, and every side effect in
-- api/paystack-webhook.js — refunding the card-setup charge, creating the
-- subscription, sending a Loops email — must happen exactly once.
--
-- Paystack has no single guaranteed-unique event id the way Paddle's event_id
-- is, so the webhook builds the key itself from the event name and the object
-- id it carries (e.g. "charge.success:1504173002"). That pair is stable across
-- redeliveries of the same event, which is exactly what the unique constraint
-- needs.
create table public.paystack_processed_events (
  event_key    text primary key,
  event_type   text not null,
  processed_at timestamptz not null default now()
);

-- Back-office only, matching paddle_processed_events: nothing in the browser
-- ever reads this, only the webhook via the service role, which bypasses RLS.
alter table public.paystack_processed_events enable row level security;
revoke all on public.paystack_processed_events from anon, authenticated;
