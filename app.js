import { FaceLandmarker, FilesetResolver, DrawingUtils } from './vendor/vision_bundle.mjs';
import { FocusEngine, PRESETS, REASONS, eulerFromMatrix, median, fmtClock } from './engine.js';
import { predictFocus, extractEAR } from './classifier.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('fl_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('fl_' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const RING_C = 2 * Math.PI * 150;
const ROUNDS_TOTAL = 4;

// ------------------------------------------------------------------ state
const app = {
  focusMin: 25, breakMin: 5, preset: '25-5',
  camOn: false, noCam: false, calibrated: false, calibrating: false, loadingModel: false,
  completed: 0,
  sim: { on: false, key: 'focus' },
  view: null,          // smoothed relative values for the meters
  raw: null,           // latest raw frame
  inferMs: 0, fps: 0, delegate: '-', _fpsN: 0, _fpsT: performance.now(),
  calibSamples: null,
  summaryPauses: [],
  classifier: null,
  detectorMode: store.get('detectorMode', 'rules'),
};
const engine = new FocusEngine({
  graceSec: store.get('grace', 5),
  ...PRESETS[store.get('strict', 'strict')],
  notesMode: store.get('notes', false),
  eyeWarn: store.get('eyeWarn2', 0.4), eyeClosed: store.get('eyeClosed', 0.5),
  blinkMs: store.get('blinkMs', 500), resumeMs: store.get('resumeMs', 300),
  eyeMode: store.get('eyeMode', 'max'),
});
let landmarker = null, stream = null, lastVideoTime = -1, lastTs = 0;
const video = $('video'), meshCanvas = $('mesh'), mctx = meshCanvas.getContext('2d');
const drawing = new DrawingUtils(mctx);

// ------------------------------------------------------------------ small helpers
function toast(msg, ms = 3200) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const stateColor = () => getComputedStyle(document.body).getPropertyValue('--state').trim() || '#0a9c8c';

// ------------------------------------------------------------------ sound
let actx = null;
function beep(seq) {
  if (!$('optSound').checked) return;
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    let t = actx.currentTime + 0.02;
    for (const [f, d, type = 'sine', v = 0.12] of seq) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.value = f; o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.start(t); o.stop(t + d + 0.02); t += d * 0.85;
    }
  } catch { /* audio blocked */ }
}
const SOUND = {
  grace: () => beep([[440, 0.18]]),
  alarm: () => beep([[880, 0.14, 'square', 0.07], [880, 0.14, 'square', 0.07], [880, 0.2, 'square', 0.07]]),
  paused: () => beep([[392, 0.2], [294, 0.32]]),
  resumed: () => beep([[330, 0.14], [494, 0.24]]),
  done: () => beep([[523, 0.18], [659, 0.18], [784, 0.36]]),
  drowsy: () => beep([[330, 0.25], [330, 0.25]]),
};

// ------------------------------------------------------------------ ticks on the dial
const ticksG = $('ticks');
for (let i = 0; i < 60; i++) {
  const a = (i / 60) * Math.PI * 2 - Math.PI / 2, major = i % 5 === 0;
  const r1 = 172, r2 = major ? 186 : 181;
  const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  l.setAttribute('x1', 200 + Math.cos(a) * r1); l.setAttribute('y1', 200 + Math.sin(a) * r1);
  l.setAttribute('x2', 200 + Math.cos(a) * r2); l.setAttribute('y2', 200 + Math.sin(a) * r2);
  if (major) l.classList.add('major');
  ticksG.appendChild(l);
}
const tickEls = [...ticksG.children];
let lastTickOn = -1;

// ------------------------------------------------------------------ presets / settings
function applyPreset(key) {
  app.preset = key;
  document.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('on', b.dataset.preset === key));
  $('customBox').hidden = key !== 'custom';
  if (key === 'custom') { app.focusMin = +$('cFocus').value || 25; app.breakMin = +$('cBreak').value; }
  else { const [f, b] = key.split('-').map(Number); app.focusMin = f; app.breakMin = b; }
  store.set('preset', key);
  if (engine.state === 'idle') engine.prepare('focus', app.focusMin * 60);
}
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
  if (engine.state !== 'idle') { toast('Finish or end the current session to change the length.'); return; }
  applyPreset(b.dataset.preset);
}));
['cFocus', 'cBreak'].forEach((id) => $(id).addEventListener('change', () => applyPreset('custom')));

function seg(id, key, onPick) {
  const el = $(id), cur = String(store.get(key, null) ?? el.querySelector('.on')?.dataset.v);
  el.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === cur);
    b.addEventListener('click', () => {
      el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      store.set(key, b.dataset.v); onPick(b.dataset.v);
    });
  });
  onPick(cur);
}
seg('segGrace', 'grace', (v) => engine.setConfig({ graceSec: +v }));
seg('segStrict', 'strict', (v) => {
  engine.setConfig(PRESETS[v]);
  $('strictHint').textContent = `Head turn and tilt limit: ${PRESETS[v].yawLimit}° from where you sit`;
  updateMeterZones();
});
// grace was stored as number in JSON; make sure the seg matched
{ const g = String(engine.cfg.graceSec); $('segGrace').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === g)); }

function bindCheck(id, key, def, fn) {
  const el = $(id); el.checked = store.get(key, def);
  el.addEventListener('change', () => { store.set(key, el.checked); fn?.(el.checked); });
  fn?.(el.checked);
}
bindCheck('optNotes', 'notes', false, (v) => { engine.setConfig({ notesMode: v }); updateMeterZones(); });

const DETECTOR_HELP = {
  rules: 'MediaPipe measurements are evaluated by the original FocusLens rules. No Focused / Not focused classification is produced in this mode.',
  rf: 'The trained MLP classifier is the only focus classifier. Its Focused / Not focused prediction controls the timer.',
  both: 'The rule-based detector and MLP classifier operate independently. Either detector can trigger a pause.',
};
const DETECTOR_NAMES = { rules: 'Rules only', rf: 'MLP only', both: 'Both models' };
function setDetectorMode(mode, notify = false) {
  app.detectorMode = ['rules', 'rf', 'both'].includes(mode) ? mode : 'rules';
  store.set('detectorMode', app.detectorMode);
  document.querySelectorAll('[data-detector-mode]').forEach((button) => {
    const selected = button.dataset.detectorMode === app.detectorMode;
    button.classList.toggle('on', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  $('detectorHelp').textContent = DETECTOR_HELP[app.detectorMode];
  if (notify) toast(`Detection method: ${DETECTOR_NAMES[app.detectorMode]}`);
}
document.querySelectorAll('[data-detector-mode]').forEach((button) => {
  button.addEventListener('click', () => setDetectorMode(button.dataset.detectorMode, true));
});
setDetectorMode(app.detectorMode);
bindCheck('optSound', 'sound', true);
bindCheck('optMesh', 'mesh', true, () => { if (!$('optMesh').checked) mctx.clearRect(0, 0, meshCanvas.width, meshCanvas.height); });
bindCheck('optPrivacy', 'privacy', false, (v) => $('finder').classList.toggle('private', v));
bindCheck('optAvg', 'avg', false, (v) => engine.setConfig({ eyeMode: v ? 'avg' : 'max' }));

function bindSlider(id, outId, key, cfgKey, fmt) {
  const s = $(id); s.value = engine.cfg[cfgKey];
  const upd = () => { $(outId).textContent = fmt(+s.value); };
  s.addEventListener('input', () => { engine.setConfig({ [cfgKey]: +s.value }); store.set(key, +s.value); upd(); updateMeterZones(); });
  upd();
}
bindSlider('sWarn', 'oWarn', 'eyeWarn2', 'eyeWarn', (v) => v.toFixed(2));
bindSlider('sClosed', 'oClosed', 'eyeClosed', 'eyeClosed', (v) => v.toFixed(2));
bindSlider('sBlink', 'oBlink', 'blinkMs', 'blinkMs', (v) => (v / 1000).toFixed(2) + ' s');
bindSlider('sResume', 'oResume', 'resumeMs', 'resumeMs', (v) => (v / 1000).toFixed(2) + ' s');

// theme
{
  const saved = store.get('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = saved;
  $('btnTheme').addEventListener('click', () => {
    const n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = n; store.set('theme', n);
  });
}
// drawer
$('btnHood').addEventListener('click', () => {
  const open = $('hood').hidden; $('hood').hidden = !open; $('btnHood').setAttribute('aria-expanded', String(open));
});
$('hoodClose').addEventListener('click', () => { $('hood').hidden = true; $('btnHood').setAttribute('aria-expanded', 'false'); });

// simulator
$('optSim').addEventListener('change', () => {
  app.sim.on = $('optSim').checked; $('hood').classList.toggle('sim-on', app.sim.on);
  if (app.sim.on) { app.calibrated = true; engine.calibrate(0, 0); app.sim.key = 'focus'; markSim(); }
  updateFinderEmpty();
});
document.querySelectorAll('[data-sim]').forEach((b) => b.addEventListener('click', () => { app.sim.key = b.dataset.sim; markSim(); }));
function markSim() { document.querySelectorAll('[data-sim]').forEach((b) => b.classList.toggle('on', b.dataset.sim === app.sim.key)); }
function simFrame(now) {
  const k = app.sim.key, j = Math.sin(now / 400) * 0.6, c = engine.base;
  const f = { face: true, yaw: c.yaw + j, pitch: c.pitch + j * 0.7, eyeL: 0.03, eyeR: 0.04 };
  if (k === 'left') f.yaw += 30; else if (k === 'right') f.yaw -= 30;
  else if (k === 'down') f.pitch += 30; else if (k === 'up') f.pitch -= 30;
  else if (k === 'drowsy') { f.eyeL = 0.45; f.eyeR = 0.42; }
  else if (k === 'closed') { f.eyeL = 0.82; f.eyeR = 0.78; }
  else if (k === 'noface') return { face: false };
  return f;
}
setInterval(() => { if (app.sim.on) onFrame(simFrame(performance.now()), performance.now(), null); }, 33);

// ------------------------------------------------------------------ camera + model
async function ensureLandmarker() {
  if (landmarker) return;
  app.loadingModel = true; render(performance.now());
  const fileset = await FilesetResolver.forVisionTasks('./vendor/wasm');
  let err;
  for (const delegate of ['CPU', 'GPU']) {
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: './face_landmarker.task', delegate },
        runningMode: 'VIDEO', numFaces: 1,
        outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      });
      app.delegate = delegate; err = null; break;
    } catch (e) { err = e; }
  }
  app.loadingModel = false;
  if (err) throw err;
}

async function startCamera() {
  $('camError').hidden = true; $('btnNoCam').hidden = true;
  $('btnCam').disabled = true; $('btnCam').textContent = 'Starting…';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser can’t reach a camera here. Open the page over https or on localhost.');
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
    video.srcObject = stream; await video.play();
    stream.getVideoTracks()[0].addEventListener('ended', () => { app.camOn = false; updateFinderEmpty(); toast('Camera stopped. The timer pauses until it’s back.'); });
    await ensureLandmarker();
    app.camOn = true; app.noCam = false; lastVideoTime = -1;
    updateFinderEmpty();
    return true;
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    $('camError').textContent = denied
      ? 'Camera access is blocked. Allow it in your browser’s address bar, then try again.'
      : (e && e.name === 'NotFoundError' ? 'No camera found. Plug one in, or use the timer without it.' : 'Couldn’t start the camera: ' + (e?.message || e));
    $('camError').hidden = false; $('btnNoCam').hidden = false;
    return false;
  } finally {
    $('btnCam').disabled = false; $('btnCam').textContent = 'Turn on camera'; app.loadingModel = false;
  }
}
$('btnCam').addEventListener('click', startCamera);
$('btnNoCam').addEventListener('click', () => { app.noCam = true; updateFinderEmpty(); toast('Timer only. FocusLens won’t pause for you without the camera.'); });

function updateFinderEmpty() {
  const showEmpty = !app.camOn && !app.sim.on && !app.noCam;
  $('finderEmpty').hidden = !showEmpty;
  $('finder').classList.toggle('off', !app.camOn);
  $('btnRecal').disabled = !(app.camOn || app.sim.on);
}

function detectLoop() {
  if (!landmarker || !app.camOn || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  let ts = performance.now(); if (ts <= lastTs) ts = lastTs + 1; lastTs = ts;
  let res;
  const t0 = performance.now();
  try { res = landmarker.detectForVideo(video, ts); }
  catch (e) { console.warn('detect failed', e); return; }
  app.inferMs = performance.now() - t0;
  app._fpsN++;
  if (ts - app._fpsT > 1000) { app.fps = app._fpsN * 1000 / (ts - app._fpsT); app._fpsN = 0; app._fpsT = ts; }

  let frame;
  const lm = res.faceLandmarks?.[0];
  if (lm && res.facialTransformationMatrixes?.length && res.faceBlendshapes?.length) {
    const { pitch, yaw, roll } = eulerFromMatrix(res.facialTransformationMatrixes[0].data);
    const ear = extractEAR(lm);
    const cats = res.faceBlendshapes[0].categories;
    const g = (n) => cats.find((c) => c.categoryName === n)?.score ?? 0;
    frame = { face: true, yaw, pitch, roll, ...ear, eyeL: g('eyeBlinkLeft'), eyeR: g('eyeBlinkRight') };
  } else frame = { face: false };
  drawMesh(lm);
  if (!app.sim.on) onFrame(frame, performance.now(), lm);
}
setInterval(detectLoop, 33);

function drawMesh(lm) {
  if (meshCanvas.width !== video.videoWidth) { meshCanvas.width = video.videoWidth; meshCanvas.height = video.videoHeight; }
  mctx.clearRect(0, 0, meshCanvas.width, meshCanvas.height);
  if (!lm || !$('optMesh').checked) return;
  drawing.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_CONTOURS, { color: stateColor(), lineWidth: 2 });
}

// ------------------------------------------------------------------ frames
function onFrame(frame, now) {
  app.raw = frame;
  app.classifier = null;
  const classifierStatus = $('classifierStatus');
  if (classifierStatus) classifierStatus.textContent = app.sim.on ? 'Simulator prediction' : 'Waiting for face';

  if (app.detectorMode === 'rules') {
    // Rules-only mode must never display MLP class labels.
    if (classifierStatus) classifierStatus.textContent = 'Not used in Rules only mode';
  } else if (frame.face && Number.isFinite(frame.roll) && Number.isFinite(frame.ear_left) && Number.isFinite(frame.ear_right)) {
    try {
      app.classifier = predictFocus(frame);
      if (classifierStatus) classifierStatus.textContent = `${app.classifier.label} · ${(Math.max(...Object.values(app.classifier.probabilities)) * 100).toFixed(1)}%`;
    } catch (err) {
      console.warn('FocusLens MLP inference failed:', err);
      if (classifierStatus) classifierStatus.textContent = 'Inference error';
    }
  } else if (app.sim.on && frame.face) {
    // Deterministic simulator labels let MLP-enabled modes be demonstrated without a webcam.
    const focused = app.sim.key === 'focus' || app.sim.key === 'drowsy';
    const classId = focused ? 1 : 0;
    app.classifier = { classId, label: focused ? 'Focused' : 'Not focused', probabilities: { 0: focused ? 0 : 1, 1: focused ? 1 : 0 } };
    if (classifierStatus) classifierStatus.textContent = `${app.classifier.label} · 100% (simulated)`;
  } else if (!frame.face && classifierStatus) {
    classifierStatus.textContent = app.sim.on ? 'No face (simulated)' : 'No face detected';
  }

  if (frame.face) {
    const eye = engine.cfg.eyeMode === 'avg' ? (frame.eyeL + frame.eyeR) / 2 : Math.max(frame.eyeL, frame.eyeR);
    const cur = { yaw: frame.yaw - engine.base.yaw, pitch: frame.pitch - engine.base.pitch, eye };
    const p = app.view;
    app.view = p ? { yaw: p.yaw + 0.5 * (cur.yaw - p.yaw), pitch: p.pitch + 0.5 * (cur.pitch - p.pitch), eye: p.eye + 0.5 * (cur.eye - p.eye) } : cur;
  } else app.view = null;

  if (app.calibrating) { if (frame.face) app.calibSamples.push(frame); return; }
  const s = engine.state;
  if (s === 'idle' || s === 'done' || s === 'manual') return;

  // The two detectors remain independent:
  // - rules: engine evaluates MediaPipe yaw/pitch/blink measurements only.
  // - rf: engine uses the MLP classifier class only (plus no-face handling).
  // - both: engine evaluates the rules and adds the MLP decision as a separate reason.
  // Never encode an MLP prediction as a fake head angle or eye-blink score.
  engine.feed(frame, now, {
    mode: app.detectorMode,
    classifierLabel: app.classifier?.label ?? null,
  });
}

// ------------------------------------------------------------------ calibration
function calibrate() {
  return new Promise((resolve) => {
    app.calibrating = true; app.calibSamples = [];
    const el = $('calib'), prog = $('calibProg'), num = $('calibNum'), msg = $('calibMsg');
    el.hidden = false; msg.textContent = 'Look at the middle of your screen'; prog.style.strokeDashoffset = 276.46;
    const DUR = 3000, t0 = performance.now(), len = 276.46;
    if (app.sim.on) app.calibSamples = [];
    const iv = setInterval(() => {
      const e = performance.now() - t0;
      prog.style.strokeDashoffset = String(len * (1 - Math.min(1, e / DUR)));
      num.textContent = String(Math.max(1, Math.ceil((DUR - e) / 1000)));
      const have = app.calibSamples.length;
      if (e < DUR) return;
      if (have < 10 && e < 9000) { msg.textContent = have ? 'Hold still for a moment…' : 'Looking for your face…'; return; }
      clearInterval(iv); app.calibrating = false;
      const S = app.calibSamples;
      if (S.length < 8) {
        msg.textContent = 'We couldn’t see your face. Face the camera in good light.'; num.textContent = '!';
        setTimeout(() => { el.hidden = true; resolve(false); }, 1800); return;
      }
      engine.calibrate(median(S.map((x) => x.yaw)), median(S.map((x) => x.pitch)));
      app.calibrated = true; app.view = null;
      $('vBase').textContent = `${engine.base.yaw.toFixed(1)}° / ${engine.base.pitch.toFixed(1)}°`;
      msg.textContent = 'Got it. That’s your neutral.'; num.textContent = '✓';
      setTimeout(() => { el.hidden = true; resolve(true); }, 600);
    }, 50);
  });
}
$('btnRecal').addEventListener('click', async () => {
  const active = ['running', 'grace', 'paused'].includes(engine.state);
  if (active) engine.pauseManual(performance.now());
  if (app.sim.on) { engine.calibrate(0, 0); toast('Simulator is always centered.'); }
  else await calibrate();
  if (active) engine.resumeManual(performance.now());
});

// ------------------------------------------------------------------ session control
async function startSession() {
  if (app.starting) return; app.starting = true;
  try {
    if (!app.sim.on && !app.noCam && !app.camOn) { const ok = await startCamera(); if (!ok) return; }
    if (!app.sim.on && app.camOn && !app.calibrated) { const ok = await calibrate(); if (!ok) return; }
    if (app.sim.on) engine.calibrate(0, 0);
    engine.startPhase('focus', app.focusMin * 60, performance.now());
    SOUND.resumed();
  } finally { app.starting = false; }
}

$('btnMain').addEventListener('click', () => {
  const now = performance.now(), s = engine.state;
  if (s === 'idle') startSession();
  else if (s === 'manual') engine.resumeManual(now);
  else if (['running', 'grace', 'paused', 'break'].includes(s)) engine.pauseManual(now);
});
$('btnSkip').addEventListener('click', () => { nextRound(); });
$('btnEnd').addEventListener('click', () => endSession(true));

function nextRound() {
  engine.prepare('focus', app.focusMin * 60);
}
function endSession(showSummary) {
  const st = engine.stats;
  const had = st.focusMs > 3000;
  engine.stop();
  if (showSummary && had) openSummary(); else engine.resetStats();
  app.completed = 0; engine.prepare('focus', app.focusMin * 60);
}

function handleEvents(now) {
  for (const e of engine.drain()) {
    switch (e.type) {
      case 'grace-start':
        if (e.reason === 'eyes') SOUND.alarm(); else SOUND.grace(); break;
      case 'paused': SOUND.paused(); break;
      case 'resumed': SOUND.resumed(); toast('Welcome back. Timer resumed.', 1800); break;
      case 'drowsy': SOUND.drowsy(); toast('Your eyes look heavy. Blink, sit up, or take a sip of water.'); break;
      case 'phase-end':
        SOUND.done();
        if (e.phase === 'focus') {
          app.completed++;
          if (app.completed >= ROUNDS_TOTAL) { toast('Four rounds done. Great work.'); endSession(true); break; }
          if (app.breakMin > 0) { engine.startPhase('break', app.breakMin * 60, now); toast(`Round ${app.completed} done. Take a ${app.breakMin}-minute break.`); }
          else { nextRound(); toast(`Round ${app.completed} done.`); }
        } else { nextRound(); toast(`Break over. Ready for round ${app.completed + 1}.`); }
        break;
    }
  }
}

// ------------------------------------------------------------------ rendering
function statusFor(s, snap) {
  const cam = app.camOn || app.sim.on;
  switch (s) {
    case 'idle':
      if (app.loadingModel) return ['Getting your camera ready', 'Loading the face model. This takes a few seconds the first time.'];
      if (app.calibrating) return ['Calibrating', 'Look at the middle of your screen and sit how you normally study.'];
      return ['Ready when you are', cam || app.noCam ? 'Press start. The timer runs while you look at your screen.' : 'Press start. We’ll turn on your camera and take a quick look at how you sit.'];
    case 'running':
      if (snap.drowsy) return ['Still focused, eyes look heavy', 'Blink, sit up, or take a breath. The timer is still running.'];
      return ['In focus', app.noCam ? 'Timer only. The camera is off.' : 'The timer is running. You’re in range.'];
    case 'grace': {
      const sec = Math.ceil((snap.graceLeftMs ?? 0) / 1000);
      return [snap.reasonText || 'Heads up', `The timer pauses in ${sec} s. ${hint(snap.reason)}`];
    }
    case 'paused': return [`Paused: ${snap.reasonText.toLowerCase()}`, hint(snap.reason, true)];
    case 'manual': return ['Paused by you', 'Press resume when you’re ready.'];
    case 'break': return ['Break time', 'The camera isn’t watching during breaks. Stretch, drink some water.'];
    default: return ['Ready', ''];
  }
}
function hint(r, resume) {
  const tail = resume ? ' The timer resumes the moment you’re back.' : '';
  switch (r) {
    case 'left': case 'right': return 'Turn back to your screen.' + tail;
    case 'down': return 'Lift your head back to your screen.' + tail;
    case 'up': return 'Bring your head back down to your screen.' + tail;
    case 'eyes': return 'Open your eyes and look at your screen.' + tail;
    case 'noface': return 'Move into view of the camera.' + tail;
    default: return '';
  }
}

function render(now) {
  const snap = engine.snapshot(now);
  const s = snap.state === 'done' ? 'idle' : snap.state;
  document.body.dataset.state = s;

  // dial
  const elapsedFrac = snap.totalMs ? 1 - snap.remainingMs / snap.totalMs : 0;
  const idleLike = s === 'idle';
  $('prog').style.strokeDashoffset = String(RING_C * (idleLike ? 0 : elapsedFrac));
  const lit = Math.ceil((1 - (idleLike ? 0 : elapsedFrac)) * 60);
  if (lit !== lastTickOn || render._s !== s) { tickEls.forEach((t, i) => t.classList.toggle('on', i < lit)); lastTickOn = lit; }
  render._s = s;
  $('clock').textContent = fmtClock(snap.remainingMs);
  let blur = 0;
  if (s === 'grace' && snap.graceLeftMs != null) blur = 3.2 * (1 - snap.graceLeftMs / Math.max(1, snap.graceMs));
  else if (s === 'paused') blur = 2.4;
  document.documentElement.style.setProperty('--blur', blur.toFixed(2) + 'px');
  const isBreak = snap.phase === 'break' && s !== 'idle';
  $('phaseLabel').textContent = isBreak ? 'Break' : `Focus, round ${Math.min(app.completed + 1, ROUNDS_TOTAL)} of ${ROUNDS_TOTAL}`;

  // status
  const [main, sub] = statusFor(s, snap);
  if ($('statusMain').textContent !== main) $('statusMain').textContent = main;
  if ($('statusSub').textContent !== sub) $('statusSub').textContent = sub;

  // buttons
  const bm = $('btnMain');
  const label = s === 'idle' ? (app.completed > 0 ? `Start round ${app.completed + 1}` : 'Start focus') : s === 'manual' ? 'Resume' : 'Pause';
  if (bm.textContent !== label) bm.textContent = label;
  bm.disabled = app.starting || app.calibrating || app.loadingModel;
  $('btnSkip').hidden = !(s === 'break' || (s === 'manual' && snap.phase === 'break'));
  $('btnEnd').hidden = s === 'idle' && engine.stats.elapsedMs === 0;

  // title
  const tag = s === 'paused' ? '⏸ ' : s === 'grace' ? '⚠ ' : s === 'break' ? '☕ ' : '';
  document.title = s === 'idle' ? 'FocusLens' : `${tag}${fmtClock(snap.remainingMs)} · FocusLens`;

  renderFinder(s, snap);
  renderMeters(snap);
  renderHood(snap);
  const active = ['running', 'grace', 'paused', 'manual', 'break'].includes(s);
  $('hiddenNotice').hidden = !(document.hidden && active && (app.camOn));
}

function renderFinder(s, snap) {
  const chip = $('finderChip'), txt = $('finderChipText');
  let cls = '', t;
  if (app.loadingModel) t = 'Loading face model';
  else if (app.calibrating) t = 'Calibrating';
  else if (!app.camOn && !app.sim.on) t = app.noCam ? 'Timer only' : 'Camera off';
  else if (app.sim.on && !app.camOn && s === 'idle') { cls = 'ok'; t = 'Simulator on'; }
  else if (s === 'break') { t = 'On break'; }
  else if (s === 'grace') { cls = 'warn'; t = `${snap.reasonText} · ${Math.ceil((snap.graceLeftMs ?? 0) / 1000)} s`; }
  else if (s === 'paused') { cls = 'bad'; t = `Paused · ${snap.reasonText}`; }
  else if (s === 'manual') { t = 'Paused by you'; }
  else if (!app.raw || !app.raw.face) { cls = 'bad'; t = 'No face in view'; }
  else if (s === 'running' && snap.drowsy) { cls = 'warn'; t = 'Eyes look heavy'; }
  else if (s === 'running') {
    cls = 'ok';
    // Rules-only mode reports rule compliance, not a Focused / Not focused class.
    t = app.detectorMode === 'rules' ? 'Within focus rules' : 'Focused';
  }
  else { cls = 'ok'; t = 'Face found'; }
  chip.className = 'finder-chip ' + cls;
  if (txt.textContent !== t) txt.textContent = t;
}

function updateMeterZones() {
  const c = engine.cfg, R = 45;
  const ySafe = $('mYaw').querySelector('.m-safe');
  ySafe.style.left = (50 - c.yawLimit / R * 50) + '%'; ySafe.style.width = (c.yawLimit / R * 100) + '%';
  const down = c.notesMode ? c.notesDownLimit : c.pitchLimit;
  const pSafe = $('mPitch').querySelector('.m-safe');
  pSafe.style.left = (50 - c.pitchLimit / R * 50) + '%'; pSafe.style.width = ((c.pitchLimit + down) / R * 50) + '%';
  const w = $('mEye').querySelector('.m-warn'), b = $('mEye').querySelector('.m-bad');
  w.style.left = (c.eyeWarn * 100) + '%'; w.style.width = ((c.eyeClosed - c.eyeWarn) * 100) + '%';
  b.style.left = (c.eyeClosed * 100) + '%';
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function renderMeters(snap) {
  const v = app.view, c = engine.cfg, R = 45;
  const live = (app.camOn || app.sim.on) && v;
  $('metersHint').textContent = live ? `Sitting point set: ${app.calibrated ? 'yes' : 'not yet'}` : (app.camOn || app.sim.on ? 'No face in view' : 'Camera off');
  for (const id of ['mYaw', 'mPitch', 'mEye']) { const m = $(id); m.classList.toggle('idle', !live); if (!live) m.classList.remove('out', 'warn'); }
  if (!live) return;
  const down = c.notesMode ? c.notesDownLimit : c.pitchLimit;
  $('mYaw').querySelector('.m-dot').style.left = clamp(50 - v.yaw / R * 50, 2, 98) + '%';
  $('mPitch').querySelector('.m-dot').style.left = clamp(50 + v.pitch / R * 50, 2, 98) + '%';
  $('mEye').querySelector('.m-dot').style.left = clamp(v.eye * 100, 2, 98) + '%';
  $('mYaw').classList.toggle('out', Math.abs(v.yaw) > c.yawLimit);
  $('mPitch').classList.toggle('out', v.pitch > down || v.pitch < -c.pitchLimit);
  $('mEye').classList.toggle('out', v.eye >= c.eyeClosed);
  $('mEye').classList.toggle('warn', v.eye >= c.eyeWarn && v.eye < c.eyeClosed);
}

function renderHood(snap) {
  if ($('hood').hidden) return;
  const r = app.raw, v = app.view;
  $('vState').textContent = snap.state + (snap.reason ? ` (${snap.reason})` : '');
  $('vYaw').textContent = v ? `${v.yaw.toFixed(1)}° rel` + (r ? ` · ${r.yaw.toFixed(1)}° raw` : '') : '–';
  $('vPitch').textContent = v ? `${v.pitch.toFixed(1)}° rel` + (r ? ` · ${r.pitch.toFixed(1)}° raw` : '') : '–';
  $('vEyes').textContent = r && r.face ? `${r.eyeL.toFixed(2)} / ${r.eyeR.toFixed(2)}` : '–';
  $('vEye').textContent = v ? `${v.eye.toFixed(2)} (${engine.cfg.eyeMode === 'avg' ? 'average' : 'worse eye'}) · ${snap.eyeBand ?? '–'}` : '–';
  $('vDet').textContent = `${app.detectorMode === 'rules' ? 'Rules' : app.detectorMode === 'rf' ? 'MLP classifier' : 'Rules + MLP classifier'} · ${app.sim.on ? 'simulator' : app.camOn ? `${app.delegate} · ${app.inferMs.toFixed(0)} ms · ${app.fps.toFixed(0)} fps` : 'camera off'}`;
  $('vRoll').textContent = r?.face && Number.isFinite(r.roll) ? `${r.roll.toFixed(2)}°` : '–';
  $('vEAR').textContent = r?.face && Number.isFinite(r.ear_left) ? `${r.ear_left.toFixed(3)} / ${r.ear_right.toFixed(3)}` : '–';
  $('vMode').textContent = app.detectorMode === 'rules' ? 'Rule-based logic' : app.detectorMode === 'rf' ? 'MLP classifier' : 'Both (combined)';
  $('vClassifier').textContent = app.detectorMode === 'rules'
    ? 'Not used in Rules only mode'
    : app.sim.on
      ? 'Unavailable in simulator'
      : app.classifier
        ? `${app.classifier.label} · ${(Math.max(...Object.values(app.classifier.probabilities)) * 100).toFixed(1)}%`
        : 'Waiting for face';
}

// timeline canvas
function drawTimeline() {
  const cv = $('tl'), st = engine.stats, dpr = devicePixelRatio || 1;
  const w = cv.clientWidth, h = 34;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = h * dpr; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  $('tlEmpty').hidden = st.elapsedMs > 0;
  if (!st.elapsedMs) return;
  const span = Math.max(st.elapsedMs, 120000);
  const col = { running: cssVar('--focus'), drowsy: cssVar('--drowsy'), grace: cssVar('--warn'), paused: cssVar('--stop'), break: cssVar('--rest'), manual: cssVar('--manual') };
  for (const sg of st.segments) {
    ctx.fillStyle = col[sg.state] || col.running;
    const x0 = sg.t0 / span * w, x1 = sg.t1 / span * w;
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
  }
}
setInterval(drawTimeline, 400);
// hover a stretch of the timeline to read what it was
const TL_LABEL = { running: 'Focused', drowsy: 'Focused, eyes looked heavy', grace: 'Heads up', paused: 'Paused', manual: 'Paused by you', break: 'Break' };
$('tl').addEventListener('pointermove', (e) => {
  const st = engine.stats; if (!st.elapsedMs) return;
  const r = $('tl').getBoundingClientRect(), span = Math.max(st.elapsedMs, 120000);
  const t = (e.clientX - r.left) / r.width * span;
  const sg = st.segments.find((x) => t >= x.t0 && t <= x.t1);
  $('tl').title = sg ? `${TL_LABEL[sg.state] || sg.state}${sg.reason ? ': ' + (REASONS[sg.reason] || sg.reason).toLowerCase() : ''} · ${mmss(sg.t0)} to ${mmss(sg.t1)}` : '';
});

// ------------------------------------------------------------------ summary
const mmss = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function openSummary() {
  const st = engine.stats;
  const tot = st.focusMs + st.pausedMs;
  const pct = tot ? Math.round(st.focusMs / tot * 100) : 100;
  app.summaryPauses = st.pauses.map((p) => ({ ...p, actuallyFocused: false }));
  const el = $('sumGrid');
  const cell = (b, s, cls = '') => `<div class="stat ${cls}"><b>${b}</b><span>${s}</span></div>`;
  el.innerHTML =
    cell(pct + '%', 'of your sitting time was focused time', 'hero') +
    cell(mmss(st.focusMs), 'focused') + cell(mmss(st.pausedMs), 'paused') + cell(String(st.pauseCount), 'pauses') +
    cell(mmss(st.longestStreakMs), 'longest streak') + cell(String(st.graceRecovered), 'saved by grace') +
    '<div class="stat"><b id="fpRate">0</b><span>false pauses per focus minute</span></div>';
  const rs = Object.entries(st.reasons).filter(([, v]) => v.count).sort((a, b) => b[1].ms - a[1].ms);
  const maxMs = Math.max(1, ...rs.map(([, v]) => v.ms));
  $('sumReasons').innerHTML = rs.length
    ? '<h3>Why the timer paused</h3>' + rs.map(([k, v]) => `<div class="rbar"><span>${REASONS[k] || k}</span><i style="width:${Math.max(4, v.ms / maxMs * 100)}%"></i><span>${v.count}× · ${mmss(v.ms)}</span></div>`).join('')
    : '<p class="tiny">No pauses. You stayed in range the whole time.</p>';
  $('sumPauses').innerHTML = app.summaryPauses.length
    ? '<h3>Tick any pause that was wrong</h3>' + app.summaryPauses.map((p, i) =>
      `<div class="prow"><span>${mmss(p.startMs)} · ${REASONS[p.reason] || p.reason} · ${(p.durationMs / 1000).toFixed(0)} s</span><label><input type="checkbox" data-fp="${i}"> I was focused</label></div>`).join('')
    : '';
  $('sumPauses').querySelectorAll('[data-fp]').forEach((c) => c.addEventListener('change', () => {
    app.summaryPauses[+c.dataset.fp].actuallyFocused = c.checked; updateFp();
  }));
  app._sum = { st: JSON.parse(JSON.stringify({ focusMs: st.focusMs, pausedMs: st.pausedMs, pauseCount: st.pauseCount, longestStreakMs: st.longestStreakMs, graceRecovered: st.graceRecovered })), pct };
  $('summary').showModal();
  updateFp();
  engine.resetStats();
}
function updateFp() {
  const n = app.summaryPauses.filter((p) => p.actuallyFocused).length;
  const mins = (app._sum?.st.focusMs || 0) / 60000;
  const e = $('fpRate'); if (e) e.textContent = mins ? (n / mins).toFixed(2) : '0';
}
$('btnCsv').addEventListener('click', () => {
  const rows = ['pause,start_s,end_s,duration_s,reason,actually_focused'];
  app.summaryPauses.forEach((p, i) => rows.push([i + 1, (p.startMs / 1000).toFixed(1), (p.endMs / 1000).toFixed(1), (p.durationMs / 1000).toFixed(1), p.reason, p.actuallyFocused ? 1 : 0].join(',')));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  const d = new Date(); a.download = `focuslens-pauses-${d.toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`; a.click(); URL.revokeObjectURL(a.href);
});
$('btnCopy').addEventListener('click', async () => {
  const s = app._sum; if (!s) return;
  const txt = `FocusLens session: focused ${mmss(s.st.focusMs)}, paused ${mmss(s.st.pausedMs)} (${s.pct}% focused), ${s.st.pauseCount} pauses, longest streak ${mmss(s.st.longestStreakMs)}.`;
  try { await navigator.clipboard.writeText(txt); toast('Copied.'); } catch { toast('Couldn’t copy. Select the numbers instead.'); }
});

// ------------------------------------------------------------------ main loop
document.addEventListener('visibilitychange', () => render(performance.now()));
setInterval(() => {
  const now = performance.now();
  engine.tick(now); handleEvents(now); render(now);
}, 100);

applyPreset(store.get('preset', '25-5'));
updateMeterZones(); updateFinderEmpty(); render(performance.now());

// First-launch introduction: Skip closes the introduction; Continue advances.
const welcomeDialog = $('welcomeDialog');
function closeWelcome() { if (welcomeDialog.open) welcomeDialog.close(); }
$('welcomeSkip1').addEventListener('click', closeWelcome);
$('welcomeSkip2').addEventListener('click', closeWelcome);
$('welcomeContinue1').addEventListener('click', () => {
  $('welcomeStep1').hidden = true;
  $('welcomeStep2').hidden = false;
});
$('welcomeContinue2').addEventListener('click', closeWelcome);
welcomeDialog.showModal();

// handles for tests and the demo console
window.__fl = { engine, app, onFrame, calibrate, startSession, render };
