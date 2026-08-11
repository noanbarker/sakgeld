/*
 * Sprout cookie consent banner.
 *
 * Shows a bottom banner asking visitors to accept or decline non-essential
 * (analytics/advertising) cookies, and stores their choice in localStorage
 * (shared across every page on this domain, including the app).
 *
 * Nothing currently reads this choice — the site doesn't set any
 * analytics/advertising cookies yet. This exists so that when the Meta
 * Pixel / TikTok Pixel / GA are added later, that code can gate itself on
 * window.sproutConsent.get() === 'accepted' instead of firing unconditionally.
 */
(function () {
  var STORAGE_KEY = 'sprout_cookie_consent';
  var listeners = [];

  function get() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function set(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch (e) {
      /* localStorage unavailable (private mode, etc.) — choice just won't persist */
    }
    listeners.forEach(function (fn) {
      try { fn(value); } catch (e) {}
    });
    document.dispatchEvent(new CustomEvent('sproutconsentchange', { detail: { value: value } }));
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  window.sproutConsent = { get: get, set: set, onChange: onChange };

  if (get()) return; // already decided, don't show the banner again

  function renderBanner() {
    var wrap = document.createElement('div');
    wrap.id = 'sprout-cookie-banner';
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', 'Cookie consent');
    wrap.style.cssText = [
      'position:fixed', 'z-index:1000',
      'background:#ffffff', 'border:1px solid #e5ece7', 'border-radius:16px',
      'box-shadow:0 12px 32px rgba(15,40,25,.16)',
      'padding:16px 18px', 'box-sizing:border-box',
      'font-family:\'Nunito\',system-ui,sans-serif',
      'display:flex', 'flex-direction:column', 'gap:12px',
      'opacity:0', 'transform:translateY(12px)',
      'transition:opacity .25s ease,transform .25s ease'
    ].join(';');

    var text = document.createElement('p');
    text.style.cssText = 'margin:0;font-size:13.5px;line-height:1.5;color:#1e293b';
    text.innerHTML = 'We use cookies to understand how visitors use Sprout and to show relevant ads. You can accept or decline non-essential cookies. See our <a href="/privacy.html" style="color:#15803d;font-weight:700;text-decoration:underline">Privacy Policy</a>.';

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap';

    var declineBtn = document.createElement('button');
    declineBtn.type = 'button';
    declineBtn.textContent = 'Decline';
    declineBtn.style.cssText = 'flex:1;min-width:110px;height:40px;border-radius:10px;border:1px solid #e5ece7;background:#fff;color:#1e293b;font-weight:700;font-size:13.5px;font-family:inherit;cursor:pointer';

    var acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.textContent = 'Accept';
    acceptBtn.style.cssText = 'flex:1;min-width:110px;height:40px;border-radius:10px;border:none;background:linear-gradient(132deg,#16a34a,#15803d);color:#fff;font-weight:800;font-size:13.5px;font-family:inherit;cursor:pointer;box-shadow:0 6px 16px rgba(22,163,74,.28)';

    function dismiss(value) {
      set(value);
      wrap.style.opacity = '0';
      wrap.style.transform = 'translateY(12px)';
      window.setTimeout(function () {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }, 250);
    }

    declineBtn.addEventListener('click', function () { dismiss('declined'); });
    acceptBtn.addEventListener('click', function () { dismiss('accepted'); });

    actions.appendChild(declineBtn);
    actions.appendChild(acceptBtn);
    wrap.appendChild(text);
    wrap.appendChild(actions);
    document.body.appendChild(wrap);

    // On narrow screens, a full-width sheet (above the mobile sticky CTA bar).
    // On wider screens, a compact card docked to the corner so it never
    // covers centered page content or a form's submit button.
    var mq = window.matchMedia('(max-width:640px)');
    function applyLayout() {
      if (mq.matches) {
        wrap.style.left = '16px';
        wrap.style.right = '16px';
        wrap.style.bottom = '96px';
        wrap.style.maxWidth = 'none';
      } else {
        wrap.style.left = 'auto';
        wrap.style.right = '20px';
        wrap.style.bottom = '20px';
        wrap.style.maxWidth = '360px';
      }
    }
    applyLayout();
    if (mq.addEventListener) mq.addEventListener('change', applyLayout);

    requestAnimationFrame(function () {
      wrap.style.opacity = '1';
      wrap.style.transform = 'translateY(0)';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderBanner);
  } else {
    renderBanner();
  }
})();
