-- Push notifications. When a parent turns them on in Settings, the browser
-- hands the app a "subscription": a unique push address for that device plus
-- two encryption keys. api/push-send.js posts to those addresses whenever a
-- kid marks a chore done or claims a reward, and sw.js shows the result.
--
-- One row per device, not per parent: a family's phone and the parent's
-- laptop are separate rows under the same user_id. The endpoint is unique
-- across everyone (push services guarantee that), which is what lets the app
-- re-save the same device on every visit without creating duplicates.
create table public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

-- The browser saves and removes its own device's row directly (same pattern
-- as kids/chores: a parent only ever sees their own rows). Sending is done by
-- the API with the service role, which bypasses RLS.
alter table public.push_subscriptions enable row level security;

create policy "users manage own push subscriptions"
  on public.push_subscriptions
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
