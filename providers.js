// Every remote call lives here. All three services are free and need no API key.
//
//   search()  Photon      https://photon.komoot.io      type-ahead over OSM
//   geocode() Nominatim   https://nominatim.openstreetmap.org   resolve one address
//   route()   Transitous  https://api.transitous.org    public transport routing (MOTIS)
//
// Nominatim allows 1 request/second and Transitous is community-run, so callers
// throttle and cache rather than hammering. Swapping in a paid provider means
// rewriting this file only.

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const MOTIS = 'https://api.transitous.org/api/v1/plan';

const num = v => (typeof v === 'number' ? v : Number(v));

async function getJSON(url, signal) {
  const r = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${new URL(url).hostname} returned ${r.status}`);
  return r.json();
}

/**
 * Type-ahead place search. `near` ({lat,lng}) biases results, which matters a
 * lot: unbiased, "tim ho wan" finds nothing useful.
 * Returns [{ name, label, kind, lat, lng }].
 */
export async function search(q, near, signal) {
  const u = new URL(PHOTON);
  u.searchParams.set('q', q);
  u.searchParams.set('limit', '6');
  if (near) { u.searchParams.set('lat', near.lat); u.searchParams.set('lon', near.lng); }

  const { features = [] } = await getJSON(u, signal);
  return features.map(f => {
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;
    const name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || 'Unnamed';
    const label = [p.street !== name ? p.street : null, p.district, p.city, p.state, p.country]
      .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
    return { name, label, kind: (p.osm_value || p.osm_key || '').replace(/_/g, ' '), lat, lng };
  });
}

/** Resolve a single typed/pasted address. Nominatim ranks better than Photon here. */
export async function geocode(q, signal) {
  const u = new URL(NOMINATIM);
  u.searchParams.set('q', q);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('limit', '1');

  const hits = await getJSON(u, signal);
  if (!hits.length) throw new Error(`Not found: ${q}`);
  const h = hits[0];
  return { name: q, address: h.display_name, lat: num(h.lat), lng: num(h.lon), stayMin: 60 };
}

const modeLabel = m => (m || '').toLowerCase().replace(/_/g, ' ');

function legLabel(l) {
  if (l.mode === 'WALK') return `walk ${Math.round(l.duration / 60)} min`;
  const line = l.routeShortName || l.routeLongName || modeLabel(l.mode);
  return `${line} · ${l.from?.name ?? '?'} → ${l.to?.name ?? '?'}`;
}

/**
 * Public transport from A to B leaving at `when` (a Date).
 * Returns { seconds, summary, transfers, arrival } or null when nothing runs.
 *
 * `seconds` is measured from `when`, not from the itinerary's own departure, so
 * time spent waiting at the stop is included - that is what a timeline needs.
 */
export async function route(from, to, when, signal) {
  const u = new URL(MOTIS);
  u.searchParams.set('fromPlace', `${from.lat},${from.lng}`);
  u.searchParams.set('toPlace', `${to.lat},${to.lng}`);
  u.searchParams.set('time', when.toISOString());

  const res = await getJSON(u, signal);
  const options = [...(res.itineraries || []), ...(res.direct || [])];
  if (!options.length) return null;

  // Earliest arrival wins; MOTIS returns a pareto set, not a sorted list.
  const best = options.reduce((a, b) => (new Date(b.endTime) < new Date(a.endTime) ? b : a));
  const arrival = new Date(best.endTime);
  return {
    seconds: Math.max(60, Math.round((arrival - when) / 1000)),
    summary: (best.legs || []).map(legLabel).join('  →  '),
    transfers: best.transfers ?? 0,
    arrival: arrival.toISOString(),
    fare: null, // Transitous carries no fare data; add fares by hand on the leg
  };
}

/** Metres between two points. Used to order stops when no transit matrix is free. */
export function haversine(a, b) {
  const R = 6371000, rad = d => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
