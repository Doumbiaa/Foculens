// FocusLens logic engine: pure rule-based state machine, no camera, no DOM, no model.
// Input per frame: { face, yaw, pitch, eyeL, eyeR }
//   yaw   : degrees, LEFT turn is positive, RIGHT turn is negative
//   pitch : degrees, DOWN is positive, UP is negative
//   eyeL/eyeR : MediaPipe eyeBlink scores, ~0 open, ~1 closed
// Output: a snapshot (state, remaining time, reason, grace countdown) and events.

export const PRESETS = {
  strict:   { yawLimit: 15, pitchLimit: 15 },   // default, as requested
  balanced: { yawLimit: 20, pitchLimit: 20 },
  relaxed:  { yawLimit: 25, pitchLimit: 25 },
};

export const DEFAULTS = {
  yawLimit: 15,          // deg from calibrated neutral, both directions
  pitchLimit: 15,        // deg from calibrated neutral, both directions
  eyeWarn: 0.4,          // eye score where we start warning (sleeping starts at eyeClosed)
  eyeClosed: 0.5,        // eye score treated as sleeping / eyes closed (assumed bound)
  eyeMode: 'max',        // 'max' = worse eye decides, 'avg' = average of both
  graceSec: 5,           // time out of range before the timer pauses
  blinkMs: 500,          // anything shorter than this is ignored (blinks, glitches)
  recoverMs: 250,        // in-range time needed before an out-of-range episode counts as over
  resumeMs: 300,         // in-range time needed to resume a paused timer
  hysteresisDeg: 2,      // must come back this far inside the limit to clear a flag
  hysteresisEye: 0.03,
  notesMode: false,      // looking down is fine (reading, writing notes)
  notesDownLimit: 40,    // downward limit in notes mode
  smooth: 0.5,           // EMA weight of the newest frame
  drowsyHoldMs: 1200,    // eyes in the warning band this long -> drowsy notice
};

export const REASONS = {
  noface: 'No face in view',
  eyes: 'Eyes closed',
  left: 'Looking left',
  right: 'Looking right',
  down: 'Looking down',
  up: 'Looking up',
  classifier: 'MLP: not focused',
};

const PRIORITY = ['noface', 'classifier', 'eyes', 'left', 'right', 'down', 'up'];
const MAX_DT = 2000;

export class FocusEngine {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.base = { yaw: 0, pitch: 0 };
    this.events = [];
    this.resetAll();
  }

  setConfig(partial) { Object.assign(this.cfg, partial); }
  calibrate(yaw, pitch) { this.base = { yaw, pitch }; }

  resetAll() {
    this.state = 'idle';       // idle | running | grace | paused | manual | break | done
    this.phase = 'focus';      // focus | break
    this.totalMs = 25 * 60000;
    this.remainingMs = this.totalMs;
    this._last = null;
    this._frame = null;        // last smoothed measurement
    this._flags = {};          // active violation flags with hysteresis
    this._reasons = [];
    this._violStart = null;
    this._okSince = null;
    this._pauseReason = null;
    this._pauseStart = null;
    this._drowsyStart = null;
    this._drowsy = false;
    this._manualFrom = null;
    this.stats = this._blankStats();
    this.events.length = 0;
  }

  _blankStats() {
    return {
      focusMs: 0, pausedMs: 0, breakMs: 0, pauseCount: 0, graceRecovered: 0,
      streakMs: 0, longestStreakMs: 0,
      reasons: {},            // reason -> { count, ms }
      pauses: [],             // { startMs, endMs, durationMs, reason }
      segments: [],           // { t0, t1, state } for the timeline strip
      elapsedMs: 0,
    };
  }

  // ---- control ----------------------------------------------------------
  startPhase(phase, seconds, now) {
    this.phase = phase;
    this.totalMs = this.remainingMs = seconds * 1000;
    this._last = now;
    this._violStart = this._okSince = null;
    this._flags = {};
    this._reasons = [];
    this._pauseReason = null;
    this.state = phase === 'break' ? 'break' : 'running';
    this._emit(phase === 'break' ? 'break-start' : 'focus-start');
  }

  pauseManual(now) {
    if (this.state === 'idle' || this.state === 'manual' || this.state === 'done') return;
    this._advance(now);
    this._closePause(now);
    this._manualFrom = this.state;
    this._setState('manual');
  }

  resumeManual(now) {
    if (this.state !== 'manual') return;
    this._last = now;
    this._violStart = this._okSince = null;
    this._setState(this._manualFrom === 'break' ? 'break' : 'running');
  }

  stop() { this.state = 'idle'; this._last = null; this._closePause(0); }

  resetStats() { this.stats = this._blankStats(); }

  // Show a phase on the dial without starting it.
  prepare(phase, seconds) {
    this.phase = phase;
    this.totalMs = this.remainingMs = seconds * 1000;
    this.state = 'idle'; this._last = null;
    this._violStart = this._okSince = null; this._flags = {}; this._reasons = [];
  }

  // ---- input ------------------------------------------------------------
  // frame = null or { face:false } when no face found.
  feed(frame, now, detector = {}) {
    this._frame = this._smooth(frame);
    this._evaluate(now, detector);
    this._step(now);
  }

  tick(now) { this._step(now); }

  drain() { const e = this.events.slice(); this.events.length = 0; return e; }

  // ---- internals --------------------------------------------------------
  _emit(type, extra = {}) { this.events.push({ type, ...extra }); }

  _smooth(frame) {
    const a = this.cfg.smooth;
    if (!frame || frame.face === false) { this._prev = null; return { face: false }; }
    const eye = this.cfg.eyeMode === 'avg'
      ? (frame.eyeL + frame.eyeR) / 2
      : Math.max(frame.eyeL, frame.eyeR);
    const cur = { face: true, yaw: frame.yaw - this.base.yaw, pitch: frame.pitch - this.base.pitch, eye };
    const p = this._prev;
    const out = p ? {
      face: true,
      yaw: p.yaw + a * (cur.yaw - p.yaw),
      pitch: p.pitch + a * (cur.pitch - p.pitch),
      eye: p.eye + a * (cur.eye - p.eye),
    } : cur;
    this._prev = out;
    return out;
  }

  _hyst(name, on, off) {
    // flag turns on at `on`, only clears at `off`
    const was = !!this._flags[name];
    this._flags[name] = was ? !off : on;
    return this._flags[name];
  }

  _evaluate(now, detector = {}) {
    const c = this.cfg, f = this._frame;
    const reasons = [];
    const mode = detector.mode || 'rules';
    const classifierLabel = detector.classifierLabel ?? null;
    if (this.phase !== 'focus') { this._reasons = []; return; }
    if (!f || !f.face) {
      this._flags = {};
      this._reasons = ['noface'];
      this._drowsyStart = null; this._drowsy = false;
      return;
    }

    // MLP-only mode does not evaluate the rule thresholds at all.
    // If the classifier cannot produce a prediction, fail safe as Not focused.
    if (mode === 'rf') {
      this._flags = {};
      this._drowsyStart = null; this._drowsy = false;
      this._reasons = classifierLabel === 'Focused' ? [] : ['classifier'];
      return;
    }

    const hd = c.hysteresisDeg, he = c.hysteresisEye;
    const downL = c.notesMode ? c.notesDownLimit : c.pitchLimit;
    if (this._hyst('eyes', f.eye >= c.eyeClosed, f.eye < c.eyeClosed - he)) reasons.push('eyes');
    if (this._hyst('left', f.yaw > c.yawLimit, f.yaw <= c.yawLimit - hd)) reasons.push('left');
    if (this._hyst('right', f.yaw < -c.yawLimit, f.yaw >= -c.yawLimit + hd)) reasons.push('right');
    if (this._hyst('down', f.pitch > downL, f.pitch <= downL - hd)) reasons.push('down');
    if (this._hyst('up', f.pitch < -c.pitchLimit, f.pitch >= -c.pitchLimit + hd)) reasons.push('up');
    // In combined mode, append the classifier's independent decision.
    // An unavailable MLP prediction does not disable the rule-based detector.
    if (mode === 'both' && classifierLabel === 'Not focused') reasons.push('classifier');
    reasons.sort((a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b));
    this._reasons = reasons;
    // eye warning band (soft notice only, never pauses by itself)
    const inBand = f.eye >= c.eyeWarn && f.eye < c.eyeClosed;
    if (inBand) {
      if (this._drowsyStart == null) this._drowsyStart = now;
    } else { this._drowsyStart = null; this._drowsy = false; }
  }

  _advance(now) {
    if (this._last == null) { this._last = now; return 0; }
    let dt = Math.max(0, Math.min(MAX_DT, now - this._last));
    this._last = now;
    const s = this.stats, st = this.state;
    if (dt === 0) return 0;
    if (st === 'running' || st === 'grace') {
      this.remainingMs -= dt; s.focusMs += dt; s.streakMs += dt;
      if (s.streakMs > s.longestStreakMs) s.longestStreakMs = s.streakMs;
    } else if (st === 'break') {
      this.remainingMs -= dt; s.breakMs += dt;
    } else if (st === 'paused') {
      s.pausedMs += dt;
      const r = s.reasons[this._pauseReason] ||= { count: 0, ms: 0 };
      r.ms += dt;
    }
    if (st !== 'idle' && st !== 'done') this._addSegment(dt, st);
    return dt;
  }

  _addSegment(dt, st) {
    const s = this.stats, segs = s.segments;
    const t0 = s.elapsedMs;
    s.elapsedMs += dt;
    const last = segs[segs.length - 1];
    let key = st, reason = null;
    if (st === 'running' && this._drowsy) key = 'drowsy';
    if (st === 'grace') reason = this._reasons[0] || null;
    if (st === 'paused') reason = this._pauseReason;
    if (last && last.state === key && last.reason === reason && Math.abs(last.t1 - t0) < 1) last.t1 = s.elapsedMs;
    else segs.push({ t0, t1: s.elapsedMs, state: key, reason });
  }

  _setState(next) {
    if (this.state !== next) this.state = next;
  }

  _closePause(now) {
    if (this._pauseStart == null) return;
    const s = this.stats, el = s.elapsedMs;
    s.pauses.push({
      startMs: this._pauseStart, endMs: el, durationMs: el - this._pauseStart,
      reason: this._pauseReason,
    });
    this._pauseStart = null;
  }

  _step(now) {
    this._lastNow = now;
    if (this.state === 'manual') {
      // paused by the user: record it on the timeline, no stats change
      if (this._last != null) { const dt = Math.min(MAX_DT, Math.max(0, now - this._last)); this._last = now; if (dt > 0) this._addSegment(dt, 'manual'); }
      return;
    }
    if (this.state === 'idle' || this.state === 'done') return;
    this._advance(now);
    const c = this.cfg, s = this.stats;

    if (this.remainingMs <= 0) {
      this.remainingMs = 0;
      if (this.state === 'paused') this._closePause(now);
      const ended = this.phase;
      this.state = 'done';
      this._emit('phase-end', { phase: ended });
      return;
    }
    if (this.phase === 'break') return;

    const viol = this._reasons.length > 0;
    if (viol) {
      this._okSince = null;
      if (this._violStart == null) this._violStart = now;
    } else {
      if (this._okSince == null) this._okSince = now;
      if (this._violStart != null && now - this._okSince >= c.recoverMs) {
        if (this.state === 'grace') { s.graceRecovered++; this._emit('grace-end'); this.state = 'running'; }
        this._violStart = null;
      }
    }

    // drowsy soft notice
    if (this._drowsyStart != null && !this._drowsy && now - this._drowsyStart >= c.drowsyHoldMs) {
      this._drowsy = true; this._emit('drowsy');
    }

    switch (this.state) {
      case 'running':
        if (viol && this._violStart != null && now - this._violStart >= c.blinkMs) {
          this.state = 'grace';
          this._emit('grace-start', { reason: this._reasons[0] });
        }
        // fall through: with graceSec <= blinkMs we may pause immediately
      case 'grace':
        if (this.state === 'grace' && this._violStart != null) {
          if (now - this._violStart >= Math.max(c.graceSec * 1000, c.blinkMs)) {
            this.state = 'paused';
            this._pauseStart = s.elapsedMs;
            this._pauseReason = this._reasons[0] || 'noface';
            s.pauseCount++;
            s.streakMs = 0;
            (s.reasons[this._pauseReason] ||= { count: 0, ms: 0 }).count++;
            this._emit('paused', { reason: this._pauseReason });
          }
        }
        break;
      case 'paused':
        if (viol) this._pauseReason = this._reasons[0];
        else if (this._okSince != null && now - this._okSince >= c.resumeMs) {
          this._closePause(now);
          this.state = 'running';
          this._violStart = null;
          this._emit('resumed');
        }
        break;
    }
  }

  // ---- read-out ---------------------------------------------------------
  snapshot(now) {
    const c = this.cfg, f = this._frame;
    let graceLeftMs = null;
    if (this.state === 'grace' && this._violStart != null) {
      graceLeftMs = Math.max(0, Math.max(c.graceSec * 1000, c.blinkMs) - (now - this._violStart));
    }
    const reason = this.state === 'paused' ? this._pauseReason : (this._reasons[0] || null);
    return {
      state: this.state, phase: this.phase,
      remainingMs: this.remainingMs, totalMs: this.totalMs,
      reason, reasonText: reason ? REASONS[reason] : '',
      reasons: this._reasons.slice(),
      graceLeftMs, graceMs: c.graceSec * 1000,
      drowsy: this._drowsy,
      eyeBand: f && f.face ? (f.eye >= c.eyeClosed ? 'closed' : f.eye >= c.eyeWarn ? 'warn' : 'open') : null,
      values: f && f.face ? { yaw: f.yaw, pitch: f.pitch, eye: f.eye } : null,
    };
  }
}

// ---- helpers used by the app (and testable) -------------------------------

// Head rotation from a MediaPipe facial transformation matrix.
// `m` is the 16 floats as delivered by MediaPipe (column-major). We want the same
// numbers as OpenCV's RQDecomp3x3 on the top-left 3x3 of the row-major matrix.
export function eulerFromMatrix(m) {
  // row-major r[i][j] = m[j*4 + i]  (column-major storage)
  const r = (i, j) => m[j * 4 + i];
  const r00 = r(0, 0), r01 = r(0, 1), r02 = r(0, 2);
  const r10 = r(1, 0), r11 = r(1, 1), r12 = r(1, 2);
  const r20 = r(2, 0), r21 = r(2, 1), r22 = r(2, 2);
  // Standard decomposition R = Rz * Ry * Rx
  const sy = Math.hypot(r00, r10);
  let x, y, z;
  if (sy > 1e-6) {
    x = Math.atan2(r21, r22);
    y = Math.atan2(-r20, sy);
    z = Math.atan2(r10, r00);
  } else {
    x = Math.atan2(-r12, r11); y = Math.atan2(-r20, sy); z = 0;
  }
  const deg = 180 / Math.PI;
  return { pitch: wrap(x * deg), yaw: wrap(y * deg), roll: wrap(z * deg) };
}

export function wrap(a) {
  while (a > 90) a -= 180;
  while (a < -90) a += 180;
  return a;
}

export function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const n = a.length; if (!n) return 0;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

export function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
