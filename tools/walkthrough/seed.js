/*
 * Demo data for the How It Works walkthrough clips.
 *
 * build.py injects this into a throwaway copy of app/index.html so the real app
 * renders a fixed pretend family. Every frame in the clips is therefore a
 * screenshot of the actual product, not a drawing of it — when the app's look
 * changes, re-running the build picks the change up for free.
 *
 * Six scenes pair into the three numbered steps:
 *   1 + 2  parent sets up a child and a chore
 *   3 + 4  the child works through their day
 *   5 + 6  the parent approves, and the balances move
 *
 * Query parameters: ?scene=1..6, ?cur=ZAR|USD, ?y=<pixels to scroll>.
 */
(function () {
  const params = new URLSearchParams(location.search);
  const scene = params.get('scene') || '1';
  const iso = d => new Date(d).toISOString();

  // Freeze every animation and transition before anything paints. The kid's
  // chore icons float up and down on a 3.2s loop, so without this each capture
  // catches the artwork at a different point in its bob and no two builds ever
  // match. Entrance animations here all finish visible, so stopping them shows
  // the settled state — which is what we want in a still anyway.
  const freeze = document.createElement('style');
  freeze.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
  document.head.appendChild(freeze);

  // The consent banner and tutorial nudge paint before our localStorage flags
  // land, so take them out of the DOM as well as setting the flags.
  function killChrome() {
    document.querySelectorAll('[id*="cookie" i], [class*="cookie" i]').forEach(n => n.remove());
  }

  function seed() {
    localStorage.setItem('sprout_currency', params.get('cur') || 'ZAR');
    localStorage.setItem('sprout_cookie_consent', 'rejected');
    localStorage.setItem('sprout_tutorial_nudge_dismissed', 'true');

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7, 30);

    currentUser = {
      id: 'demo-user',
      email: 'demo@sprout.app',
      user_metadata: { subscription_status: 'active', currency: params.get('cur') || 'ZAR' }
    };

    // Rand figures for the South African cut; the rest-of-world cut runs the same
    // story at dollar-sized amounts rather than a straight currency conversion.
    const usd = (params.get('cur') || 'ZAR') === 'USD';
    const M = usd
      ? { bed: 0.5, pets: 1, laundry: 2, plants: 0.75, liam: 30, zoe: 75, milestone: 50, bonus: 5, milestoneName: 'First $50 saved' }
      : { bed: 5, pets: 10, laundry: 15, plants: 8, liam: 320, zoe: 860, milestone: 500, bonus: 50, milestoneName: 'First R500 saved' };

    const kids = [
      { id: 'k1', user_id: 'demo-user', name: 'Liam', emoji: '13', balance: M.liam, created_at: iso('2026-01-04'), color_key: 'blue', date_of_birth: '2016-03-14' },
      { id: 'k2', user_id: 'demo-user', name: 'Zoe', emoji: '12', balance: M.zoe, created_at: iso('2026-01-04'), color_key: 'coral', date_of_birth: '2018-07-02' }
    ];
    const chores = [
      { id: 'c1', name: 'Make Bed', description: 'Make your bed every morning', value: M.bed, weight: 1, assignedTo: 'all', emoji: '1', schedule: 'daily', days: [], created_at: iso('2026-01-05') },
      { id: 'c2', name: 'Feed Pets', description: 'Food and fresh water', value: M.pets, weight: 1, assignedTo: 'all', emoji: '27', schedule: 'daily', days: [], created_at: iso('2026-01-05') },
      { id: 'c3', name: 'Sort Laundry', description: 'Colours and whites', value: M.laundry, weight: 1, assignedTo: 'all', emoji: '4', schedule: 'daily', days: [], created_at: iso('2026-01-05') },
      { id: 'c4', name: 'Water Plants', description: 'All the indoor plants', value: M.plants, weight: 1, assignedTo: 'all', emoji: '29', schedule: 'daily', days: [], created_at: iso('2026-01-05') }
    ];
    const done = (id, choreId, kidId, approved) => ({
      id, choreId, kidId, completedAt: iso(today), dueDate: null,
      approved: !!approved, rejected: false, missed: false
    });

    // Chores already approved earlier in the week, so the progress rings read as
    // a family mid-routine rather than an account opened five minutes ago.
    const dstr = d => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
    const monday = (() => { const d = new Date(today); const day = d.getDay(); d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day)); d.setHours(0, 0, 0, 0); return d; })();
    const earned = [];
    let txn = 0;
    const tx = (kidId, amount, name, d) => earned.push({
      id: 't' + (++txn), kidId, type: 'chore', amount, description: name,
      choreDate: dstr(d), createdAt: iso(d)
    });
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday); d.setDate(monday.getDate() + i);
      const rows = [['k1', M.bed, 'Make Bed'], ['k1', M.pets, 'Feed Pets'], ['k2', M.bed, 'Make Bed'], ['k2', M.plants, 'Water Plants']];
      if (i < 3) rows.push(['k2', M.laundry, 'Sort Laundry'], ['k1', M.laundry, 'Sort Laundry']);
      rows.forEach(([kidId, amount, name]) => tx(kidId, amount, name, d));
    }

    cache = {
      kids, chores,
      completions: [],
      transactions: earned,
      bonusMilestones: [
        { id: 'b1', name: M.milestoneName, threshold: M.milestone, bonusAmount: M.bonus, assignedTo: 'all', claimedBy: [], created_at: iso('2026-01-05') }
      ],
      rewards: [], rewardCompletions: [], distributions: [], cycleHistory: []
    };

    S.tourStep = -1;
    S.modal = null;

    // The three chores sitting in the approval queue for scenes 5 and 6.
    const queue = [['p1', 'c3', 'k2', M.laundry], ['p2', 'c1', 'k2', M.bed], ['p3', 'c2', 'k1', M.pets]];

    if (scene === '1') {
      cache.kids = [kids[0]];
      S.view = 'parent'; S.tab = 'kids';
      openModal('add-kid', { name: 'Zoe', pin: '1234', date_of_birth: '2018-07-02', emoji: '12', color_key: 'coral' });
    } else if (scene === '2') {
      S.view = 'parent'; S.tab = 'chores';
      openModal('add-chore', { name: 'Make Bed', description: 'Make your bed every morning', value: M.bed, emoji: '1', assignedTo: 'all', schedule: 'daily' });
    } else if (scene === '3') {
      cache.completions = [done('p1', 'c3', 'k2')];
      S.view = 'kid'; S.kidId = 'k2'; S.tab = 'overview';
      render();
    } else if (scene === '4') {
      cache.completions = [done('p1', 'c3', 'k2'), done('p2', 'c1', 'k2')];
      S.view = 'kid'; S.kidId = 'k2'; S.tab = 'overview';
      render();
    } else if (scene === '5') {
      cache.completions = queue.map(([id, c, k]) => done(id, c, k, false));
      S.view = 'parent'; S.tab = 'overview';
      render();
    } else if (scene === '6') {
      // The same dashboard one tap later: queue cleared, balances and the weekly
      // ring moved by exactly what was just approved. Scene 5 and 6 share a
      // scroll position on purpose, so the clip reads as a state change rather
      // than the page moving.
      cache.completions = queue.map(([id, c, k]) => done(id, c, k, true));
      queue.forEach(([, , kidId, amount]) => {
        const kid = cache.kids.find(k => k.id === kidId);
        if (kid) kid.balance = Math.round((kid.balance + amount) * 100) / 100;
        tx(kidId, amount, 'Approved', today);
      });
      S.view = 'parent'; S.tab = 'overview';
      render();
    }

    killChrome();

    // Scene 1 rests on the avatar picker, whose grid scrolls inside the modal.
    // Avatars are pictures rather than characters, so the selected one is found
    // by the aria-pressed the app puts on it, not by matching button text.
    const wantAvatar = scene === '1';
    // Scroll only once every image has settled. Chore icons load lazily, and
    // applying a scroll offset while they are still arriving shifts the layout
    // underneath it — which made scene 4 land a few pixels off from run to run.
    imagesSettled(() => {
      killChrome();
      if (wantAvatar) {
        const btn = document.querySelector('button[aria-pressed="true"][aria-label]');
        const box = scroller(btn);
        if (btn && box) box.scrollTop = Math.max(0, btn.offsetTop - box.offsetTop - box.clientHeight / 2 + btn.offsetHeight / 2);
      }
      const y = parseInt(params.get('y') || '0', 10);
      if (y) {
        const panes = Array.from(document.querySelectorAll('*')).filter(el => el.scrollHeight > el.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(el).overflowY));
        const pane = panes.sort((a, b) => b.clientHeight - a.clientHeight)[0] || document.scrollingElement;
        pane.scrollTop = y;
        window.scrollTo(0, y);
      }
      // build.py waits for this before taking the screenshot.
      document.documentElement.setAttribute('data-demo-ready', '1');
    });
  }

  function imagesSettled(done) {
    // decode() resolves only once the bitmap is ready to paint. Waiting on
    // .complete alone is not enough: a loaded-but-undecoded chore icon paints a
    // frame or two later, which is what made repeat captures differ.
    const imgs = Array.from(document.images);
    const ready = imgs.map(i => (i.decode ? i.decode().catch(() => {}) : Promise.resolve()));
    const settled = Promise.all(ready);
    const guard = new Promise(r => setTimeout(r, 8000));
    Promise.race([settled, guard]).then(() => {
      requestAnimationFrame(() => requestAnimationFrame(done));
    });
  }

  function scroller(el) {
    for (let n = el && el.parentElement; n; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 8 && /auto|scroll/.test(getComputedStyle(n).overflowY)) return n;
    }
    return null;
  }

  // initApp() is async and paints a "Loading…" screen first; wait it out.
  let tries = 0;
  const t = setInterval(() => {
    const app = document.getElementById('app');
    if ((app && app.textContent && !/Loading/.test(app.textContent)) || ++tries > 120) {
      clearInterval(t);
      try { seed(); } catch (e) { console.error('seed failed', e); }
    }
  }, 50);
})();
