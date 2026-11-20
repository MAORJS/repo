// Runs on every odedsvrmonopoly.app tab. Only one tab paints at a time (Web Lock).
// While the canvas is open it paints your art through the site's own API, logged in as you (same cookies as the page).
//  - Pixel pool: it keeps count of your pixels (up to 10, one more every 5 s), paints right away while you
//    have some, and waits only when the pool is empty.
//  - Live feed: it listens to the site's own event stream, so it knows the moment the canvas opens and
//    sees every pixel anyone paints without re-downloading the board.
//  - Background tabs: its timers run in a worker, so Chrome's background-tab throttling doesn't slow it down.
(() => {
  const DELAY = 5200;               // fallback wait when the server gives no timing
  const GAP = 80;                   // pause between pixels while the pool has some (the site's answer already paces it)
  const EDGE = 40;                  // wake this long after a new pixel is due, so the request isn't a hair early
  const IDLE = 10000;               // re-check this often while closed / off / finished (the live feed wakes it sooner)
  const BOARD_REFRESH_LIVE = 120000; // full board re-download while the live feed is connected (safety net)
  const BOARD_REFRESH = 30000;
  const BOARD_REFRESH_CLOSED = 300000;   // ... and while the canvas is closed (only read for scanning)      // ... and while it is not
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
  const WHO_GAP = 250, WHO_GAP_FAST = 110;                // pause between "who painted this pixel" questions
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
        if (!(x >= 0 && x < W && y >= 0 && y < H)) continue;
        const i = y * W + x, c = b[k + 2], m = minePx.get(i);
        board[i] = c;
        if (m && m.c === c && Date.now() - m.t < 3000) { minePx.delete(i); continue; }   // the echo of my own pixel: I know who painted it
        owner.delete(i); dirty.add(i);
        if (want.has(i)) {
          if (watchSet.has(i)) hot.push(i);      // ask who painted this one before the rest
          if (want.get(i) !== c) urgent = true;  // a pixel of an art we look after just went wrong
        }
      }
      if (urgent) { urgent = false; wake(); }   // repair at once instead of at the next look
      if (ovCfg) renderOverlay(ovCfg);
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
  // Team: with N friends, the art is cut into N equal solid blocks (top to bottom), one per friend. Everyone
  // paints their own block first, in the paint order. A friend whose block is finished helps at once with the
  // block that has the most left: the owner works from the front of the order, helpers from the back (each
  // helper a different pixel), so they meet in the middle instead of painting the same pixels.
  // Paint order 'inward' (the default): the outline of the picture first, then ring by ring towards the inside,
  // each ring traced around like a person would draw it.
  function pickNext(art, origin, protect, placed, order, team, guard, ts) {
    let total = 0, done = 0, blocked = 0, next = null, best = Infinity, n = 0, mine = 0, retake = 0, right = 0, other = 0;
    const bad = new Map();   // non-approved painters found in this art -> how many pixels
    const rest = [];   // pixels of other members' shares that are still to paint
    const size = team && team.size > 1 ? team.size : 1, slot = size > 1 ? Math.min(size, Math.max(1, team.slot || 1)) - 1 : 0;
    const cx = (art.w - 1) / 2, cy = (art.h - 1) / 2;
    const at = (x, y) => (x < 0 || y < 0 || x >= art.w || y >= art.h ? -1 : art.data[y * art.w + x]);
    const edge = (x, y, c) => at(x - 1, y) !== c || at(x + 1, y) !== c || at(x, y - 1) !== c || at(x, y + 1) !== c;
    // 'inward': how many pixels each pixel is from the outside of the picture (0 = the outline), then the angle
    // around the middle, so a ring is drawn as one line going round
    let inw = null;
    if (order === 'inward') {
      const memo = pickNext.inw || (pickNext.inw = new WeakMap());
      inw = memo.get(art);
      if (!inw) {
        const w = art.w, h = art.h, d = new Int32Array(w * h).fill(-1); let q = [];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (at(x, y) >= 0 && (at(x - 1, y) < 0 || at(x + 1, y) < 0 || at(x, y - 1) < 0 || at(x, y + 1) < 0)) { d[y * w + x] = 0; q.push(y * w + x); }
        for (let layer = 1; q.length; layer++) {
          const nq = [];
          for (const k of q) { const x = k % w, y = (k - x) / w; for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) { const j = ny * w + nx; if (at(nx, ny) >= 0 && d[j] < 0) { d[j] = layer; nq.push(j); } } }
          q = nq;
        }
        inw = new Float64Array(w * h);
        for (let k = 0; k < w * h; k++) { const x = k % w, y = (k - x) / w; inw[k] = d[k] * 10 + (Math.atan2(x - cx, cy - y) + Math.PI) / (2 * Math.PI + 1e-9); }   // starts at the top, goes round
        memo.set(art, inw);
      }
    }
    const per = new Array(size).fill(0);       // per share: pixels still to paint
    const head = new Array(size).fill(null);   // per share: its first pixel still to paint
    let rank = -1, waiting = 0;
    // Shares are solid blocks: the art's pixels, top to bottom, are cut into `size` equal runs, so each friend
    // fills one band of the picture the way a person would, instead of every N-th pixel (which left stripes).
    const cnt = pickNext.cnt || (pickNext.cnt = new WeakMap());
    let count = size > 1 ? cnt.get(art) : 0;
    if (size > 1 && count === undefined) { count = 0; for (const c of art.data) if (c >= 0) count++; cnt.set(art, count); }
    if (size > 1 && order === 'random') order = 'rows';   // a team needs an order everyone agrees on
    for (let y = 0; y < art.h; y++) for (let x = 0; x < art.w; x++) {
      const c = art.data[y * art.w + x];
      if (c < 0) continue;
      const share = size > 1 ? Math.min(size - 1, Math.floor(++rank * size / count)) : 0;   // whose pixel this is
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
      // jobs: every pixel that needs paint is one kind of work, and a member with a job does only that kind
      // (in your own art a wrong colour that is not empty is also the defender's: it was painted over, whenever that happened)
      const job = foreign ? 'replace' : guard === true ? 'defend' : 'draw';
      const also = !foreign && (guard === 'own' || (!guard && cur !== WHITE)) ? 'defend' : '';
      // a protector only looks after finished things: the protected list, and your own art once it was finished
      if (role !== 'all' && role !== job && role !== also && !(role === 'protect' && guard && !foreign)) { other++; continue; }
      n++; per[share]++; if (foreign) { retake++; bad.set(who, (bad.get(who) || 0) + 1); }
      let score;
      if (order === 'random') score = Math.random();
      else if (inw) score = inw[y * art.w + x];
      else if (order === 'center') score = (x - cx) ** 2 + (y - cy) ** 2;
      else if (order === 'outline') score = (c === 27 ? 0 : edge(x, y, c) ? 1e6 : 2e6) + y * art.w + x;   // black lines, then every edge, then the fill
      else score = y * art.w + x;                                                   // top to bottom
      if (!head[share] || score < head[share].score) head[share] = { score, i };
      if (guard && share !== slot) {   // a griefed pixel of a teammate's share: let them go first
        if (!wrongSince.has(i)) wrongSince.set(i, Date.now());
        if (Date.now() - wrongSince.get(i) < (quick() ? DEFEND_DELAY : HELP_DELAY)) continue;
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
    }
    if (!next && rest.length) {
      // your own block is finished: help at once with the block that has the most left, from the back of the
      // paint order (the owner comes from the front), each helper a different pixel
      let big = rest[0].share; for (const r of rest) if (per[r.share] > per[big]) big = r.share;
      let list = rest.filter((r) => r.share === big).sort((a, b) => a.score - b.score);
      if (list.length <= slot) list = rest.sort((a, b) => a.share - b.share || a.score - b.score);   // few left there: spread the helpers over everything left
      next = list[list.length - 1 - (slot % list.length)].p;
    }
    return { next, total, done, blocked, todo: n, mine, size, retake, waiting, right, bad, other, per };
  }
  const wrongSince = new Map(), HELP_DELAY = 8000, DEFEND_DELAY = 1500, HELP_IDLE = 20000;
  // your job: 'all' (default), 'draw' (only paint the art), 'replace' (only repaint pixels by painters who are
  // not approved), 'defend' (only repair protected arts that were painted over)
  let role = 'all';
  const JOBS = { draw: 'Drawing only', replace: 'Replacing non-approved painters only', defend: 'Defending only', protect: 'Protecting finished arts only' };
  const quick = () => role === 'defend' || role === 'protect';
  let teamState = null;   // per share: finished pixels at the last look, and when it last grew
  // approved painters: null = feature off, else the lower-case names whose pixels are left alone
  let approved = null, watch = [];
  // want: board index -> the colour it should have (your art + everything protected); watchSet: the ones whose painter matters
  let want = new Map(), watchSet = new Set(), watchAll = [], urgent = false;
  const wantSrc = { heavy: null, o: '' }, hot = [], asking = new Set(), minePx = new Map();
  const owner = new Map(), dirty = new Set();   // board index -> who painted it ('' = nobody)
  // asks the site, one pixel at a time, who painted the pixels of your arts
  // Pixels that just changed are asked first (that is where a griefer is). The second asker (id 1) only works
  // for a replacer, whose whole job this is; it also asks faster.
  async function whoLoop(id) {
    for (;;) {
      if (!alive()) return;
      let i = -1;
      if (approved && board && wantOn && (id === 0 || role === 'replace')) {
        const ok = (k) => board[k] !== WHITE && !owner.has(k) && !asking.has(k);
        while (hot.length && i < 0) { const k = hot.pop(); if (watchSet.has(k) && ok(k)) i = k; }
        if (i < 0) for (const k of watch) if (board[k] !== want.get(k) && ok(k)) { i = k; break; }
        if (i < 0) for (const k of watch) if (ok(k)) { i = k; break; }
      }
      if (i < 0) { await sleep(id ? 1000 : 400); continue; }
      asking.add(i);
      try {
        dirty.delete(i);
        const j = await (await fetch('/api/canvas/who?x=' + (i % W) + '&y=' + Math.floor(i / W), { cache: 'no-store' })).json();
        asking.delete(i);
        if (!dirty.has(i)) {   // (repainted meanwhile: ask again)
          const nm = String(j.name || '').toLowerCase();
          owner.set(i, nm);
          if (nm && approved && !approved.has(nm)) wake();   // found one to replace: do it now
        }
        await sleep(role === 'replace' ? WHO_GAP_FAST : WHO_GAP);
      } catch { asking.delete(i); await sleep(5000); }
    }
  }
  const footprint = (list, a, o) => {
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
      const bx = o.x + x, by = o.y + y;
      if (a.data[y * a.w + x] >= 0 && bx >= 0 && by >= 0 && bx < W && by < H) list.push(by * W + bx);
    }
  };
  const left = (p) => (p.size > 1 && p.mine ? p.mine : p.todo);   // in a team, your own share is what you wait for
  const eta = (todo) => {
    const ms = Math.max(0, todo - (pool.charges || 0)) * pool.period;
    if (ms < 60000) return 'under a minute';
    const m = Math.ceil(ms / 60000);
    return m < 60 ? `about ${m} min` : `about ${Math.floor(m / 60)} h ${m % 60} min`;
  };

  // ---------- on-page preview overlay (visual only; nothing is ever sent anywhere) ----------
  // A small draggable panel inside the site tab showing the art at your spot, the same picture as the popup's:
  // full colour = already done, faded = still to paint, red = a pixel that will be replaced. Guarded so it does
  // nothing when there is no page (the test harness), so it never touches painting.
  let ovCfg = null, ovEl = null, ovAt = 0;
  function overlayStates(art, origin, placed) {
    const st = new Uint8Array(art.w * art.h);
    for (let y = 0; y < art.h; y++) for (let x = 0; x < art.w; x++) {
      const k = y * art.w + x, c = art.data[k];
      if (c < 0) { st[k] = 0; continue; }
      const bx = origin.x + x, by = origin.y + y;
      if (!board || bx < 0 || by < 0 || bx >= W || by >= H) { st[k] = 2; continue; }   // no board yet: show as to-paint
      const i = by * W + bx, cur = board[i];
      const who = approved && cur !== WHITE ? owner.get(i) : '';
      const foreign = !!who && !approved.has(who);
      if (cur === c && !foreign) st[k] = 1;                                 // done
      else if (foreign) st[k] = 3;                                         // will be replaced
      else if (cur !== WHITE && !placed.has(i)) st[k] = approved ? 2 : 3;  // someone else's colour
      else st[k] = 2;                                                      // to paint
    }
    return st;
  }
  function buildOverlay() {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;top:12px;left:64px;right:auto;z-index:2147483647;direction:ltr;background:#17112aee;color:#eee;font:12px system-ui,sans-serif;border:1px solid #3a3157;border-radius:8px;padding:6px;box-shadow:0 6px 20px #0008;user-select:none;cursor:grab';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;gap:10px;margin-bottom:4px;align-items:center';
    const title = document.createElement('span'); title.textContent = '🎨';
    const close = document.createElement('span'); close.textContent = '✕'; close.style.cssText = 'cursor:pointer;opacity:.7;padding:0 2px';
    close.onclick = (e) => { e.stopPropagation(); try { chrome.storage.local.set({ overlay: false }); } catch { /* reloaded */ } };
    row.appendChild(title); row.appendChild(close);
    const cv = document.createElement('canvas');
    cv.style.cssText = 'image-rendering:pixelated;display:block;border-radius:4px;background:repeating-conic-gradient(#ccc 0 25%,#fff 0 50%) 0 0/8px 8px';
    box.appendChild(row); box.appendChild(cv);
    let dx = 0, dy = 0, down = false;
    box.addEventListener('pointerdown', (e) => { if (e.target === close) return; down = true; dx = e.clientX - box.offsetLeft; dy = e.clientY - box.offsetTop; box.style.cursor = 'grabbing'; try { box.setPointerCapture(e.pointerId); } catch { /* ok */ } });
    box.addEventListener('pointermove', (e) => { if (!down) return; box.style.left = (e.clientX - dx) + 'px'; box.style.top = (e.clientY - dy) + 'px'; box.style.right = 'auto'; });
    box.addEventListener('pointerup', (e) => { down = false; box.style.cursor = 'grab'; try { box.releasePointerCapture(e.pointerId); } catch { /* ok */ } });
    (document.body || document.documentElement).appendChild(box);
    box.__cv = cv; box.__title = title;
    return box;
  }
  function renderOverlay(cfg) {
    if (typeof document === 'undefined' || !(document.body || document.documentElement)) return;
    const on = cfg && cfg.overlay !== false && cfg.art && cfg.origin;
    if (!on) { if (ovEl) { ovEl.remove(); ovEl = null; } return; }
    if (ovEl && Date.now() - ovAt < 350) return;   // throttle redraws
    ovAt = Date.now();
    try {
      const art = cfg.art, origin = cfg.origin;
      if (!ovEl) ovEl = buildOverlay();
      const cv = ovEl.__cv, pal = (meta && meta.palette) || [];
      const st = overlayStates(art, origin, new Set(cfg.placed || []));
      const rgb = (h) => { const n = parseInt((h || '#ffffff').slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
      const scale = Math.max(1, Math.min(8, Math.floor(Math.min(220 / art.w, 160 / art.h)) || 1));
      cv.width = art.w; cv.height = art.h;
      cv.style.width = art.w * scale + 'px'; cv.style.height = art.h * scale + 'px';
      const ctx = cv.getContext('2d'), img = ctx.createImageData(art.w, art.h);
      let done = 0, total = 0;
      art.data.forEach((c, k) => {
        if (c < 0) return; total++;
        if (st[k] === 1) done++;
        if (st[k] === 3) return img.data.set([255, 40, 60, 255], k * 4);
        const [r, g, b] = rgb(pal[c]);
        img.data.set([r, g, b, st[k] === 1 ? 255 : 90], k * 4);
      });
      ctx.putImageData(img, 0, 0);
      ovEl.__title.textContent = `🎨 (${origin.x}, ${origin.y}) · ${done}/${total}` + (isOpen(meta) ? '' : ' · closed');
    } catch { /* the page is in a strange state: skip this frame */ }
  }

  // ---------- the loop ----------
  // The art and the protected areas can be megabytes; reading them from storage for every pixel made everything
  // slow. They are kept here and re-read only when they change (plus a slow safety re-read).
  let orderMoved = false;   // the saved paint order was switched once to the new default (outline to inside)
  let heavy = null, heavyAt = 0, heavyDirty = true, lastRepair = false, wasClosed = false;
  const HEAVY_REFRESH = 15000;
  const keyMemo = { art: null, x: 0, y: 0, key: '' };
  const keyOf = (a, o) => {
    if (keyMemo.art !== a || keyMemo.x !== o.x || keyMemo.y !== o.y) { keyMemo.art = a; keyMemo.x = o.x; keyMemo.y = o.y; keyMemo.key = artKey(a, o); }
    return keyMemo.key;
  };
  async function loop() {
    let fails = 0;
    for (;;) {
      if (!alive()) { liveStop(); return; }
      try {
        const cfg = await chrome.storage.local.get(['enabled', 'origin', 'protect', 'placed', 'order', 'team', 'autoGuard', 'approved', 'approvedOn', 'night', 'nightStats', 'overlay', 'role']);
        role = JOBS[cfg.role] ? cfg.role : 'all';
        if (!orderMoved) { orderMoved = true; const o = await chrome.storage.local.get('orderV2'); if (!o.orderV2) { cfg.order = 'inward'; await chrome.storage.local.set({ order: 'inward', orderV2: 1 }); } }
        if (!heavy || heavyDirty || Date.now() - heavyAt > HEAVY_REFRESH) {
          heavyDirty = false;
          heavy = await chrome.storage.local.get(['art', 'guard']); heavyAt = Date.now();
        }
        if (heavy.art) cfg.art = heavy.art;
        if (heavy.guard) cfg.guard = heavy.guard;
        wantOn = !!cfg.enabled; ovCfg = cfg; renderOverlay(cfg);
        const hasArt = !!(cfg.art && cfg.origin), hasGuard = Array.isArray(cfg.guard) && cfg.guard.length > 0;
        if (!cfg.enabled || (!hasArt && !hasGuard)) {
          liveStop();
          status({ state: 'off', msg: cfg.enabled ? 'No art or spot set yet' : 'Bot is off' });
          await sleep(IDLE, true); continue;
        }
        if (!hasArt) { cfg.art = { w: 1, h: 1, data: [-1] }; cfg.origin = { x: 0, y: 0 }; ovCfg = null; }   // nothing of your own to paint: only protect
        liveStart();

        if (!meta || Date.now() - metaAt > META_REFRESH) await getMeta();
        // While the canvas is closed, a replacer (and "everything" with approved painters on) already finds out who
        // painted each pixel, so the moment it opens it knows what to replace. The other jobs just wait.
        const closed = !isOpen(meta), scan = role === 'replace' || (role === 'all' && cfg.approvedOn !== false);
        if (closed && !scan) {
          wasClosed = true;
          status({ state: 'waiting', msg: 'Canvas is closed. Waiting for it to open…', pool: poolText() });
          await sleep(IDLE, true); metaAt = liveOk ? metaAt : 0; continue;
        }
        if (!closed && wasClosed) { wasClosed = false; boardAt = 0; }   // it just opened: start from a fresh board

        if (!board || Date.now() - boardAt > (closed ? BOARD_REFRESH_CLOSED : liveOk ? BOARD_REFRESH_LIVE : BOARD_REFRESH)) await loadBoard();
        const placed = new Set(cfg.placed || []);
        // protected arts first: repair what was painted over
        const guards = Array.isArray(cfg.guard) ? cfg.guard : [], curKey = keyOf(cfg.art, cfg.origin);
        // approved painters: your own account plus the names in the popup
        // drawers and defenders don't need to know who painted what; a replacer always does
        if (role === 'draw' || quick() || (cfg.approvedOn === false && role !== 'replace')) { approved = null; watch = []; }
        else {
          const me = (await getName()).toLowerCase();
          approved = new Set((Array.isArray(cfg.approved) ? cfg.approved : DEFAULT_APPROVED).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
          if (me) approved.add(me);
        }
        const wk = [cfg.origin.x, cfg.origin.y, W, H, hasArt].join(',');
        if (wantSrc.heavy !== heavy || wantSrc.o !== wk) {
          wantSrc.heavy = heavy; wantSrc.o = wk;
          const list = [], w2 = new Map();
          const add = (a, o) => { for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) { const c = a.data[y * a.w + x], bx = o.x + x, by = o.y + y; if (c >= 0 && bx >= 0 && by >= 0 && bx < W && by < H) w2.set(by * W + bx, c); } };
          footprint(list, cfg.art, cfg.origin);   // your own art is asked about first
          for (const g of guards) { add(g.art, g.origin); if (!g.snap) footprint(list, g.art, g.origin); }
          add(cfg.art, cfg.origin);
          want = w2; watchAll = list; watchSet = new Set(list);
        }
        watch = approved ? watchAll : [];
        if (closed) {
          wasClosed = true;
          let unknown = 0, bad = 0;
          for (const k of watch) if (board[k] !== WHITE) { const o = owner.get(k); if (o === undefined) unknown++; else if (o && !approved.has(o)) bad++; }
          status({ state: 'waiting', msg: 'Canvas is closed. Waiting for it to open…', pool: poolText(), who: unknown ? `Scanning who painted each pixel while it is closed: ${unknown} left` + (bad ? `, ${bad} to replace so far` : '') : `Scan finished: ${bad} px to replace when it opens` });
          await sleep(unknown ? 3000 : IDLE, true); metaAt = liveOk ? metaAt : 0; continue;
        }
        const guarded = guards.some((g) => g.key === curKey);
        let repair = null, repairLeft = 0, otherJobs = 0;
        for (const g of guards) {
          if (g.key === curKey || overlaps(g, cfg.art, cfg.origin)) continue;   // the current art handles its own spot
          const keepApproved = approved; if (g.snap) approved = null;   // a selected area keeps whoever painted it
          const gp = pickNext(g.art, g.origin, false, NONE, 'outline', { size: g.size || 1, slot: (cfg.team && cfg.team.slot) || 1 }, true);
          approved = keepApproved;
          repairLeft += gp.todo; otherJobs += gp.other;
          if (!repair && gp.next) repair = gp.next;
        }
        const tsKey = curKey + '|' + JSON.stringify(cfg.team || 0) + '|' + cfg.order;
        if (!teamState || teamState.key !== tsKey) teamState = { key: tsKey, t0: Date.now(), head: [], seen: [] };
        const p = pickNext(cfg.art, cfg.origin, cfg.protect !== false && !guarded && role !== 'defend', placed, cfg.order || 'inward', cfg.team, guarded ? 'own' : false, teamState);
        otherJobs += p.other;
        // "done" shown to you counts every pixel with the right colour, so all teammates see the same number
        const progress = { total: p.total, done: p.right, blocked: p.blocked, session: sessionPainted };
        if (p.size > 1) progress.team = p.mine ? `${p.mine} of your share left` : p.waiting && !p.next ? `Your share is done (${p.todo} left for teammates)` : p.todo ? `Your share is done, helping the friend with the most left (${p.todo} left in all)` : 'All done';
        if (p.size > 1 && (role === 'all' || role === 'draw')) {   // who in the team is painting, and how much each has left
          const now = Date.now(), my = Math.min(p.size, Math.max(1, (cfg.team && cfg.team.slot) || 1)) - 1;
          progress.shares = p.per.map((k, s) => '#' + (s + 1) + (s === my ? ' (you)' : '') + ': ' + (!k ? 'done' : s === my || now - (teamState.seen[s] || teamState.t0) < HELP_IDLE ? k + ' left' : k + ' left, not painting')).join(' · ');
        }
        const nGuard = guards.length;
        if (role !== 'all') progress.job = JOBS[role] + (otherJobs ? ' · ' + otherJobs + ' px left for the other jobs' : '');
        if (approved) {
          let unknown = 0; for (const k of watch) if (board[k] !== WHITE && !owner.has(k)) unknown++;
          progress.who = (unknown ? `Checking who painted each pixel: ${unknown} left` : p.retake ? `Replacing ${p.retake} px painted by: ` + [...p.bad].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([nm, k]) => `${nm} (${k})`).join(', ') + '. Add a name to the approved list to keep its pixels.' : 'All pixels are by approved painters');
        }
        if (nGuard) progress.guard = `Protecting ${nGuard} finished art${nGuard > 1 ? 's' : ''}` + (repairLeft ? `, ${repairLeft} px to repair` : '');
        if (!p.total && hasArt) { status({ state: 'error', msg: 'Your spot is outside the board. Change X/Y.' }); await sleep(IDLE, true); continue; }
        if (!p.next && !repair && !p.todo && !p.other && !p.blocked && !guarded && hasArt && cfg.autoGuard !== false) {
          // just seen complete: remember it so it gets repaired from now on
          const entry = { key: curKey, art: cfg.art, origin: cfg.origin, size: cfg.team && cfg.team.size > 1 ? cfg.team.size : 1, t: Date.now() };
          await chrome.storage.local.set({ guard: [...guards, entry].slice(-MAX_GUARD) });
          heavyDirty = true;
          continue;
        }
        if (!p.next && !repair && p.waiting && !repairLeft) {
          status({ state: 'done', ...progress, pool: poolText(), msg: 'Your share is finished ✓ Waiting for teammates to finish theirs.' });
          await sleep(3000, true); continue;
        }
        if (!p.next && !repair && (p.todo || repairLeft)) {
          status({ state: 'painting', ...progress, pool: poolText(), msg: 'Someone painted over a protected art. Giving the teammate who owns that pixel a few seconds to repair it first…' });
          await sleep(quick() ? 500 : 3000, true); continue;
        }
        if (!p.next && !repair) {
          status({
            state: 'done', ...progress, pool: poolText(),
            msg: role !== 'all' && otherJobs ? 'Nothing for your job right now ✓ Watching.' : p.blocked ? `Finished what it can: ${p.blocked} px are covered by others (skipped)` : !hasArt ? `Protecting ${nGuard} area${nGuard > 1 ? 's' : ''} ✓ Watching and repairing if someone paints over.` : 'Art complete ✓ Watching and repairing if someone paints over it.',
          });
          await sleep(nGuard || approved || role !== 'all' ? 3000 : IDLE, true); continue;
        }

        const name = await getName();
        if (!name) { status({ state: 'error', msg: 'Log in with Kick on the site first, then this starts by itself.', ...progress }); await sleep(IDLE, true); continue; }

        // how many pixels do I have right now? paint at once if any, otherwise wait just until the next one
        if (pool.charges === null) await loadPool(name);
        if (pool.charges === null) pool.charges = 1;   // couldn't ask: try one, the server's answer sets the real count
        const wait = poolWait();
        if (wait > 0) {
          status({ state: 'painting', msg: `Out of pixels, next one in ${Math.ceil(wait / 1000)} s`, pool: poolText(), eta: eta(left(p)), ...progress });
          await sleep(wait + EDGE);
          continue;
        }

        // your own art still has pixels to paint: repairs get every second pixel at most, so a protected area
        // that keeps being painted over can't stop your art
        if (repair && p.next && lastRepair) repair = null;
        const isRepair = !!repair;
        const { x, y, c, i } = repair || p.next;
        const was = board[i];
        // someone (a teammate, or you by hand) painted it right while we were getting ready: don't spend a pixel on it
        const stillForeign = !!approved && !!owner.get(i) && !approved.has(owner.get(i));
        if (was === c && !stillForeign) continue;
        const r = await fetch('/api/canvas/pixel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ x, y, c, name }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.status < 500) netFails = 0; else if (lostConnection()) return;
        if (j.ok) {
          fails = 0; sessionPainted++; lastRepair = isRepair;
          if (board) board[i] = c;
          owner.set(i, name.toLowerCase()); minePx.set(i, { c, t: Date.now() });
          if (minePx.size > 500) minePx.clear();
          if (!isRepair) placed.add(i);
          pool.charges = Math.max(0, pool.charges - 1);   // spent one (the answer below corrects it)
          syncPool(j);
          const save = { placed: [...placed] };
          if (cfg.night) {   // the night report: what was done while you slept
            const st = { painted: 0, repaired: 0, replaced: 0, ...(cfg.nightStats || {}) };
            if (was === c) st.replaced++; else if (isRepair || guarded) st.repaired++; else st.painted++;
            save.nightStats = st;
          }
          await chrome.storage.local.set(save);
          if (ovCfg) renderOverlay(ovCfg);
          status({ state: 'painting', msg: `${isRepair ? 'Repaired' : 'Painted'} (${x}, ${y})`, pool: poolText(), eta: eta(left(p) - (isRepair ? 0 : 1)), ...progress, done: p.right + (isRepair || was === c ? 0 : 1), session: sessionPainted });
          await sleep(GAP);
        } else if (j.waitMs) {
          syncPool(j);
          if (pool.charges > 0) { pool.charges = 0; pool.nextAt = Date.now() + j.waitMs; }
          status({ state: 'painting', msg: `Out of pixels, next one in ${Math.ceil(j.waitMs / 1000)} s`, pool: poolText(), eta: eta(left(p)), ...progress });
          await sleep(j.waitMs + EDGE);
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
  try { chrome.storage.onChanged.addListener((ch) => { if (ch.art || ch.guard) heavyDirty = true; if (ch.enabled || ch.art || ch.origin || ch.protect || ch.order || ch.team || ch.guard || ch.autoGuard || ch.approved || ch.approvedOn || ch.overlay || ch.role) wake(); }); } catch { /* reloaded */ }

  // ========= board-aligned ghost: draws the art straight onto the site's board, glued to its pan and zoom =========
  // The board is rendered 1:1 into a <canvas id="cv"> (canvas pixel = board pixel) and panned/zoomed with a CSS
  // transform on that canvas. We lay our own canvas over it, copy that transform live, and draw the art at its
  // board coordinates. It reads the board's own pixels to tell done from to-paint, so it works in any tab and
  // needs neither the paint lock nor the bot to be running. Visual only; it has pointer-events:none and paints nothing.
  function boardGhost() {
    if (typeof document === 'undefined') return;   // the test harness has no page
    let ov = null, view = null, raf = 0, cv = null, timer = 0, loadHook = false, pal = null, palAt = 0, cfg = null;
    let until = 0, mo = null, last = {}, ticks = 0, redraw = true;
    const hex = (h) => { const n = parseInt((h || '#ffffff').slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    async function palette() {
      if (pal && Date.now() - palAt < 60000) return pal;
      try { const m = await (await fetch('/api/canvas/meta', { cache: 'no-store' })).json(); if (m && m.palette) { pal = m.palette; palAt = Date.now(); } } catch { /* keep the old one */ }
      return pal;
    }
    function findCv() {
      let c = document.getElementById('cv'); if (c) return c;
      for (const f of document.querySelectorAll('iframe')) { try { const d = f.contentDocument, x = d && d.getElementById('cv'); if (x) return x; } catch { /* cross-origin */ } }
      return null;
    }
    function detach() { if (mo) { try { mo.disconnect(); } catch { /* ok */ } mo = null; } last = {}; if (view && raf) { try { view.cancelAnimationFrame(raf); } catch { /* ok */ } } raf = 0; if (ov) { try { ov.remove(); } catch { /* gone */ } ov = null; } cv = null; view = null; }
    // Keep the ghost glued to the board, in the iframe's OWN animation frame. Copy the COMPUTED transform and
    // transform-origin: that is exactly what the board is rendered with, including the pan/zoom, so the overlay
    // lines up to the pixel. This runs only while the board is moving (kick() is called when its style changes)
    // and for a moment after, so a board that stands still costs nothing.
    const put = (k, v) => { if (last[k] !== v) { last[k] = v; ov.style[k] = v; } };
    function frame() {
      raf = 0;
      if (!ov || !cv || !cv.isConnected || ov.ownerDocument !== cv.ownerDocument) { detach(); return; }
      if (ov.width !== cv.width || ov.height !== cv.height) { ov.width = cv.width; ov.height = cv.height; draw(); }   // board resized (also clears ov)
      const cs = view.getComputedStyle(cv);
      put('transform', cs.transform === 'none' ? '' : cs.transform);
      put('transformOrigin', cs.transformOrigin);
      put('left', cv.offsetLeft + 'px'); put('top', cv.offsetTop + 'px');
      put('width', cv.offsetWidth + 'px'); put('height', cv.offsetHeight + 'px');
      if (Date.now() < until) raf = view.requestAnimationFrame(frame);
    }
    function kick(ms) {
      until = Math.max(until, Date.now() + ms);
      if (!raf && view && ov) raf = view.requestAnimationFrame(frame);
    }
    async function draw() {
      if (!ov || !cv || !cv.isConnected) return;
      const octx = ov.getContext('2d');
      if (!cfg || !cfg.art || !cfg.origin) { octx.clearRect(0, 0, ov.width, ov.height); return; }
      const p = await palette(); if (!p) return;
      const art = cfg.art, o = cfg.origin;
      octx.clearRect(0, 0, ov.width, ov.height);
      const fits = o.x >= 0 && o.y >= 0 && o.x + art.w <= ov.width && o.y + art.h <= ov.height;
      let bd = null;
      if (fits) { try { bd = cv.getContext('2d').getImageData(o.x, o.y, art.w, art.h).data; } catch { /* unreadable */ } }
      const im = octx.createImageData(art.w, art.h);
      for (let k = 0; k < art.w * art.h; k++) {
        const c = art.data[k]; if (c < 0) continue;
        const x = k % art.w, y = (k / art.w) | 0;
        if (o.x + x < 0 || o.y + y < 0 || o.x + x >= ov.width || o.y + y >= ov.height) continue;
        const [r, g, b] = hex(p[c]), j = k * 4;
        if (bd && Math.abs(bd[j] - r) < 10 && Math.abs(bd[j + 1] - g) < 10 && Math.abs(bd[j + 2] - b) < 10) continue;   // already right: let the board show
        im.data[j] = r; im.data[j + 1] = g; im.data[j + 2] = b; im.data[j + 3] = 150;   // ~60% ghost
      }
      octx.putImageData(im, o.x, o.y);
      octx.strokeStyle = 'rgba(106,92,255,.9)'; octx.lineWidth = 1;
      octx.strokeRect(o.x + 0.5, o.y + 0.5, Math.max(1, art.w - 1), Math.max(1, art.h - 1));   // a thin box so the spot is findable
    }
    function attach() {
      const c = findCv(); if (!c) return false;
      if (c === cv && ov && ov.isConnected) return true;
      detach(); cv = c; view = cv.ownerDocument.defaultView || window;
      ov = cv.ownerDocument.createElement('canvas');
      ov.width = cv.width; ov.height = cv.height;
      ov.style.cssText = 'position:absolute;pointer-events:none;image-rendering:pixelated;transition:none';   // no transition, so it snaps to the board exactly
      cv.after(ov);   // above #cv, below #grid and #aim
      if (!loadHook) { loadHook = true; for (const f of document.querySelectorAll('iframe')) f.addEventListener('load', () => { cv = null; setTimeout(tick, 300); }); }
      try {
        mo = new view.MutationObserver(() => kick(400));   // the site moved or zoomed the board
        mo.observe(cv, { attributes: true, attributeFilter: ['style', 'class', 'width', 'height'] });
        if (cv.parentElement) mo.observe(cv.parentElement, { attributes: true, attributeFilter: ['style', 'class'] });
      } catch { /* no observer: the timer below still re-aligns it */ }
      frame(); kick(400); redraw = true;
      return true;
    }
    function tick() {
      if (!alive()) { detach(); if (timer) { clearInterval(timer); timer = 0; } return; }
      if (!cfg) return;   // settings not read yet
      if (cfg.overlayBoard === false || !cfg.art || !cfg.origin) { detach(); return; }
      if (!attach()) return;   // no board on this page yet
      kick(0);                 // safety net: re-align once, in case a move was missed
      if (redraw || ++ticks % 3 === 0) { redraw = false; draw(); }   // refresh done/to-paint about every 2 s
    }
    // the settings are read once and then followed through change events, not re-read on a timer
    try {
      chrome.storage.onChanged.addListener((ch) => {
        if (!cfg || !alive() || !(ch.overlayBoard || ch.art || ch.origin)) return;
        for (const k of ['overlayBoard', 'art', 'origin']) if (ch[k]) cfg[k] = ch[k].newValue;
        redraw = true; tick();
      });
      chrome.storage.local.get(['overlayBoard', 'art', 'origin']).then((s) => { cfg = s; tick(); }).catch(() => {});
    } catch { /* reloaded */ }
    timer = setInterval(tick, 700);
  }
  boardGhost();

  // ========= protect an area: click two corners on the board, and what is painted there now gets protected =========
  // The popup switches this on (storage key "pick" = the time it was pressed). You click one corner of a painting,
  // then the opposite corner; the pixels inside are copied from the board as they are now and added to the
  // protected arts, so the bot repaints them if someone changes them. Empty (white) pixels are not protected.
  const AREA_MAX = 60000;   // pixels in one selected area
  async function protectArea(x, y, w, h) {
    if (w * h > AREA_MAX) return `That is ${w}×${h}, too big. Select at most ${AREA_MAX} pixels at a time.`;
    const m = await (await fetch('/api/canvas/meta', { cache: 'no-store' })).json();
    const b = new Uint8Array(await (await fetch('/api/canvas', { cache: 'no-store' })).arrayBuffer());
    if (b.length !== m.w * m.h) throw new Error('board size');
    const white = m.palette.length - 1, data = [];
    let n = 0;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const c = b[(y + yy) * m.w + x + xx];
      if (c === white || c === undefined) data.push(-1); else { data.push(c); n++; }
    }
    if (!n) return 'Nothing is painted in that area.';
    const art = { w, h, data }, origin = { x, y }, key = artKey(art, origin);
    const { guard = [] } = await chrome.storage.local.get('guard');
    if (guard.some((g) => g.key === key)) return 'That area is already protected ✓';
    await chrome.storage.local.set({ guard: [...guard, { key, art, origin, size: 1, snap: true, t: Date.now() }].slice(-MAX_GUARD) });
    return `Protected ${w}×${h} at (${x}, ${y}): ${n} pixels ✓ Turn the bot on to keep it repaired.`;
  }
  function areaPicker() {
    if (typeof document === 'undefined') return;   // the test harness has no page
    let on = false, first = null, bar = null, doc = null, down = null, hideT = 0;
    const findCv = () => {
      const c = document.getElementById('cv'); if (c) return c;
      for (const f of document.querySelectorAll('iframe')) { try { const d = f.contentDocument, x = d && d.getElementById('cv'); if (x) return x; } catch { /* cross-origin */ } }
      return null;
    };
    const say = (t) => {
      clearTimeout(hideT);
      if (!bar) {
        bar = document.createElement('div');
        bar.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;direction:ltr;max-width:90vw;background:#6a5cff;color:#fff;font:600 13px system-ui,sans-serif;padding:8px 14px;border-radius:8px;box-shadow:0 6px 20px #0008;cursor:pointer';
        bar.title = 'Click to cancel';
        bar.onclick = () => stop(true);
        (document.body || document.documentElement).appendChild(bar);
      }
      bar.textContent = t;
    };
    const hide = () => { clearTimeout(hideT); if (bar) { bar.remove(); bar = null; } };
    function stop(cancel) {
      on = false; first = null;
      if (doc) { doc.removeEventListener('pointerdown', onDown, true); doc.removeEventListener('click', onClick, true); }
      doc = null;
      try { chrome.storage.local.set({ pick: 0 }); } catch { /* reloaded */ }
      if (cancel) hide();
    }
    const onDown = (e) => { down = { x: e.clientX, y: e.clientY }; };
    async function onClick(e) {
      if (!on) return;
      const cv = findCv(); if (!cv) return;
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;   // that was a drag (moving the board), not a click
      if (!e.target || !e.target.closest || !e.target.closest('#stage')) return;
      const r = cv.getBoundingClientRect();
      const px = Math.floor((e.clientX - r.left) / r.width * cv.width), py = Math.floor((e.clientY - r.top) / r.height * cv.height);
      if (px < 0 || py < 0 || px >= cv.width || py >= cv.height) return;
      if (!first) { first = { x: px, y: py }; say(`First corner: (${px}, ${py}). Now click the opposite corner. Click this bar to cancel.`); return; }
      const x = Math.min(first.x, px), y = Math.min(first.y, py), w = Math.abs(first.x - px) + 1, h = Math.abs(first.y - py) + 1;
      stop(false);
      say('Saving that area…');
      try { say(await protectArea(x, y, w, h)); } catch { say("Couldn't read the board. Try again."); }
      hideT = setTimeout(hide, 6000);
    }
    function start() {
      if (on) return;
      const cv = findCv();
      if (!cv) return;   // this tab has no board
      on = true; first = null; doc = cv.ownerDocument;
      doc.addEventListener('pointerdown', onDown, true);
      doc.addEventListener('click', onClick, true);
      say('Click one corner of the painting you want to protect. You can still move and zoom the board. Click this bar to cancel.');
    }
    const fresh = (t) => !!t && Date.now() - t < 180000;   // a forgotten selection switches itself off after 3 minutes
    try {
      chrome.storage.onChanged.addListener((ch) => { if (!ch.pick || !alive()) return; if (fresh(ch.pick.newValue)) start(); else if (on) stop(true); });
      chrome.storage.local.get('pick').then((s) => { if (fresh(s.pick)) setTimeout(start, 1200); }).catch(() => {});
    } catch { /* reloaded */ }
  }
  areaPicker();


  // a tab waiting for the lock says so, instead of looking dead
  status({ state: 'waiting', msg: 'Bot loaded in a site tab, starting…' });
  const run = () => { whoLoop(0); whoLoop(1); return loop(); };
  if (navigator.locks) navigator.locks.request('odedsvr-artbot', run);
  else run();
})();
