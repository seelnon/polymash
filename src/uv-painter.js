// Crisp Pixel-Art UV Texture Engine (2:1 Square-Texel Front/Back Atlas), UV Undo/Redo & Alt-Click Picker

import { state, emit } from './state.js';

export class UvPainter {
  constructor(uvCanvas, glRenderer) {
    this.viewCanvas = uvCanvas;
    this.viewCtx = uvCanvas.getContext('2d');
    this.glRenderer = glRenderer;

    // 2:1 atlas: left half (uvRes x uvRes) = FRONT, right half (uvRes x uvRes) = BACK -> 1:1 square texels!
    this.texCanvas = document.createElement('canvas');
    this.texCanvas.width = state.uvRes * 2;
    this.texCanvas.height = state.uvRes;
    this.texCtx = this.texCanvas.getContext('2d', { willReadFrequently: true });
    this.texCtx.imageSmoothingEnabled = false;

    this.hasCustomPaint = false;
    this.painting = false;
    this.panning = false;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.lastPanPx = 0;
    this.lastPanPy = 0;
    this.uvUndoStack = [];
    this.uvRedoStack = [];

    this.clearToBase('#d97724');
    this.bindEvents();
  }

  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.render2D();
  }

  pushUvUndo() {
    const w = this.texCanvas.width;
    const h = this.texCanvas.height;
    this.uvUndoStack.push(this.texCtx.getImageData(0, 0, w, h));
    if (this.uvUndoStack.length > 40) this.uvUndoStack.shift();
    this.uvRedoStack.length = 0;
  }

  undoUv() {
    if (this.uvUndoStack.length === 0) return false;
    const w = this.texCanvas.width;
    const h = this.texCanvas.height;
    this.uvRedoStack.push(this.texCtx.getImageData(0, 0, w, h));
    const prev = this.uvUndoStack.pop();
    if (prev.width === w && prev.height === h) {
      this.texCtx.putImageData(prev, 0, 0);
      this.hasCustomPaint = true;
      this.syncTexture();
    }
    return true;
  }

  redoUv() {
    if (this.uvRedoStack.length === 0) return false;
    const w = this.texCanvas.width;
    const h = this.texCanvas.height;
    this.uvUndoStack.push(this.texCtx.getImageData(0, 0, w, h));
    const next = this.uvRedoStack.pop();
    if (next.width === w && next.height === h) {
      this.texCtx.putImageData(next, 0, 0);
      this.hasCustomPaint = true;
      this.syncTexture();
    }
    return true;
  }

  clearToBase(hex = '#262626') {
    const w = state.uvRes * 2;
    const h = state.uvRes;
    if (this.texCanvas.width !== w || this.texCanvas.height !== h) {
      this.texCanvas.width = w;
      this.texCanvas.height = h;
      this.texCtx.imageSmoothingEnabled = false;
    }
    this.texCtx.fillStyle = hex;
    this.texCtx.fillRect(0, 0, w, h);
    this.hasCustomPaint = false;
    this.uvUndoStack.length = 0;
    this.uvRedoStack.length = 0;
    this.syncTexture();
  }

  autoFillFromMesh(mesh, force = false) {
    if (!mesh || (!force && this.hasCustomPaint)) {
      this.syncTexture();
      return;
    }
    const w = state.uvRes * 2;
    const h = state.uvRes;
    if (this.texCanvas.width !== w || this.texCanvas.height !== h) {
      this.texCanvas.width = w;
      this.texCanvas.height = h;
      this.texCtx.imageSmoothingEnabled = false;
    }

    const ctx = this.texCtx;
    ctx.fillStyle = '#333333';
    ctx.fillRect(0, 0, w, h);

    const { renUv, renIndices, regionMeta } = mesh;
    for (const reg of regionMeta) {
      ctx.fillStyle = reg.color || '#d97724';
      const end = reg.triStart + reg.triCount * 3;
      for (let i = reg.triStart; i < end; i += 3) {
        const i0 = renIndices[i] * 2;
        const i1 = renIndices[i + 1] * 2;
        const i2 = renIndices[i + 2] * 2;
        ctx.beginPath();
        ctx.moveTo(renUv[i0] * w, (1 - renUv[i0 + 1]) * h);
        ctx.lineTo(renUv[i1] * w, (1 - renUv[i1 + 1]) * h);
        ctx.lineTo(renUv[i2] * w, (1 - renUv[i2 + 1]) * h);
        ctx.closePath();
        ctx.fill();
      }
    }

    this.hasCustomPaint = false;
    this.syncTexture();
    this.render2D();
  }

  syncTexture() {
    this.glRenderer.uploadTexture(this.texCanvas);
    this.render2D();
  }

  pickColorAtUv(u, v) {
    const w = this.texCanvas.width;
    const h = this.texCanvas.height;
    const tx = Math.max(0, Math.min(w - 1, Math.floor(u * w)));
    const ty = Math.max(0, Math.min(h - 1, Math.floor((1 - v) * h)));
    const data = this.texCtx.getImageData(tx, ty, 1, 1).data;
    const hex = '#' + [data[0], data[1], data[2]]
      .map((c) => c.toString(16).padStart(2, '0'))
      .join('');
    state.paintColor = hex;
    emit('color:picked', hex);
  }

  paintAtUv(u, v, forcePick = false) {
    const w = this.texCanvas.width;
    const h = this.texCanvas.height;
    const tx = Math.max(0, Math.min(w - 1, Math.floor(u * w)));
    const ty = Math.max(0, Math.min(h - 1, Math.floor((1 - v) * h)));

    if (forcePick || state.paintTool === 'pick') {
      this.pickColorAtUv(u, v);
      return;
    }

    if (state.paintTool === 'fill') {
      this.floodFill(tx, ty, state.paintColor);
      if (state.uvMirrorFB) {
        const mx = Math.max(0, Math.min(w - 1, w - 1 - tx));
        this.floodFill(mx, ty, state.paintColor);
      }
      this.hasCustomPaint = true;
      this.syncTexture();
      return;
    }

    const sz = state.brushSize;
    const half = Math.floor(sz / 2);
    this.texCtx.fillStyle = state.paintColor;
    this.texCtx.fillRect(tx - half, ty - half, sz, sz);

    if (state.uvMirrorFB) {
      const mx = Math.max(0, Math.min(w - 1, w - 1 - tx));
      this.texCtx.fillRect(mx - half, ty - half, sz, sz);
    }

    if (state.uvSymX) {
      const halfW = w * 0.5;
      const inLeft = tx < halfW;
      const sx = inLeft ? (halfW - 1 - tx) : (w - 1 - (tx - halfW));
      this.texCtx.fillRect(Math.floor(sx) - half, ty - half, sz, sz);
      if (state.uvMirrorFB) {
        const msx = Math.max(0, Math.min(w - 1, w - 1 - Math.floor(sx)));
        this.texCtx.fillRect(msx - half, ty - half, sz, sz);
      }
    }

    this.hasCustomPaint = true;
    this.syncTexture();
  }

  floodFill(startX, startY, fillHex) {
    const w = this.texCanvas.width;
    const h = this.texCanvas.height;
    const img = this.texCtx.getImageData(0, 0, w, h);
    const d = img.data;
    const idx0 = (startY * w + startX) * 4;
    const sr = d[idx0], sg = d[idx0 + 1], sb = d[idx0 + 2];

    const clean = fillHex.replace('#', '');
    const num = parseInt(clean, 16);
    const fr = (num >> 16) & 255;
    const fg = (num >> 8) & 255;
    const fb = num & 255;

    if (sr === fr && sg === fg && sb === fb) return;

    const stack = [[startX, startY]];
    const visited = new Uint8Array(w * h);
    while (stack.length > 0) {
      const [x, y] = stack.pop();
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const p = y * w + x;
      if (visited[p]) continue;
      visited[p] = 1;
      const i = p * 4;
      if (Math.abs(d[i] - sr) > 10 || Math.abs(d[i + 1] - sg) > 10 || Math.abs(d[i + 2] - sb) > 10) {
        continue;
      }
      d[i] = fr;
      d[i + 1] = fg;
      d[i + 2] = fb;
      d[i + 3] = 255;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    this.texCtx.putImageData(img, 0, 0);
  }

  setResolution(newRes) {
    const old = document.createElement('canvas');
    old.width = this.texCanvas.width;
    old.height = this.texCanvas.height;
    old.getContext('2d').drawImage(this.texCanvas, 0, 0);

    state.uvRes = newRes;
    this.texCanvas.width = newRes * 2;
    this.texCanvas.height = newRes;
    this.texCtx.imageSmoothingEnabled = false;
    this.texCtx.drawImage(old, 0, 0, newRes * 2, newRes);
    this.uvUndoStack.length = 0;
    this.uvRedoStack.length = 0;
    this.syncTexture();
  }

  // 2:1 aspect box inside 2D UV pane with cursor-centered zoom & pan so every pixel stays 1:1 square
  getLayout() {
    const w = this.viewCanvas.width;
    const h = this.viewCanvas.height;
    const pad = 20;
    const maxW = Math.max(120, w - pad * 2);
    const maxH = Math.max(60, h - pad * 2);
    let baseW = maxW;
    let baseH = baseW * 0.5;
    if (baseH > maxH) {
      baseH = maxH;
      baseW = baseH * 2;
    }
    const drawW = baseW * this.zoom;
    const drawH = baseH * this.zoom;
    const ox = (w - drawW) * 0.5 + this.panX;
    const oy = (h - drawH) * 0.5 + this.panY;
    return { w, h, baseW, baseH, drawW, drawH, ox, oy };
  }

  clientToUv(clientX, clientY) {
    const rect = this.viewCanvas.getBoundingClientRect();
    const dpr = this.viewCanvas.width / Math.max(1, rect.width);
    const px = (clientX - rect.left) * dpr;
    const py = (clientY - rect.top) * dpr;
    const { drawW, drawH, ox, oy } = this.getLayout();
    const u = (px - ox) / drawW;
    const v = 1 - (py - oy) / drawH;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return { u, v };
  }

  bindEvents() {
    this.viewCanvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    this.viewCanvas.addEventListener('wheel', (e) => {
      if (state.mode !== 'paint') return;
      e.preventDefault();
      this.resizeIfNeeded();
      const rect = this.viewCanvas.getBoundingClientRect();
      const dpr = this.viewCanvas.width / Math.max(1, rect.width);
      const px = (e.clientX - rect.left) * dpr;
      const py = (e.clientY - rect.top) * dpr;

      const old = this.getLayout();
      const uNorm = (px - old.ox) / Math.max(1, old.drawW);
      const vNorm = (py - old.oy) / Math.max(1, old.drawH);

      const factor = e.deltaY < 0 ? 1.16 : 1 / 1.16;
      this.zoom = Math.max(0.6, Math.min(18, this.zoom * factor));

      const nextW = old.baseW * this.zoom;
      const nextH = old.baseH * this.zoom;
      this.panX = px - uNorm * nextW - (old.w - nextW) * 0.5;
      this.panY = py - vNorm * nextH - (old.h - nextH) * 0.5;
      this.render2D();
    }, { passive: false });

    this.viewCanvas.addEventListener('pointerdown', (e) => {
      if (state.mode !== 'paint') return;
      this.viewCanvas.setPointerCapture(e.pointerId);

      // Pan via Right-click, Middle-click, or Shift+Left-click
      if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
        const rect = this.viewCanvas.getBoundingClientRect();
        const dpr = this.viewCanvas.width / Math.max(1, rect.width);
        this.panning = true;
        this.lastPanPx = (e.clientX - rect.left) * dpr;
        this.lastPanPy = (e.clientY - rect.top) * dpr;
        this.viewCanvas.style.cursor = 'grabbing';
        return;
      }

      if (e.button !== 0) return;
      const uv = this.clientToUv(e.clientX, e.clientY);
      if (!uv) return;

      if (e.altKey || state.paintTool === 'pick') {
        this.painting = true;
        this.paintAtUv(uv.u, uv.v, true);
        return;
      }

      this.pushUvUndo();
      this.painting = true;
      this.paintAtUv(uv.u, uv.v, false);
    });

    this.viewCanvas.addEventListener('pointermove', (e) => {
      if (state.mode !== 'paint') return;
      if (this.panning) {
        const rect = this.viewCanvas.getBoundingClientRect();
        const dpr = this.viewCanvas.width / Math.max(1, rect.width);
        const px = (e.clientX - rect.left) * dpr;
        const py = (e.clientY - rect.top) * dpr;
        this.panX += px - this.lastPanPx;
        this.panY += py - this.lastPanPy;
        this.lastPanPx = px;
        this.lastPanPy = py;
        this.render2D();
        return;
      }
      if (!this.painting) return;
      const uv = this.clientToUv(e.clientX, e.clientY);
      if (uv) this.paintAtUv(uv.u, uv.v, e.altKey);
    });

    this.viewCanvas.addEventListener('pointerup', () => {
      this.painting = false;
      this.panning = false;
      this.viewCanvas.style.cursor = '';
    });
  }

  resizeIfNeeded() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.viewCanvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.viewCanvas.clientHeight * dpr));
    if (this.viewCanvas.width !== w || this.viewCanvas.height !== h) {
      this.viewCanvas.width = w;
      this.viewCanvas.height = h;
    }
  }

  render2D() {
    if (state.mode !== 'paint') return;
    this.resizeIfNeeded();
    const ctx = this.viewCtx;
    const { w, h, drawW, drawH, ox, oy } = this.getLayout();

    ctx.fillStyle = '#18181b';
    ctx.fillRect(0, 0, w, h);

    // Transparency checkerboard inside the 2:1 UV atlas box so alpha texels appear clearly see-through
    const cols = this.texCanvas.width;
    const rows = this.texCanvas.height;
    const stepX = drawW / cols;
    const stepY = drawH / rows;
    ctx.fillStyle = '#252529';
    ctx.fillRect(ox, oy, drawW, drawH);
    const ck = Math.max(6, Math.min(18, stepX >= 4 ? stepX : 10));
    ctx.fillStyle = '#323238';
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, drawW, drawH);
    ctx.clip();
    const nx = Math.ceil(drawW / ck);
    const ny = Math.ceil(drawH / ck);
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx < nx; cx++) {
        if ((cx + cy) % 2 === 0) {
          ctx.fillRect(ox + cx * ck, oy + cy * ck, ck, ck);
        }
      }
    }
    ctx.restore();

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.texCanvas, ox, oy, drawW, drawH);
    ctx.restore();

    if (drawW / cols >= 4) {
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= cols; i++) {
        ctx.beginPath();
        ctx.moveTo(ox + i * stepX, oy);
        ctx.lineTo(ox + i * stepX, oy + drawH);
        ctx.stroke();
      }
      for (let j = 0; j <= rows; j++) {
        ctx.beginPath();
        ctx.moveTo(ox, oy + j * stepY);
        ctx.lineTo(ox + drawW, oy + j * stepY);
        ctx.stroke();
      }
    }

    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ox + drawW * 0.5, oy);
    ctx.lineTo(ox + drawW * 0.5, oy + drawH);
    ctx.stroke();

    if (state.mesh) {
      const { renUv, renIndices } = state.mesh;
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < renIndices.length; i += 3) {
        const i0 = renIndices[i] * 2;
        const i1 = renIndices[i + 1] * 2;
        const i2 = renIndices[i + 2] * 2;
        ctx.moveTo(ox + renUv[i0] * drawW, oy + (1 - renUv[i0 + 1]) * drawH);
        ctx.lineTo(ox + renUv[i1] * drawW, oy + (1 - renUv[i1 + 1]) * drawH);
        ctx.lineTo(ox + renUv[i2] * drawW, oy + (1 - renUv[i2 + 1]) * drawH);
        ctx.closePath();
      }
      ctx.stroke();
    }

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.strokeRect(ox, oy, drawW, drawH);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px monospace';
    ctx.fillText('FRONT UV (1:1)', ox + 6, oy + 14);
    ctx.fillText('BACK UV (1:1)', ox + drawW * 0.5 + 6, oy + 14);

    // Subtle zoom readout pill at bottom-left of UV pane
    const zTxt = `ZOOM ${Math.round(this.zoom * 100)}%  |  WHEEL: ZOOM  RIGHT/SHIFT+DRAG: PAN`;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(8, h - 22, ctx.measureText(zTxt).width + 12, 16);
    ctx.fillStyle = '#22d3ee';
    ctx.fillText(zTxt, 14, h - 10);
  }
}
