/* Registry loader.
   Source of truth: dashboards.json
   file:// fallback: dashboards.js (a generated mirror — run `python3 sync.py`)
   Everything except name / category / file is optional and gets a sane default. */
(function (w) {
  'use strict';

  var DEFAULT_APP = {
    org: 'PARAS HEALTH',
    title: 'Supply Chain Command Centre',
    tagline: '',
    defaultMode: 'local',
    defaultTheme: 'dark'
  };
  var DEFAULT_CATEGORY = { icon: 'grid', accent: '#7B8792' };
  var STATUSES = ['live', 'beta', 'planned', 'archived'];

  function slug(s) {
    return String(s).toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
  }

  function normalise(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var warnings = [];

    var app = Object.assign({}, DEFAULT_APP, raw.app || {});

    var cats = Array.isArray(raw.categories) ? raw.categories : [];
    var byId = Object.create(null);
    var categories = cats.map(function (c, i) {
      var id = c.id || slug(c.name || 'category-' + i);
      var cat = Object.assign({}, DEFAULT_CATEGORY, c, {
        id: id,
        name: c.name || id,
        order: typeof c.order === 'number' ? c.order : i + 1
      });
      byId[id] = cat;
      return cat;
    });

    var seen = Object.create(null);
    var list = Array.isArray(raw.dashboards) ? raw.dashboards : [];
    var dashboards = list.map(function (d, i) {
      d = d && typeof d === 'object' ? d : {};
      var name = d.name || d.title || 'Untitled dashboard ' + (i + 1);
      var id = d.id || slug(name);
      if (seen[id]) { warnings.push('Duplicate dashboard id "' + id + '" — later entry renamed.'); id = id + '-' + (i + 1); }
      seen[id] = true;

      var catId = d.category ? slug(d.category) : 'other';
      if (!byId[catId]) {
        // Unknown category in a dashboard entry: create it on the fly so the
        // card never disappears just because the category list wasn't updated.
        var made = Object.assign({}, DEFAULT_CATEGORY, {
          id: catId, name: d.category || 'Other', order: 900 + categories.length
        });
        byId[catId] = made; categories.push(made);
        if (d.category) warnings.push('Category "' + d.category + '" is not declared in "categories" — using defaults.');
      }
      var cat = byId[catId];

      var status = STATUSES.indexOf(d.status) >= 0 ? d.status : (d.file ? 'live' : 'planned');
      if (!d.file && status !== 'planned' && status !== 'archived') {
        warnings.push('"' + name + '" has no "file" — shown as planned.');
        status = 'planned';
      }

      return {
        id: id,
        name: name,
        category: catId,
        categoryName: cat.name,
        accent: d.accent || cat.accent,
        description: d.description || '',
        file: d.file || '',
        icon: d.icon || cat.icon,
        status: status,
        order: typeof d.order === 'number' ? d.order : i + 1,
        tags: Array.isArray(d.tags) ? d.tags : [],
        owner: d.owner || '',
        // Hidden from the grid entirely for every account except admin --
        // toggled from the admin panel, never a raw file edit. Filtered out
        // of REG.dashboards itself in app.js's boot() for a non-admin
        // session, before anything renders, rather than merely hidden with
        // CSS -- so it never lands in the DOM for a regular account at all.
        adminOnly: !!d.adminOnly,
        // What this dashboard's own upload boxes expect, used to route files
        // out of the shared Data Library. Optional — matching falls back to
        // the labels read live from the dashboard itself.
        inputs: Array.isArray(d.inputs) ? d.inputs.map(function (x, k) {
          return {
            label: x.label || ('File ' + (k + 1)),
            needs: Array.isArray(x.needs) ? x.needs : [],
            match: Array.isArray(x.match) ? x.match : [],
            accept: x.accept || '',
            optional: !!x.optional,
            auto: x.auto !== false,     // false keeps it out of one-click fill
            // Every column this dashboard reads. Used to pre-tick the right
            // boxes when condensing an oversized export.
            keep: Array.isArray(x.keep) ? x.keep : []

          };
        }) : []
      };
    });

    categories.sort(function (a, b) { return a.order - b.order; });

    // Sections of the Data Library. Each one files its contents into its own
    // table, so registers of different shapes never land in the same place.
    var datasets = (Array.isArray(raw.datasets) ? raw.datasets : []).map(function (x, i) {
      return {
        id: String(x.id || ('dataset' + i)),
        name: String(x.name || x.id || ('Section ' + (i + 1))),
        hint: String(x.hint || ''),
        // Columns a file of this kind really has, so one dropped into the
        // wrong section can be spotted from its header row.
        needs: Array.isArray(x.needs) ? x.needs : [],
        // A register that arrives split across several files for one month
        // (COGS: department consumption, IP pharmacy, OP pharmacy). Each part
        // gets its own drop box and is replaced independently.
        parts: (Array.isArray(x.parts) ? x.parts : [])
          .map(function (pt, k) {
            return { id: String(pt.id || ('part' + (k + 1))),
                     name: String(pt.name || pt.id || ('Part ' + (k + 1))) };
          })
          .filter(function (pt) { return pt.id; })
      };
    });

    return {
      app: app,
      categories: categories,
      categoryById: byId,
      dashboards: dashboards,
      datasets: datasets,
      warnings: warnings,
      source: raw.__source || 'unknown'
    };
  }

  /* Loads dashboards.json when the page is served over http(s).
     Falls back to the dashboards.js mirror, which is what makes a plain
     double-click of index.html (file://) work in every browser. */
  function load() {
    var mirror = w.__PARAS_REGISTRY__ || null;
    // file:// cannot fetch a local .json — use the mirror without the failed
    // request and its console error.
    if (location.protocol === 'file:' && mirror) return Promise.resolve(fromMirror(mirror));
    return fetch('dashboards.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (json) {
        json.__source = 'dashboards.json';
        var reg = normalise(json);
        if (mirror && JSON.stringify(stripMeta(mirror)) !== JSON.stringify(stripMeta(json))) {
          reg.warnings.push('dashboards.js mirror is out of date — run "python3 sync.py" to refresh it.');
        }
        return reg;
      })
      .catch(function (err) {
        if (mirror) return fromMirror(mirror);
        var reg = normalise({});
        reg.loadError = String(err && err.message || err);
        return reg;
      });
  }

  function fromMirror(mirror) {
    var m = JSON.parse(JSON.stringify(mirror));
    m.__source = 'dashboards.js (offline mirror)';
    return normalise(m);
  }

  function stripMeta(o) {
    var c = JSON.parse(JSON.stringify(o)); delete c.__source; delete c.$comment; return c;
  }

  w.Registry = { load: load, normalise: normalise, slug: slug };
})(window);
