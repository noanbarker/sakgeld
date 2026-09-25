const crypto = require('crypto');
const { sendMetaCAPIEvent } = require('./billing-notifications');

// Meta StartTrial: one conversion, reported twice (browser Pixel + server
// Conversions API) under one event_id so Meta counts it once.
//
// Each trial attempt is a row in public.meta_trial_attribution (server-only,
// see its migration). The browser gets that row's event_id from
// api/meta-attribution.js when checkout opens, and only fires its Pixel copy
// once that endpoint's status check says the webhook below has confirmed it.

const TABLE = 'meta_trial_attribution';
const UNIQUE_VIOLATION = '23505';

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

// Shapes Meta documents for these values. Anything else is dropped rather than
// forwarded, so a tampered browser can't push junk into our Meta dataset.
const FBP = /^fb\.[0-9]\.[0-9]{10,13}\.[0-9]{1,30}$/;
const FBC = /^fb\.[0-9]\.[0-9]{10,13}\.[A-Za-z0-9_-]{1,500}$/;
const TEST_EVENT_CODE = /^TEST[A-Za-z0-9]{1,20}$/;
// Only the random ids from the table, never the fallback ones below.
const EVENT_ID = /^st_[0-9a-f]{32}$/;

function validFbp(v) { return typeof v === 'string' && FBP.test(v) ? v : null; }
function validFbc(v) { return typeof v === 'string' && FBC.test(v) ? v : null; }
function validTestEventCode(v) { return typeof v === 'string' && TEST_EVENT_CODE.test(v) ? v : null; }
function validEventId(v) { return typeof v === 'string' && EVENT_ID.test(v) ? v : null; }

// The visitor's own address, not Vercel's. Vercel sits directly in front of
// the site (no Cloudflare) and overwrites both headers itself, so a browser
// can't spoof them.
function clientIpFrom(req) {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return null;
}

async function findOpenAttempt(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin.from(TABLE).select('*')
    .eq('user_id', userId).is('trial_confirmed_at', null).maybeSingle();
  if (error) throw new Error(`open attempt read failed: ${error.message}`);
  return data;
}

// The parent's current attempt, created if there isn't one. Reopening checkout
// reuses it, so its event_id holds steady until a trial is confirmed.
async function openAttempt(supabaseAdmin, userId) {
  const existing = await findOpenAttempt(supabaseAdmin, userId);
  if (existing) return existing;
  const { data, error } = await supabaseAdmin.from(TABLE).insert({ user_id: userId }).select('*').single();
  if (!error) return data;
  // Another request created it a moment ago.
  if (error.code === UNIQUE_VIOLATION) return findOpenAttempt(supabaseAdmin, userId);
  throw new Error(`attempt insert failed: ${error.message}`);
}

// Closes the open attempt as this trial (trialRef = the provider's own id for
// it). A retried webhook for the same trial finds the row it closed last time.
async function confirmAttempt(supabaseAdmin, userId, trialRef) {
  const { data: already, error: readError } = await supabaseAdmin.from(TABLE).select('*')
    .eq('trial_ref', trialRef).maybeSingle();
  if (readError) throw new Error(`trial_ref read failed: ${readError.message}`);
  if (already) return { row: already, retry: true };

  const now = new Date().toISOString();
  const open = await findOpenAttempt(supabaseAdmin, userId);
  if (open) {
    const { data, error } = await supabaseAdmin.from(TABLE)
      .update({ trial_confirmed_at: now, trial_ref: trialRef })
      .eq('event_id', open.event_id).is('trial_confirmed_at', null)
      .select('*').maybeSingle();
    if (error && error.code !== UNIQUE_VIOLATION) throw new Error(`confirm failed: ${error.message}`);
    if (data) return { row: data, retry: false };
  } else {
    // No checkout was registered (e.g. it opened before this was deployed).
    const { data, error } = await supabaseAdmin.from(TABLE)
      .insert({ user_id: userId, trial_ref: trialRef, trial_confirmed_at: now })
      .select('*').single();
    if (!error) return { row: data, retry: false };
    if (error.code !== UNIQUE_VIOLATION) throw new Error(`confirm insert failed: ${error.message}`);
  }
  // Lost a race with a concurrent delivery of the same webhook.
  const { data: winner, error: winnerError } = await supabaseAdmin.from(TABLE).select('*')
    .eq('trial_ref', trialRef).maybeSingle();
  if (winnerError || !winner) throw new Error('confirm race could not be resolved');
  return { row: winner, retry: true };
}

// Called by both billing webhooks at the one point a genuine first trial exists
// (the same place trial_started goes to Loops and PostHog).
async function sendStartTrialConversion(supabaseAdmin, { userId, email, trialRef }) {
  let row = null;
  let retry = false;
  try {
    ({ row, retry } = await confirmAttempt(supabaseAdmin, userId, String(trialRef || `user:${userId}`)));
  } catch (err) {
    console.error('meta_trial_attribution unavailable, sending StartTrial without a browser pair:', err.message);
  }
  // Already sent for this trial on an earlier delivery.
  if (retry && row.capi_sent_at) return;

  // If the table can't be reached, the server copy still goes out: an event
  // without a browser twin beats a lost conversion. The fallback id is a one-way
  // hash of this specific trial, so it's stable across retries, never shared
  // with another trial, and can't be confused with the random st_<32 hex> ids.
  const eventId = row ? row.event_id : `st_fallback_${sha256Hex(`meta-start-trial:${userId}:${trialRef || ''}`).slice(0, 32)}`;
  const keys = row || {};

  const result = await sendMetaCAPIEvent({
    eventName: 'StartTrial',
    eventId,
    email,
    userId,
    fbp: keys.fbp,
    fbc: keys.fbc,
    clientIp: keys.client_ip,
    clientUserAgent: keys.client_user_agent,
    testEventCode: keys.test_event_code,
  });

  // Yes/no only: no email, no address, no raw cookie values in the logs.
  const has = (v) => (v ? 'yes' : 'no');
  console.log(`[meta-capi] StartTrial event_id=${eventId} status=${result.status} sent=${has(result.sent)} `
    + `em=${has(email)} external_id=${has(userId)} fbp=${has(keys.fbp)} fbc=${has(keys.fbc)} `
    + `ip=${has(keys.client_ip)} ua=${has(keys.client_user_agent)} test=${has(keys.test_event_code)}`);

  if (!row) return;
  // The match keys have done their one job. Wiped whether or not Meta accepted
  // the event: nothing retries it, so keeping them would serve no purpose.
  const { error: clearError } = await supabaseAdmin.from(TABLE).update({
    fbp: null, fbc: null, client_ip: null, client_user_agent: null, test_event_code: null,
    ...(result.sent ? { capi_sent_at: new Date().toISOString() } : {}),
  }).eq('event_id', row.event_id);
  if (clearError) console.error('meta_trial_attribution clear failed:', clearError.message);
}

module.exports = {
  TABLE,
  validFbp,
  validFbc,
  validTestEventCode,
  validEventId,
  clientIpFrom,
  openAttempt,
  sendStartTrialConversion,
};
