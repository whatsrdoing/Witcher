/* Shared Data Library.
 *
 * One place to drop every export. Each file's header row is read once when it
 * is added, so the Command Centre knows what it actually is rather than
 * guessing from the filename — then it can hand the right file to the right
 * dashboard upload box. Everything happens in this browser; nothing uploads. */
(function (w, d) {
  'use strict';

  var LIBRARY_ID = '__library__';
  var SNIFF_LIMIT = 30 * 1024 * 1024;   // don't parse enormous workbooks for a header
  var TEXT_SLICE = 256 * 1024;

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
    if (file.size > SNIFF_LIMIT) return Promise.resolve([]);

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

  w.Library = {
    ID: LIBRARY_ID,
    sniff: sniff,
    score: score,
    assign: assign,
    tokens: tokens
  };
})(window, document);
