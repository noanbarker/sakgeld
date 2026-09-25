const { createClient } = require('@supabase/supabase-js');

const GRACE_PERIOD_MS = 60 * 24 * 60 * 60 * 1000;
const ATTRIBUTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Deletion order matters: these reference kids/chores/rewards, so they have
// to go first, before the tables they point to.
const CHILD_TABLES = ['completions', 'transactions', 'reward_completions'];
const PARENT_TABLES = ['kids', 'chores', 'rewards', 'bonus_milestones'];
const CHORE_PHOTO_BUCKET = 'chore-photos';

// Custom chore photos live in a bucket, not a table, so deleting the rows
// leaves them behind. Each family's photos sit in a folder named after their
// user id, which is what makes them findable once the chores are gone.
async function purgeChorePhotos(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin.storage.from(CHORE_PHOTO_BUCKET).list(userId, { limit: 1000 });
  if (error) {
    console.error(`Failed to list chore photos for user ${userId}:`, error.message);
    return false;
  }
  if (!data.length) return true;
  const paths = data.map(f => `${userId}/${f.name}`);
  const { error: removeError } = await supabaseAdmin.storage.from(CHORE_PHOTO_BUCKET).remove(paths);
  if (removeError) {
    console.error(`Failed to delete chore photos for user ${userId}:`, removeError.message);
    return false;
  }
  return true;
}

// Runs once a day via the Vercel Cron job in vercel.json. For any account
// whose subscription has been canceled for 60+ days, deletes all of that
// family's app data and strips their profile down to name/email/country —
// matching what the privacy policy promises. Anyone who reactivates in the
// meantime has their `canceled_at` stamp cleared by the webhook, so they're
// simply skipped here and keep everything.
module.exports = async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const cutoff = Date.now() - GRACE_PERIOD_MS;

  let purged = 0;
  let page = 1;
  for (;;) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      console.error('Failed to list users for purge:', error.message);
      res.status(500).json({ error: 'Failed to list users' });
      return;
    }
    if (!data.users.length) break;

    for (const user of data.users) {
      const meta = user.user_metadata || {};
      if (meta.subscription_status !== 'canceled' || !meta.canceled_at) continue;
      if (new Date(meta.canceled_at).getTime() > cutoff) continue;

      // Photos first: the chore rows are the only record of which files exist,
      // so dropping them before the bucket would strand the images for good.
      let failed = !(await purgeChorePhotos(supabaseAdmin, user.id));
      for (const table of [...CHILD_TABLES, ...PARENT_TABLES]) {
        const { error: deleteError } = await supabaseAdmin.from(table).delete().eq('user_id', user.id);
        if (deleteError) {
          console.error(`Failed to purge ${table} for user ${user.id}:`, deleteError.message);
          failed = true;
        }
      }
      // Leave the stamp in place on failure so tomorrow's run retries this user.
      if (failed) continue;

      const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
        user_metadata: {
          name: meta.name || null,
          email: meta.email || user.email,
          country: meta.country || null,
        },
      });
      if (updateError) {
        console.error(`Failed to reset metadata for user ${user.id}:`, updateError.message);
        continue;
      }
      purged++;
    }

    if (data.users.length < 200) break;
    page++;
  }

  // Meta trial attempts (lib/meta-attribution.js) outlive their use within
  // days: Meta only pairs browser and server copies for about 48 hours. A
  // confirmed trial has already had its match keys wiped; an abandoned
  // checkout still holds them (fbp, fbc, IP, browser). Both go after 30 days.
  const attributionCutoff = new Date(Date.now() - ATTRIBUTION_RETENTION_MS).toISOString();
  const [{ error: confirmedError }, { error: abandonedError }] = await Promise.all([
    supabaseAdmin.from('meta_trial_attribution').delete()
      .not('trial_confirmed_at', 'is', null).lt('trial_confirmed_at', attributionCutoff),
    supabaseAdmin.from('meta_trial_attribution').delete()
      .is('trial_confirmed_at', null).lt('issued_at', attributionCutoff),
  ]);
  if (confirmedError || abandonedError) {
    console.error('Failed to delete old Meta trial attempts:', (confirmedError || abandonedError).message);
  }

  res.status(200).json({ purged });
};
