-- A parent can pause a chore (now, or for a set stretch of dates) and resume
-- it later. Each pause is kept rather than overwritten, so days that were
-- paused never turn into "missed" chores or count against a kid's weekly or
-- cycle totals when the history is recalculated after a resume.
--
-- Shape: [{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" | null }]
--   from = first paused day; to = the day the chore is back on (not paused).
--   to = null means paused until the parent resumes it.
alter table public.chores
  add column pauses jsonb not null default '[]'::jsonb;
