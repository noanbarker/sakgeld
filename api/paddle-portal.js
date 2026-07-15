const { createClient } = require('@supabase/supabase-js');

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
  if (userError || !userData?.user) {
    res.status(401).json({ error: 'Invalid session' });
    return;
  }

  const metadata = userData.user.user_metadata || {};
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
  res.status(200).json({ urls: paddleData.data.urls });
};
