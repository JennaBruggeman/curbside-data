'use strict';
// The build's geometry: UTM zone 10N (EPSG:32610) on WGS84, the 1 km cell grid, line clipping and Douglas-Peucker
// simplification. Everything is computed in UTM metres and written as lon / lat (GeoJSON), 6 decimals (about 0.1 m; the exact layers 7: cells.js).

// ── UTM 10N (Snyder, Map Projections: A Working Manual, pp. 61-64) ─────────────────────────────────────────────────
const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996, E2 = F * (2 - F), EP2 = E2 / (1 - E2), LON0 = -123 * Math.PI / 180;
const M1 = 1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 ** 3 / 256, M2 = 3 * E2 / 8 + 3 * E2 * E2 / 32 + 45 * E2 ** 3 / 1024,
  M3 = 15 * E2 * E2 / 256 + 45 * E2 ** 3 / 1024, M4 = 35 * E2 ** 3 / 3072;
function toUTM(lon, lat) {
  const p = lat * Math.PI / 180, s = Math.sin(p), c = Math.cos(p), t = Math.tan(p);
  const N = A / Math.sqrt(1 - E2 * s * s), T = t * t, C = EP2 * c * c, a = c * (lon * Math.PI / 180 - LON0);
  const M = A * (M1 * p - M2 * Math.sin(2 * p) + M3 * Math.sin(4 * p) - M4 * Math.sin(6 * p));
  const x = K0 * N * (a + (1 - T + C) * a ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * a ** 5 / 120) + 500000;
  const y = K0 * (M + N * t * (a * a / 2 + (5 - T + 9 * C + 4 * C * C) * a ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * a ** 6 / 720));
  return [x, y];
}
const E1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
function fromUTM(x, y) {
  const mu = (y / K0) / (A * M1);
  const p1 = mu + (3 * E1 / 2 - 27 * E1 ** 3 / 32) * Math.sin(2 * mu) + (21 * E1 * E1 / 16 - 55 * E1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * E1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * E1 ** 4 / 512) * Math.sin(8 * mu);
  const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1), C1 = EP2 * c * c, T1 = t * t, N1 = A / Math.sqrt(1 - E2 * s * s);
  const R1 = A * (1 - E2) / Math.pow(1 - E2 * s * s, 1.5), D = (x - 500000) / (N1 * K0);
  const lat = p1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = LON0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / c;
  return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}

// ── The grid ──────────────────────────────────────────────────────────────────────────────────────────────────
// The app's SM.VAN.bbox ('-123.27,49.33,-123.02,49.19': west, north, east, south). Origin: its SW corner in UTM;
// cell {x}_{y} covers origin + [x, x + 1] km east, [y, y + 1] km north. The cell range is every cell the bbox touches.
const BBOX = { west: -123.27, north: 49.33, east: -123.02, south: 49.19 };
const CELL = 1000;
const ORIGIN = toUTM(BBOX.west, BBOX.south).map((v) => Math.floor(v));
const cellOf = (x, y) => [Math.floor((x - ORIGIN[0]) / CELL), Math.floor((y - ORIGIN[1]) / CELL)];
const cellId = (cx, cy) => cx + '_' + cy;
const cellRect = (cx, cy) => [ORIGIN[0] + cx * CELL, ORIGIN[1] + cy * CELL, ORIGIN[0] + (cx + 1) * CELL, ORIGIN[1] + (cy + 1) * CELL];
const RANGE = (() => {
  const cs = [[BBOX.west, BBOX.south], [BBOX.west, BBOX.north], [BBOX.east, BBOX.south], [BBOX.east, BBOX.north]].map((p) => cellOf(...toUTM(p[0], p[1])));
  return { x0: Math.min(...cs.map((c) => c[0])), x1: Math.max(...cs.map((c) => c[0])), y0: Math.min(...cs.map((c) => c[1])), y1: Math.max(...cs.map((c) => c[1])) };
})();
const inRange = (cx, cy) => cx >= RANGE.x0 && cx <= RANGE.x1 && cy >= RANGE.y0 && cy <= RANGE.y1;
// a lon / lat test with a margin (degrees), for keeping source records near the city
const nearCity = (lon, lat, m = 0.01) => lon >= BBOX.west - m && lon <= BBOX.east + m && lat >= BBOX.south - m && lat <= BBOX.north + m;

// ── Clipping and simplification (UTM metres) ─────────────────────────────────────────────────────────────────
// a polyline clipped to a rectangle: the pieces inside it (Liang-Barsky per segment, runs stitched)
function clipLine(pts, r) {
  const out = []; let cur = null;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, ax - r[0]], [dx, r[2] - ax], [-dy, ay - r[1]], [dy, r[3] - ay]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const t = q / p; if (p < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; } else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
    }
    if (!ok || t1 < t0) { if (cur) { out.push(cur); cur = null; } continue; }
    const P = [ax + t0 * dx, ay + t0 * dy], Q = [ax + t1 * dx, ay + t1 * dy];
    if (!cur) cur = [P]; else { const L = cur[cur.length - 1]; if (Math.hypot(L[0] - P[0], L[1] - P[1]) > 1e-6) { out.push(cur); cur = [P]; } }
    cur.push(Q);
    if (t1 < 1) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.filter((p) => p.length > 1 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) > 0.01);
}
// Douglas-Peucker at tol metres (iterative)
function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop(), [ax, ay] = pts[i], [bx, by] = pts[j], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    let best = -1, bi = -1;
    for (let k = i + 1; k < j; k++) {
      const d = L ? Math.abs(dy * pts[k][0] - dx * pts[k][1] + bx * ay - by * ax) / L : Math.hypot(pts[k][0] - ax, pts[k][1] - ay);
      if (d > best) { best = d; bi = k; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([i, bi], [bi, j]); }
  }
  return pts.filter((p, k) => keep[k]);
}
// a closed ring simplified; the original when simplifying would leave fewer than four points
function simplifyRing(ring, tol) { const s = simplify(ring, tol); return s.length >= 4 ? s : ring; }
const bboxOf = (pts) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };
const pointInRing = (x, y, ring) => { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } return inside; };
const r6 = (v) => Math.round(v * 1e6) / 1e6, r7 = (v) => Math.round(v * 1e7) / 1e7;
const ll = (p) => { const q = fromUTM(p[0], p[1]); return [r6(q[0]), r6(q[1])]; };
const ll7 = (p) => { const q = fromUTM(p[0], p[1]); return [r7(q[0]), r7(q[1])]; };   // the exact layers (cells.js)

module.exports = { toUTM, fromUTM, BBOX, CELL, ORIGIN, RANGE, cellOf, cellId, cellRect, inRange, nearCity, clipLine, simplify, simplifyRing, bboxOf, pointInRing, ll, ll7 };
