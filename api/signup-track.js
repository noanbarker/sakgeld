const { createClient } = require('@supabase/supabase-js');
const { syncLoopsContact, sendLoopsEvent, billingIntervalLabel } = require('../lib/billing-notifications');

// Tells Loops a parent exists the moment their account is created.
//
// Until this, a contact only reached Loops once Paystack or Paddle confirmed a
// trial. Anyone who made an account and then left at the card page was
// invisible: no contact, no email, nothing but a row in the admin dashboard.
// In the first weeks of paid ads that was four sign-ups in five.
//
// The `account_created` event starts the signup_rescue workflow in Loops, which
// waits a day and only emails people whose lifecycleStage is still 'signed_up'.
// Both billing webhooks move that to 'trial' when a trial starts, so a parent
// who finishes checkout never gets the reminder.
//
// The caller has no session (a new account can't sign in until its email is
// confirmed), so this endpoint trusts nothing from the browser except the user
// id, and looks everything else up itself. The checks below keep it from being
// useful to anyone else: the account must be real, brand new, and not yet
// subscribed, and the email address always comes from Supabase, never the
// request. The Loops workflow is one-time-per-contact, so replaying a call
// cannot send anyone a second email.
const MAX_ACCOUNT_AGE_MS = 30 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const userId = req.body && req.body.userId;
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    res.status(400).json({ error: 'Invalid user id' });
    return;
  }
  if (!process.env.LOOPS_API_KEY) {
    res.status(200).json({ tracked: false });
    return;
  }

  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  // Same answer whether the id is unknown, old, or already subscribed, so the
  // endpoint can't be used to probe which accounts exist.
  const user = !error && data ? data.user : null;
  const meta = (user && user.user_metadata) || {};
  const isFresh = user && Date.now() - new Date(user.created_at).getTime() < MAX_ACCOUNT_AGE_MS;
  if (!user || !user.email || !isFresh || meta.subscription_status) {
    res.status(200).json({ tracked: false });
    return;
  }

  const firstName = ((meta.name || '').trim().split(/\s+/)[0]) || '';
  await syncLoopsContact(user.email, {
    ...(firstName ? { firstName } : {}),
    lifecycleStage: 'signed_up',
    billingInterval: billingIntervalLabel(meta.billing_cycle),
    // Picks the email version in Loops: South Africans are told about Paystack's
    // R1 card check, everyone else isn't, because Paddle never shows one. The
    // Paddle webhook overwrites this with the real billing currency later.
    currency: meta.signup_geo === 'ZA' ? 'ZAR' : 'USD',
  });
  await sendLoopsEvent(user.email, 'account_created', firstName ? { firstName } : {});
  res.status(200).json({ tracked: true });
};
