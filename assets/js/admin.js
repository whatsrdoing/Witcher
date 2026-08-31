/* Admin panel -- visible and reachable only for the admin account.
 * Deliberately its own small file, not folded into app.js: everything here
 * only ever runs for one account, reads/writes a completely different set
 * of endpoints (__admin/*), and app.js should not need to know this exists
 * beyond the two hooks it calls (checkAccess, reportViewing). */
(function (w, d) {
  'use strict';

  var $ = function (s, r) { return (r || d).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || d).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  function fmtMs(ms) {
    var s = Math.round((ms || 0) / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm';
    return s + 's';
  }
  function fmtBytes(n) {
    n = n || 0;
    if (n > 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    if (n > 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }
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

  var isAdminCached = false;

  /* Called from app.js's own route() on the #/admin hash -- returns true
     (and actually shows the panel) only once we know this session is the
     admin account; otherwise route() falls through to the normal home
     view rather than sitting on a hash nothing will ever render. */
  function showIfAllowed() {
    if (!isAdminCached) return false;
    $$('.view').forEach(function (v) { v.classList.remove('active'); });
    $('#viewAdmin').classList.add('active');
    refreshAll();
    return true;
  }

  function refreshAll() {
    renderSessions();
    renderAccounts();
    renderRequests();
    renderFeedback();
    renderDashboardVisibility();
    renderStorage();
    renderHistory();
  }

  var FEEDBACK_CATEGORY_LABEL = { feature: 'Feature idea', bug: "Something's broken", data: 'Data question', other: 'Other' };

  function renderFeedback() {
    var box = $('#adminFeedback');
    if (!box) return;
    box.textContent = 'Loading…';
    api('__admin/feedback').then(function (r) {
      if (!r.ok) { box.textContent = 'Could not load.'; return; }
      var rows = (r.body.items || []).slice().sort(function (a, b) {
        var openDiff = (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0);
        return openDiff || (b.createdAt || 0) - (a.createdAt || 0);
      });
      if (!rows.length) { box.innerHTML = '<p class="admin-empty">Nothing raised yet.</p>'; return; }
      box.innerHTML = rows.map(function (f) {
        var badge = f.status === 'done' ? '<span class="admin-badge admin-badge-ok">Done</span>'
          : '<span class="admin-badge">Open</span>';
        var remark = f.remark ? '<span class="admin-row-sub">Remark: ' + esc(f.remark) + '</span>' : '';
        return '<div class="admin-row"><div class="admin-row-main"><b>' + esc(f.subject) + '</b> ' + badge +
          '<span class="admin-row-sub">' + esc(f.login) + ' · ' + esc(FEEDBACK_CATEGORY_LABEL[f.category] || f.category) +
          ' · ' + fmtWhen(f.createdAt) + '</span>' +
          '<span class="admin-row-sub">' + esc(f.message) + '</span>' + remark + '</div>' +
          '<div class="admin-row-acts">' +
          '<button class="btn sm" data-feedback-toggle="' + esc(f.id) + '" data-done="' + (f.status === 'done' ? '' : '1') + '">' +
          (f.status === 'done' ? 'Reopen' : 'Mark done') + '</button></div></div>';
      }).join('');

      $$('[data-feedback-toggle]', box).forEach(function (btn) {
        btn.addEventListener('click', function () { resolveFeedback(btn.dataset.feedbackToggle, btn.dataset.done === '1'); });
      });
    });
  }

  function resolveFeedback(id, done) {
    var remark = prompt(done ? 'Mark this done. Add a remark (optional):' : 'Reopen this item. Add a remark (optional):') || '';
    api('__admin/feedback/' + encodeURIComponent(id) + '/resolve', {
      method: 'POST', body: JSON.stringify({ done: done, remark: remark })
    }).then(function (r) {
      if (!r.ok) { alert(r.body.error || 'Could not update it.'); return; }
      renderFeedback();
    });
  }

  var REQUEST_LABEL = { signup: 'New account', password_reset: 'Password reset', id_change: 'Sign-in name change' };

  function renderRequests() {
    var box = $('#adminRequests');
    if (!box) return;
    box.textContent = 'Loading…';
    api('__admin/requests').then(function (r) {
      if (!r.ok) { box.textContent = 'Could not load.'; return; }
      var rows = (r.body.requests || []).filter(function (q) { return q.status === 'pending'; })
        .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      if (!rows.length) { box.innerHTML = '<p class="admin-empty">Nothing waiting on approval.</p>'; return; }
      box.innerHTML = rows.map(function (q) {
        var detail = q.type === 'id_change' ? ('Wants to become "' + esc((q.payload || {}).newLogin) + '"')
          : q.type === 'signup' ? esc(((q.payload || {}).profile || {}).name || 'No name given')
          : 'Requesting a new password';
        return '<div class="admin-row"><div class="admin-row-main"><b>' + esc(q.login) + '</b>' +
          ' <span class="admin-badge">' + esc(REQUEST_LABEL[q.type] || q.type) + '</span>' +
          '<span class="admin-row-sub">' + detail + ' · ' + fmtWhen(q.createdAt) + '</span></div>' +
          '<div class="admin-row-acts">' +
          '<button class="btn sm" data-reject="' + esc(q.id) + '">Reject</button>' +
          '<button class="btn sm primary" data-approve="' + esc(q.id) + '">Approve</button></div></div>';
      }).join('');

      $$('[data-approve]', box).forEach(function (btn) {
        btn.addEventListener('click', function () { resolveRequest(btn.dataset.approve, 'approve'); });
      });
      $$('[data-reject]', box).forEach(function (btn) {
        btn.addEventListener('click', function () { resolveRequest(btn.dataset.reject, 'reject'); });
      });
    });
  }

  function resolveRequest(id, action) {
    var remark = prompt(action === 'approve' ? 'Approve this request. Add a remark (optional):'
      : 'Reject this request. Add a remark (optional):') || '';
    api('__admin/requests/' + encodeURIComponent(id) + '/resolve', {
      method: 'POST', body: JSON.stringify({ action: action, remark: remark })
    }).then(function (r) {
      if (!r.ok) { alert(r.body.error || 'Could not resolve it.'); return; }
      renderRequests();
      if (action === 'approve') renderAccounts();
    });
  }

  function renderDashboardVisibility() {
    var box = $('#adminDashboards');
    if (!box) return;
    box.textContent = 'Loading…';
    api('__admin/dashboards').then(function (r) {
      if (!r.ok) { box.textContent = 'Could not load.'; return; }
      var rows = (r.body.dashboards || []).filter(function (d) { return d.status !== 'planned' && d.status !== 'archived'; });
      if (!rows.length) { box.innerHTML = '<p class="admin-empty">No live dashboards yet.</p>'; return; }
      box.innerHTML = rows.map(function (d) {
        return '<div class="admin-row"><div class="admin-row-main"><b>' + esc(d.name) + '</b>' +
          '<span class="admin-row-sub">' + (d.adminOnly ? 'Admin only -- hidden from everyone else' : 'Visible to everyone') +
          '</span></div><button class="btn sm" data-vis="' + esc(d.id) + '" data-admin-only="' + (d.adminOnly ? '1' : '0') + '">' +
          (d.adminOnly ? 'Make visible to all' : 'Make admin-only') + '</button></div>';
      }).join('');
      $$('[data-vis]', box).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var makeAdminOnly = btn.dataset.adminOnly === '0';
          api('__admin/dashboards/' + encodeURIComponent(btn.dataset.vis) + '/visibility', {
            method: 'POST', body: JSON.stringify({ adminOnly: makeAdminOnly })
          }).then(function (r2) {
            if (r2.ok) renderDashboardVisibility(); else alert(r2.body.error || 'Could not update it.');
          });
        });
      });
    });
  }

  function renderSessions() {
    var box = $('#adminSessions');
    if (!box) return;
    box.textContent = 'Loading…';
    api('__admin/sessions').then(function (r) {
      if (!r.ok) { box.textContent = 'Could not load.'; return; }
      var rows = r.body.sessions || [];
      if (!rows.length) { box.innerHTML = '<p class="admin-empty">Nobody is signed in right now.</p>'; return; }
      box.innerHTML = rows.map(function (s) {
        return '<div class="admin-row"><div class="admin-row-main"><b>' + esc(s.login) + '</b>' +
          '<span class="admin-row-sub">' + (s.viewing ? 'Viewing ' + esc(s.viewing) : 'On the hub') +
          ' · since ' + fmtWhen(s.startedAt * 1000) + '</span></div>' +
          '<button class="btn sm" data-force-logout="' + esc(s.login) + '">Sign out</button></div>';
      }).join('');
      $$('[data-force-logout]', box).forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (!confirm('Sign out ' + btn.dataset.forceLogout + ' now?')) return;
          api('__admin/sessions/logout', { method: 'POST', body: JSON.stringify({ login: btn.dataset.forceLogout }) })
            .then(function () { renderSessions(); });
        });
      });
    });
  }

  function renderAccounts() {
    var box = $('#adminAccounts');
    if (!box) return;
    box.textContent = 'Loading…';
    api('__admin/accounts').then(function (r) {
      if (!r.ok) { box.textContent = 'Could not load.'; return; }
      var rows = r.body.accounts || [];
      box.innerHTML = rows.map(function (a) {
        return '<div class="admin-row"><div class="admin-row-main"><b>' + esc(a.login) + '</b>' +
          (a.isAdmin ? ' <span class="admin-badge">admin</span>' : '') +
          (a.disabled ? ' <span class="admin-badge admin-badge-bad">disabled</span>' : '') +
          '<span class="admin-row-sub">' + esc(a.name || 'No name on file') +
          ' · signed in ' + a.sessionCount + ' time' + (a.sessionCount === 1 ? '' : 's') +
          ' · ' + fmtMs(a.totalTimeMs) + ' total</span></div>' +
          '<div class="admin-row-acts">' +
          '<button class="btn sm" data-reset="' + esc(a.login) + '">Reset password</button>' +
          '<button class="btn sm" data-rename="' + esc(a.login) + '">Rename</button>' +
          '<button class="btn sm" data-toggle="' + esc(a.login) + '" data-disabled="' + (a.disabled ? '1' : '0') + '">' +
          (a.disabled ? 'Enable' : 'Disable') + '</button></div></div>';
      }).join('');

      $$('[data-reset]', box).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var pw = prompt('New password for ' + btn.dataset.reset + ' (at least 6 characters):');
          if (!pw) return;
          api('__admin/accounts/' + encodeURIComponent(btn.dataset.reset) + '/reset-password', {
            method: 'POST', body: JSON.stringify({ newPassword: pw })
          }).then(function (r2) { if (!r2.ok) alert(r2.body.error || 'Could not reset it.'); });
        });
      });
      $$('[data-rename]', box).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var name = prompt('New sign-in name for ' + btn.dataset.rename + ':');
          if (!name) return;
          api('__admin/accounts/' + encodeURIComponent(btn.dataset.rename) + '/rename', {
            method: 'POST', body: JSON.stringify({ newLogin: name })
          }).then(function (r2) {
            if (!r2.ok) { alert(r2.body.error || 'Could not rename it.'); return; }
            renderAccounts();
          });
        });
      });
      $$('[data-toggle]', box).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var willDisable = btn.dataset.disabled === '0';
          if (willDisable && !confirm('Disable ' + btn.dataset.toggle +
            '? They will be signed out and unable to sign in again until re-enabled.')) return;
          api('__admin/accounts/' + encodeURIComponent(btn.dataset.toggle) + '/disable', {
            method: 'POST', body: JSON.stringify({ disabled: willDisable })
          }).then(function (r2) { if (r2.ok) renderAccounts(); else alert(r2.body.error || 'Could not update it.'); });
        });
      });
    });
  }

  function renderStorage() {
    var box = $('#adminStorage'), sum = $('#adminStorageSummary');
    if (!box) return;
    box.textContent = 'Loading…';
    api('__admin/storage').then(function (r) {
      if (!r.ok) { box.textContent = 'Could not load.'; return; }
      var files = r.body.files || [];
      if (sum) sum.textContent = files.length + ' file' + (files.length === 1 ? '' : 's') +
        ' · ' + fmtBytes(r.body.totalBytes) + ' total';
      if (!files.length) { box.innerHTML = '<p class="admin-empty">Nothing uploaded yet.</p>'; return; }
      box.innerHTML = files.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })
        .map(function (f) {
          return '<div class="admin-row"><div class="admin-row-main"><b>' + esc(f.name) + '</b>' +
            '<span class="admin-row-sub">' + fmtBytes(f.size) + ' · uploaded by ' +
            esc(f.uploadedBy || 'unknown') + ' · ' + fmtWhen(f.updatedAt) + '</span></div></div>';
        }).join('');
    });
  }

  var HISTORY_LABEL = {
    login_ok: 'Signed in', login_fail: 'Wrong password',
    logout: 'Signed out', force_logout: 'Signed out (forced)'
  };

  function renderHistory() {
    var box = $('#adminHistory');
    if (!box) return;
    box.textContent = 'Loading…';
    api('__admin/history?limit=100').then(function (r) {
      if (!r.ok) { box.textContent = 'Could not load.'; return; }
      var rows = r.body.history || [];
      if (!rows.length) { box.innerHTML = '<p class="admin-empty">No activity recorded yet.</p>'; return; }
      box.innerHTML = rows.map(function (e) {
        var bad = e.event === 'login_fail' ? ' admin-badge-bad' : '';
        return '<div class="admin-row"><div class="admin-row-main"><b>' + esc(e.login) + '</b>' +
          ' <span class="admin-badge' + bad + '">' + esc(HISTORY_LABEL[e.event] || e.event) + '</span>' +
          '<span class="admin-row-sub">' + fmtWhen(e.ts) + '</span></div></div>';
      }).join('');
    });
  }

  var isAdminPromise = null;

  /* Memoised: app.js's boot() calls this once to decide whether to filter
     admin-only dashboards out of the registry before anything renders;
     checkAccess() below reuses the same result rather than asking twice. */
  function isAdmin() {
    if (isAdminPromise) return isAdminPromise;
    isAdminPromise = fetch('__session', { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (who) {
      isAdminCached = !!(who && who.isAdmin);
      return isAdminCached;
    }).catch(function () { isAdminCached = false; return false; });
    return isAdminPromise;
  }

  function checkAccess() {
    isAdmin().then(function (v) {
      var btn = $('#adminBtn');
      if (btn) btn.style.display = v ? '' : 'none';
    });
  }

  var lastViewing = undefined;
  function reportViewing(name) {
    if (name === lastViewing) return;   // no need to spam the server on every render of the same view
    lastViewing = name;
    try {
      fetch('__session/viewing', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboardId: name })
      });
    } catch (e) {}
  }

  d.addEventListener('DOMContentLoaded', function () {
    var btn = $('#adminBtn');
    if (btn) btn.addEventListener('click', function () { location.hash = '#/admin'; });
  });

  w.ParasAdmin = { checkAccess: checkAccess, isAdmin: isAdmin, reportViewing: reportViewing, showIfAllowed: showIfAllowed };
})(window, document);
