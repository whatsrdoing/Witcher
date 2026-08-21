/* PARAS HEALTH — SUPPLY CHAIN COMMAND CENTRE
 * Shell / launcher only. Dashboards are loaded verbatim into isolated iframes:
 * their markup, CSS, scripts and state are never touched by this file. */
(function (w, d) {
  'use strict';

  var REG = null;
  var frames = Object.create(null);   // id -> { el, loaded, openedAt }
  var fileCounts = Object.create(null);
  var current = null;                 // active dashboard id, null = home
  var filter = { text: '', category: 'all' };
  var drawerFor = null;
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
    if (next === w.Store.getMode()) return;
    var go = function () {
      w.Store.setMode(next);
      w.Store.loadPrefs();
      applyTheme(w.Store.getPref('theme', REG.app.defaultTheme));
      filter.category = w.Store.getPref('category', 'all');
      renderModeSwitch();
      refreshCounts().then(renderHome);
      if (drawerFor) renderFiles();
      toast(next === 'session' ? 'Session mode — this workspace is now temporary.' : 'Local mode — changes are saved on this computer.', 'ok');
    };
    if (next === 'session') {
      confirmDialog('Switch to Session mode?',
        'Session mode starts an empty temporary workspace. Files you attach and layout changes are held in memory only and disappear when this tab closes. Anything already saved in Local mode is kept and comes back when you switch back.',
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

    var f = frames[id];
    if (!f) {
      var el = d.createElement('iframe');
      el.title = db.name;
      el.setAttribute('loading', 'eager');
      el.dataset.id = id;
      el.src = db.file;
      $('#frameLoading').style.display = 'flex';
      $('#frameLoadingTxt').textContent = 'Opening ' + db.name + '…';
      el.addEventListener('load', function () {
        frames[id].loaded = true;
        if (current === id) $('#frameLoading').style.display = 'none';
      });
      $('#frames').appendChild(el);
      f = frames[id] = { el: el, loaded: false, openedAt: Date.now() };
    }
    $('#frameLoading').style.display = f.loaded ? 'none' : 'flex';

    $$('.frames iframe').forEach(function (x) { x.classList.toggle('active', x.dataset.id === id); });

    $('#dashIcon').innerHTML = ico(db.icon);
    $('#dashIcon').style.setProperty('--accent', db.accent);
    $('#dashTitle').textContent = db.name;
    $('#dashFilesBtn').innerHTML = ico('folder') + '<span>Files</span>' +
      (fileCounts[id] ? '<span class="badge open">' + fileCounts[id] + '</span>' : '');

    renderCrumbs(db);
    renderLiveCount();
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
        $$('#grid .card').forEach(function (c) { c.classList.remove('drop-before', 'drop-after', 'file-target'); });
      });
      card.addEventListener('dragover', function (e) {
        if (dragId) {
          if (card.dataset.id === dragId) return;
          e.preventDefault();
          try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
          var r = card.getBoundingClientRect();
          var before = (e.clientX - r.left) < r.width / 2;
          card.classList.toggle('drop-before', before);
          card.classList.toggle('drop-after', !before);
        } else if (hasFiles(e)) {
          e.preventDefault();
          card.classList.add('file-target');
        }
      });
      card.addEventListener('dragleave', function () {
        card.classList.remove('drop-before', 'drop-after', 'file-target');
      });
      card.addEventListener('drop', function (e) {
        card.classList.remove('drop-before', 'drop-after', 'file-target');
        if (dragId && card.dataset.id !== dragId) {
          e.preventDefault(); e.stopPropagation();
          var r = card.getBoundingClientRect();
          reorder(dragId, card.dataset.id, (e.clientX - r.left) < r.width / 2);
        } else if (hasFiles(e)) {
          e.preventDefault(); e.stopPropagation();
          addFiles(card.dataset.id, e.dataTransfer.files);
        }
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

  function openDrawer(id) {
    drawerFor = id;
    $('#drawer').classList.add('open');
    $('#scrim').classList.add('open');
    var db = byId(id);
    $('#drawerFor').textContent = db ? db.name : id;
    $('#fileSearchInput').value = '';
    renderFiles();
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
    if (!drawerFor) return;
    var q = ($('#fileSearchInput').value || '').trim().toLowerCase();
    w.Store.Files.list(drawerFor).then(function (rows) {
      rows.sort(function (a, b) { return b.addedAt - a.addedAt; });
      var shown = q ? rows.filter(function (r) { return r.name.toLowerCase().indexOf(q) >= 0; }) : rows;
      var host = $('#fileList');
      if (!shown.length) {
        host.innerHTML = '<div class="empty-state" style="padding:34px 8px">' + ico('inbox', 'lg') +
          '<h3>' + (q ? 'Nothing matches' : 'No files attached') + '</h3>' +
          '<p>' + (q ? 'Try a different search.' : 'Attach SOPs, registers or vendor masters — they stay linked to this dashboard.') + '</p></div>';
      } else {
        host.innerHTML = shown.map(function (r) {
          var k = kindOf(r.name, r.type);
          var isRen = renaming === r.id;
          return '<div class="file-row" data-fid="' + esc(r.id) + '">' +
            '<div class="file-ico ' + esc(k) + '">' + esc(k.toUpperCase()) + '</div>' +
            '<div class="file-meta">' +
              (isRen
                ? '<input class="file-name-input" value="' + esc(r.name) + '" data-rename-input="' + esc(r.id) + '">'
                : '<div class="file-name" title="' + esc(r.name) + '">' + esc(r.name) + '</div>') +
              '<div class="file-sub">' + esc(fmtSize(r.size)) + ' · ' + esc(fmtDate(r.addedAt)) + '</div>' +
            '</div>' +
            '<div class="file-acts">' +
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

  function addFiles(dashId, fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var db = byId(dashId);
    Promise.all(files.map(function (f) { return w.Store.Files.add(dashId, f); }))
      .then(function () { return refreshCounts(); })
      .then(function () {
        renderStats(); renderGrid();
        if (drawerFor === dashId) renderFiles();
        else if (current === dashId) openDashboard(dashId, true);
        toast(files.length + (files.length === 1 ? ' file' : ' files') + ' attached to ' + (db ? db.name : 'dashboard') + '.', 'ok');
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
    $('#lockBtn').addEventListener('click', function () {
      confirmDialog('Lock the Command Centre?',
        'You will need to sign in again. Open dashboards are closed, but nothing you have saved is lost.',
        'Lock', function () { w.ParasGate.lock(); });
    });

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
    $('#dashFilesBtn').addEventListener('click', function () { if (current) openDrawer(current); });
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
      if (!e.target.closest('.live-tray')) $('#livePop').style.display = 'none';
    });

    /* drawer */
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#scrim').addEventListener('click', closeDrawer);
    $('#fileSearchInput').addEventListener('input', renderFiles);
    $('#filePick').addEventListener('change', function (e) {
      if (drawerFor) addFiles(drawerFor, e.target.files);
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
      if (drawerFor) addFiles(drawerFor, e.dataTransfer.files);
    });

    $('#fileList').addEventListener('click', function (e) {
      var row = e.target.closest('.file-row'); if (!row) return;
      var id = row.dataset.fid;
      var name = ($('.file-name', row) || {}).textContent || 'file';
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
    $('#confirmCancel').addEventListener('click', closeConfirm);
    $('#confirmOk').addEventListener('click', function () { var cb = confirmCb; closeConfirm(); if (cb) cb(); });
    $('#confirmModal').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeConfirm(); });

    /* shortcuts */
    d.addEventListener('keydown', function (e) {
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ''));
      if (e.key === 'Escape') {
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
    ['dragover', 'drop'].forEach(function (n) {
      w.addEventListener(n, function (e) {
        if (hasFiles(e) && !e.target.closest('#dropzone,.card')) e.preventDefault();
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
