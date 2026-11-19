---
title: FocusLens
emoji: 🔍
colorFrom: green
colorTo: blue
sdk: static
pinned: false
short_description: A study timer that pauses when you look away.
---

# FocusLens

A Pomodoro timer that watches your focus, not just the clock. It uses your webcam to check head angle and eye
closure, **pauses the timer when you stop studying** and **resumes it when you come back**.

FocusLens includes the original transparent rule-based engine and a trained MLP classifier. The user can choose which detector controls the timer. MediaPipe Face Landmarker extracts head rotation and face landmarks; the classifier
uses yaw, pitch, roll, left EAR and right EAR. Both run locally in the browser; video never leaves the device.

## Two focus detectors

The app offers three selectable detection methods under **Focus detection**:

- **Rule-based logic (MediaPipe):** the original FocusLens rules control the timer.
- **MLP classifier:** the trained classifier alone controls the timer.
- **Both (combined):** the rules and MLP classifier run independently; either detector can trigger the grace window and pause.

The selected method is saved locally and controls the timer. The MLP prediction is shown only in MLP-enabled modes; Rules only never displays a Focused / Not focused class. Its inputs are `yaw`, `pitch`, `roll`, `ear_left`, `ear_right`;
the supplied StandardScaler is applied before inference. EAR is computed from the standard six-point MediaPipe eye landmarks. Confirm that these
landmark indices and the label mapping in `classifier.js` match the original training pipeline before treating
the prediction as validated. The browser mapping is `0 = Not focused`, `1 = Focused`.

## The rules

| Signal | Convention | Limit |
|---|---|---|
| Yaw (turn) | left +, right − | ±15° from where you sit (Strict). Balanced ±20°, Relaxed ±25° |
| Pitch (tilt) | down +, up − | ±15° from where you sit. Notes mode lets you look down to 40° |
| Eyes | 0 open, 1 closed, worse eye by default | warning from 0.4, treated as sleeping from 0.5 |
| No face | | counts as out of range |

* **Calibration:** a 3 s "look at your screen" capture sets your neutral. Limits are measured from it.
* **Ignore glitches:** anything out of range for less than 0.5 s (blinks, jitter) is ignored.
* **Grace window (3, 5, 10, 15 or 30 s):** once you are out of range the timer keeps running and the page shows
  a countdown. If you return in time, nothing happens. If not, the timer **pauses** and shows why.
* **Resume:** as soon as you are back in range (0.3 s of stability) the timer continues.
* **Breaks** are not monitored.
* **Summary + CSV:** pauses, reasons, longest streak. Tick the pauses that were wrong to get a
  *false pauses per focus minute* number (the headline metric of the project's evaluation).
* **Under the hood** drawer: live yaw, pitch and eye values, all thresholds as sliders, and a **simulator**
  that drives the timer without a camera (useful as a backup for a live demo).

## Run it locally

Camera access needs `localhost` or `https`.

```bash
cd focuslens
python -m http.server 8000
# open http://localhost:8000
```

The face model runs on the CPU, so no graphics card is needed. Everything (MediaPipe, WASM, model, fonts) is bundled, so it also works offline after the first load.

## Deploy on Hugging Face (free)

1. Create a new Space, choose **Static** as the SDK.
2. Upload every file in this folder with the web uploader (Files, Add file, Upload files). The web uploader handles
   the large `.wasm` and `.task` files for you. Keep the folder structure.
3. The `README.md` front matter above is already set for a static Space. Open the Space URL and allow the camera.

GitHub Pages also works (Settings, Pages, deploy from branch).

## Files

| File | Purpose |
|---|---|
| `engine.js` | the original rule-based decision logic, no camera or DOM, unit tested |
| `classifier.js` + `focuslens_mlp.json` | browser implementation of the trained MLP classifier |
| `app.js` | camera, MediaPipe, UI |
| `tests/engine.test.mjs` | `node tests/engine.test.mjs` |
| `vendor/` | MediaPipe Tasks Vision 1.2.3 (JS + WASM) |
| `face_landmarker.task` | MediaPipe Face Landmarker model |

## Known limits

* Browsers slow down hidden tabs. Keep the window visible (side by side with your notes).
* Eye scores shift when you look down (lids lower). Use Notes mode, or raise "Eyes closed" in Under the hood.
* The 0.5 "sleeping" bound and the worse-eye rule are assumptions, easy to change in Under the hood.

## Classifier integration notes

The browser MLP model was exported from the supplied `best_focuslens_classifier (1).pkl` and paired with the supplied `focuslens_scaler.pkl`. Its probabilities were numerically compared with scikit-learn across 100 test feature vectors.
The selected detection mode controls automatic pauses. The MLP prediction is available in MLP-enabled modes.

Before interpreting the labels scientifically, verify two training-pipeline details: (1) the class encoding
(`classifier.js` maps class 0 to Not focused and class 1 to Focused), and (2) the exact EAR
landmark indices/formula used when constructing the training columns. The app uses the conventional
six-landmark MediaPipe EAR formula. The supplied StandardScaler is applied before the MLP inference.


## Detection modes (three independent choices)

Use the **Focus detection** selector to choose which detector controls the Pomodoro timer:

- **Rule-based logic (MediaPipe):** the original FocusLens engine evaluates relative yaw, pitch and MediaPipe eye-blink scores against its thresholds. It does not output `Focused` or `Not focused` classes.
- **MLP classifier:** the trained MLP classifier prediction is the only focus decision. `Focused` keeps the timer running; `Not focused` starts the existing grace/pause/resume state machine. If the classifier cannot return a prediction while a face is present, this mode fails safe as `Not focused`.
- **Both (combined):** the original rules and the MLP classifier run independently. A rule violation OR a `Not focused` MLP classifier prediction starts the grace/pause logic. The pause reason identifies the source (`Looking left`, `Eyes closed`, or `MLP classifier: not focused`).

The MLP classifier decision is never converted into a fabricated yaw, pitch or eye-blink value. The classifier uses the raw feature vector in this order: `yaw`, `pitch`, `roll`, `ear_left`, `ear_right`. The rule engine continues using calibrated yaw/pitch and MediaPipe eye-blink scores.

**Important model validation:** the serialized model exposes numeric classes `[0, 1]`, but the pickle alone does not document which numeric class corresponds to which text label. The browser mapping follows the requested convention `0 = Not focused` and `1 = Focused`; verify it against the training notebook / label encoder before relying on predictions. Also confirm that the six-point EAR calculation in `classifier.js` is identical to the EAR extraction used during training.

### Detector-mode tests

Run `node tests/engine.test.mjs`. The suite includes tests proving that MLP-only mode ignores rule thresholds, and that combined mode accepts independent rule-based and classifier decisions.


### Rules-only display behavior
In Rules only mode, the live camera status reports `Within focus rules` rather than a `Focused` class, and the MLP classifier output is explicitly marked as unused. Focused / Not focused labels are reserved for MLP classifier and Both models modes.


## Current MLP classifier (updated)

The previous Random Forest export has been replaced by the supplied scikit-learn `MLPClassifier` and its matching `StandardScaler`.

- Architecture: 5 input features → 64 ReLU hidden units → 1 sigmoid output.
- Feature order: `yaw`, `pitch`, `roll`, `ear_left`, `ear_right`.
- Preprocessing: the supplied StandardScaler is applied using its saved `mean_` and `scale_` values.
- Class mapping used in the browser: `0 = Not focused`, `1 = Focused`.
- Browser inference is implemented in `classifier.js`; exported parameters are in `focuslens_mlp.json`. No Python backend is required.

The numeric class mapping follows the user's instruction. Confirm it against the target encoding used during model training before interpreting predictions as validated labels.
"# Foculens" 
