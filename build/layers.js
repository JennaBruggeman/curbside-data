'use strict';
// The layers this repository publishes (schemaVersion 1), in the app's drawing order: polygons, lines, points.
// source: the build script that makes the layer; licence: the terms its data comes under (README, "Licences").
module.exports = [
  { id: 'parks',            source: 'cov',  geometry: 'polygon', licence: 'OGL-Vancouver', props: ['name', 'classification'] },
  { id: 'buildings',        source: 'osm',  geometry: 'polygon', exact: true, licence: 'ODbL-1.0 + OGL-Vancouver', props: ['osmId', 'address', 'use', 'name', 'kind', 'levels', 'height'] },
  { id: 'streets',          source: 'osm',  geometry: 'line',    exact: true, licence: 'ODbL-1.0', props: ['wayId', 'name', 'highway', 'oneway', 'lanes', 'lanesForward', 'lanesBackward', 'width', 'cycleway', 'parking', 'maxspeed'] },
  { id: 'bikeways',         source: 'cov',  geometry: 'line',    licence: 'OGL-Vancouver', props: ['type', 'subtype', 'name', 'side'] },
  { id: 'truck-routes',     source: 'cov',  geometry: 'line',    licence: 'OGL-Vancouver', props: ['name'] },
  { id: 'one-way',          source: 'cov',  geometry: 'line',    licence: 'OGL-Vancouver', props: ['name', 'use', 'direction'] },
  { id: 'blockfaces',       source: 'derived', geometry: 'line', licence: 'ODbL-1.0 + OGL-Vancouver + TransLink GTFS (derived)', props: ['wayId', 'name', 'side', 'offM', 'eligibility', 'reasons', 'detail', 's0', 's1', 'faceLen', 'route'] },
  { id: 'bus-routes',       source: 'gtfs', geometry: 'line',    licence: 'TransLink GTFS', props: ['route', 'name', 'routeId'] },
  { id: 'row-width',        source: 'cov',  geometry: 'point',   licence: 'OGL-Vancouver', props: ['width', 'widthFt'] },
  { id: 'bus-stops',        source: 'gtfs', geometry: 'point',   licence: 'TransLink GTFS + ODbL-1.0', props: ['stopId', 'code', 'name', 'routes', 'osm'] },
  { id: 'hydrants',         source: 'cov',  geometry: 'point',   licence: 'OGL-Vancouver', props: ['hydrantId'] },
  { id: 'trees',            source: 'cov',  geometry: 'point',   licence: 'OGL-Vancouver', props: ['species', 'genus', 'speciesName', 'cultivar', 'dbh', 'height', 'area'] },
  { id: 'transit-stations', source: 'cov',  geometry: 'point',   licence: 'OGL-Vancouver', props: ['name'] },
  { id: 'pois',             source: 'osm',  geometry: 'point',   licence: 'ODbL-1.0', props: ['osmId', 'name', 'kind', 'category', 'use'] }
];
