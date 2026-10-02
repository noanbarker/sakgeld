// Behind the form on contact.html. Saves the message to contact_messages (as
// the admin dashboard expects) and then emails it to us, so a parent writing
// in doesn't sit unseen until someone happens to open /admin.
//
// The email is a Loops transactional, "INT-01 Contact form message (internal
// alert)". It goes to CONTACT_ALERT_EMAIL if that's set in Vercel, otherwise
// to hello@sproutearnsave.com. Loops' API can't put a per-message reply-to on
// a transactional, so the email carries a "Reply to <name>" mailto link instead.
//
// Saving is what counts: if Loops is down the visitor still gets the success
// screen, because the message is safe in Supabase and shows on /admin.

const { createClient } = require('@supabase/supabase-js');

const CONTACT_ALERT_TRANSACTIONAL_ID = 'cmur4x57e0bc00j10g2rvvqh4';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = req.body || {};
  const name = clean(body.name, 200);
  const email = clean(body.email, 320);
  const topic = clean(body.topic, 100);
  const message = clean(body.message, 5000);

  if (!name || !EMAIL_RE.test(email) || !topic || !message) {
    res.status(400).json({ error: 'Missing or invalid fields' });
    return;
  }

  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Only used to tell us whether the sender has a Sprout account. A missing
  // or expired token is fine; the message is accepted either way.
  let signedIn = 'No';
  const authHeader = req.headers['authorization'] || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (accessToken) {
    const { data } = await supabaseAdmin.auth.getUser(accessToken);
    if (data && data.user) signedIn = `Yes (${data.user.email})`;
  }

  const { data: row, error: insertError } = await supabaseAdmin
    .from('contact_messages')
    .insert({ name, email, topic, message })
    .select('id')
    .single();

  if (insertError) {
    console.error('contact-message: insert failed', insertError);
    res.status(500).json({ error: 'Could not save message' });
    return;
  }

  if (!process.env.LOOPS_API_KEY) {
    console.error('contact-message: LOOPS_API_KEY not set, alert email skipped');
  } else {
    try {
      const loopsRes = await fetch('https://app.loops.so/api/v1/transactional', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.LOOPS_API_KEY}`,
          'Idempotency-Key': `contact-${row.id}`,
        },
        body: JSON.stringify({
          transactionalId: CONTACT_ALERT_TRANSACTIONAL_ID,
          email: process.env.CONTACT_ALERT_EMAIL || 'hello@sproutearnsave.com',
          addToAudience: false,
          dataVariables: { name, email, topic, message, signedIn },
        }),
      });
      if (!loopsRes.ok) {
        console.error('contact-message: Loops alert failed', loopsRes.status, await loopsRes.text());
      }
    } catch (err) {
      console.error('contact-message: Loops alert failed', err);
    }
  }

  res.status(200).json({ ok: true });
};
