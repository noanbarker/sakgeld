-- Paddle explicitly doesn't guarantee exactly-once webhook delivery. The
-- webhook used to guard against resending a lifecycle email (like "your
-- subscription is now active") by comparing the subscription's old vs new
-- status read from Supabase — but two concurrent deliveries of the same
-- event can both read that same "before" state before either one's update
-- commits, so both conclude "this is a fresh transition" and both send.
--
-- Claiming the Paddle event_id here via a unique constraint closes that
-- race: only one concurrent request can win the insert, so only one ever
-- reaches the email-sending code below it.
create table public.paddle_processed_events (
  event_id     text primary key,
  event_type   text not null,
  processed_at timestamptz not null default now()
);

-- Back-office only, same reasoning as referral_codes/referral_signups:
-- nothing in the browser ever needs this, only the webhook (service role,
-- which bypasses RLS). RLS with no policies denies everything else anyway;
-- the revokes are belt and braces.
alter table public.paddle_processed_events enable row level security;
revoke all on public.paddle_processed_events from anon, authenticated;
