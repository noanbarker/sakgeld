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

      // Only fire on an actual status transition, so a duplicate Paddle
      // delivery (they don't guarantee exactly-once) doesn't resend the email.
      const previousStatus = existing.user.user_metadata.subscription_status || null;
      const newStatus = sub.status || null;
      if (newStatus && newStatus !== previousStatus) {
        const email = existing.user.email;
        const firstName = ((existing.user.user_metadata.name || '').split(' ')[0]) || 'there';
        const accessEndsAt = formatDate(sub.current_billing_period ? sub.current_billing_period.ends_at : null);

        if (previousStatus === 'trialing' && newStatus === 'canceled') {
          await sendLoopsEmail(LOOPS_TEMPLATE.trialCancelled, email, { firstName, accessEndsAt });
        } else if (previousStatus === 'trialing' && newStatus === 'active') {
          const billingInterval = billingIntervalLabel(sub.billing_cycle && sub.billing_cycle.interval);
          const nextBillingDate = formatDate(sub.next_billed_at);
          await sendLoopsEmail(LOOPS_TEMPLATE.subscriptionActivated, email, { firstName, billingInterval, nextBillingDate });
        } else if (previousStatus && previousStatus !== 'trialing' && newStatus === 'canceled') {
          await sendLoopsEmail(LOOPS_TEMPLATE.subscriptionCancelled, email, { firstName, accessEndsAt });
        }
      }
    }
  }

  res.status(200).json({ received: true });
};
