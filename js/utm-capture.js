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
 * Partner referral codes reach us two ways:
 *
 *   /join/GREENFIELD25  — the printed short link. middleware.mjs banks the code
 *                         in a `sprout_ref` cookie and redirects to a clean
 *                         homepage URL, so by the time this runs the code is
 *                         already in the cookie and never in the address bar.
 *   ?ref=GREENFIELD25   — the fallback for a link shared or forwarded by hand.
 *
 * Both end up in the same localStorage key so the signup form only has one
 * place to look. The cookie is left in place as well, since a server-set cookie
 * survives Safari's seven-day cap on script-written storage and localStorage
 * doesn't — whichever outlives the other, signup still finds the code.
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
  var code = normalise(new URLSearchParams(window.location.search).get('ref')) || normalise(fromCookie());
  if (!code) return;
  try { localStorage.setItem('sprout_ref', code); } catch (e) {}
})();
