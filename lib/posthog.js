// Server-side PostHog events, sent from the billing webhooks.
//
// The moments that decide whether Sprout makes money — a trial converting to
// paid, a card failing, a cancellation — all happen on Paddle's or Paystack's
// servers days after the parent last had the app open, so no browser is there
// to record them. These are posted straight to PostHog's ingestion endpoint
// instead, under the same Supabase user id the app uses in posthog.identify(),
// so they land on the same person and the funnel from first pageview to paying
// customer is unbroken.
//
// The project token is the same public one js/posthog.js ships to every
// browser: PostHog's capture endpoint is write-only and deliberately takes the
// public key, so nothing secret is needed here. POSTHOG_API_KEY in the
// environment overrides it if the project is ever moved.
//
// Fire-and-forget like everything in lib/billing-notifications.js: a PostHog
// outage must never fail a webhook, because the subscription state has already
// been written by the time this runs and a non-200 would make the gateway
// redeliver the event and resend customer emails.

const API_KEY = process.env.POSTHOG_API_KEY || 'phc_BgfbTW3WJRP9PJN8FYqVU5aS2BrhhkAnnMvjouXKzqxQ';
const API_HOST = process.env.POSTHOG_HOST || 'https://eu.i.posthog.com';

// Paddle reports 'month'/'year'; Paystack 'monthly'/'annually'; the app stores
// 'monthly'/'yearly'. Dashboards want one vocabulary.
function normaliseInterval(value) {
  if (!value) return undefined;
  const v = String(value).toLowerCase();
  if (v === 'year' || v === 'yearly' || v === 'annual' || v === 'annually') return 'yearly';
  if (v === 'month' || v === 'monthly') return 'monthly';
  return v;
}

function lifecycleStage(status) {
  if (status === 'trialing') return 'trial';
  if (status === 'active') return 'paid';
  if (status === 'past_due') return 'payment_issue';
  if (status === 'canceled') return 'cancelled';
  if (status === 'paused') return 'paused';
  return undefined;
}

// The attribution a parent arrived with, as stored on the Supabase user at
// sign-up (see doSignUp in app/index.html). Copied onto every server-side event
// so a "trials by school" or "paid customers by campaign" breakdown works from
// the event alone, and onto the person ($set_once) so it's there for cohorts.
function attributionFrom(userMetadata) {
  const m = userMetadata || {};
  const out = {};
  ['referral_code', 'signup_geo', 'country', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']
    .forEach((k) => { if (m[k]) out[k] = m[k]; });
  return out;
}

function dropUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

/**
 * Sends one event for a user.
 *
 * @param {object} args
 * @param {string} args.distinctId     Supabase user id.
 * @param {string} args.event          e.g. 'subscription_activated'.
 * @param {object} [args.properties]   Event properties.
 * @param {object} [args.set]          Person properties to overwrite ($set).
 * @param {object} [args.setOnce]      Person properties to write only if absent ($set_once).
 * @param {string} [args.timestamp]    ISO time the thing actually happened (defaults to now).
 */
async function sendPostHogEvent({ distinctId, event, properties, set, setOnce, timestamp }) {
  if (!distinctId || !event || !API_KEY) return;
  const body = {
    api_key: API_KEY,
    event,
    distinct_id: distinctId,
    timestamp: timestamp || new Date().toISOString(),
    properties: {
      ...dropUndefined(properties || {}),
      // Marks these as server-originated so a dashboard can tell them apart
      // from the browser's own events, and so PostHog doesn't try to attach
      // browser-only context to them.
      $lib: 'sprout-server',
      source: 'webhook',
      ...(set && Object.keys(set).length ? { $set: dropUndefined(set) } : {}),
      ...(setOnce && Object.keys(setOnce).length ? { $set_once: dropUndefined(setOnce) } : {}),
    },
  };
  try {
    const response = await fetch(`${API_HOST}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error('PostHog capture failed:', event, response.status, await response.text());
    }
  } catch (err) {
    console.error('PostHog capture error:', event, err.message);
  }
}

/**
 * The one call both webhooks make. Works out which lifecycle event a status
 * change represents and sends it with the person kept up to date.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {object} args.userMetadata         The user's metadata *before* this change (for attribution and signup date).
 * @param {string|null} args.previousStatus  Sprout status before: null | trialing | active | past_due | paused | canceled
 * @param {string|null} args.newStatus       Sprout status after.
 * @param {'paddle'|'paystack'} args.provider
 * @param {string} [args.email]
 * @param {string} [args.billingInterval]    Any of the gateways' words for monthly/yearly.
 * @param {string} [args.currency]
 * @param {number} [args.amount]             Major units (R59.00 → 59), when a charge is involved.
 * @param {boolean} [args.cancelScheduled]   Whether an end-of-period cancellation is now pending.
 * @param {boolean} [args.cancelWasScheduled] …and whether it already was before this event.
 * @param {string} [args.occurredAt]         ISO time from the gateway.
 * @param {string} [args.extraEvent]         A specific event the caller already knows about
 *                                           (e.g. 'subscription_renewed') to send in addition.
 */
async function trackSubscriptionChange({
  userId, userMetadata, previousStatus, newStatus, provider, email,
  billingInterval, currency, amount, cancelScheduled, cancelWasScheduled, occurredAt, extraEvent,
}) {
  if (!userId) return;
  const prev = previousStatus || null;
  const next = newStatus || null;
  const attribution = attributionFrom(userMetadata);
  const interval = normaliseInterval(billingInterval) || normaliseInterval((userMetadata || {}).billing_cycle);

  const events = [];
  if (extraEvent) events.push(extraEvent);
  if (next && next !== prev) {
    if (prev === null && next === 'trialing') events.push('trial_started');
    else if (prev === 'trialing' && next === 'active') events.push('subscription_activated');
    else if (prev === 'trialing' && next === 'canceled') events.push('trial_cancelled');
    else if (prev === 'past_due' && next === 'active') events.push('payment_recovered');
    else if (prev === 'canceled' && (next === 'active' || next === 'trialing')) events.push('subscription_reactivated');
    else if (next === 'past_due') events.push('payment_failed');
    else if (next === 'canceled') events.push('subscription_cancelled');
    else if (next === 'paused') events.push('subscription_paused');
    else if (prev === 'paused' && next === 'active') events.push('subscription_resumed');
    else if (prev === null && next === 'active') events.push('subscription_activated');
  }
  // A cancellation that has actually taken effect is reported above; this is
  // only the earlier "will end at the end of the period" moment.
  if (cancelScheduled && !cancelWasScheduled && next !== 'canceled') events.push('subscription_cancellation_scheduled');
  if (!cancelScheduled && cancelWasScheduled && next !== 'canceled') events.push('subscription_cancellation_reverted');
  if (!events.length) return;

  const properties = {
    provider,
    previous_status: prev,
    status: next,
    billing_interval: interval,
    currency,
    amount,
    ...attribution,
  };
  const set = {
    email,
    subscription_status: next,
    lifecycle_stage: lifecycleStage(next),
    billing_interval: interval,
    payment_provider: provider,
    cancel_scheduled: Boolean(cancelScheduled),
    currency,
    ...attribution,
  };
  const setOnce = {
    ...attribution,
    trial_started_at: events.includes('trial_started') ? (occurredAt || new Date().toISOString()) : undefined,
    first_paid_at: events.includes('subscription_activated') ? (occurredAt || new Date().toISOString()) : undefined,
  };

  for (const event of events) {
    // Sequential, not parallel: each carries the same $set, and two writes
    // racing can leave the person with the older one.
    await sendPostHogEvent({ distinctId: userId, event, properties, set, setOnce, timestamp: occurredAt });
  }
}

module.exports = { sendPostHogEvent, trackSubscriptionChange, normaliseInterval };
