/* Reads a workbook off the main thread.
 *
 * XLSX.read() and sheet_to_csv() are both synchronous CPU work, and a
 * register can run to well over 100,000 rows. Done on the main thread that
 * is a multi-second freeze with no way to cancel and nothing to show for it
 * but a spinning tab -- exactly what large COGS and GRN imports were doing.
 * Here, the tab stays responsive the whole time.
 *
 * Only reachable over http(s): a Worker cannot load a file:// script (the
 * browser refuses it as cross-origin from a "null" origin), so the caller in
 * app.js tries this first and falls back to the old synchronous path when
 * the Worker itself fails to construct -- which happens synchronously, so
 * that fallback is reliable rather than a timeout guess.
 */
importScripts('../vendor/xlsx-0.18.5.full.min.js');

var book = null;

self.onmessage = function (e) {
  var msg = e.data || {};
  try {
    if (msg.type === 'open') {
      book = XLSX.read(new Uint8Array(msg.bytes), { type: 'array', dense: true, cellDates: true });
      var names = (book.SheetNames || []).filter(function (n) {
        var ws = book.Sheets[n];
        return ws && (ws['!ref'] || (ws.length || 0) > 0);   // skip empty sheets
      });
      self.postMessage({ type: 'names', names: names.length ? names : (book.SheetNames || []) });
      return;
    }
    if (msg.type === 'sheet') {
      var ws2 = book && book.Sheets[msg.name];
      if (!ws2) throw new Error('sheet "' + msg.name + '" is not in that file');
      // Dates as plain text: the database stores everything as text and an
      // Excel serial number in a date column is unreadable later.
      var csv = XLSX.utils.sheet_to_csv(ws2, { dateNF: 'dd-mmm-yyyy', blankrows: false });
      self.postMessage({ type: 'csv', name: msg.name, csv: csv });
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};
