const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');
const { sendPostHogEvent } = require('../lib/posthog');

// Sends a push notification to every device the signed-in parent has enabled
// notifications on (see the Notifications section of Settings in
// app/index.html, and sw.js which displays them).
//
// Called by the app the moment a kid marks a chore done or claims a reward.
// The caller only says what just happened; the pending counts come from the
// database so the notification always states the true number waiting, and
// because every message carries the same tag, a burst of completions collapses
// into one notification that updates in place rather than five separate ones.
//
// Needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT in Vercel. The
// public key is also hard-coded in app/index.html (it's public by design).

const APP_URL = '/app/index.html?mode=signin&open=approvals&utm_source=push&utm_medium=notification&utm_campaign=pending_approval';

function configured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function pluralise(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!configured()) {
    res.status(200).json({ sent: 0, reason: 'push not configured' });
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
  const userId = userData.user.id;

  const { kind, kidName, itemName } = req.body || {};

  const [{ data: subs }, { count: pendingChores }, { count: pendingRewards }] = await Promise.all([
    supabaseAdmin.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', userId),
    supabaseAdmin.from('completions').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('approved', false).eq('rejected', false).eq('missed', false),
    supabaseAdmin.from('reward_completions').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('approved', false).eq('rejected', false),
  ]);

  if (!subs || !subs.length) {
    res.status(200).json({ sent: 0 });
    return;
  }

  const total = (pendingChores || 0) + (pendingRewards || 0);
  const who = String(kidName || 'Someone').slice(0, 40);
  const what = String(itemName || '').slice(0, 60);
  const title = kind === 'reward'
    ? `${who} claimed a reward`
    : `${who} marked a chore done`;
  const waiting = total > 0 ? ` · ${pluralise(total, 'item')} waiting for your approval` : '';
  const body = `${what}${waiting}`;

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:hello@sproutearnsave.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );

  const payload = JSON.stringify({ title, body, count: total, url: APP_URL, tag: 'sprout-approvals' });
  let sent = 0;
  const dead = [];
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        // A day: an approval nudge that arrives a week late is noise. urgency
        // 'normal' lets phones deliver it promptly without draining battery.
        { TTL: 60 * 60 * 24, urgency: 'normal' },
      );
      sent += 1;
    } catch (err) {
      // 404/410 mean the browser threw the subscription away (notifications
      // turned off, app uninstalled). Forget it rather than retry forever.
      if (err && (err.statusCode === 404 || err.statusCode === 410)) dead.push(sub.id);
      else console.error('Push send failed:', err && (err.statusCode || err.message));
    }
  }));

  if (dead.length) {
    await supabaseAdmin.from('push_subscriptions').delete().in('id', dead);
  }

  // Fire-and-forget analytics: how often pushes go out, and to how many devices.
  sendPostHogEvent({
    distinctId: userId,
    event: 'push_notification_sent',
    properties: { kind: kind === 'reward' ? 'reward' : 'chore', devices: sent, pending_total: total, dead_subscriptions: dead.length },
  }).catch(() => {});

  res.status(200).json({ sent, removed: dead.length });
};
