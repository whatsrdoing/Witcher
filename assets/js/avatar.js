/* ==========================================================================
   ACCOUNT PHOTO
   A per-account picture, looked up in two places so there are two ways to
   set one:

     1. a file sitting in assets/img/avatars/<login-slug>.<ext> — drop it in
        next to index.html and it is picked up on the next load, no UI needed;
     2. a picture chosen from the account menu, which is stored in the same
        server-backed folder as everything else (data/library) so it survives
        a browser reset and follows the account to any browser on this machine.

   (2) wins when both exist: an explicit choice made just now should beat a
   file that has been sitting in the folder since install.

   Nothing here touches auth.json. A photo is not a credential, and auth.json
   is small and hand-editable on purpose — a few hundred KB of base64 in the
   middle of it would wreck both properties.
   ========================================================================== */
(function (w) {
  'use strict';

  var STATIC_DIR = 'assets/img/avatars/';
  var EXTS = ['png', 'jpg', 'jpeg', 'webp'];
  var MAX = 512;            // stored square, in px — plenty for a 96px display
  var PREFIX = 'avatar:';   // dashboardId namespace; libraryFiles() ignores it

  var cache = {};           // slug -> { url, owned } ; owned = we made the object URL
  var pending = {};         // slug -> Promise, so N renders share one lookup

  function slug(login) {
    return String(login || 'user').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 60) || 'user';
  }

  function initials(who) {
    var s = (who && (who.name || who.login)) || '';
    var parts = s.replace(/[^A-Za-z ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function bin(login) { return PREFIX + slug(login); }

  /* ---- the stored copy --------------------------------------------------- */
  function storedRec(login) {
    if (!w.Store || !w.Store.Files) return Promise.resolve(null);
    var id = bin(login);
    return w.Store.Files.listAll().then(function (rows) {
      var mine = rows.filter(function (r) { return r.dashboardId === id; });
      // Newest wins; set() prunes older ones, but a crash mid-replace could
      // leave two behind and a stale face is worse than a wasted read.
      mine.sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
      return mine[0] || null;
    }).catch(function () { return null; });
  }

  /* ---- the drop-in file -------------------------------------------------- */
  function staticUrl(login) {
    var base = STATIC_DIR + slug(login) + '.';
    var i = 0;
    return (function next() {
      if (i >= EXTS.length) return Promise.resolve(null);
      var url = base + EXTS[i++];
      return fetch(url, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) return next();
        var t = r.headers.get('content-type') || '';
        // A dev server that answers 200-with-index.html for anything missing
        // would otherwise hand us a page and we would render a broken image.
        if (t && t.indexOf('image/') !== 0) return next();
        return url;
      }).catch(next);
    })();
  }

  function release(s) {
    var c = cache[s];
    if (c && c.owned && c.url) { try { URL.revokeObjectURL(c.url); } catch (e) {} }
    delete cache[s];
  }

  /* Resolve to a URL for this login's picture, or null if there isn't one. */
  function get(login) {
    var s = slug(login);
    if (cache[s]) return Promise.resolve(cache[s].url);
    if (pending[s]) return pending[s];
    pending[s] = storedRec(login).then(function (rec) {
      if (!rec) return null;
      return w.Store.Files.blob(rec.id).then(function (b) {
        return b ? { url: URL.createObjectURL(b), owned: true } : null;
      }).catch(function () { return null; });
    }).then(function (hit) {
      if (hit) return hit;
      return staticUrl(login).then(function (u) { return u ? { url: u, owned: false } : null; });
    }).then(function (hit) {
      delete pending[s];
      if (!hit) return null;
      cache[s] = hit;
      return hit.url;
    }).catch(function () { delete pending[s]; return null; });
    return pending[s];
  }

  /* ---- downscale before storing ------------------------------------------
     A phone photo is several MB. Stored as-is it bloats the data folder and
     costs a decode on every sign-in, for a picture shown at 96px at most.
     Square-crop from the centre so a portrait doesn't end up squashed. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var side = Math.min(img.naturalWidth, img.naturalHeight);
          var out = Math.min(side, MAX);
          var cv = document.createElement('canvas');
          cv.width = cv.height = out;
          var cx = cv.getContext('2d');
          cx.imageSmoothingQuality = 'high';
          cx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2,
                       side, side, 0, 0, out, out);
          URL.revokeObjectURL(url);
          // PNG keeps a transparent cut-out clean; a photo that big in PNG is
          // wasteful, so only keep PNG when the source actually had alpha.
          var wantPng = /png|webp/i.test(file.type || '');
          cv.toBlob(function (b) {
            if (!b) return reject(new Error('Could not read that image.'));
            resolve(b);
          }, wantPng ? 'image/png' : 'image/jpeg', wantPng ? undefined : 0.9);
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('That file is not an image the browser can read.'));
      };
      img.src = url;
    });
  }

  function set(login, file) {
    if (!file) return Promise.reject(new Error('No file chosen.'));
    if (file.type && file.type.indexOf('image/') !== 0) {
      return Promise.reject(new Error('Choose an image file (PNG, JPG or WEBP).'));
    }
    var s = slug(login), id = bin(login);
    return shrink(file).then(function (blob) {
      var ext = /png/i.test(blob.type) ? 'png' : 'jpg';
      var named = new File([blob], s + '.' + ext, { type: blob.type });
      return w.Store.Files.add(id, named);
    }).then(function (meta) {
      // Drop the previous copies only once the new one is safely written.
      return w.Store.Files.listAll().then(function (rows) {
        var old = rows.filter(function (r) { return r.dashboardId === id && r.id !== meta.id; });
        return Promise.all(old.map(function (r) {
          return w.Store.Files.remove(r.id).catch(function () {});
        }));
      }).catch(function () {}).then(function () {
        release(s);
        return meta;
      });
    });
  }

  function clear(login) {
    var s = slug(login), id = bin(login);
    return w.Store.Files.listAll().then(function (rows) {
      return Promise.all(rows.filter(function (r) { return r.dashboardId === id; })
        .map(function (r) { return w.Store.Files.remove(r.id).catch(function () {}); }));
    }).catch(function () {}).then(function () { release(s); });
  }

  /* Paint one <span class="avatar"> — photo if there is one, initials if not.
     Initials go in first so the element is never blank while the lookup runs. */
  function paint(el, who) {
    if (!el) return Promise.resolve(null);
    var ini = initials(who);
    el.textContent = ini;
    el.setAttribute('data-initials', ini);
    el.classList.remove('has-photo');
    if (!who) return Promise.resolve(null);
    return get(who.login).then(function (url) {
      if (!url) { el.style.backgroundImage = ''; return null; }
      el.style.backgroundImage = 'url("' + url + '")';
      el.classList.add('has-photo');
      el.textContent = '';
      return url;
    });
  }

  w.Avatar = { get: get, set: set, clear: clear, paint: paint,
               initials: initials, slug: slug, dir: STATIC_DIR };
})(window);
