// Free time Noan grants by hand from the admin dashboard (admin/index.html →
// api/admin-dashboard.js), to win back a family that signed up but never got
// going. Two kinds, both decided 2026-10-21:
//
// - 'trial14': for a family still on their trial, or whose first payment
//   failed. The trial ends 14 days from the click, whatever it was before,
//   and a failed family goes back to trialing (banner and retries stop).
// - 'free30': for a paying family. Their next payment moves 30 days later
//   than it was due. Nothing is refunded.
//
// Neither sends the family an email — Noan writes his own — but the Loops
// contact's dates are moved so automated emails don't quote the old ones.
//
// The two rails do this differently:
// - Paystack has no way to move a subscription's charge date (no update
//   endpoint at all). So the old subscription is disabled and a new one is
//   created on the same saved card with start_date set to the new date —
//   the same mechanism the trial itself uses. No card details or charge needed.
// - Paddle moves next_billed_at directly, but refuses any change to a
//   subscription that's past_due, so a Paddle family whose payment failed
//   can't be given a trial this way.
const { syncLoopsContact, formatDate } = require('./billing-notifications');

const DAY_MS = 24 * 60 * 60 * 1000;
const KINDS = { trial14: 14, free30: 30 };

const PADDLE_API_BASE_URL = process.env.PADDLE_ENVIRONMENT === 'production'
  ? 'https://api.paddle.com'
  : 'https://sandbox-api.paddle.com';

const PAYSTACK_PLAN_CODES = {
  monthly: process.env.PAYSTACK_PLAN_MONTHLY_ZA,
  yearly: process.env.PAYSTACK_PLAN_YEARLY_ZA,
};

async function paystack(path, options) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(options && options.headers),
    },
  });
  const body = await res.json().catch(() => null);
  return { ok: Boolean(res.ok && body && body.status), status: res.status, body };
}

async function paddle(path, options) {
  const res = await fetch(`${PADDLE_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options && options.headers),
    },
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

function providerOf(meta) {
  return meta.payment_provider
    || (meta.paddle_customer_id ? 'paddle' : null)
    || (meta.paystack_subscription_code ? 'paystack' : null);
}

// Which button applies to an account right now, or a reason it can't have one.
function eligibility(meta, kind) {
  const status = meta.subscription_status;
  if (meta.cancel_scheduled) return 'They have cancelled, so there is no subscription to extend.';
  if (kind === 'trial14' && status !== 'trialing' && status !== 'past_due') return 'Only for families on a trial or whose payment failed.';
  if (kind === 'free30' && status !== 'active') return 'Only for paying families.';
  return null;
}

// Disable the old Paystack subscription, start a new one billing on newDate.
// Returns the new subscription, or throws with a message for the dashboard.
// newCard moves it onto a different saved card instead of the one it bills now
// (lib/paystack-card-update.js, after a parent adds a card on Paystack's page).
async function replacePaystackSubscription(supabaseAdmin, user, meta, newDateFor, newCard) {
  const oldCode = meta.paystack_subscription_code;
  const oldToken = meta.paystack_email_token;
  if (!oldCode || !oldToken) throw new Error('No Paystack subscription on file for this family.');

  const fetched = await paystack(`/subscription/${encodeURIComponent(oldCode)}`);
  if (!fetched.ok) throw new Error(`Paystack would not return the subscription (${fetched.status}).`);
  const sub = fetched.body.data || {};
  const authorizationCode = newCard || (sub.authorization && sub.authorization.authorization_code) || meta.paystack_authorization_code;
  const customerCode = (sub.customer && sub.customer.customer_code) || meta.paystack_customer_code;
  const planCode = (sub.plan && sub.plan.plan_code) || PAYSTACK_PLAN_CODES[meta.billing_cycle === 'yearly' ? 'yearly' : 'monthly'];
  if (!authorizationCode || !customerCode || !planCode) throw new Error('Paystack is missing the card, customer or plan for this family.');
  const newDate = newDateFor(sub);

  // Marked before disabling: the subscription.disable webhook can arrive
  // before this function finishes, and api/paystack-webhook.js must not read
  // it as the family cancelling (which would lock them out and email them).
  await supabaseAdmin.auth.admin.updateUserById(user.id, {
    user_metadata: { ...meta, paystack_superseded_code: oldCode },
  });

  // Old one off first: Paystack may refuse a second live subscription to the
  // same plan for one customer, and we must never leave two that both bill.
  const disabled = await paystack('/subscription/disable', {
    method: 'POST',
    body: JSON.stringify({ code: oldCode, token: oldToken }),
  });
  if (!disabled.ok) throw new Error(`Paystack would not stop the old subscription (${disabled.status}). Nothing was changed.`);

  const created = await paystack('/subscription', {
    method: 'POST',
    body: JSON.stringify({ customer: customerCode, plan: planCode, authorization: authorizationCode, start_date: newDate }),
  });
  if (!created.ok) {
    // Put the family back exactly as they were.
    const restored = await paystack('/subscription/enable', {
      method: 'POST',
      body: JSON.stringify({ code: oldCode, token: oldToken }),
    });
    if (!restored.ok) {
      console.error('FREE TIME: OLD SUBSCRIPTION DISABLED AND NEW ONE FAILED — re-enable', oldCode, 'for', user.email, 'by hand in Paystack');
      throw new Error(`Paystack would not create the new subscription, and the old one could not be switched back on. Re-enable ${oldCode} in Paystack now.`);
    }
    throw new Error(`Paystack would not create the new subscription (${created.status}). The old one was switched back on, so nothing changed.`);
  }
  const fresh = created.body.data || {};
  return {
    newDate,
    patch: {
      subscription_id: fresh.subscription_code || null,
      paystack_subscription_code: fresh.subscription_code || null,
      // Needed to cancel the new subscription later; Paystack never sends it again.
      paystack_email_token: fresh.email_token || null,
      paystack_authorization_code: authorizationCode,
      paystack_customer_code: customerCode,
    },
  };
}

async function movePaddleSubscription(meta, newDateFor) {
  const subId = meta.subscription_id;
  if (!subId) throw new Error('No Paddle subscription on file for this family.');
  const fetched = await paddle(`/subscriptions/${encodeURIComponent(subId)}`);
  if (!fetched.ok) throw new Error(`Paddle would not return the subscription (${fetched.status}).`);
  const sub = (fetched.body && fetched.body.data) || {};
  if (sub.status === 'past_due') throw new Error('Paddle does not allow changes to a subscription whose payment has failed.');
  const newDate = newDateFor(sub);
  const updated = await paddle(`/subscriptions/${encodeURIComponent(subId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ next_billed_at: newDate, proration_billing_mode: 'do_not_bill' }),
  });
  if (!updated.ok) {
    const detail = updated.body && updated.body.error && updated.body.error.detail;
    throw new Error(`Paddle would not move the date (${updated.status}${detail ? `: ${detail}` : ''}).`);
  }
  // Paddle's subscription.updated webhook will write its own view shortly;
  // this just makes the dashboard right on the next refresh.
  return { newDate, patch: {} };
}

async function grantFreeTime(supabaseAdmin, userId, kind) {
  if (!KINDS[kind]) throw new Error('Unknown kind of free time.');
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error || !data || !data.user) throw new Error('Family not found.');
  const user = data.user;
  const meta = user.user_metadata || {};
  const refusal = eligibility(meta, kind);
  if (refusal) throw new Error(refusal);

  const now = Date.now();
  // trial14 counts from today. free30 counts from the payment that was due —
  // read from the gateway, because Supabase's copy isn't updated on renewals.
  const newDateFor = (sub) => {
    if (kind === 'trial14') {
      const target = now + 14 * DAY_MS;
      // Never shortens a trial: a 30-day offer trial, or one only just begun,
      // can already end later than 14 days from today.
      const endsMs = meta.subscription_status === 'trialing' && meta.next_billed_at ? new Date(meta.next_billed_at).getTime() : NaN;
      if (endsMs > target) throw new Error(`Their trial already ends on ${formatDate(meta.next_billed_at)}, later than 14 days from today. Nothing was changed.`);
      return new Date(target).toISOString();
    }
    const due = sub.next_payment_date || sub.next_billed_at || meta.next_billed_at;
    const dueMs = due ? new Date(due).getTime() : NaN;
    if (Number.isNaN(dueMs)) throw new Error('Could not find when their next payment is due.');
    return new Date(Math.max(dueMs, now) + 30 * DAY_MS).toISOString();
  };

  const provider = providerOf(meta);
  let result;
  if (provider === 'paystack') result = await replacePaystackSubscription(supabaseAdmin, user, meta, newDateFor);
  else if (provider === 'paddle') result = await movePaddleSubscription(meta, newDateFor);
  else throw new Error('This family has no payment provider on file.');

  // Re-read: the disable webhook may have written in between.
  const { data: latest } = await supabaseAdmin.auth.admin.getUserById(userId);
  const current = (latest && latest.user && latest.user.user_metadata) || meta;
  const grants = Array.isArray(current.free_time_grants) ? current.free_time_grants : [];
  const status = kind === 'trial14' ? 'trialing' : 'active';
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    user_metadata: {
      ...current,
      ...result.patch,
      subscription_status: status,
      next_billed_at: result.newDate,
      current_period_ends_at: result.newDate,
      payment_failed_at: null,
      payment_retry_count: 0,
      cancel_scheduled: false,
      canceled_at: null,
      free_time_grants: [...grants, { kind, granted_at: new Date(now).toISOString(), until: result.newDate }],
    },
  });
  if (updateError) {
    console.error('FREE TIME: gateway changed but Supabase not updated for', user.email, updateError.message);
    throw new Error(`The new date is set at ${provider === 'paystack' ? 'Paystack' : 'Paddle'}, but Sprout's own record could not be updated: ${updateError.message}`);
  }

  // Dates only, no events, so no workflow sends anything off the back of this.
  await syncLoopsContact(user.email, kind === 'trial14'
    ? {
      subscriptionStatus: 'trialing',
      lifecycleStage: 'trial',
      trialEndsAt: result.newDate,
      trialEndsAtDisplay: formatDate(result.newDate),
      nextBillingDate: result.newDate,
    }
    : {
      subscriptionStatus: 'active',
      lifecycleStage: 'paid',
      nextBillingDate: result.newDate,
    });

  return { kind, provider, until: result.newDate, email: user.email };
}

// Emails hello@ when a button doesn't go through, so a failure isn't missed
// when the dashboard was closed before its pop-up appeared. Loops
// transactional "INT-02 Free time not granted (internal alert)", sent to
// CONTACT_ALERT_EMAIL like the contact-form alert (INT-01). Never throws.
const FAILURE_ALERT_TRANSACTIONAL_ID = 'cmvhve4e40dz80jvrqibxnqlw';
async function sendFailureAlert(supabaseAdmin, userId, kind, reason) {
  if (!process.env.LOOPS_API_KEY) return;
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
    const user = (data && data.user) || {};
    const meta = user.user_metadata || {};
    const provider = providerOf(meta);
    const res = await fetch('https://app.loops.so/api/v1/transactional', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LOOPS_API_KEY}` },
      body: JSON.stringify({
        transactionalId: FAILURE_ALERT_TRANSACTIONAL_ID,
        email: process.env.CONTACT_ALERT_EMAIL || 'hello@sproutearnsave.com',
        addToAudience: false,
        dataVariables: {
          familyName: meta.name || '(no name)',
          familyEmail: user.email || userId,
          grant: kind === 'free30' ? '+30 days free' : kind === 'trial14' ? '+14-day trial' : String(kind),
          provider: provider === 'paystack' ? 'Paystack' : provider === 'paddle' ? 'Paddle' : 'none on file',
          attemptedAt: new Intl.DateTimeFormat('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'long', timeStyle: 'short' }).format(new Date()),
          reason: reason || 'Unknown error',
        },
      }),
    });
    if (!res.ok) console.error('Free time failure alert not sent:', res.status, await res.text());
  } catch (err) {
    console.error('Free time failure alert not sent:', err.message);
  }
}

module.exports = { grantFreeTime, sendFailureAlert, eligibility, KINDS, replacePaystackSubscription };
