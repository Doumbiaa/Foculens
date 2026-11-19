import assert from 'node:assert/strict';
import { FocusEngine, eulerFromMatrix, fmtClock } from '../engine.js';

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '\n    ', e.message); process.exitCode = 1; } };

// helpers: drive the engine at 30 fps with a constant pose for `sec` seconds
const F = (o = {}) => ({ face: true, yaw: 0, pitch: 0, eyeL: 0.02, eyeR: 0.02, ...o });
function run(e, clock, frame, sec, fps = 30) {
  const n = Math.round(sec * fps);
  for (let i = 0; i < n; i++) { clock.t += 1000 / fps; e.feed(frame, clock.t); }
}
function mk(cfg = {}, secs = 600) {
  const e = new FocusEngine({ graceSec: 5, ...cfg });
  const c = { t: 0 };
  e.startPhase('focus', secs, c.t);
  return { e, c };
}

t('focused user is never penalised and the timer counts down', () => {
  const { e, c } = mk();
  run(e, c, F(), 60);
  assert.equal(e.state, 'running');
  assert.ok(Math.abs(e.remainingMs - (600000 - 60000)) < 100);
  assert.equal(e.stats.pauseCount, 0);
});

t('yaw inside +-15 is fine, both signs', () => {
  const { e, c } = mk();
  run(e, c, F({ yaw: 14 }), 10); assert.equal(e.state, 'running');
  run(e, c, F({ yaw: -14 }), 10); assert.equal(e.state, 'running');
});

t('yaw > +15 means LEFT, < -15 means RIGHT', () => {
  let { e, c } = mk(); run(e, c, F({ yaw: 18 }), 1);
  assert.equal(e.snapshot(c.t).reason, 'left');
  ({ e, c } = mk()); run(e, c, F({ yaw: -18 }), 1);
  assert.equal(e.snapshot(c.t).reason, 'right');
});

t('pitch > +15 means DOWN, < -15 means UP', () => {
  let { e, c } = mk(); run(e, c, F({ pitch: 20 }), 1);
  assert.equal(e.snapshot(c.t).reason, 'down');
  ({ e, c } = mk()); run(e, c, F({ pitch: -20 }), 1);
  assert.equal(e.snapshot(c.t).reason, 'up');
});

t('short look-away (< 0.5 s) is ignored: no grace at all', () => {
  const { e, c } = mk();
  run(e, c, F({ yaw: 30 }), 0.3); run(e, c, F(), 2);
  assert.equal(e.state, 'running'); assert.equal(e.stats.graceRecovered, 0);
});

t('grace window: enters grace, keeps counting, pauses exactly at the window', () => {
  const { e, c } = mk({ graceSec: 5 });
  run(e, c, F({ yaw: 30 }), 1);
  assert.equal(e.state, 'grace');
  const g = e.snapshot(c.t).graceLeftMs; assert.ok(g > 3500 && g < 4500, 'graceLeft ' + g);
  const before = e.remainingMs; run(e, c, F({ yaw: 30 }), 1);
  assert.ok(e.remainingMs < before, 'timer keeps running during grace');
  run(e, c, F({ yaw: 30 }), 3.2);
  assert.equal(e.state, 'paused');
  assert.equal(e.snapshot(c.t).reason, 'left');
  assert.equal(e.stats.pauseCount, 1);
});

t('timer stops while paused', () => {
  const { e, c } = mk({ graceSec: 3 });
  run(e, c, F({ yaw: 30 }), 4); assert.equal(e.state, 'paused');
  const r = e.remainingMs; run(e, c, F({ yaw: 30 }), 10);
  assert.equal(e.remainingMs, r);
});

t('returning inside the grace window cancels it, no penalty', () => {
  const { e, c } = mk({ graceSec: 5 });
  run(e, c, F({ yaw: 30 }), 3); assert.equal(e.state, 'grace');
  run(e, c, F(), 1);
  assert.equal(e.state, 'running'); assert.equal(e.stats.pauseCount, 0); assert.equal(e.stats.graceRecovered, 1);
});

t('resumes right after the user is back in range (300 ms)', () => {
  const { e, c } = mk({ graceSec: 3 });
  run(e, c, F({ yaw: 30 }), 4); assert.equal(e.state, 'paused');
  run(e, c, F(), 0.1); assert.equal(e.state, 'paused');
  run(e, c, F(), 0.4); assert.equal(e.state, 'running');
  assert.equal(e.stats.pauses.length, 1);
  assert.equal(e.stats.pauses[0].reason, 'left');
});

t('no face: counts as out of range, resumes when face returns', () => {
  const { e, c } = mk({ graceSec: 3 });
  run(e, c, null, 4); assert.equal(e.state, 'paused'); assert.equal(e.snapshot(c.t).reason, 'noface');
  run(e, c, F(), 0.6); assert.equal(e.state, 'running');
});

t('eyes: below 0.4 open, 0.4-0.5 warn only, >= 0.5 sleeping', () => {
  let { e, c } = mk({ graceSec: 3 });
  run(e, c, F({ eyeL: 0.3, eyeR: 0.3 }), 5);
  assert.equal(e.state, 'running'); assert.equal(e.snapshot(c.t).eyeBand, 'open');
  run(e, c, F({ eyeL: 0.45, eyeR: 0.45 }), 6);
  assert.equal(e.state, 'running', 'warning band never pauses'); assert.equal(e.snapshot(c.t).eyeBand, 'warn');
  assert.ok(e.drain().some(x => x.type === 'drowsy'));
  run(e, c, F({ eyeL: 0.7, eyeR: 0.7 }), 4);
  assert.equal(e.state, 'paused'); assert.equal(e.snapshot(c.t).reason, 'eyes');
});

t('eyes use the worse eye (max) by default; avg mode is optional', () => {
  let { e, c } = mk({ graceSec: 3 });
  run(e, c, F({ eyeL: 0.8, eyeR: 0.05 }), 4);
  assert.equal(e.state, 'paused');
  ({ e, c } = mk({ graceSec: 3, eyeMode: 'avg' }));
  run(e, c, F({ eyeL: 0.8, eyeR: 0.05 }), 4);
  assert.equal(e.state, 'running');
});

t('a normal blink (0.2 s) never triggers anything', () => {
  const { e, c } = mk();
  run(e, c, F({ eyeL: 0.9, eyeR: 0.9 }), 0.2); run(e, c, F(), 3);
  assert.equal(e.state, 'running'); assert.equal(e.stats.graceRecovered, 0);
});

t('calibration shifts neutral: a user who sits turned 10 deg is fine, +16 more is not', () => {
  const { e, c } = mk();
  e.calibrate(10, -5);
  run(e, c, F({ yaw: 10, pitch: -5 }), 3); assert.equal(e.state, 'running');
  run(e, c, F({ yaw: 24, pitch: -5 }), 1); assert.equal(e.state, 'running');   // +14 rel
  run(e, c, F({ yaw: 28, pitch: -5 }), 1); assert.equal(e.state, 'grace');     // +18 rel
});

t('hysteresis: hovering at 14.5 after crossing does not flap', () => {
  const { e, c } = mk();
  run(e, c, F({ yaw: 18 }), 1); assert.equal(e.state, 'grace');
  run(e, c, F({ yaw: 14.5 }), 1);       // within 2 deg of the limit: still flagged
  assert.equal(e.snapshot(c.t).reasons[0], 'left');
  run(e, c, F({ yaw: 5 }), 1); assert.equal(e.state, 'running');
});

t('notes mode allows looking down but still catches looking away', () => {
  const { e, c } = mk({ notesMode: true, graceSec: 3 });
  run(e, c, F({ pitch: 30 }), 6); assert.equal(e.state, 'running');
  run(e, c, F({ pitch: 30, yaw: 30 }), 4); assert.equal(e.state, 'paused');
});

t('grace is user-selectable (3 / 10 / 30)', () => {
  for (const g of [3, 10, 30]) {
    const { e, c } = mk({ graceSec: g }, 3600);
    run(e, c, F({ yaw: 30 }), g - 0.5); assert.notEqual(e.state, 'paused', 'g=' + g);
    run(e, c, F({ yaw: 30 }), 1); assert.equal(e.state, 'paused', 'g=' + g);
  }
});

t('break phase is not monitored', () => {
  const e = new FocusEngine(); const c = { t: 0 };
  e.startPhase('break', 300, 0);
  run(e, c, null, 20); assert.equal(e.state, 'break'); assert.equal(e.stats.pauseCount, 0);
  assert.ok(e.remainingMs < 300000);
});

t('phase end fires once and stats add up', () => {
  const { e, c } = mk({ graceSec: 3 }, 30);
  run(e, c, F(), 10); run(e, c, F({ yaw: 40 }), 5); run(e, c, F(), 30);
  assert.equal(e.state, 'done');
  assert.equal(e.drain().filter(x => x.type === 'phase-end').length, 1);
  const s = e.stats;
  assert.ok(Math.abs(s.focusMs - 30000) < 150, 'focusMs ' + s.focusMs);
  assert.ok(s.pausedMs > 1000 && s.pausedMs < 3000, 'pausedMs ' + s.pausedMs);
  assert.equal(s.pauseCount, 1);
  assert.equal(s.reasons.left.count, 1);
});

t('manual pause freezes the timer and resume continues', () => {
  const { e, c } = mk();
  run(e, c, F(), 5); e.pauseManual(c.t);
  const r = e.remainingMs; run(e, c, F(), 5); assert.equal(e.remainingMs, r);
  e.resumeManual(c.t); run(e, c, F(), 1); assert.ok(e.remainingMs < r);
});

t('euler: identity is zero; sign check for yaw', () => {
  const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const a = eulerFromMatrix(I); assert.ok(Math.abs(a.yaw) < 1e-9 && Math.abs(a.pitch) < 1e-9);
});

t('fmtClock', () => { assert.equal(fmtClock(25 * 60000), '25:00'); assert.equal(fmtClock(61000), '01:01'); assert.equal(fmtClock(100), '00:01'); });


t('MLP-only mode ignores rule thresholds when classifier says Focused', () => {
  const { e, c } = mk({ graceSec: 1 });
  for (let i = 0; i < 60; i++) {
    c.t += 1000 / 30;
    e.feed(F({ yaw: 40, pitch: 30, eyeL: 0.9, eyeR: 0.9 }), c.t,
      { mode: 'rf', classifierLabel: 'Focused' });
  }
  assert.equal(e.state, 'running');
  assert.equal(e.stats.pauseCount, 0);
});

t('MLP-only mode pauses from Not focused classifier decision without fake head angles', () => {
  const { e, c } = mk({ graceSec: 1 });
  for (let i = 0; i < 60; i++) {
    c.t += 1000 / 30;
    e.feed(F(), c.t, { mode: 'rf', classifierLabel: 'Not focused' });
  }
  assert.equal(e.state, 'paused');
  assert.equal(e.snapshot(c.t).reason, 'classifier');
});

t('combined mode keeps rule detector active when classifier says Focused', () => {
  const { e, c } = mk({ graceSec: 1 });
  for (let i = 0; i < 60; i++) {
    c.t += 1000 / 30;
    e.feed(F({ yaw: 25 }), c.t, { mode: 'both', classifierLabel: 'Focused' });
  }
  assert.equal(e.state, 'paused');
  assert.equal(e.snapshot(c.t).reason, 'left');
});

t('combined mode can pause from classifier decision while rules are in range', () => {
  const { e, c } = mk({ graceSec: 1 });
  for (let i = 0; i < 60; i++) {
    c.t += 1000 / 30;
    e.feed(F(), c.t, { mode: 'both', classifierLabel: 'Not focused' });
  }
  assert.equal(e.state, 'paused');
  assert.equal(e.snapshot(c.t).reason, 'classifier');
});

console.log(`\n${pass} passed`);
