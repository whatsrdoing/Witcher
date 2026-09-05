/* Proves the database and the browser compute the same figures.
 *
 *   node test_sql_matches_browser.js            # needs a running server
 *   PARAS_TEST_BASE=http://127.0.0.1:8951/supply-chain/command-centre \
 *   PARAS_TEST_ADMIN='admin/ritik' PARAS_TEST_PW='TestPass123!x' \
 *     node test_sql_matches_browser.js
 *
 * Every dashboard here reduces an array of parsed rows in JavaScript. Moving
 * any of that into SQL is only safe if the two agree exactly -- and "exactly"
 * has to be checked against the messy shapes a real register has (lakh
 * commas, blank cells, text where a number belongs, dd-mm-yyyy dates), not
 * just against tidy data, because the arithmetic is not where they diverge.
 * The mapping between a heading and a column is.
 *
 * So this drives a real browser with real rows loaded, and for each of a
 * spread of filter states asks the same question both ways:
 *
 *   - the browser, using the dashboard's own filter helpers and its own
 *     parseNum(), over the rows it has actually parsed;
 *   - SQLite, through /__agg, using the equivalent aggregate spec.
 *
 * A disagreement here is a real defect regardless of which side is wrong, so
 * the test reports the figure, both answers, and the filter that produced
 * them rather than just failing.
 */
'use strict';
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.PARAS_TEST_BASE
  || 'http://127.0.0.1:8951/supply-chain/command-centre';
const LOGIN = process.env.PARAS_TEST_ADMIN || 'admin/ritik';
const PW = process.env.PARAS_TEST_PW || 'TestPass123!x';
const DATASET = 'stock-transfer';

let passed = 0, failed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + label); }
  else { failed++; console.log('  FAIL  ' + label + (detail ? '  -- ' + detail : '')); }
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

async function signIn(page) {
  await page.goto(BASE + '/');
  await page.waitForTimeout(1000);
  await page.fill('#gateEmail', LOGIN);
  await page.click('#gateSubmit');
  await page.waitForTimeout(1200);
  // A previous run may still hold the single allowed session.
  for (const _ of [0, 1]) {
    const c = await page.$('#conflictForceBtn');
    if (c && await c.isVisible()) { await c.click(); await page.waitForTimeout(1500); }
    const pw = await page.$('#gatePass');
    if (pw && await pw.isVisible()) {
      await page.fill('#gatePass', PW);
      await page.click('#gateSubmit');
      await page.waitForTimeout(2000);
    }
  }
  const status = await page.evaluate(async () => (await fetch('__data')).status);
  if (status !== 200) throw new Error('sign-in failed (/__data -> ' + status + ')');
}

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await b.newPage();
  try {
    await signIn(page);
    await page.goto(BASE + '/dashboards/Store_Transfer_Dashboard.html');
    // Wait for the real rows, not the instant paint -- the browser side of
    // the comparison has to be the dashboard's own parsed rows.
    // rawRows is declared with let, so it is a script-scope binding and
    // never becomes a window property -- reading window.rawRows silently
    // yields nothing and would compare the database against an empty array.
    // getUnitFiltered() is a function declaration, so it *is* reachable, and
    // with no unit filter applied it returns exactly those rows.
    await page.waitForFunction(
      () => typeof window.getUnitFiltered === 'function' && window.getUnitFiltered().length > 0,
      null, { timeout: 30000 }).catch(() => {});
    const n = await page.evaluate(
      () => (typeof window.getUnitFiltered === 'function' ? window.getUnitFiltered() : []).length);
    check('the dashboard has parsed rows to compare against', n > 0, 'got ' + n);
    if (!n) throw new Error('no rows loaded; seed the dataset first');

    // The dashboard now opens on the newest stored month alone, so the
    // database side has to be asked about that same month -- otherwise this
    // compares one month of parsed rows against every month in the store and
    // reports the difference as a defect.
    const period = await page.evaluate(async (ds) => {
      const info = await window.parasAgg.datasetInfo(ds);
      const ps = ((info && info.periods) || []).map(p => p.period).sort();
      return ps.length ? ps[ps.length - 1] : null;
    }, DATASET);
    check('the month under comparison is known', !!period, 'got ' + period);
    const scope = period ? { periods: [period] } : {};

    const stores = await page.evaluate(() => window.getStores ? window.getStores() : []);
    const filters = [
      { name: 'no filter', spec: {}, js: null },
      { name: 'July only', spec: { dateCol: 'Transfer Date', dateFrom: '2026-07-01', dateTo: '2026-07-31' },
        js: { from: '2026-07-01', to: '2026-07-31' } },
      { name: 'one day', spec: { dateCol: 'Transfer Date', dateFrom: '2026-07-05', dateTo: '2026-07-05' },
        js: { from: '2026-07-05', to: '2026-07-05' } },
      { name: 'a range with no rows', spec: { dateCol: 'Transfer Date', dateFrom: '1999-01-01', dateTo: '1999-01-02' },
        js: { from: '1999-01-01', to: '1999-01-02' } },
    ];
    if (stores.length) {
      // trim: true, matching how sqlDefaultViewPayload groups stores --
      // getStores() returns already-trimmed names (rawRows itself only ever
      // holds trimmed values), so a plain untrimmed IN would undercount
      // against any row whose stored value has incidental whitespace.
      filters.push({ name: 'one from-store',
                     spec: { filters: { 'From Store': { in: [stores[0]], trim: true } } },
                     js: { fromStores: [stores[0]] } });
      if (stores.length > 1) {
        filters.push({ name: 'two from-stores',
                       spec: { filters: { 'From Store': { in: [stores[0], stores[1]], trim: true } } },
                       js: { fromStores: [stores[0], stores[1]] } });
      }
    }

    // getUnitFiltered() reflects rawRows, and rawRows never contained a row
    // with a blank From Store or To Store in the first place -- parseCsvText
    // drops those before rawRows is ever built (see its comment, around line
    // 1531), not merely at display time. So the browser side of every
    // comparison below is already "real transfers only", and the database
    // side has to ask the identical question -- the same not_blank filter
    // sqlDefaultViewPayload() uses -- or a register with even one blank-store
    // row makes this test compare two different definitions of "all rows"
    // and call the gap a defect in SQLite when the gap is in the test.
    const NOT_BLANK = { 'From Store': { not_blank: true }, 'To Store': { not_blank: true } };

    for (const f of filters) {
      // --- the browser's own answer, using its own parseNum ---------------
      const js = await page.evaluate((sel) => {
        const rows = window.getUnitFiltered().filter(r => {
          if (sel && sel.from && (!r.dateKey || r.dateKey < sel.from)) return false;
          if (sel && sel.to && (!r.dateKey || r.dateKey > sel.to)) return false;
          if (sel && sel.fromStores && sel.fromStores.indexOf(r.fromStore) < 0) return false;
          return true;
        });
        const notes = new Set(), items = {};
        let qty = 0, epr = 0;
        rows.forEach(r => {
          qty += r.qty; epr += r.totalEpr;
          if (r.transferNo) notes.add(r.transferNo);
          items[r.itemName] = (items[r.itemName] || 0) + r.qty;
        });
        const top = Object.entries(items).sort((a, b) => b[1] - a[1])[0] || [null, 0];
        return { lineItems: rows.length, notes: notes.size, qty: qty, epr: epr,
                 topItem: top[0], topQty: top[1] };
      }, f.js);

      // --- SQLite's answer, same question ---------------------------------
      // A case's own filters (an IN-list on From Store, say) replace the
      // default not_blank for that one column -- the IN-list already can
      // never match a blank value -- and leave the other column's not_blank
      // in place.
      const mergedFilters = Object.assign({}, NOT_BLANK, (f.spec && f.spec.filters) || {});
      const sqlSpec = Object.assign({}, scope, {
        measures: [
          { fn: 'count', as: 'lineItems' },
          { fn: 'count_distinct', col: 'Transfer No.', as: 'notes' },
          { fn: 'sum', col: 'Transfered Qty.', as: 'qty' },
          { fn: 'sum_product', cols: ['Transfered Qty.', 'EPR'], as: 'epr' }
        ]
      }, f.spec, { filters: mergedFilters });
      const sql = await page.evaluate(
        async ([ds, spec]) => await window.parasAgg.summary(ds, spec), [DATASET, sqlSpec]);

      check(f.name + ' — line items', sql && sql.lineItems === js.lineItems,
            'browser ' + js.lineItems + ' vs database ' + (sql && sql.lineItems));
      check(f.name + ' — transfer notes', sql && sql.notes === js.notes,
            'browser ' + js.notes + ' vs database ' + (sql && sql.notes));
      check(f.name + ' — total quantity', sql && near(sql.qty || 0, js.qty),
            'browser ' + js.qty + ' vs database ' + (sql && sql.qty));
      check(f.name + ' — total EPR value', sql && near(sql.epr || 0, js.epr),
            'browser ' + js.epr + ' vs database ' + (sql && sql.epr));

      // The top item by quantity: a grouped question, not just a total, so
      // it catches a grouping or ordering difference a sum would hide.
      if (js.topItem) {
        const topSpec = Object.assign({}, scope, {
          measures: [{ fn: 'sum', col: 'Transfered Qty.', as: 'qty' }],
          // trim: true -- parseCsvText assigns itemName as
          // (r['Item Name']||'').trim(), so the browser side above is
          // already grouping on the trimmed value; asking SQL to group on
          // the raw column would split a whitespace-padded item into its
          // own row and this comparison would call that a defect in
          // SQLite when the gap is really in the question this test asks.
          groupBy: [{ col: 'Item Name', trim: true }], orderBy: 'qty', descending: true, limit: 1
        }, f.spec, { filters: mergedFilters });
        const top = await page.evaluate(
          async ([ds, spec]) => await window.parasAgg.rows(ds, spec), [DATASET, topSpec]);
        const row = top && top[0];
        // Compared on the total, not on which name came first: when two
        // items tie, "the largest" has no single right answer and JavaScript
        // and SQLite are both entitled to break it differently.
        check(f.name + ' — largest item total',
              !!row && near(row.qty, js.topQty),
              'browser ' + js.topItem + '/' + js.topQty
              + ' vs database ' + (row && row['Item Name']) + '/' + (row && row.qty));
      }
    }
    // --- the other registers ------------------------------------------
    //
    // Store Transfer is compared against the dashboard's own parsed rows
    // above. The rest have no such array to reach into, so the browser side
    // here parses the same export the dashboard would have been given and
    // totals it with the same parseNum() rule the dashboards use. That still
    // answers the question that matters: does SQLite total this register the
    // way the browser would.
    var others = [
      { ds: 'grn-register', num: 'Received Qty.', pair: ['Received Qty.', 'EPR'],
        distinct: 'GRN No.', group: 'Item Name' },
      { ds: 'purchase-register', num: 'PO Amount', pair: null,
        distinct: 'PO No', group: 'Status' }
    ];
    for (const o of others) {
      const info = await page.evaluate(async (ds) => await window.parasAgg.datasetInfo(ds), o.ds);
      if (!info) { console.log('  SKIP  ' + o.ds + ' (not imported)'); continue; }

      const local = await page.evaluate(async ([ds, o]) => {
        // Same rule every dashboard's parseNum() uses: strip commas, then
        // parseFloat, and treat anything unparseable as 0.
        const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '').trim());
                           return isNaN(n) ? 0 : n; };
        const txt = await (await fetch('../__data/' + ds + '/export?headings=original&meta=0')).text();
        // The export writes CRLF, so a plain split('\n') leaves a trailing
        // "\r" on every line -- invisible on the last column, which then
        // never matches its real heading (at(o.num) returns -1, quietly
        // zeroing every figure that depends on it) or its real value.
        const lines = txt.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim().length);
        const split = l => { const out = []; let cur = '', q = false;
          for (let i = 0; i < l.length; i++) { const c = l[i];
            if (c === '"') { if (q && l[i+1] === '"') { cur += '"'; i++; } else q = !q; }
            else if (c === ',' && !q) { out.push(cur); cur = ''; } else cur += c; }
          out.push(cur); return out; };
        const head = split(lines[0]).map(h => h.replace(/^"|"$/g, ''));
        const rows = lines.slice(1).map(split);
        const at = name => head.indexOf(name);
        const iNum = at(o.num), iA = o.pair ? at(o.pair[0]) : -1, iB = o.pair ? at(o.pair[1]) : -1;
        const iD = at(o.distinct), iG = at(o.group);
        let sum = 0, prod = 0; const seen = new Set(), groups = {};
        rows.forEach(r => {
          if (iNum >= 0) sum += num(r[iNum]);
          if (iA >= 0 && iB >= 0) prod += num(r[iA]) * num(r[iB]);
          if (iD >= 0 && String(r[iD] || '').trim()) seen.add(r[iD]);
          if (iG >= 0) groups[r[iG]] = (groups[r[iG]] || 0) + 1;
        });
        const top = Object.entries(groups).sort((a, b) => b[1] - a[1])[0] || [null, 0];
        return { n: rows.length, sum: sum, prod: prod, distinct: seen.size,
                 headerHasNum: iNum >= 0, topGroup: top[0], topCount: top[1] };
      }, [o.ds, o]);

      check(o.ds + ' — the export carries the heading the dashboard reads (' + o.num + ')',
            local.headerHasNum, 'header did not contain it');

      const ms = [{ fn: 'count', as: 'n' },
                  { fn: 'sum', col: o.num, as: 'sum' },
                  { fn: 'count_distinct', col: o.distinct, as: 'distinct' }];
      if (o.pair) ms.push({ fn: 'sum_product', cols: o.pair, as: 'prod' });
      const sql = await page.evaluate(async ([ds, ms]) =>
        await window.parasAgg.summary(ds, { measures: ms }), [o.ds, ms]);

      check(o.ds + ' — row count', sql && sql.n === local.n,
            'browser ' + local.n + ' vs database ' + (sql && sql.n));
      check(o.ds + ' — sum of ' + o.num, sql && near(sql.sum || 0, local.sum),
            'browser ' + local.sum + ' vs database ' + (sql && sql.sum));
      check(o.ds + ' — distinct ' + o.distinct, sql && sql.distinct === local.distinct,
            'browser ' + local.distinct + ' vs database ' + (sql && sql.distinct));
      if (o.pair) {
        check(o.ds + ' — ' + o.pair.join(' x '), sql && near(sql.prod || 0, local.prod),
              'browser ' + local.prod + ' vs database ' + (sql && sql.prod));
      }
      if (local.topGroup) {
        const g = await page.evaluate(async ([ds, col]) => await window.parasAgg.rows(ds,
          { measures: [{ fn: 'count', as: 'n' }], groupBy: [col], orderBy: 'n', descending: true, limit: 1 }),
          [o.ds, o.group]);
        const row = g && g[0];
        check(o.ds + ' — largest group size by ' + o.group,
              !!row && row.n === local.topCount,
              'browser ' + local.topGroup + '/' + local.topCount
              + ' vs database ' + (row && row[o.group]) + '/' + (row && row.n));
      }
    }
  } catch (e) {
    failed++;
    console.log('  FAIL  harness: ' + e.message);
  } finally {
    await b.close();
  }
  console.log('\n%d passed, %d failed', passed, failed);
  process.exit(failed === 0 ? 0 : 1);
})();
