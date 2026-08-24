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
  }

  function renderModeSwitch() {
    var mode = w.Store.getMode();
    var persistOk = w.Store.idbAvailable() !== false;
    $$('#modeSwitch button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    });
    var local = $('#modeSwitch button[data-mode="local"]');
    if (!persistOk) {
      local.title = 'Local file storage needs a local server — run "python3 serve.py". Layout still persists.';
    } else {
      local.title = 'Local mode — dashboards, layout and attached files stay on this computer.';
    }
    $('#modeNote').innerHTML = mode === 'session'
      ? ico('bolt', 'sm') + '<span>Session mode — attachments and layout changes are discarded when you close this tab.</span>'
      : (persistOk
          ? ico('lock', 'sm') + '<span>Local mode — everything is stored on this computer only. Nothing leaves the machine.</span>'
          : ico('warn', 'sm') + '<span>Local mode — layout persists, but attachments need <code>python3 serve.py</code> to survive a restart.</span>');
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
      if (filter.category !== 'all' && x.category !== filter.category) return false;
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
    $('#stats').innerHTML = [
      ['Dashboards', REG.dashboards.length],
      ['Live', live],
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
    var html = '<button class="chip" data-cat="all" aria-pressed="' + (filter.category === 'all') + '">' +
      ico('layers', 'sm') + 'All<span class="n">' + total + '</span></button>';
    html += REG.categories.filter(function (c) { return counts[c.id]; }).map(function (c) {
      return '<button class="chip" data-cat="' + esc(c.id) + '" aria-pressed="' + (filter.category === c.id) + '">' +
        '<span class="dot" style="background:' + esc(c.accent) + '"></span>' + esc(c.name) +
        '<span class="n">' + counts[c.id] + '</span></button>';
    }).join('');
    $('#chips').innerHTML = html;
  }

  function statusLabel(s) {
    return { live: 'Live', beta: 'Beta', planned: 'Coming soon', archived: 'Archived' }[s] || s;
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
    return w.Store.Files.counts().then(function (c) { fileCounts = c || {}; return c; });
  }

  function libraryCount() { return fileCounts[w.Library.ID] || 0; }

  function openDrawer(id, tab) {
    drawerFor = id || null;
    drawerTab = tab || (id ? drawerTab : 'library');
    if (!drawerFor) drawerTab = 'library';
    $('#drawer').classList.add('open');
    $('#scrim').classList.add('open');
    $('#fileSearchInput').value = '';
    renderDrawerHead();
    renderFiles();
  }

  function renderDrawerHead() {
    var db = drawerFor ? byId(drawerFor) : null;
    $('#drawerTabs').style.display = db ? 'flex' : 'none';
    $('#tabPinned').textContent = db ? db.name : '';
    $$('#drawerTabs button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.tab === drawerTab));
    });
    var lib = drawerTab === 'library';
    $('#drawerTitle').textContent = lib ? 'Data Library' : 'Pinned files';
    $('#drawerFor').textContent = lib
      ? 'Shared by every dashboard'
      : 'Only on ' + (db ? db.name : 'this dashboard');
    $('#dropHint').textContent = lib
      ? 'Registers, GRN, transfers — dropped once, used everywhere'
      : 'SOPs and notes that belong to this dashboard only';
    $('#drawerTip').style.display = 'none';
    if (lib && drawerFor) {
      frameInputs(drawerFor).then(function (slots) {
        if (slots && slots.length && drawerTab === 'library') $('#drawerTip').style.display = 'flex';
      });
    }
  }

  function drawerScope() { return drawerTab === 'library' ? w.Library.ID : drawerFor; }

  /* Names every dashboard whose upload boxes this file suits. */
  /* The one or two upload boxes this file genuinely belongs in. Deliberately
     strict: a chip that appears everywhere tells you nothing. */
  function usedBy(file) {
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
    return out.slice(0, 3);
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

  function renderFiles() {
    if (!$('#drawer').classList.contains('open')) return;
    var scope = drawerScope();
    if (!scope) return;
    var q = ($('#fileSearchInput').value || '').trim().toLowerCase();
    w.Store.Files.list(scope).then(function (rows) {
      rows.sort(function (a, b) { return b.addedAt - a.addedAt; });
      var shown = q ? rows.filter(function (r) { return r.name.toLowerCase().indexOf(q) >= 0; }) : rows;
      var host = $('#fileList');
      if (!shown.length) {
        host.innerHTML = '<div class="empty-state" style="padding:34px 8px">' + ico('inbox', 'lg') +
          '<h3>' + (q ? 'Nothing matches' : 'No files attached') + '</h3>' +
          '<p>' + (q ? 'Try a different search.' : (drawerTab === 'library'
            ? 'Drop your registers here once. The Command Centre reads each file\'s columns and offers it to every dashboard that needs it.'
            : 'Files pinned here stay with this dashboard only.')) + '</p></div>';
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
  var condenseFile = null, condenseCols = null;

  function openCondense(fileMeta) {
    condenseFile = fileMeta;
    $('#condTitle').textContent = 'Condense "' + fileMeta.name + '"';
    $('#condCols').innerHTML = '<div class="cond-loading"><span class="spinner"></span>Reading the columns…</div>';
    $('#condStats').textContent = fmtSize(fileMeta.size) + ' — too large for a browser tab to open directly.';
    $('#condRun').disabled = true;
    $('#condModal').classList.add('open');

    w.Store.Files.blob(fileMeta.id).then(function (blob) {
      if (!blob) throw new Error('that file is no longer in the workspace');
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
    condenseFile = null; condenseCols = null;
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

    w.Store.Files.blob(meta.id).then(function (blob) {
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
      return w.Library.sniff(file).then(function (headers) {
        return w.Store.Files.add(w.Library.ID, file, headers);
      }).then(function () {
        $('#condRun').classList.remove('working');
        $('#condRun').disabled = false;
        closeCondense();
        return refreshCounts().then(function () {
          renderStats(); renderGrid(); renderFiles(); refreshMatchBar();
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

  function addFiles(dashId, fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var db = dashId === w.Library.ID ? null : byId(dashId);
    var where = db ? db.name : 'the Data Library';
    if (files.length > 1 || files[0].size > 2e6) toast('Reading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…', 'ok', 2000);
    Promise.all(files.map(function (f) {
      // Read the header row once, so the file can be routed to the right
      // upload box later instead of being matched on its name alone.
      return w.Library.sniff(f).then(function (headers) {
        return w.Store.Files.add(dashId, f, headers);
      });
    }))
      .then(function () { return refreshCounts(); })
      .then(function () {
        renderStats(); renderGrid(); renderFiles(); refreshMatchBar();
        toast(files.length + (files.length === 1 ? ' file' : ' files') + ' added to ' + where + '.', 'ok');
      })
      .catch(function (e) { toast('Could not attach: ' + (e && e.message || e), 'err', 7000); });
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

  /* Puts a file in an upload box, directly or by message. */
  function fillInput(slot, blob, name, type) {
    if (slot.el) {
      var file = new File([blob], name, { type: type || blob.type || 'application/octet-stream' });
      var dt = new DataTransfer();
      dt.items.add(file);
      slot.el.files = dt.files;
      slot.el.dispatchEvent(new Event('input', { bubbles: true }));
      slot.el.dispatchEvent(new Event('change', { bubbles: true }));
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
  function libraryFiles() {
    return w.Store.Files.list(w.Library.ID);
  }

  /* Which library files suit the dashboard that is open right now. */
  function matchesForOpen() {
    if (!current) return Promise.resolve(null);
    var forDash = current;
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

  function refreshMatchBar() {
    var bar = $('#matchBar');
    if (!bar) return;
    if (!current) { bar.style.display = 'none'; return; }
    matchesForOpen().then(function (m) {
      if (!m || m.dashId !== current) { bar.style.display = 'none'; return; }
      if (!m.pairs.length && !m.blocked.length) { bar.style.display = 'none'; return; }
      bar.style.display = 'flex';
      var required = m.slots.filter(function (s) { return s.auto && !s.optional; }).length;
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

  function fillAllFromLibrary() {
    matchesForOpen().then(function (m) {
      if (!m || !m.pairs.length) return toast('Nothing in the Data Library matches this dashboard yet.', 'warn');
      var done = 0, failed = 0, lastError = '';
      var next = function (i) {
        if (i >= m.pairs.length) {
          if (done) toast('Filled ' + done + ' upload box' + (done === 1 ? '' : 'es') +
            (failed ? ' (' + failed + ' failed)' : '') +
            ' — press the dashboard\'s own build button to run it.', failed ? 'warn' : 'ok', 6000);
          else toast('Could not fill any upload box' + (lastError ? ' — ' + lastError : '') + '.', 'err', 8000);
          return;
        }
        var p = m.pairs[i];
        w.Store.Files.blob(p.file.id).then(function (blob) {
          if (!blob) { failed++; return next(i + 1); }
          return fillInput(p.slot, blob, p.file.name, p.file.type)
            .then(function () { done++; })
            .catch(function (e) { failed++; lastError = e && e.message || String(e); })
            .then(function () { setTimeout(function () { next(i + 1); }, 50); });
        }).catch(function () { failed++; setTimeout(function () { next(i + 1); }, 50); });
      };
      closeDrawer();
      next(0);
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

    /* drawer */
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
    w.Store.Files.rename(id, name).then(function () { renderFiles(); toast('Renamed.', 'ok'); });
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
