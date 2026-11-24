// PNG / Image Alpha Contour Auto-Tracer, Pixel-Art Clamper & Dual-View UV Projector
// Pure JS zero-dependency pipeline:
//   1. Crops & downscales huge uploaded images to crisp clamped pixel art (32/64/128/256px)
//   2. Extracts clean closed contours from alpha channel via Marching Squares
//   3. Collapses straight runs & grid staircases via Circular RDP + collinear pruning
//   4. Projects clamped pixel art onto Front & Back 1:1 UV halves with silhouette edge bleed

const TRACE_PALETTE = [
  '#d97724', '#e09f5a', '#4f46e5', '#0891b2',
  '#be185d', '#65a30d', '#f59e0b', '#7c3aed',
];

function pointLineDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-8) return Math.hypot(px - ax, py - ay);
  return Math.abs((px - ax) * dy - (py - ay) * dx) / len;
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a * 0.5;
}

function gridPolygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.gx * q.gy - q.gx * p.gy;
  }
  return a * 0.5;
}

function rdpOpen(pts, eps) {
  if (pts.length <= 2) return pts;
  const a = pts[0];
  const b = pts[pts.length - 1];
  let maxDist = -1;
  let split = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointLineDist(pts[i].x, pts[i].y, a.x, a.y, b.x, b.y);
    if (d > maxDist) {
      maxDist = d;
      split = i;
    }
  }
  if (maxDist > eps && split > 0) {
    const left = rdpOpen(pts.slice(0, split + 1), eps);
    const right = rdpOpen(pts.slice(split), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

// Split closed loop at the most prominent corner (farthest from centroid) and opposite vertex
function rdpClosedLoop(pts, eps) {
  const n = pts.length;
  if (n <= 4) return pts.slice();

  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= n;
  cy /= n;

  let i0 = 0, maxR = -1;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(pts[i].x - cx, pts[i].y - cy);
    if (d > maxR) { maxR = d; i0 = i; }
  }

  const ordered = [];
  for (let k = 0; k < n; k++) ordered.push(pts[(i0 + k) % n]);

  let i1 = Math.floor(n / 2), maxD = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(ordered[i].x - ordered[0].x, ordered[i].y - ordered[0].y);
    if (d > maxD) { maxD = d; i1 = i; }
  }
  if (i1 <= 1 || i1 >= n - 1) i1 = Math.max(1, Math.floor(n / 2));

  const half1 = rdpOpen(ordered.slice(0, i1 + 1), eps);
  const half2 = rdpOpen(ordered.slice(i1).concat([ordered[0]]), eps);
  return half1.slice(0, -1).concat(half2.slice(0, -1));
}

/**
 * Marching Squares closed-contour extractor on an integer alpha mask `mask` (Uint8Array of 0/1, size w x h).
 * Pure mathematical helper (can run in Node tests or Browser).
 */
export function extractAlphaContours(mask, w, h, minArea = 6) {
  const pw = w + 2;
  const ph = h + 2;
  const grid = new Uint8Array(pw * ph);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      grid[(y + 1) * pw + (x + 1)] = mask[y * w + x] ? 1 : 0;
    }
  }

  // Dual grid vertices live at integer coordinates (gx, gy) where edge midpoints lie on half-integers.
  // Encode half-integer points in 2x integer space (kx = x*2, ky = y*2) for exact Map matching.
  const keyOf = (kx, ky) => `${kx},${ky}`;
  const adj = new Map();
  const addSeg = (ax, ay, bx, by) => {
    const ak = keyOf(ax, ay);
    const bk = keyOf(bx, by);
    if (ak === bk) return;
    if (!adj.has(ak)) adj.set(ak, []);
    adj.get(ak).push([bx, by]);
  };

  // Edge midpoints in 2x space around dual cell (x, y):
  // Top: (2x+1, 2y), Right: (2x+2, 2y+1), Bottom: (2x+1, 2y+2), Left: (2x, 2y+1)
  for (let y = 0; y < ph - 1; y++) {
    for (let x = 0; x < pw - 1; x++) {
      const tl = grid[y * pw + x];
      const tr = grid[y * pw + (x + 1)];
      const br = grid[(y + 1) * pw + (x + 1)];
      const bl = grid[(y + 1) * pw + x];
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (code === 0 || code === 15) continue;

      const tx = 2 * x + 1, ty = 2 * y;
      const rx = 2 * x + 2, ry = 2 * y + 1;
      const bx = 2 * x + 1, by = 2 * y + 2;
      const lx = 2 * x,     ly = 2 * y + 1;

      // Directed edges keep solid interior on the RIGHT in screen coords (+Y down -> positive shoelace area for outer CCWs? wait: standard screen coords outer loop walks CW around solid)
      switch (code) {
        case 1:  addSeg(lx, ly, bx, by); break;
        case 2:  addSeg(bx, by, rx, ry); break;
        case 3:  addSeg(lx, ly, rx, ry); break;
        case 4:  addSeg(rx, ry, tx, ty); break;
        case 5:  addSeg(lx, ly, tx, ty); addSeg(rx, ry, bx, by); break;
        case 6:  addSeg(bx, by, tx, ty); break;
        case 7:  addSeg(lx, ly, tx, ty); break;
        case 8:  addSeg(tx, ty, lx, ly); break;
        case 9:  addSeg(tx, ty, bx, by); break;
        case 10: addSeg(tx, ty, rx, ry); addSeg(bx, by, lx, ly); break;
        case 11: addSeg(tx, ty, rx, ry); break;
        case 12: addSeg(rx, ry, lx, ly); break;
        case 13: addSeg(rx, ry, bx, by); break;
        case 14: addSeg(bx, by, lx, ly); break;
      }
    }
  }

  const loops = [];
  for (const [startKey, nextList] of adj.entries()) {
    while (nextList.length > 0) {
      const [sxStr, syStr] = startKey.split(',');
      let cx = Number(sxStr);
      let cy = Number(syStr);
      const pts = [{ x: (cx - 2) * 0.5, y: (cy - 2) * 0.5 }];

      let guard = 0;
      const maxSteps = pw * ph * 4;
      while (guard++ < maxSteps) {
        const curKey = keyOf(cx, cy);
        const list = adj.get(curKey);
        if (!list || list.length === 0) break;
        const [nx, ny] = list.pop();
        if (nx === Number(sxStr) && ny === Number(syStr)) break;
        cx = nx;
        cy = ny;
        pts.push({ x: (cx - 2) * 0.5, y: (cy - 2) * 0.5 });
      }

      if (pts.length >= 3) {
        // Align dual-cell midpoints to pixel boundary space [0..w] x [0..h]
        const aligned = pts.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
        const area = polygonArea(aligned);
        if (Math.abs(area) >= minArea) {
          loops.push({ pts: aligned, area });
        }
      }
    }
  }

  // Outer loops around solid islands have negative signed area in screen Y-down with our edge orientation
  // (Verify sign dynamically by counting winding or returning outer loops first).
  // Wait: let's check case 1 (only BL=1 inside cell (0,0)): edge (0,1)->(1,2) walks down-right.
  // For a 1x1 pixel at (1,1):
  //   (0,0) has BR=1 (code 2): bottom(1,2)->right(2,1)
  //   (1,0) has BL=1 (code 1): left(2,1)->bottom(3,2) ... wait: top-left cell of pixel (1,1) has BR=1 -> (1,2)->(2,1) (up-right),
  //   so path goes: (1,2) -> (2,1) -> (3,2) -> (2,3) -> (1,2) = CW in screen coords (+Y down), so shoelace area > 0!
  const outer = loops.filter((l) => l.area > 0);
  outer.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  return outer;
}

function sharpenChamfers(pts) {
  const n = pts.length;
  if (n < 4) return pts;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n];
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const q = pts[(i + 2) % n];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    if (Math.abs(Math.abs(abx) - 0.5) < 1e-6 && Math.abs(Math.abs(aby) - 0.5) < 1e-6) {
      const pax = a.x - p.x, pay = a.y - p.y;
      const bqx = q.x - b.x, bqy = q.y - b.y;
      const prevHoriz = Math.abs(pay) < 1e-6 && Math.abs(pax) > 0.25;
      const prevVert  = Math.abs(pax) < 1e-6 && Math.abs(pay) > 0.25;
      const nextHoriz = Math.abs(bqy) < 1e-6 && Math.abs(bqx) > 0.25;
      const nextVert  = Math.abs(bqx) < 1e-6 && Math.abs(bqy) > 0.25;
      if (prevHoriz && nextVert) {
        out.push({ x: b.x, y: a.y });
        i++; // skip b
        continue;
      }
      if (prevVert && nextHoriz) {
        out.push({ x: a.x, y: b.y });
        i++; // skip b
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

/**
 * Simplify a contour loop `(x, y)` in `[0..maskW] × [0..maskH]` onto integer `[0..gridRes] × [0..gridRes]`,
 * aggressively collapsing collinear/near-straight line chains into crisp corners.
 */
export function simplifyContourToGrid(rawPts, maskW, maskH, gridRes, straightness = 0.75) {
  if (!rawPts || rawPts.length < 3) return [];

  const sharp = sharpenChamfers(rawPts);
  const scaleX = gridRes / maskW;
  const scaleY = gridRes / maskH;
  const scaled = sharp.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY }));

  // Pass 1: Continuous Circular RDP (removes pixel staircase micro-steps)
  const rdpEps = Math.max(0.18, straightness * 0.52);
  let sim = rdpClosedLoop(scaled, rdpEps);
  if (sim.length < 3) sim = scaled;

  // Pass 2: Snap to grid coordinates
  let gridPts = [];
  for (const p of sim) {
    const gx = Math.max(0, Math.min(gridRes, Math.round(p.x)));
    const gy = Math.max(0, Math.min(gridRes, Math.round(p.y)));
    const prev = gridPts[gridPts.length - 1];
    if (!prev || prev.gx !== gx || prev.gy !== gy) {
      gridPts.push({ gx, gy });
    }
  }
  if (
    gridPts.length > 1 &&
    gridPts[0].gx === gridPts[gridPts.length - 1].gx &&
    gridPts[0].gy === gridPts[gridPts.length - 1].gy
  ) {
    gridPts.pop();
  }
  if (gridPts.length < 3) return [];

  // Pass 3: Iterative post-snap straight-line / near-collinear corner merging
  const lineDistTol = Math.max(0.32, straightness * 0.48);
  const sinAngleTol = Math.min(0.28, straightness * 0.16);
  let changed = true;
  let iter = 0;
  while (changed && gridPts.length > 3 && iter++ < 24) {
    changed = false;
    for (let i = 0; i < gridPts.length && gridPts.length > 3; i++) {
      const n = gridPts.length;
      const a = gridPts[(i - 1 + n) % n];
      const b = gridPts[i];
      const c = gridPts[(i + 1) % n];

      if ((a.gx === c.gx && a.gy === c.gy) || (a.gx === b.gx && a.gy === b.gy) || (b.gx === c.gx && b.gy === c.gy)) {
        gridPts.splice(i, 1);
        changed = true;
        break;
      }

      const d = pointLineDist(b.gx, b.gy, a.gx, a.gy, c.gx, c.gy);
      const abx = b.gx - a.gx, aby = b.gy - a.gy;
      const bcx = c.gx - b.gx, bcy = c.gy - b.gy;
      const lenAB = Math.hypot(abx, aby);
      const lenBC = Math.hypot(bcx, bcy);
      const sinTheta = Math.abs(abx * bcy - aby * bcx) / Math.max(1e-6, lenAB * lenBC);
      const dot = abx * bcx + aby * bcy;

      // Remove intermediate vertex if strictly collinear, within straightness perpendicular tol, or tiny shallow kink
      if (d < 1e-6 || (dot > 0 && (d <= lineDistTol || (sinTheta <= sinAngleTol && d <= 0.85)))) {
        gridPts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }

  if (gridPts.length < 3 || Math.abs(gridPolygonArea(gridPts)) < 1.0) return [];
  return gridPts;
}

/**
 * Compute bounding box of opaque pixels `(alpha >= alphaThresh)` on an RGBA buffer.
 */
export function getOpaqueBounds(rgba, w, h, alphaThresh = 90) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = rgba[(y * w + x) * 4 + 3];
      if (a >= alphaThresh) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Downscale/clamp source image into a square `clampPx × clampPx` pixel-art canvas
 * centered with exact `padFrac` padding matching the 2D sketch grid.
 */
export function buildClampedSquareCanvas(img, opts = {}) {
  const clampPx = Math.max(16, Math.min(512, opts.clampPx ?? 64));
  const gridClamp = Math.max(8, opts.gridClamp ?? 24);
  const padCells = Math.max(0, Math.min(Math.floor(gridClamp * 0.35), opts.padCells ?? 2));
  const alphaThresh = opts.alphaThresh ?? 90;
  const pixelate = opts.pixelate !== false;
  const autoCrop = opts.autoCrop !== false;

  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;

  // Read source (capped to 1024px if gargantuan just for fast opaque bbox scan)
  const scanScale = Math.min(1, 512 / Math.max(1, srcW, srcH));
  const sw = Math.max(1, Math.round(srcW * scanScale));
  const sh = Math.max(1, Math.round(srcH * scanScale));
  const scanCanvas = document.createElement('canvas');
  scanCanvas.width = sw;
  scanCanvas.height = sh;
  const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
  scanCtx.imageSmoothingEnabled = !pixelate;
  scanCtx.drawImage(img, 0, 0, sw, sh);
  const scanData = scanCtx.getImageData(0, 0, sw, sh).data;

  let sx = 0, sy = 0, sBoxW = srcW, sBoxH = srcH;
  if (autoCrop) {
    const bbox = getOpaqueBounds(scanData, sw, sh, alphaThresh);
    if (bbox) {
      sx = Math.max(0, Math.floor(bbox.x / scanScale));
      sy = Math.max(0, Math.floor(bbox.y / scanScale));
      sBoxW = Math.max(1, Math.min(srcW - sx, Math.ceil(bbox.w / scanScale)));
      sBoxH = Math.max(1, Math.min(srcH - sy, Math.ceil(bbox.h / scanScale)));
    }
  }

  const padFrac = padCells / gridClamp;
  const innerSpan = Math.max(4, clampPx * (1 - 2 * padFrac));
  const fitScale = Math.min(innerSpan / sBoxW, innerSpan / sBoxH);
  const dw = Math.max(1, Math.round(sBoxW * fitScale));
  const dh = Math.max(1, Math.round(sBoxH * fitScale));
  const dx = Math.round((clampPx - dw) * 0.5);
  const dy = Math.round((clampPx - dh) * 0.5);

  const out = document.createElement('canvas');
  out.width = clampPx;
  out.height = clampPx;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, clampPx, clampPx);
  ctx.imageSmoothingEnabled = !pixelate;
  ctx.drawImage(img, sx, sy, sBoxW, sBoxH, dx, dy, dw, dh);

  return {
    canvas: out,
    clampPx,
    padFrac,
    srcW,
    srcH,
    cropRect: { sx, sy, sBoxW, sBoxH },
    destRect: { dx, dy, dw, dh },
  };
}

/**
 * Trace clamped square canvas alpha channel into simplified straight-line BODY strokes.
 */
export function traceClampedCanvasToStrokes(clampedCanvas, opts = {}) {
  const gridRes = opts.gridClamp ?? 24;
  const alphaThresh = opts.alphaThresh ?? 90;
  const straightness = opts.simplify ?? 0.75;

  // Use a binary mask up to max(gridRes * 2, clampedCanvas.width) capped at 128 for crisp diagonals & fast walk
  const maskRes = Math.min(128, Math.max(gridRes * 2, clampedCanvas.width));
  const mCanvas = document.createElement('canvas');
  mCanvas.width = maskRes;
  mCanvas.height = maskRes;
  const mCtx = mCanvas.getContext('2d', { willReadFrequently: true });
  mCtx.imageSmoothingEnabled = false;
  mCtx.drawImage(clampedCanvas, 0, 0, maskRes, maskRes);

  const imgData = mCtx.getImageData(0, 0, maskRes, maskRes).data;
  const mask = new Uint8Array(maskRes * maskRes);
  let opaqueCount = 0;
  for (let i = 0; i < maskRes * maskRes; i++) {
    if (imgData[i * 4 + 3] >= alphaThresh) {
      mask[i] = 1;
      opaqueCount++;
    }
  }
  if (opaqueCount === 0) return [];

  const minArea = Math.max(4, opaqueCount * 0.015);
  const contours = extractAlphaContours(mask, maskRes, maskRes, minArea);

  const strokes = [];
  const maxParts = 10;
  for (let i = 0; i < Math.min(maxParts, contours.length); i++) {
    const pts = simplifyContourToGrid(contours[i].pts, maskRes, maskRes, gridRes, straightness);
    if (pts.length < 3) continue;
    const baseName = contours.length === 1 ? 'IMG BODY' : (i === 0 ? 'IMG MAIN' : `IMG PART ${i}`);
    strokes.push({
      id: `str_img_${Date.now()}_${i}`,
      name: baseName,
      type: 'closed',
      flapSide: 'sym',
      flapAttach: 100,
      color: dominantColorFromMask(imgData, mask, maskRes) || TRACE_PALETTE[i % TRACE_PALETTE.length],
      visible: true,
      partDepth: 1.0,
      partPuff: 1.0,
      mirrorPairId: null,
      points: pts,
    });
  }

  return strokes;
}

function dominantColorFromMask(rgba, mask, size) {
  let r = 0, g = 0, b = 0, cnt = 0;
  for (let i = 0; i < size * size; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    r += rgba[o];
    g += rgba[o + 1];
    b += rgba[o + 2];
    cnt++;
  }
  if (!cnt) return null;
  const toHex = (v) => Math.max(0, Math.min(255, Math.round(v / cnt))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Finalizes UV atlas alpha/edges:
 * - alphaMode = true: keeps image alpha transparent (a = 0) outside silhouette so 2D UV & 3D mesh are see-through
 * - alphaMode = false: fills opaque solid wrap with minimal 1px edge bleed and neutral non-outline fill
 */
function finalizeUvAlphaAndEdges(imageData, w, h, alphaThresh = 90, alphaMode = true) {
  const src = imageData.data;
  const total = w * h;

  if (alphaMode) {
    for (let i = 0; i < total; i++) {
      const o = i * 4;
      if (src[o + 3] >= alphaThresh) {
        src[o + 3] = 255;
      } else {
        src[o] = 0;
        src[o + 1] = 0;
        src[o + 2] = 0;
        src[o + 3] = 0;
      }
    }
    return;
  }

  let valid = new Uint8Array(total);
  let rSum = 0, gSum = 0, bSum = 0, count = 0;

  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (src[o + 3] >= alphaThresh) {
      valid[i] = 1;
      src[o + 3] = 255;
      // Exclude very dark outline pixels from background fill average when brighter pixels exist
      if (src[o] + src[o + 1] + src[o + 2] > 60) {
        rSum += src[o];
        gSum += src[o + 1];
        bSum += src[o + 2];
        count++;
      }
    } else {
      src[o + 3] = 0;
    }
  }

  const bgR = count > 0 ? Math.round(rSum / count) : 64;
  const bgG = count > 0 ? Math.round(gSum / count) : 64;
  const bgB = count > 0 ? Math.round(bSum / count) : 64;

  // Minimal 1-texel bleed only so no wide black moat forms around outlines
  const nextValid = new Uint8Array(valid);
  const copy = new Uint8ClampedArray(src);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (valid[idx]) continue;
      let ar = 0, ag = 0, ab = 0, ac = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const ny = y + oy;
        if (ny < 0 || ny >= h) continue;
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;
          const nx = x + ox;
          if (nx < 0 || nx >= w) continue;
          const nIdx = ny * w + nx;
          if (valid[nIdx]) {
            const no = nIdx * 4;
            ar += src[no];
            ag += src[no + 1];
            ab += src[no + 2];
            ac++;
          }
        }
      }
      if (ac > 0) {
        const o = idx * 4;
        copy[o] = Math.round(ar / ac);
        copy[o + 1] = Math.round(ag / ac);
        copy[o + 2] = Math.round(ab / ac);
        copy[o + 3] = 255;
        nextValid[idx] = 1;
      }
    }
  }
  src.set(copy);
  valid = nextValid;

  for (let i = 0; i < total; i++) {
    if (!valid[i]) {
      const o = i * 4;
      src[o] = bgR;
      src[o + 1] = bgG;
      src[o + 2] = bgB;
      src[o + 3] = 255;
    }
  }
}

/**
 * Project clamped square canvas onto BOTH Front & Back UV atlas halves matching mesher.js UV coords:
 *   Front: x = 0.04 * uvRes, y = 0.04 * uvRes, w = 0.92 * uvRes, h = 0.92 * uvRes
 *   Back:  x = 1.04 * uvRes, y = 0.04 * uvRes, w = 0.92 * uvRes, h = 0.92 * uvRes (flipped X if mirrorBack)
 */
export function projectClampedToUvAtlas(uvPainter, clampedCanvas, opts = {}) {
  if (!uvPainter || !clampedCanvas) return;
  const uvRes = opts.uvRes ?? opts.clampPx ?? 64;
  const mirrorBack = opts.mirrorBack !== false;
  const pixelate = opts.pixelate !== false;
  const alphaThresh = opts.alphaThresh ?? 90;
  const alphaMode = opts.alphaMode !== false;

  const W = uvRes * 2;
  const H = uvRes;
  if (uvPainter.texCanvas.width !== W || uvPainter.texCanvas.height !== H) {
    uvPainter.texCanvas.width = W;
    uvPainter.texCanvas.height = H;
  }
  if (uvPainter.texCtx) {
    uvPainter.texCtx.imageSmoothingEnabled = false;
  }

  const temp = document.createElement('canvas');
  temp.width = W;
  temp.height = H;
  const tctx = temp.getContext('2d', { willReadFrequently: true });
  tctx.clearRect(0, 0, W, H);
  tctx.imageSmoothingEnabled = !pixelate;

  const fx = 0.04 * uvRes;
  const fy = 0.04 * uvRes;
  const span = 0.92 * uvRes;
  tctx.drawImage(clampedCanvas, fx, fy, span, span);

  const bx = 1.04 * uvRes;
  const by = 0.04 * uvRes;
  tctx.save();
  if (mirrorBack) {
    tctx.translate(bx + span, by);
    tctx.scale(-1, 1);
    tctx.drawImage(clampedCanvas, 0, 0, span, span);
  } else {
    tctx.drawImage(clampedCanvas, bx, by, span, span);
  }
  tctx.restore();

  const imgData = tctx.getImageData(0, 0, W, H);
  finalizeUvAlphaAndEdges(imgData, W, H, alphaThresh, alphaMode);

  uvPainter.texCtx.imageSmoothingEnabled = false;
  uvPainter.texCtx.putImageData(imgData, 0, 0);
  uvPainter.hasCustomPaint = true;
  uvPainter.uvUndoStack.length = 0;
  uvPainter.uvRedoStack.length = 0;
  uvPainter.syncTexture();
}
