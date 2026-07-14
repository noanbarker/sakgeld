const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Generous replay-protection window: Paddle's own examples use 5 seconds, but
// that's tight enough to reject legitimate deliveries under normal network/
// cold-start latency. 5 minutes still blocks stale replayed requests.
const SIGNATURE_MAX_AGE_SECONDS = 300;

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
      const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        user_metadata: {
          subscription_status: sub.status || null,
          subscription_id: sub.id || null,
          current_period_ends_at: sub.current_billing_period ? sub.current_billing_period.ends_at : null,
          next_billed_at: sub.next_billed_at || null,
        },
      });
      if (error) {
        console.error('Failed to update Supabase user from Paddle webhook:', error.message);
        res.status(500).json({ error: 'Failed to update user' });
        return;
      }
    }
  }

  res.status(200).json({ received: true });
};
