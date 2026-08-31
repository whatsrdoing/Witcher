/* Two-factor authentication -- self-service setup/manage for the signed-in
 * account's own login. Its own file for the same reason as admin.js and
 * feedback.js: a handful of dedicated endpoints (__totp/*) and a modal that
 * app.js does not need to know about beyond the "Manage" button it wires up
 * once, and the status line it should keep current after sign-in. */
(function (w, d) {
  'use strict';

  var $ = function (s, r) { return (r || d).querySelector(s); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { ok: r.ok, status: r.status, body: j };
      });
    });
  }

  var enabled = false;

  function refreshStatus() {
    return api('__session').then(function (r) {
      enabled = !!(r.ok && r.body.totpEnabled);
      var el = $('#totpStatus');
      if (el) el.textContent = enabled ? 'On' : 'Off';
      return enabled;
    }).catch(function () { return false; });
  }

  function groupSecret(secret) {
    return (secret.match(/.{1,4}/g) || [secret]).join(' ');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
    }
  }

  function renderOff() {
    $('#totpModalBody').innerHTML =
      '<p class="reset-lede">Add a second step to signing in, using a free authenticator app ' +
      '(Google Authenticator, Microsoft Authenticator, Authy, and similar all work).</p>' +
      '<button class="gate-submit" id="totpBeginSetup" type="button" style="margin:0">' +
      '<span>Turn on two-factor authentication</span></button>';
    $('#totpBeginSetup').addEventListener('click', beginSetup);
  }

  function renderOn() {
    $('#totpModalBody').innerHTML =
      '<p class="reset-lede">Two-factor authentication is on for this account. ' +
      'You will be asked for a code from your authenticator app each time you sign in.</p>' +
      '<button class="btn" id="totpRegenBtn" type="button" style="margin-bottom:10px;width:100%">Get new backup codes</button>' +
      '<button class="btn ghost" id="totpDisableBtn" type="button" style="width:100%">Turn off two-factor authentication</button>';
    $('#totpRegenBtn').addEventListener('click', function () { renderCodePrompt('regenerate'); });
    $('#totpDisableBtn').addEventListener('click', function () { renderCodePrompt('disable'); });
  }

  function renderCodePrompt(action) {
    var title = action === 'disable'
      ? 'Enter a current code (or a backup code) to turn 2FA off.'
      : 'Enter a current code (or a backup code) to get a fresh set of backup codes -- this replaces the old ones.';
    $('#totpModalBody').innerHTML =
      '<p class="reset-lede">' + title + '</p>' +
      '<div class="gate-field"><input id="totpActionCode" type="text" inputmode="numeric" placeholder="123456" autocomplete="one-time-code"></div>' +
      '<div class="gate-msg" id="totpActionMsg" style="display:none"></div>' +
      '<button class="gate-submit" id="totpActionGo" type="button" style="margin:0 0 10px">' +
      '<span>' + (action === 'disable' ? 'Turn off' : 'Get new codes') + '</span></button>' +
      '<button class="btn ghost" id="totpActionCancel" type="button" style="width:100%">Cancel</button>';
    $('#totpActionCancel').addEventListener('click', renderOn);
    $('#totpActionGo').addEventListener('click', function () {
      var code = ($('#totpActionCode').value || '').trim();
      var msgEl = $('#totpActionMsg');
      if (!code) {
        msgEl.textContent = 'Enter a code.'; msgEl.className = 'gate-msg err'; msgEl.style.display = 'flex';
        return;
      }
      api('__totp/' + (action === 'disable' ? 'disable' : 'regenerate-codes'), {
        method: 'POST', body: JSON.stringify({ code: code })
      }).then(function (r) {
        if (!r.ok) {
          msgEl.textContent = r.body.error || 'Wrong code.'; msgEl.className = 'gate-msg err'; msgEl.style.display = 'flex';
          return;
        }
        if (action === 'disable') {
          enabled = false;
          refreshStatus();
          renderOff();
        } else {
          renderBackupCodes(r.body.backupCodes, true);
        }
      });
    });
  }

  function beginSetup() {
    $('#totpModalBody').textContent = 'Setting up…';
    api('__totp/setup', { method: 'POST' }).then(function (r) {
      if (!r.ok) {
        $('#totpModalBody').innerHTML = '<p class="reset-lede">' + esc(r.body.error || 'Could not start setup.') + '</p>';
        return;
      }
      renderSetup(r.body.secret, r.body.otpauthUrl);
    });
  }

  function qrSvgFor(otpauthUrl) {
    if (!w.qrcode) return '';
    try {
      var qr = w.qrcode(0, 'M');
      qr.addData(otpauthUrl);
      qr.make();
      return qr.createSvgTag(6, 16);
    } catch (e) {
      return '';
    }
  }

  function renderSetup(secret, otpauthUrl) {
    var svg = qrSvgFor(otpauthUrl);
    $('#totpModalBody').innerHTML =
      '<p class="reset-lede">Scan this with your authenticator app' +
      (svg ? '' : ' (or enter the key below manually)') + '.</p>' +
      (svg ? '<div style="background:#fff;border-radius:12px;padding:16px;margin-bottom:16px;display:flex;justify-content:center">' + svg + '</div>' : '') +
      '<button class="btn ghost" id="totpToggleKey" type="button" style="margin-bottom:10px;width:100%">' +
      (svg ? "Can't scan? Enter the key manually" : 'Show the key') + '</button>' +
      '<div id="totpKeyWrap" style="display:' + (svg ? 'none' : 'block') + '">' +
      '<div class="gate-field"><pre style="flex:none;padding:12px;margin:0;width:100%;border-radius:10px;' +
      'background:var(--glass);border:1px solid var(--wire);font-size:15px;letter-spacing:.05em;text-align:center">' +
      esc(groupSecret(secret)) + '</pre></div>' +
      '<button class="btn" id="totpCopySecret" type="button" style="margin-bottom:16px;width:100%">Copy key</button>' +
      '</div>' +
      '<label class="gate-label" for="totpSetupCode">Then enter the 6-digit code it shows</label>' +
      '<div class="gate-field"><input id="totpSetupCode" type="text" inputmode="numeric" placeholder="123456" autocomplete="one-time-code"></div>' +
      '<div class="gate-msg" id="totpSetupMsg" style="display:none"></div>' +
      '<button class="gate-submit" id="totpConfirmBtn" type="button" style="margin:0 0 10px"><span>Confirm</span></button>' +
      '<button class="btn ghost" id="totpSetupCancel" type="button" style="width:100%">Cancel</button>';
    $('#totpCopySecret').addEventListener('click', function () { copyText(secret); });
    $('#totpToggleKey').addEventListener('click', function () {
      var wrap = $('#totpKeyWrap');
      var showing = wrap.style.display !== 'none';
      wrap.style.display = showing ? 'none' : 'block';
      if (svg) $('#totpToggleKey').textContent = showing ? "Can't scan? Enter the key manually" : 'Hide the key';
    });
    $('#totpSetupCancel').addEventListener('click', renderOff);
    $('#totpConfirmBtn').addEventListener('click', function () { confirmSetup(); });
  }

  function confirmSetup() {
    var code = ($('#totpSetupCode').value || '').trim();
    var msgEl = $('#totpSetupMsg');
    if (!code) {
      msgEl.textContent = 'Enter the code.'; msgEl.className = 'gate-msg err'; msgEl.style.display = 'flex';
      return;
    }
    api('__totp/confirm', { method: 'POST', body: JSON.stringify({ code: code }) }).then(function (r) {
      if (!r.ok) {
        msgEl.textContent = r.body.error || 'Wrong code.'; msgEl.className = 'gate-msg err'; msgEl.style.display = 'flex';
        return;
      }
      enabled = true;
      refreshStatus();
      renderBackupCodes(r.body.backupCodes, false);
    });
  }

  function renderBackupCodes(codes, isRegenerate) {
    var lede = isRegenerate
      ? 'Your old backup codes no longer work. Save these new ones somewhere safe -- each works once, and this is the only time they are shown.'
      : 'Two-factor authentication is on. Save these backup codes somewhere safe -- each works once, in place of a code from your app, and this is the only time they are shown.';
    $('#totpModalBody').innerHTML =
      '<p class="reset-lede">' + lede + '</p>' +
      '<pre style="flex:none;padding:14px;margin:0 0 14px;border-radius:10px;background:var(--glass);' +
      'border:1px solid var(--wire);font-size:14px;line-height:1.8;text-align:center">' +
      codes.map(esc).join('\n') + '</pre>' +
      '<button class="btn" id="totpCopyCodes" type="button" style="margin-bottom:10px;width:100%">Copy codes</button>' +
      '<button class="gate-submit" id="totpCodesDone" type="button" style="margin:0"><span>I’ve saved these</span></button>';
    $('#totpCopyCodes').addEventListener('click', function () { copyText(codes.join('\n')); });
    $('#totpCodesDone').addEventListener('click', renderOn);
  }

  function open() {
    $('#totpModal').classList.add('open');
    $('#totpModalBody').textContent = 'Loading…';
    refreshStatus().then(function (isOn) { isOn ? renderOn() : renderOff(); });
  }

  function close() {
    $('#totpModal').classList.remove('open');
  }

  function closeIfOpen() {
    if ($('#totpModal').classList.contains('open')) { close(); return true; }
    return false;
  }

  d.addEventListener('DOMContentLoaded', function () {
    var btn = $('#totpManageBtn');
    if (btn) btn.addEventListener('click', open);
    var closeBtn = $('#totpModalClose'); if (closeBtn) closeBtn.addEventListener('click', close);
    var modal = $('#totpModal');
    if (modal) modal.addEventListener('click', function (e) { if (e.target === e.currentTarget) close(); });
  });

  w.ParasTwoFactor = { refreshStatus: refreshStatus, closeIfOpen: closeIfOpen };
})(window, document);
