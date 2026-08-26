# PARAS HEALTH — Supply Chain Command Centre

An offline launcher and workspace for the Paras Health SCM dashboards.

It is a **shell**, not a rewrite. Every dashboard in `dashboards/` is still its
own standalone HTML application with its own design, libraries and behaviour.
The Command Centre opens each one inside an isolated frame — nothing in this
project injects CSS, scripts or state into your dashboards.

---

## Start it

**Windows — double-click `start.bat`, not `index.html`.**

That one file does everything: sets up the address the first time (Windows asks
for Administrator once), starts the local server, and opens the Command Centre
in an app window with no address bar and its own taskbar icon.

`index.html` still works if you double-click it, but a file opened that way can
only ever show `C:\Users\...\index.html` in the address bar — that is genuinely
what the browser is looking at, and no page can change it. The app says so in
its footer when you open it that way.

**Everywhere else:**

```
python3 serve.py --app        app window, no address bar
python3 serve.py              ordinary browser tab
```

Binds to `127.0.0.1` only, so it is not reachable from the network, and no
internet connection is used.

**Or just double-click `index.html`** — this works too. The only difference:
attached files are written to the data folder (below) when `serve.py` is
running; opened straight from disk there is no server to write to, so the
app falls back to the browser's `IndexedDB` (or, if that is also restricted,
attachments become temporary). The app detects this and says so in the
footer. Layout, theme and mode still persist either way. A file already
attached through `IndexedDB` before `serve.py` was first run is copied over
to the data folder automatically the next time it starts, once.

---

## Where your data lives

**Outside this folder, on purpose:**

```
C:\ParasHealth\CommandCentre\
  auth.json          accounts and passwords
  library.db         the month-on-month database
  library\
    index.json       what each stored file is
    blobs\          the files themselves
```

(On macOS and Linux: `~/ParasHealth/CommandCentre`.)

The reason is upgrades. A new build arrives as a zip you extract to a new
folder — anything kept *inside* the old folder would simply not be there any
more. Keeping it at an address that never moves means upgrading is **extract
and run**, with nothing to copy and nothing to remember.

The path is printed every time `serve.py` starts, so you never have to go
looking for it.

**Backing up** is copying that one folder. Stop the server first — `library.db`
is a live database, and copying it mid-write can produce a file that will not
open.

**To move it somewhere else** (a different drive, a shared location), set
`PARAS_DATA_DIR` once and it wins over the default:

```
setx PARAS_DATA_DIR "D:\ParasData"
```

**Upgrading from a build that kept data inside the app folder:** nothing to
do. The first run copies `data\` and `auth.json` across, tells you what it
moved, and leaves the originals alone — delete them once you are satisfied.

**A note on `auth.json`:** a copy ships in the zip, but it is only ever a
starting point. It seeds the real one the first time and is ignored after
that, which is what stops an upgrade resetting your accounts. To deliberately
go back to the shipped one, delete `auth.json` from the data folder.

Two things are *not* in the data folder, by design. Each dashboard's own
remembered state (filters, selections) lives in the browser against the
address `127.0.0.1`, so it survives upgrades on its own. Drop-in account
photos live in `assets/img/avatars/`, since they ship with the build; photos
set from the account menu go to the data folder like everything else.

---

## The address bar

By default the Command Centre answers on a proper internal-looking address:

```
http://parashealth.internal/supply-chain/command-centre/
```

instead of `C:/Users/.../Downloads/SCM Command Centre/index.html`.

That hostname has to be made real before a browser will show it. One command,
once, with administrator rights:

```
Windows        start.bat does it for you on first run
               (or right-click setup_friendly_url.bat -> Run as administrator)
macOS / Linux  sudo python3 setup_hostname.py
```

Address not working? Double-click **`diagnose.bat`** (or run
`python3 setup_hostname.py --doctor`). It checks the hosts entry, whether the
name resolves, and whether the server is up, then names the next step.

It adds a single line to this computer's hosts file —
`127.0.0.1  parashealth.internal` — after backing the file up. Nothing is
registered on the internet, nothing leaves the machine, and
`python3 setup_hostname.py --remove` undoes it.

Until that runs, the same server answers on
`http://127.0.0.1:8777/supply-chain/command-centre/` and says so on startup.
Port 80 is used when free so the address carries no `:port`; if something else
holds it, the server falls back automatically.

Change the wording in **`site.json`**:

```json
{ "hostname": "parashealth.internal", "path": "/supply-chain/command-centre/", "port": 80 }
```

Then re-run `setup_hostname.py` for the new name.

Why `.internal` and not `.local`: Windows resolves `.local` names over mDNS,
and Bonjour — which ships with iTunes and iCloud for Windows — answers for them
before the hosts file is read. The entry sits there and the browser still says
`DNS_PROBE_FINISHED_NXDOMAIN`. `.internal` is reserved for private use and goes
through ordinary resolution, where the hosts file wins.

**What is not possible:** making the browser display a domain that is not
actually serving the page — including opening `index.html` from disk and having
it show an `http://` address. Showing one address while loading another is exactly
what phishing does, so every browser blocks it. The approach above is the real
version — the name genuinely resolves to this computer, so the address bar is
telling the truth. An app window (`--app`) removes the address bar altogether,
which is the closest thing to "it just looks like an application".

---

## Layout

```
index.html                 the Command Centre
dashboards.json            THE registry — the only file you edit to add a dashboard
dashboards.js              generated mirror of the registry (makes file:// work)
auth.json                  sign-in email + password hash (never the password itself)
auth.js                    generated mirror of auth.json
set_password.py            change the sign-in email / password
sync.py                    regenerates the mirrors + validates the registry
serve.py                   local-only web server
site.json                  hostname / path shown in the address bar
setup_hostname.py          maps that hostname to this computer (hosts file)
start.bat                  Windows launcher (app window, no address bar)
setup_friendly_url.bat     Windows: run the hostname setup as Administrator
diagnose.bat               Windows: explain why the address is not working

dashboards/                your standalone dashboards, untouched
  Procurement_Dashboard.html
  Procurement_Rate_MRP_Variance_Dashboard.html
  Pharmacy_Console.html
  Non_Formulary_Dashboard.html
  Store_Transfer_Dashboard.html
  SCM_Employee_Permission_Dashboard.html

assets/
  css/command-centre.css   shell styling (never reaches your dashboards)
  js/icons.js              inline SVG icon set
  js/registry.js           registry loading + defaults
  js/storage.js            SESSION / LOCAL storage
  js/crypto.js             PBKDF2-HMAC-SHA256 (offline, no dependencies)
  js/gate.js               sign-in gate
  js/app.js                shell, navigation, cards, files
  vendor/                  local copies of Chart.js, PapaParse, SheetJS, fonts
  img/paras-health-logo.png   official Paras Health logo
  img/paras-mark.png          cross mark, used as the favicon

docs/ADDING_A_DASHBOARD.md
```

---

## Signing in

The Command Centre opens on a sign-in screen. Nothing loads — no dashboard, no
files — until the credentials match.

| | |
|---|---|
| Username | `admin/ritik` — exact, case-sensitive |
| Password | set with `set_password.py` — ask Claude, or run it yourself |

More than one account can sign in — each with its own username and password,
listed in `auth.json`'s `"accounts"`. Every username is matched
case-sensitively: `Admin/Ritik` or `ADMIN/RITIK` will not sign in, only the
exact spelling registered.

A wrong username or password shows **"Wrong email or password"** and the app
stays shut — the message never says which half was wrong, so it can't be used
to find out which usernames exist. Five wrong tries locks input for 60
seconds. You stay signed in while the browser tab lives; closing the browser
signs you out, and the padlock button in the top bar signs you out on demand.

**Sign up** creates a brand-new account: its own username, its own password,
right from the sign-in screen. It needs the **admin key** — without it there
is no self-serve sign-up. Enter the key, a username that isn't already taken,
and a password; the account is created and you're signed straight in. Every
account added this way (or with `set_password.py`) can sign in from then on,
each fully independent — changing one password never touches another
account's.

**Forgot password** also asks for the **admin key**, then lets you set a new
password for the account whose name is currently typed in the username field
(or the primary account, if that field is empty) — on the spot, no email, no
server. Wrong key, no reset.

The admin key is stored the same way as every password — hashed, never in the
clear — and is changed with:

```
python3 set_password.py --admin-key NEWKEY admin/ritik 'Password1'
```

When the Command Centre is running from `start.bat` a password change or a new
sign-up is written to `auth.json` and survives everything. Opened from
`file://` there is nothing to write to, so it is kept in that browser instead
and the screen says so.

The name shown on both screens comes from the `"admin"` field in `auth.json`.

**Changing a password, from the machine that holds the folder**

```
python3 set_password.py                       # asks for both, hides typing
python3 set_password.py admin/ritik 'NewPass1' # exact, case-sensitive
```

This always sets the **primary** account (`accounts[0]`) — reusing the same
username updates its password in place; a different username becomes the new
primary account, and every account added later through Sign up is left
exactly as it was. A fresh random salt and PBKDF2-HMAC-SHA256 hash (250,000
iterations) go into `auth.json`, and the mirror is refreshed. **No password is
ever written anywhere** — only its hash, which cannot be read back. There is
deliberately no "change password" screen inside the app for the primary
account: that reset happens here.

**Removing an account** — there is no in-app way to do this, on purpose:

```
python3 set_password.py --remove someusername
```

Refuses to remove the last remaining account, so you can never lock
everyone out by accident.

To turn sign-in off entirely, set `"enabled": false` in `auth.json` and run
`python3 sync.py`.

**What this protects, and what it does not**

It closes the Command Centre to someone who opens it on this computer. It is a
door, not a safe:

- The dashboard files sit in `dashboards/` and open directly in any browser.
- Anyone who copies the folder has the data regardless of the password.
- The check runs in the browser, so it can be bypassed by someone who edits the
  files.

If the data itself needs protecting, do it at the operating-system level —
BitLocker or FileVault on the drive, an encrypted folder, or Windows account
permissions on the folder. The sign-in screen and those are complementary, not
substitutes.

---

## Adding a dashboard

1. Save your new HTML file into `dashboards/`.
2. Add one entry to `dashboards.json`.
3. Run `python3 sync.py` (or just start with `serve.py`, which syncs for you).
4. Reload the Command Centre — the card is there.

Minimum entry:

```json
{ "name": "Inventory Ageing", "category": "inventory", "file": "dashboards/Inventory_Ageing.html" }
```

Everything else is optional. Full field reference:
[docs/ADDING_A_DASHBOARD.md](docs/ADDING_A_DASHBOARD.md).

---

## What the Command Centre does

**Home**
- Cards grouped by category, with name, category, description, icon and Open.
- Search by name, category, description or tag (press <kbd>/</kbd>).
- Category filter chips with live counts.
- **Drag a card** to rearrange. **Hide** a card from its corner button, restore
  it from the tray below the grid, or **Reset layout** to go back to the order
  in `dashboards.json`.

**Opening a dashboard**
- Breadcrumb: `Command Centre / Procurement / Procurement Operations`.
- **← Back to Command Centre** and a Home button, always visible.
- Reload, full screen, and open-in-a-new-tab for the dashboard itself.
- Dashboards you open **stay alive**. Going home and coming back keeps
  filters, uploaded spreadsheets and scroll position exactly as you left them.
  The layers button in the top bar lists what is open; the ✕ there (or on the
  dashboard toolbar) closes one and frees its memory.
- Deep links work: `index.html#/d/pharmacy-console`.

**Files too big for a browser** — condense them first

A GRN or COGS export can run into the hundreds of megabytes. A browser tab
cannot open that directly — it runs out of memory and the tab crashes ("Aw,
Snap!" / "Out of Memory"). Anything over 40 MB gets a lightning-bolt button in
the Data Library instead of the usual upload arrow.

**Once a file is flagged too large, the Command Centre will not hand it to a
dashboard at all** — not through Fill upload boxes, not through the per-file
send button. Either path is refused with a message pointing at Condense.
Handing an oversized file straight to a dashboard is exactly what crashes the
tab, so there is no way around this short of condensing first.

Click it and the Command Centre reads the file's columns (a fraction of a
second, however large the file is — it never loads the whole thing), pre-ticks
the ones the target dashboard actually reads, and offers **Condense**. It then
streams the file end to end: text columns you keep become the grouping key,
number columns get added together, and rows that agree on every kept column
collapse into one. Nothing is dropped and every total comes out identical —
verified on a 252 MB / 1.6 million row file against numbers computed
independently outside the browser, matched to the cent. The condensed file
lands back in the Data Library, ready to fill.

**Data Library** — one place for every export

Drop your registers into the **Data Library** once (button in the top bar).
Each file's header row is read as it lands, so the Command Centre knows what it
actually is rather than guessing from the filename. Open any dashboard and it
shows which library files match its upload boxes; **Fill upload boxes** loads
them all in one click, then you press the dashboard's own build button.

One GRN export feeds Procurement Operations, Rate & MRP Variance and
Non-Formulary Utilisation. One stock transfer feeds Store Transfer and
Non-Formulary. You upload each file once.

**Excel works as well as CSV.** Drop an `.xlsx`, `.xls`, `.xlsm` or `.ods`
into a section and it is read straight into the month-on-month database — no
saving as CSV first. A workbook with more than one sheet asks which one to
use before it files anything, and the stored rows record the sheet they came
from, so `PURCHASE JULY.xlsx [Sheet2]` is traceable later.

Dropping several months at once is fine: each file gets its own month and
year prompt in turn, rather than only the first one being offered.

Anything that cannot go into the database — a PDF, an image — still attaches
as a file, and says so rather than appearing to have worked.

**A register that comes in several files.** COGS arrives as three exports for
the same month — Department Consumption, IP Pharmacy and OP Pharmacy — so it
has a drop box each. All three file into the same COGS data and add up into
one month; the part only decides which piece a re-upload replaces. Drop a
corrected IP Pharmacy file and the other two stay exactly as they were.

To split another register the same way, give it a `parts` list in
`dashboards.json`:

```json
{ "id": "cogs", "name": "COGS",
  "parts": [
    { "id": "dept", "name": "Department Consumption" },
    { "id": "ip",   "name": "IP Pharmacy" },
    { "id": "op",   "name": "OP Pharmacy" }
  ] }
```

**Choosing a section is what files a file.** There is no unfiled drop box:
dropping with no section chosen is refused rather than quietly leaving the
file out of the database. Click a chosen box again to clear it and see every
attached file at once.

| File | Goes to |
|---|---|
| Purchase Register | Procurement Operations, Non-Formulary |
| GRN Register | Procurement Operations, Rate & MRP Variance, Non-Formulary |
| Stock Transfer | Store Transfer, Non-Formulary |
| IP Issue | Non-Formulary |
| Non-Formulary List | Non-Formulary |
| COGS | Formulary Compliance & Savings |
| Permission file | SCM Employee Permissions (its own, kept separate) |

The routing lives in `dashboards.json` under each dashboard's `inputs`, listed
**in the order the upload boxes appear in that dashboard**. `↑` on any file
sends it into a box by hand.

It also guards the dashboard's own upload box, not just the Data Library: picking
a file over 40MB straight into a dashboard's own "Choose file" or drag-and-drop
is refused with a clear message before the dashboard's own code ever touches
it, rather than crashing the tab partway through. That is what was crashing
Formulary Compliance & Savings — the Data Library's size check only ever
covered files handed over from the Library itself, not ones picked directly
into the dashboard.

This works whichever way you open the Command Centre. `sync.py` adds a small
listener to the bottom of each dashboard so a file can be handed over even from
`file://`, where pages are otherwise sealed off from one another. It changes
nothing you can see and nothing the dashboard does — delete the marked block if
you ever want a dashboard left completely alone. Dashboards you add later get
it automatically on the next sync.

**Files pinned to one dashboard**
- Attach SOPs, registers and masters to a specific dashboard — drop them on the
  card, or open the Files drawer and drop/browse there.
- List, search, open (inline preview for PDF, images, CSV/text), download,
  rename and delete.
- Files stay associated with their dashboard. Leave Procurement, open Pharmacy,
  come back — the Procurement files are still there.

**SESSION / LOCAL mode** (top right, always visible)

| | LOCAL | SESSION |
|---|---|---|
| Attached files | kept in the data folder on this computer | memory only |
| Layout, theme, filters | kept (localStorage) | this tab only (sessionStorage) |
| Survives closing the app | yes | no |

Switching to SESSION starts a clean temporary workspace; your LOCAL data is not
deleted and comes back when you switch back. Like a normal browser window and
an Incognito one, each mode is a separate world: switching either direction
closes every dashboard you have open, so a report you built or a file you
uploaded inside a dashboard in one mode never shows up when you switch to the
other. Reopen it after switching back and everything LOCAL saved is exactly
as you left it; reopen it after switching to SESSION and it starts empty.

**Theme** — dark and light, toggled from the top bar, remembered per mode.

**Branding** — the header and home page use the official Paras Health logo,
lifted from the artwork already embedded in your own dashboards so it matches
them exactly. It is a fixed two-colour mark, so it is never recoloured or
filtered: on the dark theme it sits on a light plate, the same treatment the
dashboards use. The shell's blue and grey (`#2F5CA2`, `#757D87`) are sampled
straight from that artwork.

---

## Offline

Nothing here contacts the internet. No CDN, no API, no telemetry, no fonts
fetched at runtime. Everything the app and the dashboards need is in this
folder. Copy the folder to a USB stick or an air-gapped machine and it works.

Two of the supplied dashboards had remote references; both were repointed at
local copies of the **same** library and font versions, and nothing else in
those files was touched:

| Dashboard | Was | Now |
|---|---|---|
| `Non_Formulary_Dashboard.html` | Chart.js 4.5.1, PapaParse 5.4.1, SheetJS 0.18.5 from CDNs | `assets/vendor/*.js` |
| `SCM_Employee_Permission_Dashboard.html` | Chart.js 4.4.1, SheetJS 0.18.5 from CDNs | `assets/vendor/*.js` |
| `Store_Transfer_Dashboard.html` | Space Grotesk + IBM Plex Mono from Google Fonts | `assets/vendor/fonts/` |

The other three dashboards already bundled their libraries and were copied in
byte-for-byte.

Vendor files are versioned, so two dashboards can pin different releases of the
same library side by side:

```
assets/vendor/chart.umd-4.5.1.js        assets/vendor/papaparse-5.4.1.min.js
assets/vendor/chart.umd-4.4.1.js        assets/vendor/xlsx-0.18.5.full.min.js
assets/vendor/fonts/                    Space Grotesk, IBM Plex Mono (latin)
```

---

## Keyboard

| Key | Action |
|---|---|
| <kbd>/</kbd> | search dashboards |
| <kbd>H</kbd> | home |
| <kbd>Esc</kbd> | close drawer / preview, or back to the Command Centre |
