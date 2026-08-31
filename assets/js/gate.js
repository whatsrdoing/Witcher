/* Sign-in gate for the Command Centre.
 *
 * Scope, stated plainly: this keeps the Command Centre closed to someone who
 * opens it on this machine. It is not encryption — the dashboard HTML files
 * sit in dashboards/ and can be opened directly by anyone holding the folder.
 * For that, protect the folder at the operating-system level.
 *
 * Any number of accounts can sign in, each with its own username and
 * password (auth.json's "accounts" list). No password is ever stored —
 * only a random salt and a PBKDF2-HMAC-SHA256 hash of it, per account.
 * Reset the primary one with `python3 set_password.py`; anyone with the
 * admin key can add another from the Sign up screen here. */
(function (w, d) {
  'use strict';

  var UNLOCK_KEY = 'paras.cc.unlocked.v1';
  var FAIL_KEY = 'paras.cc.failed.v1';
  var EXTRA_KEY = 'paras.cc.extraAccounts.v1';    // file:// fallback: sign-ups with nowhere to write
  var OVERRIDE_KEY = 'paras.cc.authOverride.v1';  // file:// fallback: a reset password
  var WHOAMI_KEY = 'paras.cc.whoami.v1';          // which account unlocked this tab, for a reload
  var cfg = null, busy = false, onUnlock = null, currentProfile = null;
  var signInStep = 'user';    // 'user' | 'pass' -- which half of the two-step sign-in shows
  var signupPhotoFile = null; // chosen on the sign-up screen, applied once the account exists

  var $ = function (s) { return d.querySelector(s); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  function loadConfig() {
    // Browsers refuse to fetch a local .json over file://, so don't even try
    // there — go straight to the auth.js mirror instead of logging a failure.
    if (location.protocol === 'file:') return Promise.resolve(w.__PARAS_AUTH__ || null);
    return fetch('auth.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(function () { return w.__PARAS_AUTH__ || null; });
  }

  /* ---- accounts ----------------------------------------------------------
     cfg.accounts is the real list. Older auth.json files (or a stale
     mirror) only have the single legacy email/salt/hash fields — synthesised
     into a one-account list so the rest of this file never has to care.

     Detected by cfg.salt rather than cfg.hash: served over http(s), the
     hash itself is stripped out of what /auth.json hands back before
     sign-in (see serve.py's _send_auth) -- salt is not, so it is what is
     actually there to check for "is a legacy account configured at all". */
  function baseAccounts() {
    if (cfg && Array.isArray(cfg.accounts) && cfg.accounts.length) return cfg.accounts;
    if (cfg && cfg.salt) return [{ login: cfg.email || (cfg.logins || [])[0] || '', salt: cfg.salt, hash: cfg.hash, iterations: cfg.iterations }];
    return [];
  }
  function readExtraAccounts() {
    try { var v = JSON.parse(localStorage.getItem(EXTRA_KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  /* Every account this browser knows about: the ones in auth.json, plus any
     added from Sign up that never made it to the file (file:// with nothing
     to write to, or a server write that failed). */
  function allAccounts() {
    var base = baseAccounts();
    var extra = readExtraAccounts();
    var seen = {}; base.forEach(function (a) { seen[a.login] = 1; });
    extra.forEach(function (a) { if (!seen[a.login]) { base = base.concat([a]); seen[a.login] = 1; } });
    return base;
  }
  function findAccount(login) {
    var all = allAccounts();
    for (var i = 0; i < all.length; i++) if (all[i].login === login) return all[i];
    return null;
  }

  /* A weak password here is worse than usual: since #14, a signup or reset
     is not applied until an admin approves it, so a rejected-for-weakness
     password costs the person a full extra round trip through that queue,
     not just an instant "try again" -- worth catching here, before it is
     ever sent. Checked client-side because that is the only place a plain
     password ever exists: the server sees only a PBKDF2 hash. */
  var COMMON_PASSWORDS = [
    'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
    'qwerty123', 'qwertyuiop', 'letmein123', 'welcome123', 'admin1234', 'iloveyou1'
  ];
  function passwordProblem(pw, login) {
    if (pw.length < 10) return 'Use at least 10 characters.';
    if (login && pw.toLowerCase() === String(login).toLowerCase()) return "Don't use the sign-in name as the password.";
    if (COMMON_PASSWORDS.indexOf(pw.toLowerCase()) !== -1) return 'That password is too easy to guess -- pick another.';
    return null;
  }

  /* Which account unlocked this tab -- survives a reload (sessionStorage),
     gone once the tab closes, same as the rest of what "signed in" means
     here. Re-resolved against the account list on load so a reload always
     shows the up-to-date name/designation/etc. */
  function setCurrentUser(login) {
    currentProfile = findAccount(login) || { login: login };
    try { sessionStorage.setItem(WHOAMI_KEY, login); } catch (e) {}
  }
  function restoreCurrentUser() {
    try {
      var v = sessionStorage.getItem(WHOAMI_KEY);
      if (v) currentProfile = findAccount(v) || { login: v };
    } catch (e) {}
  }

  /* Failed-attempt state survives a reload so refreshing does not reset a lockout. */
  function fails() {
    try { return JSON.parse(sessionStorage.getItem(FAIL_KEY) || '{"n":0,"until":0}'); }
    catch (e) { return { n: 0, until: 0 }; }
  }
  function setFails(v) { try { sessionStorage.setItem(FAIL_KEY, JSON.stringify(v)); } catch (e) {} }
  function clearFails() { try { sessionStorage.removeItem(FAIL_KEY); } catch (e) {} }

  function unlockedThisSession() {
    try { return sessionStorage.getItem(UNLOCK_KEY) === '1'; } catch (e) { return false; }
  }

  function say(msg, kind) {
    var el = $('#gateMsg');
    el.className = 'gate-msg' + (kind ? ' ' + kind : '');
    el.textContent = msg || '';
    el.style.display = msg ? 'flex' : 'none';
  }

  function shake() {
    var card = $('#gateCard');
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
  }

  function lockoutRemaining() {
    var f = fails();
    return f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
  }

  var tickTimer = null;
  function tickLockout() {
    var left = lockoutRemaining();
    if (left > 0) {
      $('#gateSubmit').disabled = true;
      say('Too many failed attempts. Try again in ' + left + 's.', 'err');
      tickTimer = setTimeout(tickLockout, 1000);
    } else {
      clearTimeout(tickTimer); tickTimer = null;
      $('#gateSubmit').disabled = false;
      if (fails().until) { setFails({ n: 0, until: 0 }); say(''); }
    }
  }

  /* ---- two-step sign-in ---------------------------------------------------
     Username first, password only once that username is known to exist.
     findAccount() matches case-sensitively -- "admin/ritik" and
     "Admin/Ritik" are different logins, only the exact configured spelling
     is accepted -- so this reveals no more than typing the wrong case
     already would have. Once the account is confirmed to exist, naming the
     password (not the username) as wrong on a failed attempt is accurate,
     not a leak: step one already said the account is real. */
  function resetSignInStep() {
    signInStep = 'user';
    $('#gateWho').style.display = 'none';
    $('#gatePassWrap').style.display = 'none';
    $('#gatePass').value = '';
    $('#gateSubmitLabel').textContent = 'Continue';
    $('#gateSubmitIcoNext').style.display = '';
    $('#gateSubmitIcoLock').style.display = 'none';
  }

  function enterPassStep(acc) {
    signInStep = 'pass';
    say('');
    $('#gateWhoWelcome').textContent = 'Welcome, ' + (acc.name || acc.login);
    $('#gateWho').style.display = 'flex';
    if (w.Avatar) w.Avatar.paint($('#gateWhoAvatar'), acc);
    $('#gatePassWrap').style.display = 'block';
    $('#gateSubmitLabel').textContent = 'Verify access credentials';
    $('#gateSubmitIcoNext').style.display = 'none';
    $('#gateSubmitIcoLock').style.display = '';
    setTimeout(function () { $('#gatePass').focus(); }, 60);
  }

  function gateContinue(e) {
    if (e) e.preventDefault();
    if (busy || lockoutRemaining() > 0) return;
    if (signInStep === 'pass') { verifyPassword(); return; }

    var login = ($('#gateEmail').value || '').trim();
    if (!login) { say('Enter your username.', 'err'); shake(); return; }
    var acc = findAccount(login);
    if (!acc) {
      say('No account named "' + login + '". Please sign up first.', 'err');
      shake();
      return;
    }
    enterPassStep(acc);
  }

  /* Whether the password actually matches is decided here in two different
     places depending on how this page is running, and that split is load-
     bearing, not incidental:

     - file:// has no server to ask at all, so the digest this browser just
       computed is compared to the hash sitting right here in cfg -- exactly
       as this always worked.
     - Served over http(s), that same comparison now also happens at
       POST /__session, and *that* copy is the one that actually matters:
       only a match there hands back the session cookie every /__data and
       /__library call now requires. auth.json no longer even carries the
       real hash to a browser that has not signed in yet (see serve.py's
       _send_auth), so a local-only compare in this case would silently
       accept nothing at all -- which is why this path calls the server
       instead of trying to replicate a check it no longer has the material
       for. */
  function verifyPassword() {
    var login = ($('#gateEmail').value || '').trim();
    var pass = $('#gatePass').value || '';
    if (!pass) { say('Enter your password.', 'err'); shake(); return; }

    busy = true;
    $('#gateSubmit').classList.add('working');
    say('Verifying…', '');

    var acc = findAccount(login);
    var salt = acc ? acc.salt : (cfg.adminKeySalt || '00');   // dummy salt when unknown, so timing does not out the login
    var iters = (acc && acc.iterations) || cfg.iterations || 250000;

    function finish(ok) {
      busy = false;
      $('#gateSubmit').classList.remove('working');

      if (ok) {
        clearFails();
        completeSignIn(acc.login);
        return;
      }

      var f = fails();
      f.n = (f.n || 0) + 1;
      var max = cfg.maxAttempts || 5;
      if (f.n >= max) {
        f.until = Date.now() + (cfg.lockoutSeconds || 60) * 1000;
        f.n = 0;
        setFails(f);
        shake();
        tickLockout();
      } else {
        setFails(f);
        say('Wrong password. ' + (max - f.n) + ' attempt' + (max - f.n === 1 ? '' : 's') + ' left.', 'err');
        shake();
        $('#gatePass').select();
      }
    }

    w.ParasCrypto.derive(pass, salt, iters).then(function (digest) {
      if (location.protocol === 'file:') {
        finish(!!acc && w.ParasCrypto.equal(digest, String(acc.hash || '')));
        return;
      }
      serverVerify(login, digest).then(function (result) {
        if (result.status === 'locked') {
          busy = false;
          $('#gateSubmit').classList.remove('working');
          say('Too many failed attempts. Try again shortly.', 'err');
          shake();
          return;
        }
        if (result.status === 'unknown') {
          // The server has never heard of this login -- a sign-up that
          // only ever made it into this browser's own storage, because the
          // server could not be reached when the account was created.
          // Nothing server-side to check it against, so fall back to the
          // local compare exactly as file:// mode always has.
          finish(!!acc && w.ParasCrypto.equal(digest, String(acc.hash || '')));
          return;
        }
        if (result.status === 'conflict') {
          busy = false;
          $('#gateSubmit').classList.remove('working');
          openConflict(login, result.conflictToken);
          return;
        }
        if (result.status === 'totp') {
          busy = false;
          $('#gateSubmit').classList.remove('working');
          clearFails();
          openTotp(login, result.totpToken);
          return;
        }
        finish(result.status === 'ok');
      });
    }).catch(function (err) {
      busy = false;
      $('#gateSubmit').classList.remove('working');
      say('Could not verify: ' + (err && err.message || err), 'err');
    });
  }

  /* Shared tail end of a successful sign-in, whichever path got there --
     a plain password match, or a resolved single-session conflict below. */
  function completeSignIn(login) {
    try { sessionStorage.setItem(UNLOCK_KEY, '1'); } catch (err) {}
    setCurrentUser(login);
    say('Access granted', 'ok');
    open_();
  }

  /* POST /__session -- see verifyPassword above. Resolves to
     {status:'ok'}, {status:'fail'} (server reached, wrong password),
     {status:'locked'} (too many recent attempts for this login),
     {status:'unknown'} (server reachable but has never heard of this
     login -- including a genuine connection failure, which gets the same
     treatment as "nothing to check this against" rather than being
     surfaced as an error on every keystroke of a typo'd username), or
     {status:'conflict', conflictToken} when this account already has an
     active session elsewhere -- see openConflict below. */
  function serverVerify(login, digest) {
    return fetch('__session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: login, digest: digest })
    }).then(function (r) {
      if (r.ok) return { status: 'ok' };
      if (r.status === 404) return { status: 'unknown' };
      if (r.status === 429) return { status: 'locked' };
      if (r.status === 409) {
        return r.json().then(function (body) {
          return { status: 'conflict', conflictToken: body && body.conflictToken };
        }).catch(function () { return { status: 'fail' }; });
      }
      if (r.status === 401) {
        return r.json().then(function (body) {
          return (body && body.totpRequired)
            ? { status: 'totp', totpToken: body.totpToken }
            : { status: 'fail' };
        }).catch(function () { return { status: 'fail' }; });
      }
      return { status: 'fail' };
    }).catch(function () { return { status: 'unknown' }; });
  }

  /* ---- single-active-session conflict ------------------------------------
     One account, one session. Landing here means the password was already
     right, so this screen offers a straight choice: sign the other session
     out and take over right now, or leave it be and wait -- quietly
     polling in the background -- until that other session ends on its own
     (a real sign-out, an idle timeout, expiry), at which point this one
     completes automatically with no further click needed. */
  var conflictPoll = null;

  function stopConflictPoll() {
    if (conflictPoll) { clearTimeout(conflictPoll); conflictPoll = null; }
  }

  function conflictSay(msg, kind) {
    var el = $('#conflictMsg');
    if (!msg) { el.style.display = 'none'; return; }
    el.textContent = msg;
    el.className = 'gate-msg' + (kind ? ' ' + kind : '');
    el.style.display = 'block';
  }

  function resolveConflict(login, token, force) {
    return fetch('__session/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conflictToken: token, force: !!force })
    }).then(function (r) {
      if (r.status === 410) {
        stopConflictPoll();
        conflictSay('That sign-in attempt expired. Please sign in again.', 'err');
        return;
      }
      // A 200 here does not by itself mean this sign-in completed -- the
      // "still active, keep waiting" reply is *also* a 200 (it is not an
      // error, there is nothing wrong with the request), just with
      // {ok:false} in the body. Only a body that actually says ok:true
      // carries a real session cookie; r.ok alone would wrongly treat
      // "still waiting" as "signed in".
      return r.json().catch(function () { return null; }).then(function (data) {
        if (r.ok && data && data.ok) { stopConflictPoll(); completeSignIn(login); return; }
        // Still active (force:false, other session has not ended yet) --
        // schedule the next poll rather than treating this as a failure.
        if (!force) conflictPoll = setTimeout(function () { resolveConflict(login, token, false); }, 3000);
      });
    }).catch(function () {
      if (!force) conflictPoll = setTimeout(function () { resolveConflict(login, token, false); }, 3000);
    });
  }

  function openConflict(login, token) {
    if (!token) { say('That account is already signed in elsewhere.', 'err'); return; }
    showScreen('gateConflict');
    conflictSay('');
    $('#conflictForceBtn').onclick = function () {
      stopConflictPoll();
      conflictSay('Signing the other session out…', '');
      resolveConflict(login, token, true);
    };
    $('#conflictBack').onclick = function (e) {
      e.preventDefault();
      stopConflictPoll();
      showSignIn();
    };
    resolveConflict(login, token, false);
  }

  /* ---- 2FA at sign-in -----------------------------------------------------
     Reached only once the password already matched (see verifyPassword) --
     the pending token proves that, so this screen only ever asks for the
     second factor, never the password again. */
  function totpSay(msg, kind) {
    var el = $('#totpMsg');
    el.className = 'gate-msg' + (kind ? ' ' + kind : '');
    el.textContent = msg || '';
    el.style.display = msg ? 'flex' : 'none';
  }

  function openTotp(login, token) {
    showScreen('gateTotp');
    totpSay('');
    $('#totpCode').value = '';
    setTimeout(function () { $('#totpCode').focus(); }, 60);
    $('#totpForm').onsubmit = function (e) { e.preventDefault(); doTotp(login, token); };
    $('#totpBack').onclick = function (e) { e.preventDefault(); showSignIn(); };
  }

  function doTotp(login, token) {
    if (busy) return;
    var code = ($('#totpCode').value || '').trim();
    if (!code) return totpSay('Enter the code.', 'err');

    busy = true;
    $('#totpSubmit').classList.add('working');
    totpSay('Verifying…', '');
    fetch('__session/totp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totpToken: token, code: code })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) { return { r: r, body: body }; });
    }).then(function (res) {
      busy = false;
      $('#totpSubmit').classList.remove('working');
      if (res.r.ok && res.body.ok) { completeSignIn(login); return; }
      if (res.r.status === 409) { openConflict(login, res.body.conflictToken); return; }
      if (res.r.status === 404) { totpSay('That sign-in attempt expired. Please sign in again.', 'err'); return; }
      if (res.r.status === 429) { totpSay('Too many attempts. Try again shortly.', 'err'); return; }
      totpSay(res.body.error || 'Wrong code.', 'err');
      $('#totpCode').select();
    }).catch(function (err) {
      busy = false;
      $('#totpSubmit').classList.remove('working');
      totpSay('Could not verify: ' + (err && err.message || err), 'err');
    });
  }

  /* ---- screens: sign in / reset / sign up --------------------------------
     Only one of #gateSignIn, #gateReset, #gateSignup is visible at a time. */
  function showScreen(id) {
    ['gateSignIn', 'gateReset', 'gateSignup', 'gateConflict', 'gateTotp'].forEach(function (s) {
      $('#' + s).style.display = (s === id) ? 'block' : 'none';
    });
    var inner = $('#gateInner');
    if (inner) inner.classList.toggle('wide', id === 'gateSignup');
    say('');
  }

  /* A neutral, human line under the name. Fixed per calendar day rather than
     random per render, so it does not flicker into something different every
     time the username field is edited. */
  var CAPTIONS = [
    "How's your day going?",
    'Good to see you again.',
    'Hope the day is treating you well.',
    "Let's get to it.",
    'Ready when you are.'
  ];
  function captionForToday() {
    var d0 = new Date();
    var day = Math.floor(Date.UTC(d0.getFullYear(), d0.getMonth(), d0.getDate()) / 86400000);
    return CAPTIONS[((day % CAPTIONS.length) + CAPTIONS.length) % CAPTIONS.length];
  }

  /* ---- "how to sign in / reset password" help ------------------------------
     A short, self-contained walkthrough of the current flow (admin-approval
     queue, optional 2FA step, 10-character passwords) -- baked in here
     rather than fetched, since it is small, static, and needs to work
     before anyone is signed in (fetch of a doc file would work too, but
     this avoids one more request on the gate's critical path). */
  function helpHtml() {
    var admin = esc(cfg.admin || 'Ritik Nagar');
    return '' +
      '<h4>Signing in</h4>' +
      '<p class="reset-lede">Type your exact, case-sensitive username and press Continue. ' +
      'On the next step, type your password and press Continue again. If two-factor ' +
      'authentication is turned on for your account, you\'ll then be asked for the ' +
      '6-digit code from your authenticator app (or a backup code).</p>' +
      '<h4>Forgot your password?</h4>' +
      '<p class="reset-lede">Click <b>Forgot password?</b> on the sign-in screen, enter your ' +
      'exact username and a new password (at least 10 characters), and submit. This sends ' +
      'a request to ' + admin + ' for approval -- sign in with the new password once it\'s ' +
      'approved, not immediately.</p>' +
      '<h4>Need a new account?</h4>' +
      '<p class="reset-lede">Click <b>Sign up</b> and fill in your details. This also goes to ' +
      admin + ' for approval before you can sign in.</p>' +
      '<h4>Two-factor authentication</h4>' +
      '<p class="reset-lede">Once signed in, turn it on from the account menu under Security -- ' +
      'scan the QR code with an authenticator app, or enter the setup key by hand.</p>' +
      '<h4>Still stuck?</h4>' +
      '<p class="reset-lede">Contact ' + admin + ' directly rather than guessing.</p>';
  }
  function openHelp() {
    $('#gateHelpBody').innerHTML = helpHtml();
    $('#gateHelpModal').classList.add('open');
  }
  function closeHelp() {
    $('#gateHelpModal').classList.remove('open');
  }

  function showSignIn() {
    showScreen('gateSignIn');
    resetSignInStep();
    $('#gateWhoCaption').textContent = captionForToday();
    setTimeout(function () { $('#gateEmail').focus(); }, 60);
  }

  /* ---- password reset ------------------------------------------------------
     Forgot password does not mail anyone -- there is no server to mail from.
     It queues a request the admin approves (see submitRequest/_request_post).
     With more than one account on file, guessing which one to reset from
     whatever happened to be typed on the sign-in screen is not reliable --
     so the exact username is typed here instead, and has to match an
     existing account before the request is even sent. */
  function showReset() {
    showScreen('gateReset');
    $('#resetMsg').style.display = 'none';
    $('#resetAdmin').textContent = cfg.admin || 'Ritik Nagar';
    if (cfg.adminEmail) $('#resetAdmin').href = 'mailto:' + cfg.adminEmail;
    else $('#resetAdmin').removeAttribute('href');
    ['resetUser', 'resetPass', 'resetPass2'].forEach(function (id) { $('#' + id).value = ''; });

    var typed = ($('#gateEmail').value || '').trim();
    if (typed) $('#resetUser').value = typed;

    setTimeout(function () { $('#resetUser').focus(); }, 60);
  }
  function resetSay(msg, kind) {
    var el = $('#resetMsg');
    el.className = 'gate-msg' + (kind ? ' ' + kind : '');
    el.textContent = msg || '';
    el.style.display = msg ? 'flex' : 'none';
  }

  function doReset(e) {
    e.preventDefault();
    if (busy) return;
    var target = ($('#resetUser').value || '').trim();
    var p1 = $('#resetPass').value || '', p2 = $('#resetPass2').value || '';
    if (!target) return resetSay('Enter the exact username to reset.', 'err');
    if (!findAccount(target)) return resetSay('No account named "' + target + '".', 'err');
    var pwProblem = passwordProblem(p1, target);
    if (pwProblem) return resetSay(pwProblem, 'err');
    if (p1 !== p2) return resetSay('The two new passwords do not match.', 'err');

    busy = true;
    $('#resetSubmit').classList.add('working');

    var iters = cfg.iterations || 250000;
    resetSay('Sending the request…', '');

    var salt = randomSalt();
    w.ParasCrypto.derive(p1, salt, iters).then(function (hash) {
      return submitRequest('password_reset', { login: target, salt: salt, hash: hash, iterations: iters });
    }).then(function () {
      busy = false; $('#resetSubmit').classList.remove('working');
      resetSay('Request sent. Your password changes once an admin approves it -- try signing in with it after that.', 'ok');
      $('#resetPass').value = ''; $('#resetPass2').value = '';
    }).catch(function (err) {
      busy = false; $('#resetSubmit').classList.remove('working');
      resetSay((err && err.message) || 'Could not send the request.', 'err');
    });
  }

  function showSignup() {
    showScreen('gateSignup');
    $('#signupMsg').style.display = 'none';
    ['signupUser', 'signupFirstName', 'signupLastName', 'signupDesignation', 'signupDepartment', 'signupCategory',
     'signupPhone', 'signupEmail', 'signupParasId', 'signupPass', 'signupPass2']
      .forEach(function (id) { $('#' + id).value = ''; });
    signupPhotoFile = null;
    clearSignupPhotoPreview();
    resetSignupOtp();
    setTimeout(function () { $('#signupUser').focus(); }, 60);
  }

  function api(path, body) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, body: j }; });
      });
  }

  /* ---- sign-up email verification (OTP) ------------------------------------
     Only shown/required when the server says email is actually set up
     (__mail/status) -- fetched once and cached, since it can't change while
     this tab is open. Everything here degrades to "just sign up, no
     verification" the moment that's false, same as before this existed. */
  var mailEnabledPromise = null;
  function mailEnabled() {
    if (mailEnabledPromise) return mailEnabledPromise;
    mailEnabledPromise = fetch('__mail/status', { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : { enabled: false };
    }).then(function (j) { return !!(j && j.enabled); }).catch(function () { return false; });
    return mailEnabledPromise;
  }

  var signupOtpToken = null, signupOtpEmail = null;

  function resetSignupOtp() {
    signupOtpToken = null; signupOtpEmail = null;
    $('#signupOtpCodeWrap').style.display = 'none';
    $('#signupOtpCode').value = '';
    $('#signupOtpStatus').textContent = '';
    $('#signupOtpStatus').className = 'admin-row-sub';
    var btn = $('#signupOtpSend');
    btn.disabled = false; btn.textContent = 'Send verification code'; btn.style.display = '';
    mailEnabled().then(function (on) { $('#signupOtpWrap').style.display = on ? '' : 'none'; });
  }

  function currentSignupEmail() {
    return (($('#signupEmail').value || '').trim().split('@')[0] + EMAIL_DOMAIN).toLowerCase();
  }

  function sendSignupOtp() {
    var email = currentSignupEmail();
    if (email === EMAIL_DOMAIN.toLowerCase()) { signupSay('Enter the email first.', 'err'); return; }
    var btn = $('#signupOtpSend');
    btn.disabled = true; btn.textContent = 'Sending…';
    api('__otp/send', { email: email }).then(function (r) {
      btn.disabled = false; btn.textContent = 'Resend code';
      if (!r.ok) { $('#signupOtpStatus').textContent = r.body.error || 'Could not send it.'; $('#signupOtpStatus').className = 'admin-row-sub err'; return; }
      signupOtpEmail = email;
      $('#signupOtpCodeWrap').style.display = '';
      $('#signupOtpStatus').textContent = 'Code sent to ' + email + '.';
      $('#signupOtpStatus').className = 'admin-row-sub';
      $('#signupOtpCode').focus();
    });
  }

  function verifySignupOtp() {
    var email = currentSignupEmail();
    var code = ($('#signupOtpCode').value || '').trim();
    if (!code) return;
    var btn = $('#signupOtpVerify');
    btn.disabled = true;
    api('__otp/verify', { email: email, code: code }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { $('#signupOtpStatus').textContent = r.body.error || 'Wrong or expired code.'; $('#signupOtpStatus').className = 'admin-row-sub err'; return; }
      signupOtpToken = r.body.token; signupOtpEmail = email;
      $('#signupOtpCodeWrap').style.display = 'none';
      $('#signupOtpStatus').textContent = 'Email verified.';
      $('#signupOtpStatus').className = 'admin-row-sub ok';
      $('#signupOtpSend').style.display = 'none';
      signupSay('');
    });
  }

  /* ---- sign-up photo ------------------------------------------------------
     Held in memory while the form is filled in and only written once the
     account actually exists -- there is no account to attach it to before
     that, and a half-finished sign-up should leave nothing behind. */
  var signupPhotoUrl = null;
  function clearSignupPhotoPreview() {
    if (signupPhotoUrl) { try { URL.revokeObjectURL(signupPhotoUrl); } catch (e) {} signupPhotoUrl = null; }
    var el = $('#signupPhotoPreview');
    if (!el) return;
    el.style.backgroundImage = '';
    el.classList.remove('has-photo');
    el.textContent = '';
    var lab = $('#signupPhotoLabel');
    if (lab) lab.textContent = 'Optional — shown next to your name once signed in';
  }
  function previewSignupPhoto(file) {
    if (signupPhotoUrl) { try { URL.revokeObjectURL(signupPhotoUrl); } catch (e) {} }
    signupPhotoUrl = URL.createObjectURL(file);
    var el = $('#signupPhotoPreview');
    el.style.backgroundImage = 'url("' + signupPhotoUrl + '")';
    el.classList.add('has-photo');
    el.textContent = '';
    $('#signupPhotoLabel').textContent = 'Photo selected — tap to change';
  }
  function signupInitialsPreview() {
    var el = $('#signupPhotoPreview');
    if (!el || signupPhotoFile) return;
    var name = (($('#signupFirstName').value || '') + ' ' + ($('#signupLastName').value || '')).trim();
    el.textContent = (name && w.Avatar) ? w.Avatar.initials({ name: name }) : '';
  }
  function signupSay(msg, kind) {
    var el = $('#signupMsg');
    el.className = 'gate-msg' + (kind ? ' ' + kind : '');
    el.textContent = msg || '';
    el.style.display = msg ? 'flex' : 'none';
  }

  var EMAIL_DOMAIN = '@parashealth.com';
  // Two letters, a dash, three letters, a dash, five digits -- e.g. GG-COR-07365.
  var PARAS_ID_RE = /^[A-Z]{2}-[A-Z]{3}-[0-9]{5}$/;

  function doSignup(e) {
    e.preventDefault();
    if (busy) return;
    var login = ($('#signupUser').value || '').trim();
    var firstName = ($('#signupFirstName').value || '').trim();
    var lastName = ($('#signupLastName').value || '').trim();
    var name = (firstName + ' ' + lastName).trim();
    var designation = ($('#signupDesignation').value || '').trim();
    var department = ($('#signupDepartment').value || '').trim();
    var category = ($('#signupCategory').value || '').trim();
    var phone = ($('#signupPhone').value || '').trim();
    var emailLocal = ($('#signupEmail').value || '').trim().split('@')[0];
    var parasId = ($('#signupParasId').value || '').trim().toUpperCase();
    var p1 = $('#signupPass').value || '', p2 = $('#signupPass2').value || '';
    if (!login) return signupSay('Choose a username.', 'err');
    if (!firstName) return signupSay('Enter the first name.', 'err');
    if (!lastName) return signupSay('Enter the last name.', 'err');
    if (!designation) return signupSay('Select a designation.', 'err');
    if (!department) return signupSay('Select a department.', 'err');
    if (!category) return signupSay('Select a category.', 'err');
    // Exactly ten digits -- not nine, not eleven, and nothing but digits.
    // The field strips non-digits as they are typed, so anything rejected
    // here is a genuine length problem and the message can say so plainly.
    if (!/^[0-9]{10}$/.test(phone)) {
      return signupSay(phone
        ? 'The phone number must be exactly 10 digits — that one has ' + phone.replace(/[^0-9]/g, '').length + '.'
        : 'Enter the 10-digit phone number.', 'err');
    }
    if (!emailLocal) return signupSay('Enter the email.', 'err');
    if (!parasId) return signupSay('Enter the employee ID.', 'err');
    if (!PARAS_ID_RE.test(parasId)) {
      return signupSay('The employee ID must be in the format AA-BBB-12345 (two letters, three letters, five digits) -- like GG-COR-07365.', 'err');
    }
    var pwProblem = passwordProblem(p1, login);
    if (pwProblem) return signupSay(pwProblem, 'err');
    if (p1 !== p2) return signupSay('The two passwords do not match.', 'err');
    if (findAccount(login)) return signupSay('"' + login + '" is already taken. Choose another username.', 'err');

    var email = emailLocal + EMAIL_DOMAIN;
    mailEnabled().then(function (otpRequired) {
      if (otpRequired && (!signupOtpToken || signupOtpEmail !== email.toLowerCase())) {
        signupSay('Verify your email first -- send yourself a code above.', 'err');
        return;
      }

      busy = true;
      $('#signupSubmit').classList.add('working');
      signupSay('Sending the request…', '');

      var iters = cfg.iterations || 250000;
      var salt = randomSalt();
      var profile = { name: name, designation: designation, department: department, category: category,
                       phone: phone, email: email, parasId: parasId };
      w.ParasCrypto.derive(p1, salt, iters).then(function (hash) {
        return submitRequest('signup', { login: login, salt: salt, hash: hash, iterations: iters,
                                          profile: profile, otpToken: signupOtpToken });
      }).then(function () {
        busy = false; $('#signupSubmit').classList.remove('working');
        signupSay('Request sent. You can sign in once an admin approves it -- add a photo then, from the account menu.', 'ok');
      }).catch(function (err) {
        busy = false; $('#signupSubmit').classList.remove('working');
        signupSay((err && err.message) || 'Could not send the request.', 'err');
      });
    });
  }

  function randomSalt() {
    var b = new Uint8Array(16);
    (w.crypto || {}).getRandomValues ? w.crypto.getRandomValues(b)
      : b.forEach(function (_, i) { b[i] = Math.floor(Math.random() * 256); });
    return w.ParasCrypto.hex(b);
  }

  /* Reflects a just-written account into this tab's in-memory config right
     away, so signing in (or reopening the reset/sign-up screen) works
     without waiting for a reload. */
  function applyLocalAccount(login, salt, hash, iterations, profile) {
    if (!Array.isArray(cfg.accounts)) cfg.accounts = baseAccounts();
    var found = cfg.accounts.filter(function (a) { return a.login === login; })[0];
    if (found) { found.salt = salt; found.hash = hash; found.iterations = iterations; }
    else cfg.accounts.push(Object.assign({ login: login, salt: salt, hash: hash, iterations: iterations }, profile || {}));
  }

  /* Sends a signup / password-reset / id-change request to the admin's
     Pending Requests queue -- nothing here takes effect on its own; see
     serve.py's POST /__request and the admin panel's own resolve action.
     Needs a real server to hold that queue at all, so file:// (opened
     directly, not through start.bat) cannot support this -- there is
     nowhere for the request to land or anyone to approve it from. */
  function submitRequest(type, payload) {
    if (location.protocol === 'file:') {
      return Promise.reject(new Error(
        'This needs the app running through start.bat, not opened directly, so the request can reach an admin.'));
    }
    var body = JSON.stringify(Object.assign({ type: type }, payload));
    return fetch('__request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
      .then(function (r) {
        if (r.ok) return r.json().catch(function () { return {}; });
        return r.json().catch(function () { return {}; }).then(function (payload2) {
          return Promise.reject(new Error((payload2 && payload2.error) || ('HTTP ' + r.status)));
        });
      });
  }
  function readOverride() {
    try { return JSON.parse(localStorage.getItem(OVERRIDE_KEY) || 'null'); }
    catch (e) { return null; }
  }

  function open_() {
    var gate = $('#gate');
    gate.classList.add('gone');
    setTimeout(function () {
      gate.style.display = 'none';
      d.documentElement.removeAttribute('data-locked');
      $('#gatePass').value = '';
    }, 420);
    if (onUnlock) { var f = onUnlock; onUnlock = null; f(); }
  }

  function lock() {
    try { sessionStorage.removeItem(UNLOCK_KEY); sessionStorage.removeItem(WHOAMI_KEY); } catch (e) {}
    currentProfile = null;
    // Best-effort: the reload right after this is what actually locks the
    // workspace back up (it re-shows the gate regardless), so a request
    // that does not land -- server already gone, say -- is not worth
    // waiting on or worth blocking the reload for. This only makes the
    // difference between the session ending now versus at its normal
    // 12-hour expiry, not between locked and unlocked.
    if (location.protocol !== 'file:') { try { fetch('__logout', { method: 'POST' }); } catch (e) {} }
    location.reload();
  }

  function showGate() {
    d.documentElement.setAttribute('data-locked', '');
    var gate = $('#gate');
    gate.style.display = 'flex';
    gate.classList.remove('gone');

    // Deliberately not cleared here. The gate is shown only once auth.json
    // has loaded, which on a slow machine is a moment after the page becomes
    // interactive -- clearing at this point wiped anything typed (or filled
    // in by a password manager) in that window, so the sign-in that followed
    // submitted two empty fields. The password is still cleared on unlock in
    // open_(), which is where it actually matters.
    showSignIn();
    if (cfg.hint) { $('#gateHint').textContent = cfg.hint; $('#gateHint').style.display = 'block'; }

    $('#gateForm').addEventListener('submit', gateContinue);
    // Editing the username after the account was recognised drops back to
    // step one, so the face on screen can never belong to a different name
    // than the one in the box.
    $('#gateEmail').addEventListener('input', function () {
      if (signInStep === 'pass') { resetSignInStep(); say(''); }
    });
    $('#gateReveal').addEventListener('click', function () {
      var p = $('#gatePass');
      var show = p.type === 'password';
      p.type = show ? 'text' : 'password';
      this.setAttribute('aria-pressed', String(show));
      this.title = show ? 'Hide password' : 'Show password';
      p.focus();
    });
    $('#gateForgot').addEventListener('click', function (e) {
      e.preventDefault();
      showReset();
    });
    $('#gateSignupLink').addEventListener('click', function (e) {
      e.preventDefault();
      showSignup();
    });
    $('#resetBack').addEventListener('click', function (e) { e.preventDefault(); showSignIn(); });
    $('#signupBack').addEventListener('click', function (e) { e.preventDefault(); showSignIn(); });
    $('#gateHelpLink').addEventListener('click', function (e) { e.preventDefault(); openHelp(); });
    $('#gateHelpClose').addEventListener('click', closeHelp);
    $('#gateHelpModal').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeHelp(); });
    $('#resetForm').addEventListener('submit', doReset);
    $('#signupForm').addEventListener('submit', doSignup);

    /* ---- sign-up photo ---- */
    $('#signupPhotoBtn').addEventListener('click', function () {
      $('#signupPhotoInput').value = '';
      $('#signupPhotoInput').click();
    });
    $('#signupPhotoInput').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      if (f.type && f.type.indexOf('image/') !== 0) {
        signupSay('Choose an image file (PNG, JPG or WEBP).', 'err');
        return;
      }
      signupPhotoFile = f;
      previewSignupPhoto(f);
      signupSay('');
    });
    $('#signupFirstName').addEventListener('input', signupInitialsPreview);
    $('#signupLastName').addEventListener('input', signupInitialsPreview);
    /* Typed as lower or mixed case, always compared and stored upper --
       the format itself (two letters, a dash, three letters, a dash, five
       digits) is what's actually being enforced, not the casing. */
    $('#signupParasId').addEventListener('input', function () {
      var up = (this.value || '').toUpperCase();
      if (up !== this.value) this.value = up;
    });

    /* Digits only, and never more than ten. Stopping the wrong character
       from ever appearing beats explaining it afterwards. */
    $('#signupPhone').addEventListener('input', function () {
      var clean = (this.value || '').replace(/[^0-9]/g, '').slice(0, 10);
      if (clean !== this.value) this.value = clean;
    });

    $('#signupOtpSend').addEventListener('click', sendSignupOtp);
    $('#signupOtpVerify').addEventListener('click', verifySignupOtp);
    // A verified token is only good for the address it was issued for --
    // editing the email after verifying has to ask again, not silently
    // carry the old verification over to a different address.
    $('#signupEmail').addEventListener('input', function () {
      if (signupOtpEmail && currentSignupEmail() !== signupOtpEmail) resetSignupOtp();
    });

    tickLockout();
    setTimeout(function () { $('#gateEmail').focus(); }, 120);
  }

  /* Runs the app only once access is granted. */
  /* Served over http(s), sessionStorage's unlock flag is a claim, not proof
     -- the thing that actually matters is whether the server still holds a
     live session for it (it will not, the first time this runs after this
     version shipped, or any time the server has been restarted since, or
     past 12 hours). A GET here is cheap and needs no session of its own to
     ask. On file:// there is no server session at all, so the flag is
     trusted on its own exactly as it always was. */
  function liveSessionOk() {
    if (location.protocol === 'file:') return Promise.resolve(true);
    return fetch('__session', { cache: 'no-store' }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  w.ParasGate = {
    currentUser: function () { return currentProfile; },
    guard: function (start) {
      loadConfig().then(function (c) {
        cfg = c;
        if (cfg) restoreCurrentUser();
        var ov = cfg && readOverride();
        if (ov && ov.hash && ov.salt) {
          if (ov.login) applyLocalAccount(ov.login, ov.salt, ov.hash, ov.iterations);
          else { cfg.salt = ov.salt; cfg.hash = ov.hash; cfg.iterations = ov.iterations || cfg.iterations; }
        }
        if (!cfg || cfg.enabled === false || (!cfg.salt && !(Array.isArray(cfg.accounts) && cfg.accounts.length))) {
          // No credentials configured — open normally rather than locking the
          // owner out of their own workspace.
          $('#gate').style.display = 'none';
          $('#lockBtn').style.display = 'none';
          d.documentElement.removeAttribute('data-locked');
          start();
          return;
        }
        if (unlockedThisSession()) {
          liveSessionOk().then(function (ok) {
            if (ok) {
              $('#gate').style.display = 'none';
              d.documentElement.removeAttribute('data-locked');
              start();
              return;
            }
            // The flag says unlocked, the server disagrees -- back to the
            // gate rather than into an app that will 401 on its first
            // real request.
            try { sessionStorage.removeItem(UNLOCK_KEY); } catch (e) {}
            onUnlock = start;
            showGate();
          });
          return;
        }
        onUnlock = start;
        showGate();
      });
    },
    lock: lock
  };
})(window, document);
