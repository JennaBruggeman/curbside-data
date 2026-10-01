'use strict';
// City of Vancouver Open Data (Open Government Licence - Vancouver): one whole-dataset GeoJSON export per dataset.
// ── The mapping table: a City rename is a one-line fix here. Raw field names end in this file. ─────────────────────
// ds: the dataset id; select: the fields fetched; id: the record's own id field (null: a hash of the record, for the
// datasets without one); keep: which records count; props: the normalised properties the app reads.
const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const s = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const MAP = [
  { layer: 'bikeways', ds: 'bikeways', select: 'object_id,bikeway_type,subtype,bike_route_name,street_name,status', id: 'object_id',
    keep: (r) => r.status === 'Active',                                   // 'Temporarily Removed' segments are not on the street
    props: (r) => ({ type: s(r.bikeway_type), subtype: s(r.subtype), name: s(r.bike_route_name) || s(r.street_name), side: 'approx' }) },   // centreline data: the side is not known
  { layer: 'truck-routes', ds: 'truck-routes', select: 'type', id: null, props: (r) => ({ name: s(r.type) }) },
  { layer: 'one-way', ds: 'one-way-streets', select: 'hblock,streetuse', id: null,
    props: (r, g) => ({ name: s(r.hblock), use: s(r.streetuse), direction: g ? Math.round(g.bearing) : null }) },   // bearing of the drawn line, first to last point
  { layer: 'row-width', ds: 'right-of-way-widths', select: 'width', id: null,
    keep: (r) => n(r.width) > 0,
    props: (r) => ({ width: Math.round(n(r.width) * 0.3048 * 100) / 100, widthFt: n(r.width) }) },   // the dataset states no unit: its values are feet
  { layer: 'hydrants', ds: 'water-hydrants', select: 'id', id: 'id', props: (r) => ({ hydrantId: s(r.id) }) },
  { layer: 'trees', ds: 'public-trees', select: 'asset_id,common_name,genus_name,species_name,cultivar_name,height_m,diameter_cm,local_area', id: 'asset_id',
    props: (r) => ({ species: s(r.common_name), genus: s(r.genus_name), speciesName: s(r.species_name), cultivar: s(r.cultivar_name), dbh: n(r.diameter_cm), height: n(r.height_m), area: s(r.local_area) }) },
  { layer: 'transit-stations', ds: 'rapid-transit-stations', select: 'station', id: null, props: (r) => ({ name: s(r.station) }) },   // (two stations share a name: not an id)
  // the parks the app's city context draws past the import radius (curbside Brief 25 item 29: the import asks the City nothing live)
  { layer: 'parks', ds: 'parks-polygon-representation', select: 'object_id,park_name,classification', id: 'object_id',
    props: (r) => ({ name: s(r.park_name), classification: s(r.classification) }) },
  // not a layer: the civic addresses joined to the buildings (osm.js)
  { shared: 'addresses', ds: 'property-addresses', select: 'civic_number,std_street,site_id', id: 'site_id',
    props: (r) => ({ address: [s(r.civic_number), s(r.std_street)].filter(Boolean).join(' ') || null }) }
];
const BASE = 'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/';

const crypto = require('crypto'), G = require('./lib/geo');
// GeoJSON geometry (lon / lat) -> the cell writer's form (UTM), or null outside the city
function geomOf(g) {
  if (!g || !g.coordinates) return null;
  const U = (p) => G.toUTM(p[0], p[1]), near = (p) => G.nearCity(p[0], p[1]);
  if (g.type === 'Point') return near(g.coordinates) ? { geom: 'Point', utm: U(g.coordinates) } : null;
  const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : null;
  if (lines) {
    if (!lines.some((l) => l.some(near))) return null;
    const utm = lines.map((l) => l.map(U)), a = utm[0][0], z = utm[utm.length - 1][utm[utm.length - 1].length - 1];
    return { geom: 'Lines', utm, bearing: (Math.atan2(z[0] - a[0], z[1] - a[1]) * 180 / Math.PI + 360) % 360 };
  }
  // polygons (the parks): the outer rings with their holes; a MultiPolygon is one feature per part (id #1, #2 ...)
  const rings = (p) => p.map((r) => r.map(U));
  if (g.type === 'Polygon') return g.coordinates[0].some(near) ? { geom: 'Polygon', utm: rings(g.coordinates) } : null;
  if (g.type === 'MultiPolygon') { const parts = g.coordinates.filter((p) => p[0].some(near)).map(rings); return parts.length ? { geom: 'MultiPolygon', parts } : null; }
  return null;
}

async function build(ctx) {
  const layers = {}, shared = {}, notes = [];
  for (const m of MAP) {
    const url = BASE + m.ds + '/exports/geojson?select=' + encodeURIComponent(m.select);
    const fc = await ctx.fetchJSON(url);
    if (!fc || !Array.isArray(fc.features)) throw new Error('cov ' + m.ds + ': not a FeatureCollection');
    const out = []; let kept = 0, outside = 0;
    for (const f of fc.features) {
      const r = f.properties || {};
      if (m.keep && !m.keep(r)) continue;
      const g = geomOf(f.geometry); if (!g) { outside++; continue; }
      const rid = m.id ? s(r[m.id]) : crypto.createHash('sha1').update(JSON.stringify([f.geometry, r])).digest('hex').slice(0, 12);
      if (!rid) continue;
      if (g.geom === 'MultiPolygon') g.parts.forEach((u, k) => out.push({ id: 'cov:' + m.ds + ':' + rid + (g.parts.length > 1 ? '#' + (k + 1) : ''), geom: 'Polygon', utm: u, props: m.props(r, g) }));
      else out.push({ id: 'cov:' + m.ds + ':' + rid, geom: g.geom, utm: g.utm, props: m.props(r, g) });
      kept++;
    }
    // records with the same id (a dataset quirk: e.g. one site_id at two points) are kept once in a layer, the choice made
    // by content, never by the export's order (which differs between fetches); the addresses joined to the buildings keep
    // every point (their ids do not matter there)
    let uniq = out;
    if (!m.shared) {
      const best = new Map(), key = (f) => JSON.stringify([f.utm, f.props]);
      for (const f of out) { const b = best.get(f.id); if (!b || key(f) < key(b)) best.set(f.id, f); }
      uniq = [...best.values()];
    }
    if (m.shared) shared[m.shared] = uniq; else layers[m.layer] = uniq;
    notes.push(m.ds + ': ' + fc.features.length + ' records, ' + uniq.length + ' kept' + (outside ? ', ' + outside + ' outside the city' : '') + (uniq.length < kept ? ', ' + (kept - uniq.length) + ' duplicate ids' : ''));
  }
  return { layers, shared, notes, meta: { name: 'City of Vancouver Open Data', url: 'https://opendata.vancouver.ca/' } };
}
module.exports = { build, MAP };
