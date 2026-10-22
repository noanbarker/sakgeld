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
// Second job, the daily reminder: Supabase (pg_cron, see
// supabase/migrations/20261022120000_add_push_daily_reminder.sql) calls
// GET /api/push-send?job=reminders every 15 minutes with REMINDER_CRON_SECRET
// (its own secret, so the Vercel crons' CRON_SECRET never has to change). It
// sends one "still waiting for you" nudge per day to each device whose parent
// turned the reminder on, once their chosen local time has passed. It lives in
// this file rather than its own because api/ is at Vercel's function limit.
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

function setVapid() {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:hello@sproutearnsave.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

// Sends one payload to a list of subscription rows. Returns how many went out
// and the ids of rows the push service says are gone (404/410: notifications
// turned off, app uninstalled), which the caller deletes rather than retry forever.
async function pushToAll(subs, payload) {
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
      if (err && (err.statusCode === 404 || err.statusCode === 410)) dead.push(sub.id);
      else console.error('Push send failed:', err && (err.statusCode || err.message));
    }
  }));
  return { sent, dead };
}

async function countPending(supabaseAdmin, userId) {
  const [{ count: pendingChores }, { count: pendingRewards }] = await Promise.all([
    supabaseAdmin.from('completions').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('approved', false).eq('rejected', false).eq('missed', false),
    supabaseAdmin.from('reward_completions').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('approved', false).eq('rejected', false),
  ]);
  return (pendingChores || 0) + (pendingRewards || 0);
}

// The device's local date (YYYY-MM-DD) and minutes past midnight right now.
function localNow(timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
  } catch (e) {
    return localNow('Africa/Johannesburg'); // unknown zone name from an odd browser
  }
  const get = (t) => parts.find(p => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

// A reminder is due once the chosen time has passed today and it hasn't gone
// out today. The two-hour window stops a stalled scheduler from firing a
// "6pm" reminder at midnight when it catches up.
function reminderDue(sub) {
  const now = localNow(sub.reminder_tz || 'Africa/Johannesburg');
  const [h, m] = String(sub.reminder_time || '18:00').split(':').map(Number);
  const at = h * 60 + (m || 0);
  const due = sub.reminder_last_sent !== now.date && now.minutes >= at && now.minutes < at + 120;
  return { due, today: now.date };
}

async function sendDailyReminders(req, res) {
  const secret = process.env.REMINDER_CRON_SECRET;
  if (!secret || req.headers['authorization'] !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!configured()) {
    res.status(200).json({ sent: 0, reason: 'push not configured' });
    return;
  }
  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: subs, error } = await supabaseAdmin.from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth, reminder_time, reminder_tz, reminder_last_sent')
    .eq('reminder_enabled', true);
  if (error) {
    console.error('Reminder lookup failed:', error.message);
    res.status(500).json({ error: 'lookup failed' });
    return;
  }

  // Group due devices by family, so pending is counted once per family.
  const byUser = new Map();
  for (const sub of subs || []) {
    const { due, today } = reminderDue(sub);
    if (!due) continue;
    if (!byUser.has(sub.user_id)) byUser.set(sub.user_id, []);
    byUser.get(sub.user_id).push({ ...sub, today });
  }

  setVapid();
  let sent = 0, skipped = 0;
  const dead = [];
  for (const [userId, due] of byUser) {
    const total = await countPending(supabaseAdmin, userId);
    if (total > 0) {
      const payload = JSON.stringify({
        title: 'Chores waiting for you',
        body: `${pluralise(total, 'item')} waiting for your approval`,
        count: total,
        url: APP_URL.replace('pending_approval', 'daily_reminder'),
        tag: 'sprout-approvals',
      });
      const result = await pushToAll(due, payload);
      sent += result.sent;
      dead.push(...result.dead);
      sendPostHogEvent({
        distinctId: userId,
        event: 'push_notification_sent',
        properties: { kind: 'daily_reminder', devices: result.sent, pending_total: total, dead_subscriptions: result.dead.length },
      }).catch(() => {});
    } else {
      skipped += due.length; // nothing to approve: stay quiet, try again tomorrow
    }
    // Mark the day done either way, per device's own local date.
    await Promise.all(due.map(d => supabaseAdmin.from('push_subscriptions')
      .update({ reminder_last_sent: d.today }).eq('id', d.id)));
  }
  if (dead.length) await supabaseAdmin.from('push_subscriptions').delete().in('id', dead);

  res.status(200).json({ due: [...byUser.values()].flat().length, sent, skipped, removed: dead.length });
}

module.exports = async (req, res) => {
  if (req.method === 'GET' && req.query && req.query.job === 'reminders') {
    await sendDailyReminders(req, res);
    return;
  }
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

  const [{ data: subs }, total] = await Promise.all([
    supabaseAdmin.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', userId),
    countPending(supabaseAdmin, userId),
  ]);

  if (!subs || !subs.length) {
    res.status(200).json({ sent: 0 });
    return;
  }

  const who = String(kidName || 'Someone').slice(0, 40);
  const what = String(itemName || '').slice(0, 60);
  const title = kind === 'reward'
    ? `${who} claimed a reward`
    : `${who} marked a chore done`;
  const waiting = total > 0 ? ` · ${pluralise(total, 'item')} waiting for your approval` : '';
  const body = `${what}${waiting}`;

  setVapid();
  const payload = JSON.stringify({ title, body, count: total, url: APP_URL, tag: 'sprout-approvals' });
  const { sent, dead } = await pushToAll(subs, payload);

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
