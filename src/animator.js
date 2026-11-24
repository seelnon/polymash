// Real-Time Pin Animator, Direct 3D Mesh Grabber, ARAP + Verlet Soft-Body Loop

import { state, emit, pushHistory } from './state.js';
import { wasmBridge } from './wasm-bridge.js';

export class PinAnimator {
  constructor(glRenderer, overlayEl) {
    this.glRenderer = glRenderer;
    this.overlayEl = overlayEl;
    this.draggingPinId = null;
    this.grabSession = null;
    this.pinElements = new Map();
    this.lastTime = performance.now();
    this.frameAccum = 0;

    this.bindEvents();
  }

  bindEvents() {
    this.overlayEl.addEventListener('pointerdown', (e) => {
      if (state.mode !== 'animate') return;
      const target = e.target.closest('.pin-marker');
      if (!target) return;
      e.stopPropagation();
      const pinId = target.dataset.pinId;
      const pin = state.pins.find((p) => p.id === pinId);
      if (!pin) return;

      if (state.pinTool === 'delete' || e.button === 2) {
        this.removePin(pinId);
        return;
      }
      if (state.pinTool === 'anchor') {
        pushHistory();
        pin.anchor = !pin.anchor;
        this.syncOverlay();
        return;
      }

      state.selectedPinId = pinId;
      this.draggingPinId = pinId;
      target.setPointerCapture(e.pointerId);
      this.syncOverlay();
    });

    this.overlayEl.addEventListener('contextmenu', (e) => {
      if (state.mode !== 'animate') return;
      const target = e.target.closest('.pin-marker');
      if (target) {
        e.preventDefault();
        this.removePin(target.dataset.pinId);
      }
    });

    window.addEventListener('pointermove', (e) => {
      if (this.grabSession) {
        const gs = this.grabSession;
        const hitPt = this.glRenderer.intersectViewPlane(e.clientX, e.clientY, gs.curPos);
        if (!hitPt) return;
        const dx = hitPt[0] - gs.startPos[0];
        const dy = hitPt[1] - gs.startPos[1];
        const dz = hitPt[2] - gs.startPos[2];
        gs.curPos = hitPt;
        for (const h of gs.handles) {
          h.pos[0] = h.base[0] + dx * h.w;
          h.pos[1] = h.base[1] + dy * h.w;
          h.pos[2] = h.base[2] + dz * h.w;
        }
        wasmBridge.setPins(gs.activePins);
        return;
      }

      if (!this.draggingPinId || state.mode !== 'animate') return;
      const pin = state.pins.find((p) => p.id === this.draggingPinId);
      if (!pin) return;
      const hitPt = this.glRenderer.intersectViewPlane(e.clientX, e.clientY, pin.pos);
      if (!hitPt) return;
      pin.pos = hitPt;
      if (state.recording) {
        pin.keys[state.frame] = [...hitPt];
      }
      this.refreshPins();
    });

    window.addEventListener('pointerup', () => {
      if (this.grabSession) {
        this.endGrab();
      }
      if (this.draggingPinId) {
        if (state.recording) emit('timeline:dirty');
        this.draggingPinId = null;
        this.refreshPins();
      }
    });
  }

  // Expand movable pins across state.grabRadius with smooth cosine falloff so neither pins nor 3D grab pinch only a tiny point
  buildEffectivePins(basePins = state.pins) {
    if (!state.mesh || !basePins || basePins.length === 0) return basePins || [];
    const radius = state.grabRadius ?? 0.18;
    if (radius <= 0.005) return basePins;

    const { simVertCount, simRestPos, simRegionId, regionMeta } = state.mesh;
    const activePins = [];
    const realPinIdx = new Set();

    for (const p of basePins) {
      activePins.push(p);
      realPinIdx.add(p.simIdx);
    }

    // Determine active displaced/dragged movable pins to emit area handles around
    const movablePins = [];
    for (const p of basePins) {
      if (p.anchor || p.tempGrab) continue;
      const dx = p.pos[0] - p.rest[0];
      const dy = p.pos[1] - p.rest[1];
      const dz = p.pos[2] - p.rest[2];
      const moved = (dx * dx + dy * dy + dz * dz) > 1e-6;
      if (moved || p.id === this.draggingPinId || state.playing) {
        const regIdx = simRegionId ? simRegionId[p.simIdx] : -1;
        const regStroke = regIdx >= 0 && regionMeta?.[regIdx]
          ? state.strokes.find((s) => s.id === regionMeta[regIdx].strokeId)
          : null;
        const isFlapLike = regStroke ? regStroke.type !== 'closed' : false;
        movablePins.push({ p, dx, dy, dz, regIdx, isFlapLike });
      }
    }

    if (movablePins.length === 0) return activePins;

    const rSq = radius * radius;
    for (let i = 0; i < simVertCount; i++) {
      if (realPinIdx.has(i)) continue;
      const rx = simRestPos[i * 3];
      const ry = simRestPos[i * 3 + 1];
      const rz = simRestPos[i * 3 + 2];

      let best = null;
      let bestDistSq = rSq;
      for (const mp of movablePins) {
        if (mp.isFlapLike && simRegionId && simRegionId[i] !== mp.regIdx) continue;
        const ddx = rx - mp.p.rest[0];
        const ddy = ry - mp.p.rest[1];
        const ddz = rz - mp.p.rest[2];
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 <= bestDistSq) {
          bestDistSq = d2;
          best = mp;
        }
      }

      if (best) {
        const dist = Math.sqrt(bestDistSq);
        const t = dist / radius;
        const w = 0.22 + 0.78 * Math.pow(Math.cos(t * Math.PI * 0.5), 1.35);
        activePins.push({
          simIdx: i,
          pos: [rx + best.dx * w, ry + best.dy * w, rz + best.dz * w],
          tempGrab: true,
        });
      }
    }

    return activePins;
  }

  refreshPins() {
    if (this.grabSession) return;
    if (state.mode === 'animate') {
      wasmBridge.setPins(this.buildEffectivePins(state.pins));
    } else {
      wasmBridge.setPins([]);
    }
  }

  startGrab(clientX, clientY) {
    if (!state.mesh) return false;
    const hit = this.glRenderer.pickMesh(clientX, clientY);
    if (!hit) return false;

    const simView = wasmBridge.getSimPositionsView();
    const getPos = (idx) => simView
      ? [simView[idx * 3], simView[idx * 3 + 1], simView[idx * 3 + 2]]
      : [state.mesh.simRestPos[idx * 3], state.mesh.simRestPos[idx * 3 + 1], state.mesh.simRestPos[idx * 3 + 2]];

    const startPos = getPos(hit.simIdx);
    const activePins = [];

    // In Inflate/Sketch "big mode", only respect true anchor pins (ignore keyframe animation pins
    // so ears/limbs can be freely grabbed and bounced as a whole soft body!)
    const basePins = (state.mode === 'animate')
      ? state.pins
      : state.pins.filter((p) => p.anchor);

    for (const p of basePins) {
      activePins.push(p);
    }

    if (activePins.length === 0) {
      const gx = state.mesh.simRestPos[hit.simIdx * 3];
      const gy = state.mesh.simRestPos[hit.simIdx * 3 + 1];
      const gz = state.mesh.simRestPos[hit.simIdx * 3 + 2];
      let farIdx = 0, maxD = -1;
      for (let i = 0; i < state.mesh.simVertCount; i++) {
        const dx = state.mesh.simRestPos[i * 3] - gx;
        const dy = state.mesh.simRestPos[i * 3 + 1] - gy;
        const dz = state.mesh.simRestPos[i * 3 + 2] - gz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d > maxD) { maxD = d; farIdx = i; }
      }
      const ancRest = [
        state.mesh.simRestPos[farIdx * 3],
        state.mesh.simRestPos[farIdx * 3 + 1],
        state.mesh.simRestPos[farIdx * 3 + 2],
      ];
      activePins.push({
        id: `grab_anc_${Date.now()}`,
        simIdx: farIdx,
        rest: ancRest,
        pos: [...ancRest],
        anchor: true,
        tempGrab: true,
        keys: {},
      });
    }

    // Grab a smooth area handle controlled by state.grabRadius (restricted to flap region when grabbing flaps)
    const handleRadius = state.grabRadius ?? 0.18;
    const hitRegion = state.mesh.simRegionId ? state.mesh.simRegionId[hit.simIdx] : -1;
    const hitRegMeta = hitRegion >= 0 ? state.mesh.regionMeta?.[hitRegion] : null;
    const hitStroke = hitRegMeta ? state.strokes.find((s) => s.id === hitRegMeta.strokeId) : null;
    const isolateRegion = !hitStroke || hitStroke.type !== 'closed';
    const handles = [];
    const anchorSet = new Set(activePins.map((p) => p.simIdx));

    for (let i = 0; i < state.mesh.simVertCount; i++) {
      if (anchorSet.has(i)) continue;
      if (isolateRegion && hitRegion >= 0 && state.mesh.simRegionId[i] !== hitRegion) continue;
      const p = getPos(i);
      const dist = Math.hypot(p[0] - startPos[0], p[1] - startPos[1], p[2] - startPos[2]);
      if (i === hit.simIdx || (handleRadius > 0.005 && dist <= handleRadius)) {
        const t = handleRadius > 0.005 ? Math.min(1, dist / handleRadius) : 0;
        const w = i === hit.simIdx ? 1.0 : (0.28 + 0.72 * Math.cos(t * Math.PI * 0.5));
        const hPin = {
          id: `grab_h_${i}`,
          simIdx: i,
          base: p,
          pos: [...p],
          w,
          tempGrab: true,
        };
        handles.push(hPin);
        activePins.push(hPin);
      }
    }

    this.grabSession = { startPos, curPos: [...startPos], handles, activePins };
    wasmBridge.setPins(activePins);
    this.syncOverlay();
    return true;
  }

  endGrab() {
    if (!this.grabSession) return;
    this.grabSession = null;
    this.refreshPins();
    this.syncOverlay();
  }

  handleCanvasClick(clientX, clientY) {
    if (state.mode !== 'animate' || !state.mesh) return false;
    if (state.pinTool === 'grab') {
      return this.startGrab(clientX, clientY);
    }

    const hit = this.glRenderer.pickMesh(clientX, clientY);
    if (!hit) return false;

    if (state.pinTool === 'drag') {
      pushHistory();
      const id = `pin_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
      const rest = [
        state.mesh.simRestPos[hit.simIdx * 3],
        state.mesh.simRestPos[hit.simIdx * 3 + 1],
        state.mesh.simRestPos[hit.simIdx * 3 + 2],
      ];
      const simView = wasmBridge.getSimPositionsView();
      const curPos = simView
        ? [simView[hit.simIdx * 3], simView[hit.simIdx * 3 + 1], simView[hit.simIdx * 3 + 2]]
        : [...rest];

      const newPin = {
        id,
        simIdx: hit.simIdx,
        rest,
        pos: curPos,
        anchor: false,
        keys: { 0: [...curPos] },
      };
      state.pins.push(newPin);
      state.selectedPinId = id;
      this.draggingPinId = id;
      this.refreshPins();
      this.syncOverlay();
      emit('timeline:dirty');
      return true;
    }
    return false;
  }

  removePin(pinId) {
    pushHistory();
    state.pins = state.pins.filter((p) => p.id !== pinId);
    if (state.selectedPinId === pinId) state.selectedPinId = null;
    this.refreshPins();
    this.syncOverlay();
    emit('timeline:dirty');
  }

  clearPins() {
    pushHistory();
    state.pins = [];
    state.selectedPinId = null;
    state.playing = false;
    state.recording = false;
    wasmBridge.setPins([]);
    wasmBridge.resetPose();
    const view = wasmBridge.getSimPositionsView();
    if (view) this.glRenderer.updateDeformedPositions(view);
    this.syncOverlay();
    emit('timeline:dirty');
    emit('ui:sync');
  }

  resetToRestPose() {
    state.playing = false;
    state.recording = false;
    for (const p of state.pins) {
      p.pos = [...p.rest];
    }
    this.refreshPins();
    wasmBridge.resetPose();
    const view = wasmBridge.getSimPositionsView();
    if (view) this.glRenderer.updateDeformedPositions(view);
    this.syncOverlay();
    emit('ui:sync');
  }

  rebindPinsToMesh(mesh) {
    if (!mesh) {
      state.pins = [];
      this.syncOverlay();
      return;
    }
    const { simVertCount, simRestPos } = mesh;
    for (const p of state.pins) {
      const oldRest = [...p.rest];
      let bestIdx = 0;
      let bestD = Infinity;
      for (let i = 0; i < simVertCount; i++) {
        const dx = simRestPos[i * 3] - oldRest[0];
        const dy = simRestPos[i * 3 + 1] - oldRest[1];
        const dz = simRestPos[i * 3 + 2] - oldRest[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) {
          bestD = d;
          bestIdx = i;
        }
      }
      const newRest = [simRestPos[bestIdx * 3], simRestPos[bestIdx * 3 + 1], simRestPos[bestIdx * 3 + 2]];
      const dx = newRest[0] - oldRest[0];
      const dy = newRest[1] - oldRest[1];
      const dz = newRest[2] - oldRest[2];

      p.simIdx = bestIdx;
      p.rest = newRest;

      if (p.keys) {
        for (const k of Object.keys(p.keys)) {
          p.keys[k] = [p.keys[k][0] + dx, p.keys[k][1] + dy, p.keys[k][2] + dz];
        }
      }
      if (!state.playing && !this.draggingPinId) {
        p.pos = [...newRest];
      }
    }
    this.refreshPins();
    this.syncOverlay();
  }

  addKeyframe(frame = state.frame) {
    for (const p of state.pins) {
      p.keys[frame] = [...p.pos];
    }
    emit('timeline:dirty');
  }

  deleteKeyframe(frame = state.frame) {
    for (const p of state.pins) {
      delete p.keys[frame];
    }
    emit('timeline:dirty');
  }

  evaluatePinsAtFrame(frame) {
    const T = state.totalFrames;
    for (const p of state.pins) {
      if (p.anchor) continue;
      if (this.draggingPinId === p.id && state.recording) continue;
      const frames = Object.keys(p.keys).map(Number).sort((a, b) => a - b);
      if (frames.length === 0) continue;
      if (frames.length === 1) {
        p.pos = [...p.keys[frames[0]]];
        continue;
      }

      let f0 = frames[frames.length - 1];
      let f1 = frames[0];
      let span = (f1 + T) - f0;
      let dist = frame >= f0 ? frame - f0 : (frame + T) - f0;

      for (let i = 0; i < frames.length - 1; i++) {
        if (frame >= frames[i] && frame <= frames[i + 1]) {
          f0 = frames[i];
          f1 = frames[i + 1];
          span = f1 - f0;
          dist = frame - f0;
          break;
        }
      }

      const rawT = span > 0 ? dist / span : 0;
      const t = 0.5 - 0.5 * Math.cos(rawT * Math.PI);
      const a = p.keys[f0];
      const b = p.keys[f1];
      p.pos = [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      ];
    }
    this.refreshPins();
  }

  hasDisplacedPins() {
    for (const p of state.pins) {
      const dx = p.pos[0] - p.rest[0];
      const dy = p.pos[1] - p.rest[1];
      const dz = p.pos[2] - p.rest[2];
      if (dx * dx + dy * dy + dz * dz > 1e-6) return true;
    }
    return false;
  }

  step(now) {
    const dtMs = Math.min(50, now - this.lastTime);
    this.lastTime = now;

    if (state.playing) {
      this.frameAccum += dtMs;
      const stepMs = 1000 / state.fps;
      if (this.frameAccum >= stepMs) {
        const advance = Math.floor(this.frameAccum / stepMs);
        this.frameAccum -= advance * stepMs;
        state.frame = (state.frame + advance) % state.totalFrames;
        if (state.recording && this.draggingPinId) {
          const pin = state.pins.find((p) => p.id === this.draggingPinId);
          if (pin) pin.keys[state.frame] = [...pin.pos];
          emit('timeline:dirty');
        } else {
          this.evaluatePinsAtFrame(state.frame);
        }
        emit('timeline:frame');
      }
    }

    const needsSim = state.mesh && (
      state.playing ||
      this.draggingPinId ||
      this.grabSession ||
      Math.abs(state.gravity) > 0.005 ||
      (state.mode === 'animate' && this.hasDisplacedPins()) ||
      wasmBridge.hasDeformation()
    );

    const physExtra = {
      gravity: state.gravity,
      waveTransfer: state.waveTransfer,
      volumePreserve: state.volumePreserve,
    };

    if (needsSim) {
      if (this.grabSession) {
        wasmBridge.setPins(this.grabSession.activePins);
        const simView = wasmBridge.stepSimulation(
          state.rigidity,
          state.bounce,
          state.springStiffness,
          state.damping,
          14,
          true,
          physExtra
        );
        if (simView) this.glRenderer.updateDeformedPositions(simView);
      } else if (state.mode !== 'animate' && !state.playing) {
        // In Inflate/Sketch "big mode", release triggers pure elastic wave return around true anchors
        const anchorPins = state.pins.filter((p) => p.anchor);
        const simView = wasmBridge.stepSpringReturn(
          state.rigidity,
          state.bounce,
          state.springStiffness,
          state.damping,
          anchorPins,
          physExtra
        );
        if (simView) this.glRenderer.updateDeformedPositions(simView);
      } else if (state.pins.length > 0) {
        const simView = wasmBridge.stepSimulation(
          state.rigidity,
          state.bounce,
          state.springStiffness,
          state.damping,
          14,
          false,
          physExtra
        );
        if (simView) this.glRenderer.updateDeformedPositions(simView);
      } else {
        const anchorPins = state.pins.filter((p) => p.anchor);
        const simView = wasmBridge.stepSpringReturn(
          state.rigidity,
          state.bounce,
          state.springStiffness,
          state.damping,
          anchorPins,
          physExtra
        );
        if (simView) this.glRenderer.updateDeformedPositions(simView);
      }
    }

    this.syncOverlay();
  }

  syncOverlay() {
    if (state.mode !== 'animate' || !state.mesh) {
      this.overlayEl.innerHTML = '';
      this.pinElements.clear();
      return;
    }

    const activeIds = new Set(state.pins.filter((p) => !p.tempGrab).map((p) => p.id));
    for (const [id, el] of this.pinElements.entries()) {
      if (!activeIds.has(id)) {
        el.remove();
        this.pinElements.delete(id);
      }
    }

    for (const p of state.pins) {
      if (p.tempGrab) continue;
      let el = this.pinElements.get(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'pin-marker';
        el.dataset.pinId = p.id;
        this.overlayEl.appendChild(el);
        this.pinElements.set(p.id, el);
      }

      const scr = this.glRenderer.projectToScreen(p.pos);
      if (!scr) {
        el.style.display = 'none';
      } else {
        el.style.display = 'block';
        el.style.left = `${scr.x}px`;
        el.style.top = `${scr.y}px`;
      }

      el.classList.toggle('anchor', !!p.anchor);
      el.classList.toggle('selected', state.selectedPinId === p.id);
    }
  }
}
