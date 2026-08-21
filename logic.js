// Pure logic. No DOM, no Google. Imported by app.js and test.mjs.

export const pad = n => String(n).padStart(2, '0');

const zonedParts = (date, timeZone) => Object.fromEntries(
  new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date)
    .filter(p => p.type !== 'literal')
    .map(p => [p.type, +p.value]),
);

/** A date/time entered in the destination's timezone, returned as an instant. */
export function zonedDateTime(dateISO, time, timeZone, now = new Date()) {
  if (!dateISO) {
    const p = zonedParts(now, timeZone);
    dateISO = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  }
  const [year, month, day] = dateISO.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = instant => {
    const p = zonedParts(new Date(instant), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
  };

  // Twice handles an offset change between the UTC guess and the local instant.
  let instant = wall - offsetAt(wall);
  instant = wall - offsetAt(instant);
  const out = new Date(instant);
  const actual = zonedParts(out, timeZone);
  if ([actual.year, actual.month, actual.day, actual.hour, actual.minute].join() !==
      [year, month, day, hour, minute].join()) {
    throw new Error(`${time} does not exist in ${timeZone} on ${dateISO}.`);
  }
  return out;
}

/**
 * How long a flight actually takes, from the two local times printed on the
 * ticket and the timezone at each end.
 *
 * Subtracting them naively gives 4h 45 for an 08:20 Hong Kong departure landing
 * at 13:05 in Fukuoka. The flight is 3h 45; the extra hour is the timezone.
 * Returns null unless both zones are known, because a confident wrong duration
 * is worse than none.
 */
export function flightSeconds(startISO, endISO, tzFrom, tzTo) {
  if (!startISO || !endISO || !tzFrom || !tzTo) return null;
  const split = v => [v.slice(0, 10), v.slice(11, 16)];
  try {
    const [d1, t1] = split(startISO), [d2, t2] = split(endISO);
    if (!t1 || !t2) return null;
    const secs = (zonedDateTime(d2, t2, tzTo) - zonedDateTime(d1, t1, tzFrom)) / 1000;
    return secs > 0 ? secs : null;
  } catch { return null; }
}

/**
 * An amount as a person writes it: the currency's own sign in front, thousands
 * grouped, and no decimals. 156000 JPY reads as ¥156,000, not JPY 156000.00.
 *
 * Rounded for **display only**. What is stored is what was entered, and every
 * input keeps its cents, so a 5.50 fare is still 5.50 when you go back to it.
 *
 * A trip may carry a currency nobody has heard of - the field is free text -
 * so an unknown code falls back to grouped digits behind the code itself.
 */
export function fmtMoney(amount, currency) {
  const n = Number(amount) || 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${currency || ''} ${Math.round(n).toLocaleString()}`.trim();
  }
}

/** minutes-since-midnight -> "09:05" (with " +1" for next day) */
export function fmtTime(m) {
  const h = Math.floor(m / 60), d = Math.floor(h / 24);
  return `${pad(h % 24)}:${pad(m % 60)}${d ? ` +${d}` : ''}`;
}

export function fmtDur(sec) {
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${pad(m % 60)}`;
}

/**
 * Order stops to minimise total travel time.
 * M[i][j] = seconds from i to j. pinFirst keeps stop 0 as the start (your hotel).
 * ponytail: nearest-neighbour + 2-opt recomputing full path cost. Optimal enough
 * for a day's stops; swap for delta-eval or held-karp only if days get huge.
 */
export function optimizeOrder(M, pinFirst = true) {
  const n = M.length;
  if (n < 3) return [...Array(n).keys()];

  const left = new Set([...Array(n).keys()].slice(1));
  const p = [0];
  while (left.size) {
    let best = null, bc = Infinity;
    for (const j of left) if (M[p[p.length - 1]][j] < bc) { bc = M[p[p.length - 1]][j]; best = j; }
    p.push(best); left.delete(best);
  }

  const cost = o => o.slice(1).reduce((s, v, k) => s + M[o[k]][v], 0);
  const lo = pinFirst ? 1 : 0;
  for (let improved = true; improved;) {
    improved = false;
    for (let i = lo; i < n - 1 && !improved; i++) {
      for (let j = i + 1; j < n; j++) {
        const q = [...p.slice(0, i), ...p.slice(i, j + 1).reverse(), ...p.slice(j + 1)];
        if (cost(q) < cost(p) - 1e-9) { p.splice(0, n, ...q); improved = true; break; }
      }
    }
  }
  return p;
}

/** A day item is a real place only when it carries coordinates. */
export const isPlace = it => typeof it?.lat === "number" && typeof it?.lng === "number";

/**
 * Consecutive place pairs, skipping free-form items.
 * [Hotel, "breakfast", Museum] yields one pair: Hotel -> Museum.
 * Returned as [originIndex, destIndex]; legs are stored under originIndex.
 */
export function placePairs(items) {
  const out = [];
  let last = null;
  items.forEach((it, i) => {
    if (!isPlace(it)) return;
    if (last !== null) out.push([last, i]);
    last = i;
  });
  return out;
}

/** "22:00" -> 1320 minutes since midnight. null when it is not a clock time. */
export function clockOf(hhmm) {
  const s = String(hhmm || '');
  if (s.length < 4 || s.length > 5 || s[s.length - 3] !== ':') return null;
  const h = +s.slice(0, s.length - 3), m = +s.slice(-2);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

/** "2026-09-12T08:20" -> 500 minutes since midnight. null when there is no time. */
export function clockMinutes(dt) {
  const s = String(dt || '');
  if (s.length < 16 || s[10] !== 'T' || s[13] !== ':') return null;
  const h = +s.slice(11, 13), m = +s.slice(14, 16);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

/**
 * Walk the day: items may be places (routed between) or free-form entries that
 * only take up time. legs[originIndex] = { seconds } for the hop leaving that
 * place. Returns interleaved rows with times in minutes-since-midnight.
 *
 * An item carrying `at` is a stop you hold a ticket for, and it happens when
 * the ticket says rather than wherever the running total has drifted to. Its
 * clock is the one printed on the ticket, so a departure airport reads in its
 * own timezone and the row after it reads in the destination's.
 */
export function scheduleDay(items, legs = [], startTime = "09:00") {
  let t = clockOf(startTime) ?? 9 * 60;
  const out = [];
  let lastPlace = null;

  items.forEach((it, i) => {
    if (isPlace(it) && lastPlace !== null) {
      const leg = legs[lastPlace] || null;
      const min = leg ? Math.round(leg.seconds / 60) : null;
      out.push({ type: "leg", from: lastPlace, to: i, min, leg });
      if (min != null) t += min;
    }
    const pinned = clockMinutes(it.at);
    if (pinned != null) t = pinned;
    const stay = it.stayMin ?? 60;
    out.push({ type: "item", i, arrive: t, depart: t + stay, place: isPlace(it), pinned: pinned != null });
    t += stay;
    if (isPlace(it)) lastPlace = i;
  });
  return out;
}

const r2 = v => Math.round(v * 100) / 100;

/**
 * Reorder a day's stops to cut travel, moving only what is yours to move.
 *
 * A stop derived from a booking sits where the clock puts it: you land at the
 * airport when the plane lands and check in when you check in. Shuffling those
 * put the arrival airport after the afternoon sights until the next rebuild
 * quietly undid it. They now hold their positions, as free-form notes already
 * did, and the journey is optimised for the stops in between.
 *
 * The last fixed place before the first movable one anchors the route, so the
 * order is the best way round *starting from your hotel* rather than the best
 * loop in the abstract. `dist(a, b)` supplies the cost; no free transit matrix
 * exists, so callers pass straight-line distance.
 *
 * Returns a new items array, or null when there is nothing worth reordering.
 */
export function optimizeDay(items, dist) {
  const movable = it => isPlace(it) && !it.flightId && !it.hotelId;
  const slots = items.map((it, i) => (movable(it) ? i : -1)).filter(i => i >= 0);
  if (!slots.length) return null;

  const anchorAt = items.slice(0, slots[0]).reduce((k, it, i) => (isPlace(it) ? i : k), -1);
  const anchor = anchorAt >= 0 ? items[anchorAt] : null;
  const places = anchor ? [anchor, ...slots.map(i => items[i])] : slots.map(i => items[i]);
  if (places.length < 4) return null;

  const M = places.map(a => places.map(b => dist(a, b)));
  const order = optimizeOrder(M, true);
  const offset = anchor ? 1 : 0;
  const next = [...items];
  slots.forEach((slot, k) => { next[slot] = places[order[k + offset]]; });
  return next;
}

/**
 * Split expenses evenly among each expense's sharedBy list, then settle up with
 * the fewest sensible transfers (greedy biggest-debtor -> biggest-creditor).
 */
export function settleUp(expenses, members) {
  const bal = Object.fromEntries(members.map(m => [m, 0]));
  for (const e of expenses) {
    const share = (e.sharedBy || []).filter(m => m in bal);
    const amt = Number(e.amount) || 0;
    if (!share.length || !amt) continue;
    if (e.payer in bal) bal[e.payer] += amt;
    for (const m of share) bal[m] -= amt / share.length;
  }
  const debt = [], cred = [];
  for (const [m, v] of Object.entries(bal)) {
    const x = r2(v);
    if (x < -0.005) debt.push([m, -x]);
    else if (x > 0.005) cred.push([m, x]);
  }
  debt.sort((a, b) => b[1] - a[1]);
  cred.sort((a, b) => b[1] - a[1]);
  const transfers = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const amt = r2(Math.min(debt[i][1], cred[j][1]));
    if (amt > 0) transfers.push({ from: debt[i][0], to: cred[j][0], amount: amt });
    debt[i][1] -= amt; cred[j][1] -= amt;
    if (debt[i][1] < 0.005) i++;
    if (cred[j][1] < 0.005) j++;
  }
  for (const k in bal) bal[k] = r2(bal[k]);
  return { balances: bal, transfers };
}

/**
 * Moves a list of ISO dates so the first non-empty one lands on `newStart`,
 * keeping every gap between them. Blanks stay blank.
 *
 * Works in whole calendar days via setDate, so a trip spanning a daylight-saving
 * change does not drift by an hour and round to the wrong day.
 */
export function shiftDates(dates, newStart) {
  const first = dates.find(Boolean);
  if (!first || !newStart) return [...dates];
  const delta = Math.round(
    (new Date(`${newStart}T00:00`) - new Date(`${first}T00:00`)) / 86400000);
  if (!delta) return [...dates];
  return dates.map(d => {
    if (!d) return d;
    const t = new Date(`${d}T00:00`);
    t.setDate(t.getDate() + delta);
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  });
}

/** `n` consecutive ISO dates starting at `startISO`. Whole calendar days, so
 *  month ends, leap days and daylight-saving changes all come out right. */
export function datesFrom(startISO, n) {
  const t = new Date(`${startISO}T00:00`);
  return Array.from({ length: n }, () => {
    const s = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
    t.setDate(t.getDate() + 1);
    return s;
  });
}

/** Compact stay length for a crowded row: 30 -> "30m", 90 -> "1h 30m". */
export function fmtStay(min) {
  const n = Math.max(0, Math.round(min || 0));
  if (!n) return '';
  const h = Math.floor(n / 60), m = n % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Spreads city names across `n` days as evenly as possible, remainder to the
 * earlier cities. Three cities over eight days gives 3, 3, 2.
 *
 * Deliberately blunt: the wizard cannot know you want four nights in Kyoto and
 * one in Nara, so it makes a fair guess and the Trip days table fixes it.
 */
export function spreadCities(cities, n) {
  if (!cities.length || n <= 0) return Array.from({ length: Math.max(0, n) }, () => '');
  const base = Math.floor(n / cities.length);
  let extra = n % cities.length;
  const out = [];
  for (const c of cities) {
    const take = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra--;
    for (let i = 0; i < take; i++) out.push(c);
  }
  return out.slice(0, n);
}

/**
 * Ranks airport index rows against a query.
 * Rows are [iata, name, city, country, lat, lng].
 *
 * Exact code first: someone typing "NRT" means Narita, not every airport whose
 * name happens to contain those letters.
 */
export function matchAirports(rows, q, limit = 8) {
  const term = String(q || '').trim().toLowerCase();
  if (term.length < 2) return [];
  const code = term.toUpperCase();

  const scored = [];
  for (const [iata, name, city, country, lat, lng, size = 1] of rows) {
    const n = name.toLowerCase(), c = (city || '').toLowerCase();
    const rank = iata === code ? 0
      : iata.startsWith(code) ? 1
      : c.startsWith(term) ? 2
      : n.startsWith(term) ? 3
      : c.includes(term) ? 4
      : n.includes(term) ? 5
      : -1;
    if (rank < 0) continue;
    scored.push([rank, size, {
      name, code: iata, kind: iata, lat, lng, type: 'airport',
      label: [city, country].filter(Boolean).join(', '),
    }]);
  }
  // Match quality, then airport size, then name for a stable order.
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].name.localeCompare(b[2].name));
  return scored.slice(0, limit).map(x => x[2]);
}

/**
 * Identifies a journey by the services ridden, so a fare entered once can be
 * offered again. Central to Tsim Sha Tsui on the TWL is the same trip on
 * Thursday as it was on Monday.
 *
 * Walking legs are already excluded upstream; they cost nothing and their
 * stop names vary with the exact door you started from.
 */
export function fareKey(lines = []) {
  if (!lines.length) return '';
  return lines
    .map(l => [l.line, l.from, l.to]
      .map(v => String(v ?? '').trim().toLowerCase())
      .join('>'))
    .join('|');
}

/** Straight-line km, for matching a journey against a fare step table. */
const kmBetween = (a, b) => {
  const R = 6371, rad = d => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

// Rail carries the airport traffic. The nearest stop to Fukuoka Airport is a
// coach stand whose one route runs to Kumamoto, and starting there turned an
// eleven-minute subway ride into a seventy-two-minute round trip.
const RAIL_MODES = new Set(['RAIL', 'REGIONAL_RAIL', 'HIGHSPEED_RAIL', 'LONG_DISTANCE',
  'NIGHT_RAIL', 'SUBWAY', 'METRO', 'TRAM', 'MONORAIL', 'FUNICULAR']);

/**
 * The station to route from when the router could not start from a point.
 *
 * An airport publishes a reference point, not a door. Fukuoka's sits out on
 * the runway with no footpath touching it, so the router had nowhere to begin
 * and said there was no route to a hotel the subway reaches in eleven minutes.
 *
 * A point with a stop on its doorstep is not stranded and is left alone, or a
 * hotel would be moved to the station and quietly lose its final walk.
 * Returns null when there is nothing better, which keeps "no route" honest.
 */
export function strandedStop(point, stops, { strandedM = 400, reachM = 3000 } = {}) {
  if (!point || !stops?.length) return null;
  const near = stops
    .filter(s => s && s.lat != null && s.lng != null)
    .map(s => ({ s, m: kmBetween(point, s) * 1000 }))
    .sort((a, b) => a.m - b.m);
  if (!near.length || near[0].m <= strandedM) return null;
  const rail = near.find(({ s, m }) => m <= reachM
    && (s.modes || []).some(mode => RAIL_MODES.has(String(mode).toUpperCase())));
  return rail ? rail.s : null;
}

/**
 * Whether you sleep at this stay on that date.
 *
 * Check-in night through the last night, so the check-out date is **not**
 * one of them: that morning you leave with your bags and the day ends at an
 * airport, not back in the room. `staysOn` answers a different question - which
 * days the booking touches - and includes it.
 */
export function sleepsOn(stay, date) {
  if (!stay?.start || !date) return false;
  const from = String(stay.start).slice(0, 10);
  const to = String(stay.end || stay.start).slice(0, 10);
  return from <= date && date < to;
}

/**
 * The stops worth drawing on a day's map.
 *
 * The far end of a flight is a real stop on the day — you were at Hong Kong
 * airport that morning — but drawing it stretched the map across the East
 * China Sea and ruled a straight line through it, which says nothing about
 * the day being planned. An airport far from where the day actually happens
 * is left off the map; it keeps its place in the plan and its number.
 *
 * "Where the day happens" is the stops that came from nowhere but you: the
 * hotel and the sights. A day that is only airports keeps them all, because
 * then the flight is the day.
 */
export function mapPlaces(items, awayKm = 200) {
  const places = items.filter(isPlace);
  const grounded = places.filter(p => !p.flightId);
  if (!grounded.length) return places;
  const mid = {
    lat: grounded.reduce((n, p) => n + p.lat, 0) / grounded.length,
    lng: grounded.reduce((n, p) => n + p.lng, 0) / grounded.length,
  };
  return places.filter(p => !p.flightId || kmBetween(mid, p) <= awayKm);
}

const OSM_DAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];

/** "Mo-We,Fr" -> the set {0,1,2,4}. null when it is not a plain weekday list. */
function weekdaySet(token) {
  const out = new Set();
  for (const part of token.split(',')) {
    const m = /^([a-z]{2})(?:-([a-z]{2}))?$/.exec(part.trim().toLowerCase());
    if (!m) return null;
    const from = OSM_DAYS.indexOf(m[1]);
    if (from < 0) return null;
    if (!m[2]) { out.add(from); continue; }
    const to = OSM_DAYS.indexOf(m[2]);
    if (to < 0) return null;
    for (let i = 0; i < 7; i++) {          // Sa-Mo wraps round the week
      const d = (from + i) % 7;
      out.add(d);
      if (d === to) break;
    }
  }
  return out;
}

/**
 * When a place is open on a given weekday, read from OpenStreetMap's
 * `opening_hours` tag. Monday is 0.
 *
 * Returns a list of [openMinute, closeMinute] for that day, empty when it is
 * closed all day, and **null when the tag says something this cannot read**.
 * That third answer is the important one: the real grammar has public
 * holidays, school terms, month ranges, sunset and week numbers in it, and a
 * planner that guessed at those would tell you a museum is open on the one
 * day of the year it is not. Saying nothing is the honest answer.
 *
 * A day no rule mentions is closed, which is what the tag means: "Mo-Fr
 * 09:00-18:00" is shut at the weekend.
 */
export function openHours(spec, dayIdx) {
  const raw = String(spec || '').trim();
  if (!raw || !(dayIdx >= 0 && dayIdx < 7)) return null;
  if (/^24\/7$/i.test(raw)) return [[0, 1440]];
  // Everything the simple reading below would get wrong.
  if (/[[\]{}"|+]|\bPH\b|\bSH\b|sunrise|sunset|dawn|dusk|easter|\bweek\b|\d{4}|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec/i.test(raw)) return null;

  const byDay = Array.from({ length: 7 }, () => null);   // null = no rule said
  for (const rule of raw.split(';')) {
    const text = rule.trim();
    if (!text) continue;
    const m = /^([A-Za-z,\- ]*?)\s*((?:\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*,?\s*)+|off|closed)$/i
      .exec(text);
    if (!m) return null;

    const days = m[1].trim() ? weekdaySet(m[1]) : new Set([0, 1, 2, 3, 4, 5, 6]);
    if (!days) return null;

    const body = m[2].trim().toLowerCase();
    let spans = [];
    if (body !== 'off' && body !== 'closed') {
      for (const span of body.split(',')) {
        const [a, b] = span.split('-').map(v => clockOf(v.trim()));
        if (a == null || b == null) return null;
        // Past midnight: open until the end of the day, and this planner does
        // not carry the rest over into tomorrow.
        spans.push([a, b > a ? b : 1440]);
      }
    }
    for (const d of days) byDay[d] = spans;
  }
  // A day no rule mentions is shut, not unknown: that is what the tag means.
  return byDay[dayIdx] ?? [];
}
/** The fare city a point falls inside, or null. Nearest wins where they overlap. */
export function fareCity(table, point) {
  if (!table?.cities || !point) return null;
  let best = null, bestKm = Infinity;
  for (const c of table.cities) {
    const km = kmBetween(point, c);
    if (km <= (c.radiusKm ?? 40) && km < bestKm) { best = c; bestKm = km; }
  }
  return best;
}

/**
 * The published fare for the ridden portion an exact table covers.
 *
 * A network like the MTR charges once from where you enter to where you leave,
 * however many lines you change, so this prices first-entry to last-exit rather
 * than summing legs.
 *
 * Returns { amount, covered } where covered is the steps it accounted for, or
 * null when the table cannot price any of it.
 */
export function exactFare(exact, steps) {
  if (!exact?.stations?.length || !steps.length) return null;
  const match = (exact.match || []).map(m => String(m).toLowerCase());
  const mine = steps.filter(s => {
    const agency = String(s.agency || '').toLowerCase();
    return agency && match.some(m => agency.includes(m));
  });
  if (!mine.length) return null;

  const index = exact._index || (exact._index = new Map(exact.stations.map((s, i) => [s, i])));
  const a = index.get(mine[0].from);
  const b = index.get(mine[mine.length - 1].to);
  if (a == null || b == null || a === b) return null;

  const pair = exact.fares[a < b ? `${a}-${b}` : `${b}-${a}`];
  if (!pair) return null;
  return { amount: pair[0], covered: mine };
}

/**
 * A named service priced as a whole, matched on where it starts and ends.
 *
 * Urban distance bands are nonsense for a long coach: the Tokyo to Kawaguchiko
 * bus is 2200 yen, and pricing its 100 km as city metro gave 324.
 */
function namedRoute(city, ridden) {
  for (const r of city.routes || []) {
    if (r.modes && !ridden.some(s => r.modes.includes(String(s.mode || '').toUpperCase()))) continue;
    const [a, b] = r.between || [];
    if (!a || !b) continue;
    const start = ridden[0], end = ridden[ridden.length - 1];
    if (!start?.fromPt || !end?.toPt) continue;
    // Either direction: the return trip is the same service.
    const forward = kmBetween(start.fromPt, a) <= (a.km ?? 10)
      && kmBetween(end.toPt, b) <= (b.km ?? 10);
    const back = kmBetween(start.fromPt, b) <= (b.km ?? 10)
      && kmBetween(end.toPt, a) <= (a.km ?? 10);
    if (forward || back) return r;
  }
  return null;
}

/** First operator whose name matches, or null. Order in the data decides. */
function operatorFor(city, agency) {
  const name = String(agency || "").toLowerCase();
  if (!name) return null;
  return (city.operators || []).find(o =>
    (o.match || []).some(m => name.includes(String(m).toLowerCase()))) || null;
}

const stepAt = (steps, km) => (steps.find(([maxKm]) => km <= maxKm) || steps[steps.length - 1])[1];

/**
 * A starting guess at what a journey costs, from the committed fare table.
 *
 * Where a city lists operators, each charges separately and the fares are
 * summed. That is not a refinement, it is how Tokyo works: riding Tokyo Metro
 * and then Toei is two fares, and one city-wide table understates it badly.
 * Named transfer discounts are then subtracted.
 *
 * Only ever a suggestion: no agency publishes fares in an open feed, so these
 * are hand-written approximations that go stale. A fare the traveller enters is
 * remembered separately and takes precedence.
 *
 * Returns { amount, currency, city, breakdown, exact } or null when nothing was
 * ridden or the city is unknown. `exact` is true only when every ridden step
 * came from a published table rather than a distance band.
 */
export function estimateFare(table, from, to, steps = [], exact = null) {
  // Walking is free. Nothing ridden means nothing to charge for.
  const ridden = steps.filter(s => String(s?.mode || "").toUpperCase() !== "WALK");
  if (!ridden.length) return null;

  const city = fareCity(table, from);
  if (!city) return null;

  // A named service is priced whole, before anything is measured.
  const named = namedRoute(city, ridden);
  if (named) {
    return {
      amount: named.amount, currency: city.currency, city: city.label,
      breakdown: [{ operator: named.label, amount: named.amount, note: named.note }],
      exact: false, route: named.label,
    };
  }

  // Japanese rail feeds return no distance at all on a ridden leg. Taking that
  // as zero km billed every operator its cheapest band and hid long journeys
  // from the check below, which is how a two-hour trip to Mt Fuji was priced at
  // a couple of subway rides. Fall back to the endpoints, then to a share of
  // the journey's straight-line distance weighted by time on board.
  const knownKm = ridden.reduce((n, s) => n + (s.metres != null ? s.metres / 1000 : 0), 0);
  const blindSecs = ridden
    .filter(s => s.metres == null && !(s.fromPt && s.toPt))
    .reduce((n, s) => n + (s.seconds || 0), 0);
  const spare = Math.max(0, (to ? kmBetween(from, to) : 0) - knownKm);
  const legKm = s => {
    if (s.metres != null) return s.metres / 1000;
    if (s.fromPt && s.toPt) return kmBetween(s.fromPt, s.toPt);
    return blindSecs ? spare * ((s.seconds || 0) / blindSecs) : 0;
  };

  // Beyond the urban network the bands mean nothing, and a confidently wrong
  // number is worse than none. Say nothing instead.
  const spanKm = ridden.reduce((n, s) => n + legKm(s), 0);
  const urbanKm = city.urbanKm ?? city.radiusKm ?? 40;
  if (spanKm > urbanKm && !exact) return null;

  const breakdown = [];

  // A published fare beats any band, so price what the exact table covers and
  // leave the remaining legs to the estimates below.
  const published = exactFare(exact, ridden);
  const rest = published ? ridden.filter(s => !published.covered.includes(s)) : ridden;
  if (published) {
    breakdown.push({ operator: exact.label || "Published fare", amount: published.amount, exact: true });
  }

  // Distance per operator, taken from the routed legs where they carry one.
  const byOperator = new Map();
  let unmatchedKm = 0;
  let unmatched = false;
  for (const s of rest) {
    const km = legKm(s);
    const op = operatorFor(city, s.agency);
    if (!op) { unmatched = true; unmatchedKm += km; continue; }
    byOperator.set(op, (byOperator.get(op) || 0) + km);
  }

  for (const [op, km] of byOperator) {
    breakdown.push({ operator: op.label || op.id, amount: stepAt(op.steps, km) });
  }

  // Anything from an operator the table does not know still has to be priced.
  if (unmatched) {
    const modes = rest.map(s => String(s.mode || "").toUpperCase()).filter(Boolean);
    const mode = modes.find(m => city.modes?.[m]) || "*";
    const fallback = city.modes?.[mode] || city.modes?.["*"];
    if (fallback?.length) {
      const km = unmatchedKm > 0 ? unmatchedKm : (to ? kmBetween(from, to) : 0);
      breakdown.push({ operator: city.label, amount: stepAt(fallback, km) });
    }
  }

  if (!breakdown.length) return null;
  let amount = breakdown.reduce((n, b) => n + b.amount, 0);

  const ids = new Set([...byOperator.keys()].map(o => o.id));
  for (const d of city.transferDiscounts || []) {
    if ((d.between || []).every(id => ids.has(id))) amount -= d.amount;
  }

  amount = Math.max(0, Math.round(amount * 100) / 100);
  return {
    amount, currency: city.currency, city: city.label, breakdown,
    exact: Boolean(published) && rest.length === 0,
  };
}

/** An instant rendered as a clock time where the traveller is, not where the device is. */
export function fmtInstant(iso, timeZone) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}
