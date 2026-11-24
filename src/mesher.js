// Grid-Snapped Constrained Delaunay Mesher, Hinged Flaps, Area Extrusions & WASM Poisson Inflator

import { wasmBridge } from './wasm-bridge.js';

export function gridToWorld(gx, gy, gridRes) {
  return {
    x: (gx / gridRes) * 2 - 1,
    y: 1 - (gy / gridRes) * 2,
  };
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a * 0.5;
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function distToSegSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return (px - ax) ** 2 + (py - ay) ** 2;
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

function distToPolyBoundary(x, y, poly) {
  let minSq = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dSq = distToSegSq(x, y, a.x, a.y, b.x, b.y);
    if (dSq < minSq) minSq = dSq;
  }
  return Math.sqrt(minSq);
}

function segIntersect(a, b, c, d) {
  const rX = b.x - a.x, rY = b.y - a.y;
  const sX = d.x - c.x, sY = d.y - c.y;
  const denom = rX * sY - rY * sX;
  if (Math.abs(denom) < 1e-9) return null;
  const qpx = c.x - a.x, qpy = c.y - a.y;
  const t = (qpx * sY - qpy * sX) / denom;
  const u = (qpx * rY - qpy * rX) / denom;
  if (t >= -1e-4 && t <= 1 + 1e-4 && u >= -1e-4 && u <= 1 + 1e-4) {
    return {
      t: Math.max(0, Math.min(1, t)),
      u: Math.max(0, Math.min(1, u)),
      x: a.x + t * rX,
      y: a.y + t * rY,
    };
  }
  return null;
}

function findParentContaining(pts, parentPolys) {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= Math.max(1, pts.length);
  cy /= Math.max(1, pts.length);
  for (let i = 0; i < parentPolys.length; i++) {
    if (pointInPoly(cx, cy, parentPolys[i])) return i;
  }
  for (let i = 0; i < parentPolys.length; i++) {
    for (const p of pts) {
      if (pointInPoly(p.x, p.y, parentPolys[i])) return i;
    }
  }
  return -1;
}

function pointInOrNearPoly(x, y, poly, tol = 1e-3) {
  if (pointInPoly(x, y, poly)) return true;
  return distToPolyBoundary(x, y, poly) <= tol;
}

function resolveFlapPolygon(flapPts, parentPolys) {
  if (flapPts.length < 3) return null;

  const p0 = flapPts[0];
  const pn = flapPts[flapPts.length - 1];

  // Check if drawn start or end point is inserted inside or snapped onto a parent polygon
  let p0Parent = -1;
  let pnParent = -1;
  for (let i = 0; i < parentPolys.length; i++) {
    if (p0Parent < 0 && pointInOrNearPoly(p0.x, p0.y, parentPolys[i], 0.02)) p0Parent = i;
    if (pnParent < 0 && pointInOrNearPoly(pn.x, pn.y, parentPolys[i], 0.02)) pnParent = i;
  }

  // Inserted flap (ears / arms / hair / flappy ears starting/ending inside or on parent):
  // Keep the EXACT drawn endpoints p0 and pn and treat ONLY the 1 chord p0 <-> pn as the hinge line!
  if (p0Parent >= 0 || pnParent >= 0) {
    const parentIdx = p0Parent >= 0 ? p0Parent : pnParent;
    const poly = flapPts.map((p, idx) => ({
      x: p.x,
      y: p.y,
      hinge: idx === 0 || idx === flapPts.length - 1,
      hingeEnd: idx === 0 || idx === flapPts.length - 1,
    }));
    for (let k = 1; k <= 3; k++) {
      const t = k / 4;
      poly.push({
        x: pn.x + (p0.x - pn.x) * t,
        y: pn.y + (p0.y - pn.y) * t,
        hinge: true,
        hingeEnd: false,
      });
    }
    if (Math.abs(signedArea(poly)) > 1e-4) {
      if (signedArea(poly) < 0) poly.reverse();
      return {
        poly,
        hingeSeg: { ax: p0.x, ay: p0.y, bx: pn.x, by: pn.y },
        attachments: [{ x: p0.x, y: p0.y }, { x: pn.x, y: pn.y }],
        parentIdx,
      };
    }
  }

  // Fallback Case A: Neither endpoint inside parent, but stroke crosses parent boundary >= 2 times
  let bestParentIdx = -1;
  let hits = [];
  for (let pIdx = 0; pIdx < parentPolys.length; pIdx++) {
    const pPoly = parentPolys[pIdx];
    const curHits = [];
    for (let i = 0; i < flapPts.length - 1; i++) {
      const a = flapPts[i];
      const b = flapPts[i + 1];
      for (let j = 0; j < pPoly.length; j++) {
        const c = pPoly[j];
        const d = pPoly[(j + 1) % pPoly.length];
        const hit = segIntersect(a, b, c, d);
        if (hit) {
          curHits.push({
            x: hit.x,
            y: hit.y,
            order: i + hit.t,
          });
        }
      }
    }
    if (curHits.length >= 2) {
      bestParentIdx = pIdx;
      hits = curHits.sort((A, B) => A.order - B.order);
      break;
    }
  }

  if (bestParentIdx >= 0 && hits.length >= 2) {
    const cleanHits = [];
    for (const h of hits) {
      if (cleanHits.length === 0 || Math.hypot(h.x - cleanHits[cleanHits.length - 1].x, h.y - cleanHits[cleanHits.length - 1].y) > 0.02) {
        cleanHits.push(h);
      }
    }
    if (cleanHits.length >= 2) {
      const h0 = cleanHits[0];
      const h1 = cleanHits[cleanHits.length - 1];
      const outArc = [{ x: h0.x, y: h0.y, hinge: true, hingeEnd: true }];
      for (let i = Math.floor(h0.order) + 1; i <= Math.floor(h1.order); i++) {
        if (i >= 0 && i < flapPts.length) {
          outArc.push({ x: flapPts[i].x, y: flapPts[i].y, hinge: false, hingeEnd: false });
        }
      }
      outArc.push({ x: h1.x, y: h1.y, hinge: true, hingeEnd: true });

      for (let k = 1; k <= 3; k++) {
        const t = k / 4;
        outArc.push({
          x: h1.x + (h0.x - h1.x) * t,
          y: h1.y + (h0.y - h1.y) * t,
          hinge: true,
          hingeEnd: false,
        });
      }

      if (Math.abs(signedArea(outArc)) > 1e-4) {
        if (signedArea(outArc) < 0) outArc.reverse();
        return {
          poly: outArc,
          hingeSeg: { ax: h0.x, ay: h0.y, bx: h1.x, by: h1.y },
          attachments: [{ x: h0.x, y: h0.y }, { x: h1.x, y: h1.y }],
          parentIdx: bestParentIdx,
        };
      }
    }
  }

  // Case B: Detached / levitating flap or overlapping open U-flap
  const poly = flapPts.map((p, idx) => ({
    x: p.x,
    y: p.y,
    hinge: idx === 0 || idx === flapPts.length - 1,
    hingeEnd: idx === 0 || idx === flapPts.length - 1,
  }));
  for (let k = 1; k <= 3; k++) {
    const t = k / 4;
    poly.push({
      x: pn.x + (p0.x - pn.x) * t,
      y: pn.y + (p0.y - pn.y) * t,
      hinge: true,
      hingeEnd: false,
    });
  }

  if (Math.abs(signedArea(poly)) < 1e-4) return null;
  if (signedArea(poly) < 0) poly.reverse();

  const insideParent = findParentContaining(poly, parentPolys);
  const attachments = insideParent >= 0
    ? [{ x: p0.x, y: p0.y }, { x: pn.x, y: pn.y }]
    : [];

  return {
    poly,
    hingeSeg: { ax: p0.x, ay: p0.y, bx: pn.x, by: pn.y },
    attachments,
    parentIdx: insideParent,
  };
}

function cleanPolygon(rawPts, closed = true) {
  const out = [];
  for (const p of rawPts) {
    if (out.length === 0 || Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) > 1e-4) {
      out.push({ x: p.x, y: p.y, hinge: !!p.hinge, hingeEnd: !!p.hingeEnd });
    }
  }
  if (closed && out.length > 2) {
    if (Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-4) {
      out.pop();
    }
  }
  return out;
}

// Uncross accidental self-intersecting lasso loops via 2-opt segment swap so ear clipping stays 100% manifold
function untangleClosedPolygon(poly) {
  if (poly.length < 4) return poly;
  const pts = poly.map((p) => ({ ...p }));
  const n = pts.length;
  const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const cross = (a, b, c, d) => {
    const o1 = orient(a, b, c);
    const o2 = orient(a, b, d);
    const o3 = orient(c, d, a);
    const o4 = orient(c, d, b);
    return ((o1 > 1e-8 && o2 < -1e-8) || (o1 < -1e-8 && o2 > 1e-8)) &&
           ((o3 > 1e-8 && o4 < -1e-8) || (o3 < -1e-8 && o4 > 1e-8));
  };

  for (let pass = 0; pass < n * 2; pass++) {
    let swapped = false;
    for (let i = 0; i < n; i++) {
      const iNext = (i + 1) % n;
      for (let j = i + 2; j < n; j++) {
        const jNext = (j + 1) % n;
        if (jNext === i) continue;
        if (cross(pts[i], pts[iNext], pts[j], pts[jNext])) {
          // Reverse arc [iNext .. j]
          let l = iNext, r = j;
          while (l < r) {
            const tmp = pts[l];
            pts[l] = pts[r];
            pts[r] = tmp;
            l++;
            r--;
          }
          swapped = true;
          break;
        }
      }
      if (swapped) break;
    }
    if (!swapped) break;
  }
  return pts;
}

function subdivideBoundary(poly, maxSegLen) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    out.push({ x: a.x, y: a.y, hinge: !!a.hinge, hingeEnd: !!a.hingeEnd, boundary: true });
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.round(len / maxSegLen));
    if (steps >= 2 && len > maxSegLen * 1.15) {
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        out.push({
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          hinge: !!(a.hinge && b.hinge),
          hingeEnd: false,
          boundary: true,
        });
      }
    }
  }
  return out;
}

// Guaranteed-Watertight X-Symmetrical Constrained Delaunay Triangulation:
// 1. Ear-clip CCW boundary -> exact (nBnd - 2) manifold triangles (ZERO holes!)
// 2. Place X-symmetrical interior Steiner points sized to the polygon area
// 3. Insert each point by exact triangle/edge split
// 4. Lawson edge-flip non-boundary edges using symmetric isotropic triangle quality
function triangulatePolygon(boundaryPoly, stepSize) {
  const nBnd = boundaryPoly.length;
  if (nBnd < 3) return { pts: [], tris: [], nBnd: 0 };

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of boundaryPoly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const pts = boundaryPoly.map((p) => ({
    x: p.x,
    y: p.y,
    hinge: !!p.hinge,
    hingeEnd: !!p.hingeEnd,
    boundary: true,
  }));

  const orient = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);

  const triQuality = (ia, ib, ic) => {
    const a = pts[ia], b = pts[ib], c = pts[ic];
    const area2 = orient(a, b, c);
    if (area2 <= 1e-11) return -1;
    const l0 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const l1 = (c.x - b.x) ** 2 + (c.y - b.y) ** 2;
    const l2 = (a.x - c.x) ** 2 + (a.y - c.y) ** 2;
    const sum = l0 + l1 + l2;
    return sum > 1e-12 ? (3.4641016 * area2) / sum : -1;
  };

  // --- STEP 1: Quality-Aware Watertight Ear Clipping ---
  const tris = [];
  const rem = Array.from({ length: nBnd }, (_, idx) => idx);
  let guard = 0;
  const maxGuard = nBnd * nBnd + 200;

  while (rem.length > 3 && guard++ < maxGuard) {
    let bestK = -1;
    let bestQ = -2;

    for (let k = 0; k < rem.length; k++) {
      const i0 = rem[(k - 1 + rem.length) % rem.length];
      const i1 = rem[k];
      const i2 = rem[(k + 1) % rem.length];
      const a = pts[i0], b = pts[i1], c = pts[i2];
      const area2 = orient(a, b, c);
      if (area2 <= 1e-10) continue;

      let hasInside = false;
      for (let m = 0; m < rem.length; m++) {
        const im = rem[m];
        if (im === i0 || im === i1 || im === i2) continue;
        const pm = pts[im];
        const o1 = orient(a, b, pm);
        const o2 = orient(b, c, pm);
        const o3 = orient(c, a, pm);
        if (o1 >= -1e-9 && o2 >= -1e-9 && o3 >= -1e-9) {
          hasInside = true;
          break;
        }
      }
      if (!hasInside) {
        const q = triQuality(i0, i1, i2);
        if (q > bestQ) {
          bestQ = q;
          bestK = k;
        }
      }
    }

    // Fallback for near-degenerate collinear/pinched ears so no cavity is ever dropped
    if (bestK < 0) {
      for (let k = 0; k < rem.length; k++) {
        const i0 = rem[(k - 1 + rem.length) % rem.length];
        const i1 = rem[k];
        const i2 = rem[(k + 1) % rem.length];
        if (orient(pts[i0], pts[i1], pts[i2]) >= -1e-7) {
          bestK = k;
          break;
        }
      }
      if (bestK < 0) bestK = 0;
    }

    const i0 = rem[(bestK - 1 + rem.length) % rem.length];
    const i1 = rem[bestK];
    const i2 = rem[(bestK + 1) % rem.length];
    if (orient(pts[i0], pts[i1], pts[i2]) < 0) {
      tris.push([i0, i2, i1]);
    } else {
      tris.push([i0, i1, i2]);
    }
    rem.splice(bestK, 1);
  }

  if (rem.length === 3) {
    if (orient(pts[rem[0]], pts[rem[1]], pts[rem[2]]) < 0) {
      tris.push([rem[0], rem[2], rem[1]]);
    } else {
      tris.push([rem[0], rem[1], rem[2]]);
    }
  }

  if (tris.length === 0) return { pts, tris: [], nBnd };

  // --- STEP 2: Generate X-Symmetrical Interior Steiner Points ---
  const isNearOriginSym = Math.abs(minX + maxX) < 0.12 && minX < -0.02 && maxX > 0.02;
  const symX = isNearOriginSym ? 0.0 : (minX + maxX) * 0.5;
  const midY = (minY + maxY) * 0.5;
  const rowH = stepSize * 0.866;
  const clearance = stepSize * 0.38;

  const steinerCandidates = [];
  const halfSpanY = (maxY - minY) * 0.5;
  const halfSpanX = Math.max(Math.abs(maxX - symX), Math.abs(symX - minX));
  const maxRow = Math.ceil(halfSpanY / rowH);
  const maxCol = Math.ceil(halfSpanX / stepSize) + 1;

  for (let ry = -maxRow; ry <= maxRow; ry++) {
    const y = midY + ry * rowH;
    if (y <= minY + clearance * 0.5 || y >= maxY - clearance * 0.5) continue;
    const isOddRow = Math.abs(ry) % 2 === 1;
    if (!isOddRow) {
      if (pointInPoly(symX, y, boundaryPoly) && distToPolyBoundary(symX, y, boundaryPoly) > clearance) {
        steinerCandidates.push({ x: symX, y });
      }
      for (let kx = 1; kx <= maxCol; kx++) {
        const xl = symX - kx * stepSize;
        const xr = symX + kx * stepSize;
        if (pointInPoly(xl, y, boundaryPoly) && distToPolyBoundary(xl, y, boundaryPoly) > clearance) {
          steinerCandidates.push({ x: xl, y });
        }
        if (pointInPoly(xr, y, boundaryPoly) && distToPolyBoundary(xr, y, boundaryPoly) > clearance) {
          steinerCandidates.push({ x: xr, y });
        }
      }
    } else {
      for (let kx = 0; kx <= maxCol; kx++) {
        const offset = (kx + 0.5) * stepSize;
        const xl = symX - offset;
        const xr = symX + offset;
        if (pointInPoly(xl, y, boundaryPoly) && distToPolyBoundary(xl, y, boundaryPoly) > clearance) {
          steinerCandidates.push({ x: xl, y });
        }
        if (pointInPoly(xr, y, boundaryPoly) && distToPolyBoundary(xr, y, boundaryPoly) > clearance) {
          steinerCandidates.push({ x: xr, y });
        }
      }
    }
  }

  // Fallback for small/narrow regions: ensure at least 1 interior dome vertex
  if (steinerCandidates.length === 0) {
    let cx = 0, cy = 0;
    for (const p of boundaryPoly) { cx += p.x; cy += p.y; }
    cx /= nBnd;
    cy /= nBnd;
    if (pointInPoly(cx, cy, boundaryPoly)) {
      steinerCandidates.push({ x: cx, y: cy });
    }
  }

  // --- STEP 3: Insert Each Steiner Point by Exact Triangle/Edge Split ---
  const lockedEdge = new Set();
  const edgeKey = (u, v) => (u < v ? `${u}_${v}` : `${v}_${u}`);
  for (let i = 0; i < nBnd; i++) {
    lockedEdge.add(edgeKey(i, (i + 1) % nBnd));
  }

  for (const sp of steinerCandidates) {
    let hitTriIdx = -1;
    let onEdge = null;

    for (let ti = 0; ti < tris.length; ti++) {
      const [ia, ib, ic] = tris[ti];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      const area2 = orient(a, b, c);
      if (area2 <= 1e-11) continue;
      const o0 = orient(a, b, sp) / area2;
      const o1 = orient(b, c, sp) / area2;
      const o2 = orient(c, a, sp) / area2;
      if (o0 >= -1e-6 && o1 >= -1e-6 && o2 >= -1e-6) {
        hitTriIdx = ti;
        if (o0 < 1e-5) onEdge = [ia, ib];
        else if (o1 < 1e-5) onEdge = [ib, ic];
        else if (o2 < 1e-5) onEdge = [ic, ia];
        break;
      }
    }
    if (hitTriIdx < 0) continue;

    // Skip if right on top of an existing vertex
    const [ha, hb, hc] = tris[hitTriIdx];
    const minDistV = Math.min(
      Math.hypot(sp.x - pts[ha].x, sp.y - pts[ha].y),
      Math.hypot(sp.x - pts[hb].x, sp.y - pts[hb].y),
      Math.hypot(sp.x - pts[hc].x, sp.y - pts[hc].y)
    );
    if (minDistV < 1e-4) continue;

    const newIdx = pts.length;
    pts.push({ x: sp.x, y: sp.y, hinge: false, hingeEnd: false, boundary: false });

    if (onEdge) {
      const [eu, ev] = onEdge;
      if (lockedEdge.has(edgeKey(eu, ev))) {
        // Don't split locked boundary edge; nudge slightly inside triangle center
        pts.pop();
        continue;
      }
      // Find opposite triangle sharing (eu, ev)
      let otherIdx = -1;
      for (let tj = 0; tj < tris.length; tj++) {
        if (tj === hitTriIdx) continue;
        const t = tris[tj];
        if (t.includes(eu) && t.includes(ev)) { otherIdx = tj; break; }
      }
      if (otherIdx >= 0) {
        const opp1 = tris[hitTriIdx].find((v) => v !== eu && v !== ev);
        const opp2 = tris[otherIdx].find((v) => v !== eu && v !== ev);
        // Ensure CCW order on both quads: (eu, ev, opp1) or (ev, eu, opp1)
        const dir1 = orient(pts[eu], pts[ev], pts[opp1]) > 0;
        if (dir1) {
          tris[hitTriIdx] = [eu, newIdx, opp1];
          tris[otherIdx] = [ev, opp1, newIdx];
          tris.push([ev, newIdx, opp2], [eu, opp2, newIdx]);
        } else {
          tris[hitTriIdx] = [ev, newIdx, opp1];
          tris[otherIdx] = [eu, opp1, newIdx];
          tris.push([eu, newIdx, opp2], [ev, opp2, newIdx]);
        }
        continue;
      }
    }

    tris[hitTriIdx] = [ha, hb, newIdx];
    tris.push([hb, hc, newIdx], [hc, ha, newIdx]);
  }

  // --- STEP 4: Constrained Symmetrical Lawson Edge Flipping ---
  for (let pass = 0; pass < 14; pass++) {
    const edgeTris = new Map();
    for (let ti = 0; ti < tris.length; ti++) {
      const [a, b, c] = tris[ti];
      const pairs = [[a, b, c], [b, c, a], [c, a, b]];
      for (const [u, v, opp] of pairs) {
        const key = edgeKey(u, v);
        if (lockedEdge.has(key)) continue;
        let arr = edgeTris.get(key);
        if (!arr) { arr = []; edgeTris.set(key, arr); }
        arr.push({ ti, u, v, opp });
      }
    }

    let flipped = 0;
    const touchedTri = new Set();
    for (const [, refs] of edgeTris.entries()) {
      if (refs.length !== 2) continue;
      const r0 = refs[0], r1 = refs[1];
      if (touchedTri.has(r0.ti) || touchedTri.has(r1.ti)) continue;

      const u = r0.u, v = r0.v;
      const oppA = r0.opp;
      const oppB = r1.opp;
      if (oppA === oppB) continue;

      // Ensure oppA, oppB make a strictly convex quad: diagonal (oppA, oppB) separates u and v
      const pu = pts[u], pv = pts[v], pa = pts[oppA], pb = pts[oppB];
      const s1 = orient(pa, pb, pu);
      const s2 = orient(pa, pb, pv);
      if (s1 * s2 >= -1e-10) continue;

      // Build properly oriented candidate flipped triangles
      const f0 = s1 > 0 ? [pa, pb, pu] : [pb, pa, pu];
      const f1 = s2 > 0 ? [pa, pb, pv] : [pb, pa, pv];
      const fi0 = s1 > 0 ? [oppA, oppB, u] : [oppB, oppA, u];
      const fi1 = s2 > 0 ? [oppA, oppB, v] : [oppB, oppA, v];
      if (orient(f0[0], f0[1], f0[2]) <= 1e-10 || orient(f1[0], f1[1], f1[2]) <= 1e-10) continue;

      const qOld = Math.min(triQuality(u, v, oppA), triQuality(r1.u, r1.v, oppB));
      const qNew = Math.min(triQuality(fi0[0], fi0[1], fi0[2]), triQuality(fi1[0], fi1[1], fi1[2]));

      if (qNew > qOld + 1e-4) {
        tris[r0.ti] = fi0;
        tris[r1.ti] = fi1;
        touchedTri.add(r0.ti);
        touchedTri.add(r1.ti);
        flipped++;
      }
    }
    if (flipped === 0) break;
  }

  return { pts, tris, nBnd };
}

// Procedural Shape Analyzer: classifies part into 'head' | 'body' | 'limb' | 'flap' from proportions
function analyzePartRole(stroke, poly, parentReg, hingeSeg) {
  const n = poly.length;
  let cx = 0, cy = 0, perim = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    cx += a.x;
    cy += a.y;
    perim += Math.hypot(b.x - a.x, b.y - a.y);
  }
  cx /= Math.max(1, n);
  cy /= Math.max(1, n);

  const area = Math.abs(signedArea(poly));
  const compactness = (4 * Math.PI * area) / Math.max(1e-6, perim * perim);

  // Oriented bounding box (2x2 covariance PCA)
  let cxx = 0, cxy = 0, cyy = 0;
  for (const p of poly) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    cxx += dx * dx;
    cxy += dx * dy;
    cyy += dy * dy;
  }
  const trace = cxx + cyy;
  const diff = cxx - cyy;
  const disc = Math.sqrt(diff * diff + 4 * cxy * cxy);
  const theta = Math.abs(cxy) < 1e-8 && Math.abs(diff) < 1e-8 ? 0 : 0.5 * Math.atan2(2 * cxy, diff);
  let ux = Math.cos(theta);
  let uy = Math.sin(theta);
  if (trace < 1e-8) { ux = 0; uy = 1; }
  // Orient uAxis consistently upward/along bone (prefer +Y so vAxis = (uy, -ux) points +X when uAxis = (0,1))
  if (uy < -0.25 || (Math.abs(uy) <= 0.25 && ux < 0)) {
    ux = -ux;
    uy = -uy;
  }
  const vx = uy;
  const vy = -ux;

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of poly) {
    const u = p.x * ux + p.y * uy;
    const v = p.x * vx + p.y * vy;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const majorSpan = Math.max(1e-4, maxU - minU);
  const minorSpan = Math.max(1e-4, maxV - minV);
  const aspectRatio = majorSpan / minorSpan;

  let autoRole = 'body';
  if (stroke.type === 'flap') {
    if (aspectRatio >= 1.80 && minorSpan < 0.42) {
      autoRole = 'limb';
    } else {
      autoRole = 'flap';
    }
  } else if (aspectRatio >= 1.95 && minorSpan < 0.46) {
    autoRole = 'limb';
  } else if (compactness >= 0.62 && aspectRatio < 1.65 && (cy > 0.0 || (!parentReg && area < 0.72))) {
    autoRole = 'head';
  } else {
    autoRole = 'body';
  }

  const explicit = stroke.partRole && stroke.partRole !== 'auto' ? stroke.partRole : null;
  const role = explicit || autoRole;

  // Snap nearly-vertical body/head axes cleanly to world Y=(0,1), X=(1,0) for crisp symmetrical rings
  let finalU = { x: ux, y: uy };
  let finalV = { x: vx, y: vy };
  if ((role === 'body' || role === 'head') && (Math.abs(uy) >= 0.60 || aspectRatio < 1.45)) {
    finalU = { x: 0, y: 1 };
    finalV = { x: 1, y: 0 };
  } else if (role === 'flap' && hingeSeg) {
    const hx = hingeSeg.bx - hingeSeg.ax;
    const hy = hingeSeg.by - hingeSeg.ay;
    const hLen = Math.hypot(hx, hy);
    if (hLen > 1e-4) {
      // Orient v along hinge line, u perpendicular into flap
      let fuX = -hy / hLen, fuY = hx / hLen;
      const midHX = (hingeSeg.ax + hingeSeg.bx) * 0.5;
      const midHY = (hingeSeg.ay + hingeSeg.by) * 0.5;
      if ((cx - midHX) * fuX + (cy - midHY) * fuY < 0) {
        fuX = -fuX;
        fuY = -fuY;
      }
      finalU = { x: fuX, y: fuY };
      finalV = { x: fuY, y: -fuX };
    }
  }

  return {
    role,
    autoRole,
    area,
    compactness,
    aspectRatio,
    majorSpan,
    minorSpan,
    cx,
    cy,
    uAxis: finalU,
    vAxis: finalV,
  };
}

// Logical Structured Quad-Strip / Tubular Slice Mesher:
// Produces hand-crafted PS1 / Blockbench topology (clean rings + center face/chest plate or limb spine)
// whenever the polygon is strictly monotone along its structural flow axis.
function triangulateStructuredSlices(poly, analysis, lowPolyDetail) {
  const n = poly.length;
  if (n < 3) return null;

  const { uAxis, vAxis, role, majorSpan, minorSpan } = analysis;
  const toUV = (p) => ({
    u: p.x * uAxis.x + p.y * uAxis.y,
    v: p.x * vAxis.x + p.y * vAxis.y,
    hinge: !!p.hinge,
    hingeEnd: !!p.hingeEnd,
  });
  const toXY = (u, v, extra = {}) => ({
    x: u * uAxis.x + v * vAxis.x,
    y: u * uAxis.y + v * vAxis.y,
    ...extra,
  });

  const uvPoly = poly.map(toUV);

  // Collect & cluster vertex u-levels so every corner sits cleanly on a slice ring
  const sortedU = uvPoly.map((p) => p.u).sort((a, b) => a - b);
  const rawLevels = [];
  for (const u of sortedU) {
    if (rawLevels.length === 0 || u - rawLevels[rawLevels.length - 1] > 1e-3) {
      rawLevels.push(u);
    }
  }
  if (rawLevels.length < 2) return null;

  // Verify strict 2-crossing monotonicity across every slice interval
  const crossingsAt = (uVal) => {
    const vs = [];
    for (let i = 0; i < n; i++) {
      const a = uvPoly[i];
      const b = uvPoly[(i + 1) % n];
      if ((a.u <= uVal && b.u > uVal) || (b.u <= uVal && a.u > uVal)) {
        const t = (uVal - a.u) / (b.u - a.u);
        vs.push(a.v + t * (b.v - a.v));
      }
    }
    vs.sort((x, y) => x - y);
    return vs;
  };

  for (let k = 0; k < rawLevels.length - 1; k++) {
    const uMid = (rawLevels[k] + rawLevels[k + 1]) * 0.5;
    if (crossingsAt(uMid).length !== 2) return null;
  }

  // Subdivide tall spans cleanly proportional to lowPolyDetail
  const targetRings = Math.max(2, Math.round(lowPolyDetail * (role === 'limb' ? 0.65 : 0.72)));
  const maxStep = Math.max(0.10, majorSpan / targetRings);
  const uLevels = [rawLevels[0]];
  for (let k = 0; k < rawLevels.length - 1; k++) {
    const u0 = rawLevels[k];
    const u1 = rawLevels[k + 1];
    const du = u1 - u0;
    const sub = Math.max(1, Math.round(du / maxStep));
    for (let s = 1; s < sub; s++) {
      uLevels.push(u0 + (du * s) / sub);
    }
    uLevels.push(u1);
  }

  // Decide cross-section column pattern:
  // 4-col [L, M_L, M_R, R] -> flat chest/face bevel (hexagonal tube); 3-col [L, M, R] -> crisp ridge
  const useBevelCols = (role === 'body' || role === 'head')
    ? (lowPolyDetail >= 4)
    : (role === 'limb' && lowPolyDetail >= 6 && minorSpan >= 0.14);

  // Helper to check if a point (x,y) lies on a hinge edge of the original polygon
  const hingeEdges = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if (a.hinge && b.hinge) hingeEdges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
  }
  const matchHingeFlags = (x, y) => {
    let hinge = false;
    let hingeEnd = false;
    for (const p of poly) {
      if (p.hinge && Math.hypot(p.x - x, p.y - y) < 8e-3) {
        hinge = true;
        if (p.hingeEnd) hingeEnd = true;
      }
    }
    if (!hinge) {
      for (const he of hingeEdges) {
        if (distToSegSq(x, y, he.ax, he.ay, he.bx, he.by) < 6e-5) {
          hinge = true;
          break;
        }
      }
    }
    return { hinge, hingeEnd };
  };

  // Sample exact [vL, vR] at each slice u_k
  const slices = [];
  for (let k = 0; k < uLevels.length; k++) {
    const uk = uLevels[k];
    const onLevelVs = [];
    for (const p of uvPoly) {
      if (Math.abs(p.u - uk) <= 1.2e-3) onLevelVs.push(p.v);
    }
    const edgeVs = [];
    for (let i = 0; i < n; i++) {
      const a = uvPoly[i];
      const b = uvPoly[(i + 1) % n];
      const minU = Math.min(a.u, b.u);
      const maxU = Math.max(a.u, b.u);
      if (minU < uk - 1.2e-3 && maxU > uk + 1.2e-3) {
        const t = (uk - a.u) / (b.u - a.u);
        edgeVs.push(a.v + t * (b.v - a.v));
      }
    }
    const allVs = [...onLevelVs, ...edgeVs];
    if (allVs.length === 0) return null;
    const vL = Math.min(...allVs);
    const vR = Math.max(...allVs);
    const width = vR - vL;

    if (width < 1e-3) {
      // Pointed apex tip vertex (single point on boundary)
      const vm = 0.5 * (vL + vR);
      const xy = toXY(uk, vm);
      const hf = matchHingeFlags(xy.x, xy.y);
      slices.push({ u: uk, isTip: true, L: { ...xy, ...hf, boundary: true, latS: 0 }, R: null, mids: [] });
    } else {
      const xyL = toXY(uk, vL);
      const xyR = toXY(uk, vR);
      const hfL = matchHingeFlags(xyL.x, xyL.y);
      const hfR = matchHingeFlags(xyR.x, xyR.y);

      // Include any extra interior boundary corners strictly on horizontal top/bottom caps
      let mids = [];
      const isCap = (k === 0 || k === uLevels.length - 1);
      if (isCap) {
        const innerCorners = onLevelVs
          .filter((v) => v > vL + 1e-3 && v < vR - 1e-3)
          .sort((a, b) => a - b);
        const dedupInner = [];
        for (const v of innerCorners) {
          if (dedupInner.length === 0 || v - dedupInner[dedupInner.length - 1] > 1e-3) {
            dedupInner.push(v);
          }
        }
        if (dedupInner.length > 0) {
          mids = dedupInner.map((v) => {
            const xy = toXY(uk, v);
            return { ...xy, ...matchHingeFlags(xy.x, xy.y), boundary: true, latS: ((v - vL) / width) * 2 - 1 };
          });
        } else if (useBevelCols) {
          const vML = vL + width * 0.28;
          const vMR = vL + width * 0.72;
          const xyML = toXY(uk, vML);
          const xyMR = toXY(uk, vMR);
          mids = [
            { ...xyML, ...matchHingeFlags(xyML.x, xyML.y), boundary: true, latS: -0.44 },
            { ...xyMR, ...matchHingeFlags(xyMR.x, xyMR.y), boundary: true, latS: 0.44 },
          ];
        } else {
          const vm = 0.5 * (vL + vR);
          const xyM = toXY(uk, vm);
          mids = [{ ...xyM, ...matchHingeFlags(xyM.x, xyM.y), boundary: true, latS: 0 }];
        }
      } else if (useBevelCols) {
        const vML = vL + width * 0.28;
        const vMR = vL + width * 0.72;
        const xyML = toXY(uk, vML);
        const xyMR = toXY(uk, vMR);
        mids = [
          { ...xyML, hinge: false, hingeEnd: false, boundary: false, latS: -0.44 },
          { ...xyMR, hinge: false, hingeEnd: false, boundary: false, latS: 0.44 },
        ];
      } else {
        const vm = 0.5 * (vL + vR);
        const xyM = toXY(uk, vm);
        mids = [{ ...xyM, hinge: false, hingeEnd: false, boundary: false, latS: 0 }];
      }

      slices.push({
        u: uk,
        isTip: false,
        L: { ...xyL, ...hfL, boundary: true, latS: -1 },
        R: { ...xyR, ...hfR, boundary: true, latS: 1 },
        mids,
      });
    }
  }

  // Assemble pts[] with all CCW outer boundary points FIRST [0..nBnd-1], then interior points!
  const pts = [];
  const rowIndices = slices.map(() => []);

  // 1. Bottom cap (left -> right)
  const s0 = slices[0];
  if (s0.isTip) {
    const idx = pts.length;
    pts.push(s0.L);
    rowIndices[0] = [idx];
  } else {
    const idxL = pts.length;
    pts.push(s0.L);
    rowIndices[0].push(idxL);
    for (const m of s0.mids) {
      const idxM = pts.length;
      pts.push(m);
      rowIndices[0].push(idxM);
    }
    const idxR = pts.length;
    pts.push(s0.R);
    rowIndices[0].push(idxR);
  }

  // 2. Right wall going up (1 .. S-2)
  const rightBoundaryIdx = new Int32Array(slices.length);
  for (let k = 1; k < slices.length - 1; k++) {
    const idxR = pts.length;
    pts.push(slices[k].R);
    rightBoundaryIdx[k] = idxR;
  }

  // 3. Top cap (right -> left)
  const sLast = slices[slices.length - 1];
  const topRowReversed = [];
  if (sLast.isTip) {
    const idx = pts.length;
    pts.push(sLast.L);
    rowIndices[slices.length - 1] = [idx];
  } else {
    const idxR = pts.length;
    pts.push(sLast.R);
    topRowReversed.push(idxR);
    for (let m = sLast.mids.length - 1; m >= 0; m--) {
      const idxM = pts.length;
      pts.push(sLast.mids[m]);
      topRowReversed.push(idxM);
    }
    const idxL = pts.length;
    pts.push(sLast.L);
    topRowReversed.push(idxL);
    rowIndices[slices.length - 1] = topRowReversed.reverse();
  }

  // 4. Left wall going down (S-2 .. 1)
  const leftBoundaryIdx = new Int32Array(slices.length);
  for (let k = slices.length - 2; k >= 1; k--) {
    const idxL = pts.length;
    pts.push(slices[k].L);
    leftBoundaryIdx[k] = idxL;
  }

  const nBnd = pts.length;

  // 5. Interior spine vertices for slices (1 .. S-2)
  for (let k = 1; k < slices.length - 1; k++) {
    const row = [leftBoundaryIdx[k]];
    for (const m of slices[k].mids) {
      const idxM = pts.length;
      pts.push(m);
      row.push(idxM);
    }
    row.push(rightBoundaryIdx[k]);
    rowIndices[k] = row;
  }

  // Build symmetrical CCW triangles between every pair of consecutive slice rows
  const tris = [];
  const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const pushTri = (ia, ib, ic) => {
    const o = orient(pts[ia], pts[ib], pts[ic]);
    if (Math.abs(o) <= 1e-11) return;
    if (o > 0) tris.push([ia, ib, ic]);
    else tris.push([ia, ic, ib]);
  };

  for (let k = 0; k < rowIndices.length - 1; k++) {
    const rA = rowIndices[k];
    const rB = rowIndices[k + 1];
    const nA = rA.length;
    const nB = rB.length;

    if (nA === 1 && nB >= 2) {
      for (let j = 0; j < nB - 1; j++) pushTri(rA[0], rB[j + 1], rB[j]);
    } else if (nB === 1 && nA >= 2) {
      for (let i = 0; i < nA - 1; i++) pushTri(rA[i], rA[i + 1], rB[0]);
    } else if (nA === nB) {
      const cols = nA - 1;
      for (let c = 0; c < cols; c++) {
        // Mirror diagonal split on left vs right halves so topology is 100% left-right symmetric!
        const leftHalf = c < cols * 0.5;
        if (leftHalf) {
          pushTri(rA[c], rA[c + 1], rB[c + 1]);
          pushTri(rA[c], rB[c + 1], rB[c]);
        } else {
          pushTri(rA[c], rA[c + 1], rB[c]);
          pushTri(rA[c + 1], rB[c + 1], rB[c]);
        }
      }
    } else {
      // Zipper transition when cap corner count differs from interior column count
      let i = 0, j = 0;
      while (i < nA - 1 || j < nB - 1) {
        if (i === nA - 1) {
          pushTri(rA[i], rB[j + 1], rB[j]);
          j++;
        } else if (j === nB - 1) {
          pushTri(rA[i], rA[i + 1], rB[j]);
          i++;
        } else {
          const fracA = (i + 1) / (nA - 1);
          const fracB = (j + 1) / (nB - 1);
          if (fracA <= fracB) {
            pushTri(rA[i], rA[i + 1], rB[j]);
            i++;
          } else {
            pushTri(rA[i], rB[j + 1], rB[j]);
            j++;
          }
        }
      }
    }
  }

  return tris.length > 0 ? { pts, tris, nBnd } : null;
}

function buildLaplacianCSR(vertCount, tris, pts) {
  const edgeMap = Array.from({ length: vertCount }, () => new Map());

  const addWeight = (u, v, w) => {
    edgeMap[u].set(v, (edgeMap[u].get(v) || 0) + w);
    edgeMap[v].set(u, (edgeMap[v].get(u) || 0) + w);
  };

  for (const [ia, ib, ic] of tris) {
    const a = pts[ia], b = pts[ib], c = pts[ic];
    const cotAngle = (p, q, r) => {
      const ux = q.x - p.x, uy = q.y - p.y;
      const vx = r.x - p.x, vy = r.y - p.y;
      const dot = ux * vx + uy * vy;
      const cross = Math.abs(ux * vy - uy * vx);
      if (cross < 1e-8) return 0.1;
      return Math.max(0.08, dot / cross);
    };

    addWeight(ib, ic, 0.5 * cotAngle(a, b, c));
    addWeight(ic, ia, 0.5 * cotAngle(b, c, a));
    addWeight(ia, ib, 0.5 * cotAngle(c, a, b));
  }

  const adjOff = new Int32Array(vertCount + 1);
  let totalEdges = 0;
  for (let i = 0; i < vertCount; i++) {
    adjOff[i] = totalEdges;
    totalEdges += edgeMap[i].size;
  }
  adjOff[vertCount] = totalEdges;

  const adjIdx = new Int32Array(totalEdges);
  const adjW = new Float32Array(totalEdges);
  let cursor = 0;
  for (let i = 0; i < vertCount; i++) {
    for (const [nbr, w] of edgeMap[i].entries()) {
      adjIdx[cursor] = nbr;
      adjW[cursor] = w;
      cursor++;
    }
  }

  return { adjOff, adjIdx, adjW };
}

function sampleParentHeight(x, y, parentRegion) {
  if (!parentRegion) return 0;
  const { pts, tris, zHeights } = parentRegion;
  for (const [ia, ib, ic] of tris) {
    const a = pts[ia], b = pts[ib], c = pts[ic];
    const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(det) < 1e-10) continue;
    const l1 = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / det;
    const l2 = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / det;
    const l3 = 1 - l1 - l2;
    if (l1 >= -0.02 && l2 >= -0.02 && l3 >= -0.02) {
      return Math.max(0, l1 * zHeights[ia] + l2 * zHeights[ib] + l3 * zHeights[ic]);
    }
  }
  return 0;
}

export function buildMeshFromStrokes(strokes, options) {
  const { gridRes, meshMode, lowPolyDetail = 6, depth, roundness, hingeFlex = 0.65 } = options;
  const visibleStrokes = strokes.filter((s) => s.visible !== false && s.points.length >= 2);
  if (visibleStrokes.length === 0) return null;

  const isLowPoly = meshMode === 'lowpoly';
  const stepSize = isLowPoly
    ? 2.0 / Math.max(2, lowPolyDetail)
    : 2.0 / Math.max(12, Math.round(gridRes * 0.9));

  const closedWorldPolys = [];
  const closedRegionRefs = [];
  const regionDataList = [];
  const allAttachments = [];

  const ordered = [
    ...visibleStrokes.filter((s) => s.type === 'closed'),
    ...visibleStrokes.filter((s) => s.type === 'flap' || s.type === 'extrude'),
  ];

  for (const stroke of ordered) {
    const rawWorld = stroke.points.map((p) => gridToWorld(p.gx, p.gy, gridRes));
    let polyInfo = null;

    if (stroke.type === 'closed') {
      let cleaned = untangleClosedPolygon(cleanPolygon(rawWorld, true));
      if (cleaned.length < 3 || Math.abs(signedArea(cleaned)) < 1e-4) continue;
      if (signedArea(cleaned) < 0) cleaned.reverse();
      polyInfo = { poly: cleaned, attachments: [], parentIdx: -1 };
      closedWorldPolys.push(cleaned);
    } else if (stroke.type === 'extrude') {
      let cleaned = untangleClosedPolygon(cleanPolygon(rawWorld, true));
      if (cleaned.length < 3 || Math.abs(signedArea(cleaned)) < 1e-4) continue;
      if (signedArea(cleaned) < 0) cleaned.reverse();
      const parentIdx = findParentContaining(cleaned, closedWorldPolys);
      polyInfo = { poly: cleaned, attachments: [], parentIdx };
    } else {
      const cleanedOpen = cleanPolygon(rawWorld, false);
      polyInfo = resolveFlapPolygon(cleanedOpen, closedWorldPolys);
      if (!polyInfo) continue;
      for (const att of polyInfo.attachments) allAttachments.push(att);
    }

    const parentReg = polyInfo.parentIdx >= 0 ? closedRegionRefs[polyInfo.parentIdx] : null;
    const analysis = analyzePartRole(stroke, polyInfo.poly, parentReg, polyInfo.hingeSeg || null);
    const role = analysis.role;

    // Size-aware step sizing: larger shapes get proportionally more symmetrical triangles
    const polyArea = analysis.area;
    const shapeSpan = Math.sqrt(Math.max(0.01, polyArea));
    const targetCells = Math.max(2.0, lowPolyDetail * (0.45 + 0.65 * shapeSpan));
    const localStep = isLowPoly
      ? Math.max(0.075, Math.min(0.45, (shapeSpan * 1.35) / targetCells))
      : stepSize;

    // Prefer structured quad-strip / tubular slice topology in LOW POLY (and for elongated limbs)
    let triResult = null;
    if (isLowPoly || role === 'limb') {
      const sliceDetail = isLowPoly ? lowPolyDetail : Math.max(8, Math.round(gridRes * 0.45));
      triResult = triangulateStructuredSlices(polyInfo.poly, analysis, sliceDetail);
    }
    if (!triResult) {
      const edgeSubdivLimit = localStep * (isLowPoly ? 1.45 : 1.15);
      const subdiv = subdivideBoundary(polyInfo.poly, edgeSubdivLimit);
      triResult = triangulatePolygon(subdiv, localStep);
    }

    const { pts, tris, nBnd } = triResult;
    if (tris.length === 0) continue;

    const partDepth = stroke.partDepth ?? stroke.depthBoost ?? 1.0;
    const partPuff = stroke.partPuff ?? 1.0;
    const effectiveRound = Math.max(0.18, roundness / Math.max(0.35, partPuff));
    const isFlap = stroke.type === 'flap';
    const attachFrac = isFlap ? Math.max(0, Math.min(1, (stroke.flapAttach ?? 0) / 100)) : 1.0;

    if (isFlap && polyInfo.hingeSeg) {
      const hs = polyInfo.hingeSeg;
      let maxHingeDist = 1e-5;
      for (const p of pts) {
        const d = p.hinge ? 0 : Math.sqrt(distToSegSq(p.x, p.y, hs.ax, hs.ay, hs.bx, hs.by));
        p.hingeDist = d;
        if (d > maxHingeDist) maxHingeDist = d;
      }
      for (const p of pts) {
        p.hingeFrac = p.hinge ? 0 : (p.hingeDist / maxHingeDist);
        p.attached = !!parentReg && (p.hinge || (attachFrac > 0.001 && p.hingeFrac <= attachFrac + 1e-4));
      }
    } else {
      for (const p of pts) {
        p.hingeFrac = 0;
        p.attached = !!parentReg;
      }
    }

    const { adjOff, adjIdx, adjW } = buildLaplacianCSR(pts.length, tris, pts);
    const flags = new Int32Array(pts.length);
    const initZ = new Float32Array(pts.length);

    const avgEdge = stepSize;
    const sourceC = (avgEdge * avgEdge) * 2.2;
    const sideMode = stroke.type === 'closed' ? 'sym' : (stroke.flapSide || 'sym');

    for (let i = 0; i < pts.length; i++) {
      if (pts[i].boundary) {
        if (isFlap && parentReg && sideMode === 'sym' && pts[i].hinge && !pts[i].hingeEnd) {
          flags[i] = 0;
        } else {
          flags[i] = 1;
        }
      }
    }

    const rawZ = wasmBridge.solvePoisson(pts.length, adjOff, adjIdx, adjW, flags, initZ, sourceC, 1.38, isLowPoly ? 45 : 90);

    let maxZ = 1e-5;
    for (let i = 0; i < rawZ.length; i++) {
      if (rawZ[i] > maxZ) maxZ = rawZ[i];
    }

    const zHeights = new Float32Array(pts.length);
    const zNorms = new Float32Array(pts.length);
    const puffScale = isFlap ? (0.72 + 0.28 * partPuff) : 1.0;

    // Shape-Role-Aware Z Depth Scaling:
    // - 'limb' scales Z depth proportionally to its cross-section radius (minorSpan * 0.55) so arms/legs stay tubular!
    // - 'body' & 'head' use crisp beveled plate depth.
    let roleDepth = depth;
    if (role === 'limb') {
      const idealTubeRadius = Math.max(0.05, Math.min(depth * 1.15, analysis.minorSpan * 0.54 * (depth / 0.34)));
      roleDepth = idealTubeRadius;
    } else if (role === 'head') {
      roleDepth = depth * 1.06;
    }
    const regionDepth = roleDepth * partDepth * (isFlap && role !== 'limb' ? 0.85 : 1.0) * puffScale;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      let norm = Math.max(0, rawZ[i] / maxZ);
      if (typeof p.latS === 'number' && !p.boundary) {
        // Blend structured lateral cross-section bevel for crisp PS1/chibi plates & cylindrical limbs
        const absS = Math.min(1, Math.abs(p.latS));
        const bevelVal = role === 'limb'
          ? Math.sqrt(Math.max(0.08, 1.0 - absS * absS * 0.82))
          : (absS <= 0.50 ? 0.94 : Math.max(0.05, (1.0 - absS) / 0.50));
        norm = norm * 0.35 + bevelVal * 0.65 * Math.min(1.0, Math.pow(norm + 0.08, 0.35));
      }
      zNorms[i] = norm;
      const shaped = Math.pow(norm, effectiveRound);
      zHeights[i] = shaped * regionDepth;
    }

    const rcx = analysis.cx;
    const rcy = analysis.cy;

    const regObj = {
      stroke,
      role,
      autoRole: analysis.autoRole,
      pts,
      nBnd,
      tris,
      zHeights,
      zNorms,
      cx: rcx,
      cy: rcy,
      parentReg,
      sideMode,
      attachFrac,
      hingeSeg: polyInfo.hingeSeg || null,
      simIndices: [],
      hingeSimIndices: [],
    };

    if (stroke.type === 'closed') closedRegionRefs.push(regObj);
    regionDataList.push(regObj);
  }

  if (regionDataList.length === 0) return null;

  const simPosArr = [];
  const simRegionId = [];
  const simTris = [];

  const renPosArr = [];
  const renUvArr = [];
  const renIdxArr = [];
  const renToSim = [];
  const regionMeta = [];

  for (let rIdx = 0; rIdx < regionDataList.length; rIdx++) {
    const reg = regionDataList[rIdx];
    const { stroke, pts, nBnd, tris, zHeights, zNorms, cx, cy, parentReg, sideMode } = reg;
    const isFlap = stroke.type === 'flap';
    const isExtrude = stroke.type === 'extrude';

    const frontSimMap = new Int32Array(pts.length);
    const backSimMap = new Int32Array(pts.length);
    const frontRenMap = new Int32Array(pts.length);
    const backRenMap = new Int32Array(pts.length);
    const wallBackRenMap = new Int32Array(nBnd).fill(-1);

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const baseParentZ = parentReg ? sampleParentHeight(p.x, p.y, parentReg) : 0;

      let zFront = 0, zBack = 0;
      let sharedSeam = false;

      if (isExtrude) {
        const offset = zHeights[i];
        if (sideMode === 'back') {
          zFront = -baseParentZ * 0.9;
          zBack = -(baseParentZ + offset);
          if (zBack > zFront) { const tmp = zFront; zFront = zBack; zBack = tmp; }
        } else {
          zFront = Math.max(-baseParentZ * 0.75, baseParentZ + offset);
          zBack = baseParentZ * 0.85;
          if (zFront < zBack) {
            zBack = Math.min(zFront - 0.005, baseParentZ * 0.1);
          }
        }
        sharedSeam = p.boundary;
      } else if (isFlap && parentReg && sideMode !== 'sym') {
        // Attached Front/Back Flap: hinge / attached % embeds into parent surface while free hanging flap clears parent!
        const lift = p.hinge ? 0.006 : (p.boundary ? 0.010 : 0.018);
        if (sideMode === 'front') {
          if (baseParentZ > 0.002) {
            zFront = baseParentZ + Math.max(0, zHeights[i]) + (p.attached ? lift : 0.022);
            zBack = p.attached ? Math.max(0, baseParentZ - 0.016) : (baseParentZ + 0.010);
            sharedSeam = false;
          } else if (p.boundary) {
            zFront = 0;
            zBack = 0;
            sharedSeam = true;
          } else {
            zFront = Math.max(0, zHeights[i]) + lift;
            zBack = -Math.max(0, zHeights[i]) * 0.4;
            sharedSeam = false;
          }
        } else {
          if (baseParentZ > 0.002) {
            zBack = -(baseParentZ + Math.max(0, zHeights[i]) + (p.attached ? lift : 0.022));
            zFront = p.attached ? -Math.max(0, baseParentZ - 0.016) : -(baseParentZ + 0.010);
            sharedSeam = false;
          } else if (p.boundary) {
            zFront = 0;
            zBack = 0;
            sharedSeam = true;
          } else {
            zBack = -(Math.max(0, zHeights[i]) + lift);
            zFront = Math.max(0, zHeights[i]) * 0.4;
            sharedSeam = false;
          }
        }
      } else {
        // Symmetric double-sided volume (CLOSED body, attached SYM flap, or any DETACHED levitating flap)
        let absZ = Math.abs(zHeights[i]);
        if (isFlap && parentReg && p.hinge && baseParentZ > 0.004) {
          absZ = Math.min(absZ, Math.max(0.025, baseParentZ * 0.85));
        }
        zFront = absZ;
        zBack = -absZ;
        sharedSeam = p.boundary && !(isFlap && parentReg && sideMode === 'sym' && p.hinge && !p.hingeEnd);
      }

      // Exact 1:1 Isotropic UV Projection in 2:1 Atlas (Front left [0..0.5], Back right [0.5..1.0])
      // Matches the 2D grid sketch cutaway vertex-for-vertex without outward rim expansion
      const ux = Math.max(-1.0, Math.min(1.0, p.x));
      const uy = Math.max(-1.0, Math.min(1.0, p.y));
      const uFront = 0.02 + ((ux + 1) * 0.5) * 0.46;
      const uBack = 0.52 + ((1 - ux) * 0.5) * 0.46;
      const vCoord = 0.04 + ((uy + 1) * 0.5) * 0.92;

      const isAttachVert = isFlap ? !!p.attached : (isExtrude ? (p.boundary || baseParentZ > 0.002) : false);

      if (sharedSeam) {
        const sIdx = simPosArr.length / 3;
        const zMid = (zFront + zBack) * 0.5;
        simPosArr.push(p.x, p.y, zMid);
        simRegionId.push(rIdx);
        reg.simIndices.push(sIdx);
        if (isAttachVert) reg.hingeSimIndices.push(sIdx);
        frontSimMap[i] = sIdx;
        backSimMap[i] = sIdx;

        const rf = renPosArr.length / 3;
        renPosArr.push(p.x, p.y, zMid);
        renUvArr.push(uFront, vCoord);
        renToSim.push(sIdx);
        frontRenMap[i] = rf;

        const rb = renPosArr.length / 3;
        renPosArr.push(p.x, p.y, zMid);
        renUvArr.push(uBack, vCoord);
        renToSim.push(sIdx);
        backRenMap[i] = rb;
      } else {
        const sf = simPosArr.length / 3;
        simPosArr.push(p.x, p.y, zFront);
        simRegionId.push(rIdx);
        reg.simIndices.push(sf);
        if (isAttachVert) reg.hingeSimIndices.push(sf);
        frontSimMap[i] = sf;

        const rf = renPosArr.length / 3;
        renPosArr.push(p.x, p.y, zFront);
        renUvArr.push(uFront, vCoord);
        renToSim.push(sf);
        frontRenMap[i] = rf;

        const sb = simPosArr.length / 3;
        simPosArr.push(p.x, p.y, zBack);
        simRegionId.push(rIdx);
        reg.simIndices.push(sb);
        if (isAttachVert) reg.hingeSimIndices.push(sb);
        backSimMap[i] = sb;

        const rb = renPosArr.length / 3;
        renPosArr.push(p.x, p.y, zBack);
        renUvArr.push(uBack, vCoord);
        renToSim.push(sb);
        backRenMap[i] = rb;

        if (i < nBnd) {
          const rw = renPosArr.length / 3;
          renPosArr.push(p.x, p.y, zBack);
          renUvArr.push(sideMode === 'back' ? uBack : uFront, vCoord);
          renToSim.push(sb);
          wallBackRenMap[i] = rw;
        }
      }
    }

    const triStart = renIdxArr.length;
    for (const [ia, ib, ic] of tris) {
      renIdxArr.push(frontRenMap[ia], frontRenMap[ib], frontRenMap[ic]);
      simTris.push([frontSimMap[ia], frontSimMap[ib], frontSimMap[ic]]);

      renIdxArr.push(backRenMap[ia], backRenMap[ic], backRenMap[ib]);
      simTris.push([backSimMap[ia], backSimMap[ic], backSimMap[ib]]);
    }

    // Watertight side-wall enclosure along any non-shared boundary edge (seals front/back flaps & swollen hinge roots!)
    for (let u = 0; u < nBnd; u++) {
      const v = (u + 1) % nBnd;
      const sfU = frontSimMap[u], sbU = backSimMap[u];
      const sfV = frontSimMap[v], sbV = backSimMap[v];
      if (sfU === sbU && sfV === sbV) continue;

      const topU = (sideMode === 'back' && sfU === sbU) ? backRenMap[u] : frontRenMap[u];
      const topV = (sideMode === 'back' && sfV === sbV) ? backRenMap[v] : frontRenMap[v];
      const botU = (sfU === sbU) ? topU : wallBackRenMap[u];
      const botV = (sfV === sbV) ? topV : wallBackRenMap[v];

      if (sfU !== sbU && sfV !== sbV) {
        renIdxArr.push(topU, botU, botV);
        renIdxArr.push(topU, botV, topV);
        simTris.push([sfU, sbU, sbV], [sfU, sbV, sfV]);
      } else if (sfU === sbU && sfV !== sbV) {
        renIdxArr.push(topU, botV, topV);
        simTris.push([sfU, sbV, sfV]);
      } else if (sfU !== sbU && sfV === sbV) {
        renIdxArr.push(topU, botU, botV);
        simTris.push([sfU, sbU, sbV]);
      }
    }

    regionMeta.push({
      strokeId: stroke.id,
      color: stroke.color,
      role: reg.role,
      autoRole: reg.autoRole,
      triStart,
      triCount: (renIdxArr.length - triStart) / 3,
      poly: reg.pts,
      tris2D: reg.tris,
      sideMode,
    });
  }

  const simVertCount = simPosArr.length / 3;
  const simRestPos = new Float32Array(simPosArr);

  const simPts = [];
  for (let i = 0; i < simVertCount; i++) {
    simPts.push({
      x: simRestPos[i * 3],
      y: simRestPos[i * 3 + 1],
      z: simRestPos[i * 3 + 2],
    });
  }

  const edgeMaps = Array.from({ length: simVertCount }, () => new Map());
  const addSimEdge = (u, v, w) => {
    if (u === v) return;
    edgeMaps[u].set(v, (edgeMaps[u].get(v) || 0) + w);
    edgeMaps[v].set(u, (edgeMaps[v].get(u) || 0) + w);
  };

  for (const [ia, ib, ic] of simTris) {
    addSimEdge(ia, ib, 1.0);
    addSimEdge(ib, ic, 1.0);
    addSimEdge(ic, ia, 1.0);
  }

  // Front-to-back bracing within same region
  for (let i = 0; i < simVertCount; i++) {
    const p = simPts[i];
    let bestSame = -1, bestSameD = Infinity;
    for (let j = 0; j < simVertCount; j++) {
      if (i === j || simRegionId[i] !== simRegionId[j]) continue;
      const q = simPts[j];
      const dXY = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (p.z * q.z < -1e-5 && dXY < 1e-4 && Math.abs(p.z - q.z) < bestSameD) {
        bestSameD = Math.abs(p.z - q.z);
        bestSame = j;
      }
    }
    if (bestSame >= 0) addSimEdge(i, bestSame, 1.6);
  }

  // Hinge-line & percentage stitching from Flap/Extrude to Parent region:
  // - Flaps at 0% attach ONLY on their single hinge line (pivoting freely with tension transfer!)
  // - Increasing flapAttach (0%..100%) expands attachment outward from the hinge line across the flap.
  for (const reg of regionDataList) {
    if (!reg.parentReg || reg.parentReg.simIndices.length === 0) continue;
    const parentIndices = reg.parentReg.simIndices;
    const isFlap = reg.stroke.type === 'flap';
    const attachTargets = reg.hingeSimIndices;
    if (attachTargets.length === 0) continue;

    const kCount = isFlap ? (1 + Math.round(reg.attachFrac * 2)) : 3;
    const flexMul = 1.65 - 1.15 * Math.max(0, Math.min(1, hingeFlex));
    const stitchWeight = (isFlap ? (1.5 + reg.attachFrac * 3.0) : 4.5) * flexMul;
    const maxDistSq = isFlap ? Math.pow(0.32 + reg.attachFrac * 0.28, 2) : 0.60 * 0.60;

    for (const sIdx of attachTargets) {
      const p = simPts[sIdx];
      const nearest = [];
      for (const pIdx of parentIndices) {
        const q = simPts[pIdx];
        const d3 = (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2;
        if (nearest.length < kCount) {
          nearest.push({ pIdx, d3 });
          nearest.sort((a, b) => a.d3 - b.d3);
        } else if (d3 < nearest[kCount - 1].d3) {
          nearest[kCount - 1] = { pIdx, d3 };
          nearest.sort((a, b) => a.d3 - b.d3);
        }
      }
      if (nearest.length > 0 && nearest[0].d3 >= maxDistSq) {
        addSimEdge(sIdx, nearest[0].pIdx, stitchWeight);
      } else {
        for (const n of nearest) {
          if (n.d3 < maxDistSq) {
            addSimEdge(sIdx, n.pIdx, stitchWeight);
          }
        }
      }
    }
  }

  // Fallback proximity stitch ONLY between overlapping CLOSED body regions (e.g. Chibi Head <-> Torso),
  // NEVER between free flaps and the body!
  for (let i = 0; i < simVertCount; i++) {
    const regI = regionDataList[simRegionId[i]];
    if (!regI || regI.stroke.type !== 'closed') continue;
    const p = simPts[i];
    let bestCross = -1, bestCrossD = 0.22 * 0.22;
    for (let j = 0; j < simVertCount; j++) {
      if (simRegionId[i] === simRegionId[j]) continue;
      const regJ = regionDataList[simRegionId[j]];
      if (!regJ || regJ.stroke.type !== 'closed') continue;
      const q = simPts[j];
      const d3 = (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2;
      if (d3 < bestCrossD) {
        bestCrossD = d3;
        bestCross = j;
      }
    }
    if (bestCross >= 0) addSimEdge(i, bestCross, 3.0);
  }

  const adjOff = new Int32Array(simVertCount + 1);
  let totalAdj = 0;
  for (let i = 0; i < simVertCount; i++) {
    adjOff[i] = totalAdj;
    totalAdj += edgeMaps[i].size;
  }
  adjOff[simVertCount] = totalAdj;

  const adjIdx = new Int32Array(totalAdj);
  const adjW = new Float32Array(totalAdj);
  let ptr = 0;
  for (let i = 0; i < simVertCount; i++) {
    for (const [nbr, w] of edgeMaps[i].entries()) {
      adjIdx[ptr] = nbr;
      adjW[ptr] = w;
      ptr++;
    }
  }

  wasmBridge.uploadSimMesh(simVertCount, adjOff, adjIdx, adjW, simRestPos);

  return {
    simVertCount,
    simRestPos,
    simRegionId: new Int32Array(simRegionId),
    renVertCount: renPosArr.length / 3,
    renPos: new Float32Array(renPosArr),
    renUv: new Float32Array(renUvArr),
    renIndices: new Uint32Array(renIdxArr),
    renToSim: new Int32Array(renToSim),
    attachments: allAttachments,
    regionMeta,
  };
}
