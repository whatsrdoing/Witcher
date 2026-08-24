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

  var $ = function (s) { return d.querySelector(s); };

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
     into a one-account list so the rest of this file never has to care. */
  function baseAccounts() {
    if (cfg && Array.isArray(cfg.accounts) && cfg.accounts.length) return cfg.accounts;
    if (cfg && cfg.hash) return [{ login: cfg.email || (cfg.logins || [])[0] || '', salt: cfg.salt, hash: cfg.hash, iterations: cfg.iterations }];
    return [];
  }
  function readExtraAccounts() {
    try { var v = JSON.parse(localStorage.getItem(EXTRA_KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function addExtraAccount(acc) {
    var list = readExtraAccounts().filter(function (a) { return a.login !== acc.login; });
    list.push(acc);
    try { localStorage.setItem(EXTRA_KEY, JSON.stringify(list)); } catch (e) {}
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

  function submit(e) {
    if (e) e.preventDefault();
    if (busy || lockoutRemaining() > 0) return;

    var login = ($('#gateEmail').value || '').trim();
    var pass = $('#gatePass').value || '';
    if (!login || !pass) { say('Enter your username and password.', 'err'); shake(); return; }

    busy = true;
    $('#gateSubmit').classList.add('working');
    say('Verifying…', '');

    // Matched case-sensitively — "admin/ritik" and "Admin/Ritik" are
    // different logins, only the exact configured spelling is accepted.
    var acc = findAccount(login);
    var salt = acc ? acc.salt : (cfg.adminKeySalt || '00');   // dummy salt when unknown, so timing does not out the login
    var iters = (acc && acc.iterations) || cfg.iterations || 250000;

    w.ParasCrypto.derive(pass, salt, iters).then(function (digest) {
      var ok = !!acc && w.ParasCrypto.equal(digest, String(acc.hash || ''));

      busy = false;
      $('#gateSubmit').classList.remove('working');

      if (ok) {
        clearFails();
        try { sessionStorage.setItem(UNLOCK_KEY, '1'); } catch (err) {}
        setCurrentUser(acc.login);
        say('Access granted', 'ok');
        open_();
        return;
      }

      // One message whether the username or the password was wrong: naming
      // which half failed tells an attacker which accounts exist.
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
        say('Wrong email or password. ' + (max - f.n) + ' attempt' + (max - f.n === 1 ? '' : 's') + ' left.', 'err');
        shake();
        $('#gatePass').select();
      }
    }).catch(function (err) {
      busy = false;
      $('#gateSubmit').classList.remove('working');
      say('Could not verify: ' + (err && err.message || err), 'err');
    });
  }

  /* ---- screens: sign in / reset / sign up --------------------------------
     Only one of #gateSignIn, #gateReset, #gateSignup is visible at a time. */
  function showScreen(id) {
    ['gateSignIn', 'gateReset', 'gateSignup'].forEach(function (s) {
      $('#' + s).style.display = (s === id) ? 'block' : 'none';
    });
    say('');
  }

  function showSignIn() {
    showScreen('gateSignIn');
    setTimeout(function () { $('#gateEmail').focus(); }, 60);
  }

  /* ---- admin-key reset ----------------------------------------------------
     Forgot password does not mail anyone — there is no server to mail from.
     It asks for the admin key, and only then lets that account's password be
     changed on this machine. If a username is already typed on the sign-in
     screen and matches an existing account, that account is the one reset;
     otherwise it defaults to the primary account. */
  function showReset() {
    showScreen('gateReset');
    $('#resetMsg').style.display = 'none';
    $('#resetAdmin').textContent = cfg.admin || 'Ritik Nagar';
    if (cfg.adminEmail) $('#resetAdmin').href = 'mailto:' + cfg.adminEmail;
    else $('#resetAdmin').removeAttribute('href');
    ['resetKey', 'resetPass', 'resetPass2'].forEach(function (id) { $('#' + id).value = ''; });

    var typed = ($('#gateEmail').value || '').trim();
    var target = findAccount(typed) ? typed : ((allAccounts()[0] || {}).login || '');
    $('#resetFor').textContent = target || '—';
    showReset._target = target;

    setTimeout(function () { $('#resetKey').focus(); }, 60);
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
    var key = ($('#resetKey').value || '').trim();
    var p1 = $('#resetPass').value || '', p2 = $('#resetPass2').value || '';
    if (!key) return resetSay('Enter the admin key.', 'err');
    if (p1.length < 6) return resetSay('Use at least 6 characters for the new password.', 'err');
    if (p1 !== p2) return resetSay('The two new passwords do not match.', 'err');

    var target = showReset._target || (allAccounts()[0] || {}).login;
    if (!target) return resetSay('No account to reset.', 'err');

    busy = true;
    $('#resetSubmit').classList.add('working');
    resetSay('Checking the admin key…', '');

    var iters = cfg.iterations || 250000;
    w.ParasCrypto.derive(key, cfg.adminKeySalt, iters).then(function (digest) {
      if (!w.ParasCrypto.equal(digest, String(cfg.adminKeyHash || ''))) {
        busy = false; $('#resetSubmit').classList.remove('working');
        resetSay('That admin key is not correct.', 'err');
        $('#resetKey').select();
        return;
      }
      var salt = randomSalt();
      return w.ParasCrypto.derive(p1, salt, iters).then(function (hash) {
        return writeAuth('reset', key, target, salt, hash, iters).then(function (how) {
          busy = false; $('#resetSubmit').classList.remove('working');
          applyLocalAccount(target, salt, hash, iters);
          resetSay('Password changed' + (how === 'file' ? '.' : ' on this computer.') + ' Sign in with it now.', 'ok');
          $('#gateEmail').value = target;
          setTimeout(showSignIn, 1700);
        });
      });
    }).catch(function (err) {
      busy = false; $('#resetSubmit').classList.remove('working');
      resetSay('Could not change the password: ' + (err && err.message || err), 'err');
    });
  }

  /* ---- admin-key sign-up ---------------------------------------------------
     Same admin key, different outcome: instead of changing an existing
     account's password, this creates a brand new one. Whoever knows the
     admin key can register a username of their choice with its own
     password; there is no self-serve sign-up without it. */
  function showSignup() {
    showScreen('gateSignup');
    $('#signupMsg').style.display = 'none';
    ['signupKey', 'signupUser', 'signupName', 'signupDesignation', 'signupDepartment',
     'signupCategory', 'signupPass', 'signupPass2'].forEach(function (id) { $('#' + id).value = ''; });
    setTimeout(function () { $('#signupKey').focus(); }, 60);
  }
  function signupSay(msg, kind) {
    var el = $('#signupMsg');
    el.className = 'gate-msg' + (kind ? ' ' + kind : '');
    el.textContent = msg || '';
    el.style.display = msg ? 'flex' : 'none';
  }

  function doSignup(e) {
    e.preventDefault();
    if (busy) return;
    var key = ($('#signupKey').value || '').trim();
    var login = ($('#signupUser').value || '').trim();
    var name = ($('#signupName').value || '').trim();
    var designation = ($('#signupDesignation').value || '').trim();
    var department = ($('#signupDepartment').value || '').trim();
    var category = ($('#signupCategory').value || '').trim();
    var p1 = $('#signupPass').value || '', p2 = $('#signupPass2').value || '';
    if (!key) return signupSay('Enter the admin key.', 'err');
    if (!login) return signupSay('Choose a username.', 'err');
    if (!name) return signupSay('Enter the full name.', 'err');
    if (!designation) return signupSay('Enter the designation.', 'err');
    if (!department) return signupSay('Enter the department.', 'err');
    if (!category) return signupSay('Enter the category.', 'err');
    if (p1.length < 6) return signupSay('Use at least 6 characters for the password.', 'err');
    if (p1 !== p2) return signupSay('The two passwords do not match.', 'err');
    if (findAccount(login)) return signupSay('"' + login + '" is already taken. Choose another username.', 'err');

    var profile = { name: name, designation: designation, department: department, category: category };

    busy = true;
    $('#signupSubmit').classList.add('working');
    signupSay('Checking the admin key…', '');

    var iters = cfg.iterations || 250000;
    w.ParasCrypto.derive(key, cfg.adminKeySalt, iters).then(function (digest) {
      if (!w.ParasCrypto.equal(digest, String(cfg.adminKeyHash || ''))) {
        busy = false; $('#signupSubmit').classList.remove('working');
        signupSay('That admin key is not correct.', 'err');
        $('#signupKey').select();
        return;
      }
      var salt = randomSalt();
      return w.ParasCrypto.derive(p1, salt, iters).then(function (hash) {
        return writeAuth('register', key, login, salt, hash, iters, profile).then(function (how) {
          busy = false; $('#signupSubmit').classList.remove('working');
          applyLocalAccount(login, salt, hash, iters, profile);
          clearFails();
          try { sessionStorage.setItem(UNLOCK_KEY, '1'); } catch (err) {}
          setCurrentUser(login);
          signupSay('Account created' + (how === 'file' ? '.' : ' on this computer.') + ' Signing you in…', 'ok');
          setTimeout(open_, 900);
        }).catch(function (err) {
          busy = false; $('#signupSubmit').classList.remove('working');
          signupSay(err && err.message === 'taken'
            ? 'That username was just taken — choose another.'
            : 'Could not create the account: ' + (err && err.message || err), 'err');
        });
      });
    }).catch(function (err) {
      busy = false; $('#signupSubmit').classList.remove('working');
      signupSay('Could not verify the admin key: ' + (err && err.message || err), 'err');
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

  /* Writes through the local server when there is one, so the change
     survives a browser reset. On file:// — or if the write fails for any
     other reason — there is nothing to write to, so it is kept in this
     browser instead and the caller says so. A 409 (username taken, caught by
     someone else a moment earlier) is surfaced as a real error rather than
     silently falling back to a local-only account of the same name. */
  function writeAuth(action, adminKey, login, salt, hash, iterations, profile) {
    var body = JSON.stringify(Object.assign({ action: action, adminKey: adminKey, login: login,
                                salt: salt, hash: hash, iterations: iterations }, profile || {}));
    if (location.protocol === 'file:') return Promise.resolve(saveLocal(action, login, salt, hash, iterations, profile));
    return fetch('__auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
      .then(function (r) {
        if (r.ok) return 'file';
        if (r.status === 409) return Promise.reject(new Error('taken'));
        return Promise.reject(new Error('HTTP ' + r.status));
      })
      .catch(function (err) {
        if (err && err.message === 'taken') return Promise.reject(err);
        return saveLocal(action, login, salt, hash, iterations, profile);
      });
  }
  function saveLocal(action, login, salt, hash, iterations, profile) {
    var next = { salt: salt, hash: hash, iterations: iterations };
    if (action === 'register') addExtraAccount(Object.assign({ login: login }, next, profile || {}));
    else try { localStorage.setItem(OVERRIDE_KEY, JSON.stringify(Object.assign({ login: login }, next))); } catch (e) {}
    return 'browser';
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
    location.reload();
  }

  function showGate() {
    d.documentElement.setAttribute('data-locked', '');
    var gate = $('#gate');
    gate.style.display = 'flex';
    gate.classList.remove('gone');

    $('#gateEmail').value = '';
    $('#gatePass').value = '';
    showSignIn();
    if (cfg.hint) { $('#gateHint').textContent = cfg.hint; $('#gateHint').style.display = 'block'; }

    $('#gateForm').addEventListener('submit', submit);
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
      if (!cfg.adminKeyHash) { say('Contact Admin — ' + (cfg.admin || 'Ritik Nagar') + (cfg.adminEmail ? ' (' + cfg.adminEmail + ')' : ''), ''); return; }
      showReset();
    });
    $('#gateSignupLink').addEventListener('click', function (e) {
      e.preventDefault();
      if (!cfg.adminKeyHash) { say('Contact Admin — ' + (cfg.admin || 'Ritik Nagar') + (cfg.adminEmail ? ' (' + cfg.adminEmail + ')' : ''), ''); return; }
      showSignup();
    });
    $('#resetBack').addEventListener('click', function (e) { e.preventDefault(); showSignIn(); });
    $('#signupBack').addEventListener('click', function (e) { e.preventDefault(); showSignIn(); });
    $('#resetForm').addEventListener('submit', doReset);
    $('#signupForm').addEventListener('submit', doSignup);
    tickLockout();
    setTimeout(function () { $('#gateEmail').focus(); }, 120);
  }

  /* Runs the app only once access is granted. */
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
        if (!cfg || cfg.enabled === false || (!cfg.hash && !(Array.isArray(cfg.accounts) && cfg.accounts.length))) {
          // No credentials configured — open normally rather than locking the
          // owner out of their own workspace.
          $('#gate').style.display = 'none';
          $('#lockBtn').style.display = 'none';
          d.documentElement.removeAttribute('data-locked');
          start();
          return;
        }
        if (unlockedThisSession()) {
          $('#gate').style.display = 'none';
          d.documentElement.removeAttribute('data-locked');
          start();
          return;
        }
        onUnlock = start;
        showGate();
      });
    },
    lock: lock
  };
})(window, document);
