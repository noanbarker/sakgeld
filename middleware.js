import { geolocation, next } from '@vercel/functions';

// Runs before these pages are served. South Africa gets Rand pricing,
// every other country sees Dollar pricing — decided here, before any
// HTML reaches the browser, so there's no flash of the wrong currency.
//
// The filename matters: Vercel only builds `middleware.js`/`middleware.ts` at
// the project root. This file spent months as `middleware.mjs`, was silently
// never run, and every visitor fell through to the pages' 'ZA' default. Don't
// rename it back, and don't reach for `"type": "module"` in package.json to
// tidy the extension up — api/*.js are CommonJS and would break.
export const config = {
  matcher: [
    '/',
    '/index.html',
    '/pricing.html',
    '/features.html',
    '/about.html',
    '/contact.html',
    '/faq.html',
    '/how-it-works.html',
    '/privacy.html',
    '/terms.html',
    '/refund-policy.html',
    '/app',
    '/app/index.html',
    '/join/:code*',
  ],
};

const GEO_COOKIE_MAX_AGE = 2592000; // 30 days
const REF_COOKIE_MAX_AGE = 7776000; // 90 days — a school's poster stays up all term.

// Codes only ever contain letters and digits (enforced by referral_codes'
// check constraint), so stripping everything else both normalises what a
// visitor typed and makes it impossible to smuggle a `;` into the Set-Cookie
// header below.
function normaliseCode(raw) {
  let value = String(raw || '');
  // A hand-mangled link can leave a stray `%` in the path, which throws here
  // rather than decoding — the raw text is a fine fallback, since the strip
  // below discards anything an escape sequence could have contained.
  try { value = decodeURIComponent(value); } catch (e) { /* keep raw */ }
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40);
}

export default function middleware(request) {
  const { country } = geolocation(request);
  const geo = country === 'ZA' ? 'ZA' : 'ROW';

  // Cookie (not httpOnly) so page scripts can read it synchronously on
  // load, and 30 days so a visitor's currency stays consistent across
  // visits even if a later request is geolocated ambiguously.
  const geoCookie = `sprout_geo=${geo}; Path=/; Max-Age=${GEO_COOKIE_MAX_AGE}; SameSite=Lax; Secure`;

  // /join/GREYCOLLEGE is a partner's short link — the version printed on a
  // poster, read out at assembly, or hidden behind a QR code. The code is banked
  // into a cookie here and the visitor sent on to a bare homepage URL, so
  // nothing is left in the address bar and the homepage's relative image and nav
  // paths still resolve from the site root.
  //
  // Setting the cookie server-side is the point of doing this here rather than
  // as a vercel.json redirect: it outlives Safari's seven-day cap on
  // script-written storage, which is otherwise the most likely way a school
  // signup loses its attribution.
  const { pathname } = new URL(request.url);
  if (pathname === '/join' || pathname.startsWith('/join/')) {
    const code = normaliseCode(pathname.slice('/join/'.length));
    const headers = new Headers({ Location: '/' });
    headers.append('Set-Cookie', geoCookie);
    if (code) {
      headers.append('Set-Cookie', `sprout_ref=${code}; Path=/; Max-Age=${REF_COOKIE_MAX_AGE}; SameSite=Lax; Secure`);
    }
    // 302, never 301/308: a permanent redirect would be cached by the browser
    // forever, so a second scan of the same QR would skip this handler and
    // silently stop refreshing the cookie.
    return new Response(null, { status: 302, headers });
  }

  return next({
    headers: {
      'Set-Cookie': geoCookie,
    },
  });
}
