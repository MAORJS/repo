const BASE = 'https://odedsvrmonopoly.app';
const $ = (id) => document.getElementById(id);
// the site's palette (refreshed from /api/canvas/meta when reachable); the last one is white = empty
let PAL = ['#6d001a','#be0039','#ff4500','#ffa800','#ffd635','#fff8b8','#00a368','#00cc78','#7eed56','#00756f','#009eaa','#00ccc0','#2450a4','#3690ea','#51e9f4','#493ac1','#6a5cff','#94b3ff','#811e9f','#b44ac0','#e4abff','#de107f','#ff3881','#ff99aa','#6d482f','#9c6926','#ffb470','#000000','#515252','#898d90','#d4d7d9','#ffffff'];
let W = 1000, H = 500;
let art = null;

const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const nearest = (r, g, b) => {
  let best = 0, bd = Infinity;
  PAL.forEach((h, i) => { const [pr, pg, pb] = rgb(h); const d = (r - pr) ** 2 * 3 + (g - pg) ** 2 * 4 + (b - pb) ** 2 * 2; if (d < bd) { bd = d; best = i; } });
  return best;
};

async function loadMeta() {
  try { const m = await (await fetch(BASE + '/api/canvas/meta', { cache: 'no-store' })).json(); PAL = m.palette; W = m.w; H = m.h; return m; }
  catch { return null; }
}
async function loadBoard() { return new Uint8Array(await (await fetch(BASE + '/api/canvas', { cache: 'no-store' })).arrayBuffer()); }

function drawPreview(states) {
  const cv = $('preview');
  if (!art) { cv.width = cv.height = 1; return; }
  cv.width = art.w; cv.height = art.h;
  const scale = Math.max(1, Math.floor(Math.min(296 / art.w, 160 / art.h)));
  cv.style.width = art.w * scale + 'px'; cv.style.height = art.h * scale + 'px';
  const ctx = cv.getContext('2d'), img = ctx.createImageData(art.w, art.h);
  art.data.forEach((c, k) => {
    if (c < 0) return;
    const st = states && states[k];
    if (st === 'blocked') return img.data.set([255, 40, 60, 255], k * 4);
    const [r, g, b] = rgb(PAL[c] || '#ffffff');
    img.data.set([r, g, b, st === 'todo' ? 70 : 255], k * 4);   // still to paint = faded
  });
  ctx.putImageData(img, 0, 0);
  const n = art.data.filter((c) => c >= 0).length;
  $('artInfo').textContent = `${art.w}×${art.h}, ${n} pixels ≈ ${Math.max(1, Math.ceil(Math.max(0, n - 10) * 5 / 60))} min to paint`;
}

// image → palette indices, shrunk to fit "max size" (nearest-neighbour, keeps pixel art crisp)
async function readImage(file) {
  const bmp = await createImageBitmap(file);
  const max = Math.max(1, +$('maxSize').value || 32);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bmp, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data, data = [];
  for (let i = 0; i < w * h; i++) data.push(d[i * 4 + 3] < 128 ? -1 : nearest(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]));
  return { w, h, data };
}

async function saveArt(newArt) {
  art = newArt;
  // a new picture or spot starts a fresh record of "pixels we painted"
  await chrome.storage.local.set({ art, placed: [], presetId: '' });
  drawPreview();
  checkSoon();
}

$('file').onchange = async () => { const f = $('file').files[0]; if (f) { $('preset').value = ''; await loadMeta(); await saveArt(await readImage(f)); } };

$('preset').innerHTML += PRESETS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
async function usePreset() {
  const p = PRESETS.find((q) => q.id === $('preset').value);
  if (!p) return;
  $('file').value = '';
  await saveArt(scaleArt(p.art, +$('scale').value || 1));
  chrome.storage.local.set({ presetId: p.id, presetScale: +$('scale').value || 1 });
}
$('preset').onchange = usePreset;
$('scale').onchange = usePreset;
$('maxSize').onchange = () => $('file').onchange();

async function saveOrigin() {
  const origin = { x: Math.min(W - 1, Math.max(0, Math.floor(+$('ox').value || 0))), y: Math.min(H - 1, Math.max(0, Math.floor(+$('oy').value || 0))) };
  const old = (await chrome.storage.local.get('origin')).origin;
  if (!old || old.x !== origin.x || old.y !== origin.y) await chrome.storage.local.set({ origin, placed: [] });
  return origin;
}
$('ox').onchange = saveOrigin; $('oy').onchange = saveOrigin;

// What is already on the board at your X/Y: each art pixel is
//   done    – the board already has the right colour (the bot skips it)
//   todo    – white, or painted by this bot: it will be painted
//   blocked – someone else's colour: skipped while "never paint over others" is on
// The preview shows done pixels in full colour, todo ones faded, blocked ones in red.
let checkSeq = 0;
async function checkProgress(quiet) {
  if (!art) { setBar(null); return ($('area').textContent = 'Pick or upload an art first.'); }
  const seq = ++checkSeq;
  lastCheck = Date.now();
  const o = await saveOrigin();
  if (!quiet) $('area').textContent = 'Checking the board at (' + o.x + ', ' + o.y + ')…';
  let b;
  try { await loadMeta(); b = await loadBoard(); }
  catch { if (seq === checkSeq) $('area').innerHTML = '<span class="bad">Couldn\'t load the board. Is the site up?</span>'; return; }
  if (seq !== checkSeq) return;   // X/Y changed again while loading
  if (o.x + art.w > W || o.y + art.h > H) { drawPreview(); setBar(null); $('area').innerHTML = `<span class="bad">Doesn't fit: the board is ${W}×${H}.</span>`; return; }

  const { placed = [], protect = true, guard = [] } = await chrome.storage.local.get(['placed', 'protect', 'guard']);
  const mine = new Set(placed), WHITE = PAL.length - 1;
  const guarded = guard.some((g) => g.key === artKey(art, o));   // a protected art is repainted over anyone
  const states = art.data.map(() => null);
  let done = 0, todo = 0, blocked = 0;
  for (let y = 0; y < art.h; y++) for (let x = 0; x < art.w; x++) {
    const k = y * art.w + x, c = art.data[k];
    if (c < 0) continue;
    const i = (o.y + y) * W + o.x + x, cur = b[i];
    if (cur === c) { done++; states[k] = 'done'; }
    else if (protect !== false && !guarded && cur !== WHITE && !mine.has(i)) { blocked++; states[k] = 'blocked'; }
    else { todo++; states[k] = 'todo'; }
  }
  drawPreview(states);
  setBar({ done, todo, blocked });
  const { team } = await chrome.storage.local.get('team');
  let share = '';
  if (team && team.size > 1) {
    let left = 0;
    states.forEach((st, k) => { if (st === 'todo' && ((k % art.w) + Math.floor(k / art.w)) % team.size === team.slot - 1) left++; });
    share = `<br>👥 Your share (number ${team.slot} of ${team.size}): <b>${left}</b> left`;
  }
  const total = done + todo + blocked, pct = total ? Math.round(done / total * 100) : 0;
  const mins = Math.ceil(Math.max(0, todo - 10) * 5 / 60);
  let html = `<b>${done}/${total}</b> already done (${pct}%)`;
  html += todo ? `, <b>${todo}</b> left ≈ ${todo <= 10 ? 'under a minute' : mins + ' min'}` : ' <span class="good">✓ nothing left to paint</span>';
  if (blocked) html += `<br><span class="bad">${blocked} pixels are someone else's</span> (red in the preview). ${$('approvedOn').checked ? 'The bot replaces the ones not painted by an approved name.' : 'Skipped.'} Try "Find empty spot".`;
  else if (!done) html += `<br><span class="good">Spot is free ✓</span>`;
  $('area').innerHTML = html + share;
}
$('check').onclick = () => checkProgress();
let lastCheck = 0;
// the bar under the preview: green = done, red = someone else's, the rest is still to paint
function setBar(p) {
  $('bar').hidden = !p;
  if (!p) return;
  const total = p.done + p.todo + p.blocked || 1;
  $('barDone').style.width = (p.done / total * 100) + '%';
  $('barBlocked').style.width = (p.blocked / total * 100) + '%';
}
// check by itself whenever the spot or the art changes
let checkT = 0;
const checkSoon = () => { clearTimeout(checkT); checkT = setTimeout(() => checkProgress(), 400); };
$('ox').oninput = checkSoon; $('oy').oninput = checkSoon;

// the empty (all white) rectangle of the art's size closest to the X/Y you typed
$('find').onclick = async () => {
  if (!art) return ($('area').textContent = 'Upload art first.');
  $('area').textContent = 'Searching…';
  await loadMeta();
  const b = await loadBoard(), WHITE = PAL.length - 1, pad = 2;
  const w = art.w + pad * 2, h = art.h + pad * 2;    // keep a 2 px gap from neighbours
  const S = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    S[(y + 1) * (W + 1) + x + 1] = (b[y * W + x] !== WHITE) + S[y * (W + 1) + x + 1] + S[(y + 1) * (W + 1) + x] - S[y * (W + 1) + x];
  const sum = (x, y) => S[(y + h) * (W + 1) + x + w] - S[y * (W + 1) + x + w] - S[(y + h) * (W + 1) + x] + S[y * (W + 1) + x];
  const tx = +$('ox').value || 0, ty = +$('oy').value || 0;
  let best = null, bd = Infinity;
  for (let y = 0; y + h <= H; y++) for (let x = 0; x + w <= W; x++) {
    if (sum(x, y)) continue;
    const d = (x + pad - tx) ** 2 + (y + pad - ty) ** 2;
    if (d < bd) { bd = d; best = { x: x + pad, y: y + pad }; }
  }
  if (!best) return ($('area').innerHTML = '<span class="bad">No empty spot that big. Make the art smaller.</span>');
  $('ox').value = best.x; $('oy').value = best.y;
  await saveOrigin();
  await checkProgress();
  $('area').innerHTML = `<span class="good">Empty spot at (${best.x}, ${best.y}) ✓</span><br>` + $('area').innerHTML;
};

$('protect').onchange = async () => { await chrome.storage.local.set({ protect: $('protect').checked }); checkSoon(); };
$('autoOpen').onchange = () => chrome.storage.local.set({ autoOpen: $('autoOpen').checked });
$('order').onchange = () => chrome.storage.local.set({ order: $('order').value });
$('openSite').onclick = async () => {
  const tabs = await chrome.tabs.query({ url: BASE + '/*' });
  if (tabs.length) { chrome.tabs.update(tabs[0].id, { active: true }); chrome.windows.update(tabs[0].windowId, { focused: true }); }
  else chrome.tabs.create({ url: BASE + '/canvas' });
};

// ---------- team: friends, each on their own account, paint one art ----------
// The art is split by (x + y) % friends; the code carries the art, the spot and the number of friends.
function drawTeam(t) {
  const size = t && t.size > 1 ? t.size : 1, slot = Math.min(size, Math.max(1, (t && t.slot) || 1));
  $('teamSize').value = String(size);
  $('teamSlot').innerHTML = Array.from({ length: size }, (_, k) => `<option>${k + 1}</option>`).join('');
  $('teamSlot').value = String(slot);
  $('teamSlot').disabled = size < 2;
}
async function saveTeam() {
  const size = +$('teamSize').value || 1, slot = Math.min(size, +$('teamSlot').value || 1);
  await chrome.storage.local.set({ team: { size, slot } });
  drawTeam({ size, slot }); checkSoon();
}
$('teamSize').onchange = saveTeam; $('teamSlot').onchange = saveTeam;
function teamEncode(a, o, size) {
  const b = new Uint8Array(9 + a.data.length);
  b.set([a.w >> 8, a.w & 255, a.h >> 8, a.h & 255, o.x >> 8, o.x & 255, o.y >> 8, o.y & 255, size]);
  a.data.forEach((c, k) => { b[9 + k] = c + 1; });
  let s = ''; b.forEach((v) => { s += String.fromCharCode(v); });
  return 'CAB1.' + btoa(s);
}
function teamDecode(code) {
  code = String(code).trim();
  if (!code.startsWith('CAB1.')) throw new Error('not a team code');
  let s; try { s = atob(code.slice(5)); } catch { throw new Error('a damaged team code'); }
  const b = Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  const w = b[0] << 8 | b[1], h = b[2] << 8 | b[3];
  if (!w || !h || w > 500 || h > 500 || b.length !== 9 + w * h) throw new Error('a damaged team code');
  const size = Math.min(8, Math.max(1, b[8]));
  return { art: { w, h, data: Array.from(b.subarray(9), (v) => Math.min(v, PAL.length) - 1) }, origin: { x: b[4] << 8 | b[5], y: b[6] << 8 | b[7] }, size };
}
$('teamCopy').onclick = async () => {
  if (!art) return ($('teamInfo').textContent = 'Pick or upload an art first.');
  const code = teamEncode(art, await saveOrigin(), +$('teamSize').value || 1);
  $('teamCode').value = code;
  try { await navigator.clipboard.writeText(code); $('teamInfo').innerHTML = '<span class="good">Copied ✓</span> Send it to your friends.'; }
  catch { $('teamInfo').textContent = 'Copy the code from the box and send it to your friends.'; }
};
$('teamLoad').onclick = async () => {
  let t;
  try { t = teamDecode($('teamCode').value); } catch (e) { return ($('teamInfo').innerHTML = '<span class="bad">That is ' + e.message + '.</span>'); }
  $('preset').value = ''; $('file').value = '';
  $('ox').value = t.origin.x; $('oy').value = t.origin.y;
  const slot = Math.min(t.size, +$('teamSlot').value || 1);
  art = t.art;
  await chrome.storage.local.set({ art, origin: t.origin, placed: [], presetId: '', team: { size: t.size, slot } });
  drawTeam({ size: t.size, slot }); drawPreview(); checkSoon();
  $('teamInfo').innerHTML = `<span class="good">Loaded ✓</span> ${t.art.w}×${t.art.h} at (${t.origin.x}, ${t.origin.y}), ${t.size} friends. Now pick your number: each friend a different one.`;
};

// ---------- protected arts: finished arts the bot keeps repairing ----------
const artKey = (a, o) => { let h = 2166136261; for (const c of a.data) h = Math.imul(h ^ (c + 1), 16777619) >>> 0; return [o.x, o.y, a.w, a.h, h].join(','); };
async function drawGuard() {
  const { guard = [] } = await chrome.storage.local.get('guard');
  if (!guard.length) return ($('guardList').textContent = 'None yet. An art is added here by itself when it is finished.');
  $('guardList').innerHTML = guard.map((g, k) => `<div class="row" style="justify-content:space-between;margin:2px 0"><span>${g.art.w}×${g.art.h} at (${g.origin.x}, ${g.origin.y})${g.size > 1 ? ', team of ' + g.size : ''}</span><button class="sec" data-k="${k}" style="padding:2px 8px">Remove</button></div>`).join('') +
    '<div style="margin-top:4px">In a team, every friend\'s bot adds the art when it sees it finished, and repairs its own share first.</div>';
  $('guardList').querySelectorAll('button').forEach((b) => { b.onclick = async () => {
    const { guard = [] } = await chrome.storage.local.get('guard');
    guard.splice(+b.dataset.k, 1);
    await chrome.storage.local.set({ guard }); drawGuard(); checkSoon();
  }; });
}
const DEFAULT_APPROVED = ['kgsx', 'ksgxl', 'kgsxs'];
const saveApproved = () => chrome.storage.local.set({
  approvedOn: $('approvedOn').checked,
  approved: $('approved').value.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean),
});
$('approvedOn').onchange = saveApproved; $('approved').onchange = saveApproved;
$('autoGuard').onchange = () => chrome.storage.local.set({ autoGuard: $('autoGuard').checked });

// is the canvas open right now, and for how long
let canvasMeta = null, canvasSkew = 0;
function drawCanvasState() {
  const m = canvasMeta, el = $('canvasState');
  if (!m) { el.textContent = 'Site unreachable'; el.className = 'pill'; return; }
  const left = m.openUntil - (Date.now() + canvasSkew), open = m.open && (m.paused != null || left > 0);
  el.className = 'pill' + (open ? ' on' : '');
  if (!open) el.textContent = 'Canvas closed';
  else if (m.paused != null) el.textContent = 'Canvas open (paused)';
  else { const s = Math.max(0, Math.floor(left / 1000)); el.textContent = `Canvas open · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`; }
}
async function refreshCanvasState() {
  const m = await loadMeta();
  canvasMeta = m; if (m && typeof m.t === 'number') canvasSkew = m.t - Date.now();
  drawCanvasState();
}
setInterval(drawCanvasState, 1000);
setInterval(refreshCanvasState, 15000);

async function paintToggle(enabled) {
  $('toggle').textContent = enabled ? 'Stop' : 'Start';
  $('toggle').className = enabled ? 'stop' : '';
}
$('toggle').onclick = async () => {
  const { enabled } = await chrome.storage.local.get('enabled');
  if (!enabled) {
    if (!art) return ($('status').textContent = 'Pick or upload an art first (step 1).');
    await saveOrigin();
    const tabs = await chrome.tabs.query({ url: BASE + '/*' });
    if (!tabs.length) chrome.tabs.create({ url: BASE + '/canvas', active: false });
  }
  await chrome.storage.local.set({ enabled: !enabled });
  paintToggle(!enabled);
};

// the painter has gone silent (tab asleep, error page, lost connection): refresh its tab, or open one
async function reviveTab() {
  const { enabled, reloadAt = 0 } = await chrome.storage.local.get(['enabled', 'reloadAt']);
  if (!enabled || Date.now() - reloadAt < 60000) return;
  await chrome.storage.local.set({ reloadAt: Date.now() });
  const tabs = await chrome.tabs.query({ url: BASE + '/*' });
  if (tabs.length) tabs.forEach((t) => chrome.tabs.reload(t.id));
  else chrome.tabs.create({ url: BASE + '/canvas', active: false });
}
function showStatus(s) {
  if (!s) return ($('status').textContent = 'Open odedsvrmonopoly.app in a tab, the bot runs there.');
  const age = Math.round((Date.now() - s.t) / 1000);
  const prog = s.total ? `<br><b>${s.done}/${s.total}</b> pixels done${s.blocked ? `, ${s.blocked} skipped (someone else's)` : ''}` : '';
  const pool = s.pool ? `<br>🟪 ${s.pool}` : '';
  const team = (s.team ? `<br>👥 ${s.team}` : '') + (s.guard ? `<br>🛡️ ${s.guard}` : '') + (s.who ? `<br>🔎 ${s.who}` : '');
  const extra = team + (s.state === 'painting' && s.eta ? `<br>Time left: ${s.eta}` : '') + (s.session ? `<br><span class="muted">${s.session} painted since this tab opened</span>` : '');
  $('status').className = s.state || '';
  if (age > 30) reviveTab();
  // keep the preview in step with the bot while it paints
  if (s.state === 'painting' && art && Date.now() - lastCheck > 5000) checkProgress(true);
  $('status').innerHTML = `${s.msg}${pool}${prog}${extra}<br><span class="muted">${age > 30 ? `last update ${age}s ago. If the bot is on, the site tab is refreshed by itself.` : ''}</span>`;
}
chrome.storage.onChanged.addListener((ch) => { if (ch.status) showStatus(ch.status.newValue); if (ch.guard) drawGuard(); });

(async () => {
  const s = await chrome.storage.local.get(['art', 'origin', 'protect', 'autoOpen', 'enabled', 'status', 'presetId', 'presetScale', 'order', 'team', 'autoGuard', 'approved', 'approvedOn']);
  $('approvedOn').checked = s.approvedOn !== false;
  $('approved').value = (Array.isArray(s.approved) ? s.approved : DEFAULT_APPROVED).join(', ');
  $('autoGuard').checked = s.autoGuard !== false;
  drawGuard();
  drawTeam(s.team);
  $('order').value = s.order || 'rows';
  if (s.presetId) { $('preset').value = s.presetId; $('scale').value = String(s.presetScale || 1); }
  await refreshCanvasState();
  art = s.art || null; drawPreview();
  if (s.origin) { $('ox').value = s.origin.x; $('oy').value = s.origin.y; }
  $('protect').checked = s.protect !== false;
  $('autoOpen').checked = s.autoOpen !== false;
  paintToggle(!!s.enabled);
  showStatus(s.status);
  if (art && s.origin) checkProgress();   // show what's already painted at the saved spot
})();
