-- Deleting a chore now archives it instead of hard-deleting, so historical
-- allowance-per-cycle progress (already-elapsed days) stays accurate instead
-- of being silently recalculated when a chore is removed mid-cycle.
alter table public.chores
  add column archived boolean not null default false;
