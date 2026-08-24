const crypto = require('crypto');

// Everything in here is shared by both payment rails: api/paddle-webhook.js
// (rest of world) and api/paystack-webhook.js (South Africa). A family's
// lifecycle emails, ad attribution and referral credit must not depend on
// which gateway happened to bill them, so this logic lives in one place rather
// than being copied into each webhook and quietly drifting apart.
//
// Every helper here is deliberately fire-and-forget: they log failures and
// return rather than throwing. A Loops or Meta outage must never fail a
// webhook, because the subscription state in Supabase has already been written
// by that point and a non-200 would make the gateway redeliver the event —
// resending live customer emails.

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

// Paddle reports 'month'/'year'; Paystack reports 'monthly'/'annually'. Both
// land on the same words in the customer's email.
function billingIntervalLabel(interval) {
  if (interval === 'year' || interval === 'annually') return 'annual';
  if (interval === 'month' || interval === 'monthly') return 'monthly';
  return interval || '';
}

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
// The code arrives from the browser (user_metadata, or the gateway's custom
// data), so it is untrusted text: normalising to letters and digits here is
// what stops a crafted value reaching the query below. An unrecognised code is
// still stored rather than dropped — a near-miss typo is recoverable by hand,
// a discarded one isn't.
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

// Meta calls this a "Dataset ID" as of their 2026 Graph API — it's the same
// numeric id as the client-side Pixel in js/meta-pixel.js. Recreated
// 2026-08-18 under the Sprout Kids App business portfolio after the original
// pixel turned out to be owned by an inaccessible account.
const META_PIXEL_ID = '1621574729405259';
const META_CAPI_VERSION = 'v25.0'; // Meta deprecates Graph API versions ~2 years after release — revisit periodically.

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

// Requires META_CAPI_ACCESS_TOKEN to be set in Vercel — silently does nothing
// without it, so this is safe to call even before that's configured.
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

module.exports = {
  LOOPS_TEMPLATE,
  formatDate,
  billingIntervalLabel,
  sendLoopsEmail,
  syncLoopsContact,
  sendLoopsEvent,
  recordReferralSignup,
  sendMetaCAPIEvent,
};
