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
  const serverNow = () => Date.now() + clock;
  const isOpen = (m) => !!m && !!m.open && (m.paused != null || m.openUntil > serverNow());
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const status = (s) => { try { chrome.storage.local.set({ status: { ...s, t: Date.now() } }).catch(() => {}); } catch { /* reloaded */ } };

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
    meta = m; metaAt = Date.now();
    return m;
  }
  async function loadBoard() {
    const b = new Uint8Array(await (await fetch('/api/canvas', { cache: 'no-store' })).arrayBuffer());
    if (b.length !== W * H) { await getMeta(); if (b.length !== W * H) throw new Error('board size mismatch'); }
    board = b; boardAt = Date.now();
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
        if (x >= 0 && x < W && y >= 0 && y < H) board[y * W + x] = b[k + 2];
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

  // ---------- which pixel next ----------
  // Every art pixel is: done (right colour already), blocked (someone else's colour, skipped while
  // "protect" is on) or still to paint. `order` picks among the ones still to paint.
  // Team: with N friends, pixel (x, y) of the art belongs to member (x + y) % N. Everyone paints their own
  // share first. After that they help with whatever is left: the leftovers are put in one list and every
  // member starts at a different place in it (member 1 at the end, the others spread out before it), so
  // helpers don't pick the same pixel as each other or as the owner, who works from the start.
  function pickNext(art, origin, protect, placed, order, team) {
    let total = 0, done = 0, blocked = 0, next = null, best = Infinity, n = 0, mine = 0;
    const rest = [];   // pixels of other members' shares that are still to paint
    const size = team && team.size > 1 ? team.size : 1, slot = size > 1 ? Math.min(size, Math.max(1, team.slot || 1)) - 1 : 0;
    const cx = (art.w - 1) / 2, cy = (art.h - 1) / 2;
    for (let y = 0; y < art.h; y++) for (let x = 0; x < art.w; x++) {
      const c = art.data[y * art.w + x];
      if (c < 0) continue;
      const bx = origin.x + x, by = origin.y + y;
      if (bx < 0 || by < 0 || bx >= W || by >= H) continue;
      total++;
      const i = by * W + bx, cur = board[i];
      if (cur === c) { done++; continue; }
      if (protect && cur !== WHITE && !placed.has(i)) { blocked++; continue; }
      n++;
      let score;
      if (order === 'random') score = Math.random();
      else if (order === 'center') score = (x - cx) ** 2 + (y - cy) ** 2;
      else if (order === 'outline') score = (c === 27 ? 0 : 1e6) + y * art.w + x;   // black lines first
      else score = y * art.w + x;                                                   // top to bottom
      if ((x + y) % size !== slot) { rest.push({ score, p: { x: bx, y: by, c, i } }); continue; }
      mine++;
      if (score < best) { best = score; next = { x: bx, y: by, c, i }; }
    }
    if (!next && rest.length) {
      rest.sort((a, b) => a.score - b.score);
      next = rest[rest.length - 1 - Math.floor(slot * rest.length / size)].p;
    }
    return { next, total, done, blocked, todo: n, mine, size };
  }
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
        const cfg = await chrome.storage.local.get(['enabled', 'art', 'origin', 'protect', 'placed', 'order', 'team']);
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
        const p = pickNext(cfg.art, cfg.origin, cfg.protect !== false, placed, cfg.order, cfg.team);
        const progress = { total: p.total, done: p.done, blocked: p.blocked, session: sessionPainted };
        if (p.size > 1) progress.team = p.mine ? `${p.mine} of your share left` : p.todo ? `Your share is done, helping with the rest (${p.todo} left)` : 'All done';
        if (!p.total) { status({ state: 'error', msg: 'Your spot is outside the board. Change X/Y.' }); await sleep(IDLE, true); continue; }
        if (!p.next) {
          status({
            state: 'done', ...progress, pool: poolText(),
            msg: p.blocked ? `Finished what it can: ${p.blocked} px are covered by others (skipped)` : 'Art complete ✓ Watching and repairing if someone paints over it.',
          });
          await sleep(IDLE, true); continue;
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

        const { x, y, c, i } = p.next;
        const r = await fetch('/api/canvas/pixel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ x, y, c, name }),
        });
        const j = await r.json().catch(() => ({}));
        if (j.ok) {
          fails = 0; sessionPainted++;
          if (board) board[i] = c;
          placed.add(i);
          pool.charges = Math.max(0, pool.charges - 1);   // spent one (the answer below corrects it)
          syncPool(j);
          await chrome.storage.local.set({ placed: [...placed] });
          status({ state: 'painting', msg: `Painted (${x}, ${y})`, pool: poolText(), eta: eta(p.todo - 1), ...progress, done: p.done + 1, session: sessionPainted });
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
        fails++;
        console.warn('[artbot]', e);
        status({ state: 'error', msg: 'Error: ' + (e && e.message ? e.message : e) + '. Retrying…' });
        await sleep(Math.min(60000, 5000 * fails), true);
      }
    }
  }

  // start/stop and new settings take effect at once instead of at the next check
  try { chrome.storage.onChanged.addListener((ch) => { if (ch.enabled || ch.art || ch.origin || ch.protect || ch.order || ch.team) wake(); }); } catch { /* reloaded */ }

  // a tab waiting for the lock says so, instead of looking dead
  status({ state: 'waiting', msg: 'Bot loaded in a site tab, starting…' });
  if (navigator.locks) navigator.locks.request('odedsvr-artbot', () => loop());
  else loop();
})();
