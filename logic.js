// Pure logic. No DOM, no Google. Imported by app.js and test.mjs.

export const pad = n => String(n).padStart(2, '0');

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
