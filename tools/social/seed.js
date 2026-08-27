/*
 * Demo data and scene driver for the social clips.
 *
 * build.py injects this into a throwaway copy of app/index.html, so every frame
 * is a screenshot of the real product rather than a drawing of it. Change the
 * pretend family here and rebuild; the clips catch the change up for free.
 *
 * This is the walkthrough seed grown up. The walkthrough only ever needed six
 * fixed screens; social needs a named scene it can ask for by name, a balance it
 * can drive frame by frame, a PIN it can fill a digit at a time, and the pixel
 * position of the button a finger is about to press.
 *
 * Query parameters
 *   ?scene=<name>   which screen to render (see SCENES at the bottom)
 *   ?cur=ZAR|USD    currency cut
 *   ?bal=<number>   override the demo child's balance (drives the tick-up)
 *   ?pin=<0-4>      how many PIN dots are filled
 *   ?y=<px>         scroll the main pane down before shooting
 *   ?tall=1         let the scroll pane grow to its full height, so one capture
 *                   holds the whole screen and build.py can pan down it
 *   ?probe=1        write measurements onto <html> instead of settling for a
 *                   screenshot; build.py reads them back with --dump-dom
 *   ?tap=<name>     measure this button's centre for the finger overlay
 */
(function () {
  const params = new URLSearchParams(location.search);
  const scene  = params.get('scene') || 'parent-kids-1';
  const usd    = (params.get('cur') || 'ZAR') === 'USD';
  const iso    = d => new Date(d).toISOString();

  // Freeze every animation and transition before anything paints. The kid's
  // chore icons float on a 3.2s loop, so without this each capture catches the
  // artwork at a different point in its bob and no two builds ever match. We are
  // building our own motion on top of these stills — the app's own idle
  // animation would only fight it.
  const freeze = document.createElement('style');
  freeze.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
  document.head.appendChild(freeze);

  // Rand figures for the South African cut. The rest-of-world cut runs the same
  // story at dollar-sized amounts rather than a straight currency conversion.
  const M = usd
    ? { bed: 0.5, pets: 1, laundry: 2, plants: 0.75, liam: 30, zoe: 48, milestone: 50, bonus: 5, milestoneName: 'First $50 saved' }
    : { bed: 5, pets: 10, laundry: 15, plants: 8, liam: 320, zoe: 480, milestone: 500, bonus: 50, milestoneName: 'First R500 saved' };

  const KIDS = () => ([
    { id: 'k1', user_id: 'demo-user', name: 'Liam', emoji: '3', balance: M.liam, created_at: iso('2026-01-04'), color_key: 'blue',  date_of_birth: '2016-03-14' },
    { id: 'k2', user_id: 'demo-user', name: 'Zoe',  emoji: '9', balance: M.zoe,  created_at: iso('2026-01-04'), color_key: 'coral', date_of_birth: '2018-07-02' }
  ]);

  const CHORES = () => ([
    { id: 'c1', name: 'Make Bed',    description: 'Make your bed every morning', value: M.bed,     weight: 1, assignedTo: 'all', emoji: '1',  schedule: 'daily', days: [], created_at: iso('2026-01-05') },
    { id: 'c2', name: 'Feed Pets',   description: 'Food and fresh water',        value: M.pets,    weight: 1, assignedTo: 'all', emoji: '27', schedule: 'daily', days: [], created_at: iso('2026-01-05') },
    { id: 'c3', name: 'Sort Laundry',description: 'Colours and whites',          value: M.laundry, weight: 1, assignedTo: 'all', emoji: '4',  schedule: 'daily', days: [], created_at: iso('2026-01-05') },
    { id: 'c4', name: 'Water Plants',description: 'All the indoor plants',       value: M.plants,  weight: 1, assignedTo: 'all', emoji: '29', schedule: 'daily', days: [], created_at: iso('2026-01-05') }
  ]);

  // What is sitting in the approval queue: [completionId, chore, kid, amount].
  // One each, so the clip can show the parent approving Zoe's and leaving her
  // brother's where it is — and so approving hers moves her balance by exactly
  // what Make Bed is worth, rather than by some sum of several chores.
  const QUEUE = () => ([['p1', 'c1', 'k2', M.bed], ['p2', 'c2', 'k1', M.pets]]);

  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7, 30);

  const withoutMakeBed = () => CHORES().filter(c => c.id !== 'c1');

  // A form field's value: whatever the storyboard passed, or the finished value
  // when it did not pass anything. Passing an empty string is how a beat says
  // "not filled in yet", so an absent parameter and an empty one differ.
  function field(name, whenAbsent) {
    return params.has(name) ? params.get(name) : whenAbsent;
  }

  function approve(which) {
    cache.completions = QUEUE().map(([id, c, k]) => done(id, c, k, which(k)));
    QUEUE().forEach(([, , kidId, amount]) => {
      if (!which(kidId)) return;
      const kid = cache.kids.find(k => k.id === kidId);
      if (kid) kid.balance = Math.round((kid.balance + amount) * 100) / 100;
    });
  }

  function done(id, choreId, kidId, approved) {
    return { id, choreId, kidId, completedAt: iso(today), dueDate: null,
             approved: !!approved, rejected: false, missed: false };
  }

  // Chores already approved earlier in the week, so the progress rings read as a
  // family mid-routine rather than an account opened five minutes ago.
  function weekOfEarnings() {
    const dstr = d => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
    const monday = (() => { const d = new Date(today); const day = d.getDay(); d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day)); d.setHours(0, 0, 0, 0); return d; })();
    const out = []; let n = 0;
    const tx = (kidId, amount, name, d) => out.push({
      id: 't' + (++n), kidId, type: 'chore', amount, description: name,
      choreDate: dstr(d), createdAt: iso(d)
    });
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday); d.setDate(monday.getDate() + i);
      const rows = [['k1', M.bed, 'Make Bed'], ['k1', M.pets, 'Feed Pets'], ['k2', M.bed, 'Make Bed'], ['k2', M.plants, 'Water Plants']];
      if (i < 3) rows.push(['k2', M.laundry, 'Sort Laundry'], ['k1', M.laundry, 'Sort Laundry']);
      rows.forEach(([kidId, amount, name]) => tx(kidId, amount, name, d));
    }
    return out;
  }

  function baseCache() {
    return {
      kids: KIDS(),
      chores: CHORES(),
      completions: [],
      transactions: weekOfEarnings(),
      bonusMilestones: [
        { id: 'b1', name: M.milestoneName, threshold: M.milestone, bonusAmount: M.bonus,
          assignedTo: 'all', claimedBy: [], created_at: iso('2026-01-05') }
      ],
      rewards: [], rewardCompletions: [], distributions: [], cycleHistory: []
    };
  }

  // ── the scenes ──────────────────────────────────────────────────────────────
  // Each one leaves the app in a state and returns nothing. build.py names them.

  const SCENES = {
    // 1. Parent sets up a child, then a chore.
    'parent-kids-1': () => { cache.kids = [KIDS()[0]]; S.view = 'parent'; S.tab = 'kids'; render(); },

    // The form as it stands part-way through being filled in. Every field can be
    // handed in from the storyboard, so a name can arrive a letter at a time and
    // a colour can be unpicked and then picked — which is what lets the clip
    // show the form being filled rather than cutting to it already full.
    'add-kid': () => {
      cache.kids = [KIDS()[0]];
      S.view = 'parent'; S.tab = 'kids';
      openModal('add-kid', {
        name:          field('name', 'Zoe'),
        pin:           field('kpin', '1234'),
        date_of_birth: field('dob', '2018-07-02'),
        // Left empty these fall back to the app's own defaults — blue, and the
        // next avatar in the cycle — which is exactly the unpicked state.
        color_key:     field('colour', 'coral'),
        emoji:         field('avatar', '9')
      });
    },
    'parent-kids-2': () => { S.view = 'parent'; S.tab = 'kids'; render(); },

    // Make Bed, so that the chore added here is the same one the child marks
    // done and the parent then approves — one thread through the whole reel.
    //
    // The cost of that: the icon picker opens on the first illustration, which
    // is the bed, so the tile the parent presses is already the chosen one. The
    // press is visible — the tile depresses and rings — but nothing switches.
    'without-makebed': () => { cache.chores = withoutMakeBed(); S.view = 'parent'; S.tab = 'chores'; render(); },
    'add-chore': () => {
      cache.chores = withoutMakeBed();
      S.view = 'parent'; S.tab = 'chores';
      openModal('add-chore', {
        name:        field('cname', 'Make Bed'),
        description: field('cdesc', 'Make your bed every morning'),
        value:       field('cval', M.bed),
        emoji:       field('cicon', '1'),
        assignedTo: 'all', schedule: 'daily'
      });
    },
    'parent-chores': () => { S.view = 'parent'; S.tab = 'chores'; render(); },

    // 2. The child signs in.
    'home':     () => { S.view = 'home'; render(); },
    'kid-pin':  () => { S.view = 'kid-pin'; S.pinKidId = 'k2'; S.pin = '1234'.slice(0, +(params.get('pin') || 0)); render(); },
    'kid-today':() => { S.view = 'kid'; S.kidId = 'k2'; S.tab = 'overview'; render(); },

    // 3. A chore is marked Done.
    'kid-done': () => {
      cache.completions = [done('p2', 'c1', 'k2')];
      S.view = 'kid'; S.kidId = 'k2'; S.tab = 'overview'; render();
    },

    // 4. The parent approves. Two cuts of the same moment: the whole queue
    //    cleared, or only the child whose "Approve all" was pressed. The second
    //    is what really happens after one press, so it is what the reel uses.
    'parent-queue':   () => { cache.completions = QUEUE().map(([id, c, k]) => done(id, c, k, false)); S.view = 'parent'; S.tab = 'overview'; render(); },
    'parent-cleared': () => { approve(() => true);  S.view = 'parent'; S.tab = 'overview'; render(); },
    'parent-approved-zoe': () => { approve(kid => kid === 'k2'); S.view = 'parent'; S.tab = 'overview'; render(); },

    // 5. The balance climbs and the tree grows. ?bal drives it frame by frame.
    'kid-balance': () => { S.view = 'kid'; S.kidId = 'k2'; S.tab = 'overview'; render(); }
  };

  // Where a finger lands. The storyboard names a target, never a coordinate, so
  // the finger follows the button when the layout changes instead of quietly
  // drifting off it.
  //
  //   text:Done!        a button whose label reads that
  //   #k-name           anything a CSS selector can reach
  //   [onclick*="..."]  which covers the colour swatches and icon tiles, since
  //                     each carries its own value in its onclick
  function findTarget(spec) {
    if (!spec) return null;
    if (spec.startsWith('text:')) return btnByText(spec.slice(5));
    try { return document.querySelector(spec); } catch (e) { return null; }
  }

  // The part of a control that actually looks like a button.
  //
  // A colour swatch is a transparent <button> wrapping a coloured circle and a
  // caption; measuring the button gives a tall box round both, and the ring
  // then reads as a focus outline rather than a press on the circle. Where the
  // button paints nothing itself, use the child that does.
  function painted(el) {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const bare = (cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent')
              && cs.backgroundImage === 'none';
    if (!bare) return el;
    const kid = Array.from(el.children).find(c => {
      if (c.tagName === 'IMG' || c.tagName === 'PICTURE') return true;
      const k = getComputedStyle(c);
      return k.backgroundColor !== 'rgba(0, 0, 0, 0)' && k.backgroundColor !== 'transparent';
    });
    return kid ? painted(kid) : el;
  }

  function btnByText(text) {
    const all = Array.from(document.querySelectorAll('button'));
    return all.find(b => b.textContent.trim() === text)
        || all.find(b => b.textContent.trim().startsWith(text))
        || all.find(b => b.textContent.includes(text));
  }

  // ── plumbing ────────────────────────────────────────────────────────────────

  function killChrome() {
    document.querySelectorAll('[id*="cookie" i], [class*="cookie" i]').forEach(n => n.remove());
    // The "New here? — take a two-minute tour" card is real, but it belongs to
    // an account opened five minutes ago. This family is mid-routine, and the
    // card only dates the shot.
    document.querySelectorAll('button').forEach(b => {
      if (b.textContent.trim() !== 'Tutorial') return;
      const card = b.closest('div[class*="md:"]') || b.parentElement;
      if (card && /two-minute tour/.test(card.textContent)) card.remove();
      else if (card && card.parentElement && /two-minute tour/.test(card.parentElement.textContent)) card.parentElement.remove();
    });
  }

  function scrollPanes() {
    return Array.from(document.querySelectorAll('*')).filter(el =>
      el.scrollHeight > el.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(el).overflowY));
  }

  function isDocument(el) {
    return !el || el === document.scrollingElement || el === document.documentElement || el === document.body;
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height].map(Math.round);
  }

  function mainPane() {
    // A modal's sheet is the thing that scrolls while it is open, even though
    // the tab content behind it is taller. Without this the avatar and chore
    // icon grids — the two screens most worth scrolling — would never move.
    const sheet = document.querySelector('.modal-sheet');
    if (sheet && sheet.scrollHeight > sheet.clientHeight + 8) return sheet;
    return scrollPanes().sort((a, b) => b.clientHeight - a.clientHeight)[0] || document.scrollingElement;
  }

  function seed() {
    localStorage.setItem('sprout_currency', usd ? 'USD' : 'ZAR');
    localStorage.setItem('sprout_cookie_consent', 'rejected');
    localStorage.setItem('sprout_tutorial_nudge_dismissed', 'true');

    currentUser = {
      id: 'demo-user',
      email: 'demo@sprout.app',
      user_metadata: { subscription_status: 'active', currency: usd ? 'USD' : 'ZAR' }
    };

    cache = baseCache();
    S.tourStep = -1;
    S.modal = null;

    // A balance override has to land before the scene renders, so the savings
    // header and the tree stage are both drawn from it.
    const bal = params.get('bal');
    if (bal !== null) {
      const kid = cache.kids.find(k => k.id === 'k2');
      if (kid) kid.balance = parseFloat(bal);
    }

    (SCENES[scene] || SCENES['parent-kids-1'])();
    killChrome();

    // Scroll and measure only once every image has settled. Chore icons and
    // avatars load lazily, and measuring while they are still arriving shifts
    // the layout underneath the measurement.
    imagesSettled(() => {
      killChrome();

      // Measure the scrolling pane before touching it, so build.py knows which
      // part of the screen moves and which part — header, modal edges, tab bar —
      // has to stay put while it does.
      //
      // Most of the app scrolls as a whole page: its panes are laid out under
      // min-height:100vh, so they grow with their content rather than clipping
      // it, and the document is what actually scrolls. There the moving part is
      // the whole viewport. A modal is the exception — its sheet is capped at
      // 90vh and really does scroll inside a still screen.
      const pane = mainPane();
      paneRect = isDocument(pane)
        ? [0, 0, window.innerWidth, window.innerHeight]
        : rectOf(pane);

      if (params.get('tall')) {
        // Let the pane grow to its content so one capture holds the whole thing.
        // build.py pans a window down it and drops the result back into the
        // pane's slot on the normal capture, which is what keeps the header
        // still while the content scrolls under it.
        pane.style.overflow = 'visible';
        pane.style.height = 'auto';
        pane.style.maxHeight = 'none';
        // A modal sheet is pinned to the bottom of the screen. Grown to its full
        // height it would run off the top, so stand it up from the top instead —
        // the crop lands back in the right place either way.
        if (pane.classList.contains('modal-sheet') && pane.parentElement) {
          pane.parentElement.style.position = 'absolute';
          pane.parentElement.style.alignItems = 'flex-start';
          pane.parentElement.style.height = 'auto';
          pane.parentElement.style.bottom = 'auto';
        }
        document.body.style.height = 'auto';
        document.documentElement.style.height = 'auto';
        paneRect = isDocument(pane)
          ? [0, 0, window.innerWidth, Math.max(document.documentElement.scrollHeight, window.innerHeight)]
          : rectOf(pane);
      }

      // setTimeout rather than requestAnimationFrame: build.py reads the
      // measurements back with Chrome's --dump-dom, which does not paint, so
      // frame callbacks may never run. Timers still fire.
      setTimeout(() => {
        measure();
        applyPress();          // after measuring, so the rect is the resting one
        document.documentElement.setAttribute('data-demo-ready', '1');
      }, 60);
    });
  }

  let paneRect = [0, 0, 390, 844];

  // A button mid-press: pushed in and dimmed, the way it looks under a thumb.
  // Rendered by the app rather than drawn over it, so the button keeps its own
  // shape, shadow and background — and so the press is on the button itself
  // rather than a marker floating above the screen.
  function applyPress() {
    const spec = params.get('press');
    const amt = parseFloat(params.get('amt') || '0');
    if (!spec || !(amt > 0)) return;
    const el = findTarget(spec);
    if (!el) return;
    el.style.transform = 'scale(' + (1 - 0.09 * amt).toFixed(4) + ')';
    el.style.filter = 'brightness(' + (1 - 0.18 * amt).toFixed(4) + ')';
  }

  function measure() {
    // Written onto <html> so build.py can read them back with --dump-dom. The
    // alternative — guessing coordinates by hand — goes stale the moment a
    // button moves, and does so silently.
    const h = Math.ceil(Math.max(
      844,
      paneRect[1] + paneRect[3],
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0));
    document.documentElement.setAttribute('data-tall-h', String(h));
    document.documentElement.setAttribute('data-pane', paneRect.join(','));

    // The button's shape, measured before any press shrinks it, so the ring
    // build.py draws around it matches its outline and its corners.
    const want = params.get('tap') || params.get('press');
    if (want) {
      const el = painted(findTarget(want));
      if (el) {
        const r = el.getBoundingClientRect();
        const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
        document.documentElement.setAttribute(
          'data-tap', [r.left, r.top, r.width, r.height, radius].map(Math.round).join(','));
      }
    }
  }

  function imagesSettled(done) {
    // decode() resolves only once the bitmap is ready to paint. Waiting on
    // .complete alone is not enough: a loaded-but-undecoded icon paints a frame
    // or two later, which is what makes repeat captures differ.
    const imgs = Array.from(document.images);
    const ready = imgs.map(i => (i.decode ? i.decode().catch(() => {}) : Promise.resolve()));
    const guard = new Promise(r => setTimeout(r, 8000));
    Promise.race([Promise.all(ready), guard]).then(() => setTimeout(done, 40));
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
