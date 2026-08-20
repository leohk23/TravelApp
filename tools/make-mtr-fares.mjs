// Builds data/mtr-fares.json, exact MTR station-to-station fares.
// Run: node tools/make-mtr-fares.mjs
//
// MTR publishes its full fare table as open CSV with no key and no
// registration, which makes Hong Kong the one city where the app can quote a
// real fare rather than a distance-band guess.
//
// Source: https://opendata.mtr.com.hk/ (MTR open data). Re-run when fares are
// revised; the output is committed so the app has no build step.
import { writeFileSync, mkdirSync } from 'node:fs';

const CSV = 'https://opendata.mtr.com.hk/data/mtr_lines_fares.csv';

function splitRow(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const res = await fetch(CSV);
if (!res.ok) throw new Error(`MTR open data returned ${res.status}`);
const lines = (await res.text()).split('\n');
const head = splitRow(lines[0]).map(h => h.trim());
const col = name => {
  const i = head.indexOf(name);
  if (i < 0) throw new Error(`column ${name} missing; the feed's shape changed`);
  return i;
};
const [SRC, DEST, OCT, SINGLE] =
  ['SRC_STATION_NAME', 'DEST_STATION_NAME', 'OCT_ADT_FARE', 'SINGLE_ADT_FARE'].map(col);

const index = new Map();          // station name -> index
const stations = [];
const idOf = name => {
  if (!index.has(name)) { index.set(name, stations.length); stations.push(name); }
  return index.get(name);
};

const fares = {};
let rows = 0, skipped = 0;
for (let i = 1; i < lines.length; i++) {
  if (!lines[i].trim()) continue;
  const r = splitRow(lines[i]);
  const from = (r[SRC] || '').trim(), to = (r[DEST] || '').trim();
  if (!from || !to || from === to) continue;

  const oct = Number(r[OCT]), single = Number(r[SINGLE]);
  if (!Number.isFinite(oct) || oct <= 0) { skipped++; continue; }

  // Fares are symmetric, so one entry per unordered pair halves the file.
  const a = idOf(from), b = idOf(to);
  const key = a < b ? `${a}-${b}` : `${b}-${a}`;
  if (key in fares) continue;
  fares[key] = Number.isFinite(single) && single > 0 && single !== oct
    ? [oct, single]
    : [oct];
  rows++;
}

mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
const out = {
  updated: new Date().toISOString().slice(0, 10),
  source: CSV,
  note: 'Adult MTR fares. Each entry is [octopus] or [octopus, single] when they differ. '
    + 'Station names are as MTR publishes them, which is how the router names them too.',
  currency: 'HKD',
  match: ['mtr', '港鐵', 'mtr rail'],
  stations,
  fares,
};
writeFileSync(new URL('../data/mtr-fares.json', import.meta.url), JSON.stringify(out) + '\n');

console.log(`data/mtr-fares.json  ${stations.length} stations, ${rows} pairs`
  + `${skipped ? `, ${skipped} rows skipped` : ''}`);

const show = (a, b) => {
  const i = index.get(a), j = index.get(b);
  const k = i < j ? `${i}-${j}` : `${j}-${i}`;
  console.log(`  ${a} to ${b}: ${fares[k] ? fares[k].join(' / ') : 'MISSING'}`);
};
show('Central', 'Tsim Sha Tsui');
show('Central', 'Tung Chung');
show('Hong Kong', 'Airport');
show('Admiralty', 'Kowloon Tong');
