// Builds the outline map the app ships with, from Natural Earth's public-domain data.
//
//   node tools/build-map.mjs <folder with the two GeoJSON files>
//
// The folder holds, from https://github.com/nvkelso/natural-earth-vector (tag v5.1.2, folder geojson):
//   ne_50m_admin_0_countries.geojson         every country, at 1:50 million
//   ne_10m_admin_1_states_provinces.geojson  states, provinces and counties, at 1:10 million
//
// The result is one TopoJSON file with two layers. `countries` holds every
// country but those of DIVIDED, which come in `regions` as their states,
// provinces or counties, so that their outline is drawn once. Only a name is
// kept for each shape. The file is committed; run this again only to change
// what the map shows.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quantize } from 'topojson-client';
import { topology } from 'topojson-server';
import { presimplify, quantile, simplify } from 'topojson-simplify';

/** Countries drawn with their divisions: those of the region priority, and Canada beside the United States. */
const DIVIDED = ['USA', 'CAN', 'NLD', 'GBR', 'IRL', 'AUS', 'NZL'];
/** How much of the detail is kept: the share of points, counted from the most telling. */
const KEEP = 0.3;
/** Coordinates are stored as whole numbers on a grid this fine. */
const GRID = 2e4;

const folder = process.argv[2];
if (!folder) throw new Error('give the folder that holds the Natural Earth GeoJSON files');
const read = (name) => JSON.parse(readFileSync(join(folder, name), 'utf8'));

const named = (feature, name) => ({
  type: 'Feature',
  properties: { name },
  geometry: feature.geometry,
});

// Both files name the country a shape belongs to by Natural Earth's own three
// letters, so a country that is left out of one layer is whole in the other. Its
// ISO code would not do: outlying islands carry another, or none.

const countries = read('ne_50m_admin_0_countries.geojson')
  .features.filter((feature) => !DIVIDED.includes(feature.properties.ADM0_A3))
  .map((feature) => named(feature, feature.properties.NAME));
const regions = read('ne_10m_admin_1_states_provinces.geojson')
  .features.filter((feature) => DIVIDED.includes(feature.properties.adm0_a3) && feature.geometry)
  .map((feature) => named(feature, feature.properties.name ?? ''));

const collection = (features) => ({ type: 'FeatureCollection', features });
const whole = topology({ countries: collection(countries), regions: collection(regions) });
const weighed = presimplify(whole);
const map = quantize(simplify(weighed, quantile(weighed, KEEP)), GRID);

const out = fileURLToPath(
  new URL('../apps/desktop/src/renderer/src/assets/world.json', import.meta.url),
);
let points = 0;
for (const arc of map.arcs) points += arc.length;
const text = JSON.stringify(map);
writeFileSync(out, text);
console.log(
  `${countries.length} countries, ${regions.length} regions, ${points} points, ` +
    `${Math.round(text.length / 1024)} KB -> ${out}`,
);
