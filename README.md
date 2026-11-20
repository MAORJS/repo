# Canvas Art Bot (odedsvrmonopoly.app)

A Chrome/Edge extension. It watches for the canvas to open and paints your pixel art in a spot you choose, using only your own pixels.

## Install
1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this `canvas-artbot` folder.

After changing any file: click the reload icon on the extension's card, then refresh any open odedsvrmonopoly.app tab.

## Use
1. Log in on odedsvrmonopoly.app with Kick like you normally do.
2. Click the extension icon:
   - **Your art**: pick a built-in art and set its exact size (1×–16×, the pixel count is shown), or upload a small image. Uploads are shrunk to "Max size" and matched to the site's 32 colors. Transparent pixels are left alone.
   - **Your spot**: type the top-left X/Y, or click **Find empty spot** for the closest all-white area with a 2 px gap around it. The popup checks the board there by itself and shows what is already done (full color), still to paint (faded) and someone else's (red), with a progress bar.
   - Press **Start painting** in the card at the top. The other sections (Options, Approved painters, Team, Protected arts) fold away; click a title to open it. **Options** has the paint order: top to bottom, outline first (black lines, then every edge, then the fill), middle outwards, random.
3. Leave Chrome running. The pill at the top of the popup shows whether the canvas is open and for how long.

## What it does by itself
- **Notices the canvas opening.** A site tab that is already open hears it instantly from the site's live feed. Otherwise the extension checks every 30 s, sends a notification, and opens a background tab. That tab is closed again when the canvas closes (unless you are looking at it).
- **Uses your pixel pool.** You can hold up to 10 pixels and get one more every 5 s. It asks the site how many you have, paints right away while you have some, and waits only when you are out.
- **Stays in step with the board.** It follows every pixel anyone paints through the live feed, skips what is already right, and repaints its own pixels if someone covers them.
- **Never paints over others** (while that option is on): it only paints white pixels and pixels it placed itself.
- **Keeps its pace in a background tab.** Its timers run in a worker, so Chrome's background-tab slowdown doesn't apply.
- **Reports.** The toolbar badge shows progress in %, ✓ when finished, `OPEN` when the canvas is open, `!` on an error. You get a notification when the art is finished.
- If you have several site tabs open, only one paints.

## Team mode (optional)
For friends who want to paint one art together, each with their own account and their own pixels.
1. One friend sets up the art and the spot, sets **Friends painting** to the number of people, and clicks **Copy team code**.
2. Everyone else pastes that code and clicks **Load code**. This gives them the same art, spot and team size.
3. Each friend picks a different **I am number**, then clicks Start.

The art is split into shares with the same number of pixels. Each bot paints only its own share while the others are painting theirs, so everyone paints the same amount. If a friend stops for 20 seconds (offline or stuck), the bots that are finished step in and split that share between them, so the art still gets done. Everyone must use the same version of the extension and the same paint order (the team code sets it; "Random" counts as "Top to bottom" in a team).

## Protected arts (anti-griefing)
When the bot sees your art complete, it saves the picture and its spot in a list (shown in the popup under **Protected arts**). From then on it keeps checking those spots every few seconds while the canvas is open, and repaints any pixel that someone painted over, before it continues with new art. You can remove an art from the list, or turn the feature off with the checkbox in **Run**.

In a team there is no shared server: each friend's bot adds the art to its own list when it sees it finished. The friend who owns a griefed pixel repairs it at once; the others wait 8 seconds first, so the team doesn't spend several pixels on the same one.

## Approved painters
With **Only approved painters** on (in **Run**), the bot asks the site who painted each pixel inside your art and your protected arts. A pixel painted by anyone who is not on the list is repainted by you, even if its colour is already right. Your own account is always approved. In a team you don't have to list your friends: anyone who paints your art in the right colour is approved automatically after a few pixels (the team code also shares the names). This stops the bots repainting each other's pixels. Checking takes about 4 pixels per second.

## Lost connection
If several requests to the site fail in a row, the bot refreshes the page (at most once every 2 minutes). If the tab can't load at all or was put to sleep, the extension reloads it once the site answers again and the canvas is open.

## Night mode
Tick **Night mode** in **Run** before you go to sleep. It starts the bot and then needs nothing from you:
- keeps the computer from going to sleep (the screen may still turn off),
- opens the site in a background tab when the canvas opens, and refreshes it if it stops answering,
- sends no notifications,
- writes a **Night report** in the popup: pixels painted, repaired and taken back, and what happened at what time.

It can't log in for you: stay logged in on the site and leave Chrome open. Closing a laptop lid usually still puts it to sleep. **Stop** ends night mode.

## On-board preview
With **Show the art on the board** on (in **Run**, on by default), a faded ghost of your art is drawn directly onto the canvas at its exact spot, lined up with the board and following it as you pan and zoom. Pixels already painted correctly are left clear so the real board shows through; the rest are shown at about 60% so you can see what is still to come, with a thin box around the area. It is drawn only in your own browser, paints nothing, and does not block clicking. There is also an optional small preview **panel** in the corner (a draggable copy of the popup's picture) under the second checkbox.

## Files
- `background.js`: the 30 s check, notifications, badge, opening/closing the background tab.
- `content.js`: the painter (runs in the site tab, as you).
- `popup.html` / `popup.js`: the settings window.
- `presets.js`: built-in arts as text rows, one letter per color. Copy a block to add your own.
