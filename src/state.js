// Centralized Reactive Studio State & Undo/Redo History

const listeners = new Map();

export const state = {
  mode: 'sketch', // 'sketch' | 'inflate' | 'paint' | 'animate'
  uiScale: 1.15,

  // Sketch parameters
  gridRes: 24,
  sketchTool: 'closed', // 'closed' | 'flap' | 'extrude' | 'edit'
  flapSide: 'sym', // 'sym' | 'front' | 'back'
  mirrorX: false,
  lassoMode: false,
  sketchWireframe: false,
  strokes: [],
  activeStrokeId: null,
  refImage: null,
  refClampedCanvas: null,
  refAlpha: 0.35,
  refName: '',
  refSettingsOpen: false,
  refTrace: {
    autoTrace: true,
    clampPx: 64,
    gridClamp: 24,
    simplify: 0.75,
    alphaThresh: 90,
    padCells: 2,
    pixelate: true,
    mirrorBack: true,
    autoCrop: true,
    alphaMode: true,
  },

  // Inflation & Mesh parameters
  meshMode: 'lowpoly', // 'lowpoly' | 'full'
  lowPolyDetail: 6,
  depth: 0.34,
  roundness: 0.65,
  shadingMode: 'faceted', // 'faceted' | 'clay' | 'unlit'
  wireframe: false,
  alphaCutout: false,
  inflateTool: 'grab', // 'orbit' | 'grab'

  // Built Mesh Data (populated by mesher.js)
  mesh: null,

  // UV Paint parameters
  paintColor: '#d97724',
  paintTool: 'brush', // 'brush' | 'fill' | 'pick'
  brushSize: 1,
  uvRes: 64,
  uvMirrorFB: true,
  uvSymX: false,

  // Soft-Body Physics & Pin Animation parameters
  pinTool: 'drag', // 'drag' | 'grab' | 'anchor' | 'delete'
  pins: [],
  selectedPinId: null,
  playing: false,
  recording: false,
  frame: 0,
  totalFrames: 60,
  fps: 24,
  bounce: 0.55,
  rigidity: 0.85,
  springStiffness: 0.34,
  damping: 0.25,
  grabRadius: 0.18,
  gravity: 0.0,
  waveTransfer: 0.65,
  volumePreserve: 0.45,
  hingeFlex: 0.65,

  // Camera
  camYaw: 0.45,
  camPitch: 0.22,
  camDist: 2.85,
  camTarget: [0, 0, 0],
};

const undoStack = [];
const redoStack = [];
const MAX_HISTORY = 40;

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of set) fn(payload);
}

function cloneSnapshot() {
  return JSON.stringify({
    strokes: state.strokes,
    activeStrokeId: state.activeStrokeId,
    gridRes: state.gridRes,
    meshMode: state.meshMode,
    lowPolyDetail: state.lowPolyDetail,
    depth: state.depth,
    roundness: state.roundness,
    grabRadius: state.grabRadius,
    hingeFlex: state.hingeFlex,
    pins: state.pins,
  });
}

export function pushHistory() {
  undoStack.push(cloneSnapshot());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
}

export function undo() {
  if (undoStack.length === 0) return false;
  redoStack.push(cloneSnapshot());
  const snap = JSON.parse(undoStack.pop());
  applySnapshot(snap);
  return true;
}

export function redo() {
  if (redoStack.length === 0) return false;
  undoStack.push(cloneSnapshot());
  const snap = JSON.parse(redoStack.pop());
  applySnapshot(snap);
  return true;
}

function applySnapshot(snap) {
  state.strokes = snap.strokes;
  state.activeStrokeId = snap.activeStrokeId;
  state.gridRes = snap.gridRes;
  state.meshMode = snap.meshMode;
  state.lowPolyDetail = snap.lowPolyDetail ?? 6;
  state.depth = snap.depth;
  state.roundness = snap.roundness;
  state.grabRadius = snap.grabRadius ?? 0.18;
  state.hingeFlex = snap.hingeFlex ?? 0.65;
  state.pins = snap.pins || [];
  emit('history:applied');
  emit('mesh:dirty');
  emit('ui:sync');
}
