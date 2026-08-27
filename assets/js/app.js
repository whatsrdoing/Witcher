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
  var current = null;                 // active dashboard id, null = home
  var DEV_CAT = '__dev';            // pseudo-category: everything not live yet
  var filter = { text: '', category: 'all' };
  var drawerFor = null;      // which dashboard the drawer is showing
  var drawerTab = 'library';  // 'library' (shared) or 'pinned' (this dashboard)
  var renaming = null;

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
      REG = reg;

      var mode = w.Store.readStoredMode(reg.app.defaultMode);
      w.Store.setMode(mode);
      frames = framesByMode[mode] || framesByMode.local;
      w.Store.loadPrefs();

      applyTheme(w.Store.getPref('theme', reg.app.defaultTheme));
      filter.category = w.Store.getPref('category', 'all');

      paintChrome();
      wire();

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
      ['Paras ID', who.parasId],
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
      invalidateFiles();
      refreshCounts().then(renderHome);
      goHome();
      renderLiveCount();
      if (drawerFor) renderFiles();
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
    $$('.frames iframe').forEach(function (f) { f.classList.remove('active'); });
    $('#frameLoading').style.display = 'none';
    $('#matchBar').style.display = 'none';
    $('.dash-bar').classList.remove('collapsed');
    renderCrumbs();
    renderLiveCount();
    if (!silent) location.hash = '#/';
    else if (!location.hash || location.hash === '#') history.replaceState(null, '', '#/');
  }

  function openDashboard(id, silent) {
    var db = byId(id);
    if (!db) return goHome();
    if (!db.file) { toast('"' + db.name + '" is registered but has no HTML file yet.', 'warn'); return; }

    current = id;
    $('#viewHome').classList.remove('active');
    $('#viewDash').classList.add('active');
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
    $('#dashFilesBtn').innerHTML = ico('folder') + '<span>Files</span>' +
      (fileCounts[id] ? '<span class="badge open">' + fileCounts[id] + '</span>' : '');

    renderCrumbs(db);
    renderLiveCount();
    refreshMatchBar();
    if (!silent) location.hash = '#/d/' + encodeURIComponent(id);
    if (drawerFor) openDrawer(id);
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
    // Every mutation (add, delete, condense) funnels through here, so this is
    // the one place the cached file list has to be dropped.
    invalidateFiles();
    return w.Store.Files.counts().then(function (c) { fileCounts = c || {}; return c; });
  }

  function openDrawer(id, tab) {
    drawerFor = id || null;
    drawerTab = tab || (id ? drawerTab : 'library');
    if (!drawerFor) drawerTab = 'library';
    $('#drawer').classList.add('open');
    $('#scrim').classList.add('open');
    $('#fileSearchInput').value = '';
    renderDrawerHead();
    renderFiles();
    // renderDrawerHead() just painted every box from whatever dbSummary held
    // at that instant -- null on the first open of a session, since the
    // fetch below has not resolved yet. Every box read "nothing stored yet"
    // until something else repainted them (clicking a box, which happens to
    // trigger the same render for an unrelated reason). Repainting here once
    // the real numbers are in is what makes a fresh open show them without
    // needing a click first.
    loadDbSummary().then(function () {
      renderSectionPicker();
      renderSectionMonths();
    });
  }

  /* One drop box per kind of register. Dropping straight onto the right box
     is what decides where a file is filed, so there is no way to attach a
     file and then discover it went somewhere else. Clicking a box shows just
     that section's files; clicking it again shows everything.

     A register that arrives split across several files for one month -- COGS
     as department consumption, IP pharmacy and OP pharmacy -- gets a box per
     piece. They all file into the same COGS data; the part only decides
     which piece a re-upload replaces. */
  function partsOf(dsId) {
    var d = sectionById(dsId);
    return (d && d.parts && d.parts.length) ? d.parts : null;
  }
  function partName(dsId, partId) {
    var ps = partsOf(dsId) || [];
    for (var i = 0; i < ps.length; i++) if (ps[i].id === partId) return ps[i].name;
    return '';
  }

  function renderSectionPicker() {
    var host = $('#sectionGrid');
    if (!host) return;
    var list = (REG && REG.datasets) || [];
    if (!list.length) { host.style.display = 'none'; return; }
    host.style.display = 'grid';

    var html = [];
    list.forEach(function (d) {
      var st = storedFor(d.id);
      var parts = (d.parts && d.parts.length) ? d.parts : null;

      if (!parts) {
        var sub = st && st.periods.length
          ? st.periods.length + (st.periods.length === 1 ? ' month · ' : ' months · ') + st.rows.toLocaleString() + ' rows'
          : 'nothing stored yet';
        html.push('<button class="sec-box' + (section === d.id && !sectionPart ? ' on' : '') +
          '" data-sec="' + esc(d.id) + '" data-part=""' +
          ' title="' + esc(d.hint || d.name) + '">' +
          '<span class="sec-name">' + esc(d.name) + '</span>' +
          '<span class="sec-sub">' + esc(sub) + '</span>' +
          '</button>');
        return;
      }

      parts.forEach(function (pt) {
        // How much of this part is stored, across every month.
        var months = 0, rows = 0;
        ((st && st.periods) || []).forEach(function (per) {
          (per.parts || []).forEach(function (pp) {
            if (pp.part === pt.id) { months++; rows += pp.rows || 0; }
          });
        });
        var psub = months
          ? months + (months === 1 ? ' month · ' : ' months · ') + rows.toLocaleString() + ' rows'
          : 'nothing stored yet';
        html.push('<button class="sec-box part' + (section === d.id && sectionPart === pt.id ? ' on' : '') +
          '" data-sec="' + esc(d.id) + '" data-part="' + esc(pt.id) + '"' +
          ' title="' + esc(d.name + ' — ' + pt.name) + '">' +
          '<span class="sec-name">' + esc(pt.name) + '</span>' +
          '<span class="sec-sub"><em>' + esc(d.name) + '</em> · ' + esc(psub) + '</span>' +
          '</button>');
      });
    });
    host.innerHTML = html.join('');
    wireSectionDrops();
  }

  function wireSectionDrops() {
    $$('#sectionGrid .sec-box').forEach(function (box) {
      box.addEventListener('click', function () {
        // Clicking the box already selected clears it, which is how you get
        // back to seeing every file now that there is no catch-all box.
        var same = box.dataset.sec === section && (box.dataset.part || '') === sectionPart;
        if (same) chooseSection('', '');
        else chooseSection(box.dataset.sec, box.dataset.part || '');
      });
      ['dragenter', 'dragover'].forEach(function (n) {
        box.addEventListener(n, function (e) {
          if (!hasFiles(e)) return;
          e.preventDefault(); e.stopPropagation();
          box.classList.add('hot');
        });
      });
      ['dragleave', 'dragend'].forEach(function (n) {
        box.addEventListener(n, function () { box.classList.remove('hot'); });
      });
      box.addEventListener('drop', function (e) {
        if (!hasFiles(e)) return;
        e.preventDefault(); e.stopPropagation();
        box.classList.remove('hot');
        chooseSection(box.dataset.sec, box.dataset.part || '');
        addFiles(drawerScope(), e.dataTransfer.files);
      });
    });
  }

  function chooseSection(id, part) {
    section = id || '';
    sectionPart = section ? (part || '') : '';
    invalidateFiles();
    renderDrawerHead(); renderSectionMonths(); renderFiles();
  }

  function renderDrawerHead() {
    var db = drawerFor ? byId(drawerFor) : null;
    renderSectionPicker();
    $('#drawerTabs').style.display = db ? 'flex' : 'none';
    $('#tabPinned').textContent = db ? db.name : '';
    $$('#drawerTabs button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.tab === drawerTab));
    });
    var lib = drawerTab === 'library';
    var sec = lib && section ? sectionById(section) : null;
    var pn = sec && sectionPart ? partName(section, sectionPart) : '';
    $('#sectionGrid').style.display = lib ? 'grid' : 'none';
    $('#drawerTitle').textContent = !lib ? 'Pinned files'
      : (sec ? (pn ? sec.name + ' — ' + pn : sec.name) : 'All files');
    $('#drawerFor').textContent = !lib
      ? 'Only on ' + (db ? db.name : 'this dashboard')
      : (sec ? (pn ? 'One of the ' + sec.name + ' files for a month' : (sec.hint || 'Filed by month into the database'))
             : 'Everything attached so far — choose a section above to file a new file');
    $('#dropHint').textContent = !lib
      ? 'SOPs and notes that belong to this dashboard only'
      : (sec ? 'Name it with the month, e.g. "2026-07 ' + (pn || sec.name) + '.csv"'
             : 'Choose a section above first, so it can be filed into the database');
    $('#drawerTip').style.display = 'none';
    if (lib && drawerFor) {
      frameInputs(drawerFor).then(function (slots) {
        if (slots && slots.length && drawerTab === 'library') $('#drawerTip').style.display = 'flex';
      });
    }
  }

  /* ---- Data Library sections --------------------------------------------
     A section is a kind of register (COGS, GRN Register, ...). Files dropped
     into one are kept apart from the others, and their contents are filed
     into that section's own table in the database, month by month, so July
     and August of the same register stack up instead of overwriting. */
  var section = '';                 // '' = show everything, otherwise a dataset id
  var sectionPart = '';             // which piece of a split register (COGS) is selected
  function sectionScope(id) { return 'ds:' + id; }
  function drawerScope() {
    if (drawerTab !== 'library') return drawerFor;
    return section ? sectionScope(section) : ALL_FILES;
  }
  function sectionById(id) {
    var list = (REG && REG.datasets) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* The month a file is for, guessed from its name. Always shown for
     confirmation rather than acted on: a wrong guess would file August's
     figures under July, and nothing downstream would look wrong. */
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function guessPeriod(name) {
    var s = String(name || '');
    var m = /(20\d{2})[-_ ]?(0[1-9]|1[0-2])(?!\d)/.exec(s);          // 2026-07
    if (m) return m[1] + '-' + m[2];
    m = /(0[1-9]|1[0-2])[-_ ]?(20\d{2})(?!\d)/.exec(s);              // 07-2026
    if (m) return m[2] + '-' + m[1];
    m = /([a-z]{3,9})[-_ ]?(20\d{2}|\d{2})(?!\d)/i.exec(s);          // JULY26, Jul-2026
    if (m) {
      var mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
      if (mo) {
        var y = m[2].length === 2 ? '20' + m[2] : m[2];
        return y + '-' + (mo < 10 ? '0' : '') + mo;
      }
    }
    return '';
  }

  /* The one or two upload boxes this file genuinely belongs in. Deliberately
     strict: a chip that appears everywhere tells you nothing.

     Memoised per file: the answer depends only on the file's name, headers
     and the registry, none of which change while the drawer is open, and it
     costs a scoring pass over every upload box of every dashboard. */
  var usedByCache = Object.create(null);
  function usedBy(file) {
    var ck = file.id + '' + file.name;
    if (usedByCache[ck]) return usedByCache[ck];
    var scored = [];
    REG.dashboards.forEach(function (db) {
      (db.inputs || []).forEach(function (slot) {
        var r = w.Library.score(file, slot);
        if (r.score >= 70) scored.push({ id: db.id, name: db.name, slot: slot.label, score: r.score });
      });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    var seen = {}, out = [];
    scored.forEach(function (x) {
      if (seen[x.slot]) return;
      seen[x.slot] = 1;
      out.push(x);
    });
    out = out.slice(0, 3);
    usedByCache[ck] = out;
    return out;
  }
  function closeDrawer() {
    drawerFor = null; renaming = null;
    $('#drawer').classList.remove('open');
    $('#scrim').classList.remove('open');
  }

  function kindOf(name, type) {
    var e = (name.split('.').pop() || '').toLowerCase();
    if (e === 'pdf') return 'pdf';
    if (['xlsx', 'xls', 'xlsm', 'ods'].indexOf(e) >= 0) return 'xls';
    if (['doc', 'docx', 'odt', 'rtf'].indexOf(e) >= 0) return 'doc';
    if (['csv', 'tsv'].indexOf(e) >= 0) return 'csv';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].indexOf(e) >= 0) return 'img';
    if (['zip', '7z', 'rar', 'tar', 'gz'].indexOf(e) >= 0) return 'zip';
    if (/^image\//.test(type || '')) return 'img';
    return e.slice(0, 4) || 'file';
  }
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

  /* The file list is fetched once per scope and then filtered in memory.
     It used to be re-fetched on every keystroke in the search box: with the
     library stored on disk that is a round trip to serve.py per character,
     each one re-reading the whole index and re-scoring every row against
     every dashboard, to narrow a list already sitting in the page. */
  var fileCache = { scope: null, rows: null };
  function invalidateFiles() { fileCache.scope = null; fileCache.rows = null; }

  var ALL_FILES = '\u0000all';    // not a real scope; means "do not filter"

  function loadFiles(scope) {
    if (fileCache.scope === scope && fileCache.rows) return Promise.resolve(fileCache.rows);
    // No section chosen: show everything in the library, including anything
    // filed before the sections existed. Without this, removing the catch-all
    // box would have left those files with nowhere to be seen.
    var got = scope === ALL_FILES ? libraryFiles() : w.Store.Files.list(scope);
    return got.then(function (rows) {
      rows = rows.slice().sort(function (a, b) { return b.addedAt - a.addedAt; });
      fileCache.scope = scope; fileCache.rows = rows;
      return rows;
    });
  }

  function renderFiles() {
    if (!$('#drawer').classList.contains('open')) return;
    var scope = drawerScope();
    if (!scope) return;
    var q = ($('#fileSearchInput').value || '').trim().toLowerCase();
    loadFiles(scope).then(function (rows) {
      var shown = q ? rows.filter(function (r) { return r.name.toLowerCase().indexOf(q) >= 0; }) : rows;
      var host = $('#fileList');
      if (!shown.length) {
        // A section can hold database rows with no file currently attached
        // -- the two are independent by design: once a register is read
        // into the database it does not need to stay around, and a file
        // can be deleted, replaced, or simply never re-attached after an
        // import. Left unexplained, "no files attached" next to "1 month,
        // 18,656 rows" reads as a contradiction rather than as the normal
        // state it is.
        var d0 = (!q && section) ? storedFor(section) : null;
        var hasDbRows = d0 && d0.periods.length &&
          (!sectionPart || d0.periods.some(function (p) {
            return (p.parts || []).some(function (pp) { return pp.part === sectionPart; });
          }));
        host.innerHTML = '<div class="empty-state" style="padding:34px 8px">' + ico('inbox', 'lg') +
          '<h3>' + (q ? 'Nothing matches' : 'No files attached') + '</h3>' +
          '<p>' + (q ? 'Try a different search.' : (hasDbRows
            ? 'That is normal here: the data above is already in the database and does not need its source file to stay attached. Drop a file to add another month, or to replace one.'
            : (drawerTab === 'library'
              ? 'Drop your registers here once. The Command Centre reads each file\'s columns and offers it to every dashboard that needs it.'
              : 'Files pinned here stay with this dashboard only.'))) + '</p></div>';
      } else {
        host.innerHTML = shown.map(function (r) {
          var k = kindOf(r.name, r.type);
          var isRen = renaming === r.id;
          return '<div class="file-row" data-fid="' + esc(r.id) + '" data-ftype="' + esc(r.type || '') + '" data-fsize="' + esc(r.size || 0) + '">' +
            '<div class="file-ico ' + esc(k) + '">' + esc(k.toUpperCase()) + '</div>' +
            '<div class="file-meta">' +
              (isRen
                ? '<input class="file-name-input" value="' + esc(r.name) + '" data-rename-input="' + esc(r.id) + '">'
                : '<div class="file-name" title="' + esc(r.name) + '">' + esc(r.name) + '</div>') +
              '<div class="file-sub">' + esc(fmtSize(r.size)) + ' · ' + esc(fmtDate(r.addedAt)) +
                (r.headers && r.headers.length ? ' · ' + r.headers.length + ' columns' : '') + '</div>' +
              (drawerTab === 'library' ? usedByHtml(r) : '') +
              (isBig(r) ? '<div class="file-warn">' + esc(fmtSize(r.size)) +
                ' — too large to open directly. Condense it first (⚡).</div>' : '') +
            '</div>' +
            '<div class="file-acts">' +
              (isBig(r) ? '<button class="cond" data-fcond="' + esc(r.id) + '" title="Too large for a browser — condense it">' + ico('bolt', 'sm') + '</button>' : '') +
              '<button class="use" data-fuse="' + esc(r.id) + '" title="Load into this dashboard\'s upload box">' + ico('upload', 'sm') + '</button>' +
              '<button data-fopen="' + esc(r.id) + '" title="Open">' + ico('eye', 'sm') + '</button>' +
              '<button data-fdl="' + esc(r.id) + '" title="Download">' + ico('download', 'sm') + '</button>' +
              '<button data-fren="' + esc(r.id) + '" title="Rename">' + ico('pencil', 'sm') + '</button>' +
              '<button class="del" data-fdel="' + esc(r.id) + '" title="Delete">' + ico('trash', 'sm') + '</button>' +
            '</div>' +
          '</div>';
        }).join('');
        var inp = $('[data-rename-input]', host);
        if (inp) { inp.focus(); inp.select(); }
      }
      $('#fileTally').textContent = rows.length + (rows.length === 1 ? ' file' : ' files') +
        (rows.length ? ' · ' + fmtSize(rows.reduce(function (n, r) { return n + (r.size || 0); }, 0)) : '');
      $('#filePersist').innerHTML = w.Store.Files.persistent()
        ? ico('lock', 'sm') + 'Saved on this computer'
        : ico('bolt', 'sm') + 'Temporary (this tab only)';
    });
  }

  /* ---- condensing an oversized export ------------------------------------
     A quarter-gigabyte CSV cannot be opened in a browser tab: the dashboard
     reads the whole file, then the spreadsheet parser turns it into millions
     of cell objects. Rather than change the dashboards, shrink the file first
     — stream it, keep the columns that dashboard actually reads, and add up
     rows that agree on every one of them. Totals come out identical. */
  /* The blob is fetched once and kept while the modal is open. Profiling the
     columns and then condensing used to fetch it twice, which on the register
     this feature exists for (a ~300MB CSV) meant pulling the whole file over
     twice to read a few hundred rows and then stream it. Released on close. */
  var condenseFile = null, condenseCols = null, condenseBlob = null;

  function openCondense(fileMeta) {
    condenseFile = fileMeta;
    $('#condTitle').textContent = 'Condense "' + fileMeta.name + '"';
    $('#condCols').innerHTML = '<div class="cond-loading"><span class="spinner"></span>Reading the columns…</div>';
    $('#condStats').textContent = fmtSize(fileMeta.size) + ' — too large for a browser tab to open directly.';
    $('#condRun').disabled = true;
    $('#condModal').classList.add('open');

    w.Store.Files.blob(fileMeta.id).then(function (blob) {
      if (!blob) throw new Error('that file is no longer in the workspace');
      condenseBlob = blob;
      return w.Library.profile(blob, 400);
    }).then(function (cols) {
      condenseCols = cols;
      var suggested = suggestedKeep(fileMeta);
      $('#condCols').innerHTML = cols.map(function (c, i) {
        var on = !suggested || suggested.some(function (k) {
          return w.Library.tokens(k).join(' ') === w.Library.tokens(c.name).join(' ');
        });
        return '<label class="cond-col' + (c.numeric ? ' num' : '') + '">' +
          '<input type="checkbox" data-col="' + i + '"' + (on ? ' checked' : '') + '>' +
          '<span class="cond-name">' + esc(c.name) + '</span>' +
          '<span class="cond-tag">' + (c.numeric ? 'Σ added up' : 'grouped') + '</span>' +
          '</label>';
      }).join('');
      $('#condRun').disabled = false;
      $('#condStats').textContent = fmtSize(fileMeta.size) + ' · ' + cols.length +
        ' columns. Ticked columns are kept; number columns are added up.';
    }).catch(function (e) {
      $('#condCols').innerHTML = '<div class="cond-loading">Could not read the columns: ' +
        esc(e && e.message || e) + '</div>';
    });
  }

  /* Pre-tick exactly the columns the dashboard this file suits actually reads. */
  function suggestedKeep(fileMeta) {
    var best = null, bestScore = 0;
    REG.dashboards.forEach(function (db) {
      (db.inputs || []).forEach(function (slot) {
        if (!slot.keep || !slot.keep.length) return;
        var r = w.Library.score(fileMeta, slot);
        if (r.score > bestScore) { bestScore = r.score; best = slot.keep; }
      });
    });
    return bestScore >= 60 ? best : null;
  }

  function closeCondense() {
    $('#condModal').classList.remove('open');
    condenseFile = null; condenseCols = null; condenseBlob = null;
  }

  function runCondense() {
    if (!condenseFile || !condenseCols) return;
    var picked = $$('#condCols input[type=checkbox]').filter(function (b) { return b.checked; })
      .map(function (b) { return condenseCols[+b.dataset.col]; });
    if (!picked.length) return toast('Tick at least one column.', 'warn');

    var keys = picked.filter(function (c) { return !c.numeric; }).map(function (c) { return c.name; });
    var sums = picked.filter(function (c) { return c.numeric; }).map(function (c) { return c.name; });
    var meta = condenseFile;

    $('#condRun').classList.add('working');
    $('#condRun').disabled = true;
    $('#condStats').textContent = 'Reading… this runs in the background and never loads the whole file.';

    var haveBlob = condenseBlob
      ? Promise.resolve(condenseBlob)
      : w.Store.Files.blob(meta.id);
    haveBlob.then(function (blob) {
      if (!blob) throw new Error('that file is no longer in the workspace');
      return w.Library.condense(blob, {
        keys: keys, sums: sums,
        onProgress: function (p) {
          $('#condStats').textContent = p.read.toLocaleString() + ' rows read · ' +
            p.kept.toLocaleString() + ' combined rows so far';
        }
      });
    }).then(function (out) {
      var name = meta.name.replace(/\.[^.]+$/, '') + ' (condensed).csv';
      var file = new File([out.blob], name, { type: 'text/csv' });
      // Filed into whatever section is currently open, not always the
      // generic library. Condensing a file while looking at a specific
      // section (COGS -- IP Pharmacy, say) and having the result land
      // somewhere else meant it was invisible right where it was made --
      // ALL_FILES is the "show everything, don't file into it" marker, so
      // that alone falls back to the real generic scope.
      var fileScope = (drawerScope() === ALL_FILES) ? w.Library.ID : drawerScope();
      return w.Library.sniff(file).then(function (headers) {
        return w.Store.Files.add(fileScope, file, headers);
      }).then(function () {
        $('#condRun').classList.remove('working');
        $('#condRun').disabled = false;
        closeCondense();
        invalidateFiles();
        return refreshCounts().then(function () {
          renderStats(); renderGrid(); renderFiles(); refreshMatchBar();
          renderSectionPicker(); renderSectionMonths();
          toast(out.rowsIn.toLocaleString() + ' rows became ' + out.rowsOut.toLocaleString() +
            ' — ' + fmtSize(meta.size) + ' down to ' + fmtSize(out.blob.size) +
            '. Totals are unchanged.', 'ok', 9000);
        });
      });
    }).catch(function (e) {
      $('#condRun').classList.remove('working');
      $('#condRun').disabled = false;
      $('#condStats').textContent = '';
      toast('Could not condense: ' + (e && e.message || e), 'err', 11000);
    });
  }

  function isBig(r) {
    return r.size > w.Library.BIG_FILE && /\.(csv|tsv|txt)$/i.test(r.name);
  }

  function usedByHtml(file) {
    var uses = usedBy(file);
    if (!uses.length) return '<div class="file-uses none">No dashboard matched — send it by hand with ↑</div>';
    return '<div class="file-uses">' + uses.map(function (u) {
      return '<span title="' + esc(u.name) + ' · ' + esc(u.slot) + '">' + esc(u.slot) + '</span>';
    }).join('') + '</div>';
  }

  /* ---- filing a dropped file into the database -------------------------- */
  var dbSummary = null;                       // what the database holds, by section
  function loadDbSummary() {
    if (!w.Store.Files.onDisk()) return Promise.resolve(null);
    // Called right after boot -- a 401 here can be this request racing the
    // just-set session cookie rather than a real expiry, so give it one
    // forgiving retry (see storage.js's libFetch/checkPersistence) before
    // concluding the session is actually gone.
    var attempt = function (retryOn401) {
      return fetch('__data', { cache: 'no-store' })
        .then(function (r) {
          if (r.status === 401 && retryOn401) {
            return new Promise(function (res) { setTimeout(res, 300); })
              .then(function () { return attempt(false); });
          }
          if (r.status === 401 && w.ParasGate) w.ParasGate.lock();
          return r.ok ? r.json() : null;
        });
    };
    return attempt(true)
      .then(function (j) { dbSummary = (j && j.datasets) || []; return dbSummary; })
      .catch(function () { return null; });
  }
  function storedFor(id) {
    return (dbSummary || []).filter(function (d) { return d.dataset === id; })[0] || null;
  }

  function renderSectionMonths() {
    var box = $('#sectionMonths');
    if (!box) return;
    if (!section || drawerTab !== 'library') { box.style.display = 'none'; return; }
    var d = storedFor(section);
    box.style.display = 'block';
    if (!d || !d.periods.length) {
      box.innerHTML = '<span class="sm-empty">Nothing in the database for this section yet.</span>';
      return;
    }
    // With a part selected, report that part alone: "3 months" ought to mean
    // three months of IP pharmacy, not three months of COGS as a whole.
    var pills = [], total = 0;
    d.periods.forEach(function (p) {
      if (sectionPart) {
        var mine = (p.parts || []).filter(function (pp) { return pp.part === sectionPart; })[0];
        if (!mine) return;
        total += mine.rows;
        pills.push({ period: p.period, rows: mine.rows, source: mine.source });
      } else {
        total += p.rows;
        var made = (p.parts || []).filter(function (pp) { return pp.part; });
        pills.push({ period: p.period, rows: p.rows,
                     source: made.length > 1
                       ? made.length + ' files: ' + made.map(function (pp) {
                           return partName(section, pp.part) || pp.part;
                         }).join(', ')
                       : p.source });
      }
    });
    if (!pills.length) {
      box.innerHTML = '<span class="sm-empty">Nothing in the database for this section yet.</span>';
      return;
    }
    box.innerHTML = '<span class="sm-head">' + total.toLocaleString() + ' rows stored</span>' +
      pills.map(function (p) {
        return '<span class="sm-pill" title="' + esc(p.source) + ' · ' + p.rows.toLocaleString() + ' rows">' +
          esc(p.period) + '<b>' + p.rows.toLocaleString() + '</b></span>';
      }).join('');
  }

  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];
  var pendingImport = null;
  var pendingBook = null;      // the opened workbook, when the file is a spreadsheet

  /* Does this file look like the kind of register this section holds?
     Compared on the header row, not the file name, because a renamed file
     still has the columns it always had. */
  function sectionFit(ds, headers) {
    var d = sectionById(ds);
    var needs = (d && d.needs) || [];
    if (!needs.length || !headers || !headers.length) return null;   // nothing to judge on
    var hit = needs.filter(function (n) {
      var nn = String(n).toLowerCase().replace(/[^a-z0-9]+/g, '');
      return headers.some(function (h) {
        var hh = String(h).toLowerCase().replace(/[^a-z0-9]+/g, '');
        return hh === nn || hh.indexOf(nn) >= 0 || nn.indexOf(hh) >= 0;
      });
    });
    return { hit: hit.length, need: needs.length, missing: needs.filter(function (n) {
      return hit.indexOf(n) < 0; }) };
  }

  /* The section a file's columns actually look like, when it is not the one
     it was dropped on -- so the warning can say where it probably belongs. */
  function bestSection(headers) {
    var best = null;
    ((REG && REG.datasets) || []).forEach(function (d) {
      var f = sectionFit(d.id, headers);
      if (!f || !f.need) return;
      var r = f.hit / f.need;
      if (r >= 0.6 && (!best || r > best.ratio)) best = { id: d.id, name: d.name, ratio: r };
    });
    return best;
  }

  /* ---- spreadsheets ------------------------------------------------------
     The database reads CSV. Registers arrive as often as not as .xlsx, and
     until now those attached fine and then silently never reached the
     database -- the section just kept saying "nothing stored yet" with no
     hint why.

     Converting happens here rather than in serve.py because SheetJS is
     already vendored for the dashboards and handles .xls, .xlsx and .ods
     alike; the equivalent in Python would be a new dependency for the modern
     format and would still not read the old binary one. */
  var SHEET_EXT = /\.(xlsx|xlsm|xlsb|xls|ods)$/i;

  /* Read a workbook and hand back its sheet names plus a converter, so the
     caller can ask which sheet before paying to convert one.

     A register can run past 100,000 rows, and both XLSX.read() and
     sheet_to_csv() are synchronous CPU work -- on the main thread that is a
     multi-second freeze with nothing to show for it but a stuck tab. Done in
     xlsx-worker.js instead, the tab stays responsive throughout.

     A Worker can only load over http(s): opened as a plain file://, the
     browser refuses the worker script as cross-origin from a "null" origin,
     and that failure happens synchronously in the constructor -- so trying
     the worker first and falling back to the old direct-on-this-thread path
     when construction throws is a reliable fallback, not a guess. */
  function readWorkbook(blob) {
    return blob.arrayBuffer().then(function (buf) {
      try {
        return readWorkbookInWorker(buf);
      } catch (e) {
        return readWorkbookHere(buf);
      }
    });
  }

  function readWorkbookInWorker(buf) {
    return new Promise(function (resolve, reject) {
      var worker = new Worker('assets/js/xlsx-worker.js');   // throws under file://
      var settled = false;
      function fail(msg) {
        if (settled) return;
        settled = true;
        worker.terminate();
        reject(new Error(msg));
      }
      worker.onerror = function (e) {
        e.preventDefault && e.preventDefault();
        fail((e && e.message) || 'could not read that spreadsheet');
      };
      worker.onmessage = function (e) {
        var msg = e.data || {};
        if (msg.type === 'names') {
          if (settled) return;
          settled = true;
          resolve({
            names: msg.names,
            toCsv: function (name) {
              return new Promise(function (res2, rej2) {
                var mh = function (e2) {
                  var m2 = e2.data || {};
                  if (m2.type === 'csv' && m2.name === name) {
                    worker.removeEventListener('message', mh);
                    worker.terminate();
                    res2(m2.csv);
                  } else if (m2.type === 'error') {
                    worker.removeEventListener('message', mh);
                    worker.terminate();
                    rej2(new Error(m2.message));
                  }
                };
                worker.addEventListener('message', mh);
                worker.postMessage({ type: 'sheet', name: name });
              });
            }
          });
        } else if (msg.type === 'error') {
          fail(msg.message);
        }
      };
      // The buffer is transferred, not copied: for a large file that is the
      // difference between an instant handoff and duplicating tens of MB.
      // buf is unusable in this thread after this call, which is fine --
      // nothing here reads it again.
      worker.postMessage({ type: 'open', bytes: buf }, [buf]);
    });
  }

  /* The original synchronous path. Kept as the fallback for file://, and
     good enough there: someone opening the app by double-clicking
     index.html is trading the disk-backed database and multi-user sign-in
     for convenience already, and a slower spreadsheet read on top of that
     is a fair continuation of the same trade, clearly explained rather than
     silently eaten. */
  function readWorkbookHere(buf) {
    return w.Library.loadXLSX().then(function (XLSX) {
      var wb = XLSX.read(new Uint8Array(buf), { type: 'array', dense: true, cellDates: true });
      var names = (wb.SheetNames || []).filter(function (n) {
        var ws = wb.Sheets[n];
        return ws && (ws['!ref'] || (ws.length || 0) > 0);
      });
      return {
        names: names.length ? names : (wb.SheetNames || []),
        toCsv: function (name) {
          var ws = wb.Sheets[name];
          if (!ws) return Promise.reject(new Error('sheet "' + name + '" is not in that file'));
          return Promise.resolve(
            XLSX.utils.sheet_to_csv(ws, { dateNF: 'dd-mmm-yyyy', blankrows: false }));
        }
      };
    });
  }

  /* Work through everything just dropped, one prompt at a time. Only the
     first file used to be offered, so dropping three months at once quietly
     filed one -- the same class of silence as the spreadsheet problem. */
  var importQueue = [];

  function offerImports(added) {
    var can = [], cannot = [];
    (added || []).forEach(function (m) {
      if (!m || !m.name) return;
      if (/\.(csv|tsv|txt)$/i.test(m.name) || SHEET_EXT.test(m.name)) can.push(m);
      else cannot.push(m.name);
    });
    if (cannot.length) {
      // Never silent: a file that cannot reach the database has to say so.
      toast(cannot.length === 1
        ? '"' + cannot[0] + '" was attached, but only spreadsheets and CSV files can go into the database.'
        : cannot.length + ' files were attached but cannot go into the database — only spreadsheets and CSV files can.',
        'warn', 9000);
    }
    importQueue = can.slice(1);
    if (can.length) askImport(can[0]);
  }

  function nextImport() {
    var nxt = importQueue.shift();
    if (nxt) setTimeout(function () { askImport(nxt); }, 250);
  }

  function askImport(fileMeta) {
    pendingImport = fileMeta;
    $('#importSection').innerHTML = ((REG && REG.datasets) || []).map(function (d) {
      return '<option value="' + esc(d.id) + '"' + (d.id === section ? ' selected' : '') + '>' + esc(d.name) + '</option>';
    }).join('');

    var now = new Date(), yNow = now.getFullYear();
    var g = guessPeriod(fileMeta.name);
    var gy = g ? +g.slice(0, 4) : yNow;
    var gm = g ? +g.slice(5, 7) : now.getMonth() + 1;
    $('#importMonth').innerHTML = MONTH_NAMES.map(function (n, i) {
      return '<option value="' + (i + 1) + '"' + (i + 1 === gm ? ' selected' : '') + '>' + n + '</option>';
    }).join('');
    var years = [];
    for (var y = yNow + 1; y >= yNow - 6; y--) years.push(y);
    if (years.indexOf(gy) < 0) years.unshift(gy);
    $('#importYear').innerHTML = years.map(function (y) {
      return '<option value="' + y + '"' + (y === gy ? ' selected' : '') + '>' + y + '</option>';
    }).join('');

    renderImportPart();
    $('#importFile').textContent = fileMeta.name;
    $('#importGuess').textContent = g
      ? 'Month and year read from the file name. Change them if that is not right.'
      : 'Could not tell the month from the file name — please choose it.';
    $('#importMsg').style.display = 'none';
    $('#importSheetWrap').style.display = 'none';
    $('#importSheet').innerHTML = '';
    pendingBook = null;
    $('#importModal').classList.add('open');

    if (SHEET_EXT.test(fileMeta.name)) {
      // A workbook has to be opened before we know what is in it. Say what is
      // happening -- reading a 10MB file takes a moment.
      $('#importMsg').style.display = 'flex';
      $('#importMsg').className = 'gate-msg';
      $('#importMsg').textContent = 'Opening the spreadsheet…';
      $('#importGo').disabled = true;
      w.Store.Files.blob(fileMeta.id)
        .then(function (blob) {
          if (!blob) throw new Error('that file is no longer in the workspace');
          return readWorkbook(blob);
        })
        .then(function (book) {
          if (pendingImport !== fileMeta) return;    // modal moved on
          pendingBook = book;
          $('#importGo').disabled = false;
          $('#importMsg').style.display = 'none';
          $('#importSheet').innerHTML = book.names.map(function (n) {
            return '<option value="' + esc(n) + '">' + esc(n) + '</option>';
          }).join('');
          // One sheet needs no question; more than one does, because picking
          // the wrong one files the wrong numbers with nothing to show for it.
          $('#importSheetWrap').style.display = book.names.length > 1 ? 'block' : 'none';
          checkDup();
        })
        .catch(function (e) {
          $('#importGo').disabled = false;
          $('#importMsg').style.display = 'flex';
          $('#importMsg').className = 'gate-msg err';
          $('#importMsg').textContent = 'Could not read that spreadsheet: ' + (e && e.message || e);
        });
      return;
    }
    checkDup();
  }

  /* Which piece of a split register this import is. Only meaningful for a
     dataset that declares parts; everything else files as the unnamed part,
     which is how it has always behaved. */
  function importPart() {
    var ds = $('#importSection').value;
    var ps = partsOf(ds);
    if (!ps) return '';
    var chosen = $('#importPart') && $('#importPart').value;
    return chosen || (ds === section ? sectionPart : '') || ps[0].id;
  }

  /* Show the part chooser only when the chosen section actually has parts. */
  function renderImportPart() {
    var ds = $('#importSection').value;
    var ps = partsOf(ds);
    var wrap = $('#importPartWrap');
    if (!ps) { wrap.style.display = 'none'; $('#importPart').innerHTML = ''; return; }
    var want = (ds === section && sectionPart) ? sectionPart : ps[0].id;
    $('#importPart').innerHTML = ps.map(function (pt) {
      return '<option value="' + esc(pt.id) + '"' + (pt.id === want ? ' selected' : '') + '>' +
        esc(pt.name) + '</option>';
    }).join('');
    wrap.style.display = 'block';
  }

  function importPeriod() {
    var m = +$('#importMonth').value, y = +$('#importYear').value;
    if (!m || !y) return '';
    return y + '-' + (m < 10 ? '0' : '') + m;
  }

  function checkDup() {
    var ds = $('#importSection').value, per = importPeriod();
    var box = $('#importDup');

    // Wrong-section check: does this file's header row look like this kind
    // of register at all?
    var mm = $('#importMismatch');
    var fit = sectionFit(ds, (pendingImport && pendingImport.headers) || []);
    if (fit && fit.hit / fit.need < 0.5) {
      var elsewhere = bestSection(pendingImport.headers);
      mm.style.display = 'flex';
      mm.textContent = 'This does not look like ' + (sectionById(ds) || {}).name +
        ' — only ' + fit.hit + ' of ' + fit.need + ' expected columns are there' +
        (fit.missing.length ? ' (missing ' + fit.missing.slice(0, 3).join(', ') + ')' : '') + '.' +
        (elsewhere && elsewhere.id !== ds ? ' It looks like ' + elsewhere.name + '.' : '') +
        ' Add it anyway only if you are sure.';
    } else {
      mm.style.display = 'none';
    }
    var d = storedFor(ds);
    var hit = d && d.periods.filter(function (p) { return p.period === per; })[0];
    if (hit) {
      box.style.display = 'flex';
      box.textContent = per + ' is already in ' + (sectionById(ds) || {}).name + ' — ' +
        hit.rows.toLocaleString() + ' rows from "' + hit.source + '". Adding this replaces it.';
    } else {
      box.style.display = 'none';
    }
    $('#importGo').disabled = !per;
  }
  function closeImport(skipQueue) {
    $('#importModal').classList.remove('open');
    pendingImport = null;
    pendingBook = null;          // release the workbook; these are large
    $('#importGo').disabled = false;
    if (!skipQueue) nextImport();
  }

  function runImport() {
    if (!pendingImport) return;
    var ds = $('#importSection').value, per = importPeriod();
    if (!per) return;
    var btn = $('#importGo');
    btn.classList.add('working'); btn.disabled = true;
    $('#importMsg').style.display = 'flex';
    $('#importMsg').className = 'gate-msg';
    $('#importMsg').textContent = 'Reading the file into the database…';

    var send;
    if (pendingBook) {
      // The server cannot parse a workbook, so it gets the sheet as CSV.
      // toCsv() runs in the background worker when one is available (see
      // readWorkbook), so this can be a real wait for a huge sheet without
      // the tab looking stuck.
      var sheet = $('#importSheet').value || pendingBook.names[0];
      var label = pendingImport.name + (pendingBook.names.length > 1 ? ' [' + sheet + ']' : '');
      send = pendingBook.toCsv(sheet).then(function (csv) {
        // Built once and reused across a retry -- a Blob (unlike a stream)
        // can be sent through fetch() more than once safely.
        var blob = new Blob([csv], { type: 'text/csv' });
        var url = '__data/import?dataset=' + encodeURIComponent(ds) +
                    '&period=' + encodeURIComponent(per) +
                    '&part=' + encodeURIComponent(importPart()) +
                    '&source=' + encodeURIComponent(label);
        return function () {
          return fetch(url, { method: 'POST',
                      headers: { 'Content-Type': 'text/csv; charset=utf-8' },
                      body: blob });
        };
      }, function (e) {
        // Distinguish "could not even read the sheet" from a server-side
        // rejection, by throwing a message the shared catch below can show
        // as-is rather than prefixing with "Could not add it".
        throw new Error('Could not read that sheet: ' + (e && e.message || e));
      });
    } else {
      var url2 = '__data/import?fileId=' + encodeURIComponent(pendingImport.id) +
                  '&dataset=' + encodeURIComponent(ds) + '&period=' + encodeURIComponent(per) +
                  '&part=' + encodeURIComponent(importPart());
      send = Promise.resolve(function () { return fetch(url2, { method: 'POST' }); });
    }
    send
      .then(function (doFetch) {
        // A 401 this soon after sign-in (this modal can be reached moments
        // after unlocking, via an auto-picked upload) can be the session
        // cookie racing this exact request rather than a real expiry -- one
        // forgiving retry before treating it as the session actually being
        // gone, same as storage.js's libFetch/checkPersistence.
        var attempt = function (retryOn401) {
          return doFetch().then(function (r) {
            if (r.status === 401 && retryOn401) {
              return new Promise(function (res) { setTimeout(res, 300); })
                .then(function () { return attempt(false); });
            }
            if (r.status === 401 && w.ParasGate) w.ParasGate.lock();
            return r.json().then(function (j) { return { ok: r.ok, j: j }; });
          });
        };
        return attempt(true);
      })
      .then(function (res) {
        btn.classList.remove('working'); btn.disabled = false;
        if (!res.ok) throw new Error(res.j.error || 'import failed');
        closeImport();
        return loadDbSummary().then(function () {
          // Both the pill bar for the open section AND the box summaries on
          // the grid behind it need the fresh numbers -- renderSectionMonths
          // alone left the grid showing the pre-import count until something
          // else happened to repaint it.
          renderSectionPicker();
          renderSectionMonths();
          var pnm = res.j.part ? partName(ds, res.j.part) : '';
          toast(res.j.rows.toLocaleString() + ' rows added to ' +
            (sectionById(ds) || {}).name + (pnm ? ' — ' + pnm : '') +
            ' for ' + per + '.', 'ok', 6000);
        });
      })
      .catch(function (e) {
        btn.classList.remove('working'); btn.disabled = false;
        $('#importMsg').className = 'gate-msg err';
        $('#importMsg').textContent = /^Could not read that sheet/.test(e && e.message || '')
          ? e.message
          : 'Could not add it: ' + (e && e.message || e);
      });
  }

  function addFiles(dashId, fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    if (dashId === ALL_FILES) {
      // The catch-all box is gone on purpose; quietly recreating it here by
      // filing the drop as "unfiled" is exactly what was confusing before.
      toast('Choose a section above first — that is what decides where the file is filed.', 'warn', 7000);
      return;
    }
    var db = dashId === w.Library.ID ? null : byId(dashId);
    // Name the section it actually went into. Saying "the Data Library" for a
    // file dropped into GRN Register reads like it was filed somewhere else.
    var sec = section ? sectionById(section) : null;
    var where = db ? db.name : (sec ? sec.name : 'the Data Library');
    if (files.length > 1 || files[0].size > 2e6) toast('Reading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…', 'ok', 2000);
    Promise.all(files.map(function (f) {
      // Read the header row once, so the file can be routed to the right
      // upload box later instead of being matched on its name alone.
      return w.Library.sniff(f).then(function (headers) {
        return w.Store.Files.add(dashId, f, headers);
      });
    }))
      .then(function (added) { return refreshCounts().then(function () { return added; }); })
      .then(function (added) {
        renderStats(); renderGrid(); renderFiles(); refreshMatchBar();
        // If the server disappeared mid-session the file was kept in the
        // browser instead. Say so plainly, and update the storage note --
        // silently filing it somewhere else is how data goes missing.
        var fellBack = (added || []).some(function (m) { return m && m.keptInBrowser; });
        if (fellBack) {
          renderModeSwitch();
          toast('The local server is not answering, so ' +
            (files.length === 1 ? 'that file was' : 'those files were') +
            ' kept in this browser, not in data/library. Start serve.py again, then re-add ' +
            (files.length === 1 ? 'it' : 'them') + ' to store ' +
            (files.length === 1 ? 'it' : 'them') + ' on disk.', 'warn', 12000);
        } else {
          toast(files.length + (files.length === 1 ? ' file' : ' files') + ' added to ' + where + '.', 'ok');
        }
        // Dropped into a section, and the database is reachable: offer to file
        // its contents too. Never automatic -- the month is a guess from the
        // file name, and filing August under July would be invisible later.
        if (section && w.Store.Files.onDisk()) offerImports(added || []);
        else if (section && !w.Store.Files.onDisk()) {
          toast('Filed as a file, but the database is not reachable, so nothing was added to ' +
            ((sectionById(section) || {}).name || 'the section') +
            '. Start serve.py and drop it again.', 'warn', 10000);
        }
      })
      .catch(function (e) {
        var msg = (e && e.message) || String(e);
        if (/failed to fetch|networkerror|load failed/i.test(msg)) {
          msg = 'the local server is not running. Start serve.py (the black window) and try again.';
        }
        toast('Could not attach: ' + msg, 'err', 10000);
      });
  }

  function withBlob(id, fn) {
    w.Store.Files.blob(id).then(function (b) {
      if (!b) return toast('That file is no longer in the workspace.', 'warn');
      fn(b);
    });
  }

  function downloadFile(id, name) {
    withBlob(id, function (b) {
      var url = URL.createObjectURL(b);
      var a = d.createElement('a');
      a.href = url; a.download = name || 'file';
      d.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 20000);
    });
  }

  function previewFile(id, name, type) {
    withBlob(id, function (b) {
      // Release whatever the modal was showing before. Every close path
      // revokes already, but overwriting the handle without revoking would
      // strand the previous file's bytes for the life of the tab.
      var prev = $('#previewModal');
      if (prev.dataset.url) { URL.revokeObjectURL(prev.dataset.url); delete prev.dataset.url; }
      var k = kindOf(name, type || b.type);
      var url = URL.createObjectURL(b.type ? b : new Blob([b], { type: guessMime(name) }));
      var body = $('#previewBody');
      $('#previewTitle').textContent = name;
      $('#previewDl').onclick = function () { downloadFile(id, name); };
      $('#previewTab').onclick = function () { w.open(url, '_blank', 'noopener'); };
      if (k === 'img') body.innerHTML = '<img alt="' + esc(name) + '" src="' + url + '">';
      else if (k === 'pdf') body.innerHTML = '<iframe title="' + esc(name) + '" src="' + url + '"></iframe>';
      else if (['csv', 'txt', 'json', 'log', 'md'].indexOf(kindOf(name, '')) >= 0 || /^text\//.test(b.type)) {
        body.innerHTML = '<pre>Loading…</pre>';
        b.slice(0, 400000).text().then(function (t) { $('pre', body).textContent = t; });
      } else {
        body.innerHTML = '<div class="empty-state" style="margin:auto">' + ico('file', 'lg') +
          '<h3>No inline preview</h3><p>' + esc(name) + ' opens in the app it belongs to — use Download, or Open in a new tab.</p></div>';
      }
      $('#previewModal').classList.add('open');
      $('#previewModal').dataset.url = url;
    });
  }

  function guessMime(name) {
    var e = (name.split('.').pop() || '').toLowerCase();
    return ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', csv: 'text/csv',
      txt: 'text/plain', json: 'application/json', md: 'text/plain' })[e] || 'application/octet-stream';
  }

  function closePreview() {
    var m = $('#previewModal');
    m.classList.remove('open');
    if (m.dataset.url) { URL.revokeObjectURL(m.dataset.url); delete m.dataset.url; }
    $('#previewBody').innerHTML = '';
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
    if (!forDash) return Promise.resolve(null);
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
      closeDrawer();
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
            closeDrawer();
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
    $('#homeBtn').addEventListener('click', function () { goHome(); });
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
        if (t.dataset.files) return openDrawer(t.dataset.files);
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
    $('#dashFilesBtn').addEventListener('click', function () { if (current) openDrawer(current, 'library'); });
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
    /* Flicked shut by hand rather than via the close button: the sheet has
       already animated itself out, so this only has to clear the state that
       closeDrawer() owns. Removing .open again is harmless -- the sheet is
       already where it is going. */
    var dr = $('#drawer');
    if (dr) dr.addEventListener('sheet:dismiss', function () { closeDrawer(); });

    /* drawer */
    $('#importSection').addEventListener('change', function () { renderImportPart(); checkDup(); });
    $('#importMonth').addEventListener('change', checkDup);
    $('#importYear').addEventListener('change', checkDup);
    $('#importCancel').addEventListener('click', closeImport);
    $('#importClose').addEventListener('click', closeImport);
    $('#importGo').addEventListener('click', runImport);
    $('#importModal').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeImport(); });

    $('#drawerTabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-tab]'); if (!b) return;
      drawerTab = b.dataset.tab;
      $('#fileSearchInput').value = '';
      renderDrawerHead(); renderFiles();
    });
    $('#libraryBtn').addEventListener('click', function () { openDrawer(current, 'library'); });
    $('#matchFill').addEventListener('click', fillAllFromLibrary);
    $('#matchOpen').addEventListener('click', function () { openDrawer(current, 'library'); });
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#scrim').addEventListener('click', closeDrawer);
    $('#fileSearchInput').addEventListener('input', renderFiles);
    $('#filePick').addEventListener('change', function (e) {
      addFiles(drawerScope(), e.target.files);
      e.target.value = '';
    });
    $('#dropzone').addEventListener('click', function () { $('#filePick').click(); });
    ['dragenter', 'dragover'].forEach(function (n) {
      $('#dropzone').addEventListener(n, function (e) { e.preventDefault(); $('#dropzone').classList.add('hot'); });
    });
    ['dragleave', 'drop'].forEach(function (n) {
      $('#dropzone').addEventListener(n, function () { $('#dropzone').classList.remove('hot'); });
    });
    $('#dropzone').addEventListener('drop', function (e) {
      e.preventDefault();
      addFiles(drawerScope(), e.dataTransfer.files);
    });

    $('#fileList').addEventListener('click', function (e) {
      var row = e.target.closest('.file-row'); if (!row) return;
      var id = row.dataset.fid;
      var name = ($('.file-name', row) || {}).textContent || 'file';
      if (e.target.closest('[data-fcond]')) {
        var rec = null;
        return w.Store.Files.list(drawerScope()).then(function (rows) {
          rec = rows.filter(function (x) { return x.id === id; })[0];
          if (rec) openCondense(rec);
        });
      }
      if (e.target.closest('[data-fuse]')) {
        if (!drawerFor) return toast('Open a dashboard first, then send the file to it.', 'warn');
        var size = +row.dataset.fsize || 0;
        if (isBig({ name: name, size: size })) {
          toast('"' + name + '" is ' + fmtSize(size) + ' — too large to hand to a dashboard directly. Condense it first (⚡).', 'warn', 8000);
          return;
        }
        return sendToDashboard(id, name, row.dataset.ftype || '', drawerFor);
      }
      if (e.target.closest('[data-fopen]')) return previewFile(id, name);
      if (e.target.closest('[data-fdl]')) return downloadFile(id, name);
      if (e.target.closest('[data-fren]')) { renaming = id; renderFiles(); return; }
      if (e.target.closest('[data-fdel]')) {
        return confirmDialog('Delete "' + name + '"?', 'The file is removed from this workspace. Your original copy on disk is untouched.', 'Delete', function () {
          w.Store.Files.remove(id).then(refreshCounts).then(function () {
            renderFiles(); renderStats(); renderGrid();
            toast('File deleted.', 'ok');
          });
        });
      }
    });
    $('#fileList').addEventListener('keydown', function (e) {
      var inp = e.target.closest('[data-rename-input]'); if (!inp) return;
      if (e.key === 'Enter') { commitRename(inp.dataset.renameInput, inp.value); }
      if (e.key === 'Escape') { renaming = null; renderFiles(); }
    });
    $('#fileList').addEventListener('focusout', function (e) {
      var inp = e.target.closest('[data-rename-input]');
      if (inp && renaming) commitRename(inp.dataset.renameInput, inp.value);
    });

    /* preview + confirm modals */
    $('#previewClose').addEventListener('click', closePreview);
    $('#previewModal').addEventListener('click', function (e) { if (e.target === e.currentTarget) closePreview(); });
    $('#pickList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-slot]'); if (!b || !pickSlots) return;
      var slot = pickSlots[+b.dataset.slot], cb = pickCb;
      closePick();
      if (cb) cb(slot);
    });
    $('#condCancel').addEventListener('click', closeCondense);
    $('#condRun').addEventListener('click', runCondense);
    $('#condModal').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeCondense(); });
    $('#pickCancel').addEventListener('click', closePick);
    $('#pickModal').addEventListener('click', function (e) { if (e.target === e.currentTarget) closePick(); });

    $('#confirmCancel').addEventListener('click', closeConfirm);
    $('#confirmOk').addEventListener('click', function () { var cb = confirmCb; closeConfirm(); if (cb) cb(); });
    $('#confirmModal').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeConfirm(); });

    /* shortcuts */
    d.addEventListener('keydown', function (e) {
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ''));
      if (e.key === 'Escape') {
        if ($('#importModal').classList.contains('open')) return closeImport();
        if ($('#condModal').classList.contains('open')) return closeCondense();
        if ($('#pickModal').classList.contains('open')) return closePick();
        if ($('#previewModal').classList.contains('open')) return closePreview();
        if ($('#confirmModal').classList.contains('open')) return closeConfirm();
        if ($('#drawer').classList.contains('open')) return closeDrawer();
        if (current) return goHome();
      }
      if (typing) return;
      if (e.key === '/') { e.preventDefault(); if (current) goHome(); $('#search').focus(); }
      if (e.key.toLowerCase() === 'h' && !e.metaKey && !e.ctrlKey) goHome();
    });

    /* block accidental navigation when a file is dropped outside a zone */
    /* Files are only ever added through the Data Library's own dropzone —
       cards no longer accept a file drop, since a dropped file always went
       into the shared library and was auto-matched regardless of which card
       received it, so highlighting one particular card as a target was
       misleading. This just stops the browser from navigating away if a file
       is dropped anywhere else on the page. */
    ['dragover', 'drop'].forEach(function (n) {
      w.addEventListener(n, function (e) {
        if (hasFiles(e) && !e.target.closest('#dropzone')) e.preventDefault();
      });
    });
  }

  function commitRename(id, name) {
    name = (name || '').trim();
    renaming = null;
    if (!name) { renderFiles(); return; }
    w.Store.Files.rename(id, name).then(function () {
      invalidateFiles(); renderFiles(); toast('Renamed.', 'ok');
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
