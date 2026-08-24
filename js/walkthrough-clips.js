/*
 * How It Works walkthrough clips.
 *
 * Three silent looping clips, one per numbered step. Two jobs here:
 *
 *  1. Currency. Visitors outside South Africa get the dollar cut of each clip.
 *     The swap has to happen before anything loads, which is why every <video>
 *     ships with preload="none" and no autoplay attribute — nothing is fetched
 *     until play() is called below.
 *
 *  2. Cost. Autoplaying three videos would pull ~500 KB on page load for a
 *     section most visitors never scroll to. Instead each clip starts only when
 *     it scrolls into view and pauses when it leaves, so the homepage's initial
 *     load is the poster images alone.
 *
 * Anyone who has asked their system for reduced motion keeps the poster frame
 * and no video is ever fetched.
 */
(function () {
  var clips = document.querySelectorAll('.pr-clip');
  if (!clips.length) return;

  if (document.documentElement.getAttribute('data-geo') === 'ROW') {
    Array.prototype.forEach.call(clips, function (v) {
      var source = v.querySelector('source');
      if (source) source.setAttribute('src', source.getAttribute('src').replace(/(step\d)\.mp4/, '$1-usd.mp4'));
      var poster = v.getAttribute('poster');
      if (poster) v.setAttribute('poster', poster.replace(/(step\d)-poster/, '$1-usd-poster'));
      v.load();
    });
  }

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !('IntersectionObserver' in window)) return;

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var v = entry.target;
      if (entry.isIntersecting) {
        var p = v.play();
        // Autoplay can still be refused (low power mode, for one). The poster
        // stays put if so, which is a fine outcome — don't let it throw.
        if (p && p.catch) p.catch(function () {});
      } else if (!v.paused) {
        v.pause();
      }
    });
  }, { threshold: 0.25 });

  Array.prototype.forEach.call(clips, function (v) { io.observe(v); });
})();
