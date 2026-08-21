// Every data-provider call lives here. All four services are free and need no API key.
//
//   search(), searchAirports()  Photon  https://photon.komoot.io  type-ahead over OSM
//   geocode() Nominatim   https://nominatim.openstreetmap.org   resolve one address
//   route()   Transitous  https://api.transitous.org    public transport routing (MOTIS)
//   timeZoneAt() Open-Meteo https://api.open-meteo.com  timezone from coordinates
//
// Nominatim and Transitous are community-run, so callers debounce and cache
// rather than hammering. Swapping in a paid provider means rewriting this file only.

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_LOOKUP = 'https://nominatim.openstreetmap.org/lookup';
const MOTIS = 'https://api.transitous.org/api/v1/plan';
const MOTIS_STOPS = 'https://api.transitous.org/api/v1/map/stops';
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

import { matchAirports, strandedStop } from './logic.js';

const num = v => (typeof v === 'number' ? v : Number(v));

async function getJSON(url, signal) {
  const r = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${new URL(url).hostname} returned ${r.status}`);
  return r.json();
}

/** OSM tags that mean "somewhere you sleep", for the hotel picker. */
export const STAY_TAGS = [
  'tourism:hotel', 'tourism:hostel', 'tourism:guest_house',
  'tourism:apartment', 'tourism:motel',
];

/**
 * Global airport picker; a trip's destination is the wrong bias for one end.
 *
 * Backed by a committed IATA index rather than Photon, because Photon indexes
 * airport names but not codes: "Narita" matches, "NRT" does not. Overpass can
 * query the iata tag, but its public endpoints answered 500 or refused, which
 * is no basis for a type-ahead. The index also works with no signal.
 *
 * Photon stays as the fallback for anything the index has never heard of.
 */
let airportIndex = null;
const loadAirports = () => (airportIndex ||= fetch(new URL('./data/airports.json', import.meta.url))
  .then(r => (r.ok ? r.json() : Promise.reject(new Error(`airports.json ${r.status}`))))
  .catch(err => { airportIndex = null; throw err; }));

export async function searchAirports(q, signal) {
  const term = q.trim().toLowerCase();
  if (term.length < 2) return [];

  let rows = null;
  try { rows = await loadAirports(); } catch { /* fall through to Photon */ }

  if (rows) {
    const hits = matchAirports(rows, q);
    if (hits.length) return hits;
  }

  return runSearch(q, { tags: ['aeroway:aerodrome'], limit: 8, lang: 'en' }, signal);
}

/** Degrees box around a point. Photon's bbox is a hard filter; lat/lon alone is not. */
function bboxAround({ lat, lng }, km) {
  const dLat = km / 111;
  const dLng = km / (111 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map(n => n.toFixed(4)).join(',');
}

/**
 * Type-ahead place search.
 *   near      {lat,lng} to search around - without it, brand names land anywhere
 *   tags      restrict to OSM categories, e.g. STAY_TAGS
 *   radiusKm  half-width of the hard bbox filter, wide enough for a day trip
 *
 * `lat`/`lon` alone is only a weak nudge: "park hyatt" biased to Tokyo still
 * returns Chennai and Paris first. A bbox actually constrains it, so we box the
 * search and retry unboxed only if that found nothing.
 *
 * Returns [{ name, label, kind, lat, lng }].
 */
export async function search(q, { near, tags, radiusKm = 200, limit = 6, lang = 'en' } = {}, signal) {
  // lang=en matters as much here as it does for cities: without it an English
  // query never reaches a Japanese name, so Hakone and Nikko were simply not
  // found, and what came back was unreadable to an English-speaking traveller.
  const opts = { near, tags, limit, ...(lang ? { lang } : {}) };
  if (!near) return runSearch(q, opts, signal);

  // The box is wide enough for a day trip, not just the city: Mt Fuji, Hakone
  // and Nikko are 80 to 140 km out and a 60 km box hid all of them. Still tight
  // enough to keep "park hyatt" in Tokyo rather than Chennai.
  const hits = await runSearch(q, { ...opts, box: bboxAround(near, radiusKm) }, signal);
  if (hits.length) return hits;
  return runSearch(q, opts, signal);   // nothing near, so look anywhere
}

async function runSearch(q, { near, tags, limit, box, lang }, signal) {
  const u = new URL(PHOTON);
  u.searchParams.set('q', q);
  u.searchParams.set('limit', String(limit));
  if (lang) u.searchParams.set('lang', lang);
  if (near) { u.searchParams.set('lat', near.lat); u.searchParams.set('lon', near.lng); }
  if (box) u.searchParams.set('bbox', box);
  for (const t of tags || []) u.searchParams.append('osm_tag', t);

  const { features = [] } = await getJSON(u, signal);
  return features.map(f => {
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;
    const name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || 'Unnamed';
    const label = [p.street, p.district, p.city, p.county, p.state, p.country]
      .filter(Boolean)
      .filter(v => v !== name)                       // a city is not its own address
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(', ');
    return {
      name, label, lat, lng,
      // Identity, so the same place can be recognised in another language.
      // Position cannot do it: reverse geocoding Dazaifu Tenmangu returns a
      // tree in its grounds.
      osmId: p.osm_id != null ? `${p.osm_type || ''}${p.osm_id}` : null,
      type: p.type,                                  // photon's normalised bucket
      kind: (p.osm_value || p.osm_key || '').replace(/_/g, ' '),
    };
  });
}

/**
 * The same place, named in the local language.
 *
 * Photon answers in one language at a time, and `lang=en` is what lets an
 * English query reach a Japanese name at all. The name on the signs therefore
 * costs a second request, so it is fetched once for a place you actually add
 * rather than on every keystroke. Matched back by OSM id.
 *
 * Returns null when the local index does not answer to the English query,
 * which is common enough to be unremarkable.
 */
export async function otherName(q, opts, osmId, signal) {
  if (!q || !osmId) return null;
  const hits = await search(q, { ...opts, lang: null }, signal).catch(() => []);
  const hit = hits.find(h => h.osmId === osmId);
  return hit ? { name: hit.name || null, label: hit.label || null } : null;
}

/**
 * The opening hours OpenStreetMap holds for a place, as the raw tag.
 *
 * Photon does not carry the tag, but Nominatim will hand back any tag for an
 * OSM id, which is what the search result gave us. One request, made once for
 * a place being added, never while typing.
 *
 * Most places have nothing recorded, so null is the normal answer.
 */
export async function openingHours(osmId, signal) {
  const m = /^([NWR])(\d+)$/.exec(String(osmId || ''));
  if (!m) return null;
  const u = new URL(NOMINATIM_LOOKUP);
  u.searchParams.set('osm_ids', m[1] + m[2]);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('extratags', '1');
  const hits = await getJSON(u, signal).catch(() => []);
  return hits[0]?.extratags?.opening_hours || null;
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

/** IANA timezone at a coordinate, e.g. "Asia/Tokyo". */
export async function timeZoneAt({ lat, lng }, signal) {
  const u = new URL(OPEN_METEO);
  u.searchParams.set('latitude', lat);
  u.searchParams.set('longitude', lng);
  u.searchParams.set('timezone', 'auto');
  u.searchParams.set('forecast_days', '0');
  const { timezone } = await getJSON(u, signal);
  if (!timezone) throw new Error('Could not determine the local timezone.');
  return timezone;
}

const modeLabel = m => (m || '').toLowerCase().replace(/_/g, ' ');

/**
 * Transitous carries overlapping Tokyo feeds and one of them puts an internal
 * route id in route_short_name, so a passenger was shown "3582461" where a line
 * name belongs. Anything that is only digits and long is an id, not a name.
 * Real bus routes keep their kanji (上４６) and survive this.
 */
const isRouteId = v => /^[0-9]{4,}$/.test(String(v || '').trim());

/** Short label for a service: a line code, else its full name, else the mode. */
function routeName(l) {
  const short = String(l.routeShortName || '').trim();
  if (short && !isRouteId(short)) return short;
  const long = String(l.routeLongName || '').trim();
  return long || modeLabel(l.mode);
}

/** Fuller label, preferred where there is room to show it. */
function routeFullName(l) {
  const long = String(l.routeLongName || '').trim();
  if (long) return long;
  return routeName(l);
}

function legLabel(l) {
  if (l.mode === 'WALK') return `walk ${Math.round(l.duration / 60)} min`;
  return `${routeName(l)}  ${l.from?.name ?? '?'} → ${l.to?.name ?? '?'}`;
}

/**
 * Public transport from A to B leaving at `when` (a Date).
 * Returns { seconds, summary, transfers, arrival } or null when nothing runs.
 *
 * `seconds` is measured from `when`, not from the itinerary's own departure, so
 * time spent waiting at the stop is included - that is what a timeline needs.
 */
export async function route(from, to, when, signal) {
  const plan = async (a, b) => {
    const u = new URL(MOTIS);
    u.searchParams.set('fromPlace', `${a.lat},${a.lng}`);
    u.searchParams.set('toPlace', `${b.lat},${b.lng}`);
    u.searchParams.set('time', when.toISOString());
    const res = await getJSON(u, signal);
    return [...(res.itineraries || []), ...(res.direct || [])];
  };

  let options = await plan(from, to);
  let startedAt = null, endedAt = null;

  // Nothing at all usually means one end sits where the walking network never
  // reaches, which is exactly what an airport reference point out on the
  // runway is. Only then is it worth two more requests to find a station to
  // start from; a journey that simply does not run still answers no route.
  if (!options.length) {
    const [ns, nd] = await Promise.all([stopsNear(from, signal), stopsNear(to, signal)]);
    const a = strandedStop(from, ns), b = strandedStop(to, nd);
    if (a || b) {
      options = await plan(a || from, b || to);
      if (options.length) { startedAt = a?.name || null; endedAt = b?.name || null; }
    }
  }
  if (!options.length) return null;

  // Earliest arrival wins; MOTIS returns a pareto set, not a sorted list.
  const best = options.reduce((a, b) => (new Date(b.endTime) < new Date(a.endTime) ? b : a));
  const arrival = new Date(best.endTime);
  const ridden = (best.legs || []).filter(l => l.mode !== 'WALK');
  return {
    seconds: Math.max(60, Math.round((arrival - when) / 1000)),
    summary: (best.legs || []).map(legLabel).join('  →  '),
    transfers: best.transfers ?? 0,
    arrival: arrival.toISOString(),
    // Every step, walking included, so the journey can be shown in full.
    steps: (best.legs || []).map(l => ({
      mode: l.mode || '',
      line: routeName(l),
      lineName: routeFullName(l),        // the full name, for the journey view
      headsign: l.headsign || '',
      agency: l.agencyName || '',
      from: l.from?.name || '', to: l.to?.name || '',
      fromPt: l.from?.lat != null ? { lat: l.from.lat, lng: l.from.lon } : null,
      toPt: l.to?.lat != null ? { lat: l.to.lat, lng: l.to.lon } : null,
      seconds: l.duration ?? 0,
      metres: l.distance != null ? Math.round(l.distance) : null,
      // Kept encoded rather than decoded: a leg is a few hundred points, and
      // this whole object is persisted to localStorage on every recalc.
      shape: l.legGeometry?.points || null,
      shapePrecision: l.legGeometry?.precision ?? 5,
      stops: l.intermediateStops?.length ?? null,
      startTime: l.startTime || '', endTime: l.endTime || '',
    })),
    // Which services you actually ride, used to recognise a repeated journey.
    lines: ridden.map(l => ({
      line: routeName(l),
      from: l.from?.name || '', to: l.to?.name || '',
      mode: l.mode || '',          // picks the fare table: a bus is not a metro
    })),
    // No agency in the feeds tested publishes GTFS fares, so there is no amount
    // to read. Some publish a link to their fare page, which is the next best.
    fare: null,
    fareUrl: ridden.find(l => l.agencyFareUrl)?.agencyFareUrl || null,
    // Set when an end had to be moved to a station to be routable at all, so
    // the journey view can say where the clock really starts.
    startedAt, endedAt,
  };
}

/**
 * Stops the router knows about within about 3 km of a point, from MOTIS's own
 * stop index. Only reached when a plan came back empty, so it costs nothing
 * on the ordinary path.
 */
async function stopsNear(pt, signal, km = 3) {
  const d = km / 111;
  const u = new URL(MOTIS_STOPS);
  u.searchParams.set('min', `${pt.lat - d},${pt.lng - d}`);
  u.searchParams.set('max', `${pt.lat + d},${pt.lng + d}`);
  const j = await getJSON(u, signal).catch(() => null);
  return Array.isArray(j) ? j.map(s => ({ ...s, lng: s.lon })) : [];
}

/** Metres between two points. Used to order stops when no transit matrix is free. */
export function haversine(a, b) {
  const R = 6371000, rad = d => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * City search for labelling a day.
 *
 * Deliberately not tag-filtered: Tokyo is `place=province` in OSM, so any
 * osm_tag list that looks right still misses it. Photon's normalised `type`
 * does catch it, but only after the fact - hence over-fetching and filtering
 * here. `lang=en` matters too: without it "tokyo" never matches 東京都.
 *
 * Global on purpose. The next city on a trip can be anywhere.
 */
const CITY_TYPES = new Set(['city', 'district', 'county', 'state']);

export async function searchCity(q, signal) {
  const hits = await runSearch(q, { limit: 25, lang: 'en' }, signal);
  return hits
    .filter(h => CITY_TYPES.has(h.type))
    // Proper cities first; sort is stable, so Photon's ranking survives within
    // each group and regions like "Kyoto Prefecture" fall below "Kyoto".
    .sort((a, b) => (a.type === 'city' ? 0 : 1) - (b.type === 'city' ? 0 : 1))
    .slice(0, 6);
}
