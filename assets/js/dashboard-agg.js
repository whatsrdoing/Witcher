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
    query: query,
    summary: summary,
    rows: rows,
    compare: compare
  };
})(window);
