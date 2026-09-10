# PostHog: what Sprout tracks and why

Plain-English reference for the product analytics set up in September 2026.
PostHog project: EU cloud, https://eu.posthog.com. Code lives in `js/posthog.js`
(loader + consent), `js/site-events.js` (marketing site), `app/index.html`
(the app, search for `track(`), and `lib/posthog.js` (server-side, called from
the two billing webhooks in `api/`).

## How tracking and cookie consent fit together

| Visitor's choice on the banner | What PostHog does |
|---|---|
| Hasn't answered yet | **Cookieless.** Nothing stored on the device. Pageviews, clicks and funnel events are recorded anonymously; the visitor is counted via a server-side hash that changes daily, so they can't be followed across days. No session replay. |
| Decline | Same as above, permanently. |
| Accept | **Full.** A device id in a cookie, session replay on, and signing in links the browser to the account so acquisition source (which ad, which school) survives into the paid funnel. |

Signed-in activity is always attributed to the account (distinct id = Supabase user id),
and the billing webhooks report to the same id from the server, so the
trial → paid → cancelled funnel is complete regardless of the banner.

## Events

### Marketing site (all pages outside /app/)

| Event | Fires when | Useful properties |
|---|---|---|
| `$pageview` / `$pageleave` | Automatic. Pageleave carries scroll depth and time on page. | `$current_url`, `$referrer`, `utm_*` |
| `$autocapture` | Automatic. Every click, with the element's text. | |
| `$dead_click` | Automatic. A click that did nothing (looks clickable, isn't). | |
| `cta_clicked` | Any link into the app. | `intent` signup/signin, `label`, `placement` nav/hero/pricing/mobile-sticky/footer…, `page` |
| `faq_opened` | A FAQ question expanded (homepage or FAQ page). | `question`, `page` |
| `page_scrolled` | 25 / 50 / 75 / 100% of the page reached, once each. | `depth`, `page` |
| `outbound_clicked` | A link off the site (social, email). | `url`, `label`, `page` |
| `contact_form_submitted` / `contact_form_failed` | Contact page form. | `topic` only, never the message |
| `cookie_consent_accepted` / `cookie_consent_declined` | The banner. Accepted ÷ (accepted + declined) is the consent rate. | |

### App: signup and checkout (browser)

| Event | Fires when | Properties |
|---|---|---|
| `screen_viewed` | Each distinct screen as it appears. The app is one page, so this is its pageview. | `screen`: signup, signin, subscription-gate, onboarding:currency … onboarding:money, home, parent:overview … parent:settings, kid-pin, kid, parent-pin, reset-password |
| `billing_cycle_selected` | Monthly/yearly toggled on the signup form. | `billing_cycle` |
| `signup_submitted` | Form passed validation and was sent to Supabase. | `billing_cycle`, `geo`, `country`, `has_referral_code`, `utm_*` |
| `signup_failed` | Supabase rejected it. | `reason` |
| `signup_duplicate_email` | Email already has an account (sent to sign-in). | |
| `signin_failed` | Wrong password etc. | `reason` |
| `checkout_started` | Paddle overlay opened or Paystack redirect began. | `billing_cycle`, `geo`, `provider`, `has_referral_code`, `utm_*` |
| `checkout_completed` | Browser saw the checkout succeed (Paddle callback / Paystack return). The trial itself is confirmed by the server event below. | `billing_cycle`, `provider`, `utm_*` |

### Billing lifecycle (server, from the webhooks)

All carry `provider` (paddle/paystack), `previous_status`, `status`, `billing_interval`,
`currency`, `amount` where relevant, and the signup attribution
(`referral_code`, `signup_geo`, `country`, `utm_*`). Each one also refreshes the
person's `subscription_status`, `lifecycle_stage`, `billing_interval`,
`payment_provider`, `referral_code`.

| Event | Meaning |
|---|---|
| `trial_started` | The gateway confirmed a 14-day trial. **The real "signup" number.** |
| `subscription_activated` | First successful charge after the trial. **The real conversion.** |
| `subscription_renewed` | A later monthly/annual charge (Paystack only for now). |
| `payment_failed` | Charge failed; account is past due. |
| `payment_recovered` | Past-due account paid. |
| `subscription_cancellation_scheduled` | Parent cancelled; access continues to period end. |
| `subscription_cancellation_reverted` | They changed their mind before it took effect. |
| `trial_cancelled` | Cancelled during the trial. Never paid. |
| `subscription_cancelled` | A paying customer's subscription ended. |
| `subscription_reactivated` | A cancelled account came back. |
| `subscription_paused` / `subscription_resumed` | Paddle pause feature, if ever used. |

### App: setup and everyday use (browser)

| Event | Fires when | Properties |
|---|---|---|
| `onboarding_completed` | Finished the first-run wizard. | `kids_count`, `chores_count` |
| `tour_started` / `tour_ended` | Dashboard tour. | `completed`, `step` |
| `child_added` | | `kids_count` |
| `chore_created` | Regular chore or quick task. | `chores_count`, `schedule`, `has_photo`, `mode` cycle/per_chore |
| `chore_deleted` | | |
| `chore_completed` | A kid marked a chore done. | |
| `chore_approved` / `chore_rejected` | Parent decision. | `pays_out`, `bulk`, `mode` |
| `reward_created` / `reward_claimed` / `reward_approved` | Rewards. | `amount`, `rewards_count` |
| `savings_goal_created` | Bonus milestone. | `goals_count`, `threshold`, `bonus_amount` |
| `payout_recorded` | Parent marked money as handed over. | `amount` |
| `kid_mode_entered` / `kid_pin_failed` | Kid PIN screen. | |
| `parent_pin_set`, `currency_changed`, `manage_subscription_opened`, `signed_out` | Settings. | |
| `push_enabled` / `push_disabled` / `push_permission_denied` / `push_enable_failed` | Push notifications toggled in Settings. | `standalone`, `ios`, `reason` |
| `push_notification_opened` | Parent tapped a push notification and landed in the app. | |
| `push_notification_sent` (server) | A kid's completion or reward claim triggered a push. | `kind`, `devices`, `pending_total` |

### Person properties (filter or group any chart by these)

`subscription_status`, `lifecycle_stage` (trial / paid / payment_issue / cancelled),
`billing_cycle`, `payment_provider`, `signup_geo` (ZA/ROW), `country`,
`referral_code`, `utm_source/medium/campaign/content/term`, `signed_up_at`,
`trial_started_at`, `first_paid_at`, `kids_count`, `chores_count`,
`has_parent_pin`, `onboarding_complete`, `cancel_scheduled`.

## The questions the dashboards answer

1. **Is the website working?** Visitors by source → CTA click rate by placement → signup page reached. Scroll depth and FAQ opens show what people read; dead clicks and replays show what confuses them.
2. **Where does the signup funnel leak?** `screen_viewed: signup` → `signup_submitted` → `checkout_started` → `checkout_completed` → `trial_started` → `subscription_activated`, broken down by geo and by utm_source.
3. **Do families actually set Sprout up?** Activation = `child_added` + `chore_created` + `chore_approved` within 7 days of `trial_started`. Onboarding step drop-off from `screen_viewed: onboarding:*`.
4. **Do they keep using it?** Weekly retention on `chore_approved` (parents) and `chore_completed` (kids) after `trial_started`.
5. **Are we making money?** Trial→paid rate, `payment_failed`, `trial_cancelled` vs `subscription_cancelled`, renewals.
6. **Which schools are working?** `trial_started` and `subscription_activated` broken down by `referral_code`, plus the conversion rate between them per code. Only campaign signups carry a code; everyone else shows as blank.

## Things to know

- **Replay only records visitors who clicked Accept.** If the consent rate is low, there will be few replays. Cookieless visitors still count in every chart.
- **`trial_started` in PostHog comes from the server**, not the browser. The browser-side step is `checkout_completed`. A gap between the two means webhooks aren't arriving.
- Kids' names and balances are visible in replays (only typed input is masked). Add `data-ph-mask` to an element to hide its text.
- Free tier: 1M events and 5k replays a month. Set a billing limit in PostHog → Organization → Billing so it can never charge without warning.
