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
  var pendingSignup = null;   // validated sign-up fields, waiting on the admin-key popup

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
        try { sessionStorage.setItem(UNLOCK_KEY, '1'); } catch (err) {}
        setCurrentUser(acc.login);
        say('Access granted', 'ok');
        open_();
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
        if (result === 'locked') {
          busy = false;
          $('#gateSubmit').classList.remove('working');
          say('Too many failed attempts. Try again shortly.', 'err');
          shake();
          return;
        }
        if (result === 'unknown') {
          // The server has never heard of this login -- a sign-up that
          // only ever made it into this browser's own storage, because the
          // server could not be reached when the account was created.
          // Nothing server-side to check it against, so fall back to the
          // local compare exactly as file:// mode always has.
          finish(!!acc && w.ParasCrypto.equal(digest, String(acc.hash || '')));
          return;
        }
        finish(result === 'ok');
      });
    }).catch(function (err) {
      busy = false;
      $('#gateSubmit').classList.remove('working');
      say('Could not verify: ' + (err && err.message || err), 'err');
    });
  }

  /* POST /__session -- see verifyPassword above. Resolves to 'ok', 'fail'
     (server reached, wrong password), 'locked' (too many recent attempts
     for this login), or 'unknown' (server reachable but has never heard of
     this login -- including a genuine connection failure, which gets the
     same treatment as "nothing to check this against" rather than being
     surfaced as an error on every keystroke of a typo'd username). */
  function serverVerify(login, digest) {
    return fetch('__session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: login, digest: digest })
    }).then(function (r) {
      if (r.ok) return 'ok';
      if (r.status === 404) return 'unknown';
      if (r.status === 429) return 'locked';
      return 'fail';
    }).catch(function () { return 'unknown'; });
  }

  /* ---- screens: sign in / reset / sign up --------------------------------
     Only one of #gateSignIn, #gateReset, #gateSignup is visible at a time. */
  function showScreen(id) {
    ['gateSignIn', 'gateReset', 'gateSignup'].forEach(function (s) {
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

  function showSignIn() {
    showScreen('gateSignIn');
    resetSignInStep();
    $('#gateWhoCaption').textContent = captionForToday();
    setTimeout(function () { $('#gateEmail').focus(); }, 60);
  }

  /* ---- admin-key reset ----------------------------------------------------
     Forgot password does not mail anyone — there is no server to mail from.
     It asks for the admin key, and only then lets that account's password be
     changed on this machine. With more than one account on file, guessing
     which one to reset from whatever happened to be typed on the sign-in
     screen is not reliable -- so the exact username is typed here instead,
     and has to match an existing account before the admin key is even
     checked. */
  function showReset() {
    showScreen('gateReset');
    $('#resetMsg').style.display = 'none';
    $('#resetAdmin').textContent = cfg.admin || 'Ritik Nagar';
    if (cfg.adminEmail) $('#resetAdmin').href = 'mailto:' + cfg.adminEmail;
    else $('#resetAdmin').removeAttribute('href');
    ['resetUser', 'resetKey', 'resetPass', 'resetPass2'].forEach(function (id) { $('#' + id).value = ''; });

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
    var key = ($('#resetKey').value || '').trim();
    var p1 = $('#resetPass').value || '', p2 = $('#resetPass2').value || '';
    if (!target) return resetSay('Enter the exact username to reset.', 'err');
    if (!findAccount(target)) return resetSay('No account named "' + target + '".', 'err');
    if (!key) return resetSay('Enter the admin key.', 'err');
    if (p1.length < 6) return resetSay('Use at least 6 characters for the new password.', 'err');
    if (p1 !== p2) return resetSay('The two new passwords do not match.', 'err');

    busy = true;
    $('#resetSubmit').classList.add('working');

    var iters = cfg.iterations || 250000;
    // Served over http(s), auth.json no longer carries the admin key's real
    // hash to a browser that has not signed in yet (see serve.py's
    // _send_auth) -- checking it here would just be comparing against an
    // empty string. The real check happens where the admin key actually
    // still lives: server-side, inside writeAuth's POST to /__auth. On
    // file:// there is no server to ask, so the local check stays the only
    // one there is.
    var checkKeyLocally = location.protocol === 'file:';
    resetSay(checkKeyLocally ? 'Checking the admin key…' : 'Changing the password…', '');

    (checkKeyLocally
      ? w.ParasCrypto.derive(key, cfg.adminKeySalt, iters).then(function (digest) {
          return w.ParasCrypto.equal(digest, String(cfg.adminKeyHash || ''));
        })
      : Promise.resolve(true)
    ).then(function (keyOk) {
      if (!keyOk) {
        busy = false; $('#resetSubmit').classList.remove('working');
        resetSay('That admin key is not correct.', 'err');
        $('#resetKey').select();
        return;
      }
      var salt = randomSalt();
      return w.ParasCrypto.derive(p1, salt, iters).then(function (hash) {
        return writeAuth('reset', key, target, salt, hash, iters).then(function (how) {
          return establishSession(target, hash, salt, iters).then(function () {
            busy = false; $('#resetSubmit').classList.remove('working');
            applyLocalAccount(target, salt, hash, iters);
            resetSay('Password changed' + (how === 'file' ? '.' : ' on this computer.') + ' Sign in with it now.', 'ok');
            $('#gateEmail').value = target;
            setTimeout(showSignIn, 1700);
          });
        });
      });
    }).catch(function (err) {
      busy = false; $('#resetSubmit').classList.remove('working');
      resetSay('Could not change the password: ' + (err && err.message || err), 'err');
    });
  }

  /* Best-effort: after a password reset or a new sign-up, ask the server
     for a real session using the digest just written, so the person is
     actually signed in rather than only looking signed in in this tab. If
     this does not land (the server is momentarily unreachable, say) the
     write itself already succeeded -- verifyPassword will simply ask again,
     for real, the next time this account tries to sign in. */
  function establishSession(login, digest) {
    if (location.protocol === 'file:') return Promise.resolve();
    return fetch('__session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: login, digest: digest })
    }).catch(function () {});
  }

  /* ---- admin-key sign-up ---------------------------------------------------
     Same admin key, different outcome: instead of changing an existing
     account's password, this creates a brand new one. Whoever knows the
     admin key can register a username of their choice with its own
     password; there is no self-serve sign-up without it. */
  function showSignup() {
    showScreen('gateSignup');
    $('#signupMsg').style.display = 'none';
    ['signupUser', 'signupName', 'signupDesignation', 'signupDepartment', 'signupCategory',
     'signupPhone', 'signupEmail', 'signupParasId', 'signupPass', 'signupPass2']
      .forEach(function (id) { $('#' + id).value = ''; });
    signupPhotoFile = null;
    pendingSignup = null;
    clearSignupPhotoPreview();
    setTimeout(function () { $('#signupUser').focus(); }, 60);
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
    var name = ($('#signupName').value || '').trim();
    el.textContent = (name && w.Avatar) ? w.Avatar.initials({ name: name }) : '';
  }
  function signupSay(msg, kind) {
    var el = $('#signupMsg');
    el.className = 'gate-msg' + (kind ? ' ' + kind : '');
    el.textContent = msg || '';
    el.style.display = msg ? 'flex' : 'none';
  }

  var EMAIL_DOMAIN = '@parashealth.com';

  function doSignup(e) {
    e.preventDefault();
    if (busy) return;
    var login = ($('#signupUser').value || '').trim();
    var name = ($('#signupName').value || '').trim();
    var designation = ($('#signupDesignation').value || '').trim();
    var department = ($('#signupDepartment').value || '').trim();
    var category = ($('#signupCategory').value || '').trim();
    var phone = ($('#signupPhone').value || '').trim();
    var emailLocal = ($('#signupEmail').value || '').trim().split('@')[0];
    var parasId = ($('#signupParasId').value || '').trim();
    var p1 = $('#signupPass').value || '', p2 = $('#signupPass2').value || '';
    if (!login) return signupSay('Choose a username.', 'err');
    if (!name) return signupSay('Enter the full name.', 'err');
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
    if (!parasId) return signupSay('Enter the Paras ID.', 'err');
    if (p1.length < 6) return signupSay('Use at least 6 characters for the password.', 'err');
    if (p1 !== p2) return signupSay('The two passwords do not match.', 'err');
    if (findAccount(login)) return signupSay('"' + login + '" is already taken. Choose another username.', 'err');

    // Everything the form can check is good. The admin key is the last gate,
    // and it is asked for in its own popup rather than sitting filled in on
    // screen for the whole time the rest of the form is being typed.
    pendingSignup = {
      login: login, password: p1,
      profile: { name: name, designation: designation, department: department, category: category,
                 phone: phone, email: emailLocal + EMAIL_DOMAIN, parasId: parasId }
    };
    signupSay('');
    openSignupKey();
  }

  /* ---- admin-key popup ---------------------------------------------------- */
  function openSignupKey() {
    $('#signupKeyModalInput').value = '';
    signupKeySay('');
    $('#signupKeyScrim').classList.add('open');
    setTimeout(function () { $('#signupKeyModalInput').focus(); }, 60);
  }
  function closeSignupKey() {
    $('#signupKeyScrim').classList.remove('open');
    $('#signupKeyModalInput').value = '';
    pendingSignup = null;
  }
  function signupKeySay(msg, kind) {
    var el = $('#signupKeyModalMsg');
    el.className = 'gate-msg' + (kind ? ' ' + kind : '');
    el.textContent = msg || '';
    el.style.display = msg ? 'flex' : 'none';
  }

  function confirmSignupKey(e) {
    if (e) e.preventDefault();
    if (busy || !pendingSignup) return;
    var key = ($('#signupKeyModalInput').value || '').trim();
    if (!key) return signupKeySay('Enter the admin key.', 'err');

    var req = pendingSignup;
    busy = true;
    $('#signupKeyConfirm').classList.add('working');

    var iters = cfg.iterations || 250000;
    // See the matching comment in doReset -- served over http(s), the real
    // admin-key check happens server-side in writeAuth's POST to /__auth,
    // because auth.json no longer carries the hash needed to check it here.
    var checkKeyLocally = location.protocol === 'file:';
    signupKeySay(checkKeyLocally ? 'Checking the admin key…' : 'Creating the account…', '');

    (checkKeyLocally
      ? w.ParasCrypto.derive(key, cfg.adminKeySalt, iters).then(function (digest) {
          return w.ParasCrypto.equal(digest, String(cfg.adminKeyHash || ''));
        })
      : Promise.resolve(true)
    ).then(function (keyOk) {
      if (!keyOk) {
        busy = false; $('#signupKeyConfirm').classList.remove('working');
        signupKeySay('That admin key is not correct.', 'err');
        $('#signupKeyModalInput').select();
        return;
      }
      var salt = randomSalt();
      return w.ParasCrypto.derive(req.password, salt, iters).then(function (hash) {
        return writeAuth('register', key, req.login, salt, hash, iters, req.profile).then(function (how) {
          return establishSession(req.login, hash).then(function () {
            busy = false; $('#signupKeyConfirm').classList.remove('working');
            applyLocalAccount(req.login, salt, hash, iters, req.profile);
            clearFails();
            try { sessionStorage.setItem(UNLOCK_KEY, '1'); } catch (err) {}
            setCurrentUser(req.login);
            $('#signupKeyScrim').classList.remove('open');
            pendingSignup = null;
            signupSay('Account created' + (how === 'file' ? '.' : ' on this computer.') + ' Signing you in…', 'ok');
            // The photo is stored against the account that now exists. A photo
            // that fails to save must not block the sign-in it was attached to.
            savePhotoFor(req.login).then(function () { setTimeout(open_, 900); });
          });
        }).catch(function (err) {
          busy = false; $('#signupKeyConfirm').classList.remove('working');
          signupKeySay((err && err.message) || 'Could not create the account.', 'err');
        });
      });
    }).catch(function (err) {
      busy = false; $('#signupKeyConfirm').classList.remove('working');
      signupKeySay('Could not verify the admin key: ' + (err && err.message || err), 'err');
    });
  }

  function savePhotoFor(login) {
    if (!signupPhotoFile || !w.Avatar) return Promise.resolve();
    return w.Avatar.set(login, signupPhotoFile).then(function () {
      signupPhotoFile = null;
    }).catch(function () {
      // Deliberately soft: the account is already created and the person is
      // about to be signed in. They can set a photo from the account menu.
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
     survives a browser reset. Only a genuine "there is nothing to write
     to" -- file://, or the server not answering at all -- falls back to
     keeping it in this browser instead, and the caller is told that is
     what happened.

     A response from a *reachable* server, on the other hand, is always the
     real answer, not a reason to improvise: a wrong admin key (403), too
     many recent attempts (429) or a username just taken by someone else
     (409) are every bit as final as "it worked" -- silently saving a
     local-only account of the same name in any of those cases used to mean
     this screen could say "Password changed" for an admin key that was
     never actually right, while the real account on the server sat
     untouched. fetch() itself only rejects (a TypeError) for a connection
     that never happened; anything the server did answer resolves normally
     and is turned into a real rejection here, which is what actually
     distinguishes the two. */
  function writeAuth(action, adminKey, login, salt, hash, iterations, profile) {
    var body = JSON.stringify(Object.assign({ action: action, adminKey: adminKey, login: login,
                                salt: salt, hash: hash, iterations: iterations }, profile || {}));
    if (location.protocol === 'file:') return Promise.resolve(saveLocal(action, login, salt, hash, iterations, profile));
    return fetch('__auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
      .then(function (r) {
        if (r.ok) return 'file';
        return r.json().catch(function () { return {}; }).then(function (payload) {
          return Promise.reject(new Error((payload && payload.error) || ('HTTP ' + r.status)));
        });
      })
      .catch(function (err) {
        if (err instanceof TypeError) return saveLocal(action, login, salt, hash, iterations, profile);
        return Promise.reject(err);
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
      // cfg.adminKeySalt (not adminKeyHash) is the right thing to check here:
      // served over http(s), the hash is stripped from what /auth.json
      // hands back before sign-in (see serve.py's _send_auth) -- salt is
      // not, so it is what is actually there to say "an admin key exists".
      if (!cfg.adminKeySalt) { say('Contact Admin — ' + (cfg.admin || 'Ritik Nagar') + (cfg.adminEmail ? ' (' + cfg.adminEmail + ')' : ''), ''); return; }
      showReset();
    });
    $('#gateSignupLink').addEventListener('click', function (e) {
      e.preventDefault();
      // cfg.adminKeySalt (not adminKeyHash) is the right thing to check here:
      // served over http(s), the hash is stripped from what /auth.json
      // hands back before sign-in (see serve.py's _send_auth) -- salt is
      // not, so it is what is actually there to say "an admin key exists".
      if (!cfg.adminKeySalt) { say('Contact Admin — ' + (cfg.admin || 'Ritik Nagar') + (cfg.adminEmail ? ' (' + cfg.adminEmail + ')' : ''), ''); return; }
      showSignup();
    });
    $('#resetBack').addEventListener('click', function (e) { e.preventDefault(); showSignIn(); });
    $('#signupBack').addEventListener('click', function (e) { e.preventDefault(); showSignIn(); });
    $('#resetForm').addEventListener('submit', doReset);
    $('#signupForm').addEventListener('submit', doSignup);

    /* ---- admin-key popup ---- */
    $('#signupKeyForm').addEventListener('submit', confirmSignupKey);
    $('#signupKeyCancel').addEventListener('click', closeSignupKey);
    $('#signupKeyScrim').addEventListener('click', function (ev) {
      if (ev.target === ev.currentTarget) closeSignupKey();
    });
    d.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && $('#signupKeyScrim').classList.contains('open')) closeSignupKey();
    });

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
    $('#signupName').addEventListener('input', signupInitialsPreview);

    /* Digits only, and never more than ten. Stopping the wrong character
       from ever appearing beats explaining it afterwards. */
    $('#signupPhone').addEventListener('input', function () {
      var clean = (this.value || '').replace(/[^0-9]/g, '').slice(0, 10);
      if (clean !== this.value) this.value = clean;
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
