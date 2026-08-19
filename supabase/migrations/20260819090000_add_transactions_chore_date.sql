-- A chore payment showed the moment the parent approved it, so approving a day
-- late moved the chore to a date the child never worked on: the kid's history
-- read "18 Aug" for chores assigned on the 17th, while the parent's missed list
-- — which keys off the due date — still called the 18th a missed day.
--
-- created_at has to stay the approval moment: "amount owed" and distributions
-- only count transactions strictly after last_distribution_at, and a date-derived
-- timestamp can land in the future and drop same-day earnings off that figure.
-- So the assigned date is recorded alongside it and used for display only.
alter table public.transactions
  add column chore_date text;

-- Backfill: pair each existing chore payment with the approved completion it
-- came from. Chore payments carry only the chore's name, so the match is by
-- name + kid within the same account, taking the most recent completion due on
-- or before the approval day. Where several payments share one approval instant
-- (a batch covering more than one day), each takes the next-most-recent day in
-- turn. Anything that can't be matched inside a 7-day window is left null and
-- falls back to created_at, rather than guessing a date onto real history.
with tx as (
  select t.id, t.user_id, t.kid_id, t.description, t.created_at,
         to_char(t.created_at at time zone 'Africa/Johannesburg','YYYY-MM-DD') as ub,
         to_char((t.created_at at time zone 'Africa/Johannesburg') - interval '7 days','YYYY-MM-DD') as lb,
         row_number() over (partition by t.user_id, t.kid_id, t.description, t.created_at
                            order by t.id) as slot
  from public.transactions t
  where t.type = 'chore'
),
cand as (
  select distinct tx.id as tx_id, tx.slot, c.due_date
  from tx
  join public.chores ch on ch.user_id = tx.user_id and ch.name = tx.description
  join public.completions c on c.chore_id = ch.id and c.kid_id = tx.kid_id and c.approved = true
  where c.due_date <= tx.ub and c.due_date >= tx.lb
),
ranked as (
  select tx_id, slot, due_date,
         row_number() over (partition by tx_id order by due_date desc) as rk
  from cand
)
update public.transactions t
   set chore_date = ranked.due_date
  from ranked
 where ranked.tx_id = t.id
   and ranked.rk = ranked.slot;
