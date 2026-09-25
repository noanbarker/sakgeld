-- Meta StartTrial de-duplication and match data.
--
-- One row per trial attempt, not per account. event_id is the id Meta sees on
-- both the browser Pixel StartTrial and the server Conversions API StartTrial,
-- which is how Meta merges the two into one conversion. It's 122 bits from
-- gen_random_uuid() (Postgres's cryptographically secure generator), so nothing
-- about the account can be read from it and it can't be guessed.
--
-- A parent has at most one open (unconfirmed) attempt at a time, reused however
-- often they reopen checkout. When a webhook confirms a trial it closes that
-- attempt and stamps it with the billing provider's own reference (trial_ref),
-- so a retried webhook finds the same row and the same id. A later trial for
-- the same parent opens a fresh row with a fresh id.
--
-- fbp / fbc / client_ip / client_user_agent are only ever written for a visitor
-- who accepted cookies (api/meta-attribution.js), and are wiped the moment the
-- trial is confirmed (lib/meta-attribution.js). Whole rows are deleted 30 days
-- after they were last used (api/purge-canceled-accounts.js).
--
-- Server-only: RLS is on with no policies, so the browser can neither read nor
-- write this table. Everything goes through the API with the service role.
create table public.meta_trial_attribution (
  event_id           text primary key default ('st_' || replace(gen_random_uuid()::text, '-', '')),
  user_id            uuid not null references auth.users(id) on delete cascade,
  trial_ref          text,
  fbp                text,
  fbc                text,
  client_ip          text,
  client_user_agent  text,
  test_event_code    text,
  captured_at        timestamptz,
  issued_at          timestamptz not null default now(),
  trial_confirmed_at timestamptz,
  capi_sent_at       timestamptz,
  created_at         timestamptz not null default now()
);

create index meta_trial_attribution_user_id_idx on public.meta_trial_attribution (user_id, created_at desc);
-- At most one open attempt per parent, even if two requests race to create it.
create unique index meta_trial_attribution_one_open_idx on public.meta_trial_attribution (user_id) where trial_confirmed_at is null;
-- One row per real trial, even if two webhook deliveries race.
create unique index meta_trial_attribution_trial_ref_idx on public.meta_trial_attribution (trial_ref) where trial_ref is not null;

alter table public.meta_trial_attribution enable row level security;
revoke all on table public.meta_trial_attribution from anon, authenticated;
