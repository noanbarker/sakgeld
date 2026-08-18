/*
 * Meta (Facebook/Instagram) Pixel, loaded only after the visitor has
 * accepted cookies via the banner in cookie-consent.js. Same gating
 * pattern as analytics.js.
 */
(function () {
  var PIXEL_ID = '1621574729405259';
  var loaded = false;

  function loadPixel() {
    if (loaded) return;
    loaded = true;

    !function(f,b,e,v,n,t,s)
    {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};
    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
    n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s)}(window, document,'script',
    'https://connect.facebook.net/en_US/fbevents.js');

    fbq('init', PIXEL_ID);
    fbq('track', 'PageView');
  }

  if (!window.sproutConsent) return; // consent script missing — don't track without it

  var consent = window.sproutConsent.get();
  if (consent === 'accepted') {
    loadPixel();
  } else if (consent !== 'declined') {
    window.sproutConsent.onChange(function (value) {
      if (value === 'accepted') loadPixel();
    });
  }
})();
