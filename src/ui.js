// Brutalist Studio UI Controller, Draggable Floating Windows, Per-Part & Physics Controls, UV Undo/Redo

import { state, on, emit, undo, redo, pushHistory } from './state.js';
import {
  buildClampedSquareCanvas,
  traceClampedCanvasToStrokes,
  projectClampedToUvAtlas,
} from './image-tracer.js';

const QUICK_PALETTE = [
  '#ffffff', '#d4d4d8', '#71717a', '#18181b',
  '#d97724', '#f5b062', '#dc2626', '#fb7185',
  '#4c2c4a', '#7e22ce', '#2563eb', '#22d3ee',
  '#16a34a', '#a3e635', '#facc15', '#e5c1a1',
];

function hsvToHex(h, s, v) {
  const f = (n, k = (n + h * 6) % 6) => v - v * s * Math.max(Math.min(k, 4 - k, 1), 0);
  const r = Math.round(f(5) * 255);
  const g = Math.round(f(3) * 255);
  const b = Math.round(f(1) * 255);
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

function hexToHsv(hex) {
  const clean = hex.replace('#', '');
  const n = parseInt(clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

export class UIController {
  constructor({ sketchCanvas, uvPainter, animator, loadPreset, newProject }) {
    this.sketchCanvas = sketchCanvas;
    this.uvPainter = uvPainter;
    this.animator = animator;
    this.loadPreset = loadPreset;
    this.newProject = newProject;
    this.hsv = hexToHsv(state.paintColor);

    this.initFloatingWindows();
    this.initCategories();
    this.initTopBar();
    this.initSettingsWindow();
    this.initSketchWindow();
    this.initInflateWindow();
    this.initReferenceWindow();
    this.initPaintWindow();
    this.initAnimateWindow();
    this.initKeyboardShortcuts();

    on('ui:sync', () => this.syncAll());
    on('timeline:dirty', () => this.renderTimeline());
    on('timeline:frame', () => this.updatePlayhead());
    on('color:picked', (hex) => {
      this.hsv = hexToHsv(hex);
      this.drawColorPickers();
      this.syncColorWidgets();
    });

    this.syncAll();
  }

  initCategories() {
    document.querySelectorAll('[data-cat-toggle]').forEach((head) => {
      head.addEventListener('click', () => {
        const sec = document.getElementById(head.dataset.catToggle);
        if (!sec) return;
        const collapsed = sec.classList.toggle('collapsed');
        const arrow = head.querySelector('.cat-arrow');
        if (arrow) arrow.textContent = collapsed ? '▸' : '▾';
      });
    });
  }

  initSettingsWindow() {
    const win = document.getElementById('win-settings');
    document.getElementById('btn-settings')?.addEventListener('click', () => {
      win?.classList.toggle('hidden');
      this.syncSettingsControls();
    });
    document.getElementById('btn-settings-close')?.addEventListener('click', () => {
      win?.classList.add('hidden');
    });

    const applyUiScale = (val) => {
      state.uiScale = Math.max(0.80, Math.min(1.45, val));
      document.documentElement.style.setProperty('--ui-scale', String(state.uiScale));
      this.syncSettingsControls();
      requestAnimationFrame(() => {
        this.sketchCanvas.render();
        this.uvPainter.render2D();
      });
    };

    document.getElementById('sl-ui-scale')?.addEventListener('input', (e) => {
      applyUiScale(parseFloat(e.target.value));
    });

    document.querySelectorAll('[data-ui-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyUiScale(parseFloat(btn.dataset.uiPreset));
      });
    });

    document.getElementById('btn-set-sketch-wire')?.addEventListener('click', () => {
      this.toggleSketchWireframe();
    });
    document.getElementById('btn-set-3d-wire')?.addEventListener('click', () => {
      this.toggleWireframe();
    });

    document.getElementById('btn-set-reset-layout')?.addEventListener('click', () => {
      const defaults = {
        'win-layers': { bottom: '10px', left: '10px', top: 'auto', right: 'auto' },
        'win-inflate': { top: '10px', right: '10px', left: 'auto', bottom: 'auto' },
        'win-ref': { bottom: '10px', right: '10px', left: 'auto', top: 'auto' },
        'win-paint': { top: '10px', left: '10px', right: 'auto', bottom: 'auto' },
        'win-animate': { bottom: '10px', left: '10px', top: 'auto', right: '' },
      };
      for (const [id, pos] of Object.entries(defaults)) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.style.top = pos.top;
        el.style.bottom = pos.bottom;
        el.style.left = pos.left;
        el.style.right = pos.right;
      }
    });
  }

  syncSettingsControls() {
    const sl = document.getElementById('sl-ui-scale');
    const lbl = document.getElementById('val-ui-scale');
    if (sl) sl.value = state.uiScale.toFixed(2);
    if (lbl) lbl.textContent = `${Math.round(state.uiScale * 100)}%`;
    document.querySelectorAll('[data-ui-preset]').forEach((b) => {
      b.classList.toggle('active', Math.abs(parseFloat(b.dataset.uiPreset) - state.uiScale) < 0.02);
    });
    this.syncWireframeButtons();
  }

  performUndo() {
    if (state.mode === 'paint') {
      if (this.uvPainter.undoUv()) return;
    }
    undo();
  }

  performRedo() {
    if (state.mode === 'paint') {
      if (this.uvPainter.redoUv()) return;
    }
    redo();
  }

  initFloatingWindows() {
    document.querySelectorAll('[data-drag-win]').forEach((header) => {
      const win = document.getElementById(header.dataset.dragWin);
      let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;

      header.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        dragging = true;
        const rect = win.getBoundingClientRect();
        const pRect = win.parentElement.getBoundingClientRect();
        ox = rect.left - pRect.left;
        oy = rect.top - pRect.top;
        sx = e.clientX;
        sy = e.clientY;
        win.style.right = 'auto';
        win.style.bottom = 'auto';
        win.style.left = `${ox}px`;
        win.style.top = `${oy}px`;
        header.setPointerCapture(e.pointerId);
      });

      header.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const nx = Math.max(4, ox + (e.clientX - sx));
        const ny = Math.max(4, oy + (e.clientY - sy));
        win.style.left = `${nx}px`;
        win.style.top = `${ny}px`;
      });

      header.addEventListener('pointerup', () => { dragging = false; });
    });

    document.querySelectorAll('[data-min-win]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const win = document.getElementById(btn.dataset.minWin);
        const collapsed = win.classList.toggle('collapsed');
        btn.textContent = collapsed ? '+' : '_';
      });
    });
  }

  initTopBar() {
    document.getElementById('btn-new').addEventListener('click', () => {
      this.newProject();
    });
    document.getElementById('btn-undo').addEventListener('click', () => this.performUndo());
    document.getElementById('btn-redo').addEventListener('click', () => this.performRedo());

    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.setMode(btn.dataset.mode));
    });

    const presetSel = document.getElementById('preset-select');
    presetSel.addEventListener('change', () => {
      if (presetSel.value) {
        this.loadPreset(presetSel.value);
        presetSel.value = '';
      }
    });

    document.getElementById('btn-wireframe')?.addEventListener('click', () => {
      this.toggleWireframe();
    });

    document.getElementById('btn-export-obj').addEventListener('click', () => this.exportObj());

    const helpWin = document.getElementById('win-help');
    document.getElementById('btn-help').addEventListener('click', () => {
      helpWin.classList.toggle('hidden');
    });
    document.getElementById('btn-help-close').addEventListener('click', () => {
      helpWin.classList.add('hidden');
    });

    document.querySelectorAll('.cam-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const c = btn.dataset.cam;
        if (c === 'front') { state.camYaw = 0; state.camPitch = 0.08; }
        else if (c === 'iso') { state.camYaw = 0.55; state.camPitch = 0.25; }
        else if (c === 'side') { state.camYaw = Math.PI * 0.5; state.camPitch = 0.08; }
        else if (c === 'back') { state.camYaw = Math.PI; state.camPitch = 0.08; }
        state.camTarget = [0, 0, 0];
      });
    });
  }

  setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.mode-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });

    const grid = document.getElementById('viewport-grid');
    grid.className = `viewport-grid mode-${mode}`;

    const sketchEl = document.getElementById('sketch-canvas');
    const uvEl = document.getElementById('uv-canvas');
    const label2d = document.getElementById('pane-2d-label');

    const winLayers = document.getElementById('win-layers');
    const winInflate = document.getElementById('win-inflate');
    const winRef = document.getElementById('win-ref');
    const winPaint = document.getElementById('win-paint');
    const winAnim = document.getElementById('win-animate');
    const btnSketchWire = document.getElementById('btn-sketch-wire');
    const catPhysics = document.getElementById('cat-physics');
    const inflateToolRow = document.getElementById('inflate-tool-row');

    sketchEl.classList.toggle('hidden', mode !== 'sketch');
    uvEl.classList.toggle('hidden', mode !== 'paint');
    btnSketchWire?.classList.toggle('hidden', mode !== 'sketch');

    winLayers.classList.toggle('hidden', mode !== 'sketch');
    winRef.classList.toggle('hidden', mode !== 'sketch');
    winInflate.classList.toggle('hidden', mode === 'paint');
    winPaint.classList.toggle('hidden', mode !== 'paint');
    winAnim.classList.toggle('hidden', mode !== 'animate');

    // Physics sliders & 3D Grab toggle only appear in [2] INFLATE 3D, with 3D GRAB active by default
    catPhysics?.classList.toggle('hidden', mode !== 'inflate');
    inflateToolRow?.classList.toggle('hidden', mode !== 'inflate');
    if (mode === 'inflate') {
      state.inflateTool = 'grab';
      this.syncInflateControls();
    }

    if (mode === 'sketch') label2d.textContent = '2D GRID SKETCH';
    if (mode === 'paint') {
      label2d.textContent = '2D PIXEL UV ATLAS (1:1)';
      requestAnimationFrame(() => this.uvPainter.render2D());
    }
    if (mode === 'sketch') {
      requestAnimationFrame(() => this.sketchCanvas.render());
    }

    this.animator.refreshPins();
    this.animator.syncOverlay();
  }

  initSketchWindow() {
    const toolClosed = document.getElementById('tool-draw-closed');
    const toolFlap = document.getElementById('tool-draw-flap');
    const toolExtrude = document.getElementById('tool-draw-extrude');
    const toolEdit = document.getElementById('tool-edit-verts');
    const flapRow = document.getElementById('flap-side-row');

    const setTool = (t) => {
      state.sketchTool = t;
      toolClosed.classList.toggle('active', t === 'closed');
      toolFlap.classList.toggle('active', t === 'flap');
      toolExtrude.classList.toggle('active', t === 'extrude');
      toolEdit.classList.toggle('active', t === 'edit');
      flapRow.classList.toggle('hidden', t !== 'flap' && t !== 'extrude');
      this.sketchCanvas.draftPoints = [];
      this.sketchCanvas.render();
    };

    toolClosed.addEventListener('click', () => setTool('closed'));
    toolFlap.addEventListener('click', () => setTool('flap'));
    toolExtrude.addEventListener('click', () => setTool('extrude'));
    toolEdit.addEventListener('click', () => setTool('edit'));

    document.querySelectorAll('[data-flap-side]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.flapSide = btn.dataset.flapSide;
        document.querySelectorAll('[data-flap-side]').forEach((b) => {
          b.classList.toggle('active', b.dataset.flapSide === state.flapSide);
        });
      });
    });

    const slGrid = document.getElementById('sl-grid');
    slGrid.addEventListener('input', () => {
      const oldRes = state.gridRes;
      const newRes = parseInt(slGrid.value, 10);
      if (oldRes === newRes) return;
      const ratio = newRes / oldRes;
      for (const s of state.strokes) {
        for (const p of s.points) {
          p.gx = Math.round(p.gx * ratio);
          p.gy = Math.round(p.gy * ratio);
        }
      }
      state.gridRes = newRes;
      document.getElementById('val-grid').textContent = String(newRes);
      this.sketchCanvas.render();
      emit('mesh:dirty');
    });

    const btnMirror = document.getElementById('btn-mirror-x');
    btnMirror.addEventListener('click', () => {
      state.mirrorX = !state.mirrorX;
      btnMirror.classList.toggle('active', state.mirrorX);
      this.sketchCanvas.render();
    });

    const btnLasso = document.getElementById('btn-lasso-mode');
    btnLasso.addEventListener('click', () => {
      state.lassoMode = !state.lassoMode;
      btnLasso.classList.toggle('active', state.lassoMode);
      btnLasso.textContent = state.lassoMode ? 'LASSO' : 'POLY';
      this.sketchCanvas.draftPoints = [];
      this.sketchCanvas.render();
    });

    document.getElementById('btn-sketch-fit')?.addEventListener('click', () => {
      this.sketchCanvas.resetView();
    });

    document.getElementById('btn-sketch-wire')?.addEventListener('click', () => {
      this.toggleSketchWireframe();
    });

    document.getElementById('btn-clear-sketch').addEventListener('click', () => {
      pushHistory();
      state.strokes = [];
      state.activeStrokeId = null;
      state.pins = [];
      emit('mesh:dirty');
      this.syncAll();
    });
  }

  toggleSketchWireframe() {
    state.sketchWireframe = !state.sketchWireframe;
    this.syncWireframeButtons();
    this.sketchCanvas.render();
  }

  toggleWireframe() {
    state.wireframe = !state.wireframe;
    this.syncWireframeButtons();
  }

  syncWireframeButtons() {
    document.getElementById('btn-wireframe')?.classList.toggle('active', state.wireframe);
    document.getElementById('btn-inf-wire')?.classList.toggle('active', state.wireframe);
    document.getElementById('btn-set-3d-wire')?.classList.toggle('active', state.wireframe);
    document.getElementById('btn-sketch-wire')?.classList.toggle('active', state.sketchWireframe);
    document.getElementById('btn-set-sketch-wire')?.classList.toggle('active', state.sketchWireframe);
    document.getElementById('btn-inf-alpha')?.classList.toggle('active', state.alphaCutout);
    document.getElementById('btn-uv-alpha')?.classList.toggle('active', state.alphaCutout);
  }

  initInflateWindow() {
    const btnLow = document.getElementById('mesh-mode-lowpoly');
    const btnFull = document.getElementById('mesh-mode-full');

    btnLow.addEventListener('click', () => {
      pushHistory();
      state.meshMode = 'lowpoly';
      this.syncInflateControls();
      emit('mesh:dirty');
    });

    btnFull.addEventListener('click', () => {
      pushHistory();
      state.meshMode = 'full';
      this.syncInflateControls();
      emit('mesh:dirty');
    });

    const slPoly = document.getElementById('sl-poly-detail');
    slPoly.addEventListener('input', () => {
      state.lowPolyDetail = parseInt(slPoly.value, 10);
      document.getElementById('val-poly-detail').textContent = String(state.lowPolyDetail);
      emit('mesh:dirty');
    });

    const slDepth = document.getElementById('sl-depth');
    slDepth.addEventListener('input', () => {
      state.depth = parseFloat(slDepth.value);
      document.getElementById('val-depth').textContent = state.depth.toFixed(2);
      emit('mesh:dirty');
    });

    const slRound = document.getElementById('sl-round');
    slRound.addEventListener('input', () => {
      state.roundness = parseFloat(slRound.value);
      document.getElementById('val-round').textContent = state.roundness.toFixed(2);
      emit('mesh:dirty');
    });

    const slPartDepth = document.getElementById('sl-part-depth');
    slPartDepth.addEventListener('input', () => {
      const active = state.strokes.find((s) => s.id === state.activeStrokeId);
      if (!active) return;
      active.partDepth = parseFloat(slPartDepth.value);
      document.getElementById('val-part-depth').textContent = active.partDepth.toFixed(2);
      emit('mesh:dirty');
    });

    const slPartPuff = document.getElementById('sl-part-puff');
    slPartPuff.addEventListener('input', () => {
      const active = state.strokes.find((s) => s.id === state.activeStrokeId);
      if (!active) return;
      active.partPuff = parseFloat(slPartPuff.value);
      document.getElementById('val-part-puff').textContent = active.partPuff.toFixed(2);
      emit('mesh:dirty');
    });

    const slPartAttach = document.getElementById('sl-part-attach');
    slPartAttach?.addEventListener('input', () => {
      const active = state.strokes.find((s) => s.id === state.activeStrokeId);
      if (!active || active.type !== 'flap') return;
      active.flapAttach = parseInt(slPartAttach.value, 10);
      document.getElementById('val-part-attach').textContent = `${active.flapAttach}%`;
      this.sketchCanvas.render();
      emit('mesh:dirty');
    });

    const setPartType = (nextType) => {
      const active = state.strokes.find((s) => s.id === state.activeStrokeId);
      if (!active || active.type === nextType) return;
      pushHistory();
      active.type = nextType;
      active.partRole = 'auto';
      if (nextType === 'flap' && (active.flapAttach === undefined || active.flapAttach === 100)) {
        active.flapAttach = 0;
      }
      emit('mesh:dirty');
      this.syncAll();
      this.sketchCanvas.render();
    };
    document.getElementById('btn-part-body')?.addEventListener('click', () => setPartType('closed'));
    document.getElementById('btn-part-flap')?.addEventListener('click', () => setPartType('flap'));

    const cyclePart = (dir) => {
      if (state.strokes.length === 0) return;
      const curIdx = state.strokes.findIndex((s) => s.id === state.activeStrokeId);
      const nextIdx = curIdx < 0
        ? 0
        : (curIdx + dir + state.strokes.length) % state.strokes.length;
      state.activeStrokeId = state.strokes[nextIdx].id;
      this.renderLayerList();
      this.syncInflateControls();
      this.sketchCanvas.render();
    };
    document.getElementById('btn-part-prev')?.addEventListener('click', () => cyclePart(-1));
    document.getElementById('btn-part-next')?.addEventListener('click', () => cyclePart(1));

    // Soft-Body Physics sliders in Inflation & Mesh
    document.getElementById('sl-inf-elastic')?.addEventListener('input', (e) => {
      state.rigidity = parseFloat(e.target.value);
      this.syncPhysicsControls();
    });
    document.getElementById('sl-inf-spring')?.addEventListener('input', (e) => {
      state.springStiffness = parseFloat(e.target.value);
      this.syncPhysicsControls();
    });
    document.getElementById('sl-inf-damp')?.addEventListener('input', (e) => {
      state.damping = parseFloat(e.target.value);
      this.syncPhysicsControls();
    });
    document.getElementById('sl-inf-bounce')?.addEventListener('input', (e) => {
      state.bounce = parseFloat(e.target.value);
      this.syncPhysicsControls();
    });
    document.getElementById('sl-inf-grav')?.addEventListener('input', (e) => {
      state.gravity = parseFloat(e.target.value);
      this.syncPhysicsControls();
    });
    document.getElementById('sl-inf-wave')?.addEventListener('input', (e) => {
      state.waveTransfer = parseFloat(e.target.value);
      this.syncPhysicsControls();
    });
    document.getElementById('sl-inf-squash')?.addEventListener('input', (e) => {
      state.volumePreserve = parseFloat(e.target.value);
      this.syncPhysicsControls();
    });
    document.getElementById('sl-inf-hinge')?.addEventListener('input', (e) => {
      state.hingeFlex = parseFloat(e.target.value);
      this.syncPhysicsControls();
      emit('mesh:dirty');
    });
    document.getElementById('sl-inf-grab-r')?.addEventListener('input', (e) => {
      state.grabRadius = parseFloat(e.target.value);
      this.syncPhysicsControls();
      this.animator.refreshPins();
    });

    document.querySelectorAll('.shade-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.shadingMode = btn.dataset.shade;
        document.querySelectorAll('.shade-btn').forEach((b) => {
          b.classList.toggle('active', b.dataset.shade === state.shadingMode);
        });
      });
    });

    document.getElementById('btn-inf-wire')?.addEventListener('click', () => {
      this.toggleWireframe();
    });

    document.getElementById('btn-inf-alpha')?.addEventListener('click', () => {
      this.toggleAlphaMode();
    });

    const btnOrbit = document.getElementById('btn-inflate-orbit');
    const btnGrab = document.getElementById('btn-inflate-grab');
    btnOrbit.addEventListener('click', () => {
      state.inflateTool = 'orbit';
      btnOrbit.classList.add('active');
      btnGrab.classList.remove('active');
    });
    btnGrab.addEventListener('click', () => {
      state.inflateTool = 'grab';
      btnGrab.classList.add('active');
      btnOrbit.classList.remove('active');
    });
  }

  applyReferenceTrace(saveUndo = false) {
    if (!state.refImage) return;
    const cfg = state.refTrace;
    const clamped = buildClampedSquareCanvas(state.refImage, {
      clampPx: cfg.clampPx,
      gridClamp: cfg.gridClamp,
      padCells: cfg.padCells,
      alphaThresh: cfg.alphaThresh,
      pixelate: cfg.pixelate,
      autoCrop: cfg.autoCrop,
    });
    state.refClampedCanvas = clamped.canvas;

    const traced = traceClampedCanvasToStrokes(clamped.canvas, {
      gridClamp: cfg.gridClamp,
      alphaThresh: cfg.alphaThresh,
      simplify: cfg.simplify,
    });

    if (saveUndo) pushHistory();
    state.gridRes = cfg.gridClamp;
    state.uvRes = cfg.clampPx;
    state.alphaCutout = cfg.alphaMode !== false;

    if (traced.length > 0) {
      state.strokes = traced;
      state.activeStrokeId = traced[0].id;
      state.pins = [];
      state.selectedPinId = null;
    }

    emit('mesh:dirty');
    projectClampedToUvAtlas(this.uvPainter, clamped.canvas, {
      uvRes: cfg.clampPx,
      mirrorBack: cfg.mirrorBack,
      pixelate: cfg.pixelate,
      alphaThresh: cfg.alphaThresh,
      alphaMode: cfg.alphaMode,
    });

    this.renderReferencePreview(clamped);
    this.syncAll();
    this.sketchCanvas.render();
  }

  renderReferencePreview(clampedMeta = null) {
    const previewWrap = document.getElementById('ref-preview-wrap');
    const previewCanvas = document.getElementById('ref-preview-canvas');
    const metaTag = document.getElementById('ref-meta-tag');
    if (!previewWrap || !previewCanvas) return;

    const hasRef = !!(state.refClampedCanvas || state.refImage);
    previewWrap.classList.toggle('hidden', !hasRef);
    if (!hasRef) return;

    const ctx = previewCanvas.getContext('2d');
    const cw = previewCanvas.width;
    const ch = previewCanvas.height;
    ctx.clearRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = !state.refTrace.pixelate;

    const src = state.refClampedCanvas || state.refImage;
    const scale = Math.min((cw - 8) / src.width, (ch - 8) / src.height);
    const dw = Math.max(1, Math.round(src.width * scale));
    const dh = Math.max(1, Math.round(src.height * scale));
    ctx.drawImage(src, Math.round((cw - dw) * 0.5), Math.round((ch - dh) * 0.5), dw, dh);

    if (metaTag) {
      const sw = clampedMeta?.srcW || state.refImage?.naturalWidth || state.refImage?.width || 0;
      const sh = clampedMeta?.srcH || state.refImage?.naturalHeight || state.refImage?.height || 0;
      const pts = state.strokes.reduce((acc, s) => acc + s.points.length, 0);
      metaTag.textContent = `${sw}x${sh} -> ${state.refTrace.clampPx}PX | ${pts}V`;
    }
  }

  syncReferenceControls() {
    const cfg = state.refTrace;
    const hasRef = !!state.refImage;
    const settingsBox = document.getElementById('ref-gen-settings');
    const previewWrap = document.getElementById('ref-preview-wrap');
    const toggleHint = document.getElementById('ref-toggle-hint');
    const status = document.getElementById('ref-status');

    if (status) {
      status.textContent = hasRef && state.refName
        ? `REF: ${state.refName.slice(0, 14).toUpperCase()} (SWAP)`
        : 'LOAD / DROP PNG REF';
    }
    if (previewWrap) previewWrap.classList.toggle('hidden', !hasRef);
    if (settingsBox) settingsBox.classList.toggle('hidden', !hasRef || !state.refSettingsOpen);
    if (toggleHint) {
      toggleHint.textContent = state.refSettingsOpen ? '[▾] HIDE SETTINGS' : '[▸] GEN SETTINGS';
    }

    document.querySelectorAll('.clamp-px-btn').forEach((b) => {
      b.classList.toggle('active', parseInt(b.dataset.clampPx, 10) === cfg.clampPx);
    });

    const setVal = (slId, valId, val, fmt = String) => {
      const sl = document.getElementById(slId);
      const lbl = document.getElementById(valId);
      if (sl) sl.value = val;
      if (lbl) lbl.textContent = fmt(val);
    };
    setVal('sl-ref-grid', 'val-ref-grid', cfg.gridClamp);
    setVal('sl-ref-simplify', 'val-ref-simplify', cfg.simplify, (v) => v.toFixed(2));
    setVal('sl-ref-alphacut', 'val-ref-alphacut', cfg.alphaThresh);
    setVal('sl-ref-pad', 'val-ref-pad', cfg.padCells);
    setVal('sl-ref-alpha', 'val-ref-alpha', state.refAlpha, (v) => `${Math.round(v * 100)}%`);

    document.getElementById('btn-ref-pixelate')?.classList.toggle('active', cfg.pixelate);
    document.getElementById('btn-ref-crop')?.classList.toggle('active', cfg.autoCrop);
    document.getElementById('btn-ref-mirror-back')?.classList.toggle('active', cfg.mirrorBack);
    document.getElementById('btn-ref-alpha-mode')?.classList.toggle('active', cfg.alphaMode !== false);
  }

  toggleAlphaMode() {
    const next = !state.alphaCutout;
    state.alphaCutout = next;
    state.refTrace.alphaMode = next;
    if (state.refClampedCanvas) {
      projectClampedToUvAtlas(this.uvPainter, state.refClampedCanvas, {
        uvRes: state.refTrace.clampPx,
        mirrorBack: state.refTrace.mirrorBack,
        pixelate: state.refTrace.pixelate,
        alphaThresh: state.refTrace.alphaThresh,
        alphaMode: next,
      });
    }
    this.syncAll();
  }

  initReferenceWindow() {
    const winRef = document.getElementById('win-ref');
    const dropZone = document.getElementById('ref-drop-zone');
    const upload = document.getElementById('ref-upload');
    const previewWrap = document.getElementById('ref-preview-wrap');

    const loadFile = (file) => {
      if (!file || !file.type.startsWith('image/')) return;
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        state.refImage = img;
        state.refName = file.name || 'image.png';
        // Clamp very small pixel sprites cleanly at 32px, huge images default to 64px (user-adjustable up to 256px)
        const maxDim = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
        if (maxDim <= 32) state.refTrace.clampPx = 32;
        else if (state.refTrace.clampPx === 32 && maxDim >= 128) state.refTrace.clampPx = 64;

        // Open Reference window & expose clamping/generation settings right upon image upload
        if (winRef) {
          winRef.classList.remove('collapsed');
          const minBtn = winRef.querySelector('[data-min-win="win-ref"]');
          if (minBtn) minBtn.textContent = '_';
        }
        state.refSettingsOpen = true;
        this.applyReferenceTrace(true);
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    };

    upload.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) loadFile(file);
    });

    if (dropZone) {
      ['dragenter', 'dragover'].forEach((ev) => {
        dropZone.addEventListener(ev, (e) => {
          e.preventDefault();
          dropZone.classList.add('drag-over');
        });
      });
      ['dragleave', 'drop'].forEach((ev) => {
        dropZone.addEventListener(ev, (e) => {
          e.preventDefault();
          dropZone.classList.remove('drag-over');
        });
      });
      dropZone.addEventListener('drop', (e) => {
        const file = e.dataTransfer?.files?.[0];
        if (file) loadFile(file);
      });
    }

    previewWrap?.addEventListener('click', () => {
      if (!state.refImage) return;
      state.refSettingsOpen = !state.refSettingsOpen;
      this.syncReferenceControls();
    });

    document.querySelectorAll('.clamp-px-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.refTrace.clampPx = parseInt(btn.dataset.clampPx, 10);
        this.applyReferenceTrace(true);
      });
    });

    document.getElementById('sl-ref-grid')?.addEventListener('input', (e) => {
      state.refTrace.gridClamp = parseInt(e.target.value, 10);
      this.applyReferenceTrace(false);
    });

    document.getElementById('sl-ref-simplify')?.addEventListener('input', (e) => {
      state.refTrace.simplify = parseFloat(e.target.value);
      this.applyReferenceTrace(false);
    });

    document.getElementById('sl-ref-alphacut')?.addEventListener('input', (e) => {
      state.refTrace.alphaThresh = parseInt(e.target.value, 10);
      this.applyReferenceTrace(false);
    });

    document.getElementById('sl-ref-pad')?.addEventListener('input', (e) => {
      state.refTrace.padCells = parseInt(e.target.value, 10);
      this.applyReferenceTrace(false);
    });

    document.getElementById('btn-ref-pixelate')?.addEventListener('click', () => {
      state.refTrace.pixelate = !state.refTrace.pixelate;
      this.applyReferenceTrace(true);
    });

    document.getElementById('btn-ref-crop')?.addEventListener('click', () => {
      state.refTrace.autoCrop = !state.refTrace.autoCrop;
      this.applyReferenceTrace(true);
    });

    document.getElementById('btn-ref-mirror-back')?.addEventListener('click', () => {
      state.refTrace.mirrorBack = !state.refTrace.mirrorBack;
      this.applyReferenceTrace(true);
    });

    document.getElementById('btn-ref-alpha-mode')?.addEventListener('click', () => {
      state.refTrace.alphaMode = !state.refTrace.alphaMode;
      state.alphaCutout = state.refTrace.alphaMode;
      this.applyReferenceTrace(true);
    });

    document.getElementById('btn-ref-apply')?.addEventListener('click', () => {
      this.applyReferenceTrace(true);
    });

    const slAlpha = document.getElementById('sl-ref-alpha');
    slAlpha.addEventListener('input', () => {
      state.refAlpha = parseFloat(slAlpha.value);
      document.getElementById('val-ref-alpha').textContent = `${Math.round(state.refAlpha * 100)}%`;
      this.sketchCanvas.render();
    });

    document.getElementById('btn-ref-clear').addEventListener('click', () => {
      state.refImage = null;
      state.refClampedCanvas = null;
      state.refName = '';
      state.refSettingsOpen = false;
      upload.value = '';
      this.syncReferenceControls();
      this.sketchCanvas.render();
    });
  }

  initPaintWindow() {
    const svCanvas = document.getElementById('sv-picker');
    const hueCanvas = document.getElementById('hue-picker');

    const pickSV = (e) => {
      const rect = svCanvas.getBoundingClientRect();
      this.hsv.s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      this.hsv.v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
      state.paintColor = hsvToHex(this.hsv.h, this.hsv.s, this.hsv.v);
      this.drawColorPickers();
      this.syncColorWidgets();
    };

    let dragSV = false;
    svCanvas.addEventListener('pointerdown', (e) => {
      dragSV = true;
      svCanvas.setPointerCapture(e.pointerId);
      pickSV(e);
    });
    svCanvas.addEventListener('pointermove', (e) => { if (dragSV) pickSV(e); });
    svCanvas.addEventListener('pointerup', () => { dragSV = false; });

    const pickHue = (e) => {
      const rect = hueCanvas.getBoundingClientRect();
      this.hsv.h = Math.max(0, Math.min(0.999, (e.clientX - rect.left) / rect.width));
      state.paintColor = hsvToHex(this.hsv.h, this.hsv.s, this.hsv.v);
      this.drawColorPickers();
      this.syncColorWidgets();
    };

    let dragH = false;
    hueCanvas.addEventListener('pointerdown', (e) => {
      dragH = true;
      hueCanvas.setPointerCapture(e.pointerId);
      pickHue(e);
    });
    hueCanvas.addEventListener('pointermove', (e) => { if (dragH) pickHue(e); });
    hueCanvas.addEventListener('pointerup', () => { dragH = false; });

    const hexInput = document.getElementById('hex-input');
    hexInput.addEventListener('change', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(hexInput.value)) {
        state.paintColor = hexInput.value.toLowerCase();
        this.hsv = hexToHsv(state.paintColor);
        this.drawColorPickers();
        this.syncColorWidgets();
      }
    });

    const swWrap = document.getElementById('quick-swatches');
    swWrap.innerHTML = '';
    for (const c of QUICK_PALETTE) {
      const el = document.createElement('button');
      el.className = 'q-swatch';
      el.style.background = c;
      el.dataset.hex = c;
      el.addEventListener('click', () => {
        state.paintColor = c;
        this.hsv = hexToHsv(c);
        this.drawColorPickers();
        this.syncColorWidgets();
      });
      swWrap.appendChild(el);
    }

    document.querySelectorAll('.paint-tool').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.paintTool = btn.dataset.ptool;
        document.querySelectorAll('.paint-tool').forEach((b) => {
          b.classList.toggle('active', b.dataset.ptool === state.paintTool);
        });
      });
    });

    const slBrush = document.getElementById('sl-brush');
    slBrush.addEventListener('input', () => {
      state.brushSize = parseInt(slBrush.value, 10);
      document.getElementById('val-brush').textContent = String(state.brushSize);
    });

    const uvResSel = document.getElementById('uv-res-select');
    uvResSel.addEventListener('change', () => {
      this.uvPainter.setResolution(parseInt(uvResSel.value, 10));
    });

    const btnMirFB = document.getElementById('btn-uv-mirror');
    btnMirFB.addEventListener('click', () => {
      state.uvMirrorFB = !state.uvMirrorFB;
      btnMirFB.classList.toggle('active', state.uvMirrorFB);
    });

    const btnSymX = document.getElementById('btn-uv-symx');
    btnSymX.addEventListener('click', () => {
      state.uvSymX = !state.uvSymX;
      btnSymX.classList.toggle('active', state.uvSymX);
    });

    document.getElementById('btn-uv-reset').addEventListener('click', () => {
      this.uvPainter.pushUvUndo();
      this.uvPainter.autoFillFromMesh(state.mesh, true);
    });
    document.getElementById('btn-uv-fit')?.addEventListener('click', () => {
      this.uvPainter.resetView();
    });
    document.getElementById('btn-uv-alpha')?.addEventListener('click', () => {
      this.toggleAlphaMode();
    });

    this.drawColorPickers();
    this.syncColorWidgets();
  }

  drawColorPickers() {
    const svCanvas = document.getElementById('sv-picker');
    const ctx = svCanvas.getContext('2d');
    const w = svCanvas.width, h = svCanvas.height;

    const pure = hsvToHex(this.hsv.h, 1, 1);
    ctx.fillStyle = pure;
    ctx.fillRect(0, 0, w, h);

    const gWhite = ctx.createLinearGradient(0, 0, w, 0);
    gWhite.addColorStop(0, '#ffffff');
    gWhite.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gWhite;
    ctx.fillRect(0, 0, w, h);

    const gBlack = ctx.createLinearGradient(0, 0, 0, h);
    gBlack.addColorStop(0, 'rgba(0,0,0,0)');
    gBlack.addColorStop(1, '#000000');
    ctx.fillStyle = gBlack;
    ctx.fillRect(0, 0, w, h);

    const cx = this.hsv.s * w;
    const cy = (1 - this.hsv.v) * h;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - 3, cy - 3, 6, 6);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - 4, cy - 4, 8, 8);

    const hueCanvas = document.getElementById('hue-picker');
    const hctx = hueCanvas.getContext('2d');
    const hw = hueCanvas.width, hh = hueCanvas.height;
    const grad = hctx.createLinearGradient(0, 0, hw, 0);
    for (let i = 0; i <= 6; i++) {
      grad.addColorStop(i / 6, hsvToHex(i / 6, 1, 1));
    }
    hctx.fillStyle = grad;
    hctx.fillRect(0, 0, hw, hh);

    const hx = this.hsv.h * hw;
    hctx.fillStyle = '#ffffff';
    hctx.fillRect(hx - 2, 0, 4, hh);
    hctx.strokeStyle = '#000000';
    hctx.strokeRect(hx - 2, 0, 4, hh);
  }

  syncColorWidgets() {
    document.getElementById('color-swatch-active').style.background = state.paintColor;
    document.getElementById('hex-input').value = state.paintColor.toUpperCase();
  }

  initAnimateWindow() {
    const pDrag = document.getElementById('btn-pin-mode-drag');
    const pGrab = document.getElementById('btn-pin-mode-grab');
    const pAnc = document.getElementById('btn-pin-mode-anchor');
    const pDel = document.getElementById('btn-pin-mode-del');

    const setPinTool = (t) => {
      state.pinTool = t;
      pDrag.classList.toggle('active', t === 'drag');
      pGrab.classList.toggle('active', t === 'grab');
      pAnc.classList.toggle('active', t === 'anchor');
      pDel.classList.toggle('active', t === 'delete');
    };

    pDrag.addEventListener('click', () => setPinTool('drag'));
    pGrab.addEventListener('click', () => setPinTool('grab'));
    pAnc.addEventListener('click', () => setPinTool('anchor'));
    pDel.addEventListener('click', () => setPinTool('delete'));

    document.getElementById('btn-pin-clear').addEventListener('click', () => this.animator.clearPins());

    const btnPlay = document.getElementById('btn-anim-play');
    const btnRec = document.getElementById('btn-anim-rec');

    btnPlay.addEventListener('click', () => {
      state.playing = !state.playing;
      if (!state.playing) state.recording = false;
      this.syncAnimControls();
    });

    btnRec.addEventListener('click', () => {
      state.recording = !state.recording;
      if (state.recording) state.playing = true;
      this.syncAnimControls();
    });

    document.getElementById('btn-anim-key').addEventListener('click', () => {
      this.animator.addKeyframe(state.frame);
    });

    document.getElementById('btn-anim-delkey').addEventListener('click', () => {
      this.animator.deleteKeyframe(state.frame);
    });

    document.getElementById('btn-anim-reset-pose').addEventListener('click', () => {
      this.animator.resetToRestPose();
    });

    document.getElementById('sl-anim-grab-r')?.addEventListener('input', (e) => {
      state.grabRadius = parseFloat(e.target.value);
      this.syncPhysicsControls();
      this.animator.refreshPins();
    });

    const slFps = document.getElementById('sl-fps');
    slFps.addEventListener('input', () => {
      state.fps = parseInt(slFps.value, 10);
      document.getElementById('val-fps').textContent = String(state.fps);
    });

    const track = document.getElementById('timeline-track');
    let scrubbing = false;
    const scrub = (e) => {
      const rect = track.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      state.frame = Math.round(t * (state.totalFrames - 1));
      this.animator.evaluatePinsAtFrame(state.frame);
      this.updatePlayhead();
    };
    track.addEventListener('pointerdown', (e) => {
      scrubbing = true;
      track.setPointerCapture(e.pointerId);
      scrub(e);
    });
    track.addEventListener('pointermove', (e) => { if (scrubbing) scrub(e); });
    track.addEventListener('pointerup', () => { scrubbing = false; });
  }

  initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.performRedo(); else this.performUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.performRedo();
        return;
      }
      if (e.key === '1') this.setMode('sketch');
      else if (e.key === '2') this.setMode('inflate');
      else if (e.key === '3') this.setMode('paint');
      else if (e.key === '4') this.setMode('animate');
      else if (e.key.toLowerCase() === 'w') {
        this.toggleWireframe();
      } else if (e.key.toLowerCase() === 'r') {
        if (state.mode === 'paint') this.uvPainter.resetView();
        else if (state.mode === 'sketch') this.sketchCanvas.resetView();
      } else if (e.code === 'Space' && state.mode === 'animate') {
        e.preventDefault();
        state.playing = !state.playing;
        this.syncAnimControls();
      }
    });
  }

  syncAll() {
    this.renderLayerList();
    this.syncInflateControls();
    this.syncPhysicsControls();
    this.syncAnimControls();
    this.syncSettingsControls();
    this.syncReferenceControls();
    this.syncWireframeButtons();
    this.renderTimeline();
    this.updatePlayhead();
    document.getElementById('sl-grid').value = state.gridRes;
    document.getElementById('val-grid').textContent = String(state.gridRes);

    const btnMirror = document.getElementById('btn-mirror-x');
    if (btnMirror) btnMirror.classList.toggle('active', state.mirrorX);
    const btnLasso = document.getElementById('btn-lasso-mode');
    if (btnLasso) {
      btnLasso.classList.toggle('active', state.lassoMode);
      btnLasso.textContent = state.lassoMode ? 'LASSO' : 'POLY';
    }
    const slBrush = document.getElementById('sl-brush');
    const valBrush = document.getElementById('val-brush');
    if (slBrush) slBrush.value = state.brushSize;
    if (valBrush) valBrush.textContent = String(state.brushSize);
    const uvResSel = document.getElementById('uv-res-select');
    if (uvResSel) uvResSel.value = String(state.uvRes);
  }

  syncPhysicsControls() {
    const setPair = (slId, valId, val) => {
      const sl = document.getElementById(slId);
      const lbl = document.getElementById(valId);
      if (sl) sl.value = val;
      if (lbl) lbl.textContent = val.toFixed(2);
    };
    setPair('sl-inf-elastic', 'val-inf-elastic', state.rigidity);
    setPair('sl-inf-spring', 'val-inf-spring', state.springStiffness);
    setPair('sl-inf-damp', 'val-inf-damp', state.damping);
    setPair('sl-inf-bounce', 'val-inf-bounce', state.bounce);
    setPair('sl-inf-grav', 'val-inf-grav', state.gravity);
    setPair('sl-inf-wave', 'val-inf-wave', state.waveTransfer);
    setPair('sl-inf-squash', 'val-inf-squash', state.volumePreserve);
    setPair('sl-inf-hinge', 'val-inf-hinge', state.hingeFlex);
    setPair('sl-inf-grab-r', 'val-inf-grab-r', state.grabRadius);
    setPair('sl-anim-grab-r', 'val-anim-grab-r', state.grabRadius);
  }

  syncInflateControls() {
    const isLow = state.meshMode === 'lowpoly';
    document.getElementById('mesh-mode-lowpoly').classList.toggle('active', isLow);
    document.getElementById('mesh-mode-full').classList.toggle('active', !isLow);
    document.getElementById('lowpoly-detail-row').classList.toggle('hidden', !isLow);
    document.getElementById('sl-poly-detail').value = state.lowPolyDetail;
    document.getElementById('val-poly-detail').textContent = String(state.lowPolyDetail);

    document.getElementById('sl-depth').value = state.depth;
    document.getElementById('val-depth').textContent = state.depth.toFixed(2);
    document.getElementById('sl-round').value = state.roundness;
    document.getElementById('val-round').textContent = state.roundness.toFixed(2);

    const active = state.strokes.find((s) => s.id === state.activeStrokeId);
    const partTitle = document.getElementById('part-ctl-title');
    const btnPartBody = document.getElementById('btn-part-body');
    const btnPartFlap = document.getElementById('btn-part-flap');
    const slPDepth = document.getElementById('sl-part-depth');
    const slPPuff = document.getElementById('sl-part-puff');
    const attachRow = document.getElementById('part-attach-row');
    const slPAttach = document.getElementById('sl-part-attach');
    if (active) {
      partTitle.textContent = `PART: ${active.name}`;
      slPDepth.disabled = false;
      slPPuff.disabled = false;
      const pd = active.partDepth ?? 1.0;
      const pp = active.partPuff ?? 1.0;
      slPDepth.value = pd;
      document.getElementById('val-part-depth').textContent = pd.toFixed(2);
      slPPuff.value = pp;
      document.getElementById('val-part-puff').textContent = pp.toFixed(2);

      const isFlap = active.type === 'flap';
      if (btnPartBody) {
        btnPartBody.disabled = false;
        btnPartBody.classList.toggle('active', active.type === 'closed');
      }
      if (btnPartFlap) {
        btnPartFlap.disabled = false;
        btnPartFlap.classList.toggle('active', isFlap);
      }

      if (attachRow) attachRow.classList.toggle('hidden', !isFlap);
      if (isFlap && slPAttach) {
        const pa = active.flapAttach ?? 0;
        slPAttach.value = pa;
        const lbl = document.getElementById('val-part-attach');
        if (lbl) lbl.textContent = `${pa}%`;
      }
    } else {
      partTitle.textContent = 'PART: NONE';
      slPDepth.disabled = true;
      slPPuff.disabled = true;
      if (btnPartBody) {
        btnPartBody.disabled = true;
        btnPartBody.classList.remove('active');
      }
      if (btnPartFlap) {
        btnPartFlap.disabled = true;
        btnPartFlap.classList.remove('active');
      }
      if (attachRow) attachRow.classList.add('hidden');
    }

    document.querySelectorAll('.shade-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.shade === state.shadingMode);
    });
    this.syncWireframeButtons();
    document.getElementById('btn-inflate-orbit').classList.toggle('active', state.inflateTool === 'orbit');
    document.getElementById('btn-inflate-grab').classList.toggle('active', state.inflateTool === 'grab');
  }

  syncAnimControls() {
    const playBtn = document.getElementById('btn-anim-play');
    const recBtn = document.getElementById('btn-anim-rec');
    playBtn.classList.toggle('active', state.playing);
    playBtn.textContent = state.playing ? 'PAUSE' : 'PLAY';
    recBtn.classList.toggle('active', state.recording);
  }

  renderLayerList() {
    const list = document.getElementById('layer-list');
    list.innerHTML = '';
    if (state.strokes.length === 0) {
      const empty = document.createElement('div');
      empty.style.fontSize = '0.88em';
      empty.style.color = '#666';
      empty.textContent = 'DRAW ON GRID TO CREATE MESH';
      list.appendChild(empty);
      return;
    }

    for (let i = state.strokes.length - 1; i >= 0; i--) {
      const s = state.strokes[i];
      const row = document.createElement('div');
      row.className = `layer-item${s.id === state.activeStrokeId ? ' active' : ''}`;
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        state.activeStrokeId = s.id;
        this.renderLayerList();
        this.syncInflateControls();
        this.sketchCanvas.render();
      });

      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = s.name;

      const tag = document.createElement('span');
      tag.className = 'layer-tag';
      if (s.type === 'closed') {
        tag.textContent = 'BODY';
      } else {
        const prefix = s.type === 'extrude' ? 'E:' : 'F:';
        tag.textContent = prefix + (s.flapSide || 'sym').toUpperCase().slice(0, 1);
        tag.title = 'Click to cycle side (SYM / FRONT / BACK)';
        tag.style.cursor = 'pointer';
        tag.addEventListener('click', (e) => {
          e.stopPropagation();
          pushHistory();
          const order = ['sym', 'front', 'back'];
          s.flapSide = order[(order.indexOf(s.flapSide || 'sym') + 1) % order.length];
          this.renderLayerList();
          emit('mesh:dirty');
        });
      }

      const eye = document.createElement('button');
      eye.className = 'layer-act';
      eye.textContent = s.visible !== false ? 'O' : '-';
      eye.title = 'Toggle Visibility';
      eye.addEventListener('click', () => {
        pushHistory();
        s.visible = s.visible === false;
        this.renderLayerList();
        this.sketchCanvas.render();
        emit('mesh:dirty');
      });

      const del = document.createElement('button');
      del.className = 'layer-act';
      del.textContent = 'X';
      del.title = 'Delete Stroke';
      del.addEventListener('click', () => {
        pushHistory();
        state.strokes = state.strokes.filter((item) => item.id !== s.id);
        if (state.activeStrokeId === s.id) state.activeStrokeId = state.strokes[0]?.id || null;
        this.renderLayerList();
        this.syncInflateControls();
        this.sketchCanvas.render();
        emit('mesh:dirty');
      });

      row.append(name, tag, eye, del);
      list.appendChild(row);
    }
  }

  renderTimeline() {
    const keysEl = document.getElementById('timeline-keys');
    keysEl.innerHTML = '';
    const keyFrames = new Set();
    for (const p of state.pins) {
      if (p.tempGrab) continue;
      for (const f of Object.keys(p.keys)) keyFrames.add(Number(f));
    }
    for (const f of keyFrames) {
      const pct = (f / Math.max(1, state.totalFrames - 1)) * 100;
      const d = document.createElement('div');
      d.className = 'key-diamond';
      d.style.left = `${pct}%`;
      keysEl.appendChild(d);
    }
  }

  updatePlayhead() {
    const head = document.getElementById('timeline-head');
    const pct = (state.frame / Math.max(1, state.totalFrames - 1)) * 100;
    head.style.left = `${pct}%`;
    document.getElementById('frame-readout').textContent =
      `F ${String(state.frame).padStart(2, '0')}/${state.totalFrames}`;
  }

  exportObj() {
    if (!state.mesh) return;
    const { renPos, renUv, renIndices } = state.mesh;
    const lines = ['# MashGrid Studio OBJ Export'];
    for (let i = 0; i < renPos.length; i += 3) {
      lines.push(`v ${renPos[i].toFixed(4)} ${renPos[i + 1].toFixed(4)} ${renPos[i + 2].toFixed(4)}`);
    }
    for (let i = 0; i < renUv.length; i += 2) {
      lines.push(`vt ${renUv[i].toFixed(4)} ${renUv[i + 1].toFixed(4)}`);
    }
    for (let i = 0; i < renIndices.length; i += 3) {
      const a = renIndices[i] + 1;
      const b = renIndices[i + 1] + 1;
      const c = renIndices[i + 2] + 1;
      lines.push(`f ${a}/${a} ${b}/${b} ${c}/${c}`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mashgrid_character.obj';
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
