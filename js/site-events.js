/*
 * Marketing-site engagement events for PostHog. Loaded on every page outside
 * /app/ after js/posthog.js, which provides window.sproutTrack.
 *
 * PostHog's autocapture already records every click as a generic "$autocapture"
 * event, but those are hard to build a funnel from ("clicks on an <a> whose text
 * was 'Start free trial' inside a div with class pr-hero…"). The handful of
 * events here are the ones a dashboard actually asks about, named plainly, with
 * the properties the question needs: which button, on which page, in which
 * part of the page.
 *
 *   cta_clicked        any link into the app. `intent` is 'signup' or 'signin',
 *                      `placement` says where on the page it sat.
 *   faq_opened         a question expanded on the homepage or FAQ page.
 *   outbound_clicked   a link off the site (social, email, WhatsApp).
 *   page_scrolled      25/50/75/100% depth milestones, once each per pageview.
 *                      (PostHog's own $pageleave carries a scroll depth too,
 *                      but only as a number on an event that fires as the tab
 *                      closes, which browsers are free to drop; these are
 *                      reliable and can be stepped through in a funnel.)
 *
 * Everything is delegated from document so the pages' markup needs no changes,
 * and everything is wrapped so an analytics failure can never break a page.
 */
(function () {
  function track(event, properties) {
    if (typeof window.sproutTrack === 'function') window.sproutTrack(event, properties);
  }

  function pageName() {
    var path = window.location.pathname.replace(/\/index\.html$/, '/');
    return path === '/' ? 'home' : path.replace(/^\//, '').replace(/\.html$/, '');
  }

  // Where on the page a call-to-action sat. Checks an explicit data-cta first,
  // then falls back to the nearest landmark so the existing markup needs no edits.
  function placementOf(el) {
    var explicit = el.closest('[data-cta]');
    if (explicit) return explicit.getAttribute('data-cta');
    if (el.closest('#pr-sticky-cta')) return 'mobile-sticky';
    if (el.closest('#pr-mobmenu')) return 'mobile-menu';
    if (el.closest('nav, header, .pr-header-row')) return 'nav';
    if (el.closest('footer, .pr-grid-footer, .pr-footer')) return 'footer';
    if (el.closest('.pr-hero')) return 'hero';
    if (el.closest('#pr-pricing-section, .pr-pricing, [id*="pricing"]')) return 'pricing';
    if (el.closest('#pr-hiw-section, .pr-hiw')) return 'how-it-works';
    // Otherwise the nearest named block: an id first, then the first class on the
    // way up that isn't the page wrapper itself.
    var node = el.parentElement;
    while (node && node !== document.body) {
      if (node.id) return node.id.replace(/^pr-/, '');
      var cls = (node.className && String(node.className).split(/\s+/)[0]) || '';
      if (cls && cls !== 'pr-page-wrap' && /^pr-/.test(cls)) return cls.replace(/^pr-/, '');
      node = node.parentElement;
    }
    return 'body';
  }

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var text = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);

    if (/(^|\/)app\/(index\.html)?(\?|$)/.test(href)) {
      var intent = /mode=signin/.test(href) ? 'signin' : 'signup';
      track('cta_clicked', { intent: intent, label: text, placement: placementOf(a), page: pageName() });
      return;
    }

    if (/^mailto:/.test(href) || /^https?:\/\//.test(href) && a.hostname && a.hostname !== window.location.hostname) {
      track('outbound_clicked', { url: href, label: text, page: pageName() });
    }
  }, true);

  // FAQ accordions (homepage and faq.html share the same markup). Fires only on
  // open, not close, and only for the question, never the category header.
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.faq-toggle') : null;
    if (!btn) return;
    var item = btn.closest('.faq-item');
    var answer = item && item.querySelector('.faq-answer');
    // The page's own handler runs after this capturing listener, so "closed
    // now" means it's about to open.
    var opening = answer && answer.style.display === 'none';
    if (!opening) return;
    var question = (btn.textContent || '').replace(/[+−]\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    track('faq_opened', { question: question, page: pageName() });
  }, true);

  // Scroll depth milestones. Depth is how far down the page the *bottom* of the
  // viewport has reached, so a short page that fits on screen counts as 100%.
  // The pages' .pr-page-wrap has overflow:auto and can be the element that
  // actually scrolls rather than the window, so this listens for scrolls
  // anywhere (capture phase) and measures whichever element moved.
  var reached = {};
  function depthOf(el) {
    var scrollHeight = el.scrollHeight;
    var clientHeight = el.clientHeight || window.innerHeight;
    if (!scrollHeight || !clientHeight) return 0;
    return Math.round(((el.scrollTop + clientHeight) / scrollHeight) * 100);
  }
  function checkScroll(target) {
    var el = (target && target.nodeType === 1) ? target : (document.scrollingElement || document.documentElement);
    var pct = depthOf(el);
    [25, 50, 75, 100].forEach(function (mark) {
      if (pct >= mark && !reached[mark]) {
        reached[mark] = true;
        track('page_scrolled', { depth: mark, page: pageName() });
      }
    });
  }
  // Throttled with a timer rather than requestAnimationFrame: a background
  // tab pauses animation frames entirely, and a scroll that happened just before
  // the tab was switched away would otherwise never be measured.
  var pendingTarget = null;
  var timer = null;
  document.addEventListener('scroll', function (e) {
    pendingTarget = e.target;
    if (timer) return;
    timer = setTimeout(function () { timer = null; checkScroll(pendingTarget); }, 150);
  }, { capture: true, passive: true });
})();
