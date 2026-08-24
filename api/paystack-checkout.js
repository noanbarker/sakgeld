const { createClient } = require('@supabase/supabase-js');

// South African checkout. Everyone outside South Africa still goes to Paddle
// (see openTrialCheckout in app/index.html) — this endpoint exists because
// Paddle is a Merchant of Record and charges SA VAT on our behalf, which we
// aren't yet required to charge ourselves.
//
// Paystack has no native free trial. The documented way to run one is to
// tokenise the card with a small charge now and start the subscription later,
// so this endpoint only opens that card-setup charge; api/paystack-webhook.js
// refunds it and creates the real subscription the moment it succeeds.
//
// (Paystack's Preauthorization API would be tidier — an SA-only, ZAR-only hold
// that releases itself instead of a charge that needs refunding — but the
// integration isn't eligible for it. Worth revisiting with Paystack support.)
const CARD_SETUP_AMOUNT_KOBO = 100; // R1.00, refunded the instant it lands.

const PLAN_CODES = {
  monthly: process.env.PAYSTACK_PLAN_MONTHLY_ZA,
  yearly: process.env.PAYSTACK_PLAN_YEARLY_ZA,
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!process.env.PAYSTACK_SECRET_KEY) {
    console.error('PAYSTACK_SECRET_KEY is not configured');
    res.status(500).json({ error: 'Payments are not configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const userId = body && body.userId;
  const billingCycle = body && body.billingCycle === 'yearly' ? 'yearly' : 'monthly';
  if (!userId) {
    res.status(400).json({ error: 'Missing userId' });
    return;
  }

  // Checked for shape, not just presence. A plan code that is missing *or*
  // malformed fails identically from here on: Paystack accepts the card-setup
  // charge regardless, and only rejects the subscription afterwards — leaving
  // a parent charged, refunded, and with no trial, which is precisely the
  // outcome this endpoint exists to avoid. Every Paystack plan code is
  // PLN_ followed by alphanumerics, so a wrong value is caught here, before
  // any card is touched.
  const planCode = PLAN_CODES[billingCycle];
  if (!/^PLN_[A-Za-z0-9]+$/.test(String(planCode || ''))) {
    console.error(
      `Paystack plan code for "${billingCycle}" is missing or malformed — check the `
      + `${billingCycle === 'yearly' ? 'PAYSTACK_PLAN_YEARLY_ZA' : 'PAYSTACK_PLAN_MONTHLY_ZA'} `
      + `environment variable. Expected PLN_..., got: ${JSON.stringify(planCode)}`
    );
    res.status(500).json({ error: 'Payments are not configured' });
    return;
  }

  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // The email is read from Supabase rather than taken from the request. The
  // caller is an anonymous browser (the account exists but the parent hasn't
  // confirmed their address yet, so there's no session to authenticate with),
  // and an attacker-supplied email would otherwise decide who the card-setup
  // charge — and every later subscription charge — is billed to.
  const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (userError || !userData || !userData.user) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }
  const user = userData.user;
  const metadata = user.user_metadata || {};

  // Re-opening checkout for someone who already has a live subscription would
  // tokenise a second card and start a second subscription billing the same
  // family twice. The dashboard's "Continue to Checkout" button is reachable
  // whenever this metadata is missing, so the guard belongs here too.
  if (metadata.subscription_status === 'trialing' || metadata.subscription_status === 'active') {
    res.status(409).json({ error: 'This account already has an active subscription' });
    return;
  }

  const initRes = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: user.email,
      amount: CARD_SETUP_AMOUNT_KOBO,
      currency: 'ZAR',
      // Card only: the subscription rail can only charge a stored card
      // authorisation, so paying this R1 by EFT would leave us with nothing to
      // bill in 14 days' time.
      channels: ['card'],
      callback_url: `${process.env.SITE_URL || 'https://www.sproutearnsave.com'}/app/?checkout=paystack`,
      // Read back by the webhook. Nothing here is trusted as an instruction —
      // sprout_purpose only tells the webhook which of its two kinds of
      // charge.success this is (card setup vs. a later subscription renewal).
      metadata: {
        sprout_purpose: 'card_setup',
        supabase_user_id: userId,
        billing_cycle: billingCycle,
        plan_code: planCode,
        referral_code: metadata.referral_code || '',
      },
    }),
  });

  const initBody = await initRes.json().catch(() => null);
  if (!initRes.ok || !initBody || !initBody.status || !initBody.data) {
    console.error('Paystack transaction initialize failed:', initRes.status, JSON.stringify(initBody));
    res.status(502).json({ error: 'Could not start checkout' });
    return;
  }

  res.status(200).json({
    authorization_url: initBody.data.authorization_url,
    access_code: initBody.data.access_code,
    reference: initBody.data.reference,
  });
};
