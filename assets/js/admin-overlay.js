/* Hidden admin overlay -- typed into the search bar, not clicked from any
 * visible menu. Works for ANY signed-in account, not just the primary
 * admin's own (see serve.py's grant_admin_overlay / _require_admin): a
 * correct admin-key digest proves whoever is at the keyboard knows the
 * shared secret, independent of which account happens to be signed in on
 * this particular browser -- the "walk up to someone else's already-open
 * session and reveal admin controls" case this was built for.
 *
 * Reuses #viewAdmin verbatim by reparenting it (not cloning) into the
 * overlay shell on open, and back to its normal spot in the SPA on close --
 * every button, listener, and id inside it keeps working exactly as it
 * does on the routed #/admin page, with zero duplicated markup or logic. */
(function (w, d) {
  'use strict';

  var $ = function (s, r) { return (r || d).querySelector(s); };

  var cfg = null;
  function loadCfg() {
    if (cfg) return Promise.resolve(cfg);
    return fetch('auth.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { cfg = j; return j; })
      .catch(function () { return null; });
  }

  var homeParent = null, homeNext = null;
  var open = false;
  var refreshTimer = null;

  function placeBack() {
    var viewAdmin = $('#viewAdmin');
    if (!viewAdmin || !homeParent) return;
    viewAdmin.classList.remove('admin-overlay-active');
    if (homeNext) homeParent.insertBefore(viewAdmin, homeNext);
    else homeParent.appendChild(viewAdmin);
  }

  function openOverlay() {
    if (open) return;
    open = true;
    var viewAdmin = $('#viewAdmin');
    var shell = $('#adminOverlayShell');
    homeParent = viewAdmin.parentNode;
    homeNext = viewAdmin.nextSibling;
    shell.appendChild(viewAdmin);
    viewAdmin.classList.add('admin-overlay-active');
    $('#adminOverlayScrim').classList.add('open');

    var tick = function () { if (w.ParasAdmin && w.ParasAdmin.refreshAll) w.ParasAdmin.refreshAll(); };
    tick();
    refreshTimer = setInterval(tick, 1000);
  }

  function closeOverlay() {
    if (!open) return;
    open = false;
    clearInterval(refreshTimer);
    refreshTimer = null;
    $('#adminOverlayScrim').classList.remove('open');
    placeBack();
    // Best-effort: the whole point is nothing stays server-side either, but
    // if this fails (tab closing, connection already gone) the grant still
    // expires on its own shortly -- see ADMIN_OVERLAY_TTL in serve.py.
    fetch('__session/admin-unlock/revoke', { method: 'POST' }).catch(function () {});
  }

  function tryUnlock(typed, input) {
    loadCfg().then(function (c) {
      if (!c || !c.adminKeySalt || !w.ParasCrypto) return null;
      var iters = c.iterations || 250000;
      return w.ParasCrypto.derive(typed, c.adminKeySalt, iters);
    }).then(function (digest) {
      if (!digest) return null;
      return fetch('__session/admin-unlock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ digest: digest })
      });
    }).then(function (r) {
      if (r && r.ok) {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        openOverlay();
      }
      // Wrong key: nothing special happens -- left exactly as any other
      // failed search would look, which is the whole point of hiding this
      // behind the search bar rather than a real prompt.
    }).catch(function () { /* silent, same reasoning */ });
  }

  function wire() {
    var input = $('#search');
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        var val = input.value;
        if (!val) return;
        tryUnlock(val, input);
      });
    }
    var closeBtn = $('#adminOverlayClose');
    if (closeBtn) closeBtn.addEventListener('click', closeOverlay);
    var scrim = $('#adminOverlayScrim');
    if (scrim) scrim.addEventListener('click', function (e) { if (e.target === scrim) closeOverlay(); });
    d.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) closeOverlay();
    });
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', wire);
  else wire();
})(window, document);
