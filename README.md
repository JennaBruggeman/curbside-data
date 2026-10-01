# curbside-data

The City of Vancouver site data [Curbside](https://github.com/JennaBruggeman/curbside) reads: City open data,
OpenStreetMap and TransLink's bus network, normalised once, offline, into 1 km cells, rebuilt every week.

**Base URL:** `https://jennabruggeman.github.io/curbside-data/` (GitHub Pages; CORS-safe). The app reads it from the
one constant `GIS.BASE`.

## Layout

```
index.json                     the cell list, per-layer updatedAt / counts / sizes / schemaVersion, the sources
cells/{cellId}/{layerId}.json  one GeoJSON FeatureCollection per cell per layer ({layerId}.1.json ... when split)
fixtures/                      the cells around the three test sites (the app vendors them as test/gis-fixtures/)
build/                         the Node scripts: one per source, the cell writer, the checks
.github/workflows/refresh.yml  weekly (Monday 06:00 Pacific) and on demand
```

**Cells.** A 1 km grid in UTM zone 10N (EPSG:32610). The origin is the south-west corner of the app's Vancouver bbox
(`-123.27, 49.19`), floored to the metre: `index.json` › `grid.origin`. Cell `{x}_{y}` covers `origin + [x, x+1] km`
east and `[y, y+1] km` north; x and y can be negative at the edges. Points go in the cell that contains them. Lines are
clipped to every cell they cross and keep their `id` in each, so join the pieces by `id`. Polygons (buildings) are
written whole in every cell they touch, so deduplicating by `id` is exact.

**Schema (schemaVersion 1).** Every feature:
- `id`, stable: `cov:{dataset}:{recordId}`, `osm:{type}:{id}`, `gtfs:stop:{stop_id}`, `gtfs:route:{route_id}:{shape_id}`.
  Datasets without a record id use a hash of the record.
- `properties`: `id`, `layer`, `source` (`cov` | `osm` | `gtfs`), `fetchedAt`, and `props`, which holds **normalised
  names only**. Raw source fields never reach the app.
- Streets and buildings (the geometry the app measures a site from) are written exactly as OpenStreetMap has them, to 7 decimals. The other lines are simplified at 0.5 m (Douglas–Peucker). Points are untouched.
- Coordinates are WGS84 lon / lat, 6 decimals (7 for streets and buildings).
- Each file is at most 200 kB gzipped; a larger one is split into parts, never allowed to grow.

## Layers

| layerId | source | geometry | props |
|---|---|---|---|
| `buildings` | OSM `building=*` ways + City `property-addresses` | polygon | `osmId, address, use, name, kind, levels, height` |
| `streets` | OSM ways, the app's highway classes | line | `wayId, name, highway, oneway (yes/no/reverse), lanes, lanesForward, lanesBackward, width, cycleway {left, right}, parking {left, right}, maxspeed` |
| `bikeways` | City `bikeways` (Active) | line | `type, subtype, name, side` (`side` is `approx`: the data is centreline-based) |
| `truck-routes` | City `truck-routes` | line | `name` |
| `one-way` | City `one-way-streets` | line | `name, use, direction` (bearing of the drawn line) |
| `bus-routes` | TransLink GTFS `routes` + `trips` + `shapes`, bus only | line | `route, name, routeId` |
| `row-width` | City `right-of-way-widths` | point (label) | `width` (m), `widthFt` — property line to property line, **not curb-to-curb** |
| `bus-stops` | TransLink GTFS `stops` + `stop_times` | point | `stopId, code, name, routes[], osm` (the OSM `highway=bus_stop` within 20 m, or null) |
| `hydrants` | City `water-hydrants` | point | `hydrantId` |
| `trees` | City `public-trees` | point | `species, genus, speciesName, cultivar, dbh, height, area` |
| `transit-stations` | City `rapid-transit-stations` | point | `name` |
| `pois` | OSM `amenity` / `shop` / `office` nodes | point | `osmId, name, kind, category, use` |

A building's `use` follows the app's rule: a shop or office inside the building sets it, even in a residential building.
Its `address` is the City civic address inside the footprint that is nearest the centroid, else the one nearest the footprint within 15 m (the app's rule). The City's right-of-way
widths are published in feet with no unit stated; `width` is converted to metres.

## index.json

- `grid`: the CRS, origin, cell size, bbox and cell range.
- `sources`: per source, its name, URL, data date and the time it last changed.
- `layers`: per layer, its source, geometry, licence, `schemaVersion`, `updatedAt` (the build that last changed it),
  `count`, `cells`, `bytes`, `gzBytes`, `hash`. If its source failed, it also has `stale: true` and `error`.
- `cells`: `{cellId: {layerId: [features, gzBytes, parts]}}`.

It holds no run timestamps: a build that changes no data changes no file.

## Build rules

- `node build/build.js [--fresh] [--only=cov,osm,gtfs]`, then `node build/check.js [--sites]`. It needs Node 24 or
  later and no npm package: the PBF and zip readers use Node's zlib.
- Each source is independent. A source that fails, or one of whose layers drops more than 30 % from the last build,
  publishes nothing: its layers keep their previous files and are marked `stale` in `index.json`. The published cell
  set is never partial.
- Each source script has a mapping table at the top (`build/cov.js`, `osm.js`, `gtfs.js`). A City field rename is a
  one-line fix there.
- The downloads go to `.cache/` (git-ignored): the OSM extract (BBBike Vancouver, about 62 MB, weekly) and the GTFS
  feed (about 16 MB). The workflow downloads them fresh each run. The City data is read live from its API.

## Licences and attribution

The build scripts are MIT-licensed. The data keeps its sources' licences, per layer; see [LICENSE.md](LICENSE.md).
In short:

- OpenStreetMap layers: © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
- City layers: contains information licensed under the [Open Government Licence – Vancouver](https://opendata.vancouver.ca/pages/licence/).
- Bus layers: TransLink GTFS, under [TransLink's terms of use](https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources).
