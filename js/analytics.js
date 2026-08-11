/*
 * Google Analytics (GA4), loaded only after the visitor has accepted
 * cookies via the banner in cookie-consent.js. If they haven't decided
 * yet, we wait and load it the moment they accept. If they decline,
 * this never runs.
 */
(function () {
  var MEASUREMENT_ID = 'G-SNKNZHRKTN';
  var loaded = false;

  function loadGtag() {
    if (loaded) return;
    loaded = true;

    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + MEASUREMENT_ID;
    document.head.appendChild(s);

    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    gtag('js', new Date());
    gtag('config', MEASUREMENT_ID);
  }

  if (!window.sproutConsent) return; // consent script missing — don't track without it

  var consent = window.sproutConsent.get();
  if (consent === 'accepted') {
    loadGtag();
  } else if (consent !== 'declined') {
    window.sproutConsent.onChange(function (value) {
      if (value === 'accepted') loadGtag();
    });
  }
})();
