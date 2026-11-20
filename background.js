// Polls the canvas status every 30 s. When the canvas opens it notifies you and, if no site tab is open,
// opens one in the background so content.js can paint. It also keeps the toolbar badge up to date and
// tells you when the art is finished.
const BASE = 'https://odedsvrmonopoly.app';

const isOpen = (m) => !!m && m.open && (m.paused != null || m.openUntil > m.t);
// ---------- night mode: runs unattended ----------
// Keeps the computer awake, opens/refreshes the site tab by itself, stays quiet (no notifications) and
// writes what happened into a log the popup shows in the morning.
async function nightLog(msg) {
  const { night, nightLog: log = [] } = await chrome.storage.local.get(['night', 'nightLog']);
  if (!night || (log.length && log[log.length - 1].msg === msg)) return;
  await chrome.storage.local.set({ nightLog: [...log, { t: Date.now(), msg }].slice(-60) });
}
async function keepAwake() {
  const { night, enabled } = await chrome.storage.local.get(['night', 'enabled']);
  try { if (night && enabled) chrome.power.requestKeepAwake('system'); else chrome.power.releaseKeepAwake(); } catch { /* no power permission */ }
}
const note = async (id, title, message) => {
  const { night } = await chrome.storage.local.get('night');
  if (night) return nightLog(title);   // asleep: write it down instead of making a sound
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icon.png', title, message });
};

function ensureAlarm() {
  chrome.alarms.get('poll', (a) => { if (!a) chrome.alarms.create('poll', { periodInMinutes: 0.5 }); });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);

// badge: progress while painting, ✓ when finished, OPEN when the canvas is open and the bot isn't painting
function badge(open, s) {
  const fresh = s && Date.now() - s.t < 60000;
  let text = open ? 'OPEN' : '', color = '#00a368';
  if (fresh && s.state === 'painting' && s.total) { text = Math.floor(s.done / s.total * 100) + '%'; color = '#6a5cff'; }
  else if (fresh && s.state === 'done' && open) { text = '✓'; }
  else if (fresh && s.state === 'error' && open) { text = '!'; color = '#be0039'; }
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

async function poll() {
  keepAwake();
  let meta;
  try { meta = await (await fetch(BASE + '/api/canvas/meta', { cache: 'no-store' })).json(); }
  catch { return; }
  const open = isOpen(meta);
  const { wasOpen, enabled, autoOpen = true, art, status, autoTab, reloadAt = 0, night } = await chrome.storage.local.get(['wasOpen', 'enabled', 'autoOpen', 'art', 'status', 'autoTab', 'reloadAt', 'night', 'guard']);
  const guard = (await chrome.storage.local.get('guard')).guard, work = art || (Array.isArray(guard) && guard.length > 0);   // something to paint or protect
  if (!open && wasOpen) nightLog('The canvas closed');
  badge(open, status);

  if (open && !wasOpen) {
    const mins = meta.paused == null ? Math.max(1, Math.round((meta.openUntil - meta.t) / 60000)) : 0;
    note('open', 'The canvas is open!' + (mins ? ` (${mins} min)` : ''),
      (enabled && work ? 'Painting your art now.' : 'Turn the bot on in the popup to paint.') + (meta.theme ? ` Theme: ${meta.theme}` : ''));
  }
  if (open && enabled && work && (autoOpen || night)) {
    const tabs = await chrome.tabs.query({ url: BASE + '/*' });
    if (!tabs.length) {
      // a background tab of our own; told not to be put to sleep by the browser's memory saver
      const tab = await chrome.tabs.create({ url: BASE + '/canvas', active: false });
      try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch { /* older browser */ }
      await chrome.storage.local.set({ autoTab: tab.id });
      nightLog('Opened the site in a background tab');
    }
  }
  // The painter reports every few seconds. If the site answers (we just got its status) but the painter has
  // been silent for 45 s, its tab lost the connection, shows an error page, or was put to sleep: refresh it.
  if (enabled && work && (!status || Date.now() - status.t > 45000) && Date.now() - reloadAt > (open ? 60000 : 300000)) {
    const tabs = await chrome.tabs.query({ url: BASE + '/*' });
    if (tabs.length) {
      await chrome.storage.local.set({ reloadAt: Date.now() });
      nightLog('The site tab stopped answering, refreshed it');
      for (const t of tabs) { try { await chrome.tabs.reload(t.id); } catch { /* closed meanwhile */ } }
    }
  }
  // the canvas closed: close the tab this extension opened by itself, unless you are looking at it
  if (!open && wasOpen && autoTab != null) {
    try { const tab = await chrome.tabs.get(autoTab); if (tab && !tab.active && tab.url && tab.url.startsWith(BASE)) await chrome.tabs.remove(autoTab); }
    catch { /* already closed */ }
    await chrome.storage.local.remove('autoTab');
  }
  await chrome.storage.local.set({ wasOpen: open });
}

// the painter reports through storage: update the badge, and say when the art is finished
chrome.storage.onChanged.addListener(async (ch) => {
  if (ch.night || ch.enabled) keepAwake();
  if (!ch.status) return;
  const s = ch.status.newValue, old = ch.status.oldValue;
  if (s && s.state === 'error' && (!old || old.msg !== s.msg)) nightLog('Problem: ' + s.msg);
  const { wasOpen, doneNoteAt = 0 } = await chrome.storage.local.get(['wasOpen', 'doneNoteAt']);
  badge(!!wasOpen, s);
  if (s && s.state === 'done' && old && old.state === 'painting' && Date.now() - doneNoteAt > 10 * 60000) {
    await chrome.storage.local.set({ doneNoteAt: Date.now() });
    note('done', 'Your art is finished 🎨', s.blocked ? `${s.done}/${s.total} pixels. ${s.blocked} were covered by others and skipped.` : `All ${s.total} pixels are on the canvas.`);
  }
});

chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'poll') poll(); });
chrome.notifications.onClicked.addListener(() => chrome.tabs.create({ url: BASE + '/canvas' }));
ensureAlarm();
poll();
