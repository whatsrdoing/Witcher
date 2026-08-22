# Adding a dashboard

The whole process is: **drop the file in, add one entry, sync, reload.**
You never edit JavaScript.

---

## The four steps

**1. Put your HTML file in `dashboards/`**

```
dashboards/Inventory_Ageing_Dashboard.html
```

Nothing about the file needs to change. Keep its own CSS, its own scripts,
its own everything. If it loads a library from the internet, see
[Keeping it offline](#keeping-it-offline) below.

**2. Add one entry to `dashboards.json`**

Append it to the `"dashboards"` array:

```json
{
  "name": "Inventory Ageing",
  "category": "inventory",
  "description": "Slow-moving and expiring stock by store and category.",
  "file": "dashboards/Inventory_Ageing_Dashboard.html",
  "icon": "boxes",
  "status": "live",
  "order": 2,
  "tags": ["ageing", "expiry", "slow moving"]
}
```

Only `name`, `category` and `file` are actually required:

```json
{ "name": "Inventory Ageing", "category": "inventory", "file": "dashboards/Inventory_Ageing_Dashboard.html" }
```

**3. Run the sync**

```
python3 sync.py
```

This regenerates `dashboards.js` (the mirror that makes `file://` work) and
prints any problems it finds — a bad path, a duplicate id, an undeclared
category. `python3 serve.py` runs it for you on start, so you can skip this
step if you always launch that way.

**4. Reload the Command Centre.** The card is there.

---

## Feeding it from the Data Library

Add an `inputs` array to route library files into the dashboard's own upload
boxes, **listed in the order those boxes appear in the dashboard**:

```json
"inputs": [
  { "label": "Purchase Register",
    "needs": ["UNIT", "Item Code", "PO No", "Status"],
    "match": ["purchase\\s*register"] },
  { "label": "GRN Register",
    "needs": ["UNIT", "Item Code", "Received Qty.", "GRN No."],
    "match": ["\\bgrn\\b"] }
]
```

| Key | Meaning |
|---|---|
| `label` | Shown in the match bar and on file chips. |
| `needs` | Column headers this box expects. Files are read on arrival and matched against these — the strongest signal by far. |
| `match` | Optional regexes tried against the filename. |
| `optional` | `true` keeps it out of the "required" count. |
| `auto` | `false` keeps it out of one-click fill; the file can still be sent by hand. |

Reuse the same `label` and `needs` across dashboards that take the same export
— that is what lets one GRN file feed three dashboards. If a dashboard renders
the same upload box twice, list it twice.

Leave `inputs` out entirely and the dashboard still works; it just will not
appear in the auto-fill.

`sync.py` also appends a short `<!-- paras-command-centre-bridge -->` block to
each dashboard. That is what lets the Command Centre place a file in an upload
box when the app is opened straight from disk. It is invisible, idempotent, and
safe to delete if you want a dashboard untouched — you lose only the one-click
fill for that one.

## Field reference

| Field | Required | Default | Notes |
|---|---|---|---|
| `name` | ✔ | — | Card title. Also what search matches first. |
| `category` | ✔ | `other` | Must match a `categories[].id`, or one is created for you. |
| `file` | ✔* | — | Path relative to `index.html`. *Optional when `status` is `planned`. |
| `id` | | slug of `name` | URL key: `index.html#/d/<id>`. Set it once and don't change it — layout and attached files are keyed to it. |
| `description` | | empty | One or two lines on the card. |
| `icon` | | the category's icon | Any key from `assets/js/icons.js`. |
| `status` | | `live` | `live`, `beta`, `planned`, `archived`. |
| `order` | | position in the file | Sorts within its category. |
| `tags` | | `[]` | Extra search terms. Not shown on the card. |
| `inputs` | | `[]` | Upload boxes, in DOM order — see above. |
| `owner` | | empty | Searchable. Useful for "whose dashboard is this". |
| `accent` | | the category's accent | Override the card colour for this one card. |

### Statuses

- **`live`** — normal, opens.
- **`beta`** — opens, carries an amber badge.
- **`planned`** — a placeholder card reading *Coming soon*, Open disabled. Use
  this to hold a slot for a dashboard you are still building; you can leave the
  intended `file` path in the entry.
- **`archived`** — greyed out, still opens.

---

## Categories

Categories live in the same file:

```json
{ "id": "inventory", "name": "Inventory", "icon": "boxes", "accent": "#A78BFA", "order": 3 }
```

`accent` drives the card's colour, icon tint and top rule. `order` controls
where the category's cards sit on the home page and where its filter chip
appears.

You can invent a category on the spot — put `"category": "logistics"` on a
dashboard without declaring it, and the Command Centre creates a grey
"Logistics" category rather than dropping the card. `sync.py` will point it out
so you can declare it properly when you have a minute.

---

## Icons

Built in: `cart` `pill` `boxes` `truck` `shield` `clipboard` `chart`
`trending` `users` `handshake` `flask` `grid` `file` `folder` `layers`
`inbox` `bolt` `lock` `search` `home` `check` `warn` `info`

To add one, append a path to `assets/js/icons.js`:

```js
syringe: '<path d="M4 20l4-4"/><path d="M8 16l8-8 4 4-8 8z"/>',
```

Draw it on a 24×24 grid, strokes only — the shell supplies colour and width.
Then use `"icon": "syringe"`.

---

## Keeping it offline

The Command Centre never touches the network, and your dashboards shouldn't
either. If a new dashboard has a `<script src="https://…">` or an
`@import url('https://fonts.googleapis.com/…')`:

1. Download the file once, on a machine with internet.
2. Drop it in `assets/vendor/`.
3. Change the one line in the dashboard to point at it:

```html
<!-- before -->
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1"></script>
<!-- after -->
<script src="../assets/vendor/chart.umd-4.5.1.js"></script>
```

`assets/vendor/` already has Chart.js 4.5.1 and 4.4.1, PapaParse 5.4.1,
SheetJS 0.18.5, and Space Grotesk + IBM Plex Mono, so a new dashboard using any
of those can just point at them. Filenames carry the version, so two dashboards
built against different releases of the same library can coexist — keep that
convention when you add one (`chart.umd-4.6.0.js`, not `chart.umd.js`).

A quick check for leftovers:

```
grep -o 'https\?://[^"]*' dashboards/Your_New_Dashboard.html | grep -v -E 'w3\.org|openxmlformats|purl\.org|oasis-open|sheetjs\.com|schemas\.microsoft'
```

(The excluded ones are XML namespace strings inside bundled libraries — they
are identifiers, never fetched.)

---

## Removing or renaming

- **Remove** — delete the entry from `dashboards.json` and run `sync.py`. Files
  you attached to it stay in the browser's storage but are no longer reachable;
  to clear them, delete them from the drawer before removing the entry.
- **Rename the display name** — change `name`, keep `id`. Layout position and
  attached files are preserved.
- **Change the id** — the card is treated as brand new: it loses its position
  in your layout and its attached files. Avoid unless you mean it.

---

## Troubleshooting

**A card is missing.** Run `python3 sync.py` — it names the problem. If the
JSON is malformed the app falls back to the last good `dashboards.js` mirror,
which is why an edit can appear to do nothing.

**The card is there but the dashboard is blank.** The `file` path is wrong, or
it's an absolute path. It must be relative to `index.html`, e.g.
`dashboards/My_Dashboard.html`.

**Edits to `dashboards.json` aren't showing.** You opened `index.html` by
double-clicking, so the app is reading the `dashboards.js` mirror. Run
`python3 sync.py`, or launch with `python3 serve.py` instead.

**Attached files disappear after closing.** Either you're in SESSION mode
(check the top-right switch), or you're on `file://` in a browser that blocks
IndexedDB. Use `python3 serve.py`.
