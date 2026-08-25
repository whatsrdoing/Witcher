/* ==========================================================================
   GRABBABLE SHEET
   Turns the Data Library drawer from something that plays a 300ms canned
   transition into something you can push around.

   It watches the .open class rather than replacing openDrawer()/closeDrawer(),
   so every existing caller -- the toolbar button, a keyboard shortcut, the
   scrim, code that reads .open to decide whether to re-render -- keeps working
   untouched, and this file stays removable.

   What the gesture gives you that a transition cannot:
     - the sheet stays under your finger 1:1, from wherever you grabbed it
     - you can catch it mid-flight and push it back without waiting
     - letting go hands the finger's speed straight to the spring, so there
       is no seam between dragging and animating
     - a flick is projected forward to decide open vs closed, so a short
       fast flick throws it shut instead of snapping back
     - pulling the wrong way resists instead of hitting a wall
   ========================================================================== */
(function (w) {
  'use strict';

  var d = w.document;
  if (!w.Fluid) return;

  var FLING = 320;      // px/s past which the direction of the throw decides
  var GRAB_SLOP = 6;    // px before a drag is a drag and not a stray click

  function attach(cfg) {
    var el = d.querySelector(cfg.el);
    var scrim = cfg.scrim ? d.querySelector(cfg.scrim) : null;
    if (!el) return null;

    el.classList.add('fluid-sheet');

    var closedX = 0;
    function measure() { closedX = el.offsetWidth + 28; return closedX; }
    measure();

    var isOpen = el.classList.contains('open');
    var spring = new w.Fluid.Spring({
      from: isOpen ? 0 : closedX,
      to: isOpen ? 0 : closedX,
      onFrame: paint,
      onRest: function (v) {
        if (v >= closedX - 0.5) {
          el.style.visibility = 'hidden';
          if (scrim) scrim.style.visibility = 'hidden';
        }
      }
    });

    function paint(x) {
      el.style.transform = 'translateX(' + x + 'px)';
      if (x < closedX - 0.5) {
        el.style.visibility = 'visible';
        if (scrim) scrim.style.visibility = 'visible';
      }
      if (scrim) {
        var p = 1 - (x / closedX);
        scrim.style.opacity = String(Math.max(0, Math.min(1, p)));
      }
    }
    paint(spring.value);

    /* ---- the .open class stays the source of truth ---------------------- */
    function sync() {
      var wantOpen = el.classList.contains('open');
      if (wantOpen === isOpen && !spring.isMoving()) return;
      isOpen = wantOpen;
      measure();
      if (wantOpen) {
        el.style.visibility = 'visible';
        if (scrim) scrim.style.visibility = 'visible';
        // Opening from a standing start has no momentum behind it, so it
        // settles rather than bounces.
        spring.to(0, w.Fluid.SETTLE);
      } else {
        spring.to(closedX, w.Fluid.SETTLE);
      }
    }
    new w.MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ['class'] });

    /* ---- the grip ------------------------------------------------------- */
    var grip = d.createElement('div');
    grip.className = 'sheet-grip';
    grip.setAttribute('aria-hidden', 'true');
    grip.innerHTML = '<span></span>';
    el.appendChild(grip);

    /* ---- dragging -------------------------------------------------------- */
    var track = new w.Fluid.Tracker(100);
    var dragging = false, armed = false, startX = 0, grabOffset = 0, pid = null;

    function fromHandle(t) {
      if (!t) return false;
      if (t.closest('.sheet-grip')) return true;
      // The header is draggable too, but not its buttons or its text input --
      // a control you can drag by is a control you cannot reliably press.
      if (t.closest('.drawer-head') && !t.closest('button, input, select, a, [contenteditable]')) return true;
      return false;
    }

    el.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      if (!fromHandle(e.target)) return;
      measure();
      armed = true; dragging = false;
      startX = e.clientX;
      pid = e.pointerId;
      // Capture immediately, not once the drag threshold is crossed. The grip
      // is a thin strip on the sheet's own edge, so a pull to the left leaves
      // the element within a few pixels -- later than the threshold, and the
      // moves that decide the drag never arrive. Capturing here does not
      // swallow a plain tap: a click still lands on whatever was under it.
      try { el.setPointerCapture(pid); } catch (err) {}
      // Catch it wherever it happens to be right now, mid-flight or at rest.
      // Reading the live value (not the target) is what stops an interrupted
      // sheet from jumping before it follows the finger.
      spring.hold();
      grabOffset = e.clientX - spring.value;
      track.clear().push(e.clientX, e.timeStamp);
    });

    el.addEventListener('pointermove', function (e) {
      if (!armed || e.pointerId !== pid) return;
      if (!dragging) {
        if (Math.abs(e.clientX - startX) < GRAB_SLOP) return;
        dragging = true;
        el.classList.add('grabbing');
      }
      track.push(e.clientX, e.timeStamp);
      var x = e.clientX - grabOffset;
      // Pulling further open than open resists instead of stopping dead.
      if (x < 0) x = -w.Fluid.rubberband(-x, closedX);
      spring.value = x;
      paint(x);
      e.preventDefault();
    });

    function release(e) {
      if (!armed || (pid != null && e.pointerId !== pid)) return;
      var wasDragging = dragging;
      armed = false; dragging = false;
      el.classList.remove('grabbing');
      try { el.releasePointerCapture(pid); } catch (err) {}
      pid = null;
      if (!wasDragging) return;

      track.push(e.clientX, e.timeStamp);
      var v = track.velocity();                          // px/s, + = closing
      var projected = spring.value + w.Fluid.project(v); // where a throw lands

      var close;
      if (Math.abs(v) > FLING) close = v > 0;            // a decisive throw wins
      else close = projected > closedX * 0.5;            // otherwise, where it would land

      // A throw carries momentum, so it is allowed a little overshoot; a slow
      // drag released gently should just settle.
      var feel = (Math.abs(v) > FLING) ? w.Fluid.SHEET : w.Fluid.MOVE;
      var opts = { damping: feel.damping, response: feel.response, velocity: v };

      if (close) {
        spring.to(closedX, opts);
        // Tell the app so it can clear its own drawer state. It will strip
        // .open, which sync() sees as already-satisfied and leaves alone.
        el.dispatchEvent(new CustomEvent('sheet:dismiss', { bubbles: true }));
      } else {
        spring.to(0, opts);
      }
    }
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);

    w.addEventListener('resize', function () {
      var wasClosed = !el.classList.contains('open');
      measure();
      if (wasClosed && !spring.isMoving()) { spring.value = spring.target = closedX; paint(closedX); }
    });

    return { sync: sync };
  }

  w.Sheet = { attach: attach };

  d.addEventListener('DOMContentLoaded', function () {
    attach({ el: '#drawer', scrim: '#scrim' });
  });
})(window);
