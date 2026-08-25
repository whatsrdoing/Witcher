/* ==========================================================================
   FLUID — springs, momentum and gesture tracking
   Vendored on purpose: everything here has to work with the network off, so
   there is no Motion/Framer dependency to reach for.

   The idea, from Apple's "Designing Fluid Interfaces": motion should start
   from whatever is on screen right now, inherit the speed of the finger that
   caused it, carry that momentum forward, and stay grabbable the whole time.
   A CSS transition can do none of those -- it interpolates from a fixed start
   to a fixed end over a fixed duration, and grabbing it mid-flight means
   fighting it. So anything a person can touch is driven from here instead.
   ========================================================================== */
(function (w) {
  'use strict';

  var reduced = false;
  try {
    var mq = w.matchMedia('(prefers-reduced-motion: reduce)');
    reduced = mq.matches;
    // addEventListener isn't on MediaQueryList in older WebKit.
    if (mq.addEventListener) mq.addEventListener('change', function (e) { reduced = e.matches; });
    else if (mq.addListener) mq.addListener(function (e) { reduced = e.matches; });
  } catch (e) {}

  /* ---- Spring -------------------------------------------------------------
     Parameterised the way Apple exposes it to designers rather than as
     mass/stiffness/damping:

       damping  1.0 = critically damped, settles with no overshoot
                0.8 = a little bounce, for motion a flick already started
       response      seconds to substantially reach the target. NOT a
                     duration -- a spring has no fixed end; the settle time
                     falls out of the parameters.

     Integrated numerically in fixed sub-steps instead of solved in closed
     form. The analytic solution needs a different branch for under-, over-
     and critically damped, and the exactly-critical case is the one that
     divides by zero. Fixed sub-steps are one code path for every ratio, and
     at 1/240s the difference is far below anything visible. */
  var STEP = 1 / 240;
  var MAX_FRAME = 0.064;   // a backgrounded tab returns a huge dt; cap it or
                           // the integrator takes one enormous step and flies off

  function Spring(opts) {
    opts = opts || {};
    this.value = opts.from || 0;
    this.target = ('to' in opts) ? opts.to : this.value;
    this.velocity = opts.velocity || 0;
    this.damping = (opts.damping == null) ? 1 : opts.damping;
    this.response = opts.response || 0.4;
    this.restDelta = opts.restDelta || 0.05;      // px
    this.restSpeed = opts.restSpeed || 0.6;       // px/s
    this._onFrame = opts.onFrame || null;
    this._onRest = opts.onRest || null;
    this._raf = 0;
    this._last = 0;
    this._carry = 0;
  }

  Spring.prototype._tick = function (now) {
    var dt = (now - this._last) / 1000;
    this._last = now;
    if (dt > MAX_FRAME) dt = MAX_FRAME;
    if (dt < 0) dt = 0;

    var w0 = (2 * Math.PI) / this.response;
    var z = this.damping;
    this._carry += dt;
    while (this._carry >= STEP) {
      var a = -w0 * w0 * (this.value - this.target) - 2 * z * w0 * this.velocity;
      this.velocity += a * STEP;
      this.value += this.velocity * STEP;
      this._carry -= STEP;
    }

    if (this._onFrame) this._onFrame(this.value, this.velocity);

    if (Math.abs(this.value - this.target) < this.restDelta &&
        Math.abs(this.velocity) < this.restSpeed) {
      this.value = this.target;
      this.velocity = 0;
      this._raf = 0;
      if (this._onFrame) this._onFrame(this.value, 0);
      if (this._onRest) this._onRest(this.value);
      return;
    }
    var self = this;
    this._raf = w.requestAnimationFrame(function (t) { self._tick(t); });
  };

  Spring.prototype.start = function () {
    if (this._raf) return this;
    var self = this;
    this._carry = 0;
    this._last = (w.performance && performance.now()) || Date.now();
    this._raf = w.requestAnimationFrame(function (t) { self._tick(t); });
    return this;
  };

  Spring.prototype.stop = function () {
    if (this._raf) w.cancelAnimationFrame(this._raf);
    this._raf = 0;
    return this;
  };

  /* Re-target without breaking continuity. Position and velocity are left
     exactly as they are, so a spring caught mid-flight and sent somewhere
     else bends towards the new target instead of jumping to a fresh start --
     this is what stops a reversal feeling like a brick wall. */
  Spring.prototype.to = function (target, opts) {
    opts = opts || {};
    this.target = target;
    if (opts.damping != null) this.damping = opts.damping;
    if (opts.response != null) this.response = opts.response;
    if (opts.velocity != null) this.velocity = opts.velocity;
    if (reduced) {
      // Reduced motion still needs the state change, just not the travel.
      this.stop();
      this.value = target;
      this.velocity = 0;
      if (this._onFrame) this._onFrame(this.value, 0);
      if (this._onRest) this._onRest(this.value);
      return this;
    }
    return this.start();
  };

  /* Take control by hand (a finger has grabbed it). */
  Spring.prototype.hold = function (v) {
    this.stop();
    if (v != null) this.value = v;
    this.velocity = 0;
    if (this._onFrame) this._onFrame(this.value, 0);
    return this;
  };

  Spring.prototype.isMoving = function () { return !!this._raf; };

  /* ---- Momentum projection ------------------------------------------------
     Where a flick would come to rest if you let it run. Snapping to whatever
     is nearest the *release point* ignores that the finger was still moving;
     projecting first is what makes a flick feel thrown rather than dropped.

     This is the exponential-decay form Apple ships in the Fluid Interfaces
     sample code, not the v^2/2a from a physics textbook. */
  function project(velocity, decelerationRate) {
    var d = (decelerationRate == null) ? 0.998 : decelerationRate;
    return (velocity / 1000) * d / (1 - d);
  }

  /* ---- Rubber-banding -----------------------------------------------------
     Past a boundary, follow the finger less and less. A hard stop reads as
     frozen -- as though the app died. Progressive resistance reads as "still
     listening, but there is nothing more this way". */
  function rubberband(overshoot, dimension, constant) {
    var c = (constant == null) ? 0.55 : constant;
    if (!dimension) return overshoot * c;
    return (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));
  }

  /* ---- Velocity tracking --------------------------------------------------
     The last pointer event alone is a bad velocity estimate: it is often a
     near-zero delta because the finger paused a few ms before lifting, which
     kills the throw. Keep a short history and measure across it. */
  function Tracker(ms) {
    this.window = ms || 100;
    this.pts = [];
  }
  Tracker.prototype.clear = function () { this.pts.length = 0; return this; };
  Tracker.prototype.push = function (v, t) {
    t = (t == null) ? ((w.performance && performance.now()) || Date.now()) : t;
    this.pts.push({ v: v, t: t });
    var cut = t - this.window;
    while (this.pts.length > 2 && this.pts[0].t < cut) this.pts.shift();
    return this;
  };
  Tracker.prototype.velocity = function () {
    if (this.pts.length < 2) return 0;
    var a = this.pts[0], b = this.pts[this.pts.length - 1];
    var dt = (b.t - a.t) / 1000;
    if (dt <= 0.001) return 0;
    return (b.v - a.v) / dt;     // px per second
  };

  w.Fluid = {
    Spring: Spring,
    Tracker: Tracker,
    project: project,
    rubberband: rubberband,
    spring: function (o) { return new Spring(o); },
    reduced: function () { return reduced; },
    /* House defaults, straight off Apple's table. Bounce is reserved for
       motion a gesture already put speed into; a menu that merely appeared
       should not overshoot. */
    MOVE:   { damping: 1.0, response: 0.4 },
    SHEET:  { damping: 0.8, response: 0.3 },
    SETTLE: { damping: 1.0, response: 0.3 }
  };
})(window);
