-- Daily approval reminder. On top of the "a kid just marked something done"
-- notification, a parent can ask a device for one reminder a day, at a time
-- they pick, if anything is still waiting for approval (Settings >
-- Notifications in app/index.html).
--
-- Stored per device on push_subscriptions, not per family: co-parents share a
-- login but each phone can want its own time. The time is the parent's local
-- wall-clock time and reminder_tz is the device's time zone, so 18:00 means
-- 18:00 where the parent is.
alter table public.push_subscriptions
  add column reminder_enabled   boolean not null default false,
  add column reminder_time      time    not null default '18:00',
  add column reminder_tz        text    not null default 'Africa/Johannesburg',
  add column reminder_last_sent date;

create index push_subscriptions_reminder_idx
  on public.push_subscriptions (reminder_enabled) where reminder_enabled;

-- The sender. Vercel's free plan only runs timed jobs once a day, which can't
-- honour a time each parent picks, so Supabase calls api/push-send every 15
-- minutes instead; the API works out which devices are due.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Before running: replace PASTE_CRON_SECRET_HERE with the same value saved in
-- Vercel as REMINDER_CRON_SECRET (its own secret: Vercel's CRON_SECRET is
-- marked Sensitive and can't be read back). It's kept in the Supabase vault,
-- not in the job itself.
select vault.create_secret('PASTE_CRON_SECRET_HERE', 'push_reminder_cron_secret');

select cron.schedule(
  'push-daily-reminders',
  '*/15 * * * *',
  $$
  select net.http_get(
    url := 'https://www.sproutearnsave.com/api/push-send?job=reminders',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'push_reminder_cron_secret')
    ),
    timeout_milliseconds := 30000
  );
  $$
);
