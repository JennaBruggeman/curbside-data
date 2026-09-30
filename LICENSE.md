# Licences

This repository holds two kinds of content under different terms.

## The build scripts (`build/`, `.github/`)

MIT License

Copyright (c) 2026 Jenna Bruggeman

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## The data (`cells/`, `fixtures/`, `index.json`)

The cells are derived from three sources and keep each source's licence. Each layer's licence is also in
`index.json` › `layers.{id}.licence`.

| Layers | Source | Licence | Attribution to show |
|---|---|---|---|
| `streets`, `pois`; `buildings` (footprints, name, kind, levels, height, use) | OpenStreetMap, via the BBBike Vancouver extract | Open Database License 1.0 (ODbL): <https://opendatacommons.org/licenses/odbl/1-0/>. The cells are a Derivative Database, offered under the ODbL. | © OpenStreetMap contributors (<https://www.openstreetmap.org/copyright>) |
| `bikeways`, `truck-routes`, `one-way`, `row-width`, `hydrants`, `trees`, `transit-stations`; `buildings` › `address` | City of Vancouver Open Data | Open Government Licence – Vancouver: <https://opendata.vancouver.ca/pages/licence/> | Contains information licensed under the Open Government Licence – Vancouver |
| `bus-routes`, `bus-stops` (the `osm` match is ODbL, as above) | TransLink GTFS static feed | TransLink's terms of use for its GTFS data: <https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources> | Route and stop data: TransLink |

The data is provided as is, without warranty. It is indicative and must be verified on site before it is relied on.
