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

/**
 * Walk the day: items may be places (routed between) or free-form entries that
 * only take up time. legs[originIndex] = { seconds } for the hop leaving that
 * place. Returns interleaved rows with times in minutes-since-midnight.
 */
export function scheduleDay(items, legs = [], startTime = "09:00") {
  const [h, mi] = startTime.split(":").map(Number);
  let t = h * 60 + mi;
  const out = [];
  let lastPlace = null;

  items.forEach((it, i) => {
    if (isPlace(it) && lastPlace !== null) {
      const leg = legs[lastPlace] || null;
      const min = leg ? Math.round(leg.seconds / 60) : null;
      out.push({ type: "leg", from: lastPlace, to: i, min, leg });
      if (min != null) t += min;
    }
    const stay = it.stayMin ?? 60;
    out.push({ type: "item", i, arrive: t, depart: t + stay, place: isPlace(it) });
    t += stay;
    if (isPlace(it)) lastPlace = i;
  });
  return out;
}

const r2 = v => Math.round(v * 100) / 100;

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
 * Returns { amount, currency, city, breakdown } or null when nothing was ridden
 * or the city is unknown.
 */
export function estimateFare(table, from, to, steps = []) {
  // Walking is free. Nothing ridden means nothing to charge for.
  const ridden = steps.filter(s => String(s?.mode || "").toUpperCase() !== "WALK");
  if (!ridden.length) return null;

  const city = fareCity(table, from);
  if (!city) return null;

  // Distance per operator, taken from the routed legs where they carry one.
  const byOperator = new Map();
  let unmatchedKm = 0;
  let unmatched = false;
  for (const s of ridden) {
    const km = s.metres != null ? s.metres / 1000 : 0;
    const op = operatorFor(city, s.agency);
    if (!op) { unmatched = true; unmatchedKm += km; continue; }
    byOperator.set(op, (byOperator.get(op) || 0) + km);
  }

  const breakdown = [];
  for (const [op, km] of byOperator) {
    breakdown.push({ operator: op.label || op.id, amount: stepAt(op.steps, km) });
  }

  // Anything from an operator the table does not know still has to be priced.
  if (unmatched) {
    const modes = ridden.map(s => String(s.mode || "").toUpperCase()).filter(Boolean);
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
  return { amount, currency: city.currency, city: city.label, breakdown };
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
