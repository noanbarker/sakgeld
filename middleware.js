import { geolocation, next } from '@vercel/functions';

// Runs before these pages are served. South Africa gets Rand pricing,
// every other country sees Dollar pricing — decided here, before any
// HTML reaches the browser, so there's no flash of the wrong currency.
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
  ],
};

export default function middleware(request) {
  const { country } = geolocation(request);
  const geo = country === 'ZA' ? 'ZA' : 'ROW';

  // Cookie (not httpOnly) so page scripts can read it synchronously on
  // load, and 30 days so a visitor's currency stays consistent across
  // visits even if a later request is geolocated ambiguously.
  return next({
    headers: {
      'Set-Cookie': `sprout_geo=${geo}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`,
    },
  });
}
