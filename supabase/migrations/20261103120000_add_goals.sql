-- Savings goals: a kid puts a set percentage of everything they earn into a
-- pot for something specific. The pot sits outside kids.balance, so it never
-- counts toward tree growth or savings milestones, and the parent holds the
-- money until the goal is bought or cancelled.
create table public.goals (
  id            text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  kid_id        text not null references public.kids(id) on delete cascade,
  name          text not null,
  target        numeric not null,
  percent       numeric not null default 0,   -- share of each earning that goes in
  match_percent numeric not null default 0,   -- parent adds this % on top of the kid's share
  image_path    text,                         -- in the chore-photos bucket, same rules
  saved         numeric not null default 0,
  status        text not null default 'active'
                check (status in ('active', 'achieved', 'cancelled')),
  created_at    timestamptz not null default now(),
  achieved_at   timestamptz,
  bought_at     timestamptz,                  -- parent tapped "Bought it"
  cancelled_at  timestamptz,
  actioned_by   uuid
);

alter table public.goals enable row level security;

create policy "users manage own goals"
  on public.goals
  for all
  using ((select auth.uid()) = user_id);

-- Every movement in or out of a goal pot.
--   auto     kid's share of an earning
--   match    parent's match on that share
--   topup    parent added money by hand
--   withdraw parent moved money back to the balance
--   return   pot returned to the balance when the goal was cancelled
create table public.goal_entries (
  id             text primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  goal_id        text not null references public.goals(id) on delete cascade,
  kid_id         text not null references public.kids(id) on delete cascade,
  amount         numeric not null,
  kind           text not null check (kind in ('auto', 'match', 'topup', 'withdraw', 'return')),
  description    text,
  transaction_id text,
  created_at     timestamptz not null default now(),
  actioned_by    uuid
);

alter table public.goal_entries enable row level security;

create policy "users manage own goal entries"
  on public.goal_entries
  for all
  using ((select auth.uid()) = user_id);

create index goal_entries_goal_id_idx on public.goal_entries (goal_id);

-- Balance-side record of money moving into ('goal', negative) or back out of
-- ('goal_return', positive) a pot, so the kid's history and "amount owed" add up.
alter table public.transactions
  add column goal_id text;
