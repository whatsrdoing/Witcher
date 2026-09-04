/* Makes a dashboard's own localStorage-based "remember my data" behave the
 * same way the Command Centre's SESSION / LOCAL switch already behaves for
 * the shell itself: SESSION starts every dashboard fresh, like a private
 * window, and keeps whatever it saves only until this tab closes; LOCAL
 * keeps what the dashboard saved, same as today.
 *
 * Must run before anything else on the page, because some dashboards read
 * localStorage synchronously while parsing the body (auto-restoring a
 * previous upload) -- by the time a script at the bottom of the page ran,
 * that read would already have happened. Runs before the dashboard's own
 * markup or scripts, and never touches how the dashboard's code is written.
 *
 * Dashboards share the same browser origin as the Command Centre shell, so
 * this read of 'paras.cc.mode' sees the shell's real, current mode with no
 * cross-window messaging needed. Session mode is backed by sessionStorage --
 * the same "gone when this tab closes" store the shell itself already uses
 * for its own Session-mode data -- so a reload mid-session still sees what
 * was just saved, only a fresh tab starts clean.
 *
 * window.__parasSessionMode is set below BEFORE the localStorage swap, and
 * left alone afterwards -- it is the one place any script loaded later on
 * this page can ask "is this tab actually in Session mode?" and get the real
 * answer. Reading w.localStorage.getItem('paras.cc.mode') again after this
 * script has run does NOT work for that: once swapped, w.localStorage IS
 * sessionStorage, which was never where the shell wrote that flag, so it
 * reads back empty and looks like Local mode even while this really is
 * Session mode. Getting that wrong would leak server-backed data (an
 * auto-loaded database, say) into what is supposed to be a private,
 * nothing-persisted session -- worth one extra global rather than trusting
 * a read that only happens to work before this script runs.
 */
(function (w) {
  'use strict';
  var isSession = false;
  try {
    isSession = w.localStorage.getItem('paras.cc.mode') === 'session';
  } catch (e) { /* storage unavailable -- treat as not-session, same as before */ }
  w.__parasSessionMode = isSession;
  if (!isSession) return;
  try {
    Object.defineProperty(w, 'localStorage', {
      value: w.sessionStorage, configurable: true, enumerable: true,
    });
  } catch (e) { /* non-configurable -- leave real localStorage alone */ }
})(window);
