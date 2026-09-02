const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
// Shared with api/paystack-webhook.js — the emails a family gets, the ad
// events we report and the referral credit a school earns must not depend on
// which gateway happens to bill them.
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

// Generous replay-protection window: Paddle's own examples use 5 seconds, but
// that's tight enough to reject legitimate deliveries under normal network/
// cold-start latency. 5 minutes still blocks stale replayed requests.
const SIGNATURE_MAX_AGE_SECONDS = 300;

// Paddle amounts are integer minor units (e.g. cents). This assumes a
// 2-decimal currency, true for ZAR/USD/GBP/EUR — Sprout's realistic set.
function extractChargeAmount(sub) {
  if (!Array.isArray(sub.items) || !sub.currency_code) return '';
  const totalMinor = sub.items.reduce((sum, item) => {
    const unit = item && item.price && item.price.unit_price && item.price.unit_price.amount;
    const qty = (item && item.quantity) || 1;
    return sum + (unit ? parseInt(unit, 10) * qty : 0);
  }, 0);
  if (!totalMinor) return '';
  const major = totalMinor / 100;
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: sub.currency_code }).format(major);
  } catch (e) {
    return `${major.toFixed(2)} ${sub.currency_code}`;
  }
}

// Same total as extractChargeAmount, but as a plain number for the Meta
// Conversions API's `value` field, which won't accept a formatted currency string.
function extractChargeValue(sub) {
  if (!Array.isArray(sub.items)) return null;
  const totalMinor = sub.items.reduce((sum, item) => {
    const unit = item && item.price && item.price.unit_price && item.price.unit_price.amount;
    const qty = (item && item.quantity) || 1;
    return sum + (unit ? parseInt(unit, 10) * qty : 0);
  }, 0);
  return totalMinor ? totalMinor / 100 : null;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(';').map((p) => p.split('=')));
  const timestamp = parts.ts;
  const receivedSig = parts.h1;
  if (!timestamp || !receivedSig) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > SIGNATURE_MAX_AGE_SECONDS) return false;

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}:${rawBody}`, 'utf8')
    .digest('hex');

  const a = Buffer.from(receivedSig, 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const rawBody = await readRawBody(req);

  if (!verifySignature(rawBody, req.headers['paddle-signature'], process.env.PADDLE_WEBHOOK_SECRET)) {
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

  // Every subscription lifecycle event (created, activated, past_due, paused,
  // canceled, etc.) carries the subscription's current status, so handling
  // them generically keeps this forward-compatible with events we haven't
  // explicitly enumerated.
  if (typeof event.event_type === 'string' && event.event_type.startsWith('subscription.')) {
    const sub = event.data || {};
    const userId = sub.custom_data && sub.custom_data.supabase_user_id;

    if (userId) {
      const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

      // Idempotency guard: Paddle doesn't guarantee exactly-once delivery, and
      // the transition check further down (comparing old vs new status) isn't
      // enough on its own — two concurrent deliveries of the same event can
      // both read the same "before" status before either one's update below
      // commits, so both conclude "this is a fresh transition" and both send
      // the email. Claiming the event_id via a unique constraint means only
      // one concurrent request wins; the other exits here instead of
      // repeating any side effect below.
      if (event.event_id) {
        const { error: dedupeError } = await supabaseAdmin
          .from('paddle_processed_events')
          .insert({ event_id: event.event_id, event_type: event.event_type });
        if (dedupeError) {
          if (dedupeError.code === '23505') {
            // Already processed this exact event — nothing left to do.
            res.status(200).json({ received: true, duplicate: true });
            return;
          }
          // A dedupe-table hiccup shouldn't drop a real webhook — a false
          // "not yet processed" is far safer than silently losing the event.
          console.error('Paddle event dedupe insert failed:', dedupeError.message);
        }
      }

      // updateUserById replaces user_metadata wholesale rather than merging it,
      // so we fetch what's already there first — otherwise every webhook wipes
      // out the name/country/billing_cycle/signup_geo set at sign-up.
      const { data: existing, error: fetchError } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (fetchError) {
        console.error('Failed to fetch Supabase user from Paddle webhook:', fetchError.message);
        res.status(500).json({ error: 'Failed to fetch user' });
        return;
      }

      // Cancellation doesn't delete anything here — it only stamps when it
      // happened. api/purge-canceled-accounts.js does the actual deletion,
      // once the 60-day grace period has passed, so a family that reactivates
      // (e.g. after an expired card) gets their data back exactly as it was.
      // Reactivating clears the stamp, so the purge job leaves them alone.
      const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        user_metadata: {
          ...existing.user.user_metadata,
          subscription_status: sub.status || null,
          subscription_id: sub.id || null,
          paddle_customer_id: sub.customer_id || null,
          current_period_ends_at: sub.current_billing_period ? sub.current_billing_period.ends_at : null,
          next_billed_at: sub.next_billed_at || null,
          canceled_at: sub.status === 'canceled' ? (event.occurred_at || new Date().toISOString()) : null,
        },
      });
      if (error) {
        console.error('Failed to update Supabase user from Paddle webhook:', error.message);
        res.status(500).json({ error: 'Failed to update user' });
        return;
      }

      const previousStatus = existing.user.user_metadata.subscription_status || null;
      const newStatus = sub.status || null;
      const email = existing.user.email;
      const firstName = ((existing.user.user_metadata.name || '').split(' ')[0]) || 'there';
      // A scheduled (end-of-period) cancellation carries the real access-end
      // date in scheduled_change; an immediate one falls back to the current
      // billing period's end (which Paddle can null out on immediate cancels).
      const accessEndsAtRaw =
        (sub.scheduled_change && sub.scheduled_change.action === 'cancel' && sub.scheduled_change.effective_at)
        || (sub.current_billing_period ? sub.current_billing_period.ends_at : null);
      const accessEndsAt = formatDate(accessEndsAtRaw);
      const billingInterval = billingIntervalLabel(sub.billing_cycle && sub.billing_cycle.interval);
      const nextBillingDateRaw = sub.next_billed_at;
      const nextBillingDate = formatDate(nextBillingDateRaw);
      const nextChargeAmount = extractChargeAmount(sub);
      const trialStartedAtRaw = event.occurred_at || new Date().toISOString();

      // Prefer the code stored at sign-up: it's set whether or not checkout was
      // ever completed, where Paddle's custom_data only exists once it was.
      await recordReferralSignup(supabaseAdmin, {
        userId,
        email,
        rawCode: existing.user.user_metadata.referral_code || (sub.custom_data && sub.custom_data.referral_code),
        status: newStatus,
        occurredAt: event.occurred_at,
      });

      // Keep the Loops contact's properties current on every subscription
      // event, not just the ones that trigger an email — the marketing
      // Workflows' branch/exit filters read these live.
      await syncLoopsContact(email, {
        firstName,
        lifecycleStage: newStatus === 'trialing' ? 'trial' : newStatus === 'active' ? 'paid' : newStatus === 'canceled' ? 'cancelled' : undefined,
        subscriptionStatus: newStatus || undefined,
        // trialStartedAt/trialEndsAt/nextBillingDate/accessEndsAt are "Date"
        // type properties in Loops, which reject anything but ISO 8601 (or a
        // unix-ms timestamp) with a 400 — and that 400 fails this whole
        // request, silently dropping subscriptionStatus/lifecycleStage/etc
        // along with it. formatDate()'s "7 September 2026" is for email body
        // text, not this call; pass the raw ISO source instead.
        trialStartedAt: (previousStatus === null && newStatus === 'trialing') ? trialStartedAtRaw : undefined,
        trialEndsAt: newStatus === 'trialing' ? accessEndsAtRaw : undefined,
        // Email templates show {contact.trialEndsAtDisplay} rather than the
        // Date-typed trialEndsAt above, since that one has to stay a raw ISO
        // string for Loops to accept it and would render mid-email as
        // "2026-09-07T09:23:30.560Z" otherwise.
        trialEndsAtDisplay: newStatus === 'trialing' ? accessEndsAt : undefined,
        billingInterval: billingInterval || undefined,
        nextChargeAmount: nextChargeAmount || undefined,
        currency: sub.currency_code || undefined,
        nextBillingDate: nextBillingDateRaw || undefined,
        // True as soon as Paddle records a scheduled (end-of-period) cancellation,
        // not only once the subscription has actually finished canceling —
        // this is what the conversion-reminder Workflow's exit filter checks.
        cancelScheduled: newStatus === 'canceled' || Boolean(sub.scheduled_change && sub.scheduled_change.action === 'cancel'),
        accessEndsAt: newStatus === 'canceled' ? accessEndsAtRaw : undefined,
        appUrl: 'https://www.sproutearnsave.com/app/',
      });

      // Only fire on an actual status transition, so a duplicate Paddle
      // delivery (they don't guarantee exactly-once) doesn't resend the email.
      if (newStatus && newStatus !== previousStatus) {
        if (previousStatus === null && newStatus === 'trialing') {
          await sendLoopsEvent(email, 'trial_started', { firstName, trialEndsAt: accessEndsAt, billingInterval, nextChargeAmount });
          // Same event_id as the client-side Pixel StartTrial call in app/index.html —
          // Meta merges the two into one conversion instead of double-counting it.
          await sendMetaCAPIEvent({ eventName: 'StartTrial', eventId: `trial_started_${userId}`, email, userId });
        } else if (previousStatus === 'trialing' && newStatus === 'canceled') {
          await sendLoopsEmail(LOOPS_TEMPLATE.trialCancelled, email, { firstName, accessEndsAt });
          await sendLoopsEvent(email, 'trial_cancelled', { firstName });
        } else if (previousStatus === 'trialing' && newStatus === 'active') {
          await sendLoopsEmail(LOOPS_TEMPLATE.subscriptionActivated, email, { firstName, billingInterval, nextBillingDate });
          await sendLoopsEvent(email, 'subscription_activated', { firstName, billingInterval, nextBillingDate });
          // No client-side pairing here — the trial converting to paid happens
          // automatically days later, with nobody necessarily on the site, so
          // this fires from the server only (no dedup event_id needed).
          await sendMetaCAPIEvent({ eventName: 'Subscribe', eventId: `subscription_paid_${userId}`, email, userId, value: extractChargeValue(sub), currency: sub.currency_code });
        } else if (previousStatus && previousStatus !== 'trialing' && newStatus === 'canceled') {
          await sendLoopsEmail(LOOPS_TEMPLATE.subscriptionCancelled, email, { firstName, accessEndsAt });
        }
      }
    }
  }

  res.status(200).json({ received: true });
};
