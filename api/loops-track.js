const { createClient } = require('@supabase/supabase-js');

// Only these fire a Loops "event" (used as Workflow triggers). Everything else
// just syncs contact properties silently, so we don't spam a contact's Loops
// timeline with routine writes (e.g. adding a 2nd, 3rd, 4th chore).
const ALLOWED_EVENTS = new Set([
  'child_added',
  'first_chore_created',
  'first_chore_completed',
  'first_chore_approved',
  'savings_goal_created',
]);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const authHeader = req.headers['authorization'] || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!accessToken) {
    res.status(401).json({ error: 'Missing access token' });
    return;
  }

  const { event, properties } = req.body || {};
  if (event && !ALLOWED_EVENTS.has(event)) {
    res.status(400).json({ error: 'Unknown event' });
    return;
  }

  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    res.status(401).json({ error: 'Invalid session' });
    return;
  }

  if (!process.env.LOOPS_API_KEY) {
    res.status(200).json({ sent: false });
    return;
  }

  // Fire-and-forget from the caller's perspective: this is marketing-data
  // plumbing, not something a parent should ever see fail in the app.
  try {
    const email = userData.user.email;
    const url = event
      ? 'https://app.loops.so/api/v1/events/send'
      : 'https://app.loops.so/api/v1/contacts/update';
    // See lib/billing-notifications.js sendLoopsEvent for why contact
    // properties must be spread flat rather than nested under a
    // `contactProperties` key.
    const body = event
      ? { email, eventName: event, eventProperties: properties || {}, ...(properties || {}) }
      : { email, ...(properties || {}) };

    const loopsRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.LOOPS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!loopsRes.ok) {
      console.error('Loops track request failed:', loopsRes.status, await loopsRes.text());
    }
  } catch (err) {
    console.error('Loops track request error:', err.message);
  }

  res.status(200).json({ sent: true });
};
