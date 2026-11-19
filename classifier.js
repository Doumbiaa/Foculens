// Browser inference for the supplied scikit-learn MLPClassifier + StandardScaler.
// Architecture: 5 inputs -> 64 ReLU units -> 1 sigmoid output.
// Feature order and scaler parameters are exported from the supplied pickle files.
import modelData from './focuslens_mlp.json' with { type: 'json' };

export const CLASSIFIER_FEATURES = modelData.feature_names;
export const CLASS_LABELS = { 0: 'Not focused', 1: 'Focused' };

function sigmoid(x) {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const ex = Math.exp(x);
  return ex / (1 + ex);
}

export function predictFocus(features) {
  const raw = CLASSIFIER_FEATURES.map((name) => Number(features[name]));
  if (raw.some((v) => !Number.isFinite(v))) throw new Error('Invalid classifier features');

  // Apply the exact StandardScaler fitted during model training.
  const x = raw.map((v, i) => (v - modelData.scaler.mean[i]) / modelData.scaler.scale[i]);

  // Hidden dense layer: ReLU(XW + b).
  const hidden = modelData.hidden.bias.map((bias, j) => {
    let value = bias;
    for (let i = 0; i < x.length; i++) value += x[i] * modelData.hidden.weights[i][j];
    return Math.max(0, value);
  });

  // Binary output layer: sigmoid(hidden·w + b) = P(class 1).
  let logit = modelData.output.bias;
  for (let j = 0; j < hidden.length; j++) logit += hidden[j] * modelData.output.weights[j];
  const p1 = sigmoid(logit);
  const probabilities = { 0: 1 - p1, 1: p1 };
  const predictedClass = p1 >= 0.5 ? 1 : 0;

  return {
    classId: predictedClass,
    label: CLASS_LABELS[predictedClass],
    probabilities,
  };
}

// EAR from the standard six-point MediaPipe Face Mesh eye contours.
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function eyeAspectRatio(landmarks, p) {
  const vertical = distance(landmarks[p[1]], landmarks[p[5]]) + distance(landmarks[p[2]], landmarks[p[4]]);
  const horizontal = 2 * distance(landmarks[p[0]], landmarks[p[3]]);
  return horizontal > 0 ? vertical / horizontal : NaN;
}
export function extractEAR(landmarks) {
  return {
    ear_left: eyeAspectRatio(landmarks, [362, 385, 387, 263, 373, 380]),
    ear_right: eyeAspectRatio(landmarks, [33, 160, 158, 133, 153, 144]),
  };
}
