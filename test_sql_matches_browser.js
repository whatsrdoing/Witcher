/* Proves the database and the browser compute the same figures.
 *
 *   node test_sql_matches_browser.js            # needs a running server
 *   PARAS_TEST_BASE=http://127.0.0.1:8931/supply-chain/command-centre \
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
  || 'http://127.0.0.1:8931/supply-chain/command-centre';
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
      filters.push({ name: 'one from-store', spec: { filters: { 'From Store': [stores[0]] } },
                     js: { fromStores: [stores[0]] } });
      if (stores.length > 1) {
        filters.push({ name: 'two from-stores',
                       spec: { filters: { 'From Store': [stores[0], stores[1]] } },
                       js: { fromStores: [stores[0], stores[1]] } });
      }
    }

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
      const sqlSpec = Object.assign({
        measures: [
          { fn: 'count', as: 'lineItems' },
          { fn: 'count_distinct', col: 'Transfer No.', as: 'notes' },
          { fn: 'sum', col: 'Transfered Qty.', as: 'qty' },
          { fn: 'sum_product', cols: ['Transfered Qty.', 'EPR'], as: 'epr' }
        ]
      }, f.spec);
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
        const topSpec = Object.assign({
          measures: [{ fn: 'sum', col: 'Transfered Qty.', as: 'qty' }],
          groupBy: ['Item Name'], orderBy: 'qty', descending: true, limit: 1
        }, f.spec);
        const top = await page.evaluate(
          async ([ds, spec]) => await window.parasAgg.rows(ds, spec), [DATASET, topSpec]);
        const row = top && top[0];
        check(f.name + ' — top item by quantity',
              !!row && row['Item Name'] === js.topItem && near(row.qty, js.topQty),
              'browser ' + js.topItem + '/' + js.topQty
              + ' vs database ' + (row && row['Item Name']) + '/' + (row && row.qty));
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
