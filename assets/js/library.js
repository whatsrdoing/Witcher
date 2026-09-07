/* Shared Data Library.
 *
 * One place to drop every export. Each file's header row is read once when it
 * is added, so the Command Centre knows what it actually is rather than
 * guessing from the filename — then it can hand the right file to the right
 * dashboard upload box. Everything happens in this browser; nothing uploads. */
(function (w, d) {
  'use strict';

  var LIBRARY_ID = '__library__';
  var WORKBOOK_SNIFF_LIMIT = 30 * 1024 * 1024;  // workbooks must be parsed to be read
  var TEXT_SLICE = 256 * 1024;                  // a CSV header costs one small slice
  var BIG_FILE = 40 * 1024 * 1024;              // past this, a browser tab starts to struggle
  var MAX_GROUPS = 400000;                      // give up aggregating rather than run out of memory

  /* ---- lazy SheetJS: only pulled in when a spreadsheet is actually added -- */
  var xlsxPromise = null;
  function loadXLSX() {
    if (w.XLSX) return Promise.resolve(w.XLSX);
    if (xlsxPromise) return xlsxPromise;
    xlsxPromise = new Promise(function (res, rej) {
      var s = d.createElement('script');
      s.src = 'assets/vendor/xlsx-0.18.5.full.min.js';
      s.onload = function () { res(w.XLSX); };
      s.onerror = function () { rej(new Error('could not load the spreadsheet reader')); };
      d.head.appendChild(s);
    });
    return xlsxPromise;
  }

  function ext(name) { return (String(name).split('.').pop() || '').toLowerCase(); }

  function splitDelimited(line) {
    var best = ',', bestN = -1;
    [',', ';', '\t', '|'].forEach(function (dch) {
      var n = line.split(dch).length;
      if (n > bestN) { bestN = n; best = dch; }
    });
    return line.split(best).map(function (c) {
      return c.replace(/^\s*"?|"?\s*$/g, '').trim();
    }).filter(Boolean);
  }

  /* Reads just the header row. Returns [] when it cannot tell. */
  function sniff(file) {
    var e = ext(file.name);

    if (['csv', 'tsv', 'txt'].indexOf(e) >= 0) {
      return file.slice(0, TEXT_SLICE).text().then(function (t) {
        var lines = t.split(/\r?\n/);
        for (var i = 0; i < lines.length && i < 25; i++) {
          var cols = splitDelimited(lines[i]);
          if (cols.length >= 2) return cols.slice(0, 80);
        }
        return [];
      }).catch(function () { return []; });
    }

    if (['xlsx', 'xls', 'xlsm', 'ods'].indexOf(e) >= 0) {
      if (file.size > WORKBOOK_SNIFF_LIMIT) return Promise.resolve([]);
      return loadXLSX().then(function (XLSX) {
        return file.arrayBuffer().then(function (buf) {
          var wb = XLSX.read(new Uint8Array(buf), { type: 'array', sheetRows: 8, cellDates: false });
          var out = [];
          (wb.SheetNames || []).slice(0, 2).forEach(function (n) {
            if (out.length) return;
            var rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false, defval: '' });
            for (var i = 0; i < rows.length && i < 8; i++) {
              var cols = (rows[i] || []).map(function (c) { return String(c).trim(); }).filter(Boolean);
              if (cols.length >= 2) { out = cols.slice(0, 80); break; }
            }
          });
          return out;
        });
      }).catch(function () { return []; });
    }
    return Promise.resolve([]);
  }

  /* ---- matching --------------------------------------------------------- */
  function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function tokens(s) {
    return norm(s).split(' ').filter(function (t) { return t.length > 2 && !STOP[t]; });
  }
  var STOP = { the: 1, and: 1, for: 1, csv: 1, xls: 1, xlsx: 1, file: 1, report: 1,
               all: 1, data: 1, new: 1, copy: 1, final: 1, jan: 1, feb: 1, mar: 1, apr: 1,
               may: 1, jun: 1, jul: 1, aug: 1, sep: 1, oct: 1, nov: 1, dec: 1 };

  function headerHit(headers, need) {
    var n = norm(need);
    if (!n) return false;
    return headers.some(function (h) {
      var hn = norm(h);
      return hn === n || hn.indexOf(n) >= 0;
    });
  }

  /* How well does this file suit this upload box? 0 = not at all. */
  function score(file, slot) {
    var headers = file.headers || [];
    var s = 0, why = [];

    if (slot.accept) {
      var e = '.' + ext(file.name);
      var list = slot.accept.toLowerCase().split(',').map(function (x) { return x.trim(); });
      var dotted = list.filter(function (x) { return x.charAt(0) === '.'; });
      if (dotted.length && dotted.indexOf(e) < 0) return { score: 0, why: ['wrong file type'] };
    }

    var needs = slot.needs || [];
    if (needs.length && headers.length) {
      var hits = needs.filter(function (n) { return headerHit(headers, n); });
      var ratio = hits.length / needs.length;
      if (ratio >= 0.8)      s += 70 + ratio * 30;
      else if (ratio >= 0.6) s += 25;
      else                   s -= 45;   // shares a few generic columns, nothing more
      if (hits.length) why.push(hits.length + '/' + needs.length + ' expected columns');
    }

    var ft = tokens(file.name), lt = tokens(slot.label);
    var shared = lt.filter(function (t) {
      return ft.some(function (f) { return f === t || f.indexOf(t) >= 0 || t.indexOf(f) >= 0; });
    });
    if (lt.length && shared.length) {
      s += (shared.length / lt.length) * 60;
      why.push('name matches "' + shared.join(' ') + '"');
    }

    (slot.match || []).forEach(function (pat) {
      try { if (new RegExp(pat, 'i').test(file.name)) { s += 30; why.push('name rule'); } }
      catch (e) {}
    });

    return { score: Math.round(s), why: why };
  }

  /* Best file for each slot, never using one file for two slots. */
  function assign(files, slots, minScore) {
    minScore = minScore || 30;
    var pairs = [];
    slots.forEach(function (slot, si) {
      files.forEach(function (f) {
        var r = score(f, slot);
        if (r.score >= minScore) pairs.push({ slotIndex: si, slot: slot, file: f, score: r.score, why: r.why });
      });
    });
    pairs.sort(function (a, b) { return b.score - a.score; });

    var usedSlot = {}, fileFor = {}, out = [];
    pairs.forEach(function (p) {
      if (usedSlot[p.slotIndex]) return;
      var claimed = fileFor[p.file.id];
      if (claimed !== undefined && claimed !== norm(p.slot.label)) return;
      usedSlot[p.slotIndex] = 1;
      fileFor[p.file.id] = norm(p.slot.label);
      out.push(p);
    });
    out.sort(function (a, b) { return a.slotIndex - b.slotIndex; });
    return out;
  }

  /* ---- lazy PapaParse, for streaming very large CSVs --------------------- */
  var papaPromise = null;
  function loadPapa() {
    if (w.Papa) return Promise.resolve(w.Papa);
    if (papaPromise) return papaPromise;
    papaPromise = new Promise(function (res, rej) {
      var s = d.createElement('script');
      s.src = 'assets/vendor/papaparse-5.4.1.min.js';
      s.onload = function () { res(w.Papa); };
      s.onerror = function () { rej(new Error('could not load the CSV reader')); };
      d.head.appendChild(s);
    });
    return papaPromise;
  }

  /* Headers that name an identifier — never sum these even when every value
     happens to be digits. A summed Item Id or Bill No is not a smaller
     version of the truth, it is a different, wrong number, and it would
     silently corrupt whatever the dashboard keys on. */
  var ID_LIKE = /\b(id|no\.?|number|num|code|sku|nbr)\b/i;
  function isIdColumn(name) {
    var n = String(name || '');
    return ID_LIKE.test(n) && !/\b(qty|quantity|amount|value|price|rate|cost|total|sum)\b/i.test(n);
  }

  function looksNumeric(v) {
    if (v === null || v === undefined) return false;
    var t = String(v).trim().replace(/[,\s\u00a0₹$]/g, '');
    if (!t || t === '-') return false;
    if (/^\(.*\)$/.test(t)) t = '-' + t.slice(1, -1);
    return isFinite(parseFloat(t)) && /^-?\d*\.?\d+(e[-+]?\d+)?$/i.test(t);
  }
  function toNum(v) {
    var t = String(v == null ? '' : v).trim().replace(/[,\s\u00a0₹$]/g, '');
    if (/^\(.*\)$/.test(t)) t = '-' + t.slice(1, -1);
    var n = parseFloat(t);
    return isFinite(n) ? n : 0;
  }
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* Reads the first rows to work out which columns hold numbers. */
  function profile(file, sampleRows) {
    var limit = sampleRows || 400;
    return loadPapa().then(function (Papa) {
      return new Promise(function (res, rej) {
        var headers = null, numeric = {}, seen = 0, settled = false;

        function finish() {
          if (settled) return;
          settled = true;
          res((headers || []).map(function (h) {
            return { name: h, numeric: !!numeric[h] && seen > 0 && !isIdColumn(h) };
          }));
        }

        // preview + step does not reliably fire "complete" in PapaParse when
        // the source is a File/Blob (the streamer keeps waiting for more
        // input once the preview cap is hit). Counting rows and aborting the
        // parser ourselves is the version of this that actually finishes.
        Papa.parse(file, {
          header: true, skipEmptyLines: true,
          step: function (row, parser) {
            if (settled) return;
            if (!headers) headers = (row.meta && row.meta.fields) || Object.keys(row.data || {});
            seen++;
            var data = row.data || {};
            for (var k in data) {
              if (numeric[k] === false) continue;
              if (String(data[k] || '').trim() === '') continue;
              numeric[k] = looksNumeric(data[k]);
            }
            if (seen >= limit) { parser.abort(); finish(); }
          },
          complete: finish,
          error: function (e) { if (!settled) { settled = true; rej(e); } }
        });
      });
    });
  }

  /* Streams a CSV and collapses it: the chosen text columns become the group,
     the chosen number columns are summed. Nothing is read whole, so memory
     stays flat however large the file is.  Rows that share every text value
     add up exactly, so any total the dashboard computes is unchanged. */
  function condense(file, opts) {
    opts = opts || {};
    var keys = opts.keys || [], sums = opts.sums || [];
    var onProgress = opts.onProgress || function () {};
    if (!keys.length && !sums.length) return Promise.reject(new Error('choose at least one column'));

    return loadPapa().then(function (Papa) {
      return new Promise(function (res, rej) {
        var groups = Object.create(null), order = [];
        var read = 0, kept = 0, overflow = false;

        Papa.parse(file, {
          header: true, skipEmptyLines: true, worker: false, chunkSize: 4 * 1024 * 1024,
          chunk: function (results, parser) {
            var rows = results.data;
            for (var i = 0; i < rows.length; i++) {
              var r = rows[i];
              read++;
              var k = '';
              for (var a = 0; a < keys.length; a++) k += String(r[keys[a]] == null ? '' : r[keys[a]]) + '\u0001';
              var g = groups[k];
              if (!g) {
                if (order.length >= MAX_GROUPS) { overflow = true; parser.abort(); return; }
                g = groups[k] = { key: [], sum: [] };
                for (a = 0; a < keys.length; a++) g.key.push(r[keys[a]] == null ? '' : r[keys[a]]);
                for (a = 0; a < sums.length; a++) g.sum.push(0);
                order.push(k);
                kept++;
              }
              for (a = 0; a < sums.length; a++) g.sum[a] += toNum(r[sums[a]]);
            }
            onProgress({ read: read, kept: kept });
          },
          complete: function () {
            if (overflow) {
              return rej(new Error('too many distinct rows to combine (' + MAX_GROUPS.toLocaleString() +
                '+). Untick a column that is different on every row — a date, a bill number — and try again.'));
            }
            var parts = [keys.concat(sums).map(csvCell).join(',') + '\n'];
            var buf = [];
            for (var i = 0; i < order.length; i++) {
              var g = groups[order[i]];
              var line = [];
              for (var a = 0; a < g.key.length; a++) line.push(csvCell(g.key[a]));
              for (a = 0; a < g.sum.length; a++) line.push(Math.round(g.sum[a] * 1e6) / 1e6);
              buf.push(line.join(','));
              if (buf.length >= 5000) { parts.push(buf.join('\n') + '\n'); buf = []; }
            }
            if (buf.length) parts.push(buf.join('\n') + '\n');
            res({ blob: new Blob(parts, { type: 'text/csv' }), rowsIn: read, rowsOut: kept });
          },
          error: function (e) { rej(e); }
        });
      });
    });
  }

  w.Library = {
    ID: LIBRARY_ID,
    BIG_FILE: BIG_FILE,
    loadXLSX: loadXLSX,      // shared so the importer does not load a second copy
    profile: profile,
    condense: condense,
    sniff: sniff,
    score: score,
    assign: assign,
    tokens: tokens
  };
})(window, document);
