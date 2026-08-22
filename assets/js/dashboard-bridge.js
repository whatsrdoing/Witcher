/* Paras Command Centre — dashboard bridge.
 *
 * Injected into each dashboard by sync.py. It adds nothing you can see and
 * changes nothing the dashboard does: it only listens for the Command Centre
 * handing over a file, and puts it in the dashboard's own upload box exactly
 * as if you had picked it yourself.
 *
 * This exists because a page opened straight from disk (file://) is sealed off
 * from every other page, so the Command Centre cannot reach in — but the two
 * can still exchange messages. Remove the injected block and the dashboard
 * carries on working; only the one-click fill stops.
 */
(function (w, d) {
  'use strict';
  if (w.__parasBridge) return;
  w.__parasBridge = 1;

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
