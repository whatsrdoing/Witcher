/* Offline storage for the Command Centre. Nothing here ever touches a network.
 *
 *   LOCAL MODE    prefs -> localStorage      files -> IndexedDB (survive restart)
 *   SESSION MODE  prefs -> sessionStorage    files -> memory   (gone on close)
 *
 * IndexedDB is unavailable on file:// in Chromium-based browsers. When that
 * happens LOCAL mode still keeps your layout, but file attachments fall back to
 * session behaviour and the UI says so — run `python3 serve.py` for full LOCAL.
 */
(function (w) {
  'use strict';

  var MODE_KEY = 'paras.cc.mode';
  var PREFS_KEY = 'paras.cc.prefs.v1';
  var DB_NAME = 'paras-command-centre';
  var DB_VER = 2;
  var STORE = 'files';      // metadata only — small, safe to iterate
  var BLOBS = 'blobs';      // the file data itself, fetched only when needed

  /* ---- safe web-storage wrappers (private mode / file:// can throw) ------- */
  function probe(store) {
    try { var k = '__p' + Date.now(); store.setItem(k, '1'); store.removeItem(k); return true; }
    catch (e) { return false; }
  }
  var memBags = { local: Object.create(null), session: Object.create(null) };
  function bag(kind) {
    var real = kind === 'local' ? w.localStorage : w.sessionStorage;
    if (real && probe(real)) return real;
    var m = memBags[kind];
    return {
      getItem: function (k) { return k in m ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; }
    };
  }
  var LS = bag('local'), SS = bag('session');

  /* ---- mode -------------------------------------------------------------- */
  var mode = 'local';
  function getMode() { return mode; }
  function setMode(m) { mode = (m === 'session') ? 'session' : 'local'; try { LS.setItem(MODE_KEY, mode); } catch (e) {} return mode; }
  function readStoredMode(fallback) {
    var v = LS.getItem(MODE_KEY);
    return (v === 'session' || v === 'local') ? v : (fallback === 'session' ? 'session' : 'local');
  }

  /* ---- prefs (layout, theme, filters) ------------------------------------ */
  function prefStore() { return mode === 'session' ? SS : LS; }
  var prefsCache = null;

  function loadPrefs() {
    try { prefsCache = JSON.parse(prefStore().getItem(PREFS_KEY) || '{}') || {}; }
    catch (e) { prefsCache = {}; }
    return prefsCache;
  }
  function prefs() { return prefsCache || loadPrefs(); }
  function savePrefs() {
    try { prefStore().setItem(PREFS_KEY, JSON.stringify(prefsCache || {})); } catch (e) {}
  }
  function getPref(k, dflt) { var p = prefs(); return (k in p) ? p[k] : dflt; }
  function setPref(k, v) { prefs()[k] = v; savePrefs(); }
  function clearPrefs() { prefsCache = {}; try { prefStore().removeItem(PREFS_KEY); } catch (e) {} }

  /* ---- file store: IndexedDB backend ------------------------------------- */
  var dbPromise = null, idbOk = null, httpOk = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (res, rej) {
      var req;
      try { req = w.indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { return rej(e); }
      if (!req) return rej(new Error('IndexedDB unavailable'));
      req.onupgradeneeded = function (ev) {
        var db = req.result, tx = req.transaction;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('dashboardId', 'dashboardId', { unique: false });
        }
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'id' });

        // v1 kept the file data inside the metadata record, so listing files
        // read every byte of every file. Move the data to its own store.
        if (ev.oldVersion && ev.oldVersion < 2 && tx) {
          var meta = tx.objectStore(STORE), blobs = tx.objectStore(BLOBS);
          var cur = meta.openCursor();
          cur.onsuccess = function () {
            var c = cur.result;
            if (!c) return;
            var v = c.value;
            if (v && v.blob) {
              blobs.put({ id: v.id, blob: v.blob });
              delete v.blob;
              c.update(v);
            }
            c.continue();
          };
        }
      };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error || new Error('IndexedDB open failed')); };
      req.onblocked = function () { rej(new Error('IndexedDB blocked')); };
    });
    return dbPromise;
  }

  function tx(mode2, fn, stores) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var names = stores || STORE;
        var t = db.transaction(names, mode2);
        var out;
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error || new Error('aborted')); };
        var set = function (v) { out = v; };
        out = (typeof names === 'string')
          ? fn(t.objectStore(names), set)
          : fn(t, set);
      });
    });
  }

  var idb = {
    list: function (dashboardId) {
      return tx('readonly', function (os, set) {
        var acc = [];
        var req = os.index('dashboardId').openCursor(IDBKeyRange.only(dashboardId));
        req.onsuccess = function () {
          var c = req.result;
          if (c) { acc.push(meta(c.value)); c.continue(); } else { set(acc); }
        };
      });
    },
    counts: function () {
      return tx('readonly', function (os, set) {
        var acc = Object.create(null);
        var req = os.openCursor();
        req.onsuccess = function () {
          var c = req.result;
          if (c) { acc[c.value.dashboardId] = (acc[c.value.dashboardId] || 0) + 1; c.continue(); }
          else { set(acc); }
        };
      });
    },
    /* Every record, regardless of dashboard -- used once, to migrate
       anything already sitting here to the on-disk library. */
    listAll: function () {
      return tx('readonly', function (os, set) {
        var acc = [];
        var req = os.openCursor();
        req.onsuccess = function () {
          var c = req.result;
          if (c) { acc.push(meta(c.value)); c.continue(); } else { set(acc); }
        };
      });
    },
    put: function (rec) {
      var m = meta(rec);
      return tx('readwrite', function (t, set) {
        t.objectStore(STORE).put(m);
        t.objectStore(BLOBS).put({ id: rec.id, blob: rec.blob });
        set(m);
      }, [STORE, BLOBS]);
    },
    /* Only ever called for one file at a time, so the data is read on demand
       rather than every time the list is drawn. */
    get: function (id) {
      return tx('readonly', function (t, set) {
        var mv = null, bv = null, left = 2;
        var done = function () {
          if (--left) return;
          if (!mv) return set(null);
          set(Object.assign({}, mv, { blob: (bv && bv.blob) || mv.blob || null }));
        };
        var m = t.objectStore(STORE).get(id);
        m.onsuccess = function () { mv = m.result || null; done(); };
        m.onerror = done;
        var b = t.objectStore(BLOBS).get(id);
        b.onsuccess = function () { bv = b.result || null; done(); };
        b.onerror = done;
      }, [STORE, BLOBS]);
    },
    del: function (id) {
      return tx('readwrite', function (t) {
        t.objectStore(STORE).delete(id);
        t.objectStore(BLOBS).delete(id);
      }, [STORE, BLOBS]);
    },
    rename: function (id, name) {
      return tx('readwrite', function (os, set) {
        var r = os.get(id);
        r.onsuccess = function () {
          var v = r.result; if (!v) return set(null);
          v.name = name; v.updatedAt = Date.now(); os.put(v); set(meta(v));
        };
      });
    },
    clearAll: function () {
      return tx('readwrite', function (t) {
        t.objectStore(STORE).clear();
        t.objectStore(BLOBS).clear();
      }, [STORE, BLOBS]);
    }
  };

  /* ---- file store: memory backend (session mode / no IndexedDB) ---------- */
  var mem = Object.create(null);
  var memApi = {
    list: function (d) { return Promise.resolve(Object.keys(mem).map(function (k) { return mem[k]; })
      .filter(function (r) { return r.dashboardId === d; }).map(meta)); },
    counts: function () {
      var acc = Object.create(null);
      Object.keys(mem).forEach(function (k) { var r = mem[k]; acc[r.dashboardId] = (acc[r.dashboardId] || 0) + 1; });
      return Promise.resolve(acc);
    },
    listAll: function () { return Promise.resolve(Object.keys(mem).map(function (k) { return meta(mem[k]); })); },
    put: function (rec) { mem[rec.id] = rec; return Promise.resolve(meta(rec)); },
    get: function (id) { return Promise.resolve(mem[id] || null); },
    del: function (id) { delete mem[id]; return Promise.resolve(); },
    rename: function (id, name) {
      var r = mem[id]; if (!r) return Promise.resolve(null);
      r.name = name; r.updatedAt = Date.now(); return Promise.resolve(meta(r));
    },
    clearAll: function () { mem = Object.create(null); return Promise.resolve(); }
  };

  function meta(r) {
    return { id: r.id, dashboardId: r.dashboardId, name: r.name, size: r.size,
             type: r.type, addedAt: r.addedAt, updatedAt: r.updatedAt,
             headers: r.headers || [] };
  }

  /* ---- file store: on-disk backend (python3 serve.py) --------------------
     Real files under data/library/ next to index.html, instead of the
     browser's IndexedDB -- so they show up in that folder like any other
     file, and survive a browser reset or a "clear browsing data". Only
     available when the app is served over http (not opened from file://). */
  var LIB = '__library';

  function libFetch(path, opts, retryOn401) {
    if (retryOn401 === undefined) retryOn401 = true;
    return fetch(LIB + path, Object.assign({ cache: 'no-store' }, opts || {}))
      .then(function (r) {
        // A 401 moments after sign-in can be this exact request racing the
        // session cookie rather than a real expiry (see checkPersistence's
        // retry, above) -- so give it one forgiving retry before treating it
        // as the session actually being gone. rec.blob (the only body ever
        // passed through here) is a Blob, which fetch can safely re-send.
        if (r.status === 401 && retryOn401) {
          return new Promise(function (res) { setTimeout(res, 300); })
            .then(function () { return libFetch(path, opts, false); });
        }
        // The session this tab thought it had is gone -- expired, or the
        // server restarted and dropped every session it was holding. Back
        // to the sign-in screen cleanly rather than surfacing this as a
        // generic failed request every dashboard would have to guess at.
        if (r.status === 401 && w.ParasGate) { w.ParasGate.lock(); }
        if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);
        return r;
      });
  }
  function libList() {
    return libFetch('').then(function (r) { return r.json(); }).then(function (j) { return (j && j.files) || []; });
  }

  var httpApi = {
    list: function (d) {
      return libList().then(function (files) {
        return files.filter(function (r) { return r.dashboardId === d; }).map(meta);
      });
    },
    listAll: function () { return libList().then(function (f) { return f.map(meta); }); },
    counts: function () {
      return libList().then(function (files) {
        var acc = Object.create(null);
        files.forEach(function (r) { acc[r.dashboardId] = (acc[r.dashboardId] || 0) + 1; });
        return acc;
      });
    },
    put: function (rec) {
      var qs = 'id=' + encodeURIComponent(rec.id) +
        '&dashboardId=' + encodeURIComponent(rec.dashboardId || '') +
        '&name=' + encodeURIComponent(rec.name || 'untitled') +
        '&type=' + encodeURIComponent(rec.type || '') +
        '&headers=' + encodeURIComponent(JSON.stringify(rec.headers || []));
      return libFetch('/' + encodeURIComponent(rec.id) + '?' + qs, { method: 'POST', body: rec.blob })
        .then(function (r) { return r.json(); }).then(meta);
    },
    get: function (id) {
      return libFetch('/' + encodeURIComponent(id))
        .then(function (r) { return r.status === 404 ? null : r.blob(); })
        .then(function (blob) { return blob ? { blob: blob } : null; });
    },
    del: function (id) { return libFetch('/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {}); },
    rename: function (id, name) {
      return libFetch('/' + encodeURIComponent(id) + '/rename?name=' + encodeURIComponent(name), { method: 'POST' })
        .then(function (r) { return r.json(); }).then(meta);
    },
    clearAll: function () {
      return libList().then(function (files) { return Promise.all(files.map(function (r) { return httpApi.del(r.id); })); });
    }
  };

  /* fetch() rejects with a TypeError when the connection itself failed --
     the server stopped, the machine slept, the port changed. That is very
     different from the server answering with an error, and it is the one
     case where the right move is to stop trusting the earlier probe. */
  function netFail(e) {
    return !!e && (e instanceof TypeError ||
      /failed to fetch|networkerror|load failed|connection/i.test(e.message || ''));
  }

  /* ---- backend selection -------------------------------------------------- */
  function backend() {
    if (mode === 'session') return memApi;
    if (httpOk === true) return httpApi;
    return (idbOk === false) ? memApi : idb;
  }

  /* Anything already sitting in IndexedDB from before the on-disk library
     existed is copied up to it, once -- so switching to the new backend
     never looks like the files vanished. Best-effort: a failure here just
     leaves those files reachable the old way (IndexedDB) instead of
     blocking startup. */
  function migrateToLibrary() {
    if (!w.indexedDB) return Promise.resolve(0);
    return idb.listAll().then(function (rows) {
      if (!rows.length) return 0;
      return libList().then(function (already) {
        var have = Object.create(null);
        already.forEach(function (r) { have[r.id] = 1; });
        var todo = rows.filter(function (r) { return !have[r.id]; });
        if (!todo.length) return 0;
        // Sequential, not parallel -- serve.py handles one request at a time,
        // and these can each be a large file.
        return todo.reduce(function (p, row) {
          return p.then(function (n) {
            return idb.get(row.id).then(function (full) {
              if (!full || !full.blob) return n;
              return httpApi.put(full).then(function () { return n + 1; });
            });
          });
        }, Promise.resolve(0));
      });
    }).catch(function () { return 0; });
  }

  /* Probes the on-disk library first, then IndexedDB as a fallback (open
     from file://, or serve.py not running). Resolves true when LOCAL file
     persistence works either way; migratedCount() reports what moved over.

     The promise is memoised, not just the result: two callers arriving
     before the first probe settles used to each see "not decided yet" and
     race ahead on whichever backend happened to be the default, so the same
     file could be looked for in the wrong store. */
  var lastMigrated = 0, probePromise = null;
  function checkPersistence() {
    if (probePromise) return probePromise;
    if (w.location.protocol === 'file:') {
      httpOk = false;
      probePromise = probeIdb();
      return probePromise;
    }
    // A 200 is not enough on its own: a stale server (or anything that
    // answers with the app's own HTML) would look like a working library and
    // then read back as empty. It only counts if it really is the index.
    //
    // A 401 here is not proof the server is unreachable -- the opposite: a
    // real HTTP response, even a rejecting one, only comes from a server
    // that is there and answering. But it also is not proof the on-disk
    // library is USABLE right now: the very first call through here can be
    // the login gate painting an account's avatar before anyone has signed
    // in at all, when a 401 is simply the truth, not a race. So a 401 gets
    // one retry after a beat (covers a session cookie set moments ago by a
    // real sign-in that has not reached this exact request yet), and if it
    // is still 401, this decides the on-disk store is not usable FOR NOW and
    // falls back to IndexedDB for this call -- but does not memoise that as
    // the answer for the rest of the page's life, so the next call (e.g.
    // right after that real sign-in completes) probes fresh instead of being
    // stuck on a verdict made before anyone had a session. Getting this
    // wrong used to be a real trap either way: treating every 401 as
    // "unreachable forever" silently ran the whole tab off browser storage
    // with nothing on screen saying so; treating it as "authenticated" threw
    // the login gate itself into a lock()-triggered reload loop.
    var wasUnauth = false;
    var attempt = function (retryOn401) {
      return fetch(LIB, { cache: 'no-store' }).then(function (r) {
        if (r.status === 401 && retryOn401) {
          return new Promise(function (res) { setTimeout(res, 300); })
            .then(function () { return attempt(false); });
        }
        if (r.status === 401) { wasUnauth = true; return null; }
        return r.ok ? r.json() : null;
      });
    };
    probePromise = attempt(true)
      .then(function (j) { return !!(j && Array.isArray(j.files)); })
      .catch(function () { return false; })
      .then(function (ok) {
        httpOk = ok;
        if (wasUnauth) probePromise = null;
        if (!ok) return probeIdb();
        return migrateToLibrary().then(function (n) { lastMigrated = n; return true; });
      });
    return probePromise;
  }
  function probeIdb() {
    if (!w.indexedDB) { idbOk = false; return Promise.resolve(false); }
    return openDB().then(function () { idbOk = true; return true; })
      .catch(function () { idbOk = false; dbPromise = null; return false; });
  }
  function migratedCount() { return lastMigrated; }

  function uid() {
    if (w.crypto && w.crypto.randomUUID) return w.crypto.randomUUID();
    return 'f-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* Every file operation waits for the backend to actually be decided.
     Without this, anything that ran during start-up (opening a dashboard
     straight from a #/d/... link, say) picked a backend while the probe was
     still in flight and could read from IndexedDB while everything after it
     wrote to disk -- the same file present or missing depending on which
     call won. checkPersistence() is memoised, so this costs one microtask. */
  function on(fn) { return checkPersistence().then(fn); }

  var Files = {
    add: function (dashboardId, file, headers) {
      var rec = { id: uid(), dashboardId: dashboardId, name: file.name || 'untitled',
                  size: file.size || 0, type: file.type || '', addedAt: Date.now(),
                  updatedAt: Date.now(), headers: headers || [], blob: file };
      return on(function () {
        var chosen = backend();
        return chosen.put(rec).catch(function (e) {
          // The probe decided once, at start-up, that the on-disk store was
          // reachable and never reconsidered. Close the server window after
          // that and every attach failed with a bare "Failed to fetch", and
          // the file went nowhere at all. Keep it in the browser instead,
          // and stop claiming the disk is available.
          if (chosen !== httpApi || !netFail(e)) throw e;
          httpOk = false;
          probePromise = null;
          var fallback = (idbOk === false) ? memApi : idb;
          return fallback.put(rec).then(function (m) {
            m = Object.assign({}, m);
            m.keptInBrowser = true;      // the caller says so; losing it silently is the bug
            return m;
          });
        });
      });
    },
    list: function (d) { return on(function () { return backend().list(d); }).catch(function () { return []; }); },
    /* Every attached file, whichever section it went into. The auto-fill
       needs this: a register dropped into its own section is still a file
       the dashboards should be offered. */
    listAll: function () { return on(function () { return backend().listAll(); }).catch(function () { return []; }); },
    counts: function () { return on(function () { return backend().counts(); }).catch(function () { return {}; }); },
    blob: function (id) { return on(function () { return backend().get(id); }).then(function (r) { return r ? r.blob : null; }); },
    remove: function (id) { return on(function () { return backend().del(id); }); },
    rename: function (id, n) { return on(function () { return backend().rename(id, n); }); },
    clearAll: function () { return on(function () { return backend().clearAll(); }); },
    persistent: function () { return mode === 'local' && (httpOk === true || idbOk === true); },
    onDisk: function () { return httpOk === true; }
  };

  w.Store = {
    MODE_KEY: MODE_KEY,
    getMode: getMode, setMode: setMode, readStoredMode: readStoredMode,
    loadPrefs: loadPrefs, getPref: getPref, setPref: setPref, clearPrefs: clearPrefs,
    checkPersistence: checkPersistence,
    idbAvailable: function () { return (httpOk === true) ? true : idbOk; },
    migratedCount: migratedCount,
    Files: Files
  };
})(window);
