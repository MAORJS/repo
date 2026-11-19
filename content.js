// Runs on every odedsvrmonopoly.app tab. Only one tab paints at a time (Web Lock).
// While the canvas is open it paints your art through the site's own API, logged in as you (same cookies as the page).
//  - Pixel pool: it keeps count of your pixels (up to 10, one more every 5 s), paints right away while you
//    have some, and waits only when the pool is empty.
//  - Live feed: it listens to the site's own event stream, so it knows the moment the canvas opens and
//    sees every pixel anyone paints without re-downloading the board.
//  - Background tabs: its timers run in a worker, so Chrome's background-tab throttling doesn't slow it down.
(() => {
  const DELAY = 5200;               // fallback wait when the server gives no timing
  const GAP = 350;                  // pause between pixels while the pool has some
  const IDLE = 10000;               // re-check this often while closed / off / finished (the live feed wakes it sooner)
  const BOARD_REFRESH_LIVE = 120000; // full board re-download while the live feed is connected (safety net)
  const BOARD_REFRESH = 30000;      // ... and while it is not
  const META_REFRESH = 20000;
  const NAME_REFRESH = 60000;

  // ---------- timers that keep their pace in a background tab ----------
  let tick = null;
  try {
    const w = new Worker(URL.createObjectURL(new Blob(
      ['onmessage=(e)=>setTimeout(()=>postMessage(e.data.id),e.data.ms)'], { type: 'text/javascript' })));
    const waiting = new Map(); let seq = 0;
    w.onmessage = (e) => { const f = waiting.get(e.data); if (f) { waiting.delete(e.data); f(); } };
    w.onerror = () => { tick = null; for (const f of waiting.values()) f(); waiting.clear(); };
    tick = (ms, f) => { const id = ++seq; waiting.set(id, f); w.postMessage({ id, ms }); };
  } catch { /* no worker: plain timers below */ }
  let wakeFn = null;
  // resolves after ms, or earlier when wake() is called (canvas opened, settings changed, …)
  const sleep = (ms, wakeable) => new Promise((res) => {
    let done = false;
    const fin = () => { if (!done) { done = true; if (wakeFn === fin) wakeFn = null; res(); } };
    if (tick) tick(ms, fin);
    setTimeout(fin, tick ? ms + 1500 : ms);   // also the fallback if the worker dies
    if (wakeable) wakeFn = fin;
  });
  const wake = () => { if (wakeFn) wakeFn(); };

  // ---------- state ----------
  let W = 0, H = 0, WHITE = 31;
  let board = null, boardAt = 0, meta = null, metaAt = 0, clock = 0;   // clock: server time − my time
  let myName = '', nameAt = 0, sessionPainted = 0;
  let netFails = 0, wantOn = false;   // failed requests in a row; is the bot switched on
  const WHO_GAP = 250;                // pause between "who painted this pixel" questions
  const DEFAULT_APPROVED = ['kgsx', 'ksgxl', 'kgsxs'];
  const serverNow = () => Date.now() + clock;
  const isOpen = (m) => !!m && !!m.open && (m.paused != null || m.openUntil > serverNow());
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const status = (s) => { try { chrome.storage.local.set({ status: { ...s, t: Date.now() } }).catch(() => {}); } catch { /* reloaded */ } };

  // ---------- lost connection: after a few failed requests in a row, refresh the page ----------
  // (if the page can't load at all, background.js reloads the tab once the site answers again)
  function lostConnection() {
    if (!wantOn || ++netFails < 4) return false;
    let last = 0;
    try { last = +sessionStorage.getItem('artbot-reload') || 0; } catch { /* storage blocked */ }
    if (Date.now() - last < 120000) return false;
    try { sessionStorage.setItem('artbot-reload', String(Date.now())); } catch { /* storage blocked */ }
    status({ state: 'error', msg: 'Lost connection to the site. Refreshing the page…' });
    liveStop();
    setTimeout(() => location.reload(), 300);
    return true;
  }

  // ---------- the pixel pool, counted the same way the site's own page does ----------
  // charges: pixels you have now (null = not asked yet); nextAt: when the next one arrives
  const pool = { charges: null, max: 10, period: 5000, nextAt: 0 };
  function syncPool(j) {
    if (!j) return;
    if (j.pool === true) {
      pool.charges = j.charges; pool.max = j.max || pool.max;
      if (j.periodMs) pool.period = j.periodMs;
      pool.nextAt = j.nextMs ? Date.now() + j.nextMs : 0;
    } else if (j.pool === false) {           // the site's older mode: one pixel, then a cooldown
      const wait = j.waitMs !== undefined ? j.waitMs : j.ok ? (j.cooldownMs || 5000) : 0;
      pool.max = 1; pool.period = j.cooldownMs || pool.period;
      pool.charges = wait > 0 ? 0 : 1; pool.nextAt = wait > 0 ? Date.now() + wait : 0;
    } else if (j.waitMs) {                   // no pool info, just "wait"
      pool.charges = 0; pool.nextAt = Date.now() + j.waitMs;
    }
  }
  // count the pixels that arrived since the last answer; ms until one is available (0 = paint now)
  function poolWait() {
    const t = Date.now();
    while (pool.charges < pool.max && pool.nextAt && t >= pool.nextAt) {
      pool.charges++;
      pool.nextAt = pool.charges < pool.max ? pool.nextAt + pool.period : 0;
    }
    if (pool.charges >= 1) return 0;
    return pool.nextAt ? Math.max(0, pool.nextAt - t) : DELAY;
  }
  async function loadPool(name) {
    try { syncPool(await (await fetch('/api/canvas/charges?name=' + encodeURIComponent(name), { cache: 'no-store' })).json()); }
    catch { /* the next paint answer tells us */ }
  }
  const poolText = () => (pool.charges === null ? '' : `Pixels: ${pool.charges}/${pool.max}`);

  // ---------- the site ----------
  async function getMeta() {
    const m = await (await fetch('/api/canvas/meta', { cache: 'no-store' })).json();
    if (typeof m.t === 'number') clock = m.t - Date.now();
    if (W && (m.w !== W || m.h !== H)) board = null;   // the canvas was resized
    W = m.w; H = m.h; WHITE = m.palette.length - 1;
    meta = m; metaAt = Date.now(); netFails = 0;
    return m;
  }
  async function loadBoard() {
    const b = new Uint8Array(await (await fetch('/api/canvas', { cache: 'no-store' })).arrayBuffer());
    if (b.length !== W * H) { await getMeta(); if (b.length !== W * H) throw new Error('board size mismatch'); }
    // a pixel that changed while we were not listening has an unknown painter again
    if (board && board.length === b.length) for (const k of [...owner.keys()]) if (board[k] !== b[k]) owner.delete(k);
    board = b; boardAt = Date.now(); netFails = 0;
  }
  async function getName() {
    if (myName && Date.now() - nameAt < NAME_REFRESH) return myName;
    let n = '';
    try {
      const me = await (await fetch('/api/me', { cache: 'no-store' })).json();
      if (me.login || me.dev) n = me.user ? me.user.name : '';
      else n = localStorage.getItem('mono-name') || '';
    } catch { try { n = localStorage.getItem('mono-name') || ''; } catch { /* storage blocked */ } }
    if (n !== myName) pool.charges = null;   // another account: ask for its pool
    if (n && n !== myName) { try { chrome.storage.local.set({ me: n }); } catch { /* reloaded */ } }   // the popup shows it
    myName = n; nameAt = Date.now();
    return n;
  }

  // ---------- the site's live feed: open/closed at once, and every painted pixel ----------
  let es = null, liveOk = false, esRetry = 0;
  function liveStart() {
    if (es || esRetry) return;
    try { es = new EventSource('/canvas/events'); } catch { return; }
    const mine = es;
    const json = (f) => (e) => { if (mine !== es) return; let d; try { d = JSON.parse(e.data); } catch { return; } f(d); };
    es.onopen = () => { liveOk = true; };
    es.onerror = () => {
      liveOk = false;
      if (mine.readyState === 2 && mine === es) {   // closed for good: open a new one in a bit
        es = null;
        esRetry = setTimeout(() => { esRetry = 0; if (alive()) liveStart(); }, 5000);
      }
    };
    es.addEventListener('px', json((b) => {
      if (!board || !Array.isArray(b)) return;
      for (let k = 0; k + 2 < b.length; k += 3) {
        const x = b[k], y = b[k + 1];
        if (x >= 0 && x < W && y >= 0 && y < H) { board[y * W + x] = b[k + 2]; owner.delete(y * W + x); dirty.add(y * W + x); }
      }
    }));
    es.addEventListener('status', json((s) => {
      if (!s || typeof s !== 'object') return;
      if (typeof s.t === 'number') clock = s.t - Date.now();
      const was = isOpen(meta);
      if (s.w && W && (s.w !== W || s.h !== H)) { metaAt = 0; board = null; }
      meta = { ...(meta || {}), ...s }; metaAt = Date.now();
      if (isOpen(meta) !== was) wake();
    }));
    es.addEventListener('reload', () => { boardAt = 0; wake(); });
    es.addEventListener('resize', () => { metaAt = 0; board = null; wake(); });
    es.addEventListener('ping', json((d) => { if (d && typeof d.t === 'number') clock = d.t - Date.now(); }));
  }
  function liveStop() {
    clearTimeout(esRetry); esRetry = 0; liveOk = false;
    if (es) { try { es.close(); } catch { /* already closed */ } es = null; }
  }

  // ---------- protected arts ----------
  // An art that was seen complete is saved (picture + spot) in the "guard" list. From then on any pixel of it
  // that turns wrong is griefing and gets repainted, also over other people's colours. In a team the pixel's
  // owner repairs at once; the others give them HELP_DELAY first, so the team doesn't spend several pixels on one.
  const artKey = (a, o) => { let h = 2166136261; for (const c of a.data) h = Math.imul(h ^ (c + 1), 16777619) >>> 0; return [o.x, o.y, a.w, a.h, h].join(','); };
  const overlaps = (g, art, o) => g.origin.x < o.x + art.w && o.x < g.origin.x + g.art.w && g.origin.y < o.y + art.h && o.y < g.origin.y + g.art.h;
  const NONE = new Set(), MAX_GUARD = 30;

  // ---------- which pixel next ----------
  // Every art pixel is: done (right colour already), blocked (someone else's colour, skipped while
  // "protect" is on) or still to paint. `order` picks among the ones still to paint.
  // Team: with N friends, the art's pixels are dealt out like cards (1st to member 1, 2nd to member 2, …), so
  // every share has the same number of pixels whatever the shape. Everyone paints their own share first, and
  // helps with another share only when its owner has stopped (offline or stuck); while all friends are painting,
  // everyone paints the same amount. An owner works from the front of their share (in the paint order) and
  // helpers from the back, so "the front pixel of a share has not moved for HELP_IDLE" means its owner stopped.
  // That is why a team should use the same paint order (it travels in the team code).
  // When they do help: the leftovers are put in one list and every
  // member starts at a different place in it (member 1 at the end, the others spread out before it), so
  // helpers don't pick the same pixel as each other or as the owner, who works from the start.
  function pickNext(art, origin, protect, placed, order, team, guard, ts) {
    let total = 0, done = 0, blocked = 0, next = null, best = Infinity, n = 0, mine = 0, retake = 0, right = 0;
    const bad = new Map();   // non-approved painters found in this art -> how many pixels
    const rest = [];   // pixels of other members' shares that are still to paint
    const size = team && team.size > 1 ? team.size : 1, slot = size > 1 ? Math.min(size, Math.max(1, team.slot || 1)) - 1 : 0;
    const cx = (art.w - 1) / 2, cy = (art.h - 1) / 2;
    const head = new Array(size).fill(null);   // per share: its first pixel still to paint
    let rank = -1, waiting = 0;
    if (size > 1 && order === 'random') order = 'rows';   // a team needs an order everyone agrees on
    for (let y = 0; y < art.h; y++) for (let x = 0; x < art.w; x++) {
      const c = art.data[y * art.w + x];
      if (c < 0) continue;
      const share = ++rank % size;   // whose pixel this is
      const bx = origin.x + x, by = origin.y + y;
      if (bx < 0 || by < 0 || bx >= W || by >= H) continue;
      total++;
      const i = by * W + bx, cur = board[i];
      // painted by someone who is not on the approved list: repaint it, even if the colour is right
      const who = approved && cur !== WHITE ? owner.get(i) : '';
      const foreign = !!who && !approved.has(who);
      if (cur === c) right++;   // right colour on the board, whoever painted it: this is the % everyone sees
      if (cur === c && !foreign) { done++; if (guard) wrongSince.delete(i); continue; }
      if (!foreign && protect && cur !== WHITE && !placed.has(i)) { blocked++; continue; }
      n++; if (foreign) { retake++; bad.set(who, (bad.get(who) || 0) + 1); }
      let score;
      if (order === 'random') score = Math.random();
      else if (order === 'center') score = (x - cx) ** 2 + (y - cy) ** 2;
      else if (order === 'outline') score = (c === 27 ? 0 : 1e6) + y * art.w + x;   // black lines first
      else score = y * art.w + x;                                                   // top to bottom
      if (!head[share] || score < head[share].score) head[share] = { score, i };
      if (guard && share !== slot) {   // a griefed pixel of a teammate's share: let them go first
        if (!wrongSince.has(i)) wrongSince.set(i, Date.now());
        if (Date.now() - wrongSince.get(i) < HELP_DELAY) continue;
      }
      if (share !== slot) { rest.push({ score, share, p: { x: bx, y: by, c, i, share } }); continue; }
      mine++;
      if (score < best) { best = score; next = { x: bx, y: by, c, i, share }; }
    }
    if (ts) {
      // a share whose front pixel moved since the last look has an active owner: leave it to them
      const now = Date.now();
      for (let s = 0; s < size; s++) {
        const h = head[s] ? head[s].i : -1;
        if (ts.head[s] !== undefined && ts.head[s] !== h) ts.seen[s] = now;
        ts.head[s] = h;
      }
      if (!next) {
        const free = rest.filter((r) => now - (ts.seen[r.share] || ts.t0) >= HELP_IDLE);
        waiting = rest.length - free.length;
        rest.length = 0; rest.push(...free);
      }
    }
    if (!next && rest.length) {
      rest.sort((a, b) => a.score - b.score);
      next = rest[rest.length - 1 - Math.floor(slot * rest.length / size)].p;
    }
    return { next, total, done, blocked, todo: n, mine, size, retake, waiting, right, bad };
  }
  const wrongSince = new Map(), HELP_DELAY = 8000, HELP_IDLE = 20000;
  let teamState = null;   // per share: finished pixels at the last look, and when it last grew
  // approved painters: null = feature off, else the lower-case names whose pixels are left alone
  let approved = null, watch = [];
  const owner = new Map(), dirty = new Set();   // board index -> who painted it ('' = nobody)
  // asks the site, one pixel at a time, who painted the pixels of your arts
  async function whoLoop() {
    for (;;) {
      if (!alive()) return;
      let i = -1;
      if (approved && board && isOpen(meta)) for (const k of watch) if (board[k] !== WHITE && !owner.has(k)) { i = k; break; }
      if (i < 0) { await sleep(1500); continue; }
      try {
        dirty.delete(i);
        const j = await (await fetch('/api/canvas/who?x=' + (i % W) + '&y=' + Math.floor(i / W), { cache: 'no-store' })).json();
        if (!dirty.has(i)) owner.set(i, String(j.name || '').toLowerCase());   // repainted meanwhile: ask again
        await sleep(WHO_GAP);
      } catch { await sleep(5000); }
    }
  }
  const footprint = (list, a, o) => {
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
      const bx = o.x + x, by = o.y + y;
      if (a.data[y * a.w + x] >= 0 && bx >= 0 && by >= 0 && bx < W && by < H) list.push(by * W + bx);
    }
  };
  const eta = (todo) => {
    const ms = Math.max(0, todo - (pool.charges || 0)) * pool.period;
    return ms < 60000 ? 'under a minute' : `about ${Math.ceil(ms / 60000)} min`;
  };

  // ---------- the loop ----------
  async function loop() {
    let fails = 0;
    for (;;) {
      if (!alive()) { liveStop(); return; }
      try {
        const cfg = await chrome.storage.local.get(['enabled', 'art', 'origin', 'protect', 'placed', 'order', 'team', 'guard', 'autoGuard', 'approved', 'approvedOn']);
        wantOn = !!cfg.enabled;
        if (!cfg.enabled || !cfg.art || !cfg.origin) {
          liveStop();
          status({ state: 'off', msg: cfg.enabled ? 'No art or spot set yet' : 'Bot is off' });
          await sleep(IDLE, true); continue;
        }
        liveStart();

        if (!meta || Date.now() - metaAt > META_REFRESH) await getMeta();
        if (!isOpen(meta)) {
          status({ state: 'waiting', msg: 'Canvas is closed. Waiting for it to open…', pool: poolText() });
          await sleep(IDLE, true); metaAt = liveOk ? metaAt : 0; continue;
        }

        if (!board || Date.now() - boardAt > (liveOk ? BOARD_REFRESH_LIVE : BOARD_REFRESH)) await loadBoard();
        const placed = new Set(cfg.placed || []);
        // protected arts first: repair what was painted over
        const guards = Array.isArray(cfg.guard) ? cfg.guard : [], curKey = artKey(cfg.art, cfg.origin);
        // approved painters: your own account plus the names in the popup
        if (cfg.approvedOn === false) { approved = null; watch = []; }
        else {
          const me = (await getName()).toLowerCase();
          approved = new Set((Array.isArray(cfg.approved) ? cfg.approved : DEFAULT_APPROVED).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
          if (me) approved.add(me);
          const list = [];
          footprint(list, cfg.art, cfg.origin);
          for (const g of guards) footprint(list, g.art, g.origin);
          watch = list;
        }
        const guarded = guards.some((g) => g.key === curKey);
        let repair = null, repairLeft = 0;
        for (const g of guards) {
          if (g.key === curKey || overlaps(g, cfg.art, cfg.origin)) continue;   // the current art handles its own spot
          const gp = pickNext(g.art, g.origin, false, NONE, 'rows', { size: g.size || 1, slot: (cfg.team && cfg.team.slot) || 1 }, true);
          repairLeft += gp.todo;
          if (!repair && gp.next) repair = gp.next;
        }
        const tsKey = curKey + '|' + JSON.stringify(cfg.team || 0) + '|' + cfg.order;
        if (!teamState || teamState.key !== tsKey) teamState = { key: tsKey, t0: Date.now(), head: [], seen: [] };
        const p = pickNext(cfg.art, cfg.origin, cfg.protect !== false && !guarded, placed, cfg.order, cfg.team, guarded, teamState);
        // "done" shown to you counts every pixel with the right colour, so all teammates see the same number
        const progress = { total: p.total, done: p.right, blocked: p.blocked, session: sessionPainted };
        if (p.size > 1) progress.team = p.mine ? `${p.mine} of your share left` : p.waiting && !p.next ? `Your share is done. Teammates are painting theirs (${p.todo} left); you step in if one stops for 20 s` : p.todo ? `Your share is done, helping a teammate who stopped (${p.todo} left)` : 'All done';
        const nGuard = guards.length;
        if (approved) {
          let unknown = 0; for (const k of watch) if (board[k] !== WHITE && !owner.has(k)) unknown++;
          progress.who = unknown ? `Checking who painted each pixel: ${unknown} left` : p.retake ? `Replacing ${p.retake} px painted by: ` + [...p.bad].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([nm, k]) => `${nm} (${k})`).join(', ') + '. If one of them is a teammate, add the name to the approved list.' : 'All pixels are by approved painters';
        }
        if (nGuard) progress.guard = `Protecting ${nGuard} finished art${nGuard > 1 ? 's' : ''}` + (repairLeft ? `, ${repairLeft} px to repair` : '');
        if (!p.total) { status({ state: 'error', msg: 'Your spot is outside the board. Change X/Y.' }); await sleep(IDLE, true); continue; }
        if (!p.next && !repair && !p.todo && !p.blocked && !guarded && cfg.autoGuard !== false) {
          // just seen complete: remember it so it gets repaired from now on
          const entry = { key: curKey, art: cfg.art, origin: cfg.origin, size: cfg.team && cfg.team.size > 1 ? cfg.team.size : 1, t: Date.now() };
          await chrome.storage.local.set({ guard: [...guards, entry].slice(-MAX_GUARD) });
          continue;
        }
        if (!p.next && !repair && p.waiting && !repairLeft) {
          status({ state: 'done', ...progress, pool: poolText(), msg: 'Your share is finished ✓ Waiting for teammates to finish theirs.' });
          await sleep(3000, true); continue;
        }
        if (!p.next && !repair && (p.todo || repairLeft)) {
          status({ state: 'painting', ...progress, pool: poolText(), msg: 'Someone painted over a protected art. Giving the teammate who owns that pixel a few seconds to repair it first…' });
          await sleep(3000, true); continue;
        }
        if (!p.next && !repair) {
          status({
            state: 'done', ...progress, pool: poolText(),
            msg: p.blocked ? `Finished what it can: ${p.blocked} px are covered by others (skipped)` : 'Art complete ✓ Watching and repairing if someone paints over it.',
          });
          await sleep(nGuard || approved ? 3000 : IDLE, true); continue;
        }

        const name = await getName();
        if (!name) { status({ state: 'error', msg: 'Log in with Kick on the site first, then this starts by itself.', ...progress }); await sleep(IDLE, true); continue; }

        // how many pixels do I have right now? paint at once if any, otherwise wait just until the next one
        if (pool.charges === null) await loadPool(name);
        if (pool.charges === null) pool.charges = 1;   // couldn't ask: try one, the server's answer sets the real count
        const wait = poolWait();
        if (wait > 0) {
          status({ state: 'painting', msg: `Out of pixels, next one in ${Math.ceil(wait / 1000)} s`, pool: poolText(), eta: eta(p.todo), ...progress });
          await sleep(wait + 120);
          continue;
        }

        const isRepair = !!repair;
        const { x, y, c, i } = repair || p.next;
        const was = board[i];
        const r = await fetch('/api/canvas/pixel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ x, y, c, name }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.status < 500) netFails = 0; else if (lostConnection()) return;
        if (j.ok) {
          fails = 0; sessionPainted++;
          if (board) board[i] = c;
          owner.set(i, name.toLowerCase());
          if (!isRepair) placed.add(i);
          pool.charges = Math.max(0, pool.charges - 1);   // spent one (the answer below corrects it)
          syncPool(j);
          await chrome.storage.local.set({ placed: [...placed] });
          status({ state: 'painting', msg: `${isRepair ? 'Repaired' : 'Painted'} (${x}, ${y})`, pool: poolText(), eta: eta(p.todo - (isRepair ? 0 : 1)), ...progress, done: p.right + (isRepair || was === c ? 0 : 1), session: sessionPainted });
          await sleep(GAP);
        } else if (j.waitMs) {
          syncPool(j);
          if (pool.charges > 0) { pool.charges = 0; pool.nextAt = Date.now() + j.waitMs; }
          status({ state: 'painting', msg: `Out of pixels, next one in ${Math.ceil(j.waitMs / 1000)} s`, pool: poolText(), eta: eta(p.todo), ...progress });
          await sleep(j.waitMs + 120);
        } else if (j.login) {
          myName = ''; nameAt = 0;
          status({ state: 'error', msg: 'The site wants you to log in with Kick.', ...progress }); await sleep(IDLE, true);
        } else {
          // closed in the meantime, a bad pixel, or the server is having a moment: look again, slower each time
          fails++; metaAt = 0; boardAt = 0; pool.charges = null;
          status({ state: 'error', msg: 'The site said: ' + (j.err || 'error ' + r.status) + '. Trying again…', ...progress });
          await sleep(Math.min(60000, DELAY * fails), true);
        }
      } catch (e) {
        if (!alive()) { liveStop(); return; }
        if (lostConnection()) return;
        fails++;
        console.warn('[artbot]', e);
        status({ state: 'error', msg: 'Error: ' + (e && e.message ? e.message : e) + '. Retrying…' });
        await sleep(Math.min(60000, 5000 * fails), true);
      }
    }
  }

  // start/stop and new settings take effect at once instead of at the next check
  try { chrome.storage.onChanged.addListener((ch) => { if (ch.enabled || ch.art || ch.origin || ch.protect || ch.order || ch.team || ch.guard || ch.autoGuard || ch.approved || ch.approvedOn) wake(); }); } catch { /* reloaded */ }

  // a tab waiting for the lock says so, instead of looking dead
  status({ state: 'waiting', msg: 'Bot loaded in a site tab, starting…' });
  const run = () => { whoLoop(); return loop(); };
  if (navigator.locks) navigator.locks.request('odedsvr-artbot', run);
  else run();
})();
