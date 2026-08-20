import assert from 'node:assert/strict';
import { settleUp, optimizeOrder, scheduleDay, placePairs, isPlace, shiftDates, datesFrom, spreadCities, zonedDateTime, matchAirports, fmtTime, fmtDur, fmtStay } from './logic.js';

// --- split & settle ---
const { balances, transfers } = settleUp([
  { desc: 'hotel',  amount: 300, payer: 'A', sharedBy: ['A', 'B', 'C'] },
  { desc: 'dinner', amount: 60,  payer: 'B', sharedBy: ['A', 'B'] },
], ['A', 'B', 'C']);
assert.equal(balances.A, 170);
assert.equal(balances.B, -70);
assert.equal(balances.C, -100);
assert.equal(transfers.reduce((s, t) => s + t.amount, 0), 170, 'transfers must clear the debt');
assert.ok(transfers.every(t => t.to === 'A'));
// non-members are ignored, not crashed on
assert.doesNotThrow(() => settleUp([{ amount: 10, payer: 'Z', sharedBy: ['Z'] }], ['A']));

// --- route optimisation ---
// four stops on a line at x = 0,1,2,3 but handed over in a silly order
const x = [0, 3, 1, 2];
const M = x.map(a => x.map(b => Math.abs(a - b)));
const order = optimizeOrder(M, true);
assert.equal(order[0], 0, 'first stop stays pinned');
const cost = order.slice(1).reduce((s, v, k) => s + M[order[k]][v], 0);
assert.equal(cost, 3, `expected optimal walk of 3, got ${cost} via ${order}`);

// --- day schedule ---
const place = (lat, stayMin) => ({ name: 'p', lat, lng: 0, stayMin });

const tl = scheduleDay([place(1, 60), place(2, 90)], [{ seconds: 1800 }], '09:00');
assert.deepEqual(tl.map(r => r.type), ['item', 'leg', 'item']);
assert.equal(fmtTime(tl[0].arrive), '09:00');
assert.equal(tl[1].min, 30);
assert.equal(fmtTime(tl[2].arrive), '10:30');
assert.equal(fmtTime(tl[2].depart), '12:00');

// an unknown leg must not poison the clock that follows it
assert.equal(scheduleDay([place(1, 60), place(2, 0)], [null], '09:00')[2].arrive, 600);

// free-form items take time but are never routed to or from
const mixed = [place(1, 60), { name: 'buy JR pass', stayMin: 30 }, place(2, 60)];
assert.deepEqual(placePairs(mixed), [[0, 2]], 'the note must not break the pair');
assert.equal(placePairs([{ name: 'a' }, { name: 'b' }]).length, 0);
assert.equal(isPlace(mixed[1]), false);
assert.equal(isPlace(mixed[0]), true);

const mtl = scheduleDay(mixed, { 0: { seconds: 1200 } }, '09:00');
assert.deepEqual(mtl.map(r => r.type), ['item', 'item', 'leg', 'item'],
  'the leg belongs immediately before the place it arrives at');
assert.equal(fmtTime(mtl[1].arrive), '10:00', 'note starts when the first stop ends');
assert.equal(mtl[2].min, 20);
assert.equal(fmtTime(mtl[3].arrive), '10:50', '60min stop + 30min note + 20min travel');

// scheduleDay must read legs under exactly the indices placePairs writes them to.
// When these drifted apart, routing stored legs the timeline never looked up and
// every journey silently rendered as "no route".
const drift = [place(1, 60), { name: 'note' }, place(2, 60), place(3, 30), { name: 'tail' }];
assert.deepEqual(
  scheduleDay(drift, {}, '09:00').filter(r => r.type === 'leg').map(r => r.from),
  placePairs(drift).map(([from]) => from),
  'leg lookup keys must match the pairs routing computes',
);

// --- shifting the whole trip ---
assert.deepEqual(
  shiftDates(["2026-04-14", "2026-04-15", "2026-04-16"], "2026-04-21"),
  ["2026-04-21", "2026-04-22", "2026-04-23"], "moves every day by the same delta");
assert.deepEqual(
  shiftDates(["2026-04-14", "", "2026-04-20"], "2026-04-15"),
  ["2026-04-15", "", "2026-04-21"], "keeps gaps and leaves blanks blank");
assert.deepEqual(
  shiftDates(["2026-01-30", "2026-01-31"], "2026-02-27"),
  ["2026-02-27", "2026-02-28"], "crosses a month boundary");
assert.deepEqual(
  shiftDates(["2026-04-14"], "2026-04-14"), ["2026-04-14"], "no-op when unchanged");
assert.deepEqual(shiftDates(["", ""], "2026-04-14"), ["", ""], "nothing to anchor on");
assert.deepEqual(shiftDates(["2026-04-14"], ""), ["2026-04-14"], "no target date");

// --- laying a range across consecutive days ---
assert.deepEqual(datesFrom("2026-02-26", 4),
  ["2026-02-26", "2026-02-27", "2026-02-28", "2026-03-01"], "rolls over a short month");
assert.deepEqual(datesFrom("2024-02-28", 3),
  ["2024-02-28", "2024-02-29", "2024-03-01"], "keeps the leap day");
assert.deepEqual(datesFrom("2026-12-31", 2), ["2026-12-31", "2027-01-01"], "crosses new year");
assert.equal(datesFrom("2026-04-14", 1).length, 1);
assert.deepEqual(datesFrom("2026-04-14", 0), [], "empty range");

assert.equal(fmtTime(1500), '01:00 +1');
assert.equal(fmtDur(5400), '1h 30');
assert.equal(fmtStay(30), '30m');
assert.equal(fmtStay(60), '1h');
assert.equal(fmtStay(90), '1h 30m');
assert.equal(fmtStay(0), '', 'no chip for a zero-length stop');
assert.equal(fmtStay(undefined), '');

// --- spreading cities over the trip ---
assert.deepEqual(spreadCities(["Tokyo", "Osaka"], 4), ["Tokyo", "Tokyo", "Osaka", "Osaka"]);
assert.deepEqual(spreadCities(["A", "B", "C"], 8),
  ["A", "A", "A", "B", "B", "B", "C", "C"], "remainder goes to the earlier cities");
assert.deepEqual(spreadCities(["Solo"], 3), ["Solo", "Solo", "Solo"]);
assert.deepEqual(spreadCities(["A", "B", "C"], 2), ["A", "B"], "more cities than days");
assert.deepEqual(spreadCities([], 2), ["", ""], "no cities still fills the days");
assert.deepEqual(spreadCities(["A"], 0), []);

// --- a day's clock belongs to the destination, not the device running the app ---
assert.equal(zonedDateTime('2026-08-21', '09:00', 'Asia/Tokyo').toISOString(),
  '2026-08-21T00:00:00.000Z');
assert.equal(zonedDateTime('2026-08-21', '09:00', 'Europe/London').toISOString(),
  '2026-08-21T08:00:00.000Z', 'summer time is applied');
assert.equal(zonedDateTime('2026-12-21', '09:00', 'Europe/London').toISOString(),
  '2026-12-21T09:00:00.000Z', 'winter time is applied');
assert.throws(() => zonedDateTime('2026-03-29', '01:30', 'Europe/London'), /does not exist/);

// --- airport lookup by IATA code, the thing Photon cannot do ---
const AIR = [                                  // [iata, name, city, country, lat, lng, size]
  ["NRT", "Narita International Airport", "Tokyo", "JP", 35.76, 140.39, 0],
  ["HND", "Tokyo Haneda International Airport", "Tokyo", "JP", 35.55, 139.78, 0],
  ["LHR", "London Heathrow Airport", "London", "GB", 51.47, -0.45, 0],
  ["NRN", "Weeze Airport", "Weeze", "DE", 51.60, 6.14, 1],
];
assert.equal(matchAirports(AIR, "NRT")[0].code, "NRT", "exact code wins");
assert.equal(matchAirports(AIR, "nrt")[0].code, "NRT", "case does not matter");
assert.deepEqual(matchAirports(AIR, "NR").map(a => a.code), ["NRT", "NRN"],
  "code prefix ties break on airport size, so Narita beats Weeze");
assert.deepEqual(matchAirports(AIR, "tokyo").map(a => a.code), ["NRT", "HND"],
  "city match, same size, so airport name orders them");
assert.equal(matchAirports(AIR, "heathrow")[0].code, "LHR", "name match");
assert.deepEqual(matchAirports(AIR, "zzz"), [], "no match is empty, not everything");
assert.deepEqual(matchAirports(AIR, "n"), [], "one letter is too vague to rank");
assert.equal(matchAirports(AIR, "NRT")[0].label, "Tokyo, JP");

console.log('all good');
