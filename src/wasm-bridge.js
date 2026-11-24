// WASM Linear-Memory Bridge for Poisson Inflation, ARAP Pin Solver & Verlet Soft-Body

const PAGE_BYTES = 65536;

export class WasmSolverBridge {
  constructor() {
    this.ready = false;
    this.memory = new WebAssembly.Memory({ initial: 64, maximum: 512 });
    this.exports = null;
    this.arena = null;
  }

  async init() {
    try {
      const resp = await fetch('/wasm/mesh_solver.wasm');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const bytes = await resp.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, {
        env: { memory: this.memory },
      });
      this.exports = instance.exports;
      this.ready = true;
    } catch (err) {
      console.error('WASM solver init failed:', err);
      this.ready = false;
    }
  }

  ensureCapacity(bytesNeeded) {
    const curBytes = this.memory.buffer.byteLength;
    if (bytesNeeded > curBytes) {
      const extraPages = Math.ceil((bytesNeeded - curBytes) / PAGE_BYTES);
      this.memory.grow(extraPages);
    }
  }

  align16(n) {
    return (n + 15) & ~15;
  }

  solvePoisson(vertCount, adjOff, adjIdx, adjW, flags, initialZ, sourceC, omega = 1.35, iters = 70) {
    if (!this.ready || vertCount === 0) {
      return new Float32Array(initialZ);
    }

    const adjLen = adjIdx.length;
    let ptr = 0;
    const pAdjOff = ptr; ptr += this.align16((vertCount + 1) * 4);
    const pAdjIdx = ptr; ptr += this.align16(adjLen * 4);
    const pAdjW   = ptr; ptr += this.align16(adjLen * 4);
    const pZ      = ptr; ptr += this.align16(vertCount * 4);
    const pFlags  = ptr; ptr += this.align16(vertCount * 4);
    this.ensureCapacity(ptr);

    const i32 = new Int32Array(this.memory.buffer);
    const f32 = new Float32Array(this.memory.buffer);

    i32.set(adjOff, pAdjOff >> 2);
    i32.set(adjIdx, pAdjIdx >> 2);
    f32.set(adjW, pAdjW >> 2);
    f32.set(initialZ, pZ >> 2);
    i32.set(flags, pFlags >> 2);

    this.exports.poisson_relax(
      vertCount,
      pAdjOff,
      pAdjIdx,
      pAdjW,
      pZ,
      pFlags,
      sourceC,
      omega,
      iters
    );

    return new Float32Array(this.memory.buffer, pZ, vertCount).slice();
  }

  uploadSimMesh(vertCount, adjOff, adjIdx, adjW, restPos) {
    const adjLen = adjIdx.length;
    let ptr = 0;
    const pAdjOff    = ptr; ptr += this.align16((vertCount + 1) * 4);
    const pAdjIdx    = ptr; ptr += this.align16(adjLen * 4);
    const pAdjW      = ptr; ptr += this.align16(adjLen * 4);
    const pRest      = ptr; ptr += this.align16(vertCount * 12);
    const pArapPos   = ptr; ptr += this.align16(vertCount * 12);
    const pSimPos    = ptr; ptr += this.align16(vertCount * 12);
    const pPrevPos   = ptr; ptr += this.align16(vertCount * 12);
    const pPinFlag   = ptr; ptr += this.align16(vertCount * 4);
    const pPinTarget = ptr; ptr += this.align16(vertCount * 12);
    const pRot       = ptr; ptr += this.align16(vertCount * 16);

    this.ensureCapacity(ptr);

    const i32 = new Int32Array(this.memory.buffer);
    const f32 = new Float32Array(this.memory.buffer);

    i32.set(adjOff, pAdjOff >> 2);
    i32.set(adjIdx, pAdjIdx >> 2);
    f32.set(adjW, pAdjW >> 2);
    f32.set(restPos, pRest >> 2);
    f32.set(restPos, pArapPos >> 2);
    f32.set(restPos, pSimPos >> 2);
    f32.set(restPos, pPrevPos >> 2);
    i32.fill(0, pPinFlag >> 2, (pPinFlag >> 2) + vertCount);
    f32.set(restPos, pPinTarget >> 2);
    const rotBase = pRot >> 2;
    for (let i = 0; i < vertCount; i++) {
      f32[rotBase + i * 4] = 0;
      f32[rotBase + i * 4 + 1] = 0;
      f32[rotBase + i * 4 + 2] = 0;
      f32[rotBase + i * 4 + 3] = 1;
    }

    this.arena = {
      vertCount,
      pAdjOff,
      pAdjIdx,
      pAdjW,
      pRest,
      pArapPos,
      pSimPos,
      pPrevPos,
      pPinFlag,
      pPinTarget,
      pRot,
    };
  }

  setPins(pins) {
    if (!this.arena) return;
    const { vertCount, pPinFlag, pPinTarget } = this.arena;
    const i32 = new Int32Array(this.memory.buffer);
    const f32 = new Float32Array(this.memory.buffer);

    i32.fill(0, pPinFlag >> 2, (pPinFlag >> 2) + vertCount);
    const targetBase = pPinTarget >> 2;
    const flagBase = pPinFlag >> 2;

    for (let k = 0; k < pins.length; k++) {
      const pin = pins[k];
      const idx = pin.simIdx;
      if (idx < 0 || idx >= vertCount) continue;
      i32[flagBase + idx] = 1;
      f32[targetBase + idx * 3] = pin.pos[0];
      f32[targetBase + idx * 3 + 1] = pin.pos[1];
      f32[targetBase + idx * 3 + 2] = pin.pos[2];
    }
  }

  _computePhysicsParams(rigidity, bounce, springStiffness, damping, isGrabbing = false, waveTransfer = 0.65) {
    // SPRNG (0.08..0.85) -> natural 60fps pose-return stiffness [0.006 .. 0.22]
    const rawStiff = 0.006 + Math.pow(springStiffness, 1.55) * 0.22;
    const effStiff = isGrabbing
      ? Math.max(rawStiff, 0.24)
      : Math.max(0.006, Math.min(0.22, rawStiff));
    const omega = Math.sqrt(effStiff);

    // Frequency-normalized damping so slow & fast springs obey BOUNC & DAMP consistently
    let effDamp;
    if (bounce <= 0.01) {
      effDamp = Math.max(0.18, Math.min(0.65, 1.0 - 2.0 * omega));
    } else {
      const lossRate = (1.0 - bounce) * 0.34 + damping * 0.36 + 0.012;
      effDamp = Math.max(0.30, Math.min(0.996, Math.exp(-lossRate * omega)));
    }

    // ELAST + WAVE -> edge-wave displacement & kinetic energy propagation
    const waveMul = 0.25 + waveTransfer * 1.15;
    const effCouple = Math.max(0.02, Math.min(0.45, (0.06 + (rigidity - 0.25) * 0.40) * waveMul));
    return { effStiff, effDamp, effCouple };
  }

  _applyExternalForces(gravity = 0.0, volumePreserve = 0.45) {
    if (!this.arena) return;
    const a = this.arena;
    const f32 = new Float32Array(this.memory.buffer);
    const i32 = new Int32Array(this.memory.buffer);
    const sBase = a.pSimPos >> 2;
    const rBase = a.pRest >> 2;
    const fBase = a.pPinFlag >> 2;
    const n = a.vertCount;

    if (Math.abs(gravity) > 1e-4) {
      const gForce = -gravity * 0.0045;
      for (let i = 0; i < n; i++) {
        if (i32[fBase + i] !== 0) continue;
        f32[sBase + i * 3 + 1] += gForce;
      }
    }

    if (volumePreserve > 0.01) {
      // Gentle squash-and-stretch bulge: stretching along Y thins X/Z subtly, compressing Y bulges X/Z!
      let sumDy = 0;
      let count = 0;
      for (let i = 0; i < n; i++) {
        const y = f32[sBase + i * 3 + 1];
        const ry = f32[rBase + i * 3 + 1];
        if (Math.abs(ry) > 0.05) {
          sumDy += (y - ry) * Math.sign(ry);
          count++;
        }
      }
      if (count > 0) {
        const strainY = Math.max(-0.35, Math.min(0.35, sumDy / count));
        const scaleXZ = 1.0 - strainY * volumePreserve * 0.35;
        for (let i = 0; i < n; i++) {
          if (i32[fBase + i] !== 0) continue;
          const rx = f32[rBase + i * 3];
          const rz = f32[rBase + i * 3 + 2];
          f32[sBase + i * 3] += rx * (scaleXZ - 1.0) * 0.16;
          f32[sBase + i * 3 + 2] += rz * (scaleXZ - 1.0) * 0.16;
        }
      }
    }
  }

  stepSimulation(rigidity, bounce, springStiffness = 0.34, damping = 0.25, arapIters = 6, isGrabbing = false, extra = {}) {
    if (!this.ready || !this.arena || this.arena.vertCount === 0) return null;
    const a = this.arena;
    const { gravity = 0.0, waveTransfer = 0.65, volumePreserve = 0.45 } = extra;

    const arapRelax = Math.max(0.72, 0.55 + rigidity * 0.45);
    this.exports.arap_step(
      a.vertCount,
      a.pAdjOff,
      a.pAdjIdx,
      a.pAdjW,
      a.pArapPos,
      a.pRest,
      a.pPinFlag,
      a.pPinTarget,
      a.pRot,
      arapIters,
      arapRelax
    );

    const { effStiff, effDamp, effCouple } = this._computePhysicsParams(
      rigidity,
      bounce,
      springStiffness,
      damping,
      isGrabbing,
      waveTransfer
    );
    const poseStiff = isGrabbing ? Math.max(0.012, effStiff * 0.45) : Math.max(0.008, effStiff * 0.55);
    this.exports.softbody_verlet(
      a.vertCount,
      a.pAdjOff,
      a.pAdjIdx,
      a.pAdjW,
      a.pSimPos,
      a.pPrevPos,
      a.pArapPos,
      a.pPinFlag,
      poseStiff,
      effDamp,
      effCouple
    );
    this._applyExternalForces(gravity, volumePreserve);
    const waveCouple = Math.min(0.40, effCouple * 0.85);
    const passes = waveTransfer > 0.72 ? 3 : (waveTransfer < 0.2 ? 1 : 2);
    for (let w = 0; w < passes; w++) {
      this.exports.softbody_verlet(
        a.vertCount,
        a.pAdjOff,
        a.pAdjIdx,
        a.pAdjW,
        a.pSimPos,
        a.pPrevPos,
        a.pArapPos,
        a.pPinFlag,
        0.0,
        1.0,
        waveCouple
      );
    }
    return new Float32Array(this.memory.buffer, a.pSimPos, a.vertCount * 3);
  }

  stepSpringReturn(rigidity = 0.85, bounce = 0.55, springStiffness = 0.34, damping = 0.25, anchorPins = [], extra = {}) {
    if (!this.ready || !this.arena || this.arena.vertCount === 0) return null;
    const a = this.arena;
    const { gravity = 0.0, waveTransfer = 0.65, volumePreserve = 0.45 } = extra;
    const f32 = new Float32Array(this.memory.buffer);
    const i32 = new Int32Array(this.memory.buffer);

    const flagBase = a.pPinFlag >> 2;
    const targetBase = a.pPinTarget >> 2;
    i32.fill(0, flagBase, flagBase + a.vertCount);
    for (let k = 0; k < anchorPins.length; k++) {
      const p = anchorPins[k];
      if (!p.anchor || p.simIdx < 0 || p.simIdx >= a.vertCount) continue;
      i32[flagBase + p.simIdx] = 1;
      f32[targetBase + p.simIdx * 3] = p.pos[0];
      f32[targetBase + p.simIdx * 3 + 1] = p.pos[1];
      f32[targetBase + p.simIdx * 3 + 2] = p.pos[2];
    }

    const { effStiff, effDamp, effCouple } = this._computePhysicsParams(
      rigidity,
      bounce,
      springStiffness,
      damping,
      false,
      waveTransfer
    );
    f32.set(f32.subarray(a.pRest >> 2, (a.pRest >> 2) + a.vertCount * 3), a.pArapPos >> 2);

    const poseStiff = Math.max(0.005, effStiff * 0.32);
    this.exports.softbody_verlet(
      a.vertCount,
      a.pAdjOff,
      a.pAdjIdx,
      a.pAdjW,
      a.pSimPos,
      a.pPrevPos,
      a.pArapPos,
      a.pPinFlag,
      poseStiff,
      effDamp,
      effCouple
    );
    this._applyExternalForces(gravity, volumePreserve);
    const waveCouple = Math.min(0.40, effCouple * 0.88);
    const passes = waveTransfer > 0.72 ? 3 : (waveTransfer < 0.2 ? 1 : 2);
    for (let w = 0; w < passes; w++) {
      this.exports.softbody_verlet(
        a.vertCount,
        a.pAdjOff,
        a.pAdjIdx,
        a.pAdjW,
        a.pSimPos,
        a.pPrevPos,
        a.pArapPos,
        a.pPinFlag,
        0.0,
        1.0,
        waveCouple
      );
    }
    return new Float32Array(this.memory.buffer, a.pSimPos, a.vertCount * 3);
  }

  hasDeformation() {
    if (!this.arena) return false;
    const a = this.arena;
    const f32 = new Float32Array(this.memory.buffer);
    const sBase = a.pSimPos >> 2;
    const pBase = a.pPrevPos >> 2;
    const rBase = a.pRest >> 2;
    const len = a.vertCount * 3;
    for (let i = 0; i < len; i++) {
      if (Math.abs(f32[sBase + i] - f32[rBase + i]) > 1e-4) return true;
      if (Math.abs(f32[sBase + i] - f32[pBase + i]) > 1e-4) return true;
    }
    return false;
  }

  resetPose() {
    if (!this.arena) return;
    const a = this.arena;
    const f32 = new Float32Array(this.memory.buffer);
    const len = a.vertCount * 3;
    const restView = f32.subarray(a.pRest >> 2, (a.pRest >> 2) + len);
    f32.set(restView, a.pArapPos >> 2);
    f32.set(restView, a.pSimPos >> 2);
    f32.set(restView, a.pPrevPos >> 2);
    const rotBase = a.pRot >> 2;
    for (let i = 0; i < a.vertCount; i++) {
      f32[rotBase + i * 4] = 0;
      f32[rotBase + i * 4 + 1] = 0;
      f32[rotBase + i * 4 + 2] = 0;
      f32[rotBase + i * 4 + 3] = 1;
    }
  }

  getSimPositionsView() {
    if (!this.arena) return null;
    return new Float32Array(this.memory.buffer, this.arena.pSimPos, this.arena.vertCount * 3);
  }
}

export const wasmBridge = new WasmSolverBridge();
