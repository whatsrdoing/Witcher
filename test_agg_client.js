/* Checks the dashboard-side aggregation client's pure logic.
 *
 *   node test_agg_client.js
 *
 * assets/js/dashboard-agg.js had no test of any kind, and the one bug that
 * reached a dashboard from it was a silent one: a header the restoration map
 * got wrong became a column the dashboard could not find, which reads as
 * blank rather than raising, so every figure derived from it quietly became
 * zero while the dashboard still reported a successful load.
 *
 * The module is a browser IIFE that assigns window.parasAgg, so it is loaded
 * here against a minimal window stub. Only the parts that need no network are
 * exercised -- slugging, header restoration, per-dataset scoping, the
 * browser-vs-database comparison, and the parts check -- which is exactly
 * where that class of bug lives.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + label); }
  else { failed++; console.log('  FAIL  ' + label + (detail ? '  -- ' + detail : '')); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- load the module against a stub window -------------------------------
const src = fs.readFileSync(path.join(__dirname, 'assets', 'js', 'dashboard-agg.js'), 'utf8');
const win = { location: { protocol: 'http:' }, console: { warn() {} } };
win.window = win;
vm.createContext(win);
vm.runInContext(src, win);
const agg = win.parasAgg;

check('the module defines window.parasAgg', !!agg);
check('it exposes the documented surface',
  ['available', 'status', 'datasetInfo', 'datasetsFor', 'readiness', 'fileFor',
   'openFromDatabase', 'query', 'summary', 'rows', 'compare']
    .every(k => typeof agg[k] === 'function'));

// --- availability ---------------------------------------------------------
check('available() is true over http with no session flag', agg.available() === true);
win.__parasSessionMode = true;
check('Session mode reports unavailable, with a reason',
  agg.available() === false && agg.status().why === 'session-mode');
delete win.__parasSessionMode;
win.location.protocol = 'file:';
check('file:// reports unavailable, with a reason',
  agg.available() === false && agg.status().why === 'file-protocol');
win.location.protocol = 'http:';
check('available() is true again once neither applies', agg.available() === true);

// --- compare(): the guard that proves SQL and the browser agree -----------
check('compare() matches identical figures',
  agg.compare({ qty: 10, epr: 2.5 }, { qty: 10, epr: 2.5 }).match === true);
check('compare() reports a genuinely different figure',
  agg.compare({ qty: 10 }, { qty: 11 }).match === false);
check('compare() tolerates float noise, which is not a difference',
  agg.compare({ epr: 188932.0000001 }, { epr: 188932 }).match === true);
check('compare() flags a key the database did not return',
  agg.compare({ qty: 1, notes: 5 }, { qty: 1 }).diffs.some(d => d.key === 'notes'));
check('compare() treats a missing side as a mismatch, not a pass',
  agg.compare(null, { qty: 1 }).match === false);

// --- slugging must mirror datastore.py's slug() exactly -------------------
const { pySlug, restoreHeaders, expectedHeaders, partsComplete, periodsOf } = agg._internal;
[['PO Amount', 'PO_Amount'], ['PO Qty.', 'PO_Qty'], ['EPR.', 'EPR'], ['GST %', 'GST'],
 ['Item/Code', 'Item_Code'], ['2nd Approver', 'c_2nd_Approver'], ['UNIT', 'UNIT'],
 ['', 'col'], ['   ', 'col']].forEach(([input, want]) => {
  check('pySlug(' + JSON.stringify(input) + ') === ' + JSON.stringify(want),
    pySlug(input) === want, 'got ' + JSON.stringify(pySlug(input)));
});

// --- header restoration, scoped per dataset ------------------------------
// The bug this pins down: Local Purchase's GRN Register needs "PO No." and
// its Purchase Register needs "PO No" -- both slug to PO_No. Collected into
// one flat list, whichever came last silently renamed the other file's column.
const reg = {
  dashboards: [{
    id: 'local-purchase',
    inputs: [
      { dataset: 'grn-register', needs: ['GRN No.', 'PO No.'], keep: [] },
      { dataset: 'purchase-register', needs: ['PO No', 'Status'], keep: [] }
    ]
  }],
  datasets: [{ id: 'cogs', parts: [{ id: 'dept' }, { id: 'ip' }, { id: 'op' }] },
             { id: 'grn-register' }]
};
check('expectedHeaders is scoped to one dataset, not the whole dashboard',
  eq(expectedHeaders(reg, 'local-purchase', 'grn-register'), ['GRN No.', 'PO No.']));
check('the other slot on the same dashboard gets its own wording',
  eq(expectedHeaders(reg, 'local-purchase', 'purchase-register'), ['PO No', 'Status']));

const grnCsv = 'GRN_No,PO_No,Received_Qty\nG1,P1,5\n';
check('restoration uses the GRN slot\'s wording for the GRN file',
  restoreHeaders(grnCsv, expectedHeaders(reg, 'local-purchase', 'grn-register'))
    .split('\n')[0] === '"GRN No.","PO No.",Received_Qty');
const poCsv = 'PO_No,Status\nP1,Approved\n';
check('and the PO slot\'s wording for the PO file -- no cross-contamination',
  restoreHeaders(poCsv, expectedHeaders(reg, 'local-purchase', 'purchase-register'))
    .split('\n')[0] === '"PO No","Status"');
check('a column the dashboard never declared is left exactly as-is',
  restoreHeaders(grnCsv, expectedHeaders(reg, 'local-purchase', 'grn-register'))
    .includes('Received_Qty'));
check('body rows are untouched by restoration',
  restoreHeaders(grnCsv, ['GRN No.']).split('\n')[1] === 'G1,P1,5');
check('a heading containing a quote is escaped, not broken',
  restoreHeaders('A_B\n1\n', ['A"B']).split('\n')[0] === '"A""B"');
check('an empty body is handled without throwing', restoreHeaders('', []) === '');

// --- parts: a month missing two of three files is not a month ------------
check('a dataset with no declared parts is always complete',
  partsComplete(reg, 'grn-register', { parts: [{ part: '' }] }) === true);
check('all three COGS parts present reads as complete',
  partsComplete(reg, 'cogs', { parts: [{ part: 'dept' }, { part: 'ip' }, { part: 'op' }] }) === true);
check('one COGS part present names the two that are missing',
  eq(partsComplete(reg, 'cogs', { parts: [{ part: 'ip' }] }), ['dept', 'op']));

// --- period selection -----------------------------------------------------
check('periodsOf sorts oldest first so the newest is last',
  eq(periodsOf({ periods: [{ period: '2026-08' }, { period: '2026-07' }] }),
     ['2026-07', '2026-08']));
check('periodsOf copes with nothing stored', eq(periodsOf(null), []));

console.log('\n%d passed, %d failed', passed, failed);
process.exit(failed === 0 ? 0 : 1);
