/* Sign-in gate for the Command Centre.
 *
 * Scope, stated plainly: this keeps the Command Centre closed to someone who
 * opens it on this machine. It is not encryption — the dashboard HTML files
 * sit in dashboards/ and can be opened directly by anyone holding the folder.
 * For that, protect the folder at the operating-system level.
 *
 * The password is never stored: auth.json holds a random salt and a
 * PBKDF2-HMAC-SHA256 hash. Reset it with `python3 set_password.py`. */
(function (w, d) {
  'use strict';

  var UNLOCK_KEY = 'paras.cc.unlocked.v1';
  var FAIL_KEY = 'paras.cc.failed.v1';
  var cfg = null, busy = false, onUnlock = null;

  var $ = function (s) { return d.querySelector(s); };

  function loadConfig() {
    // Browsers refuse to fetch a local .json over file://, so don't even try
    // there — go straight to the auth.js mirror instead of logging a failure.
    if (location.protocol === 'file:') return Promise.resolve(w.__PARAS_AUTH__ || null);
    return fetch('auth.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(function () { return w.__PARAS_AUTH__ || null; });
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

    var email = ($('#gateEmail').value || '').trim();
    var pass = $('#gatePass').value || '';
    if (!email || !pass) { say('Enter your email and password.', 'err'); shake(); return; }

    busy = true;
    $('#gateSubmit').classList.add('working');
    say('Verifying…', '');

    w.ParasCrypto.derive(pass, cfg.salt, cfg.iterations || 250000).then(function (digest) {
      var emailOk = email.toLowerCase() === String(cfg.email || '').toLowerCase();
      var passOk = w.ParasCrypto.equal(digest, String(cfg.hash || ''));

      busy = false;
      $('#gateSubmit').classList.remove('working');

      if (emailOk && passOk) {
        clearFails();
        try { sessionStorage.setItem(UNLOCK_KEY, '1'); } catch (err) {}
        say('Access granted', 'ok');
        open_();
        return;
      }

      // One message for both cases: naming which half was wrong tells an
      // attacker which accounts exist.
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

  /* ---- admin-key reset --------------------------------------------------
     Forgot password does not mail anyone — there is no server. It asks for the
     admin key, and only then lets the password be changed on this machine. */
  function showReset() {
    $('#gateSignIn').style.display = 'none';
    $('#gateReset').style.display = 'block';
    $('#resetMsg').style.display = 'none';
    $('#resetAdmin').textContent = cfg.admin || 'Ritik Nagar';
    ['resetKey', 'resetPass', 'resetPass2'].forEach(function (id) { $('#' + id).value = ''; });
    setTimeout(function () { $('#resetKey').focus(); }, 60);
  }
  function showSignIn() {
    $('#gateReset').style.display = 'none';
    $('#gateSignIn').style.display = 'block';
    say('');
    setTimeout(function () { $('#gateEmail').focus(); }, 60);
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
        return persist({ salt: salt, hash: hash, iterations: iters }).then(function (how) {
          busy = false; $('#resetSubmit').classList.remove('working');
          cfg.salt = salt; cfg.hash = hash;
          resetSay('Password changed' + (how === 'file' ? '.' : ' on this computer.') + ' Sign in with it now.', 'ok');
          setTimeout(showSignIn, 1700);
        });
      });
    }).catch(function (err) {
      busy = false; $('#resetSubmit').classList.remove('working');
      resetSay('Could not change the password: ' + (err && err.message || err), 'err');
    });
  }

  function randomSalt() {
    var b = new Uint8Array(16);
    (w.crypto || {}).getRandomValues ? w.crypto.getRandomValues(b)
      : b.forEach(function (_, i) { b[i] = Math.floor(Math.random() * 256); });
    return w.ParasCrypto.hex(b);
  }

  /* Writes through the local server when there is one, so the change survives
     a browser reset. On file:// there is nothing to write to, so it is kept in
     this browser instead and the UI says so. */
  function persist(next) {
    var body = JSON.stringify({ adminKey: $('#resetKey').value, salt: next.salt,
                                hash: next.hash, iterations: next.iterations });
    if (location.protocol === 'file:') return Promise.resolve(saveLocal(next));
    return fetch('__auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
      .then(function (r) { return r.ok ? 'file' : Promise.reject(new Error('HTTP ' + r.status)); })
      .catch(function () { return saveLocal(next); });
  }
  function saveLocal(next) {
    try { localStorage.setItem('paras.cc.authOverride.v1', JSON.stringify(next)); } catch (e) {}
    return 'browser';
  }
  function readOverride() {
    try { return JSON.parse(localStorage.getItem('paras.cc.authOverride.v1') || 'null'); }
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
    try { sessionStorage.removeItem(UNLOCK_KEY); } catch (e) {}
    location.reload();
  }

  function showGate() {
    d.documentElement.setAttribute('data-locked', '');
    var gate = $('#gate');
    gate.style.display = 'flex';
    gate.classList.remove('gone');

    $('#gateEmail').value = '';
    $('#gatePass').value = '';
    say('');
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
      if (!cfg.adminKeyHash) { say('Contact Admin — ' + (cfg.admin || 'Ritik Nagar'), ''); return; }
      showReset();
    });
    $('#resetBack').addEventListener('click', function (e) { e.preventDefault(); showSignIn(); });
    $('#resetForm').addEventListener('submit', doReset);
    tickLockout();
    setTimeout(function () { $('#gateEmail').focus(); }, 120);
  }

  /* Runs the app only once access is granted. */
  w.ParasGate = {
    guard: function (start) {
      loadConfig().then(function (c) {
        cfg = c;
        var ov = cfg && readOverride();
        if (ov && ov.hash && ov.salt) {
          cfg.salt = ov.salt; cfg.hash = ov.hash; cfg.iterations = ov.iterations || cfg.iterations;
        }
        if (!cfg || cfg.enabled === false || !cfg.hash) {
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
