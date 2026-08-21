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
  var DB_VER = 1;
  var STORE = 'files';

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
  var LS_OK = !!(w.localStorage && probe(w.localStorage));

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
  var dbPromise = null, idbOk = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (res, rej) {
      var req;
      try { req = w.indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { return rej(e); }
      if (!req) return rej(new Error('IndexedDB unavailable'));
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('dashboardId', 'dashboardId', { unique: false });
        }
      };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error || new Error('IndexedDB open failed')); };
      req.onblocked = function () { rej(new Error('IndexedDB blocked')); };
    });
    return dbPromise;
  }

  function tx(mode2, fn) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(STORE, mode2);
        var out;
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error || new Error('aborted')); };
        out = fn(t.objectStore(STORE), function (v) { out = v; });
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
    put: function (rec) { return tx('readwrite', function (os, set) { os.put(rec); set(meta(rec)); }); },
    get: function (id) { return tx('readonly', function (os, set) { var r = os.get(id); r.onsuccess = function () { set(r.result || null); }; }); },
    del: function (id) { return tx('readwrite', function (os) { os.delete(id); }); },
    rename: function (id, name) {
      return tx('readwrite', function (os, set) {
        var r = os.get(id);
        r.onsuccess = function () {
          var v = r.result; if (!v) return set(null);
          v.name = name; v.updatedAt = Date.now(); os.put(v); set(meta(v));
        };
      });
    },
    clearAll: function () { return tx('readwrite', function (os) { os.clear(); }); }
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
             type: r.type, addedAt: r.addedAt, updatedAt: r.updatedAt };
  }

  /* ---- backend selection -------------------------------------------------- */
  function backend() {
    if (mode === 'session') return memApi;
    return (idbOk === false) ? memApi : idb;
  }

  /* Probes IndexedDB once. Resolves true when LOCAL file persistence works. */
  function checkPersistence() {
    if (idbOk !== null) return Promise.resolve(idbOk);
    if (!w.indexedDB) { idbOk = false; return Promise.resolve(false); }
    return openDB().then(function () { idbOk = true; return true; })
      .catch(function () { idbOk = false; dbPromise = null; return false; });
  }

  function uid() {
    if (w.crypto && w.crypto.randomUUID) return w.crypto.randomUUID();
    return 'f-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  var Files = {
    add: function (dashboardId, file) {
      var rec = { id: uid(), dashboardId: dashboardId, name: file.name || 'untitled',
                  size: file.size || 0, type: file.type || '', addedAt: Date.now(),
                  updatedAt: Date.now(), blob: file };
      return backend().put(rec);
    },
    list: function (d) { return backend().list(d).catch(function () { return []; }); },
    counts: function () { return backend().counts().catch(function () { return {}; }); },
    blob: function (id) { return backend().get(id).then(function (r) { return r ? r.blob : null; }); },
    remove: function (id) { return backend().del(id); },
    rename: function (id, n) { return backend().rename(id, n); },
    clearAll: function () { return backend().clearAll(); },
    clearPersisted: function () { return idb.clearAll().catch(function () {}); },
    persistent: function () { return mode === 'local' && idbOk === true; }
  };

  w.Store = {
    MODE_KEY: MODE_KEY,
    getMode: getMode, setMode: setMode, readStoredMode: readStoredMode,
    loadPrefs: loadPrefs, getPref: getPref, setPref: setPref, clearPrefs: clearPrefs,
    checkPersistence: checkPersistence,
    localStorageOk: function () { return LS_OK; },
    idbAvailable: function () { return idbOk; },
    Files: Files
  };
})(window);
