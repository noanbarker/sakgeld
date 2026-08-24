const { createClient } = require('@supabase/supabase-js');
const { sendLoopsEvent, syncLoopsContact, formatDate } = require('../lib/billing-notifications');

// Paystack does not retry a failed subscription charge. Its own documentation
// is explicit: if the charge fails, the subscription sits in "attention" until
// the *next* billing date — a month later — while the family keeps full access
// and we're never paid for the month in between. Paddle retries for us on the
// rest-of-world rail; on the South African one this job is the replacement.
//
// Runs daily from the Vercel cron in vercel.json, alongside the account purge.
// The schedule below is ours to choose, which is the one advantage of doing it
// by hand: a card declined for temporary insufficient funds is most likely to
// succeed a few days later, near payday.
const RETRY_DAYS = [1, 3, 7];
const GIVE_UP_AFTER_DAYS = 10;

const PLAN_AMOUNTS_KOBO = { monthly: 5900, yearly: 59000 };

function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
}

module.exports = async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!process.env.PAYSTACK_SECRET_KEY) {
    res.status(500).json({ error: 'Paystack is not configured' });
    return;
  }

  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  let attempted = 0;
  let recovered = 0;
  let givenUp = 0;
  let page = 1;

  while (page <= 20) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      console.error('Retry job could not list users:', error.message);
      res.status(500).json({ error: 'Could not list users' });
      return;
    }
    const users = (data && data.users) || [];

    for (const user of users) {
      const meta = user.user_metadata || {};
      if (meta.payment_provider !== 'paystack') continue;
      if (meta.subscription_status !== 'past_due') continue;
      if (!meta.paystack_authorization_code) continue;

      const elapsed = daysSince(meta.payment_failed_at);
      if (elapsed === null) continue;

      // Stop chasing a card that isn't going to work. Cancelling the
      // subscription at Paystack is what stops it silently trying again a
      // month later, and the resulting subscription.disable event is what
      // moves the family to 'canceled' and sends the email — so no state is
      // written here, deliberately.
      if (elapsed >= GIVE_UP_AFTER_DAYS) {
        if (meta.paystack_subscription_code && meta.paystack_email_token) {
          const disabled = await fetch('https://api.paystack.co/subscription/disable', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              code: meta.paystack_subscription_code,
              token: meta.paystack_email_token,
            }),
          });
          if (!disabled.ok) {
            console.error('Could not disable unrecoverable subscription for', user.id, disabled.status);
            continue;
          }
        }
        givenUp += 1;
        continue;
      }

      // One attempt per scheduled day, and only on that day. payment_retry_count
      // records how many we've made, so a job that runs twice in a day (or a
      // retried invocation) can't double-charge anyone.
      const done = Number(meta.payment_retry_count || 0);
      if (done >= RETRY_DAYS.length) continue;
      if (elapsed < RETRY_DAYS[done]) continue;

      const amount = PLAN_AMOUNTS_KOBO[meta.billing_cycle === 'yearly' ? 'yearly' : 'monthly'];
      attempted += 1;

      const chargeRes = await fetch('https://api.paystack.co/transaction/charge_authorization', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: user.email,
          amount,
          currency: 'ZAR',
          authorization_code: meta.paystack_authorization_code,
        }),
      });
      const chargeBody = await chargeRes.json().catch(() => null);
      const succeeded = chargeRes.ok && chargeBody && chargeBody.status
        && chargeBody.data && chargeBody.data.status === 'success';

      const firstName = ((meta.name || '').split(' ')[0]) || 'there';

      if (succeeded) {
        recovered += 1;
        await supabaseAdmin.auth.admin.updateUserById(user.id, {
          user_metadata: {
            ...meta,
            subscription_status: 'active',
            payment_failed_at: null,
            payment_retry_count: 0,
          },
        });
        await syncLoopsContact(user.email, {
          firstName, subscriptionStatus: 'active', lifecycleStage: 'paid',
        });
        await sendLoopsEvent(user.email, 'payment_recovered', { firstName });
      } else {
        await supabaseAdmin.auth.admin.updateUserById(user.id, {
          user_metadata: { ...meta, payment_retry_count: done + 1 },
        });
        // Each failed attempt nudges the parent again, with the day their
        // access runs out, so the final cancellation is never a surprise.
        await sendLoopsEvent(user.email, 'payment_retry_failed', {
          firstName,
          attempt: done + 1,
          accessEndsAt: formatDate(new Date(new Date(meta.payment_failed_at).getTime() + GIVE_UP_AFTER_DAYS * 86400000).toISOString()),
        });
      }
    }

    if (users.length < 200) break;
    page += 1;
  }

  console.log(`Paystack retry job: ${attempted} attempted, ${recovered} recovered, ${givenUp} cancelled`);
  res.status(200).json({ attempted, recovered, givenUp });
};
