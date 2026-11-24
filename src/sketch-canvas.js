// Interactive Grid-Snapped 2D Sketch, Flap & Extrude Canvas
// Includes 2D CDT triangle wireframe preview, intersection markers, live Mirror X drawing/welding,
// and EDIT mode vertex drag + Shift+Click (add point) + Alt+Click (remove point).

import { state, emit, pushHistory } from './state.js';

const STROKE_PALETTE = [
  '#d97724', '#e09f5a', '#4f46e5', '#0891b2',
  '#be185d', '#65a30d', '#f59e0b', '#7c3aed',
];

function segCross2D(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay;
  const sx = dx - cx, sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-8) return null;
  const qpx = cx - ax, qpy = cy - ay;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t > 0.002 && t < 0.998 && u > 0.002 && u < 0.998) {
    return { x: ax + t * rx, y: ay + t * ry };
  }
  return null;
}

function pointToSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-8) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export class SketchCanvas {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.draftPoints = [];
    this.hoverGrid = null;
    this.hoverVertex = null;
    this.hoverEdge = null;
    this.isDrawing = false;
    this.dragVertex = null;
    this.shiftDown = false;
    this.altDown = false;
    this.spaceDown = false;

    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.panning = false;
    this.panBtn = -1;
    this.panMoved = false;
    this.panStartPx = 0;
    this.panStartPy = 0;
    this.lastPanPx = 0;
    this.lastPanPy = 0;
    this._suppressContextDraft = false;

    this.bindEvents();
  }

  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.render();
  }

  getLayout() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const pad = 22;
    const baseSize = Math.max(120, Math.min(w, h) - pad * 2);
    const size = baseSize * this.zoom;
    const ox = (w - size) * 0.5 + this.panX;
    const oy = (h - size) * 0.5 + this.panY;
    return { w, h, baseSize, size, ox, oy };
  }

  clientToGrid(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, rect.width);
    const px = (clientX - rect.left) * dpr;
    const py = (clientY - rect.top) * dpr;
    const { size, ox, oy } = this.getLayout();
    const gx = Math.round(((px - ox) / size) * state.gridRes);
    const gy = Math.round(((py - oy) / size) * state.gridRes);
    return {
      gx: Math.max(0, Math.min(state.gridRes, gx)),
      gy: Math.max(0, Math.min(state.gridRes, gy)),
    };
  }

  gridToPx(gx, gy) {
    const { size, ox, oy } = this.getLayout();
    return {
      x: ox + (gx / state.gridRes) * size,
      y: oy + (gy / state.gridRes) * size,
    };
  }

  worldToPx(wx, wy) {
    const { size, ox, oy } = this.getLayout();
    return {
      x: ox + ((wx + 1) * 0.5) * size,
      y: oy + ((1 - wy) * 0.5) * size,
    };
  }

  syncMirroredVertexMove(stroke, idx, oldGx, oldGy, newGx, newGy) {
    if (!state.mirrorX) return;
    if (stroke.mirrorPairId) {
      const partner = state.strokes.find((s) => s.id === stroke.mirrorPairId);
      if (partner && partner.points[idx]) {
        partner.points[idx] = { gx: state.gridRes - newGx, gy: newGy };
      }
      return;
    }
    const mid = state.gridRes * 0.5;
    if (Math.abs(oldGx - mid) < 0.01) return;
    const targetGx = state.gridRes - oldGx;
    let bestJ = -1;
    let bestD = 1.2;
    for (let j = 0; j < stroke.points.length; j++) {
      if (j === idx) continue;
      const p = stroke.points[j];
      const d = Math.hypot(p.gx - targetGx, p.gy - oldGy);
      if (d < bestD) {
        bestD = d;
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      stroke.points[bestJ] = { gx: state.gridRes - newGx, gy: newGy };
    }
  }

  bindEvents() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && state.mode === 'sketch' &&
          e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
        e.preventDefault();
        if (!this.spaceDown) {
          this.spaceDown = true;
          if (!this.panning) this.canvas.style.cursor = 'grab';
        }
      }
      if (this.shiftDown !== e.shiftKey || this.altDown !== e.altKey) {
        this.shiftDown = e.shiftKey;
        this.altDown = e.altKey;
        if (state.mode === 'sketch' && state.sketchTool === 'edit') this.render();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        if (!this.panning) this.canvas.style.cursor = '';
      }
      if (this.shiftDown !== e.shiftKey || this.altDown !== e.altKey) {
        this.shiftDown = e.shiftKey;
        this.altDown = e.altKey;
        if (state.mode === 'sketch' && state.sketchTool === 'edit') this.render();
      }
    });

    this.canvas.addEventListener('wheel', (e) => {
      if (state.mode !== 'sketch') return;
      e.preventDefault();
      this.resizeIfNeeded();
      const rect = this.canvas.getBoundingClientRect();
      const dpr = this.canvas.width / Math.max(1, rect.width);
      const px = (e.clientX - rect.left) * dpr;
      const py = (e.clientY - rect.top) * dpr;

      const old = this.getLayout();
      const uNorm = (px - old.ox) / Math.max(1, old.size);
      const vNorm = (py - old.oy) / Math.max(1, old.size);

      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.zoom = Math.max(0.6, Math.min(6.0, this.zoom * factor));

      const nextSize = old.baseSize * this.zoom;
      this.panX = px - uNorm * nextSize - (old.w - nextSize) * 0.5;
      this.panY = py - vNorm * nextSize - (old.h - nextSize) * 0.5;
      this.render();
    }, { passive: false });

    this.canvas.addEventListener('pointerdown', (e) => {
      if (state.mode !== 'sketch') return;

      // Pan via Middle-drag, Right-drag (with >4px movement threshold so short right-click still commits), or Space+Left-drag
      if (e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceDown)) {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = this.canvas.width / Math.max(1, rect.width);
        const px = (e.clientX - rect.left) * dpr;
        const py = (e.clientY - rect.top) * dpr;
        this.panning = true;
        this.panBtn = e.button;
        this.panMoved = false;
        this.panStartPx = px;
        this.panStartPy = py;
        this.lastPanPx = px;
        this.lastPanPy = py;
        this.canvas.setPointerCapture(e.pointerId);
        this.canvas.style.cursor = 'grabbing';
        return;
      }

      if (e.button !== 0) return;
      this.canvas.setPointerCapture(e.pointerId);
      this.shiftDown = e.shiftKey;
      this.altDown = e.altKey;
      const g = this.clientToGrid(e.clientX, e.clientY);

      if (state.sketchTool === 'edit') {
        // Alt+Click: Delete hovered point
        if (e.altKey) {
          const hit = this.findNearestVertex(e.clientX, e.clientY);
          if (hit) {
            const stroke = state.strokes.find((s) => s.id === hit.strokeId);
            const minPts = stroke?.type === 'flap' ? 2 : 3;
            if (stroke && stroke.points.length > minPts) {
              pushHistory();
              const removed = stroke.points[hit.idx];
              stroke.points.splice(hit.idx, 1);

              // Sync mirror deletion when MIRROR X is enabled
              if (state.mirrorX) {
                if (stroke.mirrorPairId) {
                  const partner = state.strokes.find((s) => s.id === stroke.mirrorPairId);
                  if (partner && partner.points.length > minPts && hit.idx < partner.points.length) {
                    partner.points.splice(hit.idx, 1);
                  }
                } else {
                  const mid = state.gridRes * 0.5;
                  if (Math.abs(removed.gx - mid) > 0.01 && stroke.points.length > minPts) {
                    const mgx = state.gridRes - removed.gx;
                    let bestJ = -1, bestD = 1.2;
                    for (let j = 0; j < stroke.points.length; j++) {
                      const d = Math.hypot(stroke.points[j].gx - mgx, stroke.points[j].gy - removed.gy);
                      if (d < bestD) { bestD = d; bestJ = j; }
                    }
                    if (bestJ >= 0) stroke.points.splice(bestJ, 1);
                  }
                }
              }

              state.activeStrokeId = stroke.id;
              this.hoverVertex = null;
              emit('mesh:dirty');
              emit('ui:sync');
              this.render();
            }
          }
          return;
        }

        // Shift+Click: Add point on nearest edge
        if (e.shiftKey) {
          const edgeHit = this.findNearestEdge(e.clientX, e.clientY);
          if (edgeHit) {
            const stroke = state.strokes.find((s) => s.id === edgeHit.strokeId);
            if (stroke) {
              pushHistory();
              const insertAt = edgeHit.insertAfterIdx + 1;
              stroke.points.splice(insertAt, 0, { gx: g.gx, gy: g.gy });

              if (state.mirrorX) {
                if (stroke.mirrorPairId) {
                  const partner = state.strokes.find((s) => s.id === stroke.mirrorPairId);
                  if (partner && insertAt <= partner.points.length) {
                    partner.points.splice(insertAt, 0, { gx: state.gridRes - g.gx, gy: g.gy });
                  }
                } else {
                  const mid = state.gridRes * 0.5;
                  if (Math.abs(g.gx - mid) > 0.5) {
                    // Find mirrored edge on opposite side and insert opposite vertex
                    const mgx = state.gridRes - g.gx;
                    const isClosed = stroke.type !== 'flap';
                    const n = stroke.points.length;
                    const limit = isClosed ? n : n - 1;
                    let bestEdgeAfter = -1, bestDist = Infinity;
                    for (let i = 0; i < limit; i++) {
                      const a = stroke.points[i];
                      const b = stroke.points[(i + 1) % n];
                      if (i === edgeHit.insertAfterIdx || i === edgeHit.insertAfterIdx + 1) continue;
                      const d = pointToSegDist(mgx, g.gy, a.gx, a.gy, b.gx, b.gy);
                      if (d < bestDist) { bestDist = d; bestEdgeAfter = i; }
                    }
                    if (bestEdgeAfter >= 0 && bestDist < 4.5) {
                      const adjIdx = bestEdgeAfter < insertAt ? insertAt + 1 : insertAt;
                      stroke.points.splice(bestEdgeAfter + 1, 0, { gx: mgx, gy: g.gy });
                      if (bestEdgeAfter < insertAt) {
                        this.dragVertex = { strokeId: stroke.id, idx: adjIdx };
                      }
                    }
                  }
                }
              }

              if (!this.dragVertex) {
                this.dragVertex = { strokeId: stroke.id, idx: insertAt };
              }
              state.activeStrokeId = stroke.id;
              emit('mesh:dirty');
              emit('ui:sync');
              this.render();
            }
          }
          return;
        }

        const hit = this.findNearestVertex(e.clientX, e.clientY);
        if (hit) {
          pushHistory();
          this.dragVertex = hit;
          state.activeStrokeId = hit.strokeId;
          emit('ui:sync');
        }
        return;
      }

      if (state.lassoMode) {
        this.isDrawing = true;
        this.draftPoints = [g];
        this.render();
      } else {
        if (this.draftPoints.length === 0) {
          this.draftPoints = [g];
        } else {
          const first = this.draftPoints[0];
          const last = this.draftPoints[this.draftPoints.length - 1];
          const isClosedLoop = state.sketchTool === 'closed' || state.sketchTool === 'extrude';
          if (isClosedLoop && this.draftPoints.length >= 3 && g.gx === first.gx && g.gy === first.gy) {
            this.commitDraft();
            return;
          }
          if (g.gx !== last.gx || g.gy !== last.gy) {
            this.draftPoints.push(g);
          }
        }
        this.render();
      }
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (state.mode !== 'sketch') return;
      if (this.panning) {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = this.canvas.width / Math.max(1, rect.width);
        const px = (e.clientX - rect.left) * dpr;
        const py = (e.clientY - rect.top) * dpr;
        if (!this.panMoved && Math.hypot(px - this.panStartPx, py - this.panStartPy) > 4 * dpr) {
          this.panMoved = true;
        }
        this.panX += px - this.lastPanPx;
        this.panY += py - this.lastPanPy;
        this.lastPanPx = px;
        this.lastPanPy = py;
        this.render();
        return;
      }

      this.shiftDown = e.shiftKey;
      this.altDown = e.altKey;
      const g = this.clientToGrid(e.clientX, e.clientY);
      this.hoverGrid = g;

      if (this.dragVertex) {
        const stroke = state.strokes.find((s) => s.id === this.dragVertex.strokeId);
        if (stroke) {
          const prev = stroke.points[this.dragVertex.idx];
          if (prev && (prev.gx !== g.gx || prev.gy !== g.gy)) {
            this.syncMirroredVertexMove(stroke, this.dragVertex.idx, prev.gx, prev.gy, g.gx, g.gy);
            stroke.points[this.dragVertex.idx] = { gx: g.gx, gy: g.gy };
            emit('mesh:dirty');
          }
          this.render();
        }
        return;
      }

      if (state.sketchTool === 'edit') {
        this.hoverVertex = this.findNearestVertex(e.clientX, e.clientY);
        this.hoverEdge = e.shiftKey ? this.findNearestEdge(e.clientX, e.clientY) : null;
        this.render();
        return;
      } else {
        this.hoverVertex = null;
        this.hoverEdge = null;
      }

      if (this.isDrawing && state.lassoMode) {
        const last = this.draftPoints[this.draftPoints.length - 1];
        if (!last || last.gx !== g.gx || last.gy !== g.gy) {
          const prev = this.draftPoints[this.draftPoints.length - 2];
          if (prev && prev.gx === g.gx && prev.gy === g.gy) {
            this.draftPoints.pop();
          } else {
            this.draftPoints.push(g);
          }
        }
      }
      this.render();
    });

    this.canvas.addEventListener('pointerup', () => {
      if (this.panning) {
        if (this.panBtn === 2 && this.panMoved) {
          this._suppressContextDraft = true;
        }
        this.panning = false;
        this.panBtn = -1;
        this.canvas.style.cursor = this.spaceDown ? 'grab' : '';
        return;
      }
      if (this.dragVertex) {
        this.dragVertex = null;
        emit('mesh:dirty');
        return;
      }
      if (this.isDrawing && state.lassoMode) {
        this.isDrawing = false;
        this.commitDraft();
      }
    });

    this.canvas.addEventListener('dblclick', () => {
      if (state.mode === 'sketch' && !state.lassoMode && this.draftPoints.length >= 2) {
        this.commitDraft();
      }
    });

    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this._suppressContextDraft) {
        this._suppressContextDraft = false;
        return;
      }
      if (this.draftPoints.length >= 2) {
        this.commitDraft();
      } else {
        this.draftPoints = [];
        this.render();
      }
    });

    this.canvas.addEventListener('pointerleave', () => {
      this.hoverGrid = null;
      this.hoverVertex = null;
      this.hoverEdge = null;
      this.render();
    });
  }

  findNearestVertex(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, rect.width);
    const px = (clientX - rect.left) * dpr;
    const py = (clientY - rect.top) * dpr;

    let best = null;
    let bestDist = 18 * dpr;

    for (const s of state.strokes) {
      if (s.visible === false) continue;
      for (let i = 0; i < s.points.length; i++) {
        const pt = this.gridToPx(s.points[i].gx, s.points[i].gy);
        const d = Math.hypot(pt.x - px, pt.y - py);
        if (d < bestDist) {
          bestDist = d;
          best = { strokeId: s.id, idx: i };
        }
      }
    }
    return best;
  }

  findNearestEdge(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, rect.width);
    const px = (clientX - rect.left) * dpr;
    const py = (clientY - rect.top) * dpr;

    let best = null;
    let bestDist = 14 * dpr;

    for (const s of state.strokes) {
      if (s.visible === false || s.points.length < 2) continue;
      const isClosed = s.type === 'closed' || s.type === 'extrude';
      const segCount = isClosed ? s.points.length : s.points.length - 1;
      for (let i = 0; i < segCount; i++) {
        const a = this.gridToPx(s.points[i].gx, s.points[i].gy);
        const b = this.gridToPx(s.points[(i + 1) % s.points.length].gx, s.points[(i + 1) % s.points.length].gy);
        const d = pointToSegDist(px, py, a.x, a.y, b.x, b.y);
        if (d < bestDist) {
          bestDist = d;
          best = { strokeId: s.id, insertAfterIdx: i };
        }
      }
    }
    return best;
  }

  simplifyCollinear(pts) {
    if (pts.length <= 3) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = out[out.length - 1];
      const b = pts[i];
      const c = pts[i + 1];
      const cross = (b.gx - a.gx) * (c.gy - b.gy) - (b.gy - a.gy) * (c.gx - b.gx);
      if (cross !== 0) out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  commitDraft() {
    let cleaned = this.simplifyCollinear(this.draftPoints);
    this.draftPoints = [];

    const type = state.sketchTool === 'flap' ? 'flap' : (state.sketchTool === 'extrude' ? 'extrude' : 'closed');
    const minPts = type === 'flap' ? 2 : 3;
    if (cleaned.length < minPts) {
      this.render();
      return;
    }

    pushHistory();
    const idx = state.strokes.length;
    const color = STROKE_PALETTE[idx % STROKE_PALETTE.length];
    const id = `str_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const prefix = type === 'flap' ? 'FLAP' : (type === 'extrude' ? 'EXTR' : 'BODY');
    const label = `${prefix} ${idx + 1}`;

    let createPair = false;
    let mirroredPts = null;

    if (state.mirrorX) {
      const mid = state.gridRes * 0.5;
      const allLeft = cleaned.every((p) => p.gx <= mid + 1);
      const allRight = cleaned.every((p) => p.gx >= mid - 1);
      const hasOffCenter = cleaned.some((p) => Math.abs(p.gx - mid) > 1.5);
      const firstNear = Math.abs(cleaned[0].gx - mid) <= 1.5;
      const lastNear = Math.abs(cleaned[cleaned.length - 1].gx - mid) <= 1.5;

      if ((type === 'closed' || type === 'extrude') && (allLeft || allRight) && hasOffCenter && firstNear && lastNear) {
        // Weld half-body stroke drawn up to the symmetry axis into a single symmetric polygon
        cleaned = cleaned.map((p) => ({ ...p }));
        cleaned[0].gx = Math.round(mid);
        cleaned[cleaned.length - 1].gx = Math.round(mid);
        const tail = cleaned
          .slice(0, -1)
          .reverse()
          .map((p) => ({ gx: state.gridRes - p.gx, gy: p.gy }));
        const combined = [...cleaned, ...tail];
        const dedup = [];
        for (const p of combined) {
          const prev = dedup[dedup.length - 1];
          if (!prev || prev.gx !== p.gx || prev.gy !== p.gy) dedup.push(p);
        }
        if (dedup.length > 1 && dedup[0].gx === dedup[dedup.length - 1].gx && dedup[0].gy === dedup[dedup.length - 1].gy) {
          dedup.pop();
        }
        cleaned = dedup;
      } else {
        const hasLeft = cleaned.some((p) => p.gx < mid - 1.5);
        const hasRight = cleaned.some((p) => p.gx > mid + 1.5);
        const avgDx = cleaned.reduce((acc, p) => acc + Math.abs(p.gx - mid), 0) / cleaned.length;
        // Only spawn mirrored twin if the drawn shape lies predominantly on one side of the axis
        if (!(hasLeft && hasRight) && avgDx > 1.0) {
          createPair = true;
          mirroredPts = cleaned.map((p) => ({ gx: state.gridRes - p.gx, gy: p.gy }));
        }
      }
    }

    const mirrorId = createPair ? `str_${Date.now()}_m` : null;

    state.strokes.push({
      id,
      name: label,
      type,
      flapSide: state.flapSide,
      flapAttach: type === 'flap' ? 0 : 100,
      color,
      visible: true,
      partDepth: 1.0,
      partPuff: 1.0,
      mirrorPairId: mirrorId,
      points: cleaned,
    });
    state.activeStrokeId = id;

    if (createPair && mirroredPts) {
      state.strokes.push({
        id: mirrorId,
        name: `${label} M`,
        type,
        flapSide: state.flapSide,
        flapAttach: type === 'flap' ? 0 : 100,
        color,
        visible: true,
        partDepth: 1.0,
        partPuff: 1.0,
        mirrorPairId: id,
        points: mirroredPts,
      });
    }

    emit('mesh:dirty');
    emit('ui:sync');
    this.render();
  }

  resizeIfNeeded() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render() {
    this.resizeIfNeeded();
    const ctx = this.ctx;
    const { w, h, size, ox, oy } = this.getLayout();

    ctx.fillStyle = '#ebebeb';
    ctx.fillRect(0, 0, w, h);

    if (state.refClampedCanvas || state.refImage) {
      ctx.save();
      ctx.globalAlpha = state.refAlpha;
      ctx.imageSmoothingEnabled = !state.refTrace?.pixelate;
      if (state.refClampedCanvas) {
        ctx.drawImage(state.refClampedCanvas, ox, oy, size, size);
      } else {
        const img = state.refImage;
        const scale = Math.min(size / img.width, size / img.height);
        const iw = img.width * scale;
        const ih = img.height * scale;
        ctx.drawImage(img, ox + (size - iw) * 0.5, oy + (size - ih) * 0.5, iw, ih);
      }
      ctx.restore();
    }

    const N = state.gridRes;
    const cell = size / N;
    ctx.lineWidth = 1;
    for (let i = 0; i <= N; i++) {
      const p = ox + i * cell;
      const q = oy + i * cell;
      ctx.strokeStyle = i % 4 === 0 ? '#c8c8c8' : '#dcdcdc';
      ctx.beginPath();
      ctx.moveTo(p, oy);
      ctx.lineTo(p, oy + size);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(ox, q);
      ctx.lineTo(ox + size, q);
      ctx.stroke();
    }

    ctx.strokeStyle = state.mirrorX ? '#0891b2' : '#b8b8b8';
    ctx.lineWidth = state.mirrorX ? 2 : 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(ox + size * 0.5, oy);
    ctx.lineTo(ox + size * 0.5, oy + size);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.strokeRect(ox, oy, size, size);

    // Draw stroke fills first
    for (const s of state.strokes) {
      if (s.visible === false || s.points.length < 2) continue;
      if (s.type === 'closed' || s.type === 'extrude') {
        ctx.save();
        ctx.beginPath();
        for (let i = 0; i < s.points.length; i++) {
          const pt = this.gridToPx(s.points[i].gx, s.points[i].gy);
          if (i === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        }
        ctx.closePath();
        ctx.fillStyle = `${s.color}26`;
        ctx.fill();
        ctx.restore();
      }
    }

    // Draw 2D Constrained Delaunay Triangle Wireframe inside regions only when 2D WIRE toggle is enabled
    if (state.sketchWireframe && state.mesh && state.mesh.regionMeta) {
      ctx.save();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const reg of state.mesh.regionMeta) {
        if (!reg.poly || !reg.tris2D) continue;
        for (const [ia, ib, ic] of reg.tris2D) {
          const pa = this.worldToPx(reg.poly[ia].x, reg.poly[ia].y);
          const pb = this.worldToPx(reg.poly[ib].x, reg.poly[ib].y);
          const pc = this.worldToPx(reg.poly[ic].x, reg.poly[ic].y);
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.lineTo(pc.x, pc.y);
          ctx.closePath();
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    // Draw stroke outlines, hinges, and editable vertices
    for (const s of state.strokes) {
      if (s.visible === false || s.points.length < 2) continue;
      const isActive = s.id === state.activeStrokeId;

      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < s.points.length; i++) {
        const pt = this.gridToPx(s.points[i].gx, s.points[i].gy);
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      if (s.type === 'closed' || s.type === 'extrude') ctx.closePath();

      ctx.lineWidth = isActive ? 3 : 2;
      ctx.strokeStyle = isActive ? '#000000' : (s.type === 'extrude' ? '#0891b2' : '#262626');
      if (s.type === 'extrude') ctx.setLineDash([5, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Highlight hovered edge when Shift is held in EDIT mode
      if (state.sketchTool === 'edit' && this.shiftDown && this.hoverEdge && this.hoverEdge.strokeId === s.id) {
        const ei = this.hoverEdge.insertAfterIdx;
        const a = this.gridToPx(s.points[ei].gx, s.points[ei].gy);
        const b = this.gridToPx(s.points[(ei + 1) % s.points.length].gx, s.points[(ei + 1) % s.points.length].gy);
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      if (s.type === 'flap' && s.points.length >= 2) {
        const p0 = this.gridToPx(s.points[0].gx, s.points[0].gy);
        const p1 = this.gridToPx(s.points[s.points.length - 1].gx, s.points[s.points.length - 1].gy);
        ctx.strokeStyle = isActive ? '#0891b2' : '#737373';
        ctx.lineWidth = isActive ? 2.5 : 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (isActive) {
          const pct = s.flapAttach ?? 0;
          const mx = (p0.x + p1.x) * 0.5;
          const my = (p0.y + p1.y) * 0.5;
          ctx.fillStyle = '#0891b2';
          ctx.font = 'bold 9px monospace';
          ctx.fillText(`HINGE ${pct}%`, mx + 4, my - 4);
        }
      }

      if (state.sketchTool === 'edit' || isActive) {
        for (let i = 0; i < s.points.length; i++) {
          const gp = s.points[i];
          const pt = this.gridToPx(gp.gx, gp.gy);
          const isDelHover = state.sketchTool === 'edit' && this.altDown &&
            this.hoverVertex && this.hoverVertex.strokeId === s.id && this.hoverVertex.idx === i;
          ctx.fillStyle = isDelHover ? '#dc2626' : (isActive ? '#22d3ee' : '#ffffff');
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 1.5;
          const half = isDelHover ? 5.5 : 4;
          ctx.fillRect(pt.x - half, pt.y - half, half * 2, half * 2);
          ctx.strokeRect(pt.x - half, pt.y - half, half * 2, half * 2);
        }
      }
      ctx.restore();
    }

    // Highlight all boundary intersection points (cross-stroke + self-intersections)
    const segs = [];
    for (const s of state.strokes) {
      if (s.visible === false || s.points.length < 2) continue;
      const isClosed = s.type === 'closed' || s.type === 'extrude';
      const count = isClosed ? s.points.length : s.points.length - 1;
      for (let i = 0; i < count; i++) {
        const a = s.points[i];
        const b = s.points[(i + 1) % s.points.length];
        segs.push({ sId: s.id, idx: i, nPts: s.points.length, isClosed, ax: a.gx, ay: a.gy, bx: b.gx, by: b.gy });
      }
    }
    for (let i = 0; i < segs.length; i++) {
      const A = segs[i];
      for (let j = i + 1; j < segs.length; j++) {
        const B = segs[j];
        const sameStroke = A.sId === B.sId;
        if (sameStroke) {
          if (Math.abs(A.idx - B.idx) <= 1) continue;
          if (A.isClosed && A.idx === 0 && B.idx === A.nPts - 1) continue;
        }
        const cross = segCross2D(A.ax, A.ay, A.bx, A.by, B.ax, B.ay, B.bx, B.by);
        if (cross) {
          const pt = this.gridToPx(cross.x, cross.y);
          ctx.fillStyle = sameStroke ? '#dc2626' : '#22d3ee';
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(pt.x, pt.y - 4.5);
          ctx.lineTo(pt.x + 4.5, pt.y);
          ctx.lineTo(pt.x, pt.y + 4.5);
          ctx.lineTo(pt.x - 4.5, pt.y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    if (state.mesh && state.mesh.attachments) {
      for (const att of state.mesh.attachments) {
        const pt = this.worldToPx(att.x, att.y);
        ctx.fillStyle = '#0891b2';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // Active stroke draft (with LIVE MIRROR X preview)
    if (this.draftPoints.length > 0) {
      ctx.save();
      ctx.strokeStyle = '#0891b2';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i < this.draftPoints.length; i++) {
        const pt = this.gridToPx(this.draftPoints[i].gx, this.draftPoints[i].gy);
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      if (!state.lassoMode && this.hoverGrid) {
        const hp = this.gridToPx(this.hoverGrid.gx, this.hoverGrid.gy);
        ctx.lineTo(hp.x, hp.y);
      }
      ctx.stroke();

      for (const dp of this.draftPoints) {
        const pt = this.gridToPx(dp.gx, dp.gy);
        ctx.fillStyle = '#22d3ee';
        ctx.fillRect(pt.x - 3, pt.y - 3, 6, 6);
      }

      if (state.mirrorX) {
        ctx.strokeStyle = '#0891b2';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        for (let i = 0; i < this.draftPoints.length; i++) {
          const pt = this.gridToPx(state.gridRes - this.draftPoints[i].gx, this.draftPoints[i].gy);
          if (i === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        }
        if (!state.lassoMode && this.hoverGrid) {
          const hpM = this.gridToPx(state.gridRes - this.hoverGrid.gx, this.hoverGrid.gy);
          ctx.lineTo(hpM.x, hpM.y);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        for (const dp of this.draftPoints) {
          const pt = this.gridToPx(state.gridRes - dp.gx, dp.gy);
          ctx.fillStyle = '#22d3ee';
          ctx.fillRect(pt.x - 2.5, pt.y - 2.5, 5, 5);
        }
      }
      ctx.restore();
    }

    if (this.hoverGrid && (state.sketchTool !== 'edit' || (this.shiftDown && this.hoverEdge))) {
      const hp = this.gridToPx(this.hoverGrid.gx, this.hoverGrid.gy);
      ctx.strokeStyle = '#000000';
      ctx.fillStyle = '#22d3ee';
      ctx.lineWidth = 1.5;
      ctx.fillRect(hp.x - 4, hp.y - 4, 8, 8);
      ctx.strokeRect(hp.x - 4, hp.y - 4, 8, 8);

      if (state.mirrorX && state.sketchTool !== 'edit') {
        const hpM = this.gridToPx(state.gridRes - this.hoverGrid.gx, this.hoverGrid.gy);
        ctx.fillStyle = 'rgba(34, 211, 238, 0.75)';
        ctx.fillRect(hpM.x - 3.5, hpM.y - 3.5, 7, 7);
        ctx.strokeRect(hpM.x - 3.5, hpM.y - 3.5, 7, 7);
      }
    }

    // Subtle zoom/pan HUD at top-right of 2D sketch pane (clear of bottom-left Layers panel)
    ctx.save();
    ctx.font = 'bold 10px monospace';
    const zTxt = `ZOOM ${Math.round(this.zoom * 100)}%  |  WHEEL: ZOOM  R-DRAG/SPACE+DRAG: PAN  [R] FIT`;
    const zW = ctx.measureText(zTxt).width + 12;
    ctx.fillStyle = 'rgba(0,0,0,0.82)';
    ctx.fillRect(w - zW - 8, 8, zW, 17);
    ctx.fillStyle = '#22d3ee';
    ctx.fillText(zTxt, w - zW - 2, 20);
    ctx.restore();
  }
}
