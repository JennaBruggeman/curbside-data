'use strict';
// "Where could a parklet go?" (Curbside Brief 30 §2): every block face of a street that can carry a parklet, with the
// hard exclusions the cells already know, worked out before anyone clicks. Derived: it reads the streets, bus stops,
// hydrants, bikeways, bus routes and truck routes this run has just written (cells/*), so `--only=derived` rebuilds
// it alone. Nothing here is a check result: the app's checks stay the only compliance code once a site is chosen; this
// is an estimate to steer the pick, and the app says so.
//
// A block face: one side of a street way between two corners (a vertex the way shares with a crossing way at 35 degrees
// or more, the app's pkFindCorners rule) or the way's ends. Streets: primary, secondary, tertiary, residential,
// unclassified, living_street (no trunk, no links, no service lanes). Each face is cut into pieces:
//   excluded           corner     within 6 m of the crossing street's curb line (its half width: the width tag / 2, else
//                                 its lanes x 1.65 m + 2.4 m, 2 lanes when untagged; pkFindCorners again) (C03)
//                      hydrant    5 m either side of a hydrant on this side (C05)
//                      bus_zone   15 m either side of a bus stop on this side (the app's C01 import rule)
//                      no_parking_lane  the whole face: parking:<side> = no / no_parking / no_stopping / fire_lane /
//                                 separate, or the median side of a dual carriageway
//                      bike_lane  the whole face: an OSM cycleway lane or track on this side with no parking lane tagged
//                                 beside it (the bike lane is where the parking would be)
//   needs-measurement  lane_width_estimate  the travel lanes' estimated width is within 0.1 m of C02's minimum (3.2 m
//                                 on a bus or truck route, else 3.0 m): the app's estimate, lanes x 3.2 m, or the width
//                                 tag when the way has one
//                      bike_lane  a City bikeway (painted or protected) runs along the street but OSM does not say
//                                 which side or where (the app then assumes it on the parklet's side)
//   eligible-estimate  none of the above (every value an estimate: confirm on site)
// A stop or a hydrant belongs to every face it stands beside: its projection falls inside the face (not past its ends),
// within the street's estimated half width + 12 m, on the side its position gives. A corner hydrant is beside both
// streets' faces, as the app's import (every object on the parklet's half, between the curb returns) takes it.
const fs = require('fs'), path = require('path'), G = require('./lib/geo');
const ROOT = path.resolve(__dirname, '..'), CELLS = path.join(ROOT, 'cells');
const HW = /^(primary|secondary|tertiary|residential|unclassified|living_street)$/;
const CROSS_SKIP = /^(service)$/;   // the app's corner rule leaves service ways out
const NO_PARK = /^(no|none|no_parking|no_stopping|fire_lane|separate)$/;
const YES_PARK = /^(lane|parallel|street_side|yes|diagonal|perpendicular|on_kerb|half_on_kerb|marked|shoulder)$/;
const CORNER = 6, HYDRANT = 5, BUS = 15, MARGIN = 0.1, SLIVER = 1.0;

// every feature of a layer across the cells, the pieces of a line joined (UTM metres)
function readLayer(lid) {
  const by = new Map();
  for (const c of fs.readdirSync(CELLS)) for (const f of fs.readdirSync(path.join(CELLS, c))) {
    if (f !== lid + '.json' && !(f.startsWith(lid + '.') && /^\d+\.json$/.test(f.slice(lid.length + 1)))) continue;
    for (const ft of JSON.parse(fs.readFileSync(path.join(CELLS, c, f), 'utf8')).features) {
      let o = by.get(ft.id); if (!o) by.set(ft.id, o = { id: ft.id, props: ft.properties.props, lines: [], pt: null });
      const g = ft.geometry;
      if (g.type === 'Point') o.pt = G.toUTM(g.coordinates[0], g.coordinates[1]);
      else (g.type === 'LineString' ? [g.coordinates] : g.coordinates).forEach((l) => o.lines.push(l.map((q) => G.toUTM(q[0], q[1]))));
    }
  }
  for (const o of by.values()) if (o.lines.length > 1) o.lines = join(o.lines);
  return [...by.values()];
}
// a line's pieces chained where they meet (the app's GIS.joinParts, in metres)
function join(parts) {
  const out = parts.map((p) => p.slice()), eq = (a, b) => Math.abs(a[0] - b[0]) < 0.02 && Math.abs(a[1] - b[1]) < 0.02;
  for (let m = true; m;) {
    m = false;
    for (let i = 0; i < out.length && !m; i++) for (let j = 0; j < out.length && !m; j++) {
      if (i === j) continue; const A = out[i], B = out[j];
      if (eq(A[A.length - 1], B[0])) { out[i] = A.concat(B.slice(1)); out.splice(j, 1); m = true; }
      else if (eq(A[A.length - 1], B[B.length - 1])) { out[i] = A.concat(B.slice(0, -1).reverse()); out.splice(j, 1); m = true; }
    }
  }
  return out;
}
const key = (p) => Math.round(p[0] * 50) + ',' + Math.round(p[1] * 50);   // 2 cm: a shared OSM node
const lanesOf = (p, oneway) => {   // the app's SMP.lanesOf
  const g = { primary: [2, 3], trunk: [2, 3], secondary: [1, 2], tertiary: [1, 2] }[String(p.highway).replace('_link', '')] || [1, 1];
  return p.lanes == null ? (oneway ? g[1] : g[0] * 2) : Math.round(p.lanes);
};
const crossHalf = (p) => (p.width > 3 ? p.width / 2 : (p.lanes > 0 ? p.lanes : 2) * 1.65 + 2.4);
const bikeOf = (v) => (/^(lane|opposite_lane)$/.test(v || '') ? 'painted' : /^(track|opposite_track)$/.test(v || '') ? 'protected' : null);
const bikeW = (b) => (b === 'protected' ? 2.0 : b === 'painted' ? 1.5 : 0);
const r1 = (v) => Math.round(v * 10) / 10;

// a polyline's cumulative lengths, the point at s, the sub-chain s0..s1, the projection of a point
function chain(pts) { const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return c; }
function sub(pts, cum, s0, s1) {
  const at = (s) => { let i = 1; while (i < pts.length - 1 && cum[i] < s) i++; const t = (s - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]); return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])]; };
  const out = [at(s0)]; for (let i = 1; i < pts.length - 1; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pts[i]); out.push(at(s1)); return out;
}
function project(pts, cum, q) {   // {s, lat (signed: + left of the direction), d}
  let best = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; if (l2 < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2)), px = a[0] + t * dx, py = a[1] + t * dy, d = Math.hypot(q[0] - px, q[1] - py);
    if (!best || d < best.d) { const L = Math.sqrt(l2); best = { s: cum[i - 1] + t * L, lat: (dx * (q[1] - a[1]) - dy * (q[0] - a[0])) / L, d, end: t <= 0 || t >= 1 }; }
  }
  return best;
}
// the angle (0-90) between two directions
const ang = (a, b) => { let d = Math.abs(Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0])) * 180 / Math.PI % 180; return Math.min(d, 180 - d); };
const dirAt = (pts, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]; return [b[0] - a[0], b[1] - a[1]]; };

async function build() {
  const streets = readLayer('streets'), stops = readLayer('bus-stops'), hyd = readLayer('hydrants');
  const bikeways = readLayer('bikeways'), routes = readLayer('bus-routes'), trucks = readLayer('truck-routes');
  if (!streets.length) throw new Error('no streets in the cells: build osm first');
  // the vertex index: which ways pass through each node (named or not; service ways left out of corners)
  const nodes = new Map();
  for (const w of streets) w.lines.forEach((l, li) => l.forEach((p, i) => { const k = key(p); let a = nodes.get(k); if (!a) nodes.set(k, a = []); a.push({ w, li, i }); }));
  // a 100 m bucket index of line segments, for "which lines run near here"
  const segIdx = (list) => { const B = new Map(); list.forEach((o) => o.lines.forEach((l) => { for (let i = 1; i < l.length; i++) { const k = Math.floor((l[i][0] + l[i - 1][0]) / 200) + ',' + Math.floor((l[i][1] + l[i - 1][1]) / 200); let a = B.get(k); if (!a) B.set(k, a = []); a.push({ o, a: l[i - 1], b: l[i] }); } })); return B; };
  const near = (B, p, r, dir, maxAng) => {
    const out = new Set();
    for (let x = Math.floor(p[0] / 100) - 1; x <= Math.floor(p[0] / 100) + 1; x++) for (let y = Math.floor(p[1] / 100) - 1; y <= Math.floor(p[1] / 100) + 1; y++) for (const s of B.get(x + ',' + y) || []) {
      const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], l2 = dx * dx + dy * dy; if (l2 < 1e-9) continue;
      const t = Math.max(0, Math.min(1, ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / l2));
      if (Math.hypot(p[0] - s.a[0] - t * dx, p[1] - s.a[1] - t * dy) <= r && (!dir || ang(dir, [dx, dy]) <= maxAng)) out.add(s.o);
    }
    return [...out];
  };
  const bikeB = segIdx(bikeways.filter((b) => /Painted|Protected/i.test(b.props.type || '') || /Painted|Protected/i.test(b.props.subtype || ''))), routeB = segIdx(routes), truckB = segIdx(trucks), streetB = segIdx(streets);

  // 1. the faces: each eligible way cut at its corners, two sides
  const faces = [];
  for (const w of streets) {
    const p = w.props; if (!HW.test(p.highway || '')) continue;
    const oneway = p.oneway === 'yes' || p.oneway === 'reverse', n = lanesOf(p, oneway);
    const parkL = p.parking.left || '', parkR = p.parking.right || '';
    const half = p.width > 3 ? p.width / 2 : (n * 3.2 + (NO_PARK.test(parkL) ? 0 : 2.4) + (NO_PARK.test(parkR) ? 0 : 2.4) + bikeW(bikeOf(p.cycleway.left)) + bikeW(bikeOf(p.cycleway.right))) / 2;
    w.lines.forEach((pts, li) => {
      const cuts = [];   // {i, half, name}
      pts.forEach((q, i) => {
        let best = null;
        for (const o of nodes.get(key(q)) || []) {
          if (o.w === w || CROSS_SKIP.test(o.w.props.highway || '') || (p.name && o.w.props.name === p.name)) continue;
          if (ang(dirAt(pts, i), dirAt(o.w.lines[o.li], o.i)) < 35) continue;
          const h = crossHalf(o.w.props); if (!best || h > best.half) best = { i, half: h, name: o.w.props.name || o.w.props.highway };
        }
        if (best) cuts.push(best);
      });
      const cum = chain(pts), bounds = [{ i: 0, half: 0, name: null }].concat(cuts.filter((c) => c.i > 0 && c.i < pts.length - 1)).concat([{ i: pts.length - 1, half: 0, name: null }]);
      const atStart = cuts.find((c) => c.i === 0), atEnd = cuts.find((c) => c.i === pts.length - 1);
      if (atStart) bounds[0] = atStart; if (atEnd) bounds[bounds.length - 1] = atEnd;
      for (let k = 1; k < bounds.length; k++) {
        const a = bounds[k - 1], b = bounds[k], seg = pts.slice(a.i, b.i + 1); if (seg.length < 2) continue;
        const sc = chain(seg), S = sc[sc.length - 1]; if (S < 1) continue;
        ['left', 'right'].forEach((side) => faces.push({ w, li, seg, cum: sc, S, side, half, n, oneway, a, b, park: side === 'left' ? parkL : parkR, bike: bikeOf(side === 'left' ? p.cycleway.left : p.cycleway.right), cw: side === 'left' ? p.cycleway.left : p.cycleway.right, k: k - 1, pts: [] }));
      }
    });
  }
  // 2. the stops and hydrants: each to its nearest face (laterally), on the side its position gives
  const faceB = new Map();
  faces.forEach((f, fi) => { if (f.side !== 'left') return; for (let i = 1; i < f.seg.length; i++) { const k = Math.floor((f.seg[i][0] + f.seg[i - 1][0]) / 200) + ',' + Math.floor((f.seg[i][1] + f.seg[i - 1][1]) / 200); let a = faceB.get(k); if (!a) faceB.set(k, a = []); if (a[a.length - 1] !== fi) a.push(fi); } });
  const place = (pt, what) => {
    const seen = new Set();
    for (let x = Math.floor(pt.pt[0] / 100) - 1; x <= Math.floor(pt.pt[0] / 100) + 1; x++) for (let y = Math.floor(pt.pt[1] / 100) - 1; y <= Math.floor(pt.pt[1] / 100) + 1; y++) for (const fi of faceB.get(x + ',' + y) || []) {
      if (seen.has(fi)) continue; seen.add(fi);
      const fl = faces[fi], pr = project(fl.seg, fl.cum, pt.pt); if (!pr || pr.end || pr.d > fl.half + 12) continue;
      (pr.lat >= 0 ? fl : faces[fi + 1]).pts.push({ what, s: pr.s, pt });   // the left face, or its right twin
    }
  };
  stops.forEach((s) => place(s, 'bus_zone')); hyd.forEach((h) => place(h, 'hydrant'));

  // 3. each face: its route type, its whole-face reasons, its intervals, its pieces
  const out = [], counts = {};
  for (const f of faces) {
    const p = f.w.props, mid = sub(f.seg, f.cum, f.S / 2, f.S / 2 + 0.01)[0], dir = [f.seg[f.seg.length - 1][0] - f.seg[0][0], f.seg[f.seg.length - 1][1] - f.seg[0][1]];
    const busRoute = near(routeB, mid, 20, dir, 30).length > 0, truck = near(truckB, mid, 20, dir, 30).length > 0;
    const bt = /^(primary|secondary|trunk)$/.test(p.highway) || busRoute || truck, req = bt ? 3.2 : 3.0;
    const whole = [], base = [], detail = {};
    // the median side of a dual carriageway: a one-way way of the same name 30 m or less to this side
    if (f.oneway && p.name) {
      const sgn = f.side === 'left' ? 1 : -1, L = Math.hypot(dir[0], dir[1]) || 1, probe = [mid[0] - sgn * dir[1] / L * 15, mid[1] + sgn * dir[0] / L * 15];
      if (near(streetB, probe, 16, dir, 30).some((o) => o !== f.w && o.props.name === p.name && (o.props.oneway === 'yes' || o.props.oneway === 'reverse'))) { whole.push('no_parking_lane'); detail.no_parking_lane = 'The median side of a dual carriageway (' + p.name + '): no parking lane'; }
    }
    if (!detail.no_parking_lane && NO_PARK.test(f.park)) { whole.push('no_parking_lane'); detail.no_parking_lane = 'No parking lane on this side (OpenStreetMap: parking ' + f.park + ')'; }
    if (f.bike && !YES_PARK.test(f.park)) { whole.push('bike_lane'); detail.bike_lane = 'A ' + f.bike + ' bike lane where the parking lane would be (OpenStreetMap: cycleway ' + f.cw + ')'; }
    else if (!f.bike && !/^(lane|opposite_lane|track|opposite_track)$/.test(p.cycleway.left || '') && !/^(lane|opposite_lane|track|opposite_track)$/.test(p.cycleway.right || '')) {
      const cb = near(bikeB, mid, 15, dir, 30)[0];
      if (cb) { base.push('bike_lane'); detail.bike_lane = 'A City bikeway runs along this street (' + [cb.props.type, cb.props.subtype].filter(Boolean).join(', ') + (cb.props.name ? ', ' + cb.props.name : '') + '): which side, and where, to confirm'; }
    }
    const nPark = (NO_PARK.test(p.parking.left || '') ? 0 : 1) + (NO_PARK.test(p.parking.right || '') ? 0 : 1);
    const est = p.width > 3 ? (p.width - nPark * 2.4 - bikeW(bikeOf(p.cycleway.left)) - bikeW(bikeOf(p.cycleway.right))) / f.n : 3.2;
    if (est < req + MARGIN) { base.push('lane_width_estimate'); detail.lane_width_estimate = (bt ? 'A bus or truck route' : 'A local street') + ': travel lanes estimated at ' + est.toFixed(2) + ' m (' + (p.width > 3 ? 'the width tag ' + p.width + ' m, ' : 'lanes x 3.2 m, ') + f.n + ' lane' + (f.n > 1 ? 's' : '') + ') against C02\'s ' + req.toFixed(1) + ' m: measure them'; }
    // the intervals that exclude part of the face
    const iv = [];
    if (f.a.half) iv.push({ s0: 0, s1: f.a.half + CORNER, why: 'corner', text: 'Within ' + CORNER + ' m of the corner at ' + f.a.name + ' (C03)' });
    if (f.b.half) iv.push({ s0: f.S - f.b.half - CORNER, s1: f.S, why: 'corner', text: 'Within ' + CORNER + ' m of the corner at ' + f.b.name + ' (C03)' });
    f.pts.sort((x, y) => x.s - y.s || (x.pt.id < y.pt.id ? -1 : 1)).forEach((q) => {
      if (q.what === 'hydrant') iv.push({ s0: q.s - HYDRANT, s1: q.s + HYDRANT, why: 'hydrant', text: 'Fire hydrant ' + (q.pt.props.hydrantId || '') + ' ' + r1(q.s) + ' m along this face: 5 m clear each side (C05)' });
      else iv.push({ s0: q.s - BUS, s1: q.s + BUS, why: 'bus_zone', text: 'Bus stop ' + (q.pt.props.name || '') + (q.pt.props.code ? ' (' + q.pt.props.code + ')' : '') + ' ' + r1(q.s) + ' m along this face: a bus zone (C01)' });
    });
    // the cut points: every interval end inside the face
    const cutsS = [0, f.S]; iv.forEach((v) => { if (v.s0 > 0 && v.s0 < f.S) cutsS.push(v.s0); if (v.s1 > 0 && v.s1 < f.S) cutsS.push(v.s1); });
    const ss = [...new Set(cutsS.map((v) => Math.round(v * 100) / 100))].sort((x, y) => x - y);
    let pieces = [];
    for (let i = 1; i < ss.length; i++) {
      const s0 = ss[i - 1], s1 = ss[i]; if (s1 - s0 < 0.05) continue;
      const m = (s0 + s1) / 2, hit = iv.filter((v) => v.s0 <= m && v.s1 >= m);
      pieces.push({ s0, s1, hit });
    }
    // a sliver under 1 m between two excluded pieces is excluded with them (it holds no parklet, and reads as noise)
    pieces.forEach((q, i) => { if (!q.hit.length && q.s1 - q.s0 < SLIVER && pieces[i - 1] && pieces[i + 1] && pieces[i - 1].hit.length && pieces[i + 1].hit.length) q.hit = pieces[i - 1].hit; });
    // pieces of one kind next to each other become one
    const sig = (q) => q.hit.map((v) => v.why + v.text).sort().join('|');
    pieces = pieces.reduce((a, q) => { const l = a[a.length - 1]; if (l && sig(l) === sig(q)) l.s1 = q.s1; else a.push(Object.assign({}, q)); return a; }, []);
    const cellCount = (cell, el) => { const c = counts[cell] = counts[cell] || { 'eligible-estimate': 0, excluded: 0, 'needs-measurement': 0 }; c[el]++; };
    pieces.forEach((q, qi) => {
      let el, reasons, texts;
      if (whole.length) { el = 'excluded'; reasons = whole.concat(q.hit.map((v) => v.why)); texts = whole.map((r) => detail[r]).concat(q.hit.map((v) => v.text)); }
      else if (q.hit.length) { el = 'excluded'; reasons = q.hit.map((v) => v.why); texts = q.hit.map((v) => v.text); }
      else if (base.length) { el = 'needs-measurement'; reasons = base.slice(); texts = base.map((r) => detail[r]); }
      else { el = 'eligible-estimate'; reasons = []; texts = ['No exclusion in the City and OpenStreetMap data: every value an estimate, confirm on site']; }
      reasons = [...new Set(reasons)];
      const line = sub(f.seg, f.cum, q.s0, q.s1);
      out.push({ id: 'bf:' + p.wayId + ':' + f.li + ':' + f.k + ':' + f.side.charAt(0) + ':' + qi, geom: 'Lines', utm: [line],
        props: { wayId: p.wayId, name: p.name || null, side: f.side, offM: r1(f.side === 'left' ? -f.half : f.half), eligibility: el, reasons, detail: texts, s0: r1(q.s0), s1: r1(q.s1), faceLen: r1(f.S), route: bt ? 'bus_truck' : 'standard' } });
      const [cx, cy] = G.cellOf(line[0][0], line[0][1]); cellCount(G.cellId(cx, cy), el);
    });
  }
  const tot = { 'eligible-estimate': 0, excluded: 0, 'needs-measurement': 0 }; Object.values(counts).forEach((c) => Object.keys(tot).forEach((k) => { tot[k] += c[k]; }));
  const notes = [faces.length + ' block faces (' + faces.length / 2 + ' block sides x 2) cut into ' + out.length + ' pieces: ' + Object.entries(tot).map(([k, v]) => k + ' ' + v).join(', ')]
    .concat(Object.keys(counts).sort().map((c) => 'cell ' + c + ': eligible-estimate ' + counts[c]['eligible-estimate'] + ', excluded ' + counts[c].excluded + ', needs-measurement ' + counts[c]['needs-measurement']));
  return { layers: { blockfaces: out }, notes, meta: { name: 'Derived from the cells (Curbside Brief 30 §2)', url: 'https://github.com/JennaBruggeman/curbside-data/blob/main/build/blockfaces.js' } };
}
module.exports = { build };
