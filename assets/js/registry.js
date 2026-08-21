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
        owner: d.owner || ''
      };
    });

    categories.sort(function (a, b) { return a.order - b.order; });

    return {
      app: app,
      categories: categories,
      categoryById: byId,
      dashboards: dashboards,
      warnings: warnings,
      source: raw.__source || 'unknown'
    };
  }

  /* Loads dashboards.json when the page is served over http(s).
     Falls back to the dashboards.js mirror, which is what makes a plain
     double-click of index.html (file://) work in every browser. */
  function load() {
    var mirror = w.__PARAS_REGISTRY__ || null;
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
        if (mirror) {
          var m = JSON.parse(JSON.stringify(mirror));
          m.__source = 'dashboards.js (offline mirror)';
          return normalise(m);
        }
        var reg = normalise({});
        reg.loadError = String(err && err.message || err);
        return reg;
      });
  }

  function stripMeta(o) {
    var c = JSON.parse(JSON.stringify(o)); delete c.__source; delete c.$comment; return c;
  }

  w.Registry = { load: load, normalise: normalise, slug: slug };
})(window);
