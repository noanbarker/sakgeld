/*
 * PostHog product analytics, loaded only after the visitor has
 * accepted cookies via the banner in cookie-consent.js. Same gating
 * pattern as analytics.js and meta-pixel.js.
 */
(function () {
  var API_KEY = 'phc_BgfbTW3WJRP9PJN8FYqVU5aS2BrhhkAnnMvjouXKzqxQ';
  var API_HOST = 'https://eu.i.posthog.com';
  var loaded = false;

  function loadPostHog() {
    if (loaded) return;
    loaded = true;

    !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSurveyResponse".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

    posthog.init(API_KEY, {
      api_host: API_HOST,
      person_profiles: 'identified_only'
    });
  }

  if (!window.sproutConsent) return; // consent script missing — don't track without it

  var consent = window.sproutConsent.get();
  if (consent === 'accepted') {
    loadPostHog();
  } else if (consent !== 'declined') {
    window.sproutConsent.onChange(function (value) {
      if (value === 'accepted') loadPostHog();
    });
  }
})();
