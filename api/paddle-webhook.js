const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Generous replay-protection window: Paddle's own examples use 5 seconds, but
// that's tight enough to reject legitimate deliveries under normal network/
// cold-start latency. 5 minutes still blocks stale replayed requests.
const SIGNATURE_MAX_AGE_SECONDS = 300;

// Loops transactional template IDs (Sprout Loops workspace).
const LOOPS_TEMPLATE = {
  trialCancelled: 'cmsrg9qi31iax0jworozfr5np', // TXN-03
  subscriptionActivated: 'cmsrggo270dw90jxpkllonwyb', // TXN-04
  subscriptionCancelled: 'cmsrglb7x005x0kyfia2hspaa', // TXN-05
};

function formatDate(isoString) {
  if (!isoString) return '';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(isoString));
}

function billingIntervalLabel(interval) {
  if (interval === 'year') return 'annual';
  if (interval === 'month') return 'monthly';
  return interval || '';
}

// Fire-and-forget: a Loops outage should never fail the webhook or trigger a
// Paddle retry, since the Supabase subscription-state update already succeeded.
async function sendLoopsEmail(transactionalId, email, dataVariables) {
  if (!process.env.LOOPS_API_KEY || !email) return;
  try {
    const response = await fetch('https://app.loops.so/api/v1/transactional', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.LOOPS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transactionalId, email, dataVariables }),
    });
    if (!response.ok) {
      console.error('Loops transactional email failed:', response.status, await response.text());
    }
  } catch (err) {
    console.error('Loops transactional email error:', err.message);
  }
}

// Keeps the Loops contact's properties current so the marketing Workflows'
// branch/exit filters (trialing vs active, cancelScheduled, etc.) see live data.
async function syncLoopsContact(email, properties) {
  if (!process.env.LOOPS_API_KEY || !email) return;
  try {
    const response = await fetch('https://app.loops.so/api/v1/contacts/update', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.LOOPS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, ...properties }),
    });
    if (!response.ok) {
      console.error('Loops contact sync failed:', response.status, await response.text());
    }
  } catch (err) {
    console.error('Loops contact sync error:', err.message);
  }
}

// Fires a Loops event (used as Workflow triggers), separate from the direct
// transactional sends above.
async function sendLoopsEvent(email, eventName, properties) {
  if (!process.env.LOOPS_API_KEY || !email) return;
  try {
    const response = await fetch('https://app.loops.so/api/v1/events/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.LOOPS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, eventName, eventProperties: properties || {}, contactProperties: properties || {} }),
    });
    if (!response.ok) {
      console.error('Loops event send failed:', response.status, await response.text());
    }
  } catch (err) {
    console.error('Loops event send error:', err.message);
  }
}

// Records a signup against the school or partner whose code brought it in, and
// keeps its subscription status current so a partner is only ever credited for
// families that actually converted.
//
// The code arrives from the browser (user_metadata / Paddle custom_data), so it
// is untrusted text: normalising to letters and digits here is what stops a
// crafted value reaching the query below. An unrecognised code is still stored
// rather than dropped — a near-miss typo is recoverable by hand, a discarded
// one isn't.
//
// Fire-and-forget, same as the Loops and Meta helpers: this is bookkeeping, and
// failing the webhook over it would make Paddle retry and resend live emails.
async function recordReferralSignup(supabaseAdmin, { userId, email, rawCode, status, occurredAt }) {
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40);
  if (!code) return;
  const stamp = occurredAt || new Date().toISOString();
  try {
    // ilike with no wildcards is a case-insensitive exact match, which is how
    // referral_codes' unique index treats codes too.
    const { data: match, error: lookupError } = await supabaseAdmin
      .from('referral_codes')
      .select('id')
      .eq('active', true)
      .ilike('code', code)
      .maybeSingle();
    if (lookupError) {
      console.error('Referral code lookup failed:', lookupError.message);
      return;
    }

    // signed_up_at is deliberately absent: it defaults on insert and must keep
    // the original date when a later subscription event updates this row.
    const { error: upsertError } = await supabaseAdmin
      .from('referral_signups')
      .upsert({
        user_id: userId,
        code_id: match ? match.id : null,
        code_entered: code,
        email: email || null,
        subscription_status: status || null,
        // Cleared on reactivation, mirroring how canceled_at is handled on the
        // user's metadata above.
        canceled_at: status === 'canceled' ? stamp : null,
        updated_at: stamp,
      }, { onConflict: 'user_id' });
    if (upsertError) {
      console.error('Referral signup upsert failed:', upsertError.message);
      return;
    }

    // Written separately, and only where it's still empty, so the date a family
    // first started paying survives a later cancellation and re-subscription.
    if (status === 'active') {
      const { error: paidError } = await supabaseAdmin
        .from('referral_signups')
        .update({ first_paid_at: stamp })
        .eq('user_id', userId)
        .is('first_paid_at', null);
      if (paidError) console.error('Referral first_paid_at update failed:', paidError.message);
    }
  } catch (err) {
    console.error('Referral signup error:', err.message);
  }
}

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

// Meta calls this a "Dataset ID" as of their 2026 Graph API — it's the same
// numeric id as the client-side Pixel in js/meta-pixel.js. Recreated
// 2026-08-18 under the Sprout Kids App business portfolio after the original
// pixel turned out to be owned by an inaccessible account.
const META_PIXEL_ID = '1621574729405259';
const META_CAPI_VERSION = 'v25.0'; // Meta deprecates Graph API versions ~2 years after release — revisit periodically.

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

// Fire-and-forget, same reasoning as the Loops helpers above: Meta being down
// should never fail the webhook or trigger a Paddle retry. Requires
// META_CAPI_ACCESS_TOKEN to be set in Vercel — silently does nothing without it,
// so this is safe to call even before that's configured.
async function sendMetaCAPIEvent({ eventName, eventId, email, userId, value, currency, eventSourceUrl }) {
  if (!process.env.META_CAPI_ACCESS_TOKEN) return;
  const userData = {};
  if (email) userData.em = [sha256Hex(email.trim().toLowerCase())];
  if (userId) userData.external_id = [sha256Hex(userId)];
  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: 'website',
    event_source_url: eventSourceUrl || 'https://www.sproutearnsave.com/app/',
    user_data: userData,
  };
  if (value != null) event.custom_data = { value, currency: currency || 'ZAR' };
  try {
    const response = await fetch(`https://graph.facebook.com/${META_CAPI_VERSION}/${META_PIXEL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [event], access_token: process.env.META_CAPI_ACCESS_TOKEN }),
    });
    if (!response.ok) {
      console.error('Meta Conversions API event failed:', response.status, await response.text());
    }
  } catch (err) {
    console.error('Meta Conversions API event error:', err.message);
  }
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
      const accessEndsAt = formatDate(
        (sub.scheduled_change && sub.scheduled_change.action === 'cancel' && sub.scheduled_change.effective_at)
        || (sub.current_billing_period ? sub.current_billing_period.ends_at : null)
      );
      const billingInterval = billingIntervalLabel(sub.billing_cycle && sub.billing_cycle.interval);
      const nextBillingDate = formatDate(sub.next_billed_at);
      const nextChargeAmount = extractChargeAmount(sub);

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
        trialStartedAt: (previousStatus === null && newStatus === 'trialing') ? formatDate(event.occurred_at || new Date().toISOString()) : undefined,
        trialEndsAt: newStatus === 'trialing' ? accessEndsAt : undefined,
        billingInterval: billingInterval || undefined,
        nextChargeAmount: nextChargeAmount || undefined,
        currency: sub.currency_code || undefined,
        nextBillingDate: nextBillingDate || undefined,
        // True as soon as Paddle records a scheduled (end-of-period) cancellation,
        // not only once the subscription has actually finished canceling —
        // this is what the conversion-reminder Workflow's exit filter checks.
        cancelScheduled: newStatus === 'canceled' || Boolean(sub.scheduled_change && sub.scheduled_change.action === 'cancel'),
        accessEndsAt: newStatus === 'canceled' ? accessEndsAt : undefined,
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
