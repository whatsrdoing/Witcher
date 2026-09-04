/* Shared SQL-aggregation client for dashboards.
 *
 * Every dashboard historically had exactly one way to get data: the user
 * picks a file, the browser parses the whole thing, and every KPI, chart and
 * table is computed by looping over that array in JavaScript. That works, and
 * it stays the fallback for Session mode, for file:// and for any ad-hoc file
 * someone drops in -- but it means a year of a register has to be downloaded,
 * parsed and held in memory before the first number appears.
 *
 * This module offers the other route: ask the server to do the grouping and
 * totalling inside SQLite (serve.py's /__agg -> datastore.aggregate) and hand
 * back only the handful of numbers actually being drawn. A month of 20,000
 * transfers answers as a few hundred bytes rather than a 20MB export.
 *
 * The arithmetic is the same either way. datastore.aggregate() deliberately
 * mirrors the dashboards' own parseNum()/parseTransferDate() -- see its
 * comment in datastore.py -- so a figure computed here equals the figure the
 * browser would have computed from the same rows, rather than merely
 * resembling it. compare() below exists to keep proving that.
 *
 * Nothing here ever throws at a dashboard. Every failure -- no server, no
 * session, dataset not imported yet, a malformed spec -- resolves to null,
 * and the caller carries on with the upload path exactly as it does today.
 * A dashboard that cannot reach the database must still work, not break.
 */
(function (w) {
  'use strict';

  // Dashboards are served from /dashboards/<name>.html inside an iframe, so
  // the app's own routes are one level up. Matches how Store_Transfer's
  // auto-load block already addresses /__data and /__cache.
  var BASE = '../';

  function unavailable(why) {
    return { ok: false, why: why };
  }

  /* Whether the database route is usable at all, and why not when it isn't.
   *
   *  - Session mode: the whole point is that nothing touches shared storage,
   *    so a session user works only from the file they picked. The flag is
   *    set by dashboard-session-guard.js before it swaps localStorage, which
   *    is why it is read from window rather than from storage here.
   *  - file://: there is no server to ask.
   */
  function status() {
    if (w.__parasSessionMode) return unavailable('session-mode');
    if (w.location.protocol === 'file:') return unavailable('file-protocol');
    return { ok: true };
  }

  function available() {
    return status().ok;
  }

  function postJson(url, body) {
    return fetch(BASE + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || ('HTTP ' + r.status)); });
      return r.json();
    });
  }

  /* What is stored for one dataset: its periods, and how many rows in each.
   * Resolves to null rather than rejecting when there is nothing there --
   * "no data imported yet" is a normal state on a fresh install, not a fault
   * worth a console error. */
  function datasetInfo(dataset) {
    if (!available()) return Promise.resolve(null);
    return fetch(BASE + '__data').then(function (r) {
      if (!r.ok) return null;
      return r.json();
    }).then(function (data) {
      if (!data) return null;
      var list = data.datasets || data || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].dataset === dataset) {
          return (list[i].periods && list[i].periods.length) ? list[i] : null;
        }
      }
      return null;
    })['catch'](function () { return null; });
  }

  /* Which stored datasets feed this dashboard, straight from the registry
   * (dashboards.json -> each input's "dataset"), so a dashboard never has to
   * hardcode a dataset name that the Data Library might later rename.
   *
   * Returns [{label, dataset}] for the slots that have a canonical dataset,
   * skipping ad-hoc ones (a rate card, a benchmark sheet) that are only ever
   * uploaded. Duplicates are collapsed: two slots reading the same register
   * are one dataset to query.
   */
  function datasetsFor(dashboardId) {
    if (!available()) return Promise.resolve([]);
    return fetch(BASE + 'dashboards.json').then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (reg) {
      if (!reg || !reg.dashboards) return [];
      var seen = {}, out = [];
      reg.dashboards.forEach(function (d) {
        if (d.id !== dashboardId) return;
        (d.inputs || []).forEach(function (i) {
          if (i.dataset && !seen[i.dataset]) {
            seen[i.dataset] = 1;
            out.push({ label: i.label || i.dataset, dataset: i.dataset });
          }
        });
      });
      return out;
    })['catch'](function () { return []; });
  }

  /* Everything a dashboard needs to decide whether it can open straight from
   * the database: its datasets, and which of them actually have rows.
   * Resolves to {ready: false} when none do, so the caller shows its normal
   * upload prompt without having to reason about partial state. */
  function readiness(dashboardId) {
    return datasetsFor(dashboardId).then(function (list) {
      if (!list.length) return { ready: false, datasets: [], missing: [] };
      return Promise.all(list.map(function (d) {
        return datasetInfo(d.dataset).then(function (info) {
          return { label: d.label, dataset: d.dataset, info: info };
        });
      })).then(function (all) {
        var have = all.filter(function (x) { return x.info; });
        var missing = all.filter(function (x) { return !x.info; })
                          .map(function (x) { return x.label; });
        return { ready: have.length > 0, complete: missing.length === 0,
                 datasets: have, missing: missing };
      });
    });
  }

  /* One aggregation. `spec` is passed through to datastore.aggregate():
   *
   *   measures:  [{fn:'sum'|'avg'|'min'|'max'|'count'|'count_distinct'
   *                    |'sum_product', col|cols, as}]
   *   groupBy:   ['Column'] or [{col:'Transfer Date', by:'month', as:'month'}]
   *   periods:   ['2026-07', ...]        filters: {Column: 'value'}
   *   dateCol + dateFrom/dateTo          orderBy + descending + limit
   *
   * Resolves to {columns, rows} on success, or null on any failure.
   */
  function query(dataset, spec) {
    if (!available()) return Promise.resolve(null);
    return postJson('__agg/' + encodeURIComponent(dataset), spec || {})
      ['catch'](function (err) {
        // Deliberately quiet at warn level, not error: the dashboard has a
        // working fallback, so this is information, not a failure anyone
        // needs to act on mid-session.
        if (w.console && w.console.warn) w.console.warn('[agg] ' + dataset + ': ' + err.message);
        return null;
      });
  }

  /* The same aggregation as one flat object, for the common single-row case
   * (a KPI band): {notes: 5, qty: 185989, ...} instead of columns+rows. */
  function summary(dataset, spec) {
    return query(dataset, spec).then(function (out) {
      if (!out || !out.rows || !out.rows.length) return null;
      var obj = {}, row = out.rows[0];
      for (var i = 0; i < out.columns.length; i++) obj[out.columns[i]] = row[i];
      return obj;
    });
  }

  /* Rows as objects keyed by column name, for grouped results. */
  function rows(dataset, spec) {
    return query(dataset, spec).then(function (out) {
      if (!out) return null;
      return out.rows.map(function (r) {
        var o = {};
        for (var i = 0; i < out.columns.length; i++) o[out.columns[i]] = r[i];
        return o;
      });
    });
  }

  /* ---- opening straight from the database ---------------------------
   *
   * Every dashboard already knows how to read a file the user picked: it
   * validates the headers, parses the rows, and computes everything from
   * there. That code is verified against real registers and is the last
   * thing worth rewriting.
   *
   * So this does not rewrite it. It fetches the rows the database already
   * holds, restores the column headings to the exact text the dashboard
   * expects, and hands back a real File object -- which every dashboard's
   * existing parser accepts unchanged, because that is what it was always
   * given. The dashboard's arithmetic, validation and rendering are
   * untouched; only where the bytes came from is different.
   */

  /* datastore.py rewrites every heading into a safe SQL identifier at import
   * time (its slug(): non-alphanumerics to "_", trimmed, prefixed if it does
   * not start with a letter, cut to 63) and keeps no copy of the original.
   * This mirrors that exactly, so the mapping back is deterministic rather
   * than a guess. */
  function pySlug(name) {
    var s = String(name || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!s) s = 'col';
    if (!/^[A-Za-z]/.test(s)) s = 'c_' + s;
    return s.slice(0, 63);
  }

  /* The real heading text expected for one specific dataset on one specific
   * dashboard, taken from the registry's own "needs" and "keep" lists --
   * the columns that input slot declares it reads.
   *
   * Scoped to (dashboardId, dataset), not just dashboardId: two different
   * registers on the same dashboard can use headings that slug to the same
   * identifier -- Local Purchase's GRN Register needs "PO No." (with the
   * period datastore.py's slug() strips) while its Purchase Register needs
   * "PO No" (without one); both become "PO_No". Collecting every input's
   * headers into one flat list would let one clobber the other in the
   * lookup table below and silently rewrite the wrong file's column. */
  function expectedHeaders(reg, dashboardId, dataset) {
    var out = [];
    (reg.dashboards || []).forEach(function (d) {
      if (d.id !== dashboardId) return;
      (d.inputs || []).forEach(function (i) {
        if (i.dataset !== dataset) return;
        (i.needs || []).forEach(function (h) { out.push(h); });
        (i.keep || []).forEach(function (h) { out.push(h); });
      });
    });
    return out;
  }

  /* Turn the export's slugged header row back into the dashboard's own
   * wording. Only headings this dashboard actually declares are touched;
   * the export's own _period/_source/_rowno/_part columns and anything else
   * are left exactly as they are, since a parser only reads the fields it
   * names and simply ignores the rest. */
  function restoreHeaders(csvText, headers) {
    var nl = csvText.indexOf('\n');
    if (nl < 0) return csvText;
    var head = csvText.slice(0, nl);
    var map = {};
    headers.forEach(function (h) { map[pySlug(h)] = h; });
    var restored = head.split(',').map(function (cell) {
      var bare = cell.replace(/^"|"$/g, '').trim();
      var real = map[bare];
      if (!real) return cell;
      return '"' + real.replace(/"/g, '""') + '"';
    }).join(',');
    return restored + csvText.slice(nl);
  }

  /* One dataset's stored rows as a File, ready to hand to the dashboard's
   * own file handler.
   *
   * `periods` limits it to particular months -- the single most effective
   * thing a dashboard can do about memory, since a year of a register need
   * never be in the browser at once to show one month of it. Omit it for
   * everything stored.
   *
   * Resolves to null (never throws) when there is nothing to load, so the
   * caller falls through to its normal upload prompt.
   */
  function fileFor(dashboardId, dataset, periods) {
    if (!available()) return Promise.resolve(null);
    var url = BASE + '__data/' + encodeURIComponent(dataset) + '/export';
    if (periods && periods.length) url += '?periods=' + encodeURIComponent(periods.join(','));
    return Promise.all([
      fetch(url).then(function (r) { return r.ok ? r.text() : null; }),
      fetch(BASE + 'dashboards.json').then(function (r) { return r.ok ? r.json() : null; })
    ]).then(function (both) {
      var csv = both[0], reg = both[1];
      if (!csv || csv.indexOf('\n') < 0) return null;
      if (reg) csv = restoreHeaders(csv, expectedHeaders(reg, dashboardId, dataset));
      return new File([csv], dataset + '.csv', { type: 'text/csv' });
    })['catch'](function (err) {
      if (w.console && w.console.warn) w.console.warn('[agg] load ' + dataset + ': ' + err.message);
      return null;
    });
  }

  /* Open a whole dashboard from the database: for each of its datasets that
   * has rows, hand the file to `deliver(file, dataset, label)` -- whatever
   * that dashboard already calls when a user picks a file for that slot.
   *
   * Resolves to {loaded: [...], missing: [...]}; loaded empty means nothing
   * was imported and the caller should show its upload prompt as usual.
   */
  function openFromDatabase(dashboardId, deliver, periods) {
    return readiness(dashboardId).then(function (state) {
      if (!state.ready) return { loaded: [], missing: state.missing || [] };
      return Promise.all(state.datasets.map(function (d) {
        return fileFor(dashboardId, d.dataset, periods).then(function (file) {
          if (!file) return null;
          try { deliver(file, d.dataset, d.label); } catch (e) {
            if (w.console && w.console.warn) w.console.warn('[agg] deliver ' + d.dataset + ': ' + e.message);
            return null;
          }
          return d.dataset;
        });
      })).then(function (done) {
        return { loaded: done.filter(Boolean), missing: state.missing || [] };
      });
    });
  }

  /* Development aid, and the reason to trust any of this: run the same
   * question against the database and against rows already in the browser,
   * and report every figure that disagrees.
   *
   * `local` is an object of the same shape summary() returns. Differences
   * within `epsilon` are treated as equal, because floating-point addition
   * in a different order is not an error -- a genuinely different number is.
   * Returns {match: true} or {match: false, diffs: [...]}. */
  function compare(local, remote, epsilon) {
    var eps = epsilon === undefined ? 0.005 : epsilon;
    if (!local || !remote) return { match: false, diffs: [{ key: '*', reason: 'missing side' }] };
    var diffs = [];
    Object.keys(local).forEach(function (k) {
      if (!(k in remote)) { diffs.push({ key: k, reason: 'absent in database result' }); return; }
      var a = Number(local[k]), b = Number(remote[k]);
      if (isNaN(a) || isNaN(b)) {
        if (String(local[k]) !== String(remote[k])) diffs.push({ key: k, browser: local[k], database: remote[k] });
      } else if (Math.abs(a - b) > eps) {
        diffs.push({ key: k, browser: a, database: b, delta: a - b });
      }
    });
    return diffs.length ? { match: false, diffs: diffs } : { match: true };
  }

  w.parasAgg = {
    available: available,
    status: status,
    datasetInfo: datasetInfo,
    datasetsFor: datasetsFor,
    readiness: readiness,
    fileFor: fileFor,
    openFromDatabase: openFromDatabase,
    query: query,
    summary: summary,
    rows: rows,
    compare: compare
  };
})(window);
