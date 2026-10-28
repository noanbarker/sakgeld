// A parent added a new card on Paystack's hosted manage page (the link from
// api/billing-portal.js). Paystack checks the card with an R1 charge, refunds
// it itself, and sends us that charge.success — but it does NOT move the
// subscription onto the new card. Left alone, the next debit and every retry
// in api/paystack-retry-failed.js go on charging the old card (Michelle
// Lategan, 28 Oct 2026, fixed by hand).
//
// So when that R1 lands, from api/paystack-webhook.js:
// 1. bank the new card on the account (the restart flow offers it too);
// 2. if their payment had failed, charge what they owe on it right away —
//    the parent has just proved the card works and expects to be sorted;
// 3. move the subscription onto it: disable the old one and create a new one
//    on the new card with the same next debit date, the same way admin free
//    time does (lib/free-time.js). paystack_superseded_code stops the old
//    one's disable event reading as the family cancelling.
const { syncLoopsContact, sendLoopsEvent } = require('./billing-notifications');
const { trackSubscriptionChange } = require('./posthog');
const { replacePaystackSubscription } = require('./free-time');

// Same amounts as api/paystack-retry-failed.js, in cents.
const PLAN_AMOUNTS_CENTS = { monthly: 5900, yearly: 59000 };

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

function metadataOf(data) {
  const m = data.metadata;
  if (typeof m === 'string') {
    try { return JSON.parse(m) || {}; } catch (e) { return {}; }
  }
  return m || {};
}

// Paystack marks its card-update check with transaction_type "update_card"
// and names the subscription in a custom field.
function isCardUpdate(data) {
  return metadataOf(data).transaction_type === 'update_card';
}

function subscriptionCodeOf(data) {
  const fields = metadataOf(data).custom_fields || [];
  const field = fields.find((f) => f && f.variable_name === 'subscription_code');
  return (field && field.value) || null;
}

function oneCycleFromNow(billingCycle) {
  const d = new Date();
  if (billingCycle === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

async function readMeta(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error || !data || !data.user) throw new Error(`could not load user ${userId}`);
  return { user: data.user, meta: data.user.user_metadata || {} };
}

async function writeMeta(supabaseAdmin, userId, meta) {
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { user_metadata: meta });
  if (error) throw new Error(`could not update user ${userId}: ${error.message}`);
}

// Charges what a past_due family owes on the new card. The reference is fixed
// per R1, so a redelivered webhook finds the first charge instead of making a
// second one.
async function chargeWhatTheyOwe(email, meta, authorizationCode, r1Id) {
  const reference = `sprout-cardupdate-${r1Id}`;
  const earlier = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
  if (earlier.ok && earlier.body.data && earlier.body.data.status === 'success') return true;

  const charged = await paystack('/transaction/charge_authorization', {
    method: 'POST',
    body: JSON.stringify({
      email,
      amount: PLAN_AMOUNTS_CENTS[meta.billing_cycle === 'yearly' ? 'yearly' : 'monthly'],
      currency: 'ZAR',
      authorization_code: authorizationCode,
      reference,
      // Not card_setup / restart_card and no plan, so the webhook ignores
      // this charge's own charge.success.
      metadata: { sprout_purpose: 'card_update_payment' },
    }),
  });
  const ok = charged.ok && charged.body.data && charged.body.data.status === 'success';
  if (!ok) {
    console.error('Card update: charge on new card did not go through', reference,
      charged.status, charged.body && charged.body.data && charged.body.data.gateway_response);
  }
  return ok;
}

async function applyCardUpdate(supabaseAdmin, userId, data) {
  const auth = data.authorization || {};
  const newCard = auth.authorization_code;
  if (!newCard || auth.reusable === false) {
    console.error('Card update: no reusable card on R1', data.id);
    return;
  }

  // 1. Bank the card.
  let { user, meta } = await readMeta(supabaseAdmin, userId);
  const updatedAt = new Date().toISOString();
  meta = { ...meta, paystack_authorization_code: newCard, paystack_card_updated_at: updatedAt };
  await writeMeta(supabaseAdmin, userId, meta);

  // Only a live subscription that this R1 was for gets moved. A cancelled
  // family keeps the card for the restart flow; an R1 for an older,
  // already-replaced subscription changes nothing else.
  const subCode = meta.paystack_subscription_code;
  const status = meta.subscription_status;
  if (!subCode || status === 'canceled' || meta.cancel_scheduled) return;
  const r1Sub = subscriptionCodeOf(data);
  // (The superseded code is ours: a redelivery after step 3 already ran.)
  if (r1Sub && r1Sub !== subCode && r1Sub !== meta.paystack_superseded_code) {
    console.log('Card update for', r1Sub, 'which is not the current subscription', subCode, 'of', userId, '— card banked only');
    return;
  }

  // 2. Payment failed: collect it now.
  const wasPastDue = status === 'past_due';
  const recovered = wasPastDue ? await chargeWhatTheyOwe(user.email, meta, newCard, data.id) : false;

  // 3. Move the subscription onto the new card, unless Paystack already has.
  let swap = null;
  const fetched = await paystack(`/subscription/${encodeURIComponent(subCode)}`);
  const currentCard = fetched.ok && fetched.body.data && fetched.body.data.authorization
    && fetched.body.data.authorization.authorization_code;
  if (currentCard !== newCard) {
    try {
      // Keep their next debit date. A past_due subscription's date has
      // already moved on a period; if it's somehow gone, one period from now.
      const newDateFor = (sub) => {
        const nextMs = sub.next_payment_date ? new Date(sub.next_payment_date).getTime() : NaN;
        return nextMs > Date.now() ? new Date(nextMs).toISOString() : oneCycleFromNow(meta.billing_cycle);
      };
      swap = await replacePaystackSubscription(supabaseAdmin, user, meta, newDateFor, newCard);
    } catch (err) {
      // The retry job still charges the banked card (paystack_card_updated_at),
      // but the next monthly debit would hit the old one.
      console.error('CARD UPDATE: SUBSCRIPTION STILL ON OLD CARD — move', subCode, 'for', user.email, 'by hand:', err.message);
    }
  }

  // Re-read: the old subscription's disable webhook may have written meanwhile.
  ({ meta } = await readMeta(supabaseAdmin, userId));
  await writeMeta(supabaseAdmin, userId, {
    ...meta,
    ...(swap ? { ...swap.patch, next_billed_at: swap.newDate, current_period_ends_at: swap.newDate } : {}),
    ...(recovered ? { subscription_status: 'active', payment_failed_at: null, payment_retry_count: 0 } : {}),
  });

  if (!recovered) return;
  const firstName = ((meta.name || '').split(' ')[0]) || 'there';
  await syncLoopsContact(user.email, { firstName, subscriptionStatus: 'active', lifecycleStage: 'paid' });
  await sendLoopsEvent(user.email, 'payment_recovered', { firstName });
  await trackSubscriptionChange({
    userId,
    userMetadata: meta,
    previousStatus: 'past_due',
    newStatus: 'active',
    provider: 'paystack',
    email: user.email,
    billingInterval: meta.billing_cycle === 'yearly' ? 'annually' : 'monthly',
    currency: 'ZAR',
    amount: meta.billing_cycle === 'yearly' ? 590 : 59,
    cancelScheduled: false,
    cancelWasScheduled: false,
  });
}

module.exports = { isCardUpdate, applyCardUpdate };
