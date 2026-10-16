// A South African family whose subscription has ended, coming back.
//
// They've already had their free trial, so a restart is paid from day one:
// the first period is charged now, and the new Paystack subscription's first
// debit is set one period out — the same start_date mechanism the trial uses,
// just a month or a year away instead of 14 days.
//
// Two ways in, one ending:
// - api/billing-portal.js charges the card already on file (one click), then
//   calls startPaidSubscription below.
// - If that card is declined or gone, api/paystack-checkout.js sends them to
//   Paystack's card page for the full amount, and api/paystack-webhook.js calls
//   startPaidSubscription when that charge lands.
const { syncLoopsContact, recordReferralSignup } = require('./billing-notifications');
const { trackSubscriptionChange } = require('./posthog');

// Same amounts as the plans (and api/paystack-retry-failed.js), in cents.
const PLAN_AMOUNTS_CENTS = { monthly: 5900, yearly: 59000 };

const PLAN_CODES = {
  monthly: process.env.PAYSTACK_PLAN_MONTHLY_ZA,
  yearly: process.env.PAYSTACK_PLAN_YEARLY_ZA,
};

function cycleOf(metadata) {
  return (metadata || {}).billing_cycle === 'yearly' ? 'yearly' : 'monthly';
}

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

function oneCycleFromNow(billingCycle) {
  const d = new Date();
  if (billingCycle === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

// The card on file, if Paystack will still let us charge it: reusable and not
// past its expiry month. Null means "send them to the card page instead".
async function savedCard(metadata) {
  const customerCode = metadata.paystack_customer_code;
  const authorizationCode = metadata.paystack_authorization_code;
  if (!customerCode || !authorizationCode) return null;
  const customer = await paystack(`/customer/${encodeURIComponent(customerCode)}`);
  if (!customer.ok) {
    console.error('Paystack customer fetch failed:', customer.status, JSON.stringify(customer.body));
    return null;
  }
  const auth = ((customer.body.data && customer.body.data.authorizations) || [])
    .find((a) => a.authorization_code === authorizationCode);
  if (!auth || !auth.reusable) return null;
  const now = new Date();
  const expYear = Number(auth.exp_year);
  const expMonth = Number(auth.exp_month);
  if (expYear && expMonth && (expYear < now.getFullYear() || (expYear === now.getFullYear() && expMonth < now.getMonth() + 1))) {
    return null;
  }
  return {
    authorizationCode,
    last4: auth.last4 || '',
    brand: (auth.brand || auth.card_type || 'card').trim(),
    activeSubscriptions: ((customer.body.data && customer.body.data.subscriptions) || [])
      .filter((s) => s.status === 'active' || s.status === 'non-renewing'),
  };
}

// A subscription already live at Paystack for this customer, if any — left
// behind by an earlier attempt that failed after creating it.
async function liveSubscription(customerCode) {
  const customer = await paystack(`/customer/${encodeURIComponent(customerCode)}`);
  if (!customer.ok) return undefined;
  return ((customer.body.data && customer.body.data.subscriptions) || [])
    .find((s) => s.status === 'active' || s.status === 'non-renewing');
}

// The charge has gone through; create the subscription that bills from next
// period on and put the family back to 'active'. Returns true on success.
async function startPaidSubscription(supabaseAdmin, { userId, customerCode, authorizationCode, amountCents, paidAt, existingSubscription }) {
  const { data: existing, error: fetchError } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (fetchError || !existing || !existing.user) {
    console.error('Restart: could not load Supabase user', userId, fetchError && fetchError.message);
    return false;
  }
  const user = existing.user;
  const previous = user.user_metadata || {};
  const billingCycle = cycleOf(previous);
  const planCode = PLAN_CODES[billingCycle];
  const startDate = oneCycleFromNow(billingCycle);

  // A live subscription already at Paystack means an earlier attempt got this
  // far before failing; reuse it rather than create a second that bills twice.
  const created = existingSubscription
    ? { ok: true, body: { data: existingSubscription } }
    : await paystack('/subscription', {
      method: 'POST',
      body: JSON.stringify({ customer: customerCode, plan: planCode, authorization: authorizationCode, start_date: startDate }),
    });
  if (!created.ok) {
    // They've paid for this period, so they still get in — but nothing will
    // bill them next time until a subscription is created by hand.
    console.error('RESTART PAID BUT NO SUBSCRIPTION — create one by hand in Paystack for', user.email,
      created.status, JSON.stringify(created.body));
  }
  const sub = (created.ok && created.body.data) || {};

  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    user_metadata: {
      ...previous,
      payment_provider: 'paystack',
      subscription_status: 'active',
      subscription_id: sub.subscription_code || null,
      paystack_customer_code: customerCode,
      paystack_subscription_code: sub.subscription_code || null,
      paystack_email_token: sub.email_token || null,
      paystack_authorization_code: authorizationCode,
      current_period_ends_at: startDate,
      next_billed_at: startDate,
      // Clearing canceled_at is what takes them off api/purge-canceled-accounts.js's list.
      canceled_at: null,
      cancel_scheduled: false,
      payment_failed_at: null,
      payment_retry_count: 0,
      restarted_at: paidAt || new Date().toISOString(),
    },
  });
  if (updateError) {
    console.error('RESTART PAID BUT ACCOUNT NOT REOPENED — set subscription_status to active by hand for', user.email, updateError.message);
    return false;
  }

  const firstName = ((previous.name || '').split(' ')[0]) || 'there';
  await recordReferralSignup(supabaseAdmin, {
    userId, email: user.email, rawCode: previous.referral_code, status: 'active', occurredAt: paidAt || new Date().toISOString(),
  });
  await syncLoopsContact(user.email, {
    firstName,
    lifecycleStage: 'paid',
    subscriptionStatus: 'active',
    cancelScheduled: false,
    currency: 'ZAR',
    // Date-typed in Loops: raw ISO only (see the note in api/paystack-webhook.js).
    nextBillingDate: startDate,
  });
  await trackSubscriptionChange({
    userId,
    userMetadata: previous,
    previousStatus: previous.subscription_status || null,
    newStatus: 'active',
    provider: 'paystack',
    email: user.email,
    billingInterval: billingCycle,
    currency: 'ZAR',
    amount: amountCents / 100,
    cancelScheduled: false,
    cancelWasScheduled: Boolean(previous.cancel_scheduled),
    occurredAt: paidAt,
  });
  return true;
}

// One-click restart on the card already on file. The reference is fixed per
// cancellation, so a double-click or a retried request can never charge the
// card twice: Paystack rejects a reused reference, and if the first attempt
// already went through we pick it up and finish the job instead.
async function restartWithSavedCard(supabaseAdmin, user) {
  const metadata = user.user_metadata || {};
  const card = await savedCard(metadata);
  if (!card) return { ok: false, needsNewCard: true };

  const amountCents = PLAN_AMOUNTS_CENTS[cycleOf(metadata)];
  const reference = `sprout-restart-${user.id}-${Date.parse(metadata.canceled_at) || 0}`;

  let charge = null;
  const earlier = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
  if (earlier.ok && earlier.body.data && earlier.body.data.status === 'success') {
    charge = earlier.body.data;
  } else if (!earlier.ok || !earlier.body.data) {
    const attempt = await paystack('/transaction/charge_authorization', {
      method: 'POST',
      body: JSON.stringify({
        email: user.email,
        amount: amountCents,
        currency: 'ZAR',
        authorization_code: card.authorizationCode,
        reference,
        // Read by nothing today; marks the charge for anyone looking in the dashboard.
        metadata: { sprout_purpose: 'restart_saved_card', supabase_user_id: user.id },
      }),
    });
    if (attempt.ok && attempt.body.data && attempt.body.data.status === 'success') {
      charge = attempt.body.data;
    } else {
      console.error('Restart charge on saved card did not succeed:', user.id, attempt.status,
        JSON.stringify(attempt.body && (attempt.body.data ? { status: attempt.body.data.status, gateway_response: attempt.body.data.gateway_response } : attempt.body.message)));
      return { ok: false, needsNewCard: true, declined: true };
    }
  } else {
    // An earlier attempt under this reference exists but didn't succeed.
    return { ok: false, needsNewCard: true, declined: true };
  }

  const done = await startPaidSubscription(supabaseAdmin, {
    userId: user.id,
    customerCode: metadata.paystack_customer_code,
    authorizationCode: card.authorizationCode,
    amountCents,
    paidAt: charge.paid_at || charge.transaction_date,
    existingSubscription: card.activeSubscriptions[0],
  });
  return done ? { ok: true } : { ok: false, error: 'Payment went through but we could not reopen your account. Please contact us.' };
}

// The parent cancelled but their paid (or trial) time hasn't run out yet, and
// they've changed their mind. Paystack can't undo a cancellation — enabling a
// non-renewing subscription fails with "Subscription has been cancelled, and
// cannot be reactivated" (seen live 2026-10-16) — so instead we start a new
// subscription on the same saved card whose first debit falls on the day the
// old one runs out. Nothing is charged now. The old subscription then ends on
// its own, and api/paystack-webhook.js ignores that ending because it's no
// longer the subscription on file.
async function keepSubscription(supabaseAdmin, user) {
  const metadata = user.user_metadata || {};
  const customerCode = metadata.paystack_customer_code;
  const periodEnd = metadata.current_period_ends_at;
  if (!customerCode || !periodEnd || new Date(periodEnd).getTime() <= Date.now()) {
    console.error('Keep subscription: missing customer or period end for', user.id, periodEnd);
    return { ok: false };
  }
  const card = await savedCard(metadata);
  if (!card) {
    console.error('Keep subscription: saved card unusable for', user.id);
    return { ok: false, needsNewCard: true };
  }

  // A double-click (or a retry after a half-finished attempt) must not start
  // a second subscription: reuse one that's already set up and renewing.
  const fresh = card.activeSubscriptions.find((sub) => sub.status === 'active'
    && sub.subscription_code !== metadata.paystack_subscription_code);
  const created = fresh
    ? { ok: true, body: { data: fresh } }
    : await paystack('/subscription', {
      method: 'POST',
      body: JSON.stringify({
        customer: customerCode,
        plan: PLAN_CODES[cycleOf(metadata)],
        authorization: card.authorizationCode,
        start_date: periodEnd,
      }),
    });
  const sub = created.ok && created.body.data;
  if (!sub || !sub.subscription_code) {
    console.error('Keep subscription: could not create the follow-on subscription for', user.id,
      created.status, JSON.stringify(created.body && created.body.message));
    return { ok: false };
  }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
    user_metadata: {
      ...metadata,
      cancel_scheduled: false,
      subscription_id: sub.subscription_code,
      paystack_subscription_code: sub.subscription_code,
      paystack_email_token: sub.email_token || null,
      next_billed_at: periodEnd,
    },
  });
  if (error) {
    console.error('KEEP SUBSCRIPTION HALF DONE — new Paystack sub', sub.subscription_code,
      'exists but Supabase not updated for', user.email, error.message);
    return { ok: false };
  }
  const firstName = ((metadata.name || '').split(' ')[0]) || 'there';
  await syncLoopsContact(user.email, { firstName, cancelScheduled: false });
  await trackSubscriptionChange({
    userId: user.id,
    userMetadata: metadata,
    previousStatus: metadata.subscription_status || null,
    newStatus: metadata.subscription_status || null,
    provider: 'paystack',
    email: user.email,
    currency: 'ZAR',
    cancelScheduled: false,
    cancelWasScheduled: true,
  });
  return { ok: true };
}

module.exports = { PLAN_AMOUNTS_CENTS, PLAN_CODES, cycleOf, savedCard, liveSubscription, startPaidSubscription, restartWithSavedCard, keepSubscription };
