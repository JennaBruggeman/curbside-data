'use strict';
// Features -> cell files. A source hands over features in UTM metres:
//   { id, geom: 'Point' | 'Lines' | 'Polygon', utm, props }
//   Point: [x, y]; Lines: [[x, y], ...][] (one or more polylines); Polygon: rings [[x, y], ...][] (outer first).
// Points go in the cell that contains them. Lines are simplified (0.5 m) and clipped to each cell they cross, keeping
// their id in each (the app joins the pieces by id). Polygons (buildings) are simplified and written whole in every
// cell their bounding box touches, so deduplicating by id is exact. A cell-layer file over 200 kB gzipped is split
// into parts ({layer}.1.json, {layer}.2.json ...), never allowed to grow.
// An exact layer (layers.js: the streets and buildings the app's import measures the site from) is not simplified and is
// written to 7 decimals (about 1 cm, as Overpass gives it), so the import reads the geometry a live query would.
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const G = require('./geo');
const SCHEMA = 1, LIMIT = 200 * 1024, TOL = 0.5;

function assign(features, layer) {
  const exact = !!(layer && layer.exact), simp = exact ? (l) => l.slice() : (l) => G.simplify(l, TOL), simpRing = exact ? (r) => r.slice() : (r) => G.simplifyRing(r, TOL), ll = exact ? G.ll7 : G.ll;
  const cells = new Map();
  const put = (cx, cy, geometry, f) => { if (!G.inRange(cx, cy)) return; const k = G.cellId(cx, cy); let a = cells.get(k); if (!a) cells.set(k, a = []); a.push({ id: f.id, geometry, props: f.props }); };
  for (const f of features) {
    if (f.geom === 'Point') { const [cx, cy] = G.cellOf(f.utm[0], f.utm[1]); put(cx, cy, { type: 'Point', coordinates: ll(f.utm) }, f); continue; }
    if (f.geom === 'Lines') {
      const lines = f.utm.map(simp).filter((l) => l.length > 1); if (!lines.length) continue;
      const b = G.bboxOf(lines.flat()), [x0, y0] = G.cellOf(b[0], b[1]), [x1, y1] = G.cellOf(b[2], b[3]);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
        const r = G.cellRect(cx, cy), parts = [];
        for (const l of lines) for (const p of G.clipLine(l, r)) parts.push(p.map(ll));
        if (parts.length) put(cx, cy, parts.length === 1 ? { type: 'LineString', coordinates: parts[0] } : { type: 'MultiLineString', coordinates: parts }, f);
      }
      continue;
    }
    if (f.geom === 'Polygon') {
      const rings = f.utm.map(simpRing), b = G.bboxOf(rings[0]), [x0, y0] = G.cellOf(b[0], b[1]), [x1, y1] = G.cellOf(b[2], b[3]);
      const geometry = { type: 'Polygon', coordinates: rings.map((r) => r.map(ll)) };
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) put(cx, cy, geometry, f);
      continue;
    }
    throw new Error('cells: unknown geometry ' + f.geom + ' (' + f.id + ')');
  }
  return cells;
}

// the layer's content (not its dates): unchanged content keeps the files and the dates it has
function hashOf(cells) {
  const h = crypto.createHash('sha1');
  for (const k of [...cells.keys()].sort()) { h.update(k); for (const f of cells.get(k).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) h.update(JSON.stringify([f.id, f.geometry, f.props])); }
  return h.digest('hex').slice(0, 16);
}

// every file of a layer, in every cell
function layerFiles(root, layer) {
  const dir = path.join(root, 'cells'), out = [];
  if (!fs.existsSync(dir)) return out;
  for (const c of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, c))) if (f === layer + '.json' || (f.startsWith(layer + '.') && /^\d+\.json$/.test(f.slice(layer.length + 1)))) out.push(path.join(dir, c, f));
  return out;
}

// Writes the layer's cells (after removing its old files); returns its index entry
function writeLayer(root, layer, source, stamp, cells) {
  for (const f of layerFiles(root, layer)) fs.unlinkSync(f);
  const entry = { source, count: 0, cells: 0, bytes: 0, gzBytes: 0, maxGz: 0, perCell: {} }, ids = new Set();
  for (const k of [...cells.keys()].sort()) {
    // features by id, so a file's bytes never depend on the order a source delivered its records in
    const feats = cells.get(k).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((f) => ({ type: 'Feature', id: f.id, properties: { id: f.id, layer, source, fetchedAt: stamp, props: f.props }, geometry: f.geometry }));
    feats.forEach((f) => ids.add(f.id));
    const body = (list) => JSON.stringify({ type: 'FeatureCollection', schemaVersion: SCHEMA, layer, cell: k, updatedAt: stamp, features: list });
    let parts = [feats], json = parts.map(body), gz = json.map((s) => zlib.gzipSync(s).length);
    // split: features sorted west to east, cut into more and more equal parts until every part fits
    for (let n = 2; gz.some((g) => g > LIMIT); n++) {
      const key = (f) => { const c = f.geometry.coordinates; return f.geometry.type === 'Point' ? c[0] : (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiLineString' ? c[0][0][0] : c[0][0]); };
      const sorted = feats.slice().sort((a, b) => key(a) - key(b)), size = Math.ceil(sorted.length / n);
      parts = []; for (let i = 0; i < sorted.length; i += size) parts.push(sorted.slice(i, i + size));
      json = parts.map(body); gz = json.map((s) => zlib.gzipSync(s).length);
      if (n > 64) throw new Error(layer + ' in ' + k + ': cannot split under ' + LIMIT + ' B');
    }
    fs.mkdirSync(path.join(root, 'cells', k), { recursive: true });
    json.forEach((s, i) => fs.writeFileSync(path.join(root, 'cells', k, parts.length === 1 ? layer + '.json' : layer + '.' + (i + 1) + '.json'), s));
    const bytes = json.reduce((a, s) => a + Buffer.byteLength(s), 0), g = gz.reduce((a, b) => a + b, 0);
    entry.perCell[k] = { n: feats.length, bytes, gz: g, parts: parts.length };
    entry.cells++; entry.bytes += bytes; entry.gzBytes += g; entry.maxGz = Math.max(entry.maxGz, ...gz);
  }
  entry.count = ids.size;
  return entry;
}
module.exports = { SCHEMA, LIMIT, TOL, assign, hashOf, writeLayer, layerFiles };
