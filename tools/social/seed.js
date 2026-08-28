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

  // The child the clips follow: whose PIN is tapped in, whose chores are shown,
  // whose "Approve all" the parent presses, whose balance climbs. The other
  // child stays in shot as a sibling, so the screens read as a family rather
  // than an only child. One line switches which of them the story is about;
  // the tap targets that name them are in clips.py.
  const HERO = 'k1';                       // k1 Liam, k2 Zoe
  const OTHER = HERO === 'k1' ? 'k2' : 'k1';
  const usd    = (params.get('cur') || 'ZAR') === 'USD';
  // Sprout has two allowance systems and they change what the app asks a parent
  // for: an amount on every chore, or one amount per child per cycle with the
  // chores merely weighted. Whole screens differ between them, so it is a
  // parameter the storyboard sets rather than something fixed here.
  const mode   = params.get('mode') === 'per_cycle' ? 'per_cycle' : 'per_chore';
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
    ? { bed: 0.5, pets: 1, school: 2, plants: 0.75, liam: 48, zoe: 30, milestone: 50, bonus: 5, milestoneName: 'First $50 saved',
        payout: 10.5, payoutOther: 9.7, payoutPrev: 9.8, payoutOtherPrev: 9 }
    : { bed: 5, pets: 10, school: 15, plants: 8, liam: 480, zoe: 320, milestone: 500, bonus: 50, milestoneName: 'First R500 saved',
        payout: 105, payoutOther: 97, payoutPrev: 98, payoutOtherPrev: 90 };

  const KIDS = () => ([
    { id: 'k1', user_id: 'demo-user', name: 'Liam', emoji: '3', balance: M.liam, created_at: iso('2026-01-04'), color_key: 'blue',  date_of_birth: '2016-03-14', last_distribution_at: iso(payoutDay(-1)) },
    { id: 'k2', user_id: 'demo-user', name: 'Zoe',  emoji: '9', balance: M.zoe,  created_at: iso('2026-01-04'), color_key: 'coral', date_of_birth: '2018-07-02', last_distribution_at: iso(payoutDay(-1)) }
  ]);

  const CHORES = () => ([
    { id: 'c1', name: 'Make Bed',    description: 'Make your bed every morning', value: M.bed,     weight: 1, assignedTo: 'all', emoji: '1',  schedule: 'daily', days: [], created_at: iso('2026-01-05') },
    { id: 'c2', name: 'Feed Pets',   description: 'Food and fresh water',        value: M.pets,    weight: 1, assignedTo: 'all', emoji: '27', schedule: 'daily', days: [], created_at: iso('2026-01-05') },
    { id: 'c3', name: 'Pack School Bag', description: 'Books, lunch and shoes',    value: M.school,  weight: 1, assignedTo: 'all', emoji: '30', schedule: 'daily', days: [], created_at: iso('2026-01-05') },
    { id: 'c4', name: 'Water Plants',description: 'All the indoor plants',       value: M.plants,  weight: 1, assignedTo: 'all', emoji: '29', schedule: 'daily', days: [], created_at: iso('2026-01-05') }
  ]);

  // What is sitting in the approval queue: [completionId, chore, kid, amount].
  // One each, so the clip can show the parent approving the hero's and leaving
  // the sibling's where it is — and so approving it moves the hero's balance by
  // exactly what Make Bed is worth, rather than by some sum of several chores.
  const QUEUE = () => ([['p1', 'c1', HERO, M.bed], ['p2', 'c2', OTHER, M.pets]]);

  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7, 30);
  const monday = (() => {
    const d = new Date(today); const day = d.getDay();
    d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day)); d.setHours(0, 0, 0, 0); return d;
  })();

  const withoutMakeBed = () => CHORES().filter(c => c.id !== 'c1');

  // Payday is the Sunday evening before a week starts. Setting each kid's
  // last_distribution_at to the most recent one is what makes "owed now" come
  // out as this week's earnings and nothing older — which is the figure the
  // Distributions screen exists to give a parent.
  function payoutDay(offset) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + offset);
    d.setHours(18, 0, 0, 0);
    return d;
  }

  const PAYOUTS = () => ([
    ['d1', HERO,  M.payout,          -1],
    ['d2', OTHER, M.payoutOther,     -1],
    ['d3', HERO,  M.payoutPrev,      -8],
    ['d4', OTHER, M.payoutOtherPrev, -8],
  ]).map(function (row) {
    return { id: row[0], kidId: row[1], amount: row[2], createdAt: iso(payoutDay(row[3])) };
  });

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
  const dstr = d => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };

  function weekOfEarnings() {
    const out = []; let n = 0;
    const tx = (kidId, amount, name, d) => out.push({
      id: 't' + (++n), kidId, type: 'chore', amount, description: name,
      choreDate: dstr(d), createdAt: iso(d)
    });
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday); d.setDate(monday.getDate() + i);
      // Nobody has earned Saturday's pocket money on a Thursday. Left running to
      // the end of the week, the days still to come sort above today in the
      // history — so the chore the reel just had approved would not be the row
      // at the top, which is the whole point of the closing shot.
      if (d > today) break;
      const rows = [['k1', M.bed, 'Make Bed'], ['k1', M.pets, 'Feed Pets'], ['k2', M.bed, 'Make Bed'], ['k2', M.plants, 'Water Plants']];
      if (i < 3) rows.push(['k2', M.school, 'Pack School Bag'], ['k1', M.school, 'Pack School Bag']);
      rows.forEach(([kidId, amount, name]) => {
        // The hero's Make Bed today is the one the story is about. It is waiting
        // for approval, not earned, so it must not already be in his history —
        // the parent approving it is what puts it there.
        if (kidId === HERO && name === 'Make Bed' && dstr(d) === dstr(today)) return;
        tx(kidId, amount, name, d);
      });
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
      rewards: [], rewardCompletions: [], distributions: PAYOUTS(), cycleHistory: []
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
        emoji:         field('avatar', '9'),
        // Only rendered under Amount per Cycle, where a child is given a figure
        // for the week rather than a rate for each chore. Ignored otherwise.
        cycle_amount:  field('kcycle', '50')
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
        // Under Amount per Cycle the form drops the value field altogether and
        // asks for a weighting instead, which is the whole point of the shot.
        weight:      field('cweight', '1'),
        assignedTo: 'all', schedule: 'daily'
      });
    },
    'parent-chores': () => { S.view = 'parent'; S.tab = 'chores'; render(); },

    // 2. The child signs in.
    'home':     () => { S.view = 'home'; render(); },
    'kid-pin':  () => { S.view = 'kid-pin'; S.pinKidId = HERO; S.pin = '1234'.slice(0, +(params.get('pin') || 0)); render(); },
    'kid-today':() => { S.view = 'kid'; S.kidId = HERO; S.tab = 'overview'; render(); },

    // 3. A chore is marked Done.
    'kid-done': () => {
      cache.completions = [done('p1', 'c1', HERO)];
      S.view = 'kid'; S.kidId = HERO; S.tab = 'overview'; render();
    },

    // 4. The parent approves. Two cuts of the same moment: the whole queue
    //    cleared, or only the child whose "Approve all" was pressed. The second
    //    is what really happens after one press, so it is what the reel uses.
    //    The sibling's chore stays in the queue, which is the point.
    'parent-queue':   () => { cache.completions = QUEUE().map(([id, c, k]) => done(id, c, k, false)); S.view = 'parent'; S.tab = 'overview'; render(); },
    'parent-cleared': () => { approve(() => true);  S.view = 'parent'; S.tab = 'overview'; render(); },
    'parent-approved': () => { approve(kid => kid === HERO); S.view = 'parent'; S.tab = 'overview'; render(); },

    // 5. The balance climbs and the tree grows. ?bal drives it frame by frame.
    'kid-balance': () => { S.view = 'kid'; S.kidId = HERO; S.tab = 'overview'; render(); },

    // 6. Back in the child's dashboard once the parent has approved: the chore
    //    is approved, the R5 is in the balance, and it is in the history — the
    //    payoff shot. Two cuts, history shut and history open, so the clip can
    //    show the button being pressed and then what it opens.
    'kid-approved': () => approvedKidView(false),
    'kid-history':  () => approvedKidView(true),

    // 7. Where the parent chooses between the two allowance systems. Which one
    //    is selected, and whether the Cycle Length card is there at all, both
    //    follow from ?mode — so one scene covers both halves of the story.
    'settings':  () => { S.view = 'parent'; S.tab = 'settings'; S.settingsSection = null; render(); },
    'allowance': () => { S.view = 'parent'; S.tab = 'settings'; S.settingsSection = 'allowance'; render(); },

    // 8. What the parent owes, and whether the bank agrees.
    //    parent-balances clears the approval queue: that shot is about the
    //    balances themselves, and a stack of pending approvals above them only
    //    pushes them off the bottom of the screen.
    'parent-balances': () => { cache.completions = []; S.view = 'parent'; S.tab = 'overview'; render(); },
    'money':           () => { S.view = 'parent'; S.tab = 'money'; S.moneySection = null; render(); },
    'distributions':   () => { S.view = 'parent'; S.tab = 'money'; S.moneySection = 'distributions'; render(); },
    'recon':           () => { S.view = 'parent'; S.tab = 'money'; S.moneySection = 'recon'; render(); }
  };

  // The child's own view of a chore that has just been approved. approve() moves
  // the balance and marks the completion, but the app writes the transaction on
  // the way through and this seed does not — so the history would come up
  // without the very row the shot is about.
  function approvedKidView(open) {
    approve(kid => kid === HERO);
    cache.transactions.unshift({
      id: 't-approved', kidId: HERO, type: 'chore', amount: M.bed,
      description: 'Make Bed', choreDate: dstr(today), createdAt: iso(today)
    });
    S.historyOpen = open;
    S.view = 'kid'; S.kidId = HERO; S.tab = 'overview'; render();
  }

  // Where a finger lands. The storyboard names a target, never a coordinate, so
  // the finger follows the button when the layout changes instead of quietly
  // drifting off it.
  //
  //   text:Done!        a button whose label reads that
  //   #k-name           anything a CSS selector can reach
  //   [onclick*="..."]  which covers the colour swatches and icon tiles, since
  //                     each carries its own value in its onclick
  //   card:Cycle Length  the panel or row that contains that wording, for
  //                      pointing at a block of the screen that has no id
  //   history:Make Bed   the newest row in the child's history saying that.
  //                      A line in a list has no id and no fixed position, but
  //                      it does say what it is — and scoping the search to the
  //                      list matters, because the same chore is in there four
  //                      times over from earlier in the week and the shot is
  //                      about the one that was just approved.
  function findTarget(spec) {
    if (!spec) return null;
    if (spec.startsWith('text:')) return btnByText(spec.slice(5));
    if (spec.startsWith('card:')) {
      const want = spec.slice(5);
      return Array.from(document.querySelectorAll('.card')).find(c => c.textContent.includes(want)) || null;
    }
    if (spec.startsWith('history:')) {
      const want = spec.slice(8);
      const btn = btnByText('Hide history') || btnByText('Show history');
      const list = btn && btn.closest('div') && btn.closest('div').nextElementSibling;
      if (!list) return null;
      return Array.from(list.querySelectorAll('.card')).find(c => c.textContent.includes(want)) || null;
    }
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
    // Reconciliation keeps the parent's typed-in bank figures in localStorage
    // rather than in the app's own state, so that is where a clip has to put
    // them to show the tool filling up a figure at a time. An absent parameter
    // means the box has not been typed in yet, which is a different thing from
    // a zero in it.
    const recon = {};
    ['k1', 'k2'].forEach(function (id) {
      const v = params.get('rec-' + id);
      if (v !== null && v !== '') recon[id] = v;
    });
    localStorage.setItem('sprout_recon', JSON.stringify(recon));

    localStorage.setItem('sprout_currency', usd ? 'USD' : 'ZAR');
    localStorage.setItem('sprout_cookie_consent', 'rejected');
    localStorage.setItem('sprout_tutorial_nudge_dismissed', 'true');

    currentUser = {
      id: 'demo-user',
      email: 'demo@sprout.app',
      user_metadata: {
        subscription_status: 'active',
        currency: usd ? 'USD' : 'ZAR',
        allowance_mode: mode,
        cycle_period: 'weekly',
        // Anchored to this Monday, so the settings screen reads "this cycle runs
        // from Monday to Sunday" rather than from whatever today happens to be.
        cycle_anchor_date: dstr(monday)
      }
    };

    cache = baseCache();
    S.tourStep = -1;
    S.modal = null;

    // A balance override has to land before the scene renders, so the savings
    // header and the tree stage are both drawn from it.
    const bal = params.get('bal');
    if (bal !== null) {
      const kid = cache.kids.find(k => k.id === HERO);
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
