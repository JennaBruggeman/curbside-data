'use strict';
// Builds the cells:  node build/build.js [--fresh] [--only=cov,osm,gtfs,derived]
//   --fresh   downloads the OSM extract and the GTFS feed again (the workflow always does); the City is always live
//   --only    rebuilds only those sources; the other layers keep their files and index entries
// Rules (Brief 24 A4): each source is independent. A source that fails, or one of whose layers drops more than 30 %
// from the last build, publishes nothing: its layers keep their previous files and are marked stale in index.json. A
// layer whose content is unchanged keeps its files and dates, so a run that changes nothing changes no file (the
// workflow commits only when a cell changed). index.json holds no run timestamps for the same reason.
const fs = require('fs'), path = require('path');
const LAYERS = require('./layers'), C = require('./lib/cells'), G = require('./lib/geo');
const ROOT = path.resolve(__dirname, '..'), CACHE = path.join(ROOT, '.cache'), IDX = path.join(ROOT, 'index.json'), FIX = path.join(ROOT, 'fixtures');
// derived: built from the cells the other sources have just written (Curbside Brief 30 §2: blockfaces); last, always
const SOURCES = { cov: require('./cov'), osm: require('./osm'), gtfs: require('./gtfs'), derived: require('./blockfaces') }, ORDER = ['cov', 'osm', 'gtfs', 'derived'];
const DROP = 0.30, BASE = 'https://jennabruggeman.github.io/curbside-data/';
// the three sites every VERIFY runs at (the app's test sites): their cell and its eight neighbours are the fixtures
const SITES = { rb: { name: 'Robson & Burrard', lon: -123.12291, lat: 49.28347 }, cd: { name: 'Commercial & 1st', lon: -123.06942, lat: 49.27010 }, dn: { name: 'W 41st & Dunbar', lon: -123.18450, lat: 49.23486 } };
const UA = 'curbside-data build (https://github.com/JennaBruggeman/curbside-data)';

const args = process.argv.slice(2), fresh = args.includes('--fresh'), onlyArg = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
const only = onlyArg ? onlyArg.split(',') : ORDER;
const log = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, as) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(600000) });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url);
      return as === 'json' ? await r.json() : Buffer.from(await r.arrayBuffer());
    } catch (e) { last = e; await sleep(5000 * (i + 1)); }
  }
  throw last;
}
const ctx = {
  cache: CACHE, fresh, shared: {},
  fetchJSON: (url) => fetchRetry(url, 'json'),
  download: async (url, file) => { log('  downloading ' + url); const b = await fetchRetry(url, 'buf'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, b); log('  ' + (b.length / 1048576).toFixed(1) + ' MB'); }
};

(async () => {
  fs.mkdirSync(CACHE, { recursive: true });
  const prev = fs.existsSync(IDX) ? JSON.parse(fs.readFileSync(IDX, 'utf8')) : { layers: {}, sources: {}, cells: {} };
  const layers = JSON.parse(JSON.stringify(prev.layers || {})), sources = JSON.parse(JSON.stringify(prev.sources || {}));
  const perCell = {};   // layer -> { cellId: [n, gz, parts] } for the layers rebuilt this run
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z'), failed = {};
  for (const src of ORDER) {
    if (!only.includes(src)) continue;
    const mine = LAYERS.filter((l) => l.source === src), t0 = Date.now();
    log('── ' + src);
    try {
      const res = await SOURCES[src].build(ctx);
      Object.assign(ctx.shared, res.shared || {});
      (res.notes || []).forEach((n) => log('  ' + n));
      // every layer first (assign, hash, count), then the guard, then the files: a failing source writes nothing
      const built = {};
      for (const L of mine) {
        const feats = res.layers[L.id];
        if (!feats) { built[L.id] = { missing: true }; continue; }
        const cells = C.assign(feats, L), ids = new Set(); cells.forEach((a) => a.forEach((f) => ids.add(f.id)));
        built[L.id] = { cells, hash: C.hashOf(cells), count: ids.size };
      }
      for (const L of mine) {
        const b = built[L.id], p = layers[L.id];
        if (!b.missing && p && p.count && b.count < p.count * (1 - DROP)) throw new Error(L.id + ' dropped from ' + p.count + ' to ' + b.count + ' features (more than ' + DROP * 100 + ' %): not published');
      }
      let changed = false;
      for (const L of mine) {
        const b = built[L.id], p = layers[L.id];
        if (b.missing) { if (p) { p.stale = true; p.error = 'not built this run (a source it joins failed)'; } log('  ' + L.id + ': not built, previous files kept'); continue; }
        const same = p && p.hash === b.hash && C.layerFiles(ROOT, L.id).length;
        if (same) { delete p.stale; delete p.error; log('  ' + L.id + ': ' + b.count + ' features, unchanged'); continue; }
        const e = C.writeLayer(ROOT, L.id, src, stamp, b.cells);
        perCell[L.id] = e.perCell; changed = true;
        layers[L.id] = { source: src, geometry: L.geometry, licence: L.licence, schemaVersion: C.SCHEMA, updatedAt: stamp, count: e.count, cells: e.cells, bytes: e.bytes, gzBytes: e.gzBytes, maxGz: e.maxGz, hash: b.hash };
        log('  ' + L.id + ': ' + e.count + ' features in ' + e.cells + ' cells, ' + (e.bytes / 1048576).toFixed(1) + ' MB (' + (e.gzBytes / 1048576).toFixed(1) + ' MB gzipped, largest file ' + (e.maxGz / 1024).toFixed(0) + ' kB)' + (p ? ', was ' + p.count : ''));
      }
      if (changed || !sources[src]) sources[src] = Object.assign({}, res.meta, { updatedAt: stamp });
      // a source's single files (osm: intersections.json), written only when their content changed
      for (const [name, data] of Object.entries(res.files || {})) {
        const f = path.join(ROOT, name), s = JSON.stringify(data) + '\n';
        if (!fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== s) { fs.writeFileSync(f, s); log('  ' + name + ' written (' + (s.length / 1024).toFixed(0) + ' kB)'); }
      }
      log('  ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
    } catch (e) {
      failed[src] = e.message; log('  FAILED: ' + e.message);
      for (const L of mine) if (layers[L.id]) { layers[L.id].stale = true; layers[L.id].error = e.message.slice(0, 200); }
    }
  }
  // the cell list: the rebuilt layers' cells, the others' from the previous index
  const cells = {};
  for (const [k, v] of Object.entries(prev.cells || {})) for (const [lid, c] of Object.entries(v)) if (!perCell[lid] && layers[lid]) (cells[k] = cells[k] || {})[lid] = c;
  for (const [lid, pc] of Object.entries(perCell)) for (const [k, c] of Object.entries(pc)) (cells[k] = cells[k] || {})[lid] = [c.n, c.gz, c.parts];
  const sorted = (o) => Object.keys(o).sort().reduce((a, k) => { a[k] = o[k]; return a; }, {});
  const order = LAYERS.map((l) => l.id).filter((id) => layers[id]);
  const index = {
    schemaVersion: C.SCHEMA, base: BASE,
    grid: { crs: 'EPSG:32610', origin: G.ORIGIN, size: G.CELL, bbox: G.BBOX, range: G.RANGE, note: 'cell {x}_{y} covers origin + [x, x + 1] km east and [y, y + 1] km north; a layer split into parts is {layer}.1.json ... {layer}.{parts}.json' },
    sources: sorted(sources),
    layers: order.reduce((a, id) => { a[id] = layers[id]; return a; }, {}),
    cells: Object.keys(cells).sort((a, b) => { const [ax, ay] = a.split('_').map(Number), [bx, by] = b.split('_').map(Number); return ay - by || ax - bx; }).reduce((a, k) => { a[k] = order.filter((l) => cells[k][l]).reduce((o, l) => { o[l] = cells[k][l]; return o; }, {}); return a; }, {})
  };
  fs.writeFileSync(IDX, JSON.stringify(index, null, 1) + '\n');
  writeFixtures(index);
  const stale = Object.entries(index.layers).filter(([, v]) => v.stale).map(([k]) => k);
  log('── index.json: ' + Object.keys(index.cells).length + ' cells, ' + order.length + ' layers' + (stale.length ? '; STALE: ' + stale.join(', ') : ''));
  for (const [s, m] of Object.entries(failed)) console.log('::warning::' + s + ' failed: ' + m);
  process.exit(Object.keys(failed).length === only.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// fixtures/: the cells around the three sites, and an index of just those, laid out as the repository is (the app
// vendors it under test/gis-fixtures/ and reads it offline)
function writeFixtures(index) {
  const want = new Set(), sites = {};
  for (const [k, s] of Object.entries(SITES)) {
    const [cx, cy] = G.cellOf(...G.toUTM(s.lon, s.lat)); sites[k] = Object.assign({ cell: G.cellId(cx, cy) }, s);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) want.add(G.cellId(cx + dx, cy + dy));
  }
  fs.rmSync(FIX, { recursive: true, force: true });
  const cells = {};
  for (const k of [...want].sort()) {
    const src = path.join(ROOT, 'cells', k); if (!fs.existsSync(src) || !index.cells[k]) continue;
    fs.mkdirSync(path.join(FIX, 'cells', k), { recursive: true });
    for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(FIX, 'cells', k, f));
    cells[k] = index.cells[k];
  }
  fs.writeFileSync(path.join(FIX, 'index.json'), JSON.stringify(Object.assign({}, index, { base: null, fixtures: true, cells }), null, 1) + '\n');
  fs.writeFileSync(path.join(FIX, 'sites.json'), JSON.stringify(sites, null, 1) + '\n');
  if (fs.existsSync(path.join(ROOT, 'intersections.json'))) fs.copyFileSync(path.join(ROOT, 'intersections.json'), path.join(FIX, 'intersections.json'));
}
