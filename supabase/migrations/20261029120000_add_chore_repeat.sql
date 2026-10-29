-- A "repeating" chore (schedule = 'repeat') comes round every week, every two
-- weeks, or every month, either on a set day or once at any time in the period,
-- and can rotate between the assigned kids one period at a time.
--
-- Shape: {
--   "every": "week" | "2weeks" | "month",
--   "when":  "day" | "anytime",
--   "day":   "Mon".."Sun",            -- the weekday, for "day"
--   "nth":   1 | 2 | 3 | 4 | -1,      -- month + "day" only: first..fourth, or last (-1)
--   "start": "YYYY-MM-DD",           -- first period; for "2weeks", the Monday the fortnights count from
--   "turns": true | false,           -- rotate between the assigned kids
--   "order": ["kidId", ...]          -- rotation order, first kid takes the first period
-- }
-- Null for every other schedule.
alter table public.chores
  add column repeat jsonb;
