/* PBKDF2-HMAC-SHA256, offline, no dependencies.
 *
 * Uses the browser's Web Crypto when it is available (fast, native) and falls
 * back to the pure-JS implementation below otherwise — crypto.subtle is absent
 * in non-secure contexts, and this app has to work from a plain file:// path.
 * Both paths produce byte-identical output, and both match Python's
 * hashlib.pbkdf2_hmac, which is what set_password.py uses to write the hash. */
(function (w) {
  'use strict';

  /* ---- SHA-256 ---------------------------------------------------------- */
  var K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];

  function sha256(bytes) {
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var len = bytes.length;
    var withPad = ((len + 8) >> 6 << 4) + 16;
    var msg = new Uint8Array(withPad * 4);
    msg.set(bytes);
    msg[len] = 0x80;
    var bits = len * 8;
    var dv = new DataView(msg.buffer);
    dv.setUint32(msg.length - 4, bits >>> 0);
    dv.setUint32(msg.length - 8, Math.floor(bits / 4294967296));

    var wds = new Uint32Array(64);
    for (var off = 0; off < msg.length; off += 64) {
      for (var i = 0; i < 16; i++) wds[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var g0 = wds[i - 15], g1 = wds[i - 2];
        var s0 = ((g0 >>> 7) | (g0 << 25)) ^ ((g0 >>> 18) | (g0 << 14)) ^ (g0 >>> 3);
        var s1 = ((g1 >>> 17) | (g1 << 15)) ^ ((g1 >>> 19) | (g1 << 13)) ^ (g1 >>> 10);
        wds[i] = (wds[i - 16] + s0 + wds[i - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + wds[i]) >>> 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var mj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = new Uint8Array(32), ov = new DataView(out.buffer);
    for (i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
    return out;
  }

  /* ---- HMAC-SHA256 ------------------------------------------------------- */
  function hmac(key, msg) {
    if (key.length > 64) key = sha256(key);
    var k = new Uint8Array(64); k.set(key);
    var ip = new Uint8Array(64 + msg.length), op = new Uint8Array(64 + 32);
    for (var i = 0; i < 64; i++) { ip[i] = k[i] ^ 0x36; op[i] = k[i] ^ 0x5c; }
    ip.set(msg, 64);
    op.set(sha256(ip), 64);
    return sha256(op);
  }

  /* ---- PBKDF2-HMAC-SHA256, 32-byte output --------------------------------
     The loop below runs 250,000 times with the same key over a 32-byte
     message. Calling hmac() for each one rebuilt the key's inner and outer
     pads and allocated three fresh buffers every time -- on the order of two
     million throwaway arrays per sign-in, which is most of the cost whenever
     crypto.subtle is unavailable (a plain-http hostname is not a "secure
     context", so the friendly address falls back to this path).

     The pads depend only on the key, so they are built once and the two
     scratch buffers reused. The arithmetic is unchanged and the output is
     byte-identical to the previous version and to Python's hashlib. */
  function pbkdf2Js(pw, salt, iters) {
    var block = new Uint8Array(salt.length + 4);
    block.set(salt); block[salt.length + 3] = 1;          // INT(1), dkLen == hLen
    var u = hmac(pw, block), acc = u.slice();

    var key = pw.length > 64 ? sha256(pw) : pw;
    var ipad = new Uint8Array(96), opad = new Uint8Array(96);   // 64-byte pad + 32-byte digest
    for (var i = 0; i < 64; i++) {
      var kb = i < key.length ? key[i] : 0;
      ipad[i] = kb ^ 0x36;
      opad[i] = kb ^ 0x5c;
    }

    for (i = 1; i < iters; i++) {
      ipad.set(u, 64);
      opad.set(sha256(ipad), 64);
      u = sha256(opad);
      for (var j = 0; j < 32; j++) acc[j] ^= u[j];
    }
    return acc;
  }

  function utf8(s) {
    if (w.TextEncoder) return new TextEncoder().encode(s);
    var out = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 128) out.push(c);
      else if (c < 2048) out.push(192 | (c >> 6), 128 | (c & 63));
      else out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function hex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }
  function unhex(s) {
    var out = new Uint8Array(s.length >> 1);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  function derive(password, saltHex, iterations) {
    var pw = utf8(password), salt = unhex(saltHex);
    var subtle = w.crypto && w.crypto.subtle;
    if (subtle && subtle.importKey) {
      return subtle.importKey('raw', pw, { name: 'PBKDF2' }, false, ['deriveBits'])
        .then(function (key) {
          return subtle.deriveBits(
            { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' }, key, 256);
        })
        .then(function (bits) { return hex(new Uint8Array(bits)); })
        .catch(function () { return hex(pbkdf2Js(pw, salt, iterations)); });
    }
    return Promise.resolve(hex(pbkdf2Js(pw, salt, iterations)));
  }

  /* Constant-time-ish compare: never bail early on the first differing byte. */
  function equal(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  w.ParasCrypto = { derive: derive, equal: equal, hex: hex, sha256: sha256, _pbkdf2Js: function (p, s, i) {
    return hex(pbkdf2Js(utf8(p), unhex(s), i));
  } };
})(window);
