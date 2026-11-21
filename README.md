# FocusLens

**A Pomodoro timer that watches your focus, not just the clock.**
It uses your webcam to check head angle and eye closure, **pauses the timer when you stop studying**, tells you why, and **resumes when you come back**. Everything runs in your browser. Video never leaves your device.

**[Live app](https://foculens.onrender.com/)** · **Research write-up:** <!-- TODO: paste the public link to the blog post --> · Course project for *Computer Vision, with an Eye Toward Human Perception*, AIMS South Africa (MSc in AI for Science).

> **The research question:** can a computer vision system, using only an ordinary laptop webcam, tell when someone is focused on their screen, well enough to pause a study timer for a person it has never seen?
> Short answer: **partly**. It catches lapses that change how the head or eyes look (phone in the lap, turning to a friend, closed eyes). It cannot see thinking with your eyes on the screen. See [Results](#results) and [Known limits](#known-limits).

---

## Contents

1. [What it does](#what-it-does)
2. [Three focus detectors](#three-focus-detectors)
3. [The rules](#the-rules)
4. [The classifier](#the-classifier)
5. [Results](#results)
6. [Known limits](#known-limits)
7. [Repository layout](#repository-layout)
8. [Run it locally](#run-it-locally)
9. [Deployment](#deployment)
10. [Reproduce the research](#reproduce-the-research)
11. [Data, privacy and intended use](#data-privacy-and-intended-use)
12. [Team, credits and references](#team-credits-and-references)

---

## What it does

- Standard Pomodoro timer (work and break).
- **3 s calibration** ("look at your screen") sets your neutral pose. All limits are measured from it, so a tilted screen or a lap desk does not matter.
- When you look away or close your eyes, the timer keeps running for a **grace window** (default 5 s) and shows a countdown. If you return in time, nothing happens. If not, the timer **pauses** and shows the reason (looking left, looking down, eyes closed, no face, and so on).
- It **resumes** as soon as you are back in range (0.3 s of stability).
- Breaks are not monitored.
- Light and dark themes, a sound warning before a pause, works when the tab is minimised, runs on any CPU (no graphics card), and has a feedback form.
- **Summary + CSV** after a session: number of pauses, reasons, longest streak. Tick the pauses that were wrong to get a *false pauses per focus minute* number. This is the headline metric of the project's evaluation.
- **Under the hood** drawer: live yaw, pitch and eye values, every threshold as a slider, and a **simulator** that drives the timer without a camera (a backup for live demos).

## Three focus detectors

Choose one under **Focus detection**. The choice is saved locally and controls the timer.

| Mode | What decides that you lost focus |
|---|---|
| **Rule-based logic (MediaPipe)** | The transparent rules below. No learning. Shows "Within focus rules", never a Focused / Not focused class. |
| **MLP classifier** | The trained neural network alone. `Focused` keeps the timer running; `Not focused` starts the grace window. If the classifier cannot return a prediction while a face is present, it fails safe as `Not focused`. |
| **Both (combined)** | The rules and the MLP run independently. A rule violation **or** an MLP `Not focused` starts the grace window. The pause reason names the source (`Looking left`, `Eyes closed`, or `MLP classifier: not focused`). |

> **TODO(team):** the project talk and write-up describe the hybrid as "the MLP decides focused or not, and the rules supply the reason". The text above is how the code README described it (either detector can trigger). Please confirm in `app.js` which is true and keep one description everywhere.

All modes share the same grace / pause / resume state machine. The MLP's decision is never converted into a made-up yaw, pitch or eye value.

## The rules

| Signal | Convention | Limit |
|---|---|---|
| Yaw (turn) | left +, right − | ±15° from where you sit (Strict). Balanced ±20°, Relaxed ±25° |
| Pitch (tilt) | down +, up − | ±15° from where you sit. **Notes mode** lets you look down to 40° |
| Eyes | 0 open, 1 closed, worse eye by default | warning from 0.4, treated as closed from 0.5 |
| No face | | counts as out of range |

- **Ignore glitches:** anything out of range for less than 0.5 s (blinks, jitter) is ignored.
- **Grace window:** 3, 5 (default), 10, 15 or 30 s.
- **Hysteresis:** 2° at the limit, so it does not flicker. The newest frame gets half the weight in smoothing.
- **Reason priority** when several things are wrong: no face, eyes, left, right, down, up.
- The 0.5 closed-eye bound and the worse-eye rule are assumptions, easy to change in *Under the hood*.

## The classifier

A small scikit-learn `MLPClassifier` (one hidden layer of 64 ReLU units, logistic output) behind a `StandardScaler`, exported to `focuslens_mlp.json` and run in the browser by `classifier.js`. No Python backend is needed. Its probabilities were checked against scikit-learn on 100 test feature vectors.

- **Trained on our own recordings:** 12 participants, 51,017 labelled frames, person-held-out evaluation (8 train / 2 validation / 2 test).
- **Tuned with Optuna** (30 trials, 4-fold cross-validation that holds out whole people). Final setting: `hidden_layer_sizes=(64,)`, `activation="relu"`, `alpha=0.6009504`, `learning_rate_init=0.0020153`, `solver="adam"`, `early_stopping=True`, `random_state=42` (scikit-learn 1.6.1).
- **Class mapping in the browser:** `0 = Not focused`, `1 = Focused`. Our training data labels lost focus as `1`, so the export must invert it. FocusGuard's public data labels focused as `1`.
- **Inputs:** 13 features per frame: yaw, pitch, abs yaw, abs pitch, pose magnitude √(yaw² + pitch²), roll, abs roll, left and right blink scores, their maximum, a 15-frame rolling mean of that maximum, a downward-gaze score and a sideways-gaze score.

> **TODO(team):** the earlier README said the classifier takes **5** inputs (`yaw, pitch, roll, ear_left, ear_right`, the FocusGuard-data schema). Our own-data model uses the **13** features above. Check `focuslens_mlp.json` and `classifier.js` for the real input count and delete whichever sentence is wrong. Also confirm the class mapping and the EAR formula against the notebook that produced the deployed model.

## Results

Everything below is measured, from the notebooks in this repository.

**MLP on our data, two test people the model never saw**

| Metric | Value |
|---|---|
| Accuracy | **86.6%** (a model that always says "focused" gets 63.9%) |
| Macro F1 | **0.852** |
| Cross-validated macro F1 (held-out people) | 0.827 ± 0.028 |
| Lost-focus frames caught (recall) | 77.5% |
| Frames called lost-focus that really are (precision) | 84% |

The top three tuned models (MLP 0.852, gradient boosting 0.846, random forest 0.845) are too close to rank on two test people. Logistic regression is clearly worse (0.811). We deployed the MLP because it also leads in cross-validation.

**Rule detector on our recordings** (5 s grace, Strict). Of 126 lapses lasting 5 s or more, the timer paused during **105 (83%)**. The price was **0.42 false pauses per minute of real focus**, about ten times our 0.04 target. *These come from an analysis run before the final label cleaning (TODO: re-run to confirm).*

**Second dataset.** The same recipe on FocusGuard's public data (9 people, 5 features) gives similar cross-validated scores (about 0.81 for the best three models). Its 0.96 test score comes from a single held-out person, so we trust cross-validation more.

**Live false pauses per minute** from about 10 people using the deployed app: *TODO: add median and range when collected.*

Hybrid mode has no separate quantitative evaluation. A pixel-based comparison model from our proposal was not built.

## Known limits

- **Thinking and reading.** Looking up or away to think can cause wrong pauses. Thinking with your eyes on the screen is invisible to a camera, so the timer keeps running. This is a limit of the camera, not a bug.
- **Taking notes.** Head down to write looks like a phone in the lap. Notes mode allows 40° of tilt, which saves wrong pauses but also lets a phone pass.
- **More than one face.** The tracker and our features assume one person. Seen in the live app.
- **Face not found.** Poor light, glare, or leaving the frame. Across our sessions a face was found in 81% to 98% of frames. The model never trained on no-face frames.
- **Small sample.** 12 participants and only 2 test people. We did not evaluate by skin tone, age or gender, so people unlike our participants should expect more wrong pauses.
- **Labels.** One observer's reading of another person's attention, delay-corrected, from about five-minute sessions. A large part of the lost-focus frames comes from a scripted block, which is more obvious than natural lapses.
- **Hidden tabs.** Browsers slow hidden tabs. Keep the window visible (side by side with your notes).
- **Eye scores shift when you look down** (lids lower). Use Notes mode, or raise "Eyes closed" in *Under the hood*.

## Repository layout

| Path | Purpose |
|---|---|
| `index.html`, `style.css`, `fonts/` | the app page, styles and bundled fonts |
| `app.js` | camera, MediaPipe, UI |
| `engine.js` | the rule-based decision logic and timer state machine. No camera or DOM. Unit tested |
| `classifier.js` + `focuslens_mlp.json` | browser implementation of the trained MLP and its exported parameters |
| `face_landmarker.task` | MediaPipe Face Landmarker model |
| `vendor/` | MediaPipe Tasks Vision 1.2.3 (JS + WASM) |
| `tests/` | `node tests/engine.test.mjs` (includes tests that MLP-only mode ignores rule thresholds and that combined mode accepts independent decisions) |
| `FocusLens_Notebook.ipynb` | model development on **our own data** (12 people) |
| `Focus_Lens_using_FocusGaurd_Dataset.ipynb` | the same recipe on **FocusGuard's public dataset** |
| `requirements.txt`, `.python-version` | Render deployment dependencies |
| `Focuslens/` | <!-- TODO: say what this folder is (it shows as a link/submodule on GitHub) --> |

## Run it locally

Camera access needs `localhost` or `https`.

```bash
git clone https://github.com/Doumbiaa/Foculens
cd Foculens
python -m http.server 8000
# open http://localhost:8000 and allow the camera
```

The face model runs on the CPU. MediaPipe, WASM, the model and fonts are bundled, so it also works offline after the first load.

Run the tests:

```bash
node tests/engine.test.mjs
```

## Deployment

The live app is hosted on [Render](https://render.com): <https://foculens.onrender.com/>. <!-- TODO: add the Render service type and start command, e.g. static site or `python -m http.server $PORT`. -->
Render may take a few seconds to wake after a period of inactivity. GitHub Pages or a static Hugging Face Space would also work, since the app is plain HTML, CSS and JavaScript.

## Reproduce the research

1. Open `FocusLens_Notebook.ipynb` (our data) or `Focus_Lens_using_FocusGaurd_Dataset.ipynb` (public data) in Jupyter or Colab.
2. Seed is fixed at 42. Versions used: scikit-learn 1.6.1, Optuna, MediaPipe Tasks Vision 1.2.3.
3. Splits are by **person**, never by frame. Cross-validation holds out whole people.
4. The notebooks contain the exact search spaces, the permutation-importance analysis and the confusion matrices.

**What is shared:** the app, the notebooks and the model export. <!-- TODO: say whether processed per-frame features and labels are public. Raw video and frames are never shared, because faces are identifying. -->

## Data, privacy and intended use

- **Privacy:** the app runs locally. Video is processed in your browser and is not uploaded or stored.
- **Research data:** 12 participants, identified only by code (P01 to P06, P09 to P14). Raw video is not shared. <!-- TODO: confirm consent wording for the processed data. -->
- **Meant for:** one person, alone, choosing to use a study timer, facing a screen, on their own device.
- **Not meant for:** proctoring, grading, monitoring someone else, or judging anyone's effort or ability. A study timer that pauses wrongly is an annoyance. A system that judges people is a different matter, and this one is not built or evaluated for it.
- **May work worse for:** people who think by looking away or pacing, people who study on paper or on several screens, and people or settings unlike our 12 participants (face, skin tone, glasses glare, age, lighting).

## Team, credits and references

**Team:** Alimi Sara Gankou · Emmanuel Signe Josue · Manasseh Ibrahim · Cheikh Doumbia. <!-- TODO: add one line per person on what they did. -->

**Credit for what we did not make**
- MediaPipe Face Landmarker and Tasks Vision (Google), Apache-2.0.
- FocusGuard public dataset and README, Hugging Face Space `FocusGuard/final_test`.
- scikit-learn (Pedregosa et al., 2011), Optuna (Akiba et al., 2019), Adam (Kingma and Ba, 2015).
- Eye aspect ratio: Soukupová and Čech (2016).
- Pomodoro Technique: Cirillo (2006).
- The rule logic, the data-collection tool and this document were written with help from Claude, an AI assistant made by Anthropic. We checked the numbers against our notebooks.

Thanks to our instructors Fernanda de la Torre and Shreya Pandit, and to our 12 participants.

**Cite**

```bibtex
@misc{focuslens2026,
  author = {Gankou, Alimi Sara and Josue, Emmanuel Signe and Ibrahim, Manasseh and Doumbia, Cheikh},
  title  = {Can a webcam tell when you have stopped studying? {FocusLens}},
  year   = {2026},
  note   = {AIMS South Africa course project. https://github.com/Doumbiaa/Foculens}
}
```

**License:** MIT
