/* Idle timeout -- "Are you there?"
 *
 * After 10 minutes with no activity anywhere in the app -- the hub itself,
 * or inside any open dashboard -- a prompt appears. "Yes" dismisses it and
 * the clock starts over; "No", or 30 seconds of silence after the prompt
 * appears, signs out.
 *
 * Dashboards load inside iframes on the hub page (see app.js's
 * openDashboard), which are separate browsing contexts: mouse/keyboard
 * activity inside one does not reach the parent page's own listeners. This
 * one script plays two different roles depending on where it ends up
 * running, so the same file can be included everywhere (the hub directly,
 * every dashboard via sync.py's ensure_idle_timeout) without needing two
 * versions kept in sync:
 *
 *   - Inside a dashboard iframe: just relays "something happened" up to
 *     the parent page, throttled -- it does not own a clock or a prompt of
 *     its own, since a dashboard should not show its own competing dialog.
 *   - On the hub page (the top frame): owns the actual 10-minute clock,
 *     listens for its own activity plus relayed messages from every open
 *     dashboard, and is the one place that shows the prompt and signs out.
 */
(function (w, d) {
  // Overridable only for testing (set before this script runs) -- real
  // usage always gets the 10-minute/30-second defaults.
  var IDLE_MS = w.__PARAS_IDLE_MS_OVERRIDE__ || 10 * 60 * 1000;
  var PROMPT_SECONDS = w.__PARAS_IDLE_PROMPT_SECONDS_OVERRIDE__ || 30;
  var ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'wheel'];

  if (w !== w.top) {
    var lastSent = 0;
    function relay() {
      var now = Date.now();
      if (now - lastSent < 2000) return;   // no need to message the parent on every pixel of mouse movement
      lastSent = now;
      try { w.parent.postMessage({ parasIdle: 'activity' }, '*'); } catch (e) {}
    }
    ACTIVITY_EVENTS.forEach(function (ev) { d.addEventListener(ev, relay, { passive: true, capture: true }); });
    return;
  }

  var idleTimer = null, promptTimer = null, modal = null;

  function resetIdle() {
    if (modal) return;   // only an explicit Yes/No or the timeout resolves an open prompt -- background activity elsewhere should not silently dismiss it
    clearTimeout(idleTimer);
    idleTimer = setTimeout(showPrompt, IDLE_MS);
  }

  ACTIVITY_EVENTS.forEach(function (ev) { d.addEventListener(ev, resetIdle, { passive: true, capture: true }); });
  w.addEventListener('message', function (e) {
    if (e.data && e.data.parasIdle === 'activity') resetIdle();
  });

  function buildModal() {
    var wrap = d.createElement('div');
    wrap.id = 'idleCheck';
    wrap.setAttribute('style',
      'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(8,12,22,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);');
    wrap.innerHTML =
      '<div style="background:var(--panel-strong,var(--panel,#141b2b));color:var(--ink,#eef2f8);' +
      'border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:26px 28px;max-width:340px;' +
      'text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.5);' +
      'font:14px/1.5 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">' +
      '<div style="font-size:17px;font-weight:700;margin-bottom:8px;">Are you there?</div>' +
      '<div style="opacity:.75;margin-bottom:18px;">Signing out in <span id="idleCheckSecs">' + PROMPT_SECONDS +
      '</span>s if there is no answer.</div>' +
      '<div style="display:flex;gap:10px;justify-content:center;">' +
      '<button id="idleCheckNo" type="button" style="padding:9px 18px;border-radius:10px;' +
      'border:1px solid rgba(255,255,255,.2);background:transparent;color:inherit;font:inherit;cursor:pointer;">No</button>' +
      '<button id="idleCheckYes" type="button" style="padding:9px 18px;border-radius:10px;border:none;' +
      'background:#2f6fed;color:#fff;font:inherit;font-weight:600;cursor:pointer;">Yes, I\'m here</button>' +
      '</div></div>';
    return wrap;
  }

  function showPrompt() {
    if (modal) return;
    modal = buildModal();
    d.body.appendChild(modal);
    var secs = PROMPT_SECONDS;
    var secsEl = modal.querySelector('#idleCheckSecs');
    modal.querySelector('#idleCheckYes').addEventListener('click', dismissPrompt);
    modal.querySelector('#idleCheckNo').addEventListener('click', signOut);
    promptTimer = setInterval(function () {
      secs -= 1;
      if (secsEl) secsEl.textContent = String(Math.max(secs, 0));
      if (secs <= 0) signOut();
    }, 1000);
  }

  function teardownModal() {
    clearInterval(promptTimer);
    promptTimer = null;
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    modal = null;
  }

  function dismissPrompt() {
    teardownModal();
    resetIdle();
  }

  function signOut() {
    teardownModal();
    if (w.ParasGate && typeof w.ParasGate.lock === 'function') {
      w.ParasGate.lock();
    } else {
      if (location.protocol !== 'file:') { try { fetch('__logout', { method: 'POST' }); } catch (e) {} }
      w.location.reload();
    }
  }

  resetIdle();
})(window, document);
