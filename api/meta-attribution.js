const { createClient } = require('@supabase/supabase-js');
const {
  TABLE, validFbp, validFbc, validTestEventCode, validEventId, clientIpFrom, openAttempt,
} = require('../lib/meta-attribution');

// One endpoint, two jobs, so the site stays within Vercel's function limit:
//   { action: 'status', eventId }  -> trialStatus() below
//   anything else                  -> registering a checkout (the handler)

// Called by the app the moment checkout opens (openTrialCheckout in
// app/index.html). Hands back the event_id the browser will use for its Pixel
// StartTrial, and — for a visitor who accepted cookies only — records the
// browser's Meta match keys so the webhook can send them with the server copy.
//
// Who the caller is:
//   - A signed-in parent finishing checkout from the subscription screen sends
//     their session token, and the account comes from that alone.
//   - A brand-new sign-up has no session yet (the account can't sign in until
//     its email is confirmed), so it sends the id Supabase just returned from
//     signUp. That's accepted only for an account under a day old that has
//     never had a subscription, the same trust api/paystack-checkout.js and
//     api/signup-track.js already extend to that moment.
const MAX_ANON_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_USER_AGENT_LENGTH = 512;

// Answers one question for the browser: has the webhook confirmed this trial
// yet? The app polls it after checkout and fires the Pixel StartTrial only on
// a yes, so the browser event marks the same moment as the server one.
//
// Never takes a user id. The caller names the trial by the event_id this
// endpoint gave that same browser when its checkout opened: a random 122-bit
// value only that browser (and later Meta) ever sees. It works as a key to this
// one yes/no answer and nothing else, and only for 48 hours after checkout last
// opened. A signed-in caller is also checked against the session: the trial
// must be their own. (A brand-new sign-up has no session to offer. The account
// can't sign in until its email is confirmed, often days after the trial starts.)
//
// The response is { confirmed: true|false } and nothing more. An unknown,
// expired or someone-else's id gets the same "false" as a pending one.
const STATUS_TOKEN_LIFETIME_MS = 48 * 60 * 60 * 1000;

async function trialStatus(req, res, body, supabaseAdmin) {
  res.setHeader('Cache-Control', 'no-store');
  const eventId = validEventId(body.eventId);
  if (!eventId) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  let sessionUserId = null;
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const { data, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
    if (error || !data || !data.user) {
      res.status(401).json({ error: 'Invalid session' });
      return;
    }
    sessionUserId = data.user.id;
  }

  const { data: row, error } = await supabaseAdmin.from(TABLE)
    .select('user_id, issued_at, trial_confirmed_at').eq('event_id', eventId).maybeSingle();
  if (error) {
    console.error('trial status lookup failed:', error.message);
    res.status(500).json({ error: 'Lookup failed' });
    return;
  }
  const live = row && Date.now() - new Date(row.issued_at).getTime() < STATUS_TOKEN_LIFETIME_MS;
  const owned = row && (!sessionUserId || row.user_id === sessionUserId);
  res.status(200).json({ confirmed: Boolean(live && owned && row.trial_confirmed_at) });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (body.action === 'status') {
    await trialStatus(req, res, body, supabaseAdmin);
    return;
  }

  let user = null;
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const { data, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
    user = !error && data ? data.user : null;
  } else if (typeof body.userId === 'string' && UUID.test(body.userId)) {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(body.userId);
    const candidate = !error && data ? data.user : null;
    const meta = (candidate && candidate.user_metadata) || {};
    const isFresh = candidate && Date.now() - new Date(candidate.created_at).getTime() < MAX_ANON_ACCOUNT_AGE_MS;
    if (isFresh && !meta.subscription_status) user = candidate;
  }
  // Same answer for an unknown, old or already-subscribed id, so this can't be
  // used to probe which accounts exist.
  if (!user) {
    res.status(200).json({ eventId: null });
    return;
  }

  let row;
  try {
    row = await openAttempt(supabaseAdmin, user.id);
  } catch (err) {
    console.error('meta-attribution:', err.message);
    res.status(200).json({ eventId: null });
    return;
  }

  // issued_at restarts the 48-hour window in which the status check above will
  // answer for this id. Match keys are refreshed only with consent.
  const update = { issued_at: new Date().toISOString() };
  if (body.consent === 'accepted') {
    const userAgent = typeof req.headers['user-agent'] === 'string'
      ? req.headers['user-agent'].slice(0, MAX_USER_AGENT_LENGTH) : null;
    Object.assign(update, {
      fbp: validFbp(body.fbp),
      fbc: validFbc(body.fbc),
      client_ip: clientIpFrom(req),
      client_user_agent: userAgent,
      test_event_code: validTestEventCode(body.testEventCode),
      captured_at: new Date().toISOString(),
    });
  }
  // Scoped to the still-open attempt: once a trial is confirmed its keys have
  // been sent and wiped, and must stay wiped.
  const { error } = await supabaseAdmin.from(TABLE).update(update)
    .eq('event_id', row.event_id).is('trial_confirmed_at', null);
  if (error) console.error('meta_trial_attribution update failed:', error.message);

  res.status(200).json({ eventId: row.event_id });
};
