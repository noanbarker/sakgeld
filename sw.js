/*
 * Sprout service worker.
 *
 * Exists for one reason: push notifications. When a kid marks a chore done,
 * api/push-send.js sends a push message to every device the parent enabled
 * notifications on, and this is the code that receives it and shows it, even
 * when Sprout isn't open. iPhones only allow this for web apps added to the
 * home screen (iOS 16.4+), Android and desktop browsers allow it anywhere.
 *
 * Deliberately no caching. A cached copy of app/index.html that outlives a
 * deploy would be far more trouble than the offline support is worth.
 *
 * Lives at the site root so its scope covers /app/.
 */

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }

  var title = data.title || 'Sprout';
  var options = {
    body: data.body || '',
    icon: data.icon || '/images/icon-192.png',
    badge: data.badge || '/images/icon-192.png',
    // One notification per family, updated in place: five chores ticked off in
    // a row become a single "5 waiting for your approval", not five alerts.
    tag: data.tag || 'sprout-approvals',
    renotify: false,
    data: { url: data.url || '/app/index.html?mode=signin&open=approvals' },
  };

  var work = [self.registration.showNotification(title, options)];
  // The number on the home-screen icon (installed apps only; ignored elsewhere).
  if (typeof data.count === 'number' && self.navigator && self.navigator.setAppBadge) {
    work.push(data.count > 0 ? self.navigator.setAppBadge(data.count) : self.navigator.clearAppBadge());
  }
  event.waitUntil(Promise.all(work).catch(function () {}));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/app/index.html?mode=signin';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      // Reuse an open Sprout window if there is one, so the parent lands in the
      // app they already had open rather than a second copy.
      for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (client.url.indexOf('/app/') !== -1 && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
