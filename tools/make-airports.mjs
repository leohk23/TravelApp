// Builds data/airports.json, the offline IATA index. Run: node tools/make-airports.mjs
//
// Photon indexes airport names but not IATA codes, so "NRT" finds nothing while
// "Narita" works. Overpass can query the iata tag but its public endpoints
// answered 500 or refused outright, which is no basis for a type-ahead.
//
// Source: OurAirports (public domain). Re-run occasionally; the output is
// committed so the app has no build step and works offline.
import { writeFileSync, mkdirSync } from 'node:fs';

const URL_CSV = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const KEEP_TYPES = new Set(['large_airport', 'medium_airport', 'small_airport']);

/** Minimal CSV reader for this file: quoted fields, doubled quotes, no newlines inside. */
function splitRow(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const res = await fetch(URL_CSV);
if (!res.ok) throw new Error(`OurAirports returned ${res.status}`);
const lines = (await res.text()).split('\n');
const head = splitRow(lines[0]);
const col = name => head.indexOf(name);
const [I_TYPE, I_NAME, I_LAT, I_LNG, I_COUNTRY, I_CITY, I_SCHED, I_IATA] =
  ['type', 'name', 'latitude_deg', 'longitude_deg', 'iso_country', 'municipality',
    'scheduled_service', 'iata_code'].map(col);

const rows = [];
for (let i = 1; i < lines.length; i++) {
  if (!lines[i].trim()) continue;
  const r = splitRow(lines[i]);
  const iata = (r[I_IATA] || '').trim().toUpperCase();
  // A three-letter code you could actually fly into.
  if (!/^[A-Z]{3}$/.test(iata)) continue;
  if (!KEEP_TYPES.has(r[I_TYPE])) continue;
  if (r[I_SCHED] !== 'yes' && r[I_TYPE] === 'small_airport') continue;

  const lat = +r[I_LAT], lng = +r[I_LNG];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

  // Size ranks ties: typing "NR" should offer Narita before Weeze.
  const size = r[I_TYPE] === 'large_airport' ? 0 : r[I_TYPE] === 'medium_airport' ? 1 : 2;
  rows.push([iata, r[I_NAME].trim(), (r[I_CITY] || '').trim(), (r[I_COUNTRY] || '').trim(),
    +lat.toFixed(4), +lng.toFixed(4), size]);
}

rows.sort((a, b) => a[0].localeCompare(b[0]));
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
const out = new URL('../data/airports.json', import.meta.url);
// One row per line: readable in a diff, and still plain JSON.
writeFileSync(out, `[\n${rows.map(r => JSON.stringify(r)).join(',\n')}\n]\n`);

const bytes = rows.reduce((n, r) => n + JSON.stringify(r).length + 2, 2);
console.log(`data/airports.json  ${rows.length} airports, ${(bytes / 1024).toFixed(0)} KB`);
for (const c of ['NRT', 'LHR', 'HKG', 'JFK', 'KIX']) {
  const hit = rows.find(r => r[0] === c);
  console.log(`  ${c}: ${hit ? `${hit[1]}, ${hit[2] || hit[3]}` : 'MISSING'}`);
}
