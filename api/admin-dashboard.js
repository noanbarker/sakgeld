const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Feeds admin/index.html, Sprout's internal dashboard. Everything on that page
// is derived from this one JSON response, so the page itself never touches
// Supabase and never needs the service-role key.
//
// Access is a single shared secret, ADMIN_DASHBOARD_KEY, set in Vercel's
// environment variables. The page asks for it once and sends it as a Bearer
// token on every request. There is no user login behind this endpoint: whoever
// has the key sees every family's name, email and billing state, so treat it
// like a password and rotate it in Vercel if it ever leaks.

// Supabase caps a single select at 1,000 rows (PostgREST's max-rows), so tables
// like completions, which are already past that, have to be read in pages.
const PAGE_SIZE = 1000;

async function fetchAll(supabaseAdmin, table, columns) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

async function fetchAllUsers(supabaseAdmin) {
  const users = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`auth users: ${error.message}`);
    users.push(...data.users);
    if (data.users.length < 200) return users;
  }
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function maxDate(...values) {
  let best = null;
  for (const value of values) {
    if (!value) continue;
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) continue;
    if (best === null || time > best) best = time;
  }
  return best === null ? null : new Date(best).toISOString();
}

function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const id = row[key];
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

// Test accounts and family helping with design skew every number, so they're
// tagged `internal` and the page hides them unless asked. Comma-separated
// emails in ADMIN_DASHBOARD_INTERNAL_EMAILS; case doesn't matter.
function internalEmailSet(value) {
  return new Set(String(value || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

// Pure: turns raw rows into the shape the page renders. Kept separate from the
// handler so it can be run against a saved snapshot without any credentials.
function buildDashboard(raw, now = new Date(), internalEmails = new Set()) {
  const nowMs = now.getTime();
  const sevenDaysAgo = nowMs - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = nowMs - 30 * 24 * 60 * 60 * 1000;

  const kids = raw.kids || [];
  const chores = raw.chores || [];
  const completions = raw.completions || [];
  const transactions = raw.transactions || [];
  const pushSubscriptions = raw.push_subscriptions || [];

  const kidsByUser = countBy(kids, 'user_id');
  const choresByUser = countBy(chores.filter(c => !c.archived), 'user_id');
  const completionsByUser = countBy(completions, 'user_id');
  const pushByUser = countBy(pushSubscriptions, 'user_id');

  const completions7dByUser = new Map();
  const pendingByUser = new Map();
  const lastActivityByUser = new Map();
  const bump = (map, id, when) => {
    const time = when ? new Date(when).getTime() : NaN;
    if (Number.isNaN(time)) return;
    if (!map.has(id) || time > map.get(id)) map.set(id, time);
  };
  for (const c of completions) {
    bump(lastActivityByUser, c.user_id, c.completed_at);
    const time = c.completed_at ? new Date(c.completed_at).getTime() : NaN;
    if (time >= sevenDaysAgo) completions7dByUser.set(c.user_id, (completions7dByUser.get(c.user_id) || 0) + 1);
    if (!c.approved && !c.rejected && !c.missed) pendingByUser.set(c.user_id, (pendingByUser.get(c.user_id) || 0) + 1);
  }
  for (const t of transactions) bump(lastActivityByUser, t.user_id, t.created_at);
  for (const c of chores) bump(lastActivityByUser, c.user_id, c.created_at);
  for (const k of kids) bump(lastActivityByUser, k.user_id, k.created_at);

  const users = (raw.users || []).map(user => {
    const meta = user.user_metadata || {};
    const status = meta.subscription_status || 'none';
    const lastDataActivity = lastActivityByUser.has(user.id) ? new Date(lastActivityByUser.get(user.id)).toISOString() : null;
    // A session refresh doesn't touch last_sign_in_at, so on its own it
    // understates how recently a family used the app. Anything they've done in
    // the app (a chore ticked, a child added) counts as activity too.
    const lastActivity = maxDate(user.last_sign_in_at, lastDataActivity);
    const email = user.email || meta.email || null;
    return {
      id: user.id,
      name: meta.name || null,
      email,
      internal: Boolean(email && internalEmails.has(email.toLowerCase())),
      country: meta.country || null,
      signup_geo: meta.signup_geo || null,
      signed_up_at: user.created_at || null,
      last_sign_in_at: user.last_sign_in_at || null,
      last_activity_at: lastActivity,
      status,
      provider: meta.payment_provider || (meta.paddle_customer_id || (meta.subscription_id && String(meta.subscription_id).startsWith('sub_')) ? 'paddle' : null),
      billing_cycle: meta.billing_cycle || null,
      next_billed_at: meta.next_billed_at || null,
      current_period_ends_at: meta.current_period_ends_at || null,
      canceled_at: meta.canceled_at || null,
      cancel_scheduled: Boolean(meta.cancel_scheduled),
      payment_failed_at: meta.payment_failed_at || null,
      payment_retry_count: meta.payment_retry_count || 0,
      email_verified: Boolean(user.email_confirmed_at),
      onboarding_complete: Boolean(meta.onboarding_complete),
      utm_source: meta.utm_source || null,
      utm_campaign: meta.utm_campaign || null,
      referral_code: meta.referral_code || null,
      banned: Boolean(user.banned_until && new Date(user.banned_until).getTime() > nowMs),
      kids: kidsByUser.get(user.id) || 0,
      chores: choresByUser.get(user.id) || 0,
      completions: completionsByUser.get(user.id) || 0,
      completions_7d: completions7dByUser.get(user.id) || 0,
      pending_approvals: pendingByUser.get(user.id) || 0,
      push_enabled: (pushByUser.get(user.id) || 0) > 0,
    };
  });
  users.sort((a, b) => new Date(b.signed_up_at || 0) - new Date(a.signed_up_at || 0));

  const signupsByCode = new Map();
  for (const s of raw.referral_signups || []) {
    const bucket = signupsByCode.get(s.code_id) || { signups: 0, paid: 0, canceled: 0 };
    bucket.signups += 1;
    if (s.first_paid_at) bucket.paid += 1;
    if (s.canceled_at) bucket.canceled += 1;
    signupsByCode.set(s.code_id, bucket);
  }
  const referralCodes = (raw.referral_codes || []).map(code => ({
    code: code.code,
    partner_name: code.partner_name,
    partner_type: code.partner_type,
    active: code.active,
    created_at: code.created_at,
    ...(signupsByCode.get(code.id) || { signups: 0, paid: 0, canceled: 0 }),
  }));

  const contactMessages = (raw.contact_messages || [])
    .slice()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 10)
    .map(m => ({ name: m.name, email: m.email, topic: m.topic, message: m.message, created_at: m.created_at }));

  const completedAt = c => (c.completed_at ? new Date(c.completed_at).getTime() : NaN);
  const internalIds = new Set(users.filter(u => u.internal).map(u => u.id));
  const totalsFor = keep => {
    const k = kids.filter(r => keep(r.user_id));
    const ch = chores.filter(r => keep(r.user_id));
    const co = completions.filter(r => keep(r.user_id));
    return {
      kids: k.length,
      chores_active: ch.filter(c => !c.archived).length,
      chores_total: ch.length,
      completions: co.length,
      completions_7d: co.filter(c => completedAt(c) >= sevenDaysAgo).length,
      completions_30d: co.filter(c => completedAt(c) >= thirtyDaysAgo).length,
      approved: co.filter(c => c.approved).length,
      pending_approvals: co.filter(c => !c.approved && !c.rejected && !c.missed).length,
      transactions: transactions.filter(r => keep(r.user_id)).length,
      push_subscriptions: pushSubscriptions.filter(r => keep(r.user_id)).length,
      contact_messages: (raw.contact_messages || []).length,
    };
  };
  return {
    generated_at: now.toISOString(),
    users,
    internal_count: internalIds.size,
    referral_codes: referralCodes,
    contact_messages: contactMessages,
    // Two sets of totals so the page's "include test accounts" toggle can
    // switch without another round trip.
    totals: totalsFor(id => !internalIds.has(id)),
    totals_all: totalsFor(() => true),
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const expectedKey = process.env.ADMIN_DASHBOARD_KEY;
  if (!expectedKey) {
    res.status(503).json({ error: 'ADMIN_DASHBOARD_KEY is not set in Vercel' });
    return;
  }
  const authHeader = req.headers['authorization'] || '';
  const providedKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!providedKey || !timingSafeEqual(providedKey, expectedKey)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  try {
    const [users, kids, chores, completions, transactions, referralCodes, referralSignups, contactMessages, pushSubscriptions] = await Promise.all([
      fetchAllUsers(supabaseAdmin),
      fetchAll(supabaseAdmin, 'kids', 'user_id, created_at'),
      fetchAll(supabaseAdmin, 'chores', 'user_id, created_at, archived'),
      fetchAll(supabaseAdmin, 'completions', 'user_id, completed_at, approved, rejected, missed'),
      fetchAll(supabaseAdmin, 'transactions', 'user_id, created_at'),
      fetchAll(supabaseAdmin, 'referral_codes', 'id, code, partner_name, partner_type, active, created_at'),
      fetchAll(supabaseAdmin, 'referral_signups', 'code_id, first_paid_at, canceled_at'),
      fetchAll(supabaseAdmin, 'contact_messages', 'name, email, topic, message, created_at'),
      fetchAll(supabaseAdmin, 'push_subscriptions', 'user_id'),
    ]);
    const dashboard = buildDashboard({
      users,
      kids,
      chores,
      completions,
      transactions,
      referral_codes: referralCodes,
      referral_signups: referralSignups,
      contact_messages: contactMessages,
      push_subscriptions: pushSubscriptions,
    }, new Date(), internalEmailSet(process.env.ADMIN_DASHBOARD_INTERNAL_EMAILS));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(dashboard);
  } catch (err) {
    console.error('Admin dashboard failed:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
};

module.exports.buildDashboard = buildDashboard;
