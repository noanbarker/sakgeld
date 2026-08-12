-- Per-kid cycle allowance amounts
alter table public.kids
  add column cycle_amount numeric default 0,
  add column cycle_amount_pending numeric null;

-- Per-chore weighting, used only in the cycle-based allowance system
alter table public.chores
  add column weight numeric default 1;

-- History of completed/closed allowance cycles, one row per kid per cycle
create table public.cycle_history (
  id text primary key,
  user_id uuid not null references auth.users(id),
  kid_id text not null references public.kids(id),
  period_type text not null,
  start_date date not null,
  end_date date not null,
  weight_completed numeric not null,
  weight_assigned numeric not null,
  percent numeric not null,
  amount_ceiling numeric not null,
  amount_paid numeric not null,
  created_at timestamptz not null default now()
);

alter table public.cycle_history enable row level security;

create policy "users manage own cycle history"
  on public.cycle_history
  for all
  using ((select auth.uid()) = user_id);
