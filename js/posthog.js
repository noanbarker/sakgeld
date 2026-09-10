/*
 * PostHog product analytics.
 *
 * Unlike analytics.js (GA4) and meta-pixel.js, this loads on every page for
 * every visitor, and the cookie banner in cookie-consent.js decides *how* it
 * tracks rather than *whether* it tracks:
 *
 *   banner not answered yet  → cookieless. PostHog stores nothing on the device
 *                              (no cookie, no localStorage) and counts the
 *                              visitor through a server-side hash that changes
 *                              daily. Pageviews, clicks and funnel events are
 *                              still recorded, anonymously. No session replay.
 *   Decline                  → cookieless, exactly as above, permanently.
 *   Accept                   → full tracking: a device id in a cookie, session
 *                              replay, and sign-in links the browser to the
 *                              account so acquisition source survives signup.
 *
 * Before this, PostHog didn't load at all until Accept was clicked, so every
 * visitor who ignored the banner (most of them) was invisible and the ad
 * numbers could never be reconciled against site traffic.
 *
 * How the two modes are achieved, verified against posthog-js source
 * (packages/browser/src/posthog-core.ts, consent.ts):
 *   cookieless_mode 'on_reject' + opt_out_capturing_by_default true means an
 *   undecided visitor is treated as rejected, i.e. cookieless, from the very
 *   first pageview. opt_in_capturing() then resets the instance and switches to
 *   normal cookied tracking (and starts replay); opt_out_capturing() keeps it
 *   cookieless. A visitor who already accepted on an earlier visit is started
 *   directly in normal mode so their first pageview isn't counted twice.
 */
(function () {
  var API_KEY = 'phc_BgfbTW3WJRP9PJN8FYqVU5aS2BrhhkAnnMvjouXKzqxQ';
  var API_HOST = 'https://eu.i.posthog.com';

  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSurveyResponse opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  var consent = window.sproutConsent ? window.sproutConsent.get() : null;

  var config = {
    api_host: API_HOST,
    // Only people who sign in get a person profile; anonymous visitors are
    // counted as events only, which is also what keeps them in the cheaper tier.
    person_profiles: 'identified_only',
    capture_pageview: true,
    // Fires when the visitor leaves a page and carries how far down they
    // scrolled, which is where the "did anyone read past the hero" answer comes from.
    capture_pageleave: true,
    autocapture: true,
    // Clicks that do nothing (a heading someone thought was a button) — a cheap
    // way to find what on the site looks clickable but isn't.
    capture_dead_clicks: true,
    session_recording: {
      // Whatever a parent types (names, emails, passwords, amounts) is replaced
      // by asterisks in the replay. Only the layout and what was clicked survive.
      maskAllInputs: true,
      // Anything the app marks data-ph-mask (kids' names, balances) is masked
      // in the replay as well, even though it's plain text rather than an input.
      maskTextSelector: '[data-ph-mask]'
    }
  };

  if (consent !== 'accepted') {
    config.cookieless_mode = 'on_reject';
    config.opt_out_capturing_by_default = true;
  }

  posthog.init(API_KEY, config);

  if (window.sproutConsent && consent !== 'accepted' && consent !== 'declined') {
    // Still undecided: the banner is on screen. Whatever they click is itself
    // worth measuring (a 20% accept rate means 80% of replay-able sessions are
    // never recorded), so each choice is captured as an event of its own.
    window.sproutConsent.onChange(function (value) {
      if (value === 'accepted') {
        posthog.opt_in_capturing({ captureEventName: 'cookie_consent_accepted' });
      } else if (value === 'declined') {
        posthog.capture('cookie_consent_declined');
        posthog.opt_out_capturing();
      }
    });
  }

  // One safe entry point for the rest of the site. The stub above queues calls
  // made before the real library has finished downloading, so this is safe to
  // call from any script that runs after this one.
  window.sproutTrack = function (event, properties) {
    try { posthog.capture(event, properties || {}); } catch (e) { /* analytics must never break the page */ }
  };

  // Tells the app (app/index.html track()) that anything it queued while this
  // deferred script was still on its way can be sent now.
  try { document.dispatchEvent(new CustomEvent('sproutanalyticsready')); } catch (e) {}
})();
