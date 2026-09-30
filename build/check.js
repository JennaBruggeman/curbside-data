'use strict';
// Checks the published cells:  node build/check.js [--sites]
// Every file: parses, schemaVersion, one layer, the cell it sits in, <= 200 kB gzipped, every feature with a unique id
// (in the file), layer, source, fetchedAt, props with only the layer's normalised names, and a geometry inside its cell
// (points) or touching it. index.json agrees with the files. Fixtures present for the three sites. --sites prints what
// lies within 150 m of each site, per layer. Exit 1 on any failure.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const LAYERS = require('./layers'), G = require('./lib/geo'), C = require('./lib/cells');
const ROOT = path.resolve(__dirname, '..'), idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8'));
const errs = [], err = (s) => { if (errs.length < 50) errs.push(s); };
const byId = Object.fromEntries(LAYERS.map((l) => [l.id, l]));
let files = 0, feats = 0, maxGz = 0;
const cellsDir = path.join(ROOT, 'cells');
for (const k of fs.readdirSync(cellsDir)) {
  const [cx, cy] = k.split('_').map(Number), r = G.cellRect(cx, cy), m = 1;   // 1 m of slack for rounding
  for (const f of fs.readdirSync(path.join(cellsDir, k))) {
    files++;
    const buf = fs.readFileSync(path.join(cellsDir, k, f)), gz = zlib.gzipSync(buf).length; maxGz = Math.max(maxGz, gz);
    const lid = f.replace(/(\.\d+)?\.json$/, ''), L = byId[lid];
    if (!L) { err(k + '/' + f + ': unknown layer'); continue; }
    if (gz > C.LIMIT) err(k + '/' + f + ': ' + gz + ' B gzipped (over ' + C.LIMIT + ')');
    let j; try { j = JSON.parse(buf); } catch (e) { err(k + '/' + f + ': not JSON'); continue; }
    if (j.schemaVersion !== C.SCHEMA || j.layer !== lid || j.cell !== k || j.type !== 'FeatureCollection') err(k + '/' + f + ': header');
    const ids = new Set();
    for (const ft of j.features) {
      feats++;
      const p = ft.properties || {};
      if (!ft.id || ft.id !== p.id || ids.has(ft.id)) err(k + '/' + f + ': id ' + ft.id); ids.add(ft.id);
      if (p.layer !== lid || p.source !== L.source || !p.fetchedAt) err(k + '/' + f + ': ' + ft.id + ' layer / source / fetchedAt');
      const extra = Object.keys(p.props || {}).filter((n) => !L.props.includes(n)); if (extra.length) err(k + '/' + f + ': ' + ft.id + ' props ' + extra.join(','));
      const g = ft.geometry, pts = g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.type === 'MultiLineString' ? g.coordinates.flat() : g.coordinates.flat();
      const u = pts.map((q) => G.toUTM(q[0], q[1]));
      if (g.type === 'Point' || g.type === 'LineString' || g.type === 'MultiLineString') {
        if (u.some((q) => q[0] < r[0] - m || q[0] > r[2] + m || q[1] < r[1] - m || q[1] > r[3] + m)) err(k + '/' + f + ': ' + ft.id + ' outside its cell');
      } else { const b = G.bboxOf(u); if (b[2] < r[0] - m || b[0] > r[2] + m || b[3] < r[1] - m || b[1] > r[3] + m) err(k + '/' + f + ': ' + ft.id + ' does not touch its cell'); }
    }
    const ic = idx.cells[k] && idx.cells[k][lid];
    if (!ic) err(k + '/' + f + ': not in index.json');
  }
}
for (const [k, v] of Object.entries(idx.cells)) for (const [lid, c] of Object.entries(v)) { const n = c[2] > 1 ? c[2] : 1; for (let i = 1; i <= n; i++) if (!fs.existsSync(path.join(cellsDir, k, n > 1 ? lid + '.' + i + '.json' : lid + '.json'))) err('index.json lists ' + k + '/' + lid + ' part ' + i + ' but the file is missing'); }
const sites = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'sites.json'), 'utf8'));
for (const [k, s] of Object.entries(sites)) if (!fs.existsSync(path.join(ROOT, 'fixtures', 'cells', s.cell))) err('fixtures: no cell ' + s.cell + ' for ' + k);
console.log(files + ' files, ' + feats + ' features in ' + Object.keys(idx.cells).length + ' cells; largest file ' + (maxGz / 1024).toFixed(0) + ' kB gzipped (limit ' + C.LIMIT / 1024 + ')');
for (const [id, l] of Object.entries(idx.layers)) console.log('  ' + id.padEnd(17) + String(l.count).padStart(7) + ' features ' + String(l.cells).padStart(4) + ' cells ' + (l.gzBytes / 1048576).toFixed(2).padStart(6) + ' MB gz  updated ' + l.updatedAt + (l.stale ? '  STALE: ' + l.error : ''));
if (process.argv.includes('--sites')) {
  for (const [k, s] of Object.entries(sites)) {
    const u = G.toUTM(s.lon, s.lat), [cx, cy] = G.cellOf(...u), seen = {};
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const dir = path.join(ROOT, 'cells', G.cellId(cx + dx, cy + dy)); if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) for (const ft of JSON.parse(fs.readFileSync(path.join(dir, f))).features) {
        const g = ft.geometry, pts = g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.coordinates.flat(g.type === 'Polygon' ? 1 : 1);
        if (pts.some((q) => { const w = G.toUTM(q[0], q[1]); return Math.hypot(w[0] - u[0], w[1] - u[1]) <= 150; })) (seen[ft.properties.layer] = seen[ft.properties.layer] || new Map()).set(ft.id, ft.properties.props);
      }
    }
    console.log(k + ' ' + s.name + ' (cell ' + s.cell + '), within 150 m: ' + Object.entries(seen).map(([l, m]) => l + ' ' + m.size).join(', '));
    const sample = (l, fn) => seen[l] ? [...seen[l].values()].map(fn).filter(Boolean).slice(0, 6).join('; ') : '-';
    console.log('    bikeways: ' + sample('bikeways', (p) => p.type + (p.subtype ? '/' + p.subtype : '') + ' ' + (p.name || '')) + ' | row-width: ' + [...new Set(sample('row-width', (p) => p.width + ' m').split('; '))].join(', ') +
      ' | one-way: ' + sample('one-way', (p) => p.name) + ' | truck: ' + sample('truck-routes', (p) => p.name) + ' | stops: ' + sample('bus-stops', (p) => p.name + ' [' + p.routes.join(',') + ']'));
    console.log('    streets: ' + sample('streets', (p) => (p.name || '?') + ' ' + p.highway + ' lanes ' + p.lanes + ' oneway ' + p.oneway + (p.cycleway.left || p.cycleway.right ? ' cw ' + p.cycleway.left + '/' + p.cycleway.right : '')));
  }
}
if (errs.length) { console.log('FAILED: ' + errs.length + (errs.length === 50 ? '+' : '') + ' problems'); errs.forEach((e) => console.log('  ' + e)); process.exit(1); }
console.log('OK');
