# PARAS HEALTH — Supply Chain Command Centre

An offline launcher and workspace for the Paras Health SCM dashboards.

It is a **shell**, not a rewrite. Every dashboard in `dashboards/` is still its
own standalone HTML application with its own design, libraries and behaviour.
The Command Centre opens each one inside an isolated frame — nothing in this
project injects CSS, scripts or state into your dashboards.

---

## Start it

**Recommended — local server**

```
python3 serve.py
```

Opens <http://127.0.0.1:8777/>. Binds to `127.0.0.1` only, so it is not
reachable from the network, and no internet connection is used.
On Windows, double-click **`start.bat`**.

**Or just double-click `index.html`** — this works too. The only difference:
browsers restrict `IndexedDB` on `file://`, so in some browsers attached files
become temporary. The app detects this and says so in the footer. Layout,
theme and mode still persist.

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
start.bat                  Windows launcher

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
| Email | `ritiknagar@gmail.com` |
| Password | set with `set_password.py` — ask Claude, or run it yourself |

A wrong email or password shows **"Wrong email or password"** and the app stays
shut. Five wrong tries locks input for 60 seconds. You stay signed in while the
browser tab lives; closing the browser signs you out, and the padlock button in
the top bar signs you out on demand.

**Forgot password** on the sign-in screen shows *Contact Admin — Ritik Nagar*.
Change that name with the `"admin"` field in `auth.json`, then run
`python3 sync.py`.

**Changing the password**

```
python3 set_password.py                       # asks for both, hides typing
python3 set_password.py you@work.com 'NewPass1'
```

That writes a new random salt and a fresh PBKDF2-HMAC-SHA256 hash (250,000
iterations) into `auth.json` and refreshes the mirror. **The password itself is
never written anywhere** — only the hash, which cannot be read back. There is
deliberately no "change password" screen inside the app: resetting happens on
the machine that holds the folder.

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

**Files per dashboard**
- Attach SOPs, registers and masters to a specific dashboard — drop them on the
  card, or open the Files drawer and drop/browse there.
- List, search, open (inline preview for PDF, images, CSV/text), download,
  rename and delete.
- Files stay associated with their dashboard. Leave Procurement, open Pharmacy,
  come back — the Procurement files are still there.

**SESSION / LOCAL mode** (top right, always visible)

| | LOCAL | SESSION |
|---|---|---|
| Attached files | kept on this computer (IndexedDB) | memory only |
| Layout, theme, filters | kept (localStorage) | this tab only (sessionStorage) |
| Survives closing the app | yes | no |

Switching to SESSION starts a clean temporary workspace; your LOCAL data is not
deleted and comes back when you switch back.

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
