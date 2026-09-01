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

  /* Kept in sync by hand with the #gateSignup dropdowns in index.html --
     the admin's "Edit profile" fields are the same three lists, just
     reachable without going through the request-approval queue. */
  var DESIGNATIONS = ['MD', 'GCOO', 'CHRO', 'Vice President', 'Assistant Vice President',
    'General Manager', 'Deputy General Manager', 'Assistant General Manager',
    'Senior Manager', 'Manager', 'Deputy Manager', 'Assistant Manager'];
  var DEPARTMENTS = ['Purchase', 'CBU Purchase', 'Pharmacy', 'MDM', 'IT', 'Management'];
  var CATEGORIES = ['All', 'Drugs', 'Consumables', 'D&MC', 'Non Medical'];

  function fillSelect(sel, options, current) {
    sel.innerHTML = options.map(function (o) { return '<option>' + esc(o) + '</option>'; }).join('');
    if (current && options.indexOf(current) === -1) {
      sel.insertAdjacentHTML('afterbegin', '<option>' + esc(current) + '</option>');
    }
    sel.value = current || options[0];
  }

  var dashboardNamesPromise = null;
  function dashboardNames() {
    if (dashboardNamesPromise) return dashboardNamesPromise;
    dashboardNamesPromise = api('__admin/dashboards').then(function (r) {
      var map = {};
      (r.body.dashboards || []).forEach(function (d) { map[d.id] = d.name; });
      return map;
    }).catch(function () { return {}; });
    return dashboardNamesPromise;
  }

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
    startPanelAutoRefresh();
    return true;
  }

  /* Keeps whatever's on screen current while the admin is actually looking
     at it, instead of needing to leave and come back to see a new request
     land -- self-cancelling (checks its own view is still active on every
     tick) rather than needing app.js's router to remember to stop it.
     Ticks every second; refreshAllBusy skips starting a new round while
     the previous one is still in flight, so a slow moment (a big history
     fetch, a loaded machine) never piles up overlapping requests -- it
     just waits for the next second where the last round has finished. */
  var panelRefreshTimer = null;
  var refreshAllBusy = false;
  function startPanelAutoRefresh() {
    if (panelRefreshTimer) return;
    panelRefreshTimer = setInterval(function () {
      if (!$('#viewAdmin').classList.contains('active')) {
        clearInterval(panelRefreshTimer);
        panelRefreshTimer = null;
        return;
      }
      if (refreshAllBusy) return;
      refreshAllBusy = true;
      var clear = function () { refreshAllBusy = false; };
      refreshAll().then(clear, clear);   // reset on success or failure alike
    }, 1000);
  }

  function refreshAll() {
    return Promise.all([
      renderSessions(), renderAccounts(), renderRequests(), renderFeedback(),
      renderDashboardVisibility(), renderStorage(), renderBackups(), renderHistory(), renderBroadcast(), renderAsk()
    ]);
  }

  var FEEDBACK_CATEGORY_LABEL = { feature: 'New dashboard required', requirement: 'New requirement',
    bug: "Something's broken", data: 'Data question', other: 'Other' };

  function renderFeedback() {
    var box = $('#adminFeedback');
    if (!box) return;
    if (!box.dataset.loaded) box.textContent = 'Loading…';
    return api('__admin/feedback').then(function (r) {
      box.dataset.loaded = '1';
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

  var REQUEST_STATUS_BADGE = {
    pending: '<span class="admin-badge">Pending</span>',
    approved: '<span class="admin-badge admin-badge-ok">Approved</span>',
    rejected: '<span class="admin-badge admin-badge-bad">Rejected</span>'
  };

  /* Pending first (oldest business first inside that), then resolved ones
     below -- same "still shows what already happened" convention as
     Suggestions & issues, rather than a request vanishing the moment it's
     acted on. */
  function renderRequests() {
    var box = $('#adminRequests');
    if (!box) return;
    if (!box.dataset.loaded) box.textContent = 'Loading…';
    return api('__admin/requests').then(function (r) {
      box.dataset.loaded = '1';
      if (!r.ok) { box.textContent = 'Could not load.'; return; }
      var rows = (r.body.requests || []).slice().sort(function (a, b) {
        var openDiff = (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1);
        return openDiff || (b.createdAt || 0) - (a.createdAt || 0);
      });
      if (!rows.length) { box.innerHTML = '<p class="admin-empty">Nothing raised yet.</p>'; return; }
      box.innerHTML = rows.map(function (q) {
        var detail = q.type === 'id_change' ? ('Wants to become "' + esc((q.payload || {}).newLogin) + '"')
          : q.type === 'signup' ? esc(((q.payload || {}).profile || {}).name || 'No name given')
          : 'Requesting a new password';
        var remark = q.remark ? '<span class="admin-row-sub">Remark: ' + esc(q.remark) + '</span>' : '';
        var acts = q.status === 'pending'
          ? '<div class="admin-row-acts">' +
            '<button class="btn sm" data-reject="' + esc(q.id) + '">Reject</button>' +
            '<button class="btn sm primary" data-approve="' + esc(q.id) + '">Approve</button></div>'
          : '';
        return '<div class="admin-row"><div class="admin-row-main"><b>' + esc(q.login) + '</b>' +
          ' <span class="admin-badge">' + esc(REQUEST_LABEL[q.type] || q.type) + '</span> ' +
          (REQUEST_STATUS_BADGE[q.status] || '') +
          '<span class="admin-row-sub">' + detail + ' · ' + fmtWhen(q.createdAt) + '</span>' + remark + '</div>' + acts + '</div>';
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
    // Only approving actually writes to auth.json (rejecting just records
    // the remark) -- step-up only applies there, same split serve.py makes.
    var call = action === 'approve' ? apiStepUp : api;
    call('__admin/requests/' + encodeURIComponent(id) + '/resolve', {
      method: 'POST', body: JSON.stringify({ action: action, remark: remark })
    }).then(function (r) {
      if (!r) return;
      if (!r.ok) { alert(r.body.error || 'Could not resolve it.'); return; }
      renderRequests();
      if (action === 'approve') renderAccounts();
    });
  }

  /* Only ever shown once __mail/status says a server is actually
     configured (see set_mail.py) -- otherwise the card explains why it's
     off rather than presenting a compose form that can't send anything. */
  function renderBroadcastPickList() {
    var pick = $('#adminBroadcastPick');
    if (!pick) return;
    pick.innerHTML = accountsCache.filter(function (a) { return a.email; }).map(function (a) {
      return '<label class="admin-row"><input type="checkbox" value="' + esc(a.login) + '"> ' +
        '<span class="admin-row-sub">' + esc(a.login) + ' -- ' + esc(a.email) + '</span></label>';
    }).join('') || '<p class="admin-empty">No accounts have an email on file.</p>';
  }

  /* Admin-only data assistant -- a real, billed call to Anthropic per
     question (see set_llm.py / assistant.py), so unlike every other card
     here this never auto-runs anything on its own; it only ever fires
     when the admin actually submits a question. The on/off check itself
     is free (a local file read on the server), so that alone rides the
     same refreshAll() cycle as everything else -- the log content is
     untouched by that, only sendAsk() ever appends to it. */
  function renderAsk() {
    var card = $('#adminAskCard');
    if (!card) return;
    return fetch('__admin/ask/status', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : { enabled: false }; })
      .then(function (j) {
        card.style.display = '';
        var on = !!(j && j.enabled);
        $('#adminAskOff').style.display = on ? 'none' : '';
        $('#adminAskForm').style.display = on ? '' : 'none';
      });
  }

  function askLogTurn(question) {
    var log = $('#adminAskLog');
    var id = 'ask-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    var turn = d.createElement('div');
    turn.className = 'admin-ask-turn';
    turn.innerHTML = '<div class="admin-ask-q">' + esc(question) + '</div>' +
      '<div class="admin-ask-a pending" id="' + id + '">Thinking…</div>';
    log.appendChild(turn);
    log.scrollTop = log.scrollHeight;
    return id;
  }

  function sendAsk(e) {
    if (e) e.preventDefault();
    var input = $('#adminAskInput');
    var question = input.value.trim();
    if (!question) return;
    var btn = $('#adminAskSend');
    input.value = '';
    btn.disabled = true;
    var answerId = askLogTurn(question);
    api('__admin/ask', { method: 'POST', body: JSON.stringify({ question: question }) })
      .then(function (r) {
        btn.disabled = false;
        var el = $('#' + answerId);
        if (!el) return;
        el.classList.remove('pending');
        if (!r.ok || !r.body.ok) {
          el.classList.add('err');
          el.textContent = (r.body && r.body.error) || 'Could not reach the assistant.';
          return;
        }
        el.textContent = r.body.answer;
        $('#adminAskLog').scrollTop = $('#adminAskLog').scrollHeight;
      });
  }

  function renderBroadcast() {
    var card = $('#adminBroadcastCard');
    if (!card) return;
    return fetch('__mail/status', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : { enabled: false }; })
      .then(function (j) {
        card.style.display = '';
        var on = !!(j && j.enabled);
        $('#adminBroadcastOff').style.display = on ? 'none' : '';
        $('#adminBroadcastForm').style.display = on ? '' : 'none';
        if (on) renderBroadcastPickList();
      });
  }

  function sendBroadcast() {
    var subject = $('#adminBroadcastSubject').value.trim();
    var message = $('#adminBroadcastMessage').value.trim();
    var msg = $('#adminBroadcastMsg');
    if (!subject || !message) {
      msg.textContent = 'A subject and a message are required.';
      msg.className = 'gate-msg err'; msg.style.display = 'flex';
      return;
    }
    var to = document.querySelector('input[name="adminBroadcastTo"]:checked').value;
    var logins = null;
    if (to === 'pick') {
      logins = $$('#adminBroadcastPick input:checked').map(function (c) { return c.value; });
      if (!logins.length) {
        msg.textContent = 'Choose at least one account.';
        msg.className = 'gate-msg err'; msg.style.display = 'flex';
        return;
      }
    }
    var btn = $('#adminBroadcastSend');
    btn.disabled = true;
    msg.textContent = 'Sending…'; msg.className = 'gate-msg'; msg.style.display = 'flex';
    // The server waits for every send to actually finish before answering,
    // so this can take a few seconds for more than a couple of recipients --
    // worth it to report what really happened instead of just "queued".
    api('__admin/broadcast', { method: 'POST', body: JSON.stringify({ subject: subject, message: message, logins: logins }) })
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok) {
          msg.textContent = r.body.error || 'Could not send it.';
          msg.className = 'gate-msg err'; msg.style.display = 'flex';
          return;
        }
        var failed = r.body.failed || [];
        if (!failed.length) {
          msg.textContent = 'Sent to ' + r.body.sent + ' account' + (r.body.sent === 1 ? '' : 's') + '.';
          msg.className = 'gate-msg ok';
        } else {
          msg.textContent = 'Sent to ' + r.body.sent + ', failed for ' + failed.length +
            ' (' + failed.join(', ') + ') -- check the server console for why.';
          msg.className = 'gate-msg err';
        }
        msg.style.display = 'flex';
        $('#adminBroadcastSubject').value = ''; $('#adminBroadcastMessage').value = '';
      });
  }

  function renderDashboardVisibility() {
    var box = $('#adminDashboards');
    if (!box) return;
    if (!box.dataset.loaded) box.textContent = 'Loading…';
    return api('__admin/dashboards').then(function (r) {
      box.dataset.loaded = '1';
      if (!r.ok) { box.textContent = 'Could not load.'; return; }
      var rows = (r.body.dashboards || []).filter(function (d) { return d.status !== 'planned' && d.status !== 'archived'; });
      // Admin-only dashboards first -- the ones actually worth double-checking
      // shouldn't be buried below a long list of ones already visible to everyone.
      rows = rows.slice().sort(function (a, b) { return (b.adminOnly ? 1 : 0) - (a.adminOnly ? 1 : 0); });
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
    if (!box.dataset.loaded) box.textContent = 'Loading…';
    return api('__admin/sessions').then(function (r) {
      box.dataset.loaded = '1';
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

  var accountsCache = [];

  function renderAccounts() {
    var box = $('#adminAccounts');
    if (!box) return;
    if (!box.dataset.loaded) box.textContent = 'Loading…';
    return Promise.all([api('__admin/accounts'), api('__admin/sessions')]).then(function (res) {
      box.dataset.loaded = '1';
      var r = res[0], sr = res[1];
      if (!r.ok) { box.textContent = 'Could not load.'; return; }
      var rows = r.body.accounts || [];
      accountsCache = rows;
      renderBroadcastPickList();
      var viewing = {};
      (sr.ok ? (sr.body.sessions || []) : []).forEach(function (s) { viewing[s.login] = s.viewing; });
      box.innerHTML = rows.map(function (a) {
        var live = Object.prototype.hasOwnProperty.call(viewing, a.login)
          ? '<span class="admin-badge admin-badge-ok">' + (viewing[a.login] ? 'viewing ' + esc(viewing[a.login]) : 'on the hub') + ' now</span> '
          : '';
        // Just the name and employee ID here -- everything else (designation,
        // department, category, phone, email) crowded the row and pushed it
        // out of alignment; the full profile is one click away in Edit profile.
        var nameLine = [a.name || 'No name on file', a.parasId].filter(Boolean).join(' · ');
        return '<div class="admin-row"><div class="admin-row-main"><b>' + esc(a.login) + '</b>' +
          (a.isAdmin ? ' <span class="admin-badge">admin</span>' : '') +
          (a.totpEnabled ? ' <span class="admin-badge admin-badge-ok">2FA on</span>' : '') +
          (a.disabled ? ' <span class="admin-badge admin-badge-bad">disabled</span>' : '') +
          ' ' + live +
          '<span class="admin-row-sub">' + esc(nameLine) +
          ' · signed in ' + a.sessionCount + ' time' + (a.sessionCount === 1 ? '' : 's') +
          ' · ' + fmtMs(a.totalTimeMs) + ' total</span>' +
          '</div>' +
          '<div class="admin-row-acts">' +
          '<button class="btn sm" data-usage="' + esc(a.login) + '">Usage</button>' +
          '<button class="btn sm" data-edit="' + esc(a.login) + '">Edit profile</button>' +
          '<button class="btn sm" data-reset="' + esc(a.login) + '">Reset password</button>' +
          '<button class="btn sm" data-rename="' + esc(a.login) + '">Rename</button>' +
          (a.totpEnabled ? '<button class="btn sm" data-disable-totp="' + esc(a.login) + '">Disable 2FA</button>' : '') +
          '<button class="btn sm" data-remove="' + esc(a.login) + '" data-disabled="' + (a.disabled ? '1' : '0') + '">' +
          (a.disabled ? 'Enable / delete' : 'Disable / delete') + '</button></div></div>';
      }).join('');

      $$('[data-usage]', box).forEach(function (btn) {
        btn.addEventListener('click', function () { openUsage(btn.dataset.usage); });
      });
      $$('[data-edit]', box).forEach(function (btn) {
        btn.addEventListener('click', function () { openEditProfile(btn.dataset.edit); });
      });
      $$('[data-reset]', box).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var pw = prompt('New password for ' + btn.dataset.reset + ' (at least 10 characters):');
          if (!pw) return;
          apiStepUp('__admin/accounts/' + encodeURIComponent(btn.dataset.reset) + '/reset-password', {
            method: 'POST', body: JSON.stringify({ newPassword: pw })
          }).then(function (r2) { if (r2 && !r2.ok) alert(r2.body.error || 'Could not reset it.'); });
        });
      });
      $$('[data-rename]', box).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var name = prompt('New sign-in name for ' + btn.dataset.rename + ':');
          if (!name) return;
          apiStepUp('__admin/accounts/' + encodeURIComponent(btn.dataset.rename) + '/rename', {
            method: 'POST', body: JSON.stringify({ newLogin: name })
          }).then(function (r2) {
            if (!r2) return;
            if (!r2.ok) { alert(r2.body.error || 'Could not rename it.'); return; }
            renderAccounts();
          });
        });
      });
      $$('[data-disable-totp]', box).forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (!confirm('Turn off two-factor authentication for ' + btn.dataset.disableTotp +
            '? Use this to rescue an account that has lost its authenticator and backup codes.')) return;
          apiStepUp('__admin/accounts/' + encodeURIComponent(btn.dataset.disableTotp) + '/disable-2fa', {
            method: 'POST'
          }).then(function (r2) {
            if (!r2) return;
            if (!r2.ok) { alert(r2.body.error || 'Could not turn it off.'); return; }
            renderAccounts();
          });
        });
      });
      $$('[data-remove]', box).forEach(function (btn) {
        btn.addEventListener('click', function () {
          openRemoveAccount(btn.dataset.remove, btn.dataset.disabled === '1');
        });
      });
    });
  }

  function openRemoveAccount(login, disabled) {
    $('#removeAccountModal').dataset.login = login;
    $('#removeAccountTitle').textContent = login;
    $('#removeAccountToggle').textContent = disabled ? 'Enable' : 'Disable';
    $('#removeAccountModal').classList.add('open');
  }

  function closeRemoveAccount() {
    $('#removeAccountModal').classList.remove('open');
  }

  function toggleFromRemoveModal() {
    var login = $('#removeAccountModal').dataset.login;
    var willDisable = $('#removeAccountToggle').textContent === 'Disable';
    if (willDisable && !confirm('Disable ' + login +
      '? They will be signed out and unable to sign in again until re-enabled.')) return;
    apiStepUp('__admin/accounts/' + encodeURIComponent(login) + '/disable', {
      method: 'POST', body: JSON.stringify({ disabled: willDisable })
    }).then(function (r) {
      if (!r) return;
      if (!r.ok) { alert(r.body.error || 'Could not update it.'); return; }
      closeRemoveAccount();
      renderAccounts();
    });
  }

  function deleteFromRemoveModal() {
    var login = $('#removeAccountModal').dataset.login;
    if (!confirm('Permanently delete ' + login + '? This cannot be undone -- ' +
      'their account, password, and 2FA setup are all removed. Login history is kept.')) return;
    apiStepUp('__admin/accounts/' + encodeURIComponent(login) + '/delete', { method: 'POST' })
      .then(function (r) {
        if (!r) return;
        if (!r.ok) { alert(r.body.error || 'Could not delete it.'); return; }
        closeRemoveAccount();
        renderAccounts();
      });
  }

  function openEditProfile(login) {
    var a = accountsCache.filter(function (x) { return x.login === login; })[0];
    if (!a) return;
    $('#editProfileModal').dataset.login = login;
    $('#editProfileName').value = a.name || '';
    fillSelect($('#editProfileDesignation'), DESIGNATIONS, a.designation);
    fillSelect($('#editProfileDepartment'), DEPARTMENTS, a.department);
    fillSelect($('#editProfileCategory'), CATEGORIES, a.category);
    $('#editProfilePhone').value = a.phone || '';
    $('#editProfileEmail').value = a.email || '';
    $('#editProfileParasId').value = a.parasId || '';
    var msg = $('#editProfileMsg'); msg.style.display = 'none'; msg.textContent = '';
    $('#editProfileModal').classList.add('open');
  }

  // Two letters, a dash, three letters, a dash, five digits -- e.g. GG-COR-07365.
  var PARAS_ID_RE = /^[A-Z]{2}-[A-Z]{3}-[0-9]{5}$/;

  function saveEditProfile() {
    var login = $('#editProfileModal').dataset.login;
    if (!login) return;
    var parasId = $('#editProfileParasId').value.trim().toUpperCase();
    if (parasId && !PARAS_ID_RE.test(parasId)) {
      var msg = $('#editProfileMsg');
      msg.textContent = 'The employee ID must be in the format AA-BBB-12345 (two letters, three letters, five digits).';
      msg.className = 'gate-msg err'; msg.style.display = 'flex';
      return;
    }
    var body = {
      name: $('#editProfileName').value.trim(),
      designation: $('#editProfileDesignation').value,
      department: $('#editProfileDepartment').value,
      category: $('#editProfileCategory').value,
      phone: $('#editProfilePhone').value.trim(),
      email: $('#editProfileEmail').value.trim(),
      parasId: parasId
    };
    var btn = $('#editProfileSave');
    btn.disabled = true;
    apiStepUp('__admin/accounts/' + encodeURIComponent(login) + '/update-profile', {
      method: 'POST', body: JSON.stringify(body)
    }).then(function (r) {
      btn.disabled = false;
      if (!r) return;
      if (!r.ok) {
        var msg = $('#editProfileMsg');
        msg.textContent = r.body.error || 'Could not save it.';
        msg.className = 'gate-msg err'; msg.style.display = 'flex';
        return;
      }
      $('#editProfileModal').classList.remove('open');
      renderAccounts();
    });
  }

  var usageGroup = 'month';
  var usageLastByDay = {};
  var usageLastNames = {};

  function openUsage(login) {
    usageGroup = 'month';
    $('#usageTitle').textContent = 'Usage — ' + login;
    $('#usageByMonth').classList.add('primary');
    $('#usageByDay').classList.remove('primary');
    $('#usageModal').classList.add('open');
    $('#usageBody').textContent = 'Loading…';
    $('#usageLive').textContent = '';
    Promise.all([api('__admin/usage'), api('__admin/sessions'), dashboardNames()]).then(function (res) {
      var ur = res[0], sr = res[1], names = res[2];
      var live = (sr.ok ? (sr.body.sessions || []) : []).filter(function (s) { return s.login === login; })[0];
      $('#usageLive').textContent = live
        ? 'Currently ' + (live.viewing ? 'viewing ' + (names[live.viewing] || live.viewing) : 'on the hub') + '.'
        : 'Not signed in right now.';
      if (!ur.ok) { $('#usageBody').textContent = 'Could not load.'; return; }
      usageLastByDay = (ur.body.usage || {})[login] || {};
      usageLastNames = names;
      renderUsageBody(usageLastByDay, usageLastNames);
    });
  }

  function setUsageGroup(g) {
    usageGroup = g;
    $('#usageByMonth').classList.toggle('primary', g === 'month');
    $('#usageByDay').classList.toggle('primary', g === 'day');
    renderUsageBody(usageLastByDay, usageLastNames);
  }

  function renderUsageBody(byDay, names) {
    var days = Object.keys(byDay).sort().reverse();
    var buckets = {};
    if (usageGroup === 'day') {
      days.forEach(function (d) { buckets[d] = byDay[d]; });
    } else {
      days.forEach(function (d) {
        var month = d.slice(0, 7);
        var b = buckets[month] || (buckets[month] = { totalMs: 0, dashboards: {} });
        b.totalMs += byDay[d].totalMs;
        Object.keys(byDay[d].dashboards || {}).forEach(function (id) {
          b.dashboards[id] = (b.dashboards[id] || 0) + byDay[d].dashboards[id];
        });
      });
    }
    var keys = Object.keys(buckets).sort().reverse();
    var body = $('#usageBody');
    if (!keys.length) { body.innerHTML = '<p class="admin-empty">No recorded activity yet.</p>'; return; }
    body.innerHTML = keys.map(function (k) {
      var b = buckets[k];
      var dashList = Object.keys(b.dashboards).sort(function (x, y) { return b.dashboards[y] - b.dashboards[x]; })
        .map(function (id) { return (names[id] || id) + ' (' + fmtMs(b.dashboards[id]) + ')'; }).join(', ');
      return '<div class="admin-row"><div class="admin-row-main"><b>' + esc(k) + '</b>' +
        '<span class="admin-row-sub">' + fmtMs(b.totalMs) + ' total</span>' +
        (dashList ? '<span class="admin-row-sub">' + esc(dashList) + '</span>' : '') + '</div></div>';
    }).join('');
  }

  function renderStorage() {
    var box = $('#adminStorage'), sum = $('#adminStorageSummary');
    if (!box) return;
    if (!box.dataset.loaded) box.textContent = 'Loading…';
    return api('__admin/storage').then(function (r) {
      box.dataset.loaded = '1';
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

  function renderBackups() {
    var box = $('#adminBackups'), sum = $('#adminBackupSummary');
    if (!box) return;
    if (!box.dataset.loaded) box.textContent = 'Loading…';
    return api('__admin/backups').then(function (r) {
      box.dataset.loaded = '1';
      if (!r.ok) { box.textContent = 'Could not load.'; return; }
      var rows = r.body.backups || [];
      if (sum) sum.textContent = rows.length + ' backup' + (rows.length === 1 ? '' : 's') +
        ' kept · stored in ' + esc(r.body.dir || '');
      if (!rows.length) {
        box.innerHTML = '<p class="admin-empty">No backups yet -- one is taken automatically, or use "Back up now".</p>';
        return;
      }
      box.innerHTML = rows.map(function (b) {
        return '<div class="admin-row"><div class="admin-row-main"><b>' + esc(b.name) + '</b>' +
          '<span class="admin-row-sub">' + fmtBytes(b.size) + ' · ' + fmtWhen(b.createdAt) + '</span></div>' +
          '<a class="btn sm" href="__admin/backups/' + encodeURIComponent(b.name) + '" download>Download</a></div>';
      }).join('');
    });
  }

  function backupNow() {
    var btn = $('#adminBackupNow');
    if (btn) { btn.disabled = true; btn.textContent = 'Backing up…'; }
    api('__admin/backups', { method: 'POST' }).then(function (r) {
      if (btn) { btn.disabled = false; btn.textContent = 'Back up now'; }
      if (!r.ok) { alert(r.body.error || 'Backup failed.'); return; }
      renderBackups();
    });
  }

  var HISTORY_LABEL = {
    login_ok: 'Signed in', login_fail: 'Wrong password',
    logout: 'Signed out', force_logout: 'Signed out (forced)',
    totp_enabled: '2FA turned on', totp_disabled: '2FA turned off',
    password_reset_by_admin: 'Password reset (by admin)'
  };

  var historyLimit = 300;

  var expandedHistoryLogin = null;

  function historyRowHtml(e) {
    var bad = e.event === 'login_fail' ? ' admin-badge-bad' : '';
    var ip = e.ip ? ' · ' + esc(e.ip) : '';
    return '<div class="admin-row"><div class="admin-row-main">' +
      '<span class="admin-badge' + bad + '">' + esc(HISTORY_LABEL[e.event] || e.event) + '</span>' +
      '<span class="admin-row-sub">' + fmtWhen(e.ts) + ip + '</span></div></div>';
  }

  /* One row per person, most-recently-active first -- their latest event is
     the overview; clicking a name expands their full history in place. The
     "keep for longer" ask this replaced is handled by fetching a bigger
     batch (historyLimit, "Load more history" bumps it) and grouping that
     client-side, rather than a per-account request every click. */
  function renderHistory() {
    var box = $('#adminHistory');
    if (!box) return;
    if (!box.dataset.loaded) box.textContent = 'Loading…';
    return api('__admin/history?limit=' + historyLimit).then(function (r) {
      box.dataset.loaded = '1';
      if (!r.ok) { box.textContent = 'Could not load.'; return; }
      var rows = r.body.history || [];   // newest first, per read_history()
      var more = $('#adminHistoryMore');
      if (more) more.style.display = rows.length >= historyLimit ? '' : 'none';
      if (!rows.length) { box.innerHTML = '<p class="admin-empty">No activity recorded yet.</p>'; return; }

      var byLogin = {};
      var order = [];
      rows.forEach(function (e) {
        if (!byLogin[e.login]) { byLogin[e.login] = []; order.push(e.login); }
        byLogin[e.login].push(e);
      });
      // `rows` is already newest-first, so `order` (first-seen) is already
      // most-recently-active-first -- no separate timestamp sort needed.

      box.innerHTML = order.map(function (login) {
        var events = byLogin[login];
        var latest = events[0];
        var bad = latest.event === 'login_fail' ? ' admin-badge-bad' : '';
        var open = login === expandedHistoryLogin;
        var head = '<div class="admin-row" data-history-person="' + esc(login) + '" style="cursor:pointer">' +
          '<div class="admin-row-main"><b>' + esc(login) + '</b>' +
          ' <span class="admin-badge' + bad + '">' + esc(HISTORY_LABEL[latest.event] || latest.event) + '</span>' +
          '<span class="admin-row-sub">' + fmtWhen(latest.ts) + ' · ' + events.length + ' event' + (events.length === 1 ? '' : 's') +
          ' loaded</span></div><span class="admin-badge">' + (open ? 'Hide' : 'Show all') + '</span></div>';
        var body = open ? '<div class="admin-history-detail">' + events.map(historyRowHtml).join('') + '</div>' : '';
        return head + body;
      }).join('');

      $$('[data-history-person]', box).forEach(function (row) {
        row.addEventListener('click', function () {
          var login = row.dataset.historyPerson;
          expandedHistoryLogin = (expandedHistoryLogin === login) ? null : login;
          renderHistory();
        });
      });
    });
  }

  var isAdminPromise = null;
  var sessionLoginCached = '';
  var sessionTotpEnabled = false;

  /* Memoised: app.js's boot() calls this once to decide whether to filter
     admin-only dashboards out of the registry before anything renders;
     checkAccess() below reuses the same result rather than asking twice.
     Also the one place sessionTotpEnabled gets set -- whether *this*
     signed-in account (not the one being edited) has 2FA on, which is
     what decides whether step-up is asked for below. */
  function isAdmin() {
    if (isAdminPromise) return isAdminPromise;
    isAdminPromise = fetch('__session', { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (who) {
      isAdminCached = !!(who && who.isAdmin);
      sessionLoginCached = (who && who.login) || '';
      sessionTotpEnabled = !!(who && who.totpEnabled);
      return isAdminCached;
    }).catch(function () { isAdminCached = false; return false; });
    return isAdminPromise;
  }

  /* ---- step-up re-verification --------------------------------------------
     Before a change that writes to the accounts file itself (reset/rename/
     disable/delete/update-profile/disable-2fa, approving a pending
     request), an admin whose own account has 2FA on is asked for their
     password and a fresh code again -- see _require_step_up in serve.py
     for why. withStepUp() wraps one of those calls: skips the modal
     entirely when this admin has no 2FA (nothing more to ask for), else
     opens it, computes the digest against this admin's own salt from
     auth.json (never the account being changed), and only calls `run`
     once both check out server-side -- retrying in place on a wrong
     password or code rather than closing and losing what was already
     typed into the underlying form. */
  var authDataPromise = null;
  function authData() {
    if (authDataPromise) return authDataPromise;
    authDataPromise = fetch('auth.json', { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : {};
    }).catch(function () { return {}; });
    return authDataPromise;
  }

  function withStepUp(run) {
    if (!sessionTotpEnabled) return run({});
    return new Promise(function (resolve, reject) {
      var modal = $('#stepUpModal');
      var form = $('#stepUpForm');
      var msg = $('#stepUpMsg');
      var passEl = $('#stepUpPass');
      var codeEl = $('#stepUpCode');
      function say(text) {
        msg.textContent = text || '';
        msg.style.display = text ? 'flex' : 'none';
      }
      function cleanup() {
        modal.classList.remove('open');
        form.removeEventListener('submit', onSubmit);
        $('#stepUpCancel').removeEventListener('click', onCancel);
      }
      function onCancel() {
        cleanup();
        reject(new Error('cancelled'));
      }
      function onSubmit(e) {
        e.preventDefault();
        var pass = passEl.value || '';
        var code = (codeEl.value || '').trim();
        if (!pass || !code) { say('Enter both your password and the 2FA code.'); return; }
        say('Verifying…');
        authData().then(function (auth) {
          var acc = (auth.accounts || []).filter(function (a) { return a.login === sessionLoginCached; })[0];
          var salt = acc ? acc.salt : '00';
          var iters = (acc && acc.iterations) || auth.iterations || 250000;
          return w.ParasCrypto.derive(pass, salt, iters);
        }).then(function (digest) {
          return run({ stepUpDigest: digest, stepUpCode: code });
        }).then(function (r) {
          if (r && r.status === 401 && r.body && r.body.stepUpRequired) {
            say(r.body.reason === 'code' ? 'Wrong code -- try again.' : 'Wrong password -- try again.');
            codeEl.value = '';
            (r.body.reason === 'code' ? codeEl : passEl).focus();
            return;
          }
          cleanup();
          resolve(r);
        }).catch(function (err) {
          say('Could not verify: ' + (err && err.message || err));
        });
      }
      passEl.value = ''; codeEl.value = ''; say('');
      form.addEventListener('submit', onSubmit);
      $('#stepUpCancel').addEventListener('click', onCancel);
      modal.classList.add('open');
      setTimeout(function () { passEl.focus(); }, 60);
    });
  }

  /* Same call as api(), just with withStepUp's extra fields folded into
     the body first when this admin's own 2FA requires them. A cancelled
     step-up resolves to null rather than rejecting, so call sites only
     need one extra "did they back out" check, not a whole catch block. */
  function apiStepUp(path, opts) {
    opts = opts || {};
    return withStepUp(function (extra) {
      var payload = Object.assign(JSON.parse(opts.body || '{}'), extra);
      return api(path, Object.assign({}, opts, { body: JSON.stringify(payload) }));
    }).catch(function () { return null; });
  }

  function checkAccess() {
    isAdmin().then(function (v) {
      var btn = $('#adminBtn');
      if (btn) btn.style.display = v ? '' : 'none';
      var tray = $('#adminNotifTray');
      if (tray) tray.style.display = v ? '' : 'none';
      if (v) startNotifPolling();
    });
  }

  /* Pending-requests bell in the topbar -- reachable from anywhere in the
     app, not just from inside the admin panel, so a new request doesn't
     sit unnoticed until the admin happens to open it. Polls independently
     of whether the admin panel itself is even open. */
  var notifTimer = null;
  var notifPending = [];

  function renderNotifTray() {
    api('__admin/requests').then(function (r) {
      if (!r.ok) return;
      notifPending = (r.body.requests || []).filter(function (q) { return q.status === 'pending'; })
        .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      var count = $('#adminNotifCount');
      if (count) {
        count.textContent = String(notifPending.length);
        count.style.display = notifPending.length ? '' : 'none';
      }
      var list = $('#adminNotifList');
      if (!list) return;
      list.innerHTML = notifPending.length
        ? notifPending.map(function (q) {
            var detail = q.type === 'id_change' ? ('wants to become "' + esc((q.payload || {}).newLogin) + '"')
              : q.type === 'signup' ? 'new account request'
              : 'password reset request';
            return '<button type="button" class="pop-row" data-notif-goto style="flex-direction:column;align-items:flex-start;gap:2px;cursor:pointer">' +
              '<b class="nm">' + esc(q.login) + '</b>' +
              '<span style="font-size:11px;color:var(--ink-3)">' + esc(detail) + ' · ' + fmtWhen(q.createdAt) + '</span></button>';
          }).join('')
        : '<p class="empty">Nothing waiting on approval.</p>';
    });
  }

  function startNotifPolling() {
    if (notifTimer) return;
    renderNotifTray();
    notifTimer = setInterval(renderNotifTray, 10000);
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
    var backupBtn = $('#adminBackupNow');
    if (backupBtn) backupBtn.addEventListener('click', backupNow);

    var notifBtn = $('#adminNotifBtn');
    if (notifBtn) notifBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var p = $('#adminNotifPop');
      var open = p.style.display === 'block';
      if (!open) renderNotifTray();
      p.style.display = open ? 'none' : 'block';
    });
    var notifList = $('#adminNotifList');
    if (notifList) notifList.addEventListener('click', function (e) {
      if (e.target.closest('[data-notif-goto]')) {
        $('#adminNotifPop').style.display = 'none';
        location.hash = '#/admin';
      }
    });
    d.addEventListener('click', function (e) {
      if (!e.target.closest('#adminNotifTray')) { var p = $('#adminNotifPop'); if (p) p.style.display = 'none'; }
    });

    var histMore = $('#adminHistoryMore');
    if (histMore) histMore.addEventListener('click', function () { historyLimit += 300; renderHistory(); });

    var editClose = $('#editProfileClose'), editCancel = $('#editProfileCancel');
    if (editClose) editClose.addEventListener('click', function () { $('#editProfileModal').classList.remove('open'); });
    if (editCancel) editCancel.addEventListener('click', function () { $('#editProfileModal').classList.remove('open'); });
    var editSave = $('#editProfileSave');
    if (editSave) editSave.addEventListener('click', saveEditProfile);
    var editParasId = $('#editProfileParasId');
    if (editParasId) editParasId.addEventListener('input', function () {
      var up = (this.value || '').toUpperCase();
      if (up !== this.value) this.value = up;
    });
    var editModal = $('#editProfileModal');
    if (editModal) editModal.addEventListener('click', function (e) { if (e.target === e.currentTarget) editModal.classList.remove('open'); });

    var usageClose = $('#usageClose');
    if (usageClose) usageClose.addEventListener('click', function () { $('#usageModal').classList.remove('open'); });
    var usageModal = $('#usageModal');
    if (usageModal) usageModal.addEventListener('click', function (e) { if (e.target === e.currentTarget) usageModal.classList.remove('open'); });
    var usageByMonth = $('#usageByMonth'), usageByDay = $('#usageByDay');
    if (usageByMonth) usageByMonth.addEventListener('click', function () { setUsageGroup('month'); });
    if (usageByDay) usageByDay.addEventListener('click', function () { setUsageGroup('day'); });

    var askForm = $('#adminAskInputForm');
    if (askForm) askForm.addEventListener('submit', sendAsk);

    var broadcastSend = $('#adminBroadcastSend');
    if (broadcastSend) broadcastSend.addEventListener('click', sendBroadcast);
    $$('input[name="adminBroadcastTo"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        $('#adminBroadcastPick').style.display = (this.value === 'pick' && this.checked) ? '' : 'none';
      });
    });

    var removeToggle = $('#removeAccountToggle'), removeDelete = $('#removeAccountDelete'),
        removeCancel = $('#removeAccountCancel'), removeModal = $('#removeAccountModal');
    if (removeToggle) removeToggle.addEventListener('click', toggleFromRemoveModal);
    if (removeDelete) removeDelete.addEventListener('click', deleteFromRemoveModal);
    if (removeCancel) removeCancel.addEventListener('click', closeRemoveAccount);
    if (removeModal) removeModal.addEventListener('click', function (e) { if (e.target === e.currentTarget) closeRemoveAccount(); });
  });

  w.ParasAdmin = { checkAccess: checkAccess, isAdmin: isAdmin, reportViewing: reportViewing, showIfAllowed: showIfAllowed };
})(window, document);
