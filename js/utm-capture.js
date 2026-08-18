/*
 * Captures utm_source/medium/campaign/content/term from the URL the moment a
 * visitor lands from a tagged link, and remembers it in localStorage. Signup
 * happens on a later pageview in /app/ with no query string of its own, so
 * without this the ad/post that brought someone in would be lost by the time
 * they actually start a trial. Only overwrites what's stored when the current
 * URL actually carries new UTM params, so browsing the site afterward doesn't
 * erase the original attribution.
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
