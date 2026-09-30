'use strict';
// TransLink GTFS static feed (TransLink's GTFS terms of use): bus routes as their shapes, and bus stops with the routes
// that serve them. Each stop is checked against OpenStreetMap's highway=bus_stop nodes (osm.js): `osm` names the OSM
// stop within 20 m, or is null.
// ── The mapping: GTFS columns -> normalised properties ────────────────────────────────────────────────────────
const URL = 'https://gtfs-static.translink.ca/gtfs/google_transit.zip';
const BUS = new Set(['3']);   // route_type 3 = bus (1 SkyTrain, 2 West Coast Express, 4 SeaBus, 715 on-demand: not bus routes here)
const MATCH_M = 20;

const fs = require('fs'), path = require('path'), G = require('./lib/geo'), Z = require('./lib/zip');
async function build(ctx) {
  const file = path.join(ctx.cache, 'google_transit.zip');
  if (ctx.fresh || !fs.existsSync(file)) await ctx.download(URL, file);
  const zip = Z.entries(file), read = (n, cols) => { if (!zip[n]) throw new Error('gtfs: ' + n + ' missing'); return Z.csv(zip[n]().toString('utf8'), cols); };
  const info = (read('feed_info.txt')[0] || {});
  const routes = new Map(read('routes.txt', ['route_id', 'route_short_name', 'route_long_name', 'route_type']).filter((r) => BUS.has(r.route_type)).map((r) => [r.route_id, r]));
  const trips = read('trips.txt', ['route_id', 'trip_id', 'shape_id']).filter((t) => routes.has(t.route_id));
  const tripRoute = new Map(trips.map((t) => [t.trip_id, t.route_id]));
  // bus routes: every shape a bus route's trips use, as a line
  const shapeRoute = new Map(); trips.forEach((t) => { if (t.shape_id && !shapeRoute.has(t.shape_id)) shapeRoute.set(t.shape_id, t.route_id); });
  const pts = new Map();
  for (const r of read('shapes.txt', ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'])) {
    if (!shapeRoute.has(r.shape_id)) continue;
    let a = pts.get(r.shape_id); if (!a) pts.set(r.shape_id, a = []);
    a.push([+r.shape_pt_sequence, +r.shape_pt_lon, +r.shape_pt_lat]);
  }
  const lines = [];
  for (const [sid, a] of pts) {
    a.sort((p, q) => p[0] - q[0]);
    if (!a.some((p) => G.nearCity(p[1], p[2]))) continue;
    const route = routes.get(shapeRoute.get(sid));
    lines.push({ id: 'gtfs:route:' + route.route_id + ':' + sid, geom: 'Lines', utm: [a.map((p) => G.toUTM(p[1], p[2]))],
      props: { route: route.route_short_name || null, name: route.route_long_name || null, routeId: route.route_id } });
  }
  // bus stops: the stops a bus trip calls at, with the routes (short names) that call there
  const served = new Map();
  for (const st of read('stop_times.txt', ['trip_id', 'stop_id'])) {
    const rid = tripRoute.get(st.trip_id); if (!rid) continue;
    let s = served.get(st.stop_id); if (!s) served.set(st.stop_id, s = new Set());
    s.add(routes.get(rid).route_short_name || rid);
  }
  const osm = ctx.shared.osmBusStops || [], idx = new Map();
  osm.forEach((o) => { const k = Math.floor(o.utm[0] / 50) + ',' + Math.floor(o.utm[1] / 50); let a = idx.get(k); if (!a) idx.set(k, a = []); a.push(o); });
  const nearOsm = (u) => { let best = null, bd = MATCH_M; for (let x = Math.floor(u[0] / 50) - 1; x <= Math.floor(u[0] / 50) + 1; x++) for (let y = Math.floor(u[1] / 50) - 1; y <= Math.floor(u[1] / 50) + 1; y++) for (const o of idx.get(x + ',' + y) || []) { const d = Math.hypot(o.utm[0] - u[0], o.utm[1] - u[1]); if (d <= bd) { bd = d; best = o; } } return best; };
  const stops = [];
  for (const s of read('stops.txt', ['stop_id', 'stop_code', 'stop_name', 'stop_lat', 'stop_lon', 'location_type'])) {
    if (s.location_type && s.location_type !== '0') continue;
    const rs = served.get(s.stop_id); if (!rs) continue;
    const lon = +s.stop_lon, lat = +s.stop_lat; if (!G.nearCity(lon, lat)) continue;
    const u = G.toUTM(lon, lat), o = osm.length ? nearOsm(u) : null;
    stops.push({ id: 'gtfs:stop:' + s.stop_id, geom: 'Point', utm: u,
      props: { stopId: s.stop_id, code: s.stop_code || null, name: s.stop_name || null, routes: [...rs].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })), osm: o ? o.id.replace(/^osm:node:/, 'node/') : null } });
  }
  const notes = ['feed ' + (info.feed_version || '?') + ' (' + (info.feed_start_date || '?') + ' to ' + (info.feed_end_date || '?') + '): ' + routes.size + ' bus routes, ' + lines.length + ' shapes in the city, ' + stops.length + ' bus stops' +
    (osm.length ? ' (' + stops.filter((s) => s.props.osm).length + ' with an OSM stop within ' + MATCH_M + ' m)' : ' (no OSM stops to check against this run)')];
  return { layers: { 'bus-routes': lines, 'bus-stops': stops }, notes, meta: { name: 'TransLink GTFS', url: URL, feedVersion: info.feed_version || null } };
}
module.exports = { build };
