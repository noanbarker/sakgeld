/*
 * Captures utm_source/medium/campaign/content/term from the URL the moment a
 * visitor lands from a tagged link, and remembers it in localStorage. Signup
 * happens on a later pageview in /app/ with no query string of its own, so
 * without this the ad/post that brought someone in would be lost by the time
 * they actually start a trial. Only overwrites what's stored when the current
 * URL actually carries new UTM params, so browsing the site afterward doesn't
 * erase the original attribution.
 *
 * The same file also lands a partner referral code (a school's code from a
 * poster or QR) in localStorage, for exactly the same reason: it arrives on the
 * landing page and is needed several pageviews later at signup.
 */
(function () {
  var KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var params = new URLSearchParams(window.location.search);
  var found = {};
  var hasAny = false;
  KEYS.forEach(function (k) {
    var v = params.get(k);
    if (v) { found[k] = v; hasAny = true; }
  });
  if (!hasAny) return;
  found.captured_at = new Date().toISOString();
  try { localStorage.setItem('sprout_utm', JSON.stringify(found)); } catch (e) {}
})();

/*
 * Meta's click id. A Meta ad adds ?fbclid=... to the landing link, and Meta's
 * Conversions API wants it back as `fbc` ("fb.1.<click time in ms>.<fbclid>")
 * when a trial starts, often several pages and a Paystack redirect later.
 *
 * Kept here, with the time it was first seen, only on this device. The app
 * sends it to our server (and so to Meta) only if the visitor accepts cookies
 * (metaMatchKeys in app/index.html), and js/meta-pixel.js deletes it the moment
 * they decline. A later visit with no fbclid leaves the original click alone;
 * a new ad click replaces it.
 */
(function () {
  var fbclid = new URLSearchParams(window.location.search).get('fbclid');
  if (!fbclid || !/^[A-Za-z0-9_-]{1,500}$/.test(fbclid)) return;
  try {
    var saved = JSON.parse(localStorage.getItem('sprout_fbclid') || 'null');
    if (saved && saved.v === fbclid) return; // same click reloaded: keep its original time
    localStorage.setItem('sprout_fbclid', JSON.stringify({ v: fbclid, ts: Date.now() }));
  } catch (e) {}
})();

/*
 * Partner referral codes reach us two ways:
 *
 *   /join/GREYCOLLEGE  — the printed short link. middleware.js banks the code in
 *                        a `sprout_ref` cookie and redirects to a bare homepage
 *                        URL, so by the time this runs the code is already in
 *                        the cookie and was never in the address bar.
 *   ?ref=GREYCOLLEGE   — the fallback for a link shared or forwarded by hand.
 *
 * Both end up in the same localStorage key so the signup form has one place to
 * look. The cookie is deliberately left in place too: a server-set cookie
 * outlives Safari's seven-day cap on script-written storage and localStorage
 * doesn't, so whichever survives longer, signup still finds the code.
 */
(function () {
  function normalise(raw) {
    var value = String(raw || '');
    try { value = decodeURIComponent(value); } catch (e) { /* keep raw */ }
    return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40);
  }

  function fromCookie() {
    var match = / ?sprout_ref=([^;]*)/.exec('; ' + document.cookie);
    return match ? match[1] : '';
  }

  // A ?ref= on the current URL is a deliberate act and wins over anything
  // already banked, so a parent following a second school's link isn't stuck
  // with the first one.
  var params = new URLSearchParams(window.location.search);
  var fromUrl = normalise(params.get('ref'));
  var code = fromUrl || normalise(fromCookie());
  if (code) {
    try { localStorage.setItem('sprout_ref', code); } catch (e) {}
  }
  // The cookie has to be overwritten too, not just localStorage. Signup reads
  // the cookie ahead of localStorage (it's the longer-lived of the two), so
  // leaving a stale cookie behind would credit the first school a visitor
  // happened to click rather than the last one.
  if (fromUrl) {
    document.cookie = 'sprout_ref=' + fromUrl + '; Path=/; Max-Age=7776000; SameSite=Lax'
      + (window.location.protocol === 'https:' ? '; Secure' : '');
  }

  // Tidy a hand-shared ?ref= out of the address bar once it's banked, so those
  // links end up looking like the printed ones. replaceState rather than a
  // redirect: no second round trip and no extra back-button entry. Only `ref` is
  // dropped — utm_* params are left for the block above and for any analytics
  // reading them later in the page.
  if (!params.has('ref') || !window.history || !window.history.replaceState) return;
  params.delete('ref');
  var query = params.toString();
  try {
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + (query ? '?' + query : '') + window.location.hash
    );
  } catch (e) {}
})();
