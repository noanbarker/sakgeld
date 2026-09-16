# Internal admin dashboard

**Where:** `https://www.sproutearnsave.com/admin` (source: `admin/index.html`, data from `api/admin-dashboard.js`).

**Access:** one shared password, `ADMIN_DASHBOARD_KEY`, set in Vercel > Settings > Environment Variables (Production and Preview). The page asks for it once per browser tab and forgets it when the tab closes. Until the variable exists the page shows "ADMIN_DASHBOARD_KEY is not set in Vercel".

**What it shows** (everything is read live from Supabase on each load / Refresh):

- KPI tiles: total sign-ups, active (paying), trialing, canceled, no subscription, estimated MRR (ZA in Rand, rest of world in Dollars), families active in the last 7 days.
- Users by status donut, sign-ups per week (last 12 weeks).
- Breakdowns: country, payment rail (Paystack/Paddle), billing cycle, traffic source, referral partners, engagement totals.
- Needs attention: trials ending within 7 days, failed payments, scheduled cancellations, unverified emails, subscribers with no children added, subscribers quiet for 5+ days, canceled accounts awaiting the 60-day purge.
- Latest contact-form messages.
- All users table: name, email, country, sign-up date, last activity, status, plan, next billing / trial end date, kids, chores, chores done in 7 days, notes. Searchable, filterable by status, sortable by any column, exportable to CSV.

**Definitions**

- *Status* is the `subscription_status` the billing webhooks write to each user's metadata: `active`, `trialing`, `canceled`, or none (signed up but never started a trial).
- *Last activity* is the latest of: last sign-in, a chore ticked off, a transaction, a chore or child added. Supabase only updates last sign-in on a fresh login, so app activity is included to avoid understating it.
- *Estimated MRR* uses list prices (R59 / R590 for South Africa, $4.50 / $45 elsewhere, yearly divided by 12) for users whose status is `active` and who have a billing cycle and gateway on record. It is an estimate, not the gateways' ledger.
- *Provider* is `payment_provider` where set (Paystack); accounts with a Paddle customer id are shown as Paddle.

**Security notes**

- The API only answers `GET` with `Authorization: Bearer <ADMIN_DASHBOARD_KEY>` and compares keys in constant time.
- The page is `noindex` (meta tag and `X-Robots-Tag` header in `vercel.json`) and responses are `no-store`.
- Paystack card authorisation codes and email tokens are never returned.
