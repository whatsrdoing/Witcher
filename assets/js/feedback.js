/* "Raise a request" -- lets any signed-in account send a note (feature
 * idea, bug report, question) straight to the admin, and see the status of
 * what it has already sent. Its own small file, same reasoning as
 * admin.js: a couple of dedicated endpoints (__feedback, __admin/feedback)
 * that app.js does not need to know about beyond the modal it opens. */
(function (w, d) {
  'use strict';

  var $ = function (s, r) { return (r || d).querySelector(s); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var CATEGORY_LABEL = { feature: 'New dashboard required', requirement: 'New requirement',
    bug: "Something's broken", data: 'Data question', other: 'Other' };

  function fmtWhen(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleString();
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { ok: r.ok, status: r.status, body: j };
      });
    });
  }

  var busy = false;

  function say(msg, cls) {
    var el = $('#raiseMsg');
    if (!el) return;
    el.textContent = msg;
    el.className = 'gate-msg' + (cls ? ' ' + cls : '');
    el.style.display = msg ? '' : 'none';
  }

  function updateSubmitEnabled() {
    var btn = $('#raiseSubmit');
    if (!btn) return;
    var subject = ($('#raiseSubject').value || '').trim();
    var message = ($('#raiseMessage').value || '').trim();
    btn.disabled = !subject || !message;
  }

  function open() {
    $('#raiseCategory').value = 'feature';
    $('#raiseSubject').value = '';
    $('#raiseMessage').value = '';
    say('', '');
    updateSubmitEnabled();
    $('#raiseModal').classList.add('open');
    $('#raiseSubject').focus();
  }

  function close() {
    $('#raiseModal').classList.remove('open');
  }

  function closeIfOpen() {
    if ($('#myRequestsModal').classList.contains('open')) { closeMine(); return true; }
    if ($('#raiseModal').classList.contains('open')) { close(); return true; }
    return false;
  }

  function openMine() {
    var body = $('#myRequestsBody');
    body.textContent = 'Loading…';
    $('#myRequestsModal').classList.add('open');
    api('__feedback').then(function (r) {
      if (!r.ok) { body.textContent = 'Could not load.'; return; }
      var items = r.body.items || [];
      if (!items.length) { body.innerHTML = '<p class="admin-empty">Nothing raised yet.</p>'; return; }
      body.innerHTML = items.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); })
        .map(function (f) {
          var badge = f.status === 'done' ? '<span class="admin-badge admin-badge-ok">Closed</span>'
            : '<span class="admin-badge">Open</span>';
          var remark = f.remark ? '<span class="admin-row-sub">Admin: ' + esc(f.remark) + '</span>' : '';
          return '<div class="admin-row"><div class="admin-row-main"><b>' + esc(f.subject) + '</b> ' + badge +
            '<span class="admin-row-sub">' + esc(CATEGORY_LABEL[f.category] || f.category) +
            ' · ' + fmtWhen(f.createdAt) + '</span>' +
            '<span class="admin-row-sub">' + esc(f.message) + '</span>' + remark + '</div></div>';
        }).join('');
    });
  }

  function closeMine() {
    $('#myRequestsModal').classList.remove('open');
  }

  function submit() {
    if (busy) return;
    var category = $('#raiseCategory').value;
    var subject = ($('#raiseSubject').value || '').trim();
    var message = ($('#raiseMessage').value || '').trim();
    if (!subject) return say('Give it a short subject line.', 'err');
    if (!message) return say('Add a few details so the admin knows what you mean.', 'err');

    busy = true;
    var btn = $('#raiseSubmit');
    btn.disabled = true;
    var oldLabel = btn.textContent;
    btn.textContent = 'Sending…';
    say('', '');
    api('__feedback', {
      method: 'POST',
      body: JSON.stringify({ category: category, subject: subject, message: message })
    }).then(function (r) {
      busy = false;
      btn.textContent = oldLabel;
      if (!r.ok) { say(r.body.error || 'Could not send that.', 'err'); updateSubmitEnabled(); return; }
      $('#raiseSubject').value = '';
      $('#raiseMessage').value = '';
      say('Sent -- the admin will see it in the admin panel.', 'ok');
      updateSubmitEnabled();   // fields are now empty again -- back to disabled until filled in
    });
  }

  d.addEventListener('DOMContentLoaded', function () {
    var btn = $('#raiseBtn');
    if (btn) btn.addEventListener('click', open);
    var closeBtn = $('#raiseClose'); if (closeBtn) closeBtn.addEventListener('click', close);
    var cancelBtn = $('#raiseCancel'); if (cancelBtn) cancelBtn.addEventListener('click', close);
    var submitBtn = $('#raiseSubmit'); if (submitBtn) submitBtn.addEventListener('click', submit);
    var modal = $('#raiseModal');
    if (modal) modal.addEventListener('click', function (e) { if (e.target === e.currentTarget) close(); });

    $('#raiseSubject').addEventListener('input', updateSubmitEnabled);
    $('#raiseMessage').addEventListener('input', updateSubmitEnabled);

    var mineLink = $('#raiseMineLink');
    if (mineLink) mineLink.addEventListener('click', function (e) { e.preventDefault(); openMine(); });
    var mineClose = $('#myRequestsClose'); if (mineClose) mineClose.addEventListener('click', closeMine);
    var mineModal = $('#myRequestsModal');
    if (mineModal) mineModal.addEventListener('click', function (e) { if (e.target === e.currentTarget) closeMine(); });
  });

  w.ParasFeedback = { closeIfOpen: closeIfOpen };
})(window, document);
