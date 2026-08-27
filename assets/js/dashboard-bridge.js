/* Paras Command Centre — dashboard bridge.
 *
 * Injected into each dashboard by sync.py. It adds nothing you can see and
 * changes nothing the dashboard does in ordinary use: it only listens for the
 * Command Centre handing over a file, and puts it in the dashboard's own
 * upload box exactly as if you had picked it yourself.
 *
 * This exists because a page opened straight from disk (file://) is sealed off
 * from every other page, so the Command Centre cannot reach in — but the two
 * can still exchange messages. Remove the injected block and the dashboard
 * carries on working; only the one-click fill stops.
 *
 * It also stops one specific bad outcome: picking an oversized file straight
 * into this dashboard's own upload box, past what its own parser can hold in
 * memory, crashes the browser tab. That is refused here, before the file ever
 * reaches the dashboard's own code, in favour of the Command Centre's Data
 * Library — which streams a file this size instead of loading it whole.
 *
 * It also relays the shell's dark/light theme toggle: whenever the Command
 * Centre's own theme changes (and once immediately when this dashboard first
 * loads), it stamps data-theme="dark"|"light" on this document's <html> and
 * fires a "parasthemechange" event, so any dashboard that defines its own
 * :root[data-theme="light"] palette follows the shell's toggle instead of
 * carrying a separate one of its own. A dashboard with no light palette yet
 * simply ignores the attribute -- this is a no-op until one is added.
 */
(function (w, d) {
  'use strict';
  if (w.__parasBridge) return;
  w.__parasBridge = 1;

  // Mirrors assets/js/library.js's BIG_FILE. Duplicated because this file is
  // injected standalone into a different page and has no import of its own.
  var TOO_BIG = 40 * 1024 * 1024;

  function warnTooBig(file) {
    var mb = Math.round(file.size / 1048576);
    try {
      w.alert(
        '"' + file.name + '" is ' + mb + ' MB.\n\n' +
        'That is too large for this page to open directly \u2014 a file this size ' +
        'can crash the browser tab partway through.\n\n' +
        'Use the Data Library in the Paras Command Centre instead: add the file ' +
        'there, press Condense, then Fill upload boxes. The condensed file keeps ' +
        'every total exactly the same, just as far fewer rows, and opens here safely.'
      );
    } catch (e) {}
  }

  /* Runs before the dashboard's own listeners: capture-phase, on the
     document, is reached on the way down the tree before the target (and its
     bubble-phase handlers) sees the event at all. stopImmediatePropagation
     here means the dashboard's own upload code never runs for this file. A
     file the Command Centre hands over through postMessage (always well
     under the limit, since it comes from the Data Library already condensed
     if it needed to be) is untouched. */
  d.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!t || t.tagName !== 'INPUT' || t.type !== 'file' || !t.files || !t.files.length) return;
    var f = t.files[0];
    if (f.size <= TOO_BIG) return;
    ev.stopImmediatePropagation();
    ev.preventDefault();
    try { t.value = ''; } catch (e2) {}
    warnTooBig(f);
  }, true);

  d.addEventListener('drop', function (ev) {
    var dt = ev.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return;
    var f = dt.files[0];
    if (f.size <= TOO_BIG) return;
    ev.stopImmediatePropagation();
    ev.preventDefault();
    warnTooBig(f);
  }, true);

  function label(inp, i) {
    var t = '';
    try {
      if (inp.labels && inp.labels.length) t = inp.labels[0].textContent;
      if (!t && inp.closest) { var l = inp.closest('label'); if (l) t = l.textContent; }
      var box = inp.parentElement;
      for (var k = 0; k < 3 && box && !t; k++) {
        var q = box.querySelector('label, h3, h4, b, strong, .label');
        if (q && q.textContent.trim()) t = q.textContent;
        box = box.parentElement;
      }
      if (!t) t = inp.getAttribute('aria-label') || inp.getAttribute('title') || inp.name || inp.id || '';
    } catch (e) {}
    return String(t).replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function inputs() {
    return Array.prototype.slice.call(d.querySelectorAll('input[type=file]'));
  }

  function reply(src, id, body) {
    try { src.postMessage(Object.assign({ __paras: 1, id: id }, body), '*'); } catch (e) {}
  }

  w.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || m.__paras !== 1 || !m.action) return;
    // Only the page that embedded this one may drive it.
    if (w.parent === w || ev.source !== w.parent) return;

    if (m.action === 'theme') {
      try {
        var theme = m.theme === 'light' ? 'light' : 'dark';
        d.documentElement.setAttribute('data-theme', theme);
        d.dispatchEvent(new CustomEvent('parasthemechange', { detail: { theme: theme } }));
      } catch (e) {}
      return;
    }

    if (m.action === 'probe') {
      reply(ev.source, m.id, {
        ok: true,
        inputs: inputs().map(function (inp, i) {
          return { index: i, label: label(inp, i), accept: inp.getAttribute('accept') || '' };
        })
      });
      return;
    }

    if (m.action === 'fill') {
      var list = inputs(), inp = list[m.index];
      if (!inp) return reply(ev.source, m.id, { ok: false, error: 'no such upload box' });
      try {
        var file = (m.blob instanceof File) ? m.blob
          : new File([m.blob], m.name || 'file', { type: m.type || (m.blob && m.blob.type) || '' });
        var dt = new DataTransfer();
        dt.items.add(file);
        inp.files = dt.files;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        reply(ev.source, m.id, { ok: true });
      } catch (e) {
        reply(ev.source, m.id, { ok: false, error: String(e && e.message || e) });
      }
    }
  }, false);
})(window, document);
