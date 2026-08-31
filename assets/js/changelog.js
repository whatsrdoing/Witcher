/* "What's new" -- a short, dated list of things that changed, read from
 * changelog.json (plain static file, same reasoning as dashboards.json:
 * no server endpoint needed, works over http and file:// alike). Its own
 * small file so app.js only has to know about the one hook it calls after
 * sign-in (refreshDot) plus the Escape-key hook every other modal here has. */
(function (w, d) {
  'use strict';

  var $ = function (s, r) { return (r || d).querySelector(s); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var cache = null;

  function load() {
    if (cache) return Promise.resolve(cache);
    return fetch('changelog.json', { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : { entries: [] };
    }).then(function (j) {
      cache = { entries: (j && j.entries) || [] };
      cache.entries.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
      return cache;
    }).catch(function () { return { entries: [] }; });
  }

  /* Keyed per account, not just per browser -- a shared machine with more
     than one sign-in should not have the first person to look dismiss it
     for everyone else too. */
  function seenKey() {
    var who = w.ParasGate && w.ParasGate.currentUser && w.ParasGate.currentUser();
    return 'paras_changelog_seen:' + ((who && who.login) || '_');
  }
  function lastSeen() {
    try { return localStorage.getItem(seenKey()) || ''; } catch (e) { return ''; }
  }
  function markSeen(date) {
    try { localStorage.setItem(seenKey(), date); } catch (e) {}
  }

  function refreshDot() {
    load().then(function (c) {
      var dot = $('#whatsNewDot');
      if (!dot) return;
      var newest = (c.entries[0] && c.entries[0].date) || '';
      dot.style.display = (newest && newest > lastSeen()) ? '' : 'none';
    });
  }

  var VISIBLE_BY_DEFAULT = 2;   // newest builds shown up front; the rest sit behind "Show all"

  function entryHtml(e) {
    var when = e.date;
    try { when = new Date(e.date).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }); }
    catch (err) { /* keep the raw date string */ }
    var version = e.version ? '<span class="changelog-version">v' + esc(e.version) + '</span>' : '';
    return '<div class="changelog-entry"><div class="changelog-date">' + esc(when) + ' ' + version + '</div>' +
      '<div class="changelog-title">' + esc(e.title || '') + '</div>' +
      '<ul class="changelog-notes">' + (e.notes || []).map(function (n) {
        return '<li>' + esc(n) + '</li>';
      }).join('') + '</ul></div>';
  }

  /* Newest first (already sorted in load()), scrolling straight down through
     more of them -- only the latest couple of builds show up front, with
     the rest behind one "Show all" tap rather than paginated further. */
  function render(c) {
    var body = $('#changelogBody');
    if (!c.entries.length) { body.innerHTML = '<p class="reset-lede">Nothing here yet.</p>'; return; }
    var head = c.entries.slice(0, VISIBLE_BY_DEFAULT);
    var rest = c.entries.slice(VISIBLE_BY_DEFAULT);
    body.innerHTML = head.map(entryHtml).join('') +
      (rest.length ? '<button class="btn sm" id="changelogMore">Show all (' + c.entries.length + ')</button>' +
        '<div id="changelogRest" hidden>' + rest.map(entryHtml).join('') + '</div>' : '');
    var moreBtn = $('#changelogMore');
    if (moreBtn) moreBtn.addEventListener('click', function () {
      $('#changelogRest').hidden = false;
      moreBtn.remove();
    });
  }

  function open() {
    $('#changelogModal').classList.add('open');
    $('#changelogBody').textContent = 'Loading…';
    load().then(function (c) {
      render(c);
      if (c.entries[0]) markSeen(c.entries[0].date);
      var dot = $('#whatsNewDot');
      if (dot) dot.style.display = 'none';
    });
  }
  function close() {
    $('#changelogModal').classList.remove('open');
  }
  function closeIfOpen() {
    if ($('#changelogModal').classList.contains('open')) { close(); return true; }
    return false;
  }

  d.addEventListener('DOMContentLoaded', function () {
    var btn = $('#whatsNewBtn');
    if (btn) btn.addEventListener('click', open);
    var closeBtn = $('#changelogClose'); if (closeBtn) closeBtn.addEventListener('click', close);
    var modal = $('#changelogModal');
    if (modal) modal.addEventListener('click', function (e) { if (e.target === e.currentTarget) close(); });
  });

  w.ParasChangelog = { refreshDot: refreshDot, closeIfOpen: closeIfOpen };
})(window, document);
