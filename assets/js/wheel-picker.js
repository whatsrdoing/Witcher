/* Apple-style wheel picker -- a physical, momentum-driven replacement for
 * the browser's native <select> popup, applied by *enhancing* the real
 * <select> in place rather than replacing it.
 *
 * Why enhance instead of rebuild: the real <select> stays exactly where it
 * is, keeps its id, keeps rendering the current value in its own box (its
 * existing CSS already does that -- see .gate-field select), and stays the
 * single source of truth for the field's value. This file only intercepts
 * the moment that would normally pop the native OS dropdown open and
 * substitutes this wheel for it; on a pick, it sets select.value and fires
 * a real 'change' event, so every existing bit of logic that reads that
 * value or listens for that event (gate.js's submit-enable checks, the
 * signup/edit-profile POST bodies, form validation) needs zero changes.
 * "designation" still ends up exactly "Manager", never something new.
 *
 * Deliberately no infinite wraparound: every list this drives today
 * (designation, department, category) is a short, finite, non-cyclic
 * list -- there's no real sense in which "MD" comes after "Assistant
 * Manager". Real iOS pickers don't loop non-cyclic lists either (a
 * contact picker doesn't wrap); a cyclic list (hours, minutes) would
 * warrant it, but nothing in this app is one today. Edges get a soft
 * rubber-band resistance instead, which is the same physical honesty
 * applied to a bounded list.
 *
 * Physics model: `position` is a continuous float (the fractional index
 * currently centered). Dragging maps pointer delta to position 1:1;
 * releasing computes velocity from the last few samples and hands off to
 * a friction-decayed momentum loop, which yields to a spring-eased snap
 * once it's slow enough or past the edge. Every frame only ever touches
 * transform/opacity (plus a touch of filter) on a small, fixed set of
 * already-created row elements -- nothing is re-created or measured
 * mid-drag, and rAF only runs while something is actually moving. */
(function (w, d) {
  'use strict';

  var ITEM_H = 40;
  var VISIBLE = 7;                       // odd, so one row sits dead center
  var HALF = (VISIBLE - 1) / 2;
  // The viewport's own height (VISIBLE*ITEM_H) genuinely clips anything
  // past +/-VISIBLE/2 rows via overflow:hidden -- a row rendered "visible"
  // by this file's own opacity math past that line would just be an
  // invisible, but still hit-testable, dead zone. CLICKABLE sits a little
  // inside the real clip line so nothing sits half-cut-off and tappable.
  var CLIP = VISIBLE / 2;
  var CLICKABLE = CLIP - 0.3;
  var FRICTION = 0.94;                   // per ~16.7ms frame
  var MIN_VELOCITY = 0.02;               // index-units/frame -- below this, snap takes over
  var RUBBER = 0.32;                     // how much a drag past an edge actually moves the wheel
  // None of this file's motion runs through CSS, so the app's global
  // prefers-reduced-motion rule (which only shortens CSS animation/
  // transition durations) never reaches it -- handled explicitly instead:
  // snapping still happens (the value still needs to land somewhere), it
  // just doesn't animate there, and a release never coasts on momentum.
  var REDUCE_MOTION = !!(w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var SNAP_MS = REDUCE_MOTION ? 1 : 260;

  var $ = function (s, r) { return (r || d).querySelector(s); };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // cubic ease-out -- strong, no overshoot; matches the rest of the app's
  // deliberate avoidance of bounce on anything that isn't a gesture.
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  var active = null;   // the currently-open picker's own state object, or null

  function buildPop() {
    var pop = d.createElement('div');
    pop.className = 'wheel-pop';
    pop.setAttribute('role', 'listbox');
    pop.innerHTML =
      '<div class="wheel-viewport">' +
        '<div class="wheel-band" aria-hidden="true"></div>' +
        '<div class="wheel-track"></div>' +
        '<div class="wheel-fade wheel-fade-top" aria-hidden="true"></div>' +
        '<div class="wheel-fade wheel-fade-bot" aria-hidden="true"></div>' +
      '</div>';
    d.body.appendChild(pop);
    return pop;
  }

  var sharedPop = null;

  function optionsOf(selectEl) {
    var out = [];
    for (var i = 0; i < selectEl.options.length; i++) {
      var o = selectEl.options[i];
      if (o.disabled) continue;
      out.push({ value: o.value, text: o.textContent });
    }
    return out;
  }

  function State(selectEl) {
    this.select = selectEl;
    this.items = [];
    this.rows = [];
    this.position = 0;
    this.target = 0;            // intended index, tracked apart from the mid-animation position
    this.startPosition = 0;
    this.startY = 0;
    this.dragging = false;
    this.moved = false;
    this.samples = [];          // [{t, pos}, ...] for velocity on release
    this.raf = null;
    this.snapAnim = null;
    this.pointerId = null;
    this.originalValue = selectEl.value;
  }

  function currentIndex(st) {
    var v = st.select.value;
    for (var i = 0; i < st.items.length; i++) if (st.items[i].value === v) return i;
    return 0;
  }

  function render(st) {
    var pos = st.position;
    for (var i = 0; i < st.rows.length; i++) {
      var row = st.rows[i];
      var idx = row._idx;
      if (idx < 0 || idx >= st.items.length) { row.style.opacity = '0'; row.style.pointerEvents = 'none'; continue; }
      var dist = idx - pos;
      var absDist = Math.abs(dist);
      if (absDist > CLIP) { row.style.opacity = '0'; row.style.pointerEvents = 'none'; continue; }
      row.style.pointerEvents = absDist > CLICKABLE ? 'none' : 'auto';
      var y = dist * ITEM_H;
      var scale = clamp(1 - absDist * 0.1, 0.72, 1);
      // Floors at .16, not 0 -- a real picker's outer rows stay legible
      // enough to read "there's more here", they don't vanish by the
      // third row out.
      var opacity = clamp(1 - absDist * 0.16, 0.16, 1);
      var rot = clamp(dist * 11, -50, 50);
      var blur = absDist > 2.2 ? Math.min(1, (absDist - 2.2) * 1.2) : 0;
      row.style.transform = 'translate3d(0,' + y.toFixed(2) + 'px,0) rotateX(' + rot.toFixed(1) + 'deg) scale(' + scale.toFixed(3) + ')';
      row.style.opacity = opacity.toFixed(3);
      row.style.filter = blur ? 'blur(' + blur.toFixed(2) + 'px)' : '';
      row.classList.toggle('wp-center', absDist < 0.5);
    }
  }

  function layoutRows(st) {
    var track = st.pop.querySelector('.wheel-track');
    track.innerHTML = '';
    st.rows = [];
    // No per-row click listeners: setPointerCapture on the viewport (see
    // onPointerDown) retargets the click event that follows a tap to the
    // capturing element itself, not whatever was actually under the
    // finger -- a real, documented Pointer Events quirk, not a maybe.
    // Taps are handled entirely in onPointerUp instead, from the pointer's
    // own release coordinates, which capture does NOT touch.
    var count = st.items.length;
    for (var i = 0; i < count; i++) {
      var row = d.createElement('button');
      row.type = 'button';
      row.className = 'wheel-row';
      row.tabIndex = -1;
      row.textContent = st.items[i].text;
      row.setAttribute('role', 'option');
      row._idx = i;
      track.appendChild(row);
      st.rows.push(row);
    }
  }

  function stopAnim(st) {
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = null; }
    if (st.snapAnim) { cancelAnimationFrame(st.snapAnim); st.snapAnim = null; }
  }

  function momentumStep(st, velocity) {
    stopAnim(st);
    var last = performance.now();
    function frame(now) {
      var dt = Math.min(2, (now - last) / 16.7); last = now;
      velocity *= Math.pow(FRICTION, dt);
      st.position += velocity * dt;
      var min = 0, max = st.items.length - 1;
      if (st.position < min) { st.position = min + (st.position - min) * 0.4; velocity *= 0.5; }
      if (st.position > max) { st.position = max + (st.position - max) * 0.4; velocity *= 0.5; }
      render(st);
      if (Math.abs(velocity) > MIN_VELOCITY) {
        st.raf = requestAnimationFrame(frame);
      } else {
        st.raf = null;
        // The gesture is genuinely over now -- same as picking a row by
        // hand, this commits the settled value and closes.
        commit(st, Math.round(clamp(st.position, min, max)), true);
      }
    }
    st.raf = requestAnimationFrame(frame);
  }

  function snapTo(st, targetIdx, onDone) {
    stopAnim(st);
    targetIdx = clamp(targetIdx, 0, st.items.length - 1);
    var from = st.position, to = targetIdx, start = performance.now();
    if (Math.abs(from - to) < 0.001) { render(st); if (onDone) onDone(); return; }
    function frame(now) {
      var t = clamp((now - start) / SNAP_MS, 0, 1);
      st.position = from + (to - from) * easeOutCubic(t);
      render(st);
      if (t < 1) {
        st.snapAnim = requestAnimationFrame(frame);
      } else {
        st.snapAnim = null;
        st.position = to;
        render(st);
        if (onDone) onDone();
      }
    }
    st.snapAnim = requestAnimationFrame(frame);
  }

  function commit(st, idx, closeAfter) {
    idx = clamp(idx, 0, st.items.length - 1);
    st.target = idx;
    snapTo(st, idx, function () {
      var item = st.items[idx];
      if (st.select.value !== item.value) {
        st.select.value = item.value;
        st.select.dispatchEvent(new Event('input', { bubbles: true }));
        st.select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      var row = st.rows[idx];
      if (row) {
        row.classList.add('wp-confirm');
        setTimeout(function () { row.classList.remove('wp-confirm'); }, 200);
      }
      if (closeAfter) setTimeout(function () { close(true); }, 130);
    });
  }

  function position(st) {
    var rect = st.select.getBoundingClientRect();
    var pop = st.pop;
    pop.style.visibility = 'hidden';
    pop.style.display = 'block';
    var popH = pop.offsetHeight, popW = Math.max(rect.width, 220);
    pop.style.width = popW + 'px';
    var spaceBelow = w.innerHeight - rect.bottom;
    var top;
    if (spaceBelow >= popH + 10 || spaceBelow >= rect.top) {
      top = Math.min(rect.bottom + 8, w.innerHeight - popH - 8);
    } else {
      top = Math.max(8, rect.top - popH - 8);
    }
    var left = clamp(rect.left, 8, w.innerWidth - popW - 8);
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
    pop.style.visibility = '';
  }

  function onPointerDown(st, e) {
    stopAnim(st);
    st.dragging = true;
    st.moved = false;
    st.pointerId = e.pointerId;
    st.startY = e.clientY;
    st.startPosition = st.position;
    st.samples = [{ t: performance.now(), pos: st.position }];
    try { st.pop.querySelector('.wheel-viewport').setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
  }

  function onPointerMove(st, e) {
    if (!st.dragging || e.pointerId !== st.pointerId) return;
    var dy = st.startY - e.clientY;
    if (Math.abs(dy) > 3) st.moved = true;
    var raw = st.startPosition + dy / ITEM_H;
    var min = 0, max = st.items.length - 1;
    if (raw < min) raw = min - (min - raw) * RUBBER;
    if (raw > max) raw = max + (raw - max) * RUBBER;
    st.position = raw;
    st.samples.push({ t: performance.now(), pos: raw });
    if (st.samples.length > 6) st.samples.shift();
    render(st);
    e.preventDefault();
  }

  function onPointerUp(st, e) {
    if (!st.dragging || e.pointerId !== st.pointerId) return;
    st.dragging = false;
    var now = performance.now();
    var recent = st.samples.filter(function (s) { return now - s.t < 120; });
    var velocity = 0;
    if (recent.length >= 2) {
      var a = recent[0], b = recent[recent.length - 1];
      var dt = (b.t - a.t) / 16.7;
      if (dt > 0.001) velocity = (b.pos - a.pos) / dt;
    }
    if (!st.moved) {
      // A tap: figure out which row is under the release point directly
      // from its coordinates, rather than the click event that follows --
      // setPointerCapture retargets that click's `target` to the capturing
      // viewport itself, not the row, so it can't be trusted here.
      var rect = st.pop.querySelector('.wheel-viewport').getBoundingClientRect();
      var localY = e.clientY - rect.top - rect.height / 2;
      var tapped = Math.round(st.position + localY / ITEM_H);
      commit(st, clamp(tapped, 0, st.items.length - 1), true);
      return;
    }
    // The gesture is over -- whatever it settles on is the pick, exactly
    // like letting go of a real wheel, so this always commits, never a
    // bare reposition.
    if (!REDUCE_MOTION && Math.abs(velocity) > MIN_VELOCITY) momentumStep(st, velocity);
    else commit(st, Math.round(clamp(st.position, 0, st.items.length - 1)), true);
  }

  function onWheelEvent(st, e) {
    e.preventDefault();
    stopAnim(st);
    var max = st.items.length - 1;
    st.position = clamp(st.position + e.deltaY / 90, -0.6, max + 0.6);
    render(st);
    clearTimeout(st.wheelIdle);
    st.wheelIdle = setTimeout(function () {
      commit(st, Math.round(clamp(st.position, 0, max)), true);
    }, 110);
  }

  function onKeyDown(st, e) {
    if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
    if (e.key === 'Enter') { e.preventDefault(); commit(st, st.target, true); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      // Tracked separately from the animating `position` so two quick
      // presses land two rows apart, not wherever the first press's
      // still-in-flight animation happened to be at the moment of the
      // second keydown.
      st.target = clamp(st.target - 1, 0, st.items.length - 1);
      snapTo(st, st.target);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      st.target = clamp(st.target + 1, 0, st.items.length - 1);
      snapTo(st, st.target);
      return;
    }
  }

  function onOutside(e) {
    if (!active) return;
    if (active.pop.contains(e.target) || e.target === active.select) return;
    close(false);
  }

  function open(selectEl) {
    if (active && active.select === selectEl) return;
    if (active) close(false);

    var items = optionsOf(selectEl);
    if (!items.length) return;

    if (!sharedPop) sharedPop = buildPop();
    var st = new State(selectEl);
    st.items = items;
    st.pop = sharedPop;
    active = st;

    layoutRows(st);
    var idx = currentIndex(st);
    st.position = idx;
    st.target = idx;
    position(st);
    render(st);

    var viewport = st.pop.querySelector('.wheel-viewport');
    st._onDown = function (e) { onPointerDown(st, e); };
    st._onMove = function (e) { onPointerMove(st, e); };
    st._onUp = function (e) { onPointerUp(st, e); };
    st._onWheel = function (e) { onWheelEvent(st, e); };
    st._onKey = function (e) { onKeyDown(st, e); };
    st._onOutside = onOutside;

    viewport.addEventListener('pointerdown', st._onDown);
    viewport.addEventListener('pointermove', st._onMove);
    viewport.addEventListener('pointerup', st._onUp);
    viewport.addEventListener('pointercancel', st._onUp);
    viewport.addEventListener('wheel', st._onWheel, { passive: false });
    d.addEventListener('keydown', st._onKey, true);
    d.addEventListener('pointerdown', st._onOutside, true);

    requestAnimationFrame(function () { st.pop.classList.add('open'); });
    selectEl.setAttribute('aria-expanded', 'true');
  }

  function close(committed) {
    var st = active;
    if (!st) return;
    active = null;
    stopAnim(st);
    clearTimeout(st.wheelIdle);
    if (!committed) st.select.value = st.originalValue;
    st.select.setAttribute('aria-expanded', 'false');
    var viewport = st.pop.querySelector('.wheel-viewport');
    viewport.removeEventListener('pointerdown', st._onDown);
    viewport.removeEventListener('pointermove', st._onMove);
    viewport.removeEventListener('pointerup', st._onUp);
    viewport.removeEventListener('pointercancel', st._onUp);
    viewport.removeEventListener('wheel', st._onWheel);
    d.removeEventListener('keydown', st._onKey, true);
    d.removeEventListener('pointerdown', st._onOutside, true);
    st.pop.classList.remove('open');
    setTimeout(function () {
      if (!active || active.pop !== st.pop) st.pop.style.display = 'none';
    }, 220);
  }

  function enhance(selectEl) {
    if (!selectEl || selectEl._wheelEnhanced) return;
    selectEl._wheelEnhanced = true;
    selectEl.setAttribute('aria-haspopup', 'listbox');
    selectEl.setAttribute('aria-expanded', 'false');
    selectEl.addEventListener('mousedown', function (e) {
      e.preventDefault();
      selectEl.focus();
      open(selectEl);
    });
    selectEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(selectEl);
      }
      // ArrowUp/ArrowDown deliberately left alone: the native <select>
      // already cycles its own value on those with no popup involved,
      // which is correct keyboard behaviour on its own and needs nothing
      // from this file to keep working.
    });
  }

  function enhanceAll(selector) {
    var els = d.querySelectorAll(selector);
    for (var i = 0; i < els.length; i++) enhance(els[i]);
  }

  w.ParasWheelPicker = { enhance: enhance, enhanceAll: enhanceAll };

  // Self-wiring, same as every other per-feature file in this app (ask.js,
  // admin-overlay.js, ...): signup's own three fields first, then the
  // other selects that are genuinely the same kind of short, static-choice
  // control (the admin panel's edit-profile mirrors, and the feedback
  // form's category picker). Deliberately not the data-import wizard's
  // selects (sheet/section/part/month/year) -- those are populated from
  // whatever a spreadsheet happens to contain at import time, a different
  // enough shape of control that it deserves its own look before wiring
  // this in, rather than folding it in unreviewed.
  function wireDefaults() {
    enhanceAll('#signupDesignation, #signupDepartment, #signupCategory, ' +
               '#editProfileDesignation, #editProfileDepartment, #editProfileCategory, ' +
               '#raiseCategory');
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', wireDefaults);
  else wireDefaults();
})(window, document);
