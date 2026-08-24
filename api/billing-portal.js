const { createClient } = require('@supabase/supabase-js');

// One "Manage Subscription" button, two payment rails behind it.
//
// Which gateway a family is billed by is decided once, at sign-up, by where
// they were in the world — South Africa goes to Paystack, everywhere else to
// Paddle — and it never changes afterwards, because a stored card cannot be
// moved between gateways. So the button in app/index.html stays provider-blind
// and asks this endpoint where to send them; the branch lives here, on the
// server, where the answer can be read from the account itself.
const PADDLE_API_BASE_URL = process.env.PADDLE_ENVIRONMENT === 'production'
  ? 'https://api.paddle.com'
  : 'https://sandbox-api.paddle.com';

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

  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
  if (userError || !userData || !userData.user) {
    res.status(401).json({ error: 'Invalid session' });
    return;
  }

  const metadata = userData.user.user_metadata || {};

  // Every family who signed up before the South African rail existed is on
  // Paddle and has no payment_provider tag, so the presence of a Paddle
  // customer id is treated as the same answer. That keeps existing subscribers
  // working without a backfill having to run first.
  const provider = metadata.payment_provider
    || (metadata.paddle_customer_id ? 'paddle' : null)
    || (metadata.paystack_subscription_code ? 'paystack' : null);

  if (provider === 'paystack') {
    const subscriptionCode = metadata.paystack_subscription_code;
    if (!subscriptionCode) {
      res.status(404).json({ error: 'No subscription found for this account' });
      return;
    }
    // Paystack hosts the page itself: the parent can swap the card on the
    // subscription or cancel it from there. Adding a card re-tokenises it with
    // a small charge that Paystack refunds immediately, same as our sign-up.
    const linkRes = await fetch(`https://api.paystack.co/subscription/${encodeURIComponent(subscriptionCode)}/manage/link`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    const linkBody = await linkRes.json().catch(() => null);
    if (!linkRes.ok || !linkBody || !linkBody.status || !linkBody.data || !linkBody.data.link) {
      console.error('Paystack manage link request failed:', linkRes.status, JSON.stringify(linkBody));
      res.status(502).json({ error: 'Could not reach Paystack' });
      return;
    }
    res.status(200).json({ provider: 'paystack', url: linkBody.data.link });
    return;
  }

  const customerId = metadata.paddle_customer_id;
  const subscriptionId = metadata.subscription_id;
  if (!customerId) {
    res.status(404).json({ error: 'No subscription found for this account' });
    return;
  }

  const paddleRes = await fetch(`${PADDLE_API_BASE_URL}/customers/${customerId}/portal-sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(subscriptionId ? { subscription_ids: [subscriptionId] } : {}),
  });

  if (!paddleRes.ok) {
    const errText = await paddleRes.text();
    console.error('Paddle portal session request failed:', paddleRes.status, errText);
    res.status(502).json({ error: 'Could not reach Paddle' });
    return;
  }

  const paddleData = await paddleRes.json();
  // urls is kept alongside the flat url so a browser still running the older
  // app bundle, which reads urls.general.overview, keeps working through a deploy.
  res.status(200).json({
    provider: 'paddle',
    url: paddleData.data.urls.general.overview,
    urls: paddleData.data.urls,
  });
};
