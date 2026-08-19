-- Partner referral codes: a school (or an individual) hands out a code on a
-- poster, a QR, or by word of mouth, and we record which signups came in on it
-- and which of those went on to pay. Payout terms are deliberately NOT stored
-- here — those are agreed per partner outside the app, and baking a rate into
-- the database would only go stale the first time a deal is renegotiated.

create table public.referral_codes (
  id            uuid primary key default gen_random_uuid(),
  code          text not null,
  partner_name  text not null,
  partner_type  text not null default 'school',
  contact_name  text,
  contact_email text,
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  -- The code travels in a URL (/join/GREENFIELD25) and gets typed by children,
  -- so anything needing escaping or a shift key is rejected at the door rather
  -- than discovered on an already-printed poster.
  constraint referral_codes_code_format check (code ~ '^[A-Za-z0-9]{3,40}$'),
  constraint referral_codes_type_valid check (partner_type in ('school', 'individual', 'other'))
);

-- Matching is case-insensitive — a child typing `greenfield25` has to land on
-- `GREENFIELD25` — so uniqueness has to be case-insensitive too, otherwise both
-- could exist at once and the match would be a coin toss.
create unique index referral_codes_code_key on public.referral_codes (upper(code));

create table public.referral_signups (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  code_id             uuid references public.referral_codes(id) on delete set null,
  -- What the visitor actually arrived with, kept even when it matches nothing.
  -- A child who types GREENFIELD instead of GREENFIELD25 would otherwise vanish
  -- without trace; stored, the near-miss is visible and can be pointed at the
  -- right school by hand.
  code_entered        text not null,
  email               text,
  subscription_status text,
  signed_up_at        timestamptz not null default now(),
  -- Stamped the first time the subscription reaches `active`, and never cleared
  -- afterwards: it answers "did this family ever convert to paid", which is what
  -- a school actually gets paid on. subscription_status alone can't answer it,
  -- since it moves on to `canceled` a year later.
  first_paid_at       timestamptz,
  canceled_at         timestamptz,
  updated_at          timestamptz not null default now()
);

-- One row per family, so the Paddle webhook can upsert on every subscription
-- event without stacking up duplicates.
create unique index referral_signups_user_id_key on public.referral_signups (user_id);
create index referral_signups_code_id_idx on public.referral_signups (code_id);

-- Both tables are back-office only: nothing in the browser ever reads or writes
-- them. Codes are matched server-side in the Paddle webhook, so there is no
-- reason for the anon or authenticated roles to hold any grant here — which
-- also means an outsider can't enumerate the partner list by guessing codes.
-- RLS with no policies denies everything anyway; the revokes are belt and braces.
alter table public.referral_codes enable row level security;
alter table public.referral_signups enable row level security;
revoke all on public.referral_codes from anon, authenticated;
revoke all on public.referral_signups from anon, authenticated;

-- The at-a-glance report: one row per partner, safe to eyeball in the Table
-- Editor. security_invoker keeps the view honest — without it a view owned by
-- postgres would read straight past the row-level security above.
create view public.referral_summary
with (security_invoker = true) as
select
  c.code,
  c.partner_name,
  c.partner_type,
  c.active,
  count(s.id)                                               as signups,
  count(*) filter (where s.subscription_status = 'trialing') as on_trial,
  count(*) filter (where s.subscription_status = 'active')   as paying_now,
  count(*) filter (where s.first_paid_at is not null)        as ever_paid,
  count(*) filter (where s.subscription_status = 'canceled') as cancelled,
  max(s.signed_up_at)                                        as last_signup_at
from public.referral_codes c
left join public.referral_signups s on s.code_id = c.id
group by c.id, c.code, c.partner_name, c.partner_type, c.active;

revoke all on public.referral_summary from anon, authenticated;
