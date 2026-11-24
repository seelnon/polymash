// MashGrid Studio Entry Point — Pure JS + WebGL2 + WASM Orchestration

import { state, on, emit, pushHistory } from './state.js';
import { wasmBridge } from './wasm-bridge.js';
import { buildMeshFromStrokes } from './mesher.js';
import { GlRenderer } from './gl-renderer.js';
import { SketchCanvas } from './sketch-canvas.js';
import { UvPainter } from './uv-painter.js';
import { PinAnimator } from './animator.js';
import { UIController } from './ui.js';
import { PRESETS } from './presets.js';

async function bootstrap() {
  document.documentElement.style.setProperty('--ui-scale', String(state.uiScale));
  await wasmBridge.init();

  const glCanvas = document.getElementById('gl-canvas');
  const sketchEl = document.getElementById('sketch-canvas');
  const uvEl = document.getElementById('uv-canvas');
  const pinOverlay = document.getElementById('gl-overlay-pins');

  const glRenderer = new GlRenderer(glCanvas);
  const sketchCanvas = new SketchCanvas(sketchEl);
  const uvPainter = new UvPainter(uvEl, glRenderer);
  const animator = new PinAnimator(glRenderer, pinOverlay);

  function rebuildMesh(forceRepaint = false) {
    const mesh = buildMeshFromStrokes(state.strokes, {
      gridRes: state.gridRes,
      meshMode: state.meshMode,
      lowPolyDetail: state.lowPolyDetail,
      depth: state.depth,
      roundness: state.roundness,
      hingeFlex: state.hingeFlex,
    });
    state.mesh = mesh;
    glRenderer.uploadMesh(mesh);
    uvPainter.autoFillFromMesh(mesh, forceRepaint);
    animator.rebindPinsToMesh(mesh);
    sketchCanvas.render();

    const statsEl = document.getElementById('mesh-stats');
    if (mesh) {
      statsEl.textContent = `${mesh.simVertCount}V / ${mesh.renIndices.length / 3}T`;
    } else {
      statsEl.textContent = '0V / 0T';
    }
  }

  function newProject() {
    pushHistory();
    state.strokes = [];
    state.activeStrokeId = null;
    state.pins = [];
    state.selectedPinId = null;
    state.playing = false;
    state.recording = false;
    state.frame = 0;
    state.mesh = null;
    state.alphaCutout = false;
    state.refImage = null;
    state.refClampedCanvas = null;
    state.refName = '';
    state.refSettingsOpen = false;
    sketchCanvas.draftPoints = [];
    uvPainter.clearToBase('#d97724');
    glRenderer.uploadMesh(null);
    animator.syncOverlay();
    sketchCanvas.render();
    uvPainter.render2D();
    document.getElementById('mesh-stats').textContent = '0V / 0T';
    emit('ui:sync');
  }

  function loadPreset(key) {
    const p = PRESETS[key];
    if (!p) return;
    state.gridRes = p.gridRes;
    state.meshMode = p.meshMode;
    state.lowPolyDetail = p.lowPolyDetail ?? 6;
    state.depth = p.depth;
    state.roundness = p.roundness;
    state.shadingMode = p.shadingMode;
    state.alphaCutout = false;
    state.strokes = JSON.parse(JSON.stringify(p.strokes));
    state.activeStrokeId = p.defaultActiveId || state.strokes[0]?.id || null;
    state.pins = JSON.parse(JSON.stringify(p.pins || []));
    state.playing = false;
    state.recording = false;
    state.frame = 0;

    uvPainter.hasCustomPaint = false;
    uvPainter.uvUndoStack.length = 0;
    uvPainter.uvRedoStack.length = 0;
    rebuildMesh(true);
    if (p.paintFn) {
      p.paintFn(uvPainter);
      uvPainter.hasCustomPaint = true;
      uvPainter.syncTexture();
    }
    emit('ui:sync');
  }

  on('mesh:dirty', () => rebuildMesh(false));

  // 3D Viewport Camera & Direct 3D Paint / Alt+Pick / Grab / Pin Placement
  let camAction = null; // 'orbit' | 'pan' | 'paint3d' | 'pick3d'
  let lastX = 0, lastY = 0;

  glCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

  glCanvas.addEventListener('pointerdown', (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    glCanvas.setPointerCapture(e.pointerId);

    // Alt + Left-Click in Paint mode acts as 3D Eyedropper color picker
    if (e.button === 0 && e.altKey && state.mode === 'paint') {
      const hit = glRenderer.pickMesh(e.clientX, e.clientY);
      if (hit) {
        camAction = 'pick3d';
        uvPainter.paintAtUv(hit.uv[0], hit.uv[1], true);
      }
      return;
    }

    if (e.button === 2 || e.button === 1 || e.altKey) {
      camAction = e.shiftKey ? 'pan' : 'orbit';
      return;
    }

    if (e.button === 0 && e.shiftKey) {
      camAction = 'pan';
      return;
    }

    if (e.button === 0 && state.mode === 'paint') {
      const hit = glRenderer.pickMesh(e.clientX, e.clientY);
      if (hit) {
        if (state.paintTool !== 'pick') uvPainter.pushUvUndo();
        camAction = 'paint3d';
        uvPainter.paintAtUv(hit.uv[0], hit.uv[1], false);
        return;
      }
    }

    if (e.button === 0 && state.mode === 'sketch') {
      const hit = glRenderer.pickMesh(e.clientX, e.clientY);
      if (hit && hit.strokeId) {
        state.activeStrokeId = hit.strokeId;
        emit('ui:sync');
        sketchCanvas.render();
        camAction = null;
        return;
      }
      camAction = 'orbit';
      return;
    }

    if (e.button === 0 && state.mode === 'inflate' && state.inflateTool === 'grab') {
      if (animator.startGrab(e.clientX, e.clientY)) {
        camAction = null;
        return;
      }
    }

    if (e.button === 0 && state.mode === 'animate') {
      if (animator.handleCanvasClick(e.clientX, e.clientY)) {
        camAction = null;
        return;
      }
    }

    if (e.button === 0) {
      camAction = 'orbit';
    }
  });

  glCanvas.addEventListener('pointermove', (e) => {
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (camAction === 'pick3d') {
      const hit = glRenderer.pickMesh(e.clientX, e.clientY);
      if (hit) uvPainter.paintAtUv(hit.uv[0], hit.uv[1], true);
      return;
    }

    if (camAction === 'paint3d') {
      const hit = glRenderer.pickMesh(e.clientX, e.clientY);
      if (hit) uvPainter.paintAtUv(hit.uv[0], hit.uv[1], e.altKey);
      return;
    }

    if (camAction === 'orbit') {
      state.camYaw -= dx * 0.008;
      state.camPitch = Math.max(-1.4, Math.min(1.4, state.camPitch + dy * 0.008));
    } else if (camAction === 'pan') {
      const cy = Math.cos(state.camYaw);
      const sy = Math.sin(state.camYaw);
      const scale = state.camDist * 0.0018;
      state.camTarget[0] -= dx * cy * scale;
      state.camTarget[2] += dx * sy * scale;
      state.camTarget[1] += dy * scale;
    }
  });

  glCanvas.addEventListener('pointerup', () => {
    camAction = null;
  });

  glCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.camDist = Math.max(1.1, Math.min(8.0, state.camDist + e.deltaY * 0.002));
  }, { passive: false });

  window.addEventListener('resize', () => {
    sketchCanvas.render();
    uvPainter.render2D();
  });

  const ui = new UIController({ sketchCanvas, uvPainter, animator, loadPreset, newProject });
  loadPreset('bear');
  ui.setMode('sketch');

  function frame(now) {
    animator.step(now);
    glRenderer.render(state);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

bootstrap();
