/* PARAS HEALTH — SUPPLY CHAIN COMMAND CENTRE
 * Shell / launcher only. Dashboards are loaded verbatim into isolated iframes:
 * their markup, CSS, scripts and state are never touched by this file. */
(function (w, d) {
  'use strict';

  var REG = null;
  // Each mode keeps its own set of open dashboards. Local's survive a trip
  // through Session and back, exactly as left; Session's are thrown away
  // every time you leave Session, so it is always a fresh workspace when
  // you come back to it -- the same asymmetry the mode switch already has
  // for everything else (files, layout).
  var framesByMode = { local: Object.create(null), session: Object.create(null) };
  var frames = framesByMode.local;    // id -> { el, loaded, openedAt }; points at the active mode's set
  var fileCounts = Object.create(null);
  var lastUpdated = Object.create(null);  // dashboardId -> newest attached file's updatedAt, for the card's freshness note
  var current = null;                 // active dashboard id, null = home
  var DEV_CAT = '__dev';            // pseudo-category: everything not live yet
  var filter = { text: '', category: 'all' };
  // The Data Library used to be a same-page drawer the shell drove directly;
  // it is now its own dashboard, a sibling iframe like any other -- this is
  // just its id, so the few spots that used to special-case "the drawer" can
  // instead special-case "don't try to auto-match files into this one" (it
  // has its own file inputs for browsing, not upload slots to auto-fill) and
  // "open this dashboard" where they used to open the drawer.
  var LIBRARY_DASH_ID = 'data-library';

  var $ = function (s, r) { return (r || d).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || d).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var ico = function (n, c) { return w.Icons.svg(n, c); };

  /* ===================== boot =========================================== */
  function boot() {
    w.Registry.load().then(function (reg) {
      return (w.ParasAdmin ? w.ParasAdmin.isAdmin() : Promise.resolve(true)).then(function (isAdmin) {
        if (!isAdmin) reg.dashboards = reg.dashboards.filter(function (x) { return !x.adminOnly; });
        return reg;
      });
    }).then(function (reg) {
      REG = reg;

      var mode = w.Store.readStoredMode(reg.app.defaultMode);
      w.Store.setMode(mode);
      frames = framesByMode[mode] || framesByMode.local;
      w.Store.loadPrefs();

      applyTheme(w.Store.getPref('theme', reg.app.defaultTheme));
      filter.category = w.Store.getPref('category', 'all');

      paintChrome();
      wire();
      if (w.ParasAdmin) w.ParasAdmin.checkAccess();
      if (w.ParasTwoFactor) w.ParasTwoFactor.refreshStatus();
      if (w.ParasChangelog) w.ParasChangelog.refreshDot();
      if (w.ParasAsk) w.ParasAsk.reveal();

      w.Store.checkPersistence().then(function () {
        renderModeSwitch();
        var moved = w.Store.migratedCount ? w.Store.migratedCount() : 0;
        if (moved) {
          toast('Moved ' + moved + ' file' + (moved === 1 ? '' : 's') +
            ' already attached into this folder’s data/library.', 'ok', 6000);
        }
        return refreshCounts();
      }).then(renderHome);

      renderHome();
      route();

      (reg.warnings || []).forEach(function (msg) { toast(msg, 'warn', 7000); });
      if (reg.loadError) {
        toast('Could not read dashboards.json (' + reg.loadError + '). Run "python3 sync.py" then reopen, or start the app with "python3 serve.py".', 'err', 12000);
      }
    });
  }

  function paintChrome() {
    // The org name lives in the logo artwork, so it drives the alt text here.
    $('#brandLogo').alt = REG.app.org;
    $('#heroLogo').alt = REG.app.org;
    $('#brandSub').textContent = REG.app.title;
    d.title = REG.app.org + ' — ' + REG.app.title;
    $('#heroTitle').textContent = REG.app.title;
    $('#heroLede').textContent = REG.app.tagline || '';
    $('#regSource').textContent = REG.source;
    renderProfile();
  }

  function renderProfile() {
    var who = (w.ParasGate && w.ParasGate.currentUser && w.ParasGate.currentUser()) || null;
    var tray = $('#profileTray');
    if (!who) { if (tray) tray.style.display = 'none'; return; }
    if (tray) tray.style.display = '';
    var label = who.name || who.login || 'Account';
    $('#profileName').textContent = label;
    $('#profileWho').textContent = label;
    $('#profileRole').textContent = [who.designation, who.department]
      .filter(Boolean).join(' \u00b7 ') || who.login || '';
    paintAvatars(who);
    var rows = [
      ['Username', who.login],
      ['Designation', who.designation],
      ['Department', who.department],
      ['Category', who.category],
      ['Phone', who.phone],
      ['Email', who.email],
      ['Employee ID', who.parasId],
    ].filter(function (r) { return r[1]; });
    $('#profilePopBody').innerHTML = rows.length
      ? rows.map(function (r) {
          return '<div class="pop-row"><span class="nm">' + esc(r[0]) + '</span>' +
            '<span style="color:var(--ink-2);font-weight:600">' + esc(r[1]) + '</span></div>';
        }).join('')
      : '<div class="empty">No details on file.</div>';
  }

  /* ---- account photo ------------------------------------------------------
     Both chips are painted from the one lookup in Avatar.paint (it memoises
     per login), and the Remove button only appears once we know a photo is
     actually there -- offering "Remove" against initials is a dead control. */
  function paintAvatars(who) {
    if (!w.Avatar) return;
    var sm = $('#profileAvatar'), lg = $('#profileAvatarLg');
    w.Avatar.paint(sm, who);
    w.Avatar.paint(lg, who).then(function (url) {
      var drop = $('#photoDrop'), lab = $('#photoPickLabel');
      if (drop) drop.style.display = url ? '' : 'none';
      if (lab) lab.textContent = url ? 'Change photo' : 'Add photo';
    });
  }

  function wirePhoto() {
    var pick = $('#photoPick'), input = $('#photoInput'), drop = $('#photoDrop');
    if (!pick || !input) return;
    function me() {
      return (w.ParasGate && w.ParasGate.currentUser && w.ParasGate.currentUser()) || null;
    }
    pick.addEventListener('click', function () { input.value = ''; input.click(); });
    input.addEventListener('change', function () {
      var f = input.files && input.files[0], who = me();
      if (!f || !who) return;
      var lg = $('#profileAvatarLg');
      if (lg) lg.classList.add('busy');
      w.Avatar.set(who.login, f).then(function (meta) {
        paintAvatars(who);
        toast(meta && meta.keptInBrowser
          ? 'Photo saved in this browser — the data folder was not reachable.'
          : 'Photo saved.', meta && meta.keptInBrowser ? 'warn' : 'ok');
      }).catch(function (e) {
        toast(e && e.message ? e.message : 'Could not save that photo.', 'err');
      }).then(function () { if (lg) lg.classList.remove('busy'); });
    });
    if (drop) drop.addEventListener('click', function () {
      var who = me();
      if (!who) return;
      w.Avatar.clear(who.login).then(function () {
        paintAvatars(who);
        toast('Photo removed.', 'ok');
      });
    });
  }

  /* ===================== theme / mode ==================================== */
  function applyTheme(t) {
    t = (t === 'light') ? 'light' : 'dark';
    d.documentElement.setAttribute('data-theme', t);
    var b = $('#themeBtn');
    if (b) {
      b.innerHTML = ico(t === 'light' ? 'moon' : 'sun');
      b.title = t === 'light' ? 'Switch to dark' : 'Switch to light';
    }
    w.Store.setPref('theme', t);
    broadcastTheme(t);
  }

  /* Every dashboard is meant to feel like part of this one console, not a
     separate page bolted on -- so the shell's own dark/light toggle carries
     into every dashboard iframe (open now, or opened later) via the same
     bridge sync.py already injects for file hand-off. A dashboard with no
     light palette of its own just ignores the attribute; this is what makes
     it possible to add one, one dashboard at a time, without any shell-side
     change once that palette exists. */
  function sendThemeTo(id, t) {
    var f = frames[id];
    if (!f || !f.el || !f.el.contentWindow) return;
    try { f.el.contentWindow.postMessage({ __paras: 1, action: 'theme', theme: t }, '*'); } catch (e) {}
  }
  function broadcastTheme(t) {
    Object.keys(frames).forEach(function (id) { sendThemeTo(id, t); });
  }
  function currentTheme() {
    return d.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function renderModeSwitch() {
    var mode = w.Store.getMode();
    var onDisk = w.Store.Files.onDisk();               // attachments are real files in data/library/
    var persistOk = w.Store.idbAvailable() !== false;   // attachments persist at all (on disk, or at least IndexedDB)
    $$('#modeSwitch button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    });
    var local = $('#modeSwitch button[data-mode="local"]');
    if (onDisk) {
      local.title = 'Local mode — dashboards, layout and attached files stay on this computer, in this folder\'s data/library.';
    } else if (persistOk) {
      local.title = 'Local file storage isn\'t reachable right now, so attachments are only in this browser (not data/library). Restart "python3 serve.py" to fix this. Layout still persists.';
    } else {
      local.title = 'Local file storage needs a local server — run "python3 serve.py". Layout still persists.';
    }
    $('#modeNote').innerHTML = mode === 'session'
      ? ico('bolt', 'sm') + '<span>Session mode — attachments and layout changes are discarded when you close this tab.</span>'
      : onDisk
        ? ico('lock', 'sm') + '<span>Local mode — everything is stored on this computer only, in this folder\'s <code>data/library</code>. Nothing leaves the machine.</span>'
        : persistOk
          ? ico('warn', 'sm') + '<span>Local mode — attachments are only in this browser\'s storage right now, not this folder\'s <code>data/library</code>, because the local server isn\'t reachable. Restart <code>python3 serve.py</code> to fix this.</span>'
          : ico('warn', 'sm') + '<span>Local mode — layout persists, but attachments need <code>python3 serve.py</code> to survive a restart.</span>';
  }

  function switchMode(next) {
    var leaving = w.Store.getMode();
    if (next === leaving) return;
    var go = function () {
      // Session is thrown away every time you leave it, so it is a fresh
      // workspace again next time. Local is never touched here -- its open
      // dashboards just stop being shown and pick up again untouched.
      if (leaving === 'session') closeFramesFor('session');
      current = null;
      $$('.frames iframe').forEach(function (f) { f.classList.remove('active'); });
      frames = framesByMode[next];

      w.Store.setMode(next);
      w.Store.loadPrefs();
      applyTheme(w.Store.getPref('theme', REG.app.defaultTheme));
      filter.category = w.Store.getPref('category', 'all');
      renderModeSwitch();
      refreshCounts().then(renderHome);
      goHome();
      renderLiveCount();
      toast(next === 'session'
        ? 'Session mode — a fresh, temporary workspace. Dashboards open in Local stay exactly as they are.'
        : 'Local mode — back to what was saved on this computer. Dashboards open in Session were discarded.', 'ok', 4500);
    };
    if (next === 'session') {
      confirmDialog('Switch to Session mode?',
        'Session mode starts a completely fresh, temporary workspace — like opening an Incognito window. Dashboards you have open in Local right now are not affected; switch back to Local anytime to find them exactly as you left them. Files you attach and layout changes in Session are held in memory only and disappear the moment you leave Session or close this tab.',
        'Switch to Session', go);
    } else { go(); }
  }

  /* ===================== routing ========================================= */
  function route() {
    var h = (location.hash || '').replace(/^#/, '');
    if (h === '/admin') {
      if (w.ParasAdmin && w.ParasAdmin.showIfAllowed()) return;
      // Not the admin account (or the check hasn't resolved yet) -- fall
      // through to home rather than sitting on a blank/forbidden hash.
    }
    var m = /^\/d\/(.+)$/.exec(h);
    if (m) {
      var db = byId(decodeURIComponent(m[1]));
      if (db && db.file) { openDashboard(db.id, true); return; }
    }
    goHome(true);
  }

  function byId(id) {
    for (var i = 0; i < REG.dashboards.length; i++) if (REG.dashboards[i].id === id) return REG.dashboards[i];
    return null;
  }

  function goHome(silent) {
    current = null;
    $('#viewHome').classList.add('active');
    $('#viewDash').classList.remove('active');
    $('#viewAdmin').classList.remove('active');
    $$('.frames iframe').forEach(function (f) { f.classList.remove('active'); });
    $('#frameLoading').style.display = 'none';
    $('#matchBar').style.display = 'none';
    $('.dash-bar').classList.remove('collapsed');
    renderCrumbs();
    renderLiveCount();
    if (w.ParasAdmin) w.ParasAdmin.reportViewing(null);
    if (!silent) location.hash = '#/';
    else if (!location.hash || location.hash === '#') history.replaceState(null, '', '#/');
  }

  function openDashboard(id, silent) {
    var db = byId(id);
    if (!db) return goHome();
    if (!db.file) { toast('"' + db.name + '" is registered but has no HTML file yet.', 'warn'); return; }
    if (w.ParasAdmin) w.ParasAdmin.reportViewing(db.name || id);

    current = id;
    $('#viewHome').classList.remove('active');
    $('#viewDash').classList.add('active');
    $('#viewAdmin').classList.remove('active');
    // Each dashboard starts pinned open, as if newly loaded; refreshMatchBar
    // below decides within a beat whether this one gets to autohide (and, if
    // so, tucks it away right then -- see setChromeLoaded). The bar is one
    // shared element reused across every dashboard, so both classes must be
    // reset here or the previous dashboard's state would leak into this one.
    $('.dash-bar').classList.remove('collapsed', 'autohide');

    // Snapshotted so the load handler below still updates the right mode's
    // frame set even if the mode is switched again before it fires -- Local
    // and Session can each have their own iframe for the same dashboard id,
    // so `frames` (which mode switching reassigns) is not safe to read late.
    var myFrames = frames;
    var f = myFrames[id];
    if (!f) {
      var el = d.createElement('iframe');
      el.title = db.name;
      el.setAttribute('loading', 'eager');
      el.dataset.id = id;
      el.src = db.file;
      $('#frameLoading').style.display = 'flex';
      $('#frameLoadingTxt').textContent = 'Opening ' + db.name + '…';
      el.addEventListener('load', function () {
        myFrames[id].loaded = true;
        if (current === id) { $('#frameLoading').style.display = 'none'; refreshMatchBar(); }
        sendThemeTo(id, currentTheme());
        tryAutoRun(id);
      });
      $('#frames').appendChild(el);
      f = myFrames[id] = { el: el, loaded: false, openedAt: Date.now() };
    }
    $('#frameLoading').style.display = f.loaded ? 'none' : 'flex';

    // Compare by element, not by dataset.id -- Local and Session can each
    // have an iframe open for the same dashboard id at once, and only the
    // one belonging to the mode just opened should end up visible.
    $$('.frames iframe').forEach(function (x) { x.classList.toggle('active', x === f.el); });

    $('#dashIcon').innerHTML = ico(db.icon);
    $('#dashIcon').style.setProperty('--accent', db.accent);
    $('#dashTitle').textContent = db.name;
    $('#dashFilesBtn').innerHTML = ico('folder') + '<span>Data Library</span>';

    renderCrumbs(db);
    renderLiveCount();
    refreshMatchBar();
    if (!silent) location.hash = '#/d/' + encodeURIComponent(id);
  }

  function unloadFrame(id) {
    var f = frames[id];
    if (!f) return;
    f.el.remove();
    delete frames[id];
    renderLiveCount();
    if (current === id) goHome();
    var db = byId(id);
    toast((db ? db.name : 'Dashboard') + ' closed — its in-page state was released.', 'ok');
  }

  /* Closes every dashboard open in one mode's set, with no per-file toast.
     Only ever called for 'session' -- on leaving it, so it is a fresh
     workspace again next time it is entered. Local's own set is a separate
     object and is never passed here, so switching modes never touches it. */
  function closeFramesFor(mode) {
    var fm = framesByMode[mode];
    Object.keys(fm).forEach(function (id) {
      var f = fm[id];
      if (f && f.el) f.el.remove();
    });
    framesByMode[mode] = Object.create(null);
  }

  function renderCrumbs(db) {
    var c = $('#crumbs');
    if (!db) { c.innerHTML = '<span class="cur">Command Centre</span>'; return; }
    c.innerHTML =
      '<button data-go="home">Command Centre</button>' +
      '<span class="sep">/</span>' +
      '<button data-go="cat" data-cat="' + esc(db.category) + '">' + esc(db.categoryName) + '</button>' +
      '<span class="sep">/</span>' +
      '<span class="cur">' + esc(db.name) + '</span>';
  }

  function renderLiveCount() {
    var ids = Object.keys(frames);
    var b = $('#liveCount');
    b.textContent = ids.length;
    b.style.display = ids.length ? 'flex' : 'none';
  }

  function renderLivePop() {
    var ids = Object.keys(frames);
    var host = $('#livePopList');
    if (!ids.length) { host.innerHTML = '<div class="empty">No dashboards are open yet.</div>'; return; }
    host.innerHTML = ids.map(function (id) {
      var db = byId(id) || { name: id, icon: 'grid', accent: '#7B8792' };
      return '<div class="pop-row">' +
        '<span style="color:' + esc(db.accent) + '">' + ico(db.icon, 'sm') + '</span>' +
        '<button class="nm" data-open="' + esc(id) + '" style="text-align:left">' + esc(db.name) + '</button>' +
        '<button class="x" data-unload="' + esc(id) + '" title="Close and release state">' + ico('close', 'sm') + '</button>' +
        '</div>';
    }).join('');
  }

  /* ===================== home =========================================== */
  function visibleDashboards() {
    var hidden = w.Store.getPref('hidden', []) || [];
    var order = w.Store.getPref('order', []) || [];
    var list = REG.dashboards.slice();

    list.sort(function (a, b) {
      // Not-yet-built dashboards always sit after the working ones, so the
      // grid opens on what can actually be used.
      var pa = a.status === 'live' ? 0 : 1, pb = b.status === 'live' ? 0 : 1;
      if (pa !== pb) return pa - pb;
      var ia = order.indexOf(a.id), ib = order.indexOf(b.id);
      if (ia >= 0 || ib >= 0) {
        if (ia < 0) return 1; if (ib < 0) return -1;
        return ia - ib;
      }
      var ca = REG.categoryById[a.category], cb = REG.categoryById[b.category];
      if (ca && cb && ca.order !== cb.order) return ca.order - cb.order;
      if (a.order !== b.order) return a.order - b.order;
      return a.name.localeCompare(b.name);
    });

    var q = filter.text.trim().toLowerCase();
    return list.filter(function (x) {
      if (hidden.indexOf(x.id) >= 0) return false;
      if (filter.category === DEV_CAT) { if (x.status === 'live') return false; }
      else if (filter.category !== 'all' && x.category !== filter.category) return false;
      if (!q) return true;
      return (x.name + ' ' + x.categoryName + ' ' + x.description + ' ' + x.tags.join(' ') + ' ' + x.owner)
        .toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderHome() {
    renderStats();
    renderChips();
    renderGrid();
    renderHiddenTray();
  }

  function renderStats() {
    var hidden = (w.Store.getPref('hidden', []) || []).length;
    var live = REG.dashboards.filter(function (x) { return x.status === 'live'; }).length;
    var files = Object.keys(fileCounts).reduce(function (n, k) { return n + fileCounts[k]; }, 0);
    var building = REG.dashboards.filter(function (x) { return x.status !== 'live'; }).length;
    $('#stats').innerHTML = [
      ['Dashboards', REG.dashboards.length],
      ['Live', live],
      building ? ['In development', building] : null,
      ['Categories', REG.categories.filter(function (c) {
        return REG.dashboards.some(function (x) { return x.category === c.id; });
      }).length],
      ['Attachments', files],
      hidden ? ['Hidden', hidden] : null
    ].filter(Boolean).map(function (p) {
      return '<div class="stat glass"><b>' + p[1] + '</b><span>' + p[0] + '</span></div>';
    }).join('');
  }

  function renderChips() {
    var counts = Object.create(null);
    var hidden = w.Store.getPref('hidden', []) || [];
    REG.dashboards.forEach(function (x) {
      if (hidden.indexOf(x.id) >= 0) return;
      counts[x.category] = (counts[x.category] || 0) + 1;
    });
    var total = Object.keys(counts).reduce(function (n, k) { return n + counts[k]; }, 0);
    var building = REG.dashboards.filter(function (x) {
      return x.status !== 'live' && hidden.indexOf(x.id) < 0;
    }).length;
    var html = '<button class="chip" data-cat="all" aria-pressed="' + (filter.category === 'all') + '">' +
      ico('layers', 'sm') + 'All<span class="n">' + total + '</span></button>';
    if (building) {
      html += '<button class="chip dev" data-cat="' + DEV_CAT + '" aria-pressed="' +
        (filter.category === DEV_CAT) + '">' + ico('bolt', 'sm') + 'In development' +
        '<span class="n">' + building + '</span></button>';
    }
    html += REG.categories.filter(function (c) { return counts[c.id]; }).map(function (c) {
      return '<button class="chip" data-cat="' + esc(c.id) + '" aria-pressed="' + (filter.category === c.id) + '">' +
        '<span class="dot" style="background:' + esc(c.accent) + '"></span>' + esc(c.name) +
        '<span class="n">' + counts[c.id] + '</span></button>';
    }).join('');
    $('#chips').innerHTML = html;
  }

  function statusLabel(s) {
    return { live: 'Live', beta: 'Beta', planned: 'In development', archived: 'Archived' }[s] || s;
  }

  function renderGrid() {
    var list = visibleDashboards();
    var grid = $('#grid');
    if (!list.length) {
      grid.innerHTML = '';
      $('#gridEmpty').style.display = 'block';
      $('#gridEmpty').innerHTML = filter.text || filter.category !== 'all'
        ? '<div class="empty-state">' + ico('search', 'lg') + '<h3>No dashboards match</h3><p>Try a different search term or category.</p></div>'
        : '<div class="empty-state">' + ico('inbox', 'lg') + '<h3>No dashboards registered</h3>' +
          '<p>Drop an HTML file into <code>dashboards/</code> and add one entry to <code>dashboards.json</code>.</p></div>';
      return;
    }
    $('#gridEmpty').style.display = 'none';

    grid.innerHTML = list.map(function (x, i) {
      var open = !!frames[x.id];
      var n = fileCounts[x.id] || 0;
      var updatedAt = lastUpdated[x.id];
      var playable = x.status !== 'planned' && !!x.file;
      return '<article class="card glass status-' + esc(x.status) + '" data-id="' + esc(x.id) + '" draggable="true"' +
        ' style="--accent:' + esc(x.accent) + '; animation-delay:' + Math.min(i * 26, 320) + 'ms">' +
        '<div class="card-grip">' +
          '<button class="handle" title="Drag to rearrange" aria-label="Drag to rearrange">' + ico('grip', 'sm') + '</button>' +
          '<button data-hide="' + esc(x.id) + '" title="Hide this card" aria-label="Hide">' + ico('eyeoff', 'sm') + '</button>' +
        '</div>' +
        '<div class="card-top">' +
          '<div class="card-ico">' + ico(x.icon) + '</div>' +
          '<div class="card-head">' +
            '<div class="card-cat">' + esc(x.categoryName) + '</div>' +
            '<div class="card-name">' + esc(x.name) + '</div>' +
          '</div>' +
        '</div>' +
        '<p class="card-desc">' + esc(x.description || 'No description yet — add one in dashboards.json.') + '</p>' +
        (updatedAt
          ? '<div class="card-updated" title="' + esc(fmtDate(updatedAt)) + '">' + ico('clock', 'sm') +
            '<span>Data updated ' + esc(relTime(updatedAt)) + '</span></div>'
          : '') +
        '<div class="card-foot">' +
          '<span class="badge ' + esc(x.status) + '">' + esc(statusLabel(x.status)) + '</span>' +
          (open ? '<span class="badge open">Open</span>' : '') +
          '<span class="spacer"></span>' +
          '<button class="btn sm icon-only" data-files="' + esc(x.id) + '" title="Attached files">' +
            ico('folder', 'sm') + (n ? '' : '') + '</button>' +
          (n ? '<span class="card-meta">' + n + '</span>' : '') +
          (playable
            ? '<button class="btn sm primary" data-open="' + esc(x.id) + '">Open' + ico('back', 'sm') + '</button>'
            : '<button class="btn sm" disabled>Not added yet</button>') +
        '</div>' +
        '</article>';
    }).join('');
    // rotate the arrow on the Open button (reuse of the back glyph)
    $$('#grid .btn.primary .icon').forEach(function (s) { s.style.transform = 'rotate(180deg)'; });
    wireDrag();
  }

  function renderHiddenTray() {
    var hidden = w.Store.getPref('hidden', []) || [];
    var wrap = $('#hiddenWrap');
    if (!hidden.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    $('#hiddenTray').innerHTML = hidden.map(function (id) {
      var x = byId(id); if (!x) return '';
      return '<span class="hidden-pill">' + ico(x.icon, 'sm') + esc(x.name) +
        '<button data-restore="' + esc(id) + '">Restore</button></span>';
    }).join('');
  }

  /* ===================== drag to rearrange =============================== */
  var dragId = null;
  function wireDrag() {
    $$('#grid .card').forEach(function (card) {
      card.addEventListener('dragstart', function (e) {
        dragId = card.dataset.id;
        card.classList.add('dragging');
        try { e.dataTransfer.setData('text/x-paras-card', dragId); e.dataTransfer.effectAllowed = 'move'; } catch (err) {}
      });
      card.addEventListener('dragend', function () {
        dragId = null;
        card.classList.remove('dragging');
        $$('#grid .card').forEach(function (c) { c.classList.remove('drop-before', 'drop-after'); });
      });
      card.addEventListener('dragover', function (e) {
        if (!dragId || card.dataset.id === dragId) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
        var r = card.getBoundingClientRect();
        var before = (e.clientX - r.left) < r.width / 2;
        card.classList.toggle('drop-before', before);
        card.classList.toggle('drop-after', !before);
      });
      card.addEventListener('dragleave', function () {
        card.classList.remove('drop-before', 'drop-after');
      });
      card.addEventListener('drop', function (e) {
        card.classList.remove('drop-before', 'drop-after');
        if (!dragId || card.dataset.id === dragId) return;
        e.preventDefault(); e.stopPropagation();
        var r = card.getBoundingClientRect();
        reorder(dragId, card.dataset.id, (e.clientX - r.left) < r.width / 2);
      });
    });
  }

  function hasFiles(e) {
    var t = e.dataTransfer && e.dataTransfer.types;
    return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0;
  }

  function reorder(movedId, targetId, before) {
    var all = w.Store.getPref('order', []) || [];
    if (!all.length) all = REG.dashboards.slice().sort(function (a, b) {
      var ca = REG.categoryById[a.category], cb = REG.categoryById[b.category];
      if (ca && cb && ca.order !== cb.order) return ca.order - cb.order;
      return a.order - b.order;
    }).map(function (x) { return x.id; });

    REG.dashboards.forEach(function (x) { if (all.indexOf(x.id) < 0) all.push(x.id); });
    all = all.filter(function (id) { return id !== movedId; });
    var at = all.indexOf(targetId);
    if (at < 0) at = all.length;
    all.splice(before ? at : at + 1, 0, movedId);
    w.Store.setPref('order', all);
    renderGrid();
  }

  function resetLayout() {
    confirmDialog('Reset the card layout?',
      'Card order and hidden cards go back to the order defined in dashboards.json. Attached files and open dashboards are not affected.',
      'Reset layout', function () {
        w.Store.setPref('order', []);
        w.Store.setPref('hidden', []);
        renderHome();
        toast('Layout reset.', 'ok');
      });
  }

  /* ===================== files ========================================== */
  function refreshCounts() {
    // listAll (not the lighter counts()) because the card's "last updated"
    // note needs each file's own updatedAt, not just how many there are.
    return w.Store.Files.listAll().then(function (rows) {
      var counts = Object.create(null), updated = Object.create(null);
      (rows || []).forEach(function (r) {
        if (!r.dashboardId) return;
        counts[r.dashboardId] = (counts[r.dashboardId] || 0) + 1;
        var t = r.updatedAt || r.addedAt || 0;
        if (t > (updated[r.dashboardId] || 0)) updated[r.dashboardId] = t;
      });
      fileCounts = counts;
      lastUpdated = updated;
      return counts;
    }).catch(function () { fileCounts = {}; lastUpdated = {}; return {}; });
  }

  // Everything that used to live here (openDrawer/closeDrawer, the section
  // grid, the file list, condense, import, rename/delete, send-to-dashboard's
  // UI) has moved to dashboards/Data_Library.html -- its own dashboard now,
  // opened the same way as any other. What is left below is only the part
  // that could not move with it: the shell is still the one place that can
  // reach every OTHER open dashboard's iframe directly, so the auto-match
  // bar (matchesFor/refreshMatchBar/tryAutoRun/fillAllFromLibrary, further
  // down) and the cross-frame "send this file over" relay (sendToDashboard,
  // and the 'requestFill' branch on the message listener) stay here.

  function fmtSize(n) {
    if (!n && n !== 0) return '';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
  }
  function fmtDate(t) {
    try { return new Date(t).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }
  /* When its underlying data last changed, for the home card's freshness
     note -- "how current is what I'd see if I opened this" without having
     to open it. Falls back to the plain date once "X days ago" stops being
     useful at a glance. */
  function relTime(t) {
    if (!t) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    var m = s / 60;
    if (m < 60) return Math.floor(m) + (Math.floor(m) === 1 ? ' minute ago' : ' minutes ago');
    var h = m / 60;
    if (h < 24) return Math.floor(h) + (Math.floor(h) === 1 ? ' hour ago' : ' hours ago');
    var days = h / 24;
    if (days < 30) return Math.floor(days) + (Math.floor(days) === 1 ? ' day ago' : ' days ago');
    return fmtDate(t);
  }

  // Whether a file is too large to hand to a dashboard directly (still used
  // by the auto-match bar below, and by sendToDashboard's own size check) --
  // matches the same limit the Data Library dashboard condenses against.
  function isBig(r) {
    return r.size > w.Library.BIG_FILE && /\.(csv|tsv|txt)$/i.test(r.name);
  }

  /* ===================== send a file into the dashboard ================= */
  /* The dashboards keep their own "Choose File" inputs — the Command Centre
     does not change how they work. But when a dashboard is served from this
     same origin its document is reachable, so an attached file can be handed
     straight to the right input instead of being downloaded and re-picked.
     Blocked on file:// (each file is its own origin there), which is one more
     reason to launch with start.bat. */
  function frameDoc(id) {
    var f = frames[id];
    if (!f || !f.loaded) return null;
    try {
      var doc = f.el.contentDocument;
      return (doc && doc.body) ? doc : null;
    } catch (e) { return null; }      // cross-origin
  }

  function inputLabel(inp, i) {
    var txt = '';
    try {
      if (inp.labels && inp.labels.length) txt = inp.labels[0].textContent;
      if (!txt && inp.closest) { var l = inp.closest('label'); if (l) txt = l.textContent; }
      var box = inp.parentElement;
      for (var d = 0; d < 3 && box && !txt; d++) {
        var lab = box.querySelector('label, h3, h4, b, strong, .label');
        if (lab && lab.textContent.trim()) txt = lab.textContent;
        box = box.parentElement;
      }
      if (!txt) txt = inp.getAttribute('aria-label') || inp.getAttribute('title') || inp.name || inp.id || '';
    } catch (e) {}
    txt = String(txt).replace(/\s+/g, ' ').trim();
    if (txt.length > 58) txt = txt.slice(0, 58) + '…';
    return txt || ('File input ' + (i + 1));
  }

  /* ---- talking to a dashboard ------------------------------------------
     Same-origin (launched with start.bat) we read the dashboard's inputs
     directly. Opened straight from disk the browser seals each page off, so we
     ask the bridge sync.py injects into every dashboard instead. Same result
     either way; the messaging path is just a round trip slower. */
  var msgSeq = 0, pending = {};

  w.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || m.__paras !== 1 || !m.id) return;
    var waiter = pending[m.id];
    if (!waiter) return;
    delete pending[m.id];
    clearTimeout(waiter.timer);
    waiter.resolve(m);
  }, false);

  /* Unsolicited push from the open dashboard's own page (no `id` to match a
     pending request, unlike everything above) reporting which way it is
     being scrolled. Only acted on for the frame actually on screen, and only
     once that dashboard has nothing left needing the toolbar pinned -- see
     setChromeLoaded. */
  w.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || m.__paras !== 1 || m.action !== 'scroll') return;
    var srcId = null;
    Object.keys(frames).some(function (id) {
      if (frames[id].el && frames[id].el.contentWindow === ev.source) { srcId = id; return true; }
      return false;
    });
    if (!srcId || srcId !== current) return;
    var tb = $('.dash-bar');
    if (!tb || !tb.classList.contains('autohide')) return;
    tb.classList.toggle('collapsed', m.dir === 'down');
  }, false);

  /* Unsolicited push from the Data Library dashboard's own iframe: "put this
     file of mine into that OTHER dashboard's upload box". The Library used
     to live in the parent frame itself, alongside every dashboard's iframe,
     so it could call ask()/fillInput() on a target dashboard directly. Now
     it is a sibling iframe like any other, and same-origin iframes cannot
     reach one another -- only their common parent can, so the Library asks
     the shell to do the handoff instead, naming the file (by id -- the shell
     reads the actual bytes from the same on-disk/IndexedDB Store the Library
     itself used, never sent over postMessage) and the dashboard it belongs
     in. Validated the same way the scroll relay above is: the source window
     has to be a frame this shell actually has open, and here specifically
     the Library's own frame -- never any other dashboard's. */
  w.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || m.__paras !== 1 || m.action !== 'requestFill') return;
    var lib = frames[LIBRARY_DASH_ID];
    if (!lib || !lib.el || !lib.el.contentWindow || lib.el.contentWindow !== ev.source) return;
    if (!m.dashId || !m.fileId) return;
    sendToDashboard(m.fileId, m.name || 'file', m.type || '', m.dashId);
  }, false);

  function ask(id, payload, timeoutMs) {
    var f = frames[id];
    if (!f || !f.el.contentWindow) return Promise.reject(new Error('dashboard is not open'));
    var reqId = 'p' + (++msgSeq) + '-' + Date.now();
    return new Promise(function (resolve, reject) {
      pending[reqId] = {
        resolve: resolve,
        timer: setTimeout(function () {
          delete pending[reqId];
          reject(new Error('the dashboard did not answer — reload it, or run sync.py to add the bridge'));
        }, timeoutMs || 6000)
      };
      try {
        f.el.contentWindow.postMessage(
          Object.assign({ __paras: 1, id: reqId }, payload), '*');
      } catch (e) {
        delete pending[reqId];
        reject(e);
      }
    });
  }

  function decorate(id, raw) {
    var db = byId(id) || {};
    var declared = db.inputs || [];
    var used = {};
    var total = raw.length;
    return raw.map(function (r, i) {
      var spec = declared.length === total ? declared[i]
               : matchSpec(r.label, declared, i, used);
      spec = spec || {};
      return {
        el: r.el || null,
        index: i,
        label: spec.label || r.label,
        accept: spec.accept || r.accept || '',
        needs: spec.needs || [],
        match: spec.match || [],
        optional: !!spec.optional,
        auto: spec.auto !== false,
        dashId: id
      };
    });
  }

  /* Resolves to the dashboard's upload boxes, or null if it isn't ready. */
  function frameInputs(id) {
    var f = frames[id];
    if (!f || !f.loaded) return Promise.resolve(null);

    var doc = frameDoc(id);
    if (doc) {
      var raw = Array.prototype.map.call(doc.querySelectorAll('input[type=file]'), function (inp, i) {
        return { el: inp, label: inputLabel(inp, i), accept: inp.getAttribute('accept') || '' };
      });
      return Promise.resolve(decorate(id, raw));
    }

    return ask(id, { action: 'probe' })
      .then(function (m) { return m.ok ? decorate(id, m.inputs || []) : null; })
      .catch(function () { return null; });
  }

  /* Puts a file in an upload box, directly or by message.

     slot.el is a DOM node that lives in the dashboard iframe's document, but
     this code runs in the shell's. Each frame has its own realm -- its own
     File, DataTransfer and Event constructors -- and instanceof is identity-
     based, not structural: a File built with THIS window's constructor
     still has every property and method a real file has (.name, .size,
     .arrayBuffer(), .text() all work) but fails "x instanceof File" when
     that check runs inside the iframe. Most dashboards never ask; Papa
     Parse's own parser does, as the very first thing it does with whatever
     it is handed -- and coming up empty there is what produced "Cannot read
     properties of null (reading 'stream')": Papa's dispatcher matches
     neither the File branch nor the stream branch, so the variable it was
     about to call .stream() on was never assigned.

     The fix is the standard one for this class of bug: build the object
     with the TARGET realm's own constructors, taken from the iframe's own
     window, not the shell's. */
  function fillInput(slot, blob, name, type) {
    if (slot.el) {
      var iframeWin = slot.el.ownerDocument && slot.el.ownerDocument.defaultView;
      var FileCtor = (iframeWin && iframeWin.File) || File;
      var DTCtor = (iframeWin && iframeWin.DataTransfer) || DataTransfer;
      var EventCtor = (iframeWin && iframeWin.Event) || Event;
      var file = new FileCtor([blob], name, { type: type || blob.type || 'application/octet-stream' });
      var dt = new DTCtor();
      dt.items.add(file);
      slot.el.files = dt.files;
      slot.el.dispatchEvent(new EventCtor('input', { bubbles: true }));
      slot.el.dispatchEvent(new EventCtor('change', { bubbles: true }));
      return Promise.resolve();
    }
    return ask(slot.dashId, { action: 'fill', index: slot.index, blob: blob, name: name, type: type }, 15000)
      .then(function (m) { if (!m.ok) throw new Error(m.error || 'the dashboard refused the file'); });
  }

  /* Fallback pairing when the registry and the dashboard disagree on how many
     upload boxes there are: match on name and hope for the best. The normal
     path is positional — see frameInputs. */
  function matchSpec(liveLabel, declared, i, used) {
    if (!declared.length) return {};
    var lt = w.Library.tokens(liveLabel);
    var best = null, bestScore = 0;
    declared.forEach(function (spec, k) {
      var st = w.Library.tokens(spec.label);
      if (!st.length) return;
      var shared = st.filter(function (t) {
        return lt.some(function (l) { return l === t || l.indexOf(t) >= 0 || t.indexOf(l) >= 0; });
      });
      var sc = shared.length / st.length;
      if (used[k]) sc -= 0.15;          // prefer an unused entry, but allow reuse
      if (sc > bestScore) { bestScore = sc; best = k; }
    });
    if (best !== null && bestScore >= 0.5) { used[best] = 1; return declared[best]; }
    return declared[i] || {};
  }

  /* ---- shared Data Library ---------------------------------------------- */
  /* Everything a dashboard could be offered: the shared library plus every
     section. A register dropped into its own section is still a file the
     dashboards want -- before this it was invisible to the auto-fill, so a
     COGS export filed under COGS had to be picked by hand. Files pinned to
     one dashboard stay out of it; those are deliberately private to it. */
  function libraryFiles() {
    return w.Store.Files.listAll().then(function (rows) {
      return rows.filter(function (r) {
        return r.dashboardId === w.Library.ID || /^ds:/.test(r.dashboardId || '');
      });
    });
  }

  /* Which library files suit a given dashboard. Shared by the match bar
     (always scoped to whichever dashboard is on screen) and the auto-run
     check below (scoped to whichever dashboard just opened, which is not
     necessarily `current` by the time its async lookups resolve). */
  function matchesFor(forDash) {
    // The Data Library dashboard has its own file inputs (browsing a file to
    // add, an inline rename box) -- they read as upload slots to the generic
    // probe below, but they are not upload boxes waiting for the shared
    // library to fill, and this dashboard is where the shared library IS.
    // Without this, opening it could auto-drop one of its own files into its
    // own dropzone the moment it loads.
    if (!forDash || forDash === LIBRARY_DASH_ID) return Promise.resolve(null);
    return frameInputs(forDash).then(function (slots) {
      if (!slots || !slots.length) return null;
      return libraryFiles().then(function (files) {
        if (!files.length) return { slots: slots, pairs: [], files: files, blocked: [], dashId: forDash };
        var auto = slots.filter(function (s) { return s.auto; });
        var safe = files.filter(function (f) { return !isBig(f); });
        var big = files.filter(isBig);
        var pairs = w.Library.assign(safe, auto);
        // A big file that would otherwise have been the best match for a slot
        // nobody else filled — surfaced so the match bar can point at Condense
        // instead of silently leaving the box empty.
        var filledSlots = {};
        pairs.forEach(function (p) { filledSlots[p.slotIndex] = 1; });
        var blocked = [];
        auto.forEach(function (slot, si) {
          if (filledSlots[si]) return;
          var best = null, bestScore = 0;
          big.forEach(function (f) {
            var r = w.Library.score(f, slot);
            if (r.score > bestScore) { bestScore = r.score; best = f; }
          });
          if (best && bestScore >= 30) blocked.push({ slot: slot, file: best });
        });
        return { slots: slots, pairs: pairs, files: files, blocked: blocked, dashId: forDash };
      });
    });
  }
  /* Which library files suit the dashboard that is open right now. */
  function matchesForOpen() { return matchesFor(current); }

  /* Whether the top "Back to Command Centre" bar is allowed to tuck itself
     away as the dashboard is scrolled. Only true once there is nothing left
     needing the user's attention up here -- see refreshMatchBar, the only
     caller. Forcing it back to pinned+visible whenever it isn't true means an
     error never leaves the bar stuck off-screen: the moment something needs
     fixing, both rows are back and stay put. */
  function setChromeLoaded(loaded) {
    var tb = $('.dash-bar');
    if (!tb) return;
    var wasLoaded = tb.classList.contains('autohide');
    tb.classList.toggle('autohide', !!loaded);
    if (!loaded) tb.classList.remove('collapsed');
    // The moment this dashboard first has nothing left needing attention,
    // tuck the bar away right then rather than waiting for a scroll --
    // scrolling up brings it back, scrolling down (or another glance at this
    // once it's already tucked away) hides it again.
    else if (!wasLoaded) tb.classList.add('collapsed');
  }

  function refreshMatchBar() {
    var bar = $('#matchBar');
    if (!bar) return;
    if (!current) { bar.style.display = 'none'; return; }
    matchesForOpen().then(function (m) {
      if (!m || m.dashId !== current) { bar.style.display = 'none'; return; }
      var required = m.slots.filter(function (s) { return s.auto && !s.optional; }).length;
      var nothingToDo = !m.pairs.length && !m.blocked.length;
      var complete = !nothingToDo && m.pairs.length >= required && !m.blocked.length;
      if (nothingToDo || complete) { bar.style.display = 'none'; setChromeLoaded(true); return; }
      // A required box is still unmatched, or something is too large to
      // auto-fill -- that is the one case this bar (and the toolbar above
      // it) must stay put for, so the user can fix it by hand.
      setChromeLoaded(false);
      bar.style.display = 'flex';
      $('#matchText').innerHTML = '<b>' + m.pairs.length + ' of ' + required + '</b> required file' +
        (required === 1 ? '' : 's') + ' matched in the Data Library' +
        (m.blocked.length ? ' — ' + m.blocked.length + ' too large to auto-fill' : '');
      var rows = m.pairs.map(function (p) {
        return '<span>' + esc(p.slot.label) + ' &larr; ' + esc(p.file.name) + '</span>';
      });
      rows = rows.concat(m.blocked.map(function (b) {
        return '<span class="too-big">' + esc(b.slot.label) + ' &larr; ' + esc(b.file.name) +
          ' (' + fmtSize(b.file.size) + ' — condense it first, see ⚡)</span>';
      }));
      $('#matchDetail').innerHTML = rows.join('');
      $('#matchFill').disabled = !m.pairs.length;
    });
  }

  /* Loads each {slot, file} pair's bytes and hands them to fillInput, one at
     a time. Resolves to {done, failed, lastError} — never rejects — so both
     the manual "Fill upload boxes" button and the silent auto-run check
     below can read the outcome without a try/catch of their own. */
  function fillPairs(pairs) {
    return new Promise(function (resolve) {
      var done = 0, failed = 0, lastError = '';
      var next = function (i) {
        if (i >= pairs.length) return resolve({ done: done, failed: failed, lastError: lastError });
        var p = pairs[i];
        w.Store.Files.blob(p.file.id).then(function (blob) {
          if (!blob) { failed++; return setTimeout(function () { next(i + 1); }, 50); }
          return fillInput(p.slot, blob, p.file.name, p.file.type)
            .then(function () { done++; })
            .catch(function (e) { failed++; lastError = e && e.message || String(e); })
            .then(function () { setTimeout(function () { next(i + 1); }, 50); });
        }).catch(function () { failed++; setTimeout(function () { next(i + 1); }, 50); });
      };
      next(0);
    });
  }

  function fillAllFromLibrary() {
    matchesForOpen().then(function (m) {
      if (!m || !m.pairs.length) return toast('Nothing in the Data Library matches this dashboard yet.', 'warn');
      fillPairs(m.pairs).then(function (r) {
        if (r.done) toast('Filled ' + r.done + ' upload box' + (r.done === 1 ? '' : 'es') +
          (r.failed ? ' (' + r.failed + ' failed)' : '') +
          ' — press the dashboard\'s own build button to run it.', r.failed ? 'warn' : 'ok', 6000);
        else toast('Could not fill any upload box' + (r.lastError ? ' — ' + r.lastError : '') + '.', 'err', 8000);
      });
    });
  }

  /* ---- auto-run on open --------------------------------------------------
     If every required upload box has an unambiguous, non-oversized match in
     the Data Library the moment a dashboard's iframe finishes loading, fill
     them and run the dashboard's own build button automatically — no "Fill
     upload boxes" click needed. Anything less than a full, clean match (a
     required slot still empty, or blocked on a file too large to auto-fill)
     is left exactly as before: the match bar stays up and the user fills it
     by hand, since guessing at an incomplete run would be worse than asking. */
  var BUILD_BTN_IDS = ['buildBtn', 'processBtn'];
  function clickBuildButton(id) {
    var doc = frameDoc(id);
    if (!doc) return false;
    for (var i = 0; i < BUILD_BTN_IDS.length; i++) {
      var btn = doc.getElementById(BUILD_BTN_IDS[i]);
      if (btn && !btn.disabled) { btn.click(); return true; }
    }
    // Fallback for a dashboard that names its own button something else:
    // the first non-disabled button in its upload panel that isn't an
    // obvious reset/clear/change-files action.
    var panel = doc.querySelector('.upload-panel, .upload-bar, #uploadPanel');
    if (panel) {
      var candidates = panel.querySelectorAll('button:not([disabled])');
      for (var j = 0; j < candidates.length; j++) {
        var b = candidates[j];
        if (!/reset|clear|change|different/i.test(b.id + ' ' + b.textContent)) { b.click(); return true; }
      }
    }
    return false;
  }
  function tryAutoRun(id) {
    matchesFor(id).then(function (m) {
      if (!m || !m.pairs.length || m.blocked.length) return;
      var required = m.slots.filter(function (s) { return s.auto && !s.optional; }).length;
      if (m.pairs.length < required) return;
      fillPairs(m.pairs).then(function (r) {
        if (!r.done || r.failed) return;
        // fillInput only dispatches the 'change' event -- it does not wait
        // for the dashboard's own handler to finish reading the file, which
        // for a large register (tens of thousands of rows, an .xlsx read
        // via FileReader) can take several seconds. A single click attempt
        // shortly after filling used to fire while the dashboard's own
        // build button was still disabled -- silently doing nothing, with
        // every box showing filled or "Reading..." forever and no retry.
        // Poll instead: cheap per attempt (skips straight past if nothing
        // is ready yet), and 30s covers even a very large workbook.
        var attempts = 0, maxAttempts = 100;
        var tryClick = function () {
          attempts++;
          var clicked = clickBuildButton(id);
          if (clicked) {
            if (current === id) refreshMatchBar();
            var db = byId(id);
            toast('"' + (db ? db.name : id) + '" auto-filled and run from ' + r.done + ' Data Library file' + (r.done === 1 ? '' : 's') + '.', 'ok', 5000);
            return;
          }
          if (attempts >= maxAttempts) {
            var db2 = byId(id);
            toast('Auto-filled ' + r.done + ' upload box' + (r.done === 1 ? '' : 'es') + ' from the Data Library for "' +
              (db2 ? db2.name : id) + '" — it is still reading a large file; press the dashboard\'s own build button once it says everything is loaded.',
              'warn', 8000);
            return;
          }
          setTimeout(tryClick, 300);
        };
        setTimeout(tryClick, 150);
      });
    });
  }

  function acceptsFile(slot, name) {
    if (!slot.accept) return true;
    var ext = '.' + (name.split('.').pop() || '').toLowerCase();
    return slot.accept.toLowerCase().split(',').some(function (a) {
      a = a.trim();
      if (!a) return false;
      if (a.charAt(0) === '.') return a === ext;
      return true;                     // MIME patterns: don't second-guess
    });
  }

  /* Opens the dashboard if it isn't open yet, then hands the file over. */
  function sendToDashboard(fileId, name, type, dashId) {
    var ready = function () {
      frameInputs(dashId).then(function (slots) {
        if (!slots) {
          toast('Could not reach this dashboard. Reload it, or run sync.py to refresh it.', 'warn', 8000);
          return;
        }
        if (!slots.length) { toast('This dashboard has no file upload of its own.', 'warn'); return; }

        var matching = slots.filter(function (s) { return acceptsFile(s, name); });
        var choices = matching.length ? matching : slots;

        w.Store.Files.blob(fileId).then(function (blob) {
          if (!blob) return toast('That file is no longer in the workspace.', 'warn');
          if (choices.length === 1) return deliver(choices[0], blob);
          pickSlot(choices, name, function (slot) { deliver(slot, blob); });
        });

        function deliver(slot, blob) {
          fillInput(slot, blob, name, type).then(function () {
            toast('"' + name + '" loaded into ' + slot.label, 'ok', 4200);
          }).catch(function (e) {
            toast('Could not hand the file over: ' + (e && e.message || e), 'err', 8000);
          });
        }
      });
    };

    if (frames[dashId] && frames[dashId].loaded) {
      if (current !== dashId) openDashboard(dashId);
      ready();
    } else {
      openDashboard(dashId);
      var f = frames[dashId];
      if (!f) return;
      f.el.addEventListener('load', function once() {
        f.el.removeEventListener('load', once);
        setTimeout(ready, 120);
      });
    }
  }

  function pickSlot(slots, name, cb) {
    $('#pickTitle').textContent = 'Where should "' + name + '" go?';
    $('#pickList').innerHTML = slots.map(function (s, i) {
      return '<button class="pick-row" data-slot="' + i + '">' +
        ico('upload', 'sm') + '<span>' + esc(s.label) +
        (s.accept ? '<em>' + esc(s.accept) + '</em>' : '') + '</span></button>';
    }).join('');
    pickSlots = slots; pickCb = cb;
    $('#pickModal').classList.add('open');
  }
  var pickSlots = null, pickCb = null;
  function closePick() { $('#pickModal').classList.remove('open'); pickSlots = null; pickCb = null; }

  /* ===================== dialogs / toasts =============================== */
  var confirmCb = null;
  function confirmDialog(title, body, okLabel, cb) {
    $('#confirmTitle').textContent = title;
    $('#confirmBody').textContent = body;
    $('#confirmOk').textContent = okLabel;
    confirmCb = cb;
    $('#confirmModal').classList.add('open');
    $('#confirmOk').focus();
  }
  function closeConfirm() { $('#confirmModal').classList.remove('open'); confirmCb = null; }

  function toast(msg, kind, ms) {
    var el = d.createElement('div');
    el.className = 'toast ' + (kind || 'ok');
    el.innerHTML = ico(kind === 'err' ? 'warn' : kind === 'warn' ? 'warn' : 'check', 'sm') + '<span>' + esc(msg) + '</span>';
    $('#toasts').appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { el.remove(); }, 260);
    }, ms || 3600);
  }

  /* ===================== wiring ========================================= */
  function wire() {
    w.addEventListener('hashchange', route);

    $('#brand').addEventListener('click', function () { goHome(); });
    $('#backBtn').addEventListener('click', function () { goHome(); });
    $('#themeBtn').addEventListener('click', function () {
      applyTheme(d.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
    });
    $('#resetBtn').addEventListener('click', resetLayout);
    $('#lockBtn').addEventListener('click', function () { w.ParasGate.lock(); });

    $('#modeSwitch').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-mode]'); if (b) switchMode(b.dataset.mode);
    });

    $('#search').addEventListener('input', function (e) {
      filter.text = e.target.value; renderGrid();
    });
    $('#search').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.target.value = ''; filter.text = ''; renderGrid(); e.target.blur(); }
    });

    $('#chips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      filter.category = b.dataset.cat;
      w.Store.setPref('category', filter.category);
      renderChips(); renderGrid();
    });

    $('#crumbs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-go]'); if (!b) return;
      if (b.dataset.go === 'cat') { filter.category = b.dataset.cat; w.Store.setPref('category', filter.category); renderChips(); renderGrid(); }
      goHome();
    });

    $('#grid').addEventListener('click', function (e) {
      var t = e.target.closest('[data-open],[data-hide],[data-files]');
      if (t) {
        if (t.dataset.open) return openDashboard(t.dataset.open);
        if (t.dataset.files) return openDashboard(LIBRARY_DASH_ID);
        if (t.dataset.hide) {
          var h = (w.Store.getPref('hidden', []) || []).slice();
          if (h.indexOf(t.dataset.hide) < 0) h.push(t.dataset.hide);
          w.Store.setPref('hidden', h);
          renderHome();
          var db = byId(t.dataset.hide);
          toast('"' + (db ? db.name : 'Card') + '" hidden — restore it below the grid.', 'ok');
          return;
        }
      }
      var card = e.target.closest('.card');
      if (card && !e.target.closest('button')) {
        var x = byId(card.dataset.id);
        if (x && x.file && x.status !== 'planned') openDashboard(x.id);
      }
    });
    $('#hiddenTray').addEventListener('click', function (e) {
      var b = e.target.closest('[data-restore]'); if (!b) return;
      var h = (w.Store.getPref('hidden', []) || []).filter(function (id) { return id !== b.dataset.restore; });
      w.Store.setPref('hidden', h);
      renderHome();
    });

    /* dashboard toolbar */
    $('#dashFilesBtn').addEventListener('click', function () { openDashboard(LIBRARY_DASH_ID); });
    $('#dashReload').addEventListener('click', function () {
      if (!current) return;
      var f = frames[current]; if (!f) return;
      f.loaded = false;
      $('#frameLoading').style.display = 'flex';
      $('#frameLoadingTxt').textContent = 'Reloading…';
      f.el.src = f.el.src;
    });
    $('#dashTab').addEventListener('click', function () {
      var db = current && byId(current); if (db) w.open(db.file, '_blank', 'noopener');
    });
    $('#dashFull').addEventListener('click', function () {
      var f = current && frames[current];
      if (f && f.el.requestFullscreen) f.el.requestFullscreen();
    });
    $('#dashClose').addEventListener('click', function () { if (current) unloadFrame(current); });

    /* "More" tray -- Open Dashboards / Raise a Request / What's New /
       Pending Requests, collapsed behind one icon. The two plain-action rows
       (raise/what's-new) close this tray the moment they're clicked, since
       whatever they open lives outside it. Open Dashboards and Pending
       Requests are left to close it themselves (they don't -- see the
       .more-pop CSS comment): their own popovers are nested inside this one,
       so closing #morePop first would hide an ancestor of the very popover
       that click was trying to open. */
    $('#moreBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      var p = $('#morePop');
      p.style.display = (p.style.display === 'block') ? 'none' : 'block';
    });
    d.addEventListener('click', function (e) {
      if (!e.target.closest('#moreTray')) $('#morePop').style.display = 'none';
    });
    ['#raiseBtn', '#whatsNewBtn'].forEach(function (sel) {
      var b = $(sel);
      if (b) b.addEventListener('click', function () { $('#morePop').style.display = 'none'; });
    });

    /* live tray popover */
    $('#liveBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      var p = $('#livePop');
      var open = p.style.display === 'block';
      if (!open) renderLivePop();
      p.style.display = open ? 'none' : 'block';
    });
    $('#livePop').addEventListener('click', function (e) {
      var o = e.target.closest('[data-open]'), u = e.target.closest('[data-unload]');
      if (o) { $('#livePop').style.display = 'none'; openDashboard(o.dataset.open); }
      if (u) { unloadFrame(u.dataset.unload); renderLivePop(); }
    });
    d.addEventListener('click', function (e) {
      if (!e.target.closest('#liveTray')) $('#livePop').style.display = 'none';
    });

    /* signed-in-account popover */
    $('#profileBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      var p = $('#profilePop');
      p.style.display = (p.style.display === 'block') ? 'none' : 'block';
    });
    d.addEventListener('click', function (e) {
      if (!e.target.closest('#profileTray')) $('#profilePop').style.display = 'none';
    });
    wirePhoto();

    $('#matchFill').addEventListener('click', fillAllFromLibrary);
    $('#matchOpen').addEventListener('click', function () { openDashboard(LIBRARY_DASH_ID); });

    /* the "where should this go?" picker, shown when a file handed to a
       dashboard (see sendToDashboard) matches more than one of its upload
       boxes -- still needed: it is not part of the removed drawer, and the
       Data Library dashboard's own "send to..." flow ends up here too, via
       the 'requestFill' message relay above calling sendToDashboard. */
    $('#pickList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-slot]'); if (!b || !pickSlots) return;
      var slot = pickSlots[+b.dataset.slot], cb = pickCb;
      closePick();
      if (cb) cb(slot);
    });
    $('#pickCancel').addEventListener('click', closePick);
    $('#pickModal').addEventListener('click', function (e) { if (e.target === e.currentTarget) closePick(); });

    $('#confirmCancel').addEventListener('click', closeConfirm);
    $('#confirmOk').addEventListener('click', function () { var cb = confirmCb; closeConfirm(); if (cb) cb(); });
    $('#confirmModal').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeConfirm(); });

    /* shortcuts */
    d.addEventListener('keydown', function (e) {
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ''));
      if (e.key === 'Escape') {
        if ($('#pickModal').classList.contains('open')) return closePick();
        if ($('#confirmModal').classList.contains('open')) return closeConfirm();
        if (w.ParasFeedback && w.ParasFeedback.closeIfOpen()) return;
        if (w.ParasTwoFactor && w.ParasTwoFactor.closeIfOpen()) return;
        if (w.ParasChangelog && w.ParasChangelog.closeIfOpen()) return;
        if (current) return goHome();
      }
      if (typing) return;
      if (e.key === '/') { e.preventDefault(); if (current) goHome(); $('#search').focus(); }
      if (e.key.toLowerCase() === 'h' && !e.metaKey && !e.ctrlKey) goHome();
    });

    /* block accidental navigation when a file is dropped anywhere on the hub
       shell itself -- every file now goes through the Data Library
       dashboard's own dropzone, in its own iframe, which is a different
       browsing context this listener never sees; this only guards the shell
       page around it. */
    ['dragover', 'drop'].forEach(function (n) {
      w.addEventListener(n, function (e) { if (hasFiles(e)) e.preventDefault(); });
    });
  }

  /* The Command Centre only starts once the sign-in gate grants access, so a
     locked page never loads a dashboard or touches the file store. */
  function start() {
    if (w.ParasGate) w.ParasGate.guard(boot);
    else boot();
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', start);
  else start();
})(window, document);
