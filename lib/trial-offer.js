const crypto = require('crypto');

// Personal trial-offer links, e.g. /app/?offer=<token>, emailed to South
// African families who signed up but never got past the card check. The token
// names one account and one trial length, and is signed with
// TRIAL_OFFER_SECRET so it can't be edited to claim a longer trial or to act
// on someone else's account. Made by tools/trial-offer/make-links.js, read
// back by api/paystack-checkout.js.
//
// Only these lengths can ever come out of a token, whatever is signed.
const OFFER_TRIAL_DAYS = [30];
const LINK_VALID_DAYS = 30;
// Noan's call (2026-10-19): a link used after it expires still gets its full
// trial. The expiry is kept in the token so this can be switched off later.
const HONOUR_EXPIRED_LINKS = true;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload, secret) {
  return b64url(crypto.createHmac('sha256', secret).update(payload, 'utf8').digest());
}

function makeOfferToken(userId, trialDays, secret, now = Date.now()) {
  if (!secret) throw new Error('TRIAL_OFFER_SECRET is not set');
  if (!OFFER_TRIAL_DAYS.includes(trialDays)) throw new Error(`Unsupported trial length: ${trialDays}`);
  const payload = b64url(JSON.stringify({
    u: userId,
    d: trialDays,
    e: Math.floor(now / 1000) + LINK_VALID_DAYS * 24 * 60 * 60,
  }));
  return `${payload}.${sign(payload, secret)}`;
}

// Returns { userId, trialDays, expired } for a genuine token, or null.
function readOfferToken(token, secret, now = Date.now()) {
  if (!secret || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload, secret), 'utf8');
  const given = Buffer.from(sig, 'utf8');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  let body;
  try {
    body = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (e) { return null; }
  if (!body || typeof body.u !== 'string' || !OFFER_TRIAL_DAYS.includes(body.d)) return null;
  const expired = typeof body.e !== 'number' || body.e * 1000 < now;
  if (expired && !HONOUR_EXPIRED_LINKS) return null;
  return { userId: body.u, trialDays: body.d, expired };
}

module.exports = { makeOfferToken, readOfferToken, OFFER_TRIAL_DAYS, LINK_VALID_DAYS };
