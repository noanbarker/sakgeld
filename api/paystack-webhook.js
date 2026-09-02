const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const {
  LOOPS_TEMPLATE,
  formatDate,
  billingIntervalLabel,
  sendLoopsEmail,
  syncLoopsContact,
  sendLoopsEvent,
  recordReferralSignup,
  sendMetaCAPIEvent,
} = require('../lib/billing-notifications');

// South African subscription rail. The rest of the world is billed by Paddle
// (api/paddle-webhook.js) and nothing here touches those customers.
//
// The shapes differ enough between the two gateways to be worth stating:
// Paddle sends one subscription.* event carrying the subscription's current
// status, so that webhook can handle every lifecycle change generically.
// Paystack instead sends several narrower events and has no "trialing" status
// at all — its five statuses are active, non-renewing, attention, completed
// and cancelled. So this file *derives* Sprout's status vocabulary
// (trialing / active / past_due / canceled), which is what app/index.html
// already reads, from those narrower signals.
const TRIAL_DAYS = 14;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Paystack signs the raw payload with HMAC SHA512 using the integration's
// secret key — there's no separate webhook secret and no timestamp in the
// signature, so unlike Paddle there's no replay window to enforce here. The
// idempotency table below is what stops a replayed event having any effect.
//
// Paystack's own Node sample hashes JSON.stringify(req.body), which only works
// while a re-serialisation happens to match the bytes they signed. We hash the
// raw body instead, which is what was actually signed.
function verifySignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(String(header), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
  return { ok: res.ok && body && body.status, status: res.status, body };
}

function randToAmount(minorUnits, currency) {
  if (!minorUnits) return '';
  const major = minorUnits / 100;
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'ZAR' }).format(major);
  } catch (e) {
    return `${major.toFixed(2)} ${currency || 'ZAR'}`;
  }
}

// Writes subscription state onto the Supabase user, preserving everything else
// in user_metadata. updateUserById replaces the object wholesale rather than
// merging, so without re-reading first every webhook would wipe out the
// name/country/billing_cycle/signup_geo set at sign-up.
//
// Returns the previous status so callers can fire an email only on a real
// transition, or null if the user has gone.
async function applySubscriptionState(supabaseAdmin, userId, patch) {
  const { data: existing, error: fetchError } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (fetchError || !existing || !existing.user) {
    console.error('Failed to fetch Supabase user from Paystack webhook:', fetchError && fetchError.message);
    return null;
  }
  const previous = existing.user.user_metadata || {};
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    user_metadata: {
      ...previous,
      // Marks which rail owns this family's billing. api/billing-portal.js
      // reads it to decide whether "Manage Subscription" opens Paddle's portal
      // or Paystack's hosted card page, and it must never be overwritten on a
      // customer who signed up through Paddle.
      payment_provider: 'paystack',
      ...patch,
    },
  });
  if (error) {
    console.error('Failed to update Supabase user from Paystack webhook:', error.message);
    return null;
  }
  return { previousStatus: previous.subscription_status || null, user: existing.user, metadata: previous };
}

// The card-setup charge from api/paystack-checkout.js has just succeeded, so
// we now hold a reusable card authorisation. Refund the R1 immediately, then
// create the real subscription with its first debit set 14 days out — that
// start_date is Paystack's documented mechanism for a free trial period.
async function startTrialFromCardSetup(supabaseAdmin, data) {
  const meta = data.metadata || {};
  const userId = meta.supabase_user_id;
  const planCode = meta.plan_code;
  const billingCycle = meta.billing_cycle === 'yearly' ? 'yearly' : 'monthly';
  const authorizationCode = data.authorization && data.authorization.authorization_code;
  const customerCode = data.customer && data.customer.customer_code;

  if (!userId || !planCode || !authorizationCode || !customerCode) {
    console.error('Card setup succeeded but is missing what a subscription needs:', JSON.stringify({
      userId: Boolean(userId), planCode: Boolean(planCode),
      authorizationCode: Boolean(authorizationCode), customerCode: Boolean(customerCode),
    }));
    return;
  }

  // Refund first and independently of everything below: the parent has been
  // debited real money and getting it back must not depend on the subscription
  // call succeeding. A failure here is logged loudly rather than retried,
  // because a duplicate refund request would be worse than a missing one — the
  // dedupe table means we only reach this once per charge.
  const refund = await paystack('/refund', {
    method: 'POST',
    body: JSON.stringify({ transaction: data.reference }),
  });
  if (!refund.ok) {
    console.error('CARD SETUP REFUND FAILED — refund by hand in the Paystack dashboard. Reference:',
      data.reference, refund.status, JSON.stringify(refund.body));
  }

  const startDate = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const created = await paystack('/subscription', {
    method: 'POST',
    body: JSON.stringify({
      customer: customerCode,
      plan: planCode,
      authorization: authorizationCode,
      start_date: startDate,
    }),
  });
  if (!created.ok) {
    console.error('Paystack subscription creation failed:', created.status, JSON.stringify(created.body));
    return;
  }
  const sub = created.body.data || {};

  const applied = await applySubscriptionState(supabaseAdmin, userId, {
    subscription_status: 'trialing',
    subscription_id: sub.subscription_code || null,
    paystack_customer_code: customerCode,
    paystack_subscription_code: sub.subscription_code || null,
    // Paystack requires this token alongside the subscription code to cancel a
    // subscription, and never sends it again — losing it means the customer
    // can't cancel from inside Sprout.
    paystack_email_token: sub.email_token || null,
    paystack_authorization_code: authorizationCode,
    billing_cycle: billingCycle,
    current_period_ends_at: startDate,
    next_billed_at: startDate,
    canceled_at: null,
  });
  if (!applied) return;

  const email = applied.user.email;
  const firstName = ((applied.metadata.name || '').split(' ')[0]) || 'there';
  const trialEndsAt = formatDate(startDate);
  const trialStartedAtRaw = new Date().toISOString();
  const interval = billingIntervalLabel(billingCycle === 'yearly' ? 'annually' : 'monthly');
  const nextChargeAmount = randToAmount(billingCycle === 'yearly' ? 59000 : 5900, 'ZAR');

  await recordReferralSignup(supabaseAdmin, {
    userId,
    email,
    rawCode: applied.metadata.referral_code || meta.referral_code,
    status: 'trialing',
    occurredAt: new Date().toISOString(),
  });

  await syncLoopsContact(email, {
    firstName,
    lifecycleStage: 'trial',
    subscriptionStatus: 'trialing',
    // trialStartedAt/trialEndsAt/nextBillingDate are "Date" type properties in
    // Loops, which reject anything but ISO 8601 (or a unix-ms timestamp) with
    // a 400 — and that 400 fails this whole request, silently dropping
    // subscriptionStatus/lifecycleStage/etc along with it. formatDate()'s
    // "7 September 2026" is for email body text, not this call — pass the raw
    // ISO source (startDate) instead of the formatted trialEndsAt display string.
    trialStartedAt: trialStartedAtRaw,
    trialEndsAt: startDate,
    // Email templates show {contact.trialEndsAtDisplay} rather than the
    // Date-typed trialEndsAt above, since that one has to stay a raw ISO
    // string for Loops to accept it and would render mid-email as
    // "2026-09-07T09:23:30.560Z" otherwise.
    trialEndsAtDisplay: trialEndsAt,
    billingInterval: interval,
    nextChargeAmount,
    currency: 'ZAR',
    nextBillingDate: startDate,
    cancelScheduled: false,
    appUrl: 'https://www.sproutearnsave.com/app/',
  });

  // Only fire when this is genuinely a new trial. A parent who cancelled and
  // came back would otherwise be counted as a fresh conversion twice.
  if (applied.previousStatus === null) {
    await sendLoopsEvent(email, 'trial_started', { firstName, trialEndsAt, billingInterval: interval, nextChargeAmount });
    // Same event_id the browser sends via the Pixel, so Meta merges the two
    // copies into one conversion instead of double-counting it.
    await sendMetaCAPIEvent({ eventName: 'StartTrial', eventId: `trial_started_${userId}`, email, userId });
  }
}

// A subscription charge went through — either the first one at the end of the
// trial, or a later renewal.
async function handleSubscriptionCharge(supabaseAdmin, data) {
  const customerCode = data.customer && data.customer.customer_code;
  if (!customerCode) return;
  const userId = await findUserIdByCustomerCode(supabaseAdmin, customerCode);
  if (!userId) return;

  const interval = billingIntervalLabel(data.plan && data.plan.interval);
  const applied = await applySubscriptionState(supabaseAdmin, userId, {
    subscription_status: 'active',
    canceled_at: null,
  });
  if (!applied) return;

  const email = applied.user.email;
  const firstName = ((applied.metadata.name || '').split(' ')[0]) || 'there';
  const nextBillingDate = formatDate(data.paid_at);

  await recordReferralSignup(supabaseAdmin, {
    userId, email,
    rawCode: applied.metadata.referral_code,
    status: 'active',
    occurredAt: data.paid_at,
  });
  await syncLoopsContact(email, {
    firstName,
    lifecycleStage: 'paid',
    subscriptionStatus: 'active',
    billingInterval: interval || undefined,
    currency: data.currency || 'ZAR',
    cancelScheduled: false,
  });

  // The trial converting to paid happens days later with nobody on the site,
  // so this fires from the server only — no browser copy to de-duplicate.
  if (applied.previousStatus === 'trialing') {
    await sendLoopsEmail(LOOPS_TEMPLATE.subscriptionActivated, email, { firstName, billingInterval: interval, nextBillingDate });
    await sendLoopsEvent(email, 'subscription_activated', { firstName, billingInterval: interval, nextBillingDate });
    await sendMetaCAPIEvent({
      eventName: 'Subscribe',
      eventId: `subscription_paid_${userId}`,
      email, userId,
      value: data.amount ? data.amount / 100 : null,
      currency: data.currency || 'ZAR',
    });
  }
}

// Paystack identifies customers by their own code, so we look the family up by
// the code banked on their metadata at trial start. Supabase has no index on
// metadata fields, so this is a filtered scan — fine at Sprout's scale, and
// the alternative (a lookup table) is a migration we don't need yet.
async function findUserIdByCustomerCode(supabaseAdmin, customerCode) {
  let page = 1;
  while (page <= 20) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      console.error('User lookup by Paystack customer code failed:', error.message);
      return null;
    }
    const users = (data && data.users) || [];
    const hit = users.find((u) => (u.user_metadata || {}).paystack_customer_code === customerCode);
    if (hit) return hit.id;
    if (users.length < 200) return null;
    page += 1;
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const rawBody = await readRawBody(req);
  if (!verifySignature(rawBody, req.headers['x-paystack-signature'], process.env.PAYSTACK_SECRET_KEY)) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  const name = event.event;
  const data = event.data || {};
  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Idempotency. Paystack retries anything we don't answer with a 200 — every
  // 3 minutes for 4 attempts, then hourly for 72 hours — and has no single
  // guaranteed-unique event id, so the key is built from the event name and
  // the id of the object it carries. Claiming it via the primary key means
  // only one of two concurrent deliveries gets past this point, which is what
  // stops a card being refunded twice or a trial email being sent twice.
  const objectId = data.id || data.subscription_code || data.reference;
  const eventKey = objectId ? `${name}:${objectId}` : null;
  if (eventKey) {
    const { error: dedupeError } = await supabaseAdmin
      .from('paystack_processed_events')
      .insert({ event_key: eventKey, event_type: name });
    if (dedupeError) {
      if (dedupeError.code === '23505') {
        res.status(200).json({ received: true, duplicate: true });
        return;
      }
      console.error('Paystack event dedupe insert failed:', dedupeError.message);
    }
  }

  try {
    if (name === 'charge.success') {
      if ((data.metadata || {}).sprout_purpose === 'card_setup') {
        await startTrialFromCardSetup(supabaseAdmin, data);
      } else if (data.plan && data.plan.plan_code) {
        await handleSubscriptionCharge(supabaseAdmin, data);
      }
    } else if (name === 'invoice.payment_failed') {
      await handleFailedCharge(supabaseAdmin, data);
    } else if (name === 'subscription.not_renew') {
      await handleCancellationScheduled(supabaseAdmin, data);
    } else if (name === 'subscription.disable') {
      await handleSubscriptionEnded(supabaseAdmin, data);
    }
  } catch (err) {
    console.error('Paystack webhook handler error:', name, err && err.message);
    // Release the claim before asking to be sent this event again.
    //
    // The dedupe row is written *before* the handler runs, so that two copies
    // of one event arriving at the same moment can't both refund a card. But
    // that same row would also swallow a genuine retry: if Supabase blipped
    // halfway through starting a trial, the parent would be left charged R1,
    // refunded, and with no subscription — and every redelivery for the next
    // 72 hours would exit at the duplicate check instead of repairing it.
    //
    // Deleting the row reopens the event, and answering non-200 is what makes
    // Paystack send it again. The individual steps are safe to repeat: a
    // second refund of an already-refunded charge is rejected by Paystack, and
    // the trial-started email only fires on a first transition into 'trialing'.
    if (eventKey) {
      const { error: releaseError } = await supabaseAdmin
        .from('paystack_processed_events')
        .delete()
        .eq('event_key', eventKey);
      if (releaseError) {
        // Can't reopen it, so don't ask for a redelivery that would only be
        // swallowed again — leave it for the logs and a human.
        console.error('UNRECOVERED PAYSTACK EVENT — needs manual review:', eventKey, releaseError.message);
        res.status(200).json({ received: true });
        return;
      }
    }
    res.status(500).json({ error: 'Handler failed, please redeliver' });
    return;
  }

  res.status(200).json({ received: true });
};

// A renewal attempt failed. Paystack does not retry within the billing cycle —
// it waits until the next payment date, a month away — so api/paystack-retry-
// failed.js runs our own retry schedule and this only records the state and
// tells the parent their card needs attention.
async function handleFailedCharge(supabaseAdmin, data) {
  const customerCode = data.customer && data.customer.customer_code;
  if (!customerCode) return;
  const userId = await findUserIdByCustomerCode(supabaseAdmin, customerCode);
  if (!userId) return;

  const applied = await applySubscriptionState(supabaseAdmin, userId, {
    subscription_status: 'past_due',
    payment_failed_at: new Date().toISOString(),
    payment_retry_count: 0,
  });
  if (!applied) return;

  const email = applied.user.email;
  const firstName = ((applied.metadata.name || '').split(' ')[0]) || 'there';
  await syncLoopsContact(email, { firstName, subscriptionStatus: 'past_due', lifecycleStage: 'payment_issue' });
  await sendLoopsEvent(email, 'payment_failed', {
    firstName,
    reason: (data.most_recent_invoice && data.most_recent_invoice.description) || data.description || '',
  });
}

// The parent cancelled: the subscription stays active until the date it would
// next have billed, then ends.
async function handleCancellationScheduled(supabaseAdmin, data) {
  const customerCode = data.customer && data.customer.customer_code;
  if (!customerCode) return;
  const userId = await findUserIdByCustomerCode(supabaseAdmin, customerCode);
  if (!userId) return;

  const applied = await applySubscriptionState(supabaseAdmin, userId, {
    cancel_scheduled: true,
    current_period_ends_at: data.next_payment_date || null,
  });
  if (!applied) return;

  await syncLoopsContact(applied.user.email, {
    firstName: ((applied.metadata.name || '').split(' ')[0]) || 'there',
    cancelScheduled: true,
    // accessEndsAt is a "Date" type property in Loops — see the note in
    // startTrialFromCardSetup on why the formatted display string breaks this.
    accessEndsAt: data.next_payment_date || undefined,
  });
}

// The subscription has actually ended. Nothing is deleted here — the stamp is
// what api/purge-canceled-accounts.js reads once the 60-day grace period has
// passed, so a family who comes back gets their data exactly as it was.
async function handleSubscriptionEnded(supabaseAdmin, data) {
  const customerCode = data.customer && data.customer.customer_code;
  if (!customerCode) return;
  const userId = await findUserIdByCustomerCode(supabaseAdmin, customerCode);
  if (!userId) return;

  const now = new Date().toISOString();
  const applied = await applySubscriptionState(supabaseAdmin, userId, {
    subscription_status: 'canceled',
    canceled_at: now,
    cancel_scheduled: false,
  });
  if (!applied) return;

  const email = applied.user.email;
  const firstName = ((applied.metadata.name || '').split(' ')[0]) || 'there';
  const accessEndsAtRaw = data.next_payment_date || now;
  const accessEndsAt = formatDate(accessEndsAtRaw);

  await recordReferralSignup(supabaseAdmin, {
    userId, email, rawCode: applied.metadata.referral_code, status: 'canceled', occurredAt: now,
  });
  await syncLoopsContact(email, {
    firstName, lifecycleStage: 'cancelled', subscriptionStatus: 'canceled', cancelScheduled: true,
    // Date type property in Loops — see note in startTrialFromCardSetup.
    accessEndsAt: accessEndsAtRaw,
  });

  // Which email depends on whether they ever paid us — the same split the
  // Paddle rail makes between a trial that lapsed and a subscription that ended.
  if (applied.previousStatus === 'trialing') {
    await sendLoopsEmail(LOOPS_TEMPLATE.trialCancelled, email, { firstName, accessEndsAt });
    await sendLoopsEvent(email, 'trial_cancelled', { firstName });
  } else if (applied.previousStatus) {
    await sendLoopsEmail(LOOPS_TEMPLATE.subscriptionCancelled, email, { firstName, accessEndsAt });
  }
}
