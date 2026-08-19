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
 * Partner referral codes reach us as `?ref=GREENFIELD25`, either because someone
 * shared such a link directly or because they followed the printed short link
 * `/join/GREENFIELD25`, which vercel.json redirects here.
 *
 * The code is banked and then wiped straight back out of the address bar, so
 * what the visitor is left looking at is a clean `sproutearnsave.com` — the
 * whole point of handing schools a tidy link in the first place.
 */
(function () {
  function normalise(raw) {
    var value = String(raw || '');
    try { value = decodeURIComponent(value); } catch (e) { /* keep raw */ }
    return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40);
  }

  var params = new URLSearchParams(window.location.search);
  if (!params.has('ref')) return;
  var code = normalise(params.get('ref'));
  if (code) {
    try { localStorage.setItem('sprout_ref', code); } catch (e) {}
  }

  // replaceState rather than a redirect: no second round trip, no extra entry in
  // the back button's history, and the query is gone before the visitor has read
  // the page. Only `ref` is dropped — utm_* params are left for the block above
  // and for any analytics reading them later in the page.
  if (!window.history || !window.history.replaceState) return;
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
