'use strict';
// OpenStreetMap (ODbL 1.0) from the BBBike Vancouver extract (download.bbbike.org, weekly, ~62 MB): the streets the
// app's site map picks from, the buildings (joined here to the City's civic addresses and to the shops and offices
// inside them), and the points of interest. Relations are not read (the app's import never used them).
// ── The mapping: OSM tags -> normalised properties ────────────────────────────────────────────────────────────
const HIGHWAY = /^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)(_link)?$/;   // the app's SM.HIGHWAY
const URL = 'https://download.bbbike.org/osm/bbbike/Vancouver/Vancouver.osm.pbf';
const num = (v) => { const m = /^\s*(-?\d+(\.\d+)?)/.exec(v || ''); return m ? +m[1] : null; };
const oneway = (t) => (t.oneway === '-1' || t.oneway === 'reverse' ? 'reverse' : t.oneway === 'yes' || t.oneway === 'true' || t.oneway === '1' || t.junction === 'roundabout' ? 'yes' : 'no');
const side = (t, k) => t[k + ':left'] || t[k + ':both'] || t[k] || null;
const sideR = (t, k) => t[k + ':right'] || t[k + ':both'] || t[k] || null;
function streetProps(id, t) {
  return { wayId: id, name: t.name || null, highway: t.highway, oneway: oneway(t), lanes: num(t.lanes), lanesForward: num(t['lanes:forward']), lanesBackward: num(t['lanes:backward']),
    width: num(t.width), cycleway: { left: side(t, 'cycleway'), right: sideR(t, 'cycleway') },
    parking: { left: t['parking:left'] || t['parking:lane:left'] || t['parking:both'] || t['parking:lane:both'] || null, right: t['parking:right'] || t['parking:lane:right'] || t['parking:both'] || t['parking:lane:both'] || null },
    maxspeed: num(t.maxspeed) };
}
// the app's SMP.useOf, so a building's use reads the same from the cells as from a live import
function useOf(t) {
  if (!t) return null;
  const a = t.amenity, s = t.shop, b = t.building;
  if (a === 'cafe') return 'cafe';
  if (['restaurant', 'fast_food', 'bar', 'pub', 'food_court', 'ice_cream', 'biergarten'].includes(a)) return 'restaurant';
  if (['school', 'college', 'university', 'library', 'townhall', 'courthouse', 'hospital', 'clinic', 'place_of_worship', 'community_centre', 'police', 'fire_station', 'arts_centre', 'theatre'].includes(a)) return 'institutional';
  if (s === 'vacant' || t.disused === 'yes' || t['disused:shop']) return 'vacant';
  if (s || ['bank', 'pharmacy', 'bureau_de_change'].includes(a)) return 'retail';
  if (t.office) return 'office';
  if (['apartments', 'residential', 'house', 'detached', 'semidetached_house', 'terrace', 'dormitory'].includes(b)) return 'residential';
  if (['retail', 'commercial', 'supermarket', 'kiosk'].includes(b)) return b === 'commercial' ? 'mixed' : 'retail';
  if (b === 'office') return 'office';
  if (['civic', 'public', 'school', 'university', 'hospital', 'church', 'government'].includes(b)) return 'institutional';
  return null;
}

const fs = require('fs'), path = require('path'), G = require('./lib/geo'), PBF = require('./lib/pbf');
// a 50 m bucket index of points (UTM), for "which points lie inside this building"
function bucketIndex(points) { const B = new Map(); for (const p of points) { const k = Math.floor(p.utm[0] / 50) + ',' + Math.floor(p.utm[1] / 50); let a = B.get(k); if (!a) B.set(k, a = []); a.push(p); } return B; }
function inside(B, ring) {
  const b = G.bboxOf(ring), out = [];
  for (let x = Math.floor(b[0] / 50); x <= Math.floor(b[2] / 50); x++) for (let y = Math.floor(b[1] / 50); y <= Math.floor(b[3] / 50); y++) for (const p of B.get(x + ',' + y) || []) if (G.pointInRing(p.utm[0], p.utm[1], ring)) out.push(p);
  return out;
}

async function build(ctx) {
  const file = path.join(ctx.cache, 'Vancouver.osm.pbf');
  if (ctx.fresh || !fs.existsSync(file)) await ctx.download(URL, file);
  // pass: nodes near the city (their coordinates), tagged points; then the ways
  const ids = new Map(); let xs = new Float64Array(1 << 21), ys = new Float64Array(1 << 21), nn = 0;
  const pois = [], stops = [], streets = [], buildings = [];
  const stat = PBF.read(file, {
    node(id, lon, lat, t) {
      if (!G.nearCity(lon, lat)) return;
      const u = G.toUTM(lon, lat);
      if (nn === xs.length) { const a = new Float64Array(nn * 2), b = new Float64Array(nn * 2); a.set(xs); b.set(ys); xs = a; ys = b; }
      xs[nn] = u[0]; ys[nn] = u[1]; ids.set(id, nn++);
      if (!t) return;
      if (t.highway === 'bus_stop') stops.push({ id: 'osm:node:' + id, utm: u, name: t.name || null });
      const cat = t.amenity ? 'amenity' : t.shop ? 'shop' : t.office ? 'office' : null;
      if (cat) pois.push({ id: 'osm:node:' + id, geom: 'Point', utm: u, tags: t, props: { osmId: 'node/' + id, name: t.name || null, kind: t[cat], category: cat, use: useOf(t) } });
    },
    way(id, refs, t) {
      if (!t) return;
      const isStreet = t.highway && HIGHWAY.test(t.highway), isBldg = !!t.building && t.building !== 'no';
      if (!isStreet && !isBldg) return;
      // the resolved runs of the way (nodes outside the city margin break it)
      const runs = []; let cur = [];
      for (const r of refs) { const k = ids.get(r); if (k === undefined) { if (cur.length > 1) runs.push(cur); cur = []; } else cur.push([xs[k], ys[k]]); }
      if (cur.length > 1) runs.push(cur);
      if (isStreet && runs.length) streets.push({ id: 'osm:way:' + id, geom: 'Lines', utm: runs, props: streetProps(id, t) });
      if (isBldg && runs.length === 1 && runs[0].length === refs.length && refs[0] === refs[refs.length - 1] && refs.length >= 4) buildings.push({ id: 'osm:way:' + id, ring: runs[0], tags: t, wayId: id });
    }
  });
  // buildings: the civic address inside (the one nearest the centroid when there are several), the use and name of the
  // shop / office inside (a shop in a residential building makes the frontage a shop, as in the app)
  const addr = bucketIndex((ctx.shared.addresses || []).map((a) => ({ utm: a.utm, address: a.props.address })));
  const poiIdx = bucketIndex(pois);
  const out = buildings.map((b) => {
    const c = b.ring.reduce((a, p) => [a[0] + p[0] / b.ring.length, a[1] + p[1] / b.ring.length], [0, 0]);
    // nearest the centroid; a tie decided by the text, never by the sources' order
    const d = (p) => Math.round(Math.hypot(p.utm[0] - c[0], p.utm[1] - c[1]) * 1000);
    const near = (list) => list.sort((p, q) => d(p) - d(q) || String(p.address || p.id).localeCompare(String(q.address || q.id)))[0] || null;
    const a = near(inside(addr, b.ring)), p = near(inside(poiIdx, b.ring));
    const bUse = useOf(b.tags), pUse = p ? useOf(p.tags) : null;
    const use = pUse && bUse === 'residential' && pUse !== 'residential' ? pUse : (pUse || bUse);
    return { id: b.id, geom: 'Polygon', utm: [b.ring], props: { osmId: 'way/' + b.wayId, address: a ? a.address : null, use, name: (p && p.tags.name) || b.tags.name || null,
      kind: b.tags.building, levels: num(b.tags['building:levels']), height: num(b.tags.height) } };
  });
  ctx.shared.osmBusStops = stops;
  const notes = ['extract ' + (stat.timestamp || '?') + ': ' + stat.nodes + ' nodes, ' + stat.ways + ' ways read; ' + nn + ' nodes near the city',
    streets.length + ' streets, ' + out.length + ' buildings (' + out.filter((b) => b.props.address).length + ' with a City address), ' + pois.length + ' points of interest, ' + stops.length + ' OSM bus stops'];
  if (!(ctx.shared.addresses || []).length) notes.push('no City addresses (the City source failed): buildings are not published this run');
  return { layers: Object.assign({ streets, pois: pois.map((p) => ({ id: p.id, geom: p.geom, utm: p.utm, props: p.props })) }, (ctx.shared.addresses || []).length ? { buildings: out } : {}),
    notes, meta: { name: 'OpenStreetMap contributors (BBBike Vancouver extract)', url: URL, dataAt: stat.timestamp } };
}
module.exports = { build, useOf };
