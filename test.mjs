import assert from 'node:assert/strict';
import fs from 'node:fs';
import { settleUp, optimizeOrder, optimizeDay, scheduleDay, placePairs, isPlace, mapPlaces, sleepsOn, shiftDates, datesFrom, spreadCities, zonedDateTime, flightSeconds, strandedStop, matchAirports, fareKey, estimateFare, exactFare, fareCity, fmtInstant, fmtMoney, fmtTime, fmtDur, fmtStay, clockOf, openHours, decodePolyline } from './logic.js';

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

// --- recognising the same journey again ---
const RIDE = [{ line: "TWL", from: "Central", to: "Tsim Sha Tsui" }];
assert.equal(fareKey(RIDE), "twl>central>tsim sha tsui");
assert.equal(fareKey([{ line: "TWL", from: " central ", to: "TSIM SHA TSUI" }]), fareKey(RIDE),
  "same journey despite spacing and case");
assert.notEqual(fareKey([{ line: "ISL", from: "Central", to: "Tsim Sha Tsui" }]), fareKey(RIDE),
  "a different line is a different fare");
assert.equal(fareKey([]), "", "a walk-only leg has no fare identity");
assert.equal(fareKey([{ line: "A", from: "x", to: "y" }, { line: "B", from: "y", to: "z" }]),
  "a>x>y|b>y>z", "a two-leg journey keys on both");

// --- fare estimates from the committed table ---
const FARES = JSON.parse(fs.readFileSync(new URL("./data/fares.json", import.meta.url), "utf8"));
const HK_CENTRAL = { lat: 22.2819, lng: 114.1583 };
const HK_TST = { lat: 22.2976, lng: 114.1722 };
const NOWHERE = { lat: -35.0, lng: -60.0 };
const ride = (mode, km, agency) => ({ mode, metres: km * 1000, agency });
const walk = km => ({ mode: "WALK", metres: km * 1000 });

assert.equal(fareCity(FARES, HK_CENTRAL).id, "hongkong");
assert.equal(fareCity(FARES, NOWHERE), null, "unknown city yields no guess");
assert.equal(estimateFare(FARES, NOWHERE, HK_TST, [ride("SUBWAY", 3)]), null);

assert.equal(estimateFare(FARES, HK_CENTRAL, HK_TST, []), null, "no steps, nothing ridden");
assert.equal(estimateFare(FARES, HK_CENTRAL, HK_TST, [walk(0.3), walk(0.2)]), null,
  "walking the whole way costs nothing");

const hk = estimateFare(FARES, HK_CENTRAL, HK_TST, [walk(0.2), ride("SUBWAY", 3), walk(0.3)]);
assert.equal(hk.currency, "HKD");
assert.equal(hk.amount, 5.5, "a couple of stops sits in the first step");
assert.ok(estimateFare(FARES, HK_CENTRAL, HK_TST, [ride("SUBWAY", 25)]).amount > hk.amount,
  "further costs more");
assert.equal(estimateFare(FARES, HK_CENTRAL, HK_TST, [ride("BUS", 3)]).amount, 6.0,
  "buses use their own table");

// Hong Kong has a published table, so its fares are exact rather than guessed
const MTR = JSON.parse(fs.readFileSync(new URL("./data/mtr-fares.json", import.meta.url), "utf8"));
const mtrLeg = (from, to) => ({ mode: "SUBWAY", agency: "MTR Rail", from, to, metres: 3000 });

const oneLine = estimateFare(FARES, HK_CENTRAL, HK_TST,
  [walk(0.2), mtrLeg("Central", "Tsim Sha Tsui"), walk(0.2)], MTR);
assert.equal(oneLine.amount, 10.6, "the published Central to Tsim Sha Tsui fare");
assert.equal(oneLine.exact, true, "published, so not a guess");

// The MTR charges entry to exit however many lines you change, so two legs is
// still one fare, priced first-entry to last-exit - not the sum of the legs.
const changed = estimateFare(FARES, HK_CENTRAL, HK_TST,
  [mtrLeg("Central", "Admiralty"), mtrLeg("Admiralty", "Kowloon Tong")], MTR);
assert.equal(changed.amount, 13.2, "Central to Kowloon Tong, one fare across the change");
assert.equal(changed.breakdown.length, 1, "one charge, not two");

// A bus after the train is a separate fare, and the result stops being exact
const trainThenBus = estimateFare(FARES, HK_CENTRAL, HK_TST,
  [mtrLeg("Central", "Tsim Sha Tsui"), { mode: "BUS", agency: "KMB", metres: 3000 }], MTR);
assert.equal(trainThenBus.breakdown.length, 2, "train and bus charge separately");
assert.ok(trainThenBus.amount > 10.6, "the bus adds to it");
assert.equal(trainThenBus.exact, false, "part of it is still a guess");

// A station the table does not list falls back rather than inventing a fare
const unknownStation = estimateFare(FARES, HK_CENTRAL, HK_TST,
  [mtrLeg("Central", "Nowhere Station")], MTR);
assert.ok(unknownStation && unknownStation.exact === false,
  "unknown station falls back to the estimate");

assert.equal(exactFare(MTR, []), null, "nothing ridden, nothing published");
assert.equal(exactFare(null, [mtrLeg("Central", "Admiralty")]), null, "no table, no fare");
assert.equal(exactFare(MTR, [{ mode: "BUS", agency: "KMB", from: "a", to: "b" }]), null,
  "another operator is not the MTR");

// Tokyo charges per operator, which is the whole point of the operator tables
const TOKYO = { lat: 35.6812, lng: 139.7671 };
const metroOnly = estimateFare(FARES, TOKYO, null, [ride("SUBWAY", 5, "東京メトロ Tokyo Metro")]);
assert.equal(metroOnly.amount, 178, "one operator, one fare");
assert.deepEqual(metroOnly.breakdown.map(b => b.operator), ["Tokyo Metro"]);

const twoOperators = estimateFare(FARES, TOKYO, null, [
  ride("SUBWAY", 5, "東京メトロ Tokyo Metro"),
  ride("SUBWAY", 3, "都営地下鉄 Toei Subway"),
]);
assert.equal(twoOperators.breakdown.length, 2, "each operator charges separately");
assert.equal(twoOperators.amount, 178 + 178 - 70, "the Metro to Toei transfer discount applies");
assert.ok(twoOperators.amount > metroOnly.amount, "two operators cost more than one");

// A bus is not a subway even under a similar authority name
assert.equal(estimateFare(FARES, TOKYO, null, [ride("BUS", 12, "都営バス")]).amount, 210,
  "Toei bus is flat, and must not match the Toei subway bands first");

// Distance within one operator accumulates across its legs
const longMetro = estimateFare(FARES, TOKYO, null, [
  ride("SUBWAY", 8, "東京メトロ"), ride("SUBWAY", 8, "東京メトロ"),
]);
assert.equal(longMetro.breakdown.length, 1, "same operator, one fare");
assert.equal(longMetro.amount, 252, "16 km lands in the third band, not two short fares");

// Feeds that report no distance must not price as zero kilometres.
// Every ridden leg of a real Tokyo journey came back with metres:null, which
// billed each operator its cheapest band and hid the trip from the range check.
const SHINJUKU_PT = { lat: 35.6896, lng: 139.7006 };
const MTFUJI_PT = { lat: 35.4835, lng: 138.7954 };
const blind = (agency, secs) => ({ mode: "REGIONAL_RAIL", agency, metres: null, seconds: secs });

const noDistance = estimateFare(FARES, SHINJUKU_PT, MTFUJI_PT, [
  blind("JR東日本 JR East", 3480),
  blind("JR", 2460),
]);
assert.equal(noDistance, null,
  "an 85 km journey with no leg distances is still too far to price from bands");

// Short urban hops with no distances still price, using time-weighted share
const shortBlind = estimateFare(FARES, TOKYO, { lat: 35.69, lng: 139.77 }, [
  blind("東京メトロ Tokyo Metro", 300),
]);
assert.ok(shortBlind && shortBlind.amount > 0, "a short hop is still priced");

// Endpoints are used when the feed gives them, in preference to guessing
const withPoints = estimateFare(FARES, TOKYO, null, [{
  mode: "SUBWAY", agency: "東京メトロ Tokyo Metro", metres: null, seconds: 600,
  fromPt: { lat: 35.6812, lng: 139.7671 }, toPt: { lat: 35.6896, lng: 139.7006 },
}]);
assert.equal(withPoints.amount, 208,
  "just over 6 km between the endpoints, so the second band, not the cheapest");

// Long journeys must not be priced with city bands
const KAWAGUCHIKO = { lat: 35.5008, lng: 138.7566 };
const SHINJUKU = { lat: 35.6896, lng: 139.7006 };
const coach = (fromPt, toPt, km) => ({ mode: "BUS", agency: "Fujikyu", metres: km * 1000, fromPt, toPt });

const bus = estimateFare(FARES, TOKYO, KAWAGUCHIKO,
  [coach(SHINJUKU, KAWAGUCHIKO, 100)]);
assert.equal(bus.amount, 2200, "the named highway bus fare, not a metro band");
assert.equal(bus.route, "Tokyo to Kawaguchiko highway bus");

const backAgain = estimateFare(FARES, TOKYO, KAWAGUCHIKO,
  [coach(KAWAGUCHIKO, SHINJUKU, 100)]);
assert.equal(backAgain.amount, 2200, "the return trip is the same service");

// A long journey with no named route says nothing rather than guessing badly
const unknownLongHaul = estimateFare(FARES, TOKYO, null,
  [{ mode: "REGIONAL_RAIL", agency: "Some Railway", metres: 120000,
     fromPt: SHINJUKU, toPt: { lat: 36.75, lng: 139.6 } }]);
assert.equal(unknownLongHaul, null,
  "beyond the urban network, no estimate beats a wrong one");

// Short journeys are unaffected
assert.ok(estimateFare(FARES, TOKYO, null,
  [ride("SUBWAY", 5, "東京メトロ Tokyo Metro")]).amount === 178,
  "urban journeys still priced normally");

// Osaka
const OSAKA = { lat: 34.6937, lng: 135.5023 };
assert.equal(estimateFare(FARES, OSAKA, null, [ride("SUBWAY", 2, "Osaka Metro")]).amount, 190);
assert.equal(estimateFare(FARES, OSAKA, null, [ride("SUBWAY", 10, "Osaka Metro")]).amount, 290);

// An operator the table has never heard of still gets priced
const unknownOp = estimateFare(FARES, TOKYO, null, [ride("SUBWAY", 5, "Some Private Railway")]);
assert.ok(unknownOp && unknownOp.amount > 0, "unknown operators fall back to the city table");

for (const c of FARES.cities) {
  assert.ok(c.modes["*"], c.id + " needs a default mode table");
  for (const [mode, steps] of Object.entries(c.modes)) {
    const maxes = steps.map(s => s[0]);
    assert.deepEqual(maxes, [...maxes].sort((x, y) => x - y), c.id + "/" + mode + " steps must ascend");
    assert.ok(steps.every(s => s[1] > 0), c.id + "/" + mode + " has a non-positive fare");
  }
  for (const o of c.operators || []) {
    assert.ok(o.match?.length && o.steps?.length, c.id + "/" + o.id + " needs match and steps");
    const maxes = o.steps.map(s => s[0]);
    assert.deepEqual(maxes, [...maxes].sort((x, y) => x - y), c.id + "/" + o.id + " steps must ascend");
  }
  for (const d of c.transferDiscounts || []) {
    for (const id of d.between) {
      assert.ok((c.operators || []).some(o => o.id === id),
        c.id + " discount names unknown operator " + id);
    }
  }
}

// --- the route as it is actually travelled ---
// Google's own example, at the precision everyone else uses.
assert.deepEqual(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5),
  [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);

// A real leg from Transitous, which encodes at precision 7. This is the case
// that broke: a longitude of 130 degrees at that precision is about 2.6
// billion, which overflows the 32-bit integers JavaScript bitwise operators
// work in, and the walk out of Hakata Station came out in Georgia.
const HAKATA_WALK = "{tqt_SajqqvlA{qNaVT{S_mRkb@b@e_@l_b@ls@p`Qhe@tfSdo@??ufSeo@q`Qie@";
const hakataWalk = decodePolyline(HAKATA_WALK, 7);
assert.equal(hakataWalk.length, 11, "eleven points, as the router said");
assert.ok(hakataWalk.every(([lat, lng]) => Math.abs(lat - 33.59) < 0.05 && Math.abs(lng - 130.42) < 0.05),
  "every point of it is in Hakata: " + JSON.stringify(hakataWalk[0]));

// Read at the wrong precision the same line is nowhere near, which is why the
// precision travels with the shape rather than being assumed.
assert.ok(Math.abs(decodePolyline(HAKATA_WALK, 5)[0][0] - 33.59) > 1,
  "precision is not a detail");

// A broken line is a drawing problem, never a reason to lose the plan.
assert.deepEqual(decodePolyline("_p~iF~ps|U_ulL", 5), [[38.5, -120.2]],
  "a truncated pair is dropped, the rest is kept");
assert.deepEqual(decodePolyline("", 5), []);
assert.deepEqual(decodePolyline(null, 7), []);
assert.deepEqual(decodePolyline("!!!!", 5), [], "not an encoded line at all");
// --- is it open when you get there ---
// Monday is 0. Ranges come back as [openMinute, closeMinute].
assert.deepEqual(openHours("Mo-Su 09:30-21:30", 0), [[570, 1290]], "Fukuoka Tower, every day");
assert.deepEqual(openHours("Mo-Fr 09:00-12:00,13:00-18:00", 0), [[540, 720], [780, 1080]],
  "a place that shuts for lunch has two windows");
assert.deepEqual(openHours("24/7", 3), [[0, 1440]]);

// A day no rule mentions is shut. This is the whole point of the tag.
assert.deepEqual(openHours("Mo-Fr 09:00-18:00", 5), [], "Saturday is not in Mo-Fr");
assert.deepEqual(openHours("Tu-Su 09:30-17:00; Mo off", 0), [], "the museum Monday");
assert.deepEqual(openHours("Tu-Su 09:30-17:00; Mo off", 1), [[570, 1020]]);
assert.deepEqual(openHours("Sa-Mo 10:00-16:00", 6), [[600, 960]], "Sa-Mo wraps past Sunday");
assert.deepEqual(openHours("Sa-Mo 10:00-16:00", 3), [], "and Thursday is outside it");

// Open past midnight stops at the end of the day rather than leaking into it.
assert.deepEqual(openHours("Mo-Su 11:00-02:00", 0), [[660, 1440]]);

// null is "the tag says something I cannot read", and it has to stay distinct
// from [] or a closed day and an unreadable one would look the same.
assert.equal(openHours("Mo-Fr 09:00-18:00; PH off", 0), null, "public holidays");
assert.equal(openHours("Apr-Oct 09:00-18:00", 0), null, "a season");
assert.equal(openHours("Mo-Su 09:00-sunset", 0), null, "sunset moves");
assert.equal(openHours("Mo[1] 09:00-18:00", 0), null, "the first Monday of the month");
assert.equal(openHours("nonsense here", 0), null);
assert.equal(openHours("", 0), null, "most places have no hours recorded at all");
assert.equal(openHours(null, 0), null);
assert.equal(openHours("24/7", 9), null, "there is no day nine");
// --- reading a clock face off an input ---
assert.equal(clockOf("22:00"), 22 * 60);
assert.equal(clockOf("9:05"), 9 * 60 + 5, "a browser may hand back one digit for the hour");
assert.equal(clockOf("00:00"), 0, "midnight is a time, not a falsy nothing");
assert.equal(clockOf(""), null, "no end time set");
assert.equal(clockOf("half nine"), null);
assert.equal(clockOf("12:345"), null);

// --- money on screen: a sign in front, grouped, no decimals ---
// Exact symbols follow the reader's locale, so assert the shape, not the glyph.
assert.match(fmtMoney(156000, "JPY"), /156,000/, "thousands are grouped");
assert.match(fmtMoney(156000, "JPY"), /^[^0-9]+156,000$/, "the sign goes in front");
assert.ok(!/[.,]\d\d$/.test(fmtMoney(1234.56, "GBP")), "no decimals on screen");
assert.match(fmtMoney(1234.56, "GBP"), /1,235/, "rounded to the nearest, not cut off");
assert.match(fmtMoney(-52000, "JPY"), /^[-(]/, "what you are owed still reads as a debt");
assert.match(fmtMoney(1000, "NOTACODE"), /NOTACODE 1[.,]000/,
  "a currency nobody has heard of still groups its digits");
assert.match(fmtMoney(0, "JPY"), /0/, "nothing spent is still an amount");
assert.match(fmtMoney(undefined, "JPY"), /0/, "a missing amount is zero, not NaN");
assert.match(fmtMoney(500, ""), /500/, "no currency set, just the number");

// --- the far end of a flight is a stop, but not part of this day's map ---
const HKG = { name: "HKG", lat: 22.308, lng: 113.9185, flightId: "f1", role: "depart" };
const FUK = { name: "FUK", lat: 33.5859, lng: 130.4506, flightId: "f1", role: "arrive" };
const HOTEL = { name: "Hotel", lat: 33.591, lng: 130.4184, hotelId: "h" };
const SIGHT = { name: "Canal City", lat: 33.5896, lng: 130.4113 };

assert.deepEqual(mapPlaces([HKG, FUK, HOTEL, SIGHT]).map(p => p.name),
  ["FUK", "Hotel", "Canal City"],
  "the airport you flew from is 1400 km away and would stretch the map over the sea");
assert.deepEqual(mapPlaces([HOTEL, SIGHT, FUK, { ...HKG, role: "arrive" }]).map(p => p.name),
  ["Hotel", "Canal City", "FUK"], "and so would the one you fly home to");
assert.deepEqual(mapPlaces([HKG, FUK]).map(p => p.name), ["HKG", "FUK"],
  "a day that is only the flight keeps both ends, because then the flight is the day");
assert.deepEqual(mapPlaces([HOTEL, SIGHT]).map(p => p.name), ["Hotel", "Canal City"]);
assert.deepEqual(mapPlaces([{ name: "a note" }, HOTEL]).map(p => p.name), ["Hotel"],
  "a note has no coordinates and never was on the map");
assert.deepEqual(mapPlaces([]), []);

// --- which nights you actually sleep somewhere ---
const stay = { start: "2026-09-12T15:00", end: "2026-09-16T11:00" };
assert.equal(sleepsOn(stay, "2026-09-12"), true, "the night you check in");
assert.equal(sleepsOn(stay, "2026-09-15"), true, "the last night");
assert.equal(sleepsOn(stay, "2026-09-16"), false,
  "check-out morning you leave with your bags, so the day does not end in the room");
assert.equal(sleepsOn(stay, "2026-09-11"), false, "before you arrive");
assert.equal(sleepsOn({ start: "2026-09-12" }, "2026-09-12"), false,
  "a stay with no check-out cannot say how many nights, so it claims none");
assert.equal(sleepsOn(null, "2026-09-12"), false);
assert.equal(sleepsOn(stay, ""), false);

// --- optimising a day moves only the stops you typed in ---
// Stops on a line at lat 0..9, so straight-line cost is just the gap.
const gap = (a, b) => Math.abs(a.lat - b.lat);
const dayItems = [
  { name: "Hotel", lat: 0, lng: 0, hotelId: "h" },
  { name: "A", lat: 3, lng: 0 },
  { name: "buy a rail pass" },
  { name: "B", lat: 1, lng: 0 },
  { name: "C", lat: 2, lng: 0 },
  { name: "FUK", lat: 9, lng: 0, flightId: "f", role: "depart" },
];
const better = optimizeDay(dayItems, gap);
assert.deepEqual(better.map(x => x.name), ["Hotel", "B", "buy a rail pass", "C", "A", "FUK"],
  "the sights reorder around the hotel; the hotel, the note and the airport hold their places");
assert.equal(better[0].hotelId, "h", "a stop from a booking is never shuffled away from its slot");
assert.equal(better[5].flightId, "f", "least of all the flight you have to catch");
assert.notEqual(better, dayItems, "returns a new list rather than editing in place");
assert.deepEqual(dayItems.map(x => x.name), ["Hotel", "A", "buy a rail pass", "B", "C", "FUK"],
  "and leaves the original alone");

// The anchor matters: without the hotel in the matrix the best order is the
// best loop, not the best way round starting from where you are.
assert.equal(optimizeDay(dayItems.slice(1), gap), null,
  "drop the hotel and only three stops can move, under the four worth ordering");

assert.equal(optimizeDay([{ name: "Hotel", lat: 0, lng: 0, hotelId: "h" },
  { name: "A", lat: 1, lng: 0 }], gap), null, "too short to be worth reordering");
assert.equal(optimizeDay([{ name: "a note" }, { name: "another" }], gap), null,
  "nothing with coordinates, nothing to order");
// --- a point the walking network cannot reach falls back to a station ---
// Real stops from the router, around Fukuoka Airport's published coordinate.
const FUK_PT = { lat: 33.5859, lng: 130.4506 };
const FUK_STOPS = [
  { name: "\u798F\u5CA1\u7A7A\u6E2F\u56FD\u969B\u7DDA\u30BF\u30FC\u30DF\u30CA\u30EB", lat: 33.58468, lng: 130.44376, modes: ["BUS"] },
  { name: "\u798F\u5CA1\u7A7A\u6E2F", lat: 33.597324, lng: 130.44818, modes: ["REGIONAL_RAIL"] },
  { name: "\u798F\u5CA1\u7A7A\u6E2F\u56FD\u5185\u7DDA\u30BF\u30FC\u30DF\u30CA\u30EB", lat: 33.599438, lng: 130.44731, modes: ["BUS"] },
];
assert.equal(strandedStop(FUK_PT, FUK_STOPS).name, "\u798F\u5CA1\u7A7A\u6E2F",
  "the nearest stop is a coach stand 648 m away; the station 1.3 km away is the useful one");

// A hotel with a stop on its doorstep must be left where it is, or the walk
// off the end of the journey quietly disappears.
assert.equal(strandedStop({ lat: 33.591, lng: 130.4184 }, [
  { name: "\u535A\u591A\u30D0\u30B9\u30BF\u30FC\u30DF\u30CA\u30EB", lat: 33.5921, lng: 130.4198, modes: ["BUS"] },
  { name: "\u535A\u591A", lat: 33.5898, lng: 130.4207, modes: ["REGIONAL_RAIL"] },
], { strandedM: 400 }), null, "a stop 150 m away means the point is reachable");

assert.equal(strandedStop(FUK_PT, FUK_STOPS.filter(s => !s.modes.includes("REGIONAL_RAIL"))), null,
  "buses only, so no estimate rather than a coach to the next prefecture");
assert.equal(strandedStop(FUK_PT, []), null, "nothing to snap to");
assert.equal(strandedStop(null, FUK_STOPS), null, "no point, no stop");
assert.equal(strandedStop(FUK_PT, FUK_STOPS, { reachM: 800 }), null,
  "a station further than you would go to reach it is no help");
// --- a flight has two clocks, and the gap between them is not the flight ---
const HK = "Asia/Hong_Kong", JP = "Asia/Tokyo";
assert.equal(flightSeconds("2026-09-12T08:20", "2026-09-12T13:05", HK, JP), (3 * 60 + 45) * 60,
  "the extra hour on the ticket is the timezone, not time in the air");
assert.equal(flightSeconds("2026-09-16T14:30", "2026-09-16T17:20", JP, HK), (3 * 60 + 50) * 60,
  "the way back gains the hour instead");
assert.equal(flightSeconds("2026-08-17T09:00", "2026-08-18T14:14", "Europe/London", JP),
  (21 * 60 + 14) * 60, "overnight, across a date and two offsets");
assert.equal(flightSeconds("2026-09-12T08:20", "2026-09-12T13:05", HK, ""), null,
  "an unknown zone gives no duration rather than a wrong one");
assert.equal(flightSeconds("2026-09-12", "2026-09-12T13:05", HK, JP), null, "no time, no duration");
assert.equal(flightSeconds("2026-09-12T13:05", "2026-09-12T08:20", JP, JP), null,
  "landing before takeoff is not a duration");

// --- a stop you hold a ticket for happens when the ticket says ---
const flightDay = scheduleDay([
  { name: "HKG", lat: 22.3, lng: 113.9, stayMin: 0, at: "2026-09-12T08:20" },
  { name: "FUK", lat: 33.6, lng: 130.5, stayMin: 0, at: "2026-09-12T13:05" },
  { name: "Hotel", lat: 33.59, lng: 130.42, stayMin: 30 },
], { 0: { seconds: 13500 }, 1: { seconds: 1800 } }, "09:00");
const stops = flightDay.filter(r => r.type === "item");
assert.equal(stops[0].arrive, 8 * 60 + 20, "the day starts when the flight leaves, not at 09:00");
assert.equal(stops[1].arrive, 13 * 60 + 5, "and lands when the ticket says, not when the sum says");
assert.equal(stops[2].arrive, 13 * 60 + 35, "after the last pin the clock runs on from it");
assert.equal(stops[0].pinned, true);
assert.equal(stops[2].pinned, false, "a stop with no ticket is not pinned");
// --- Fukuoka, the city the preview demo plans ---
const FUKUOKA = { lat: 33.5904, lng: 130.4017 };
assert.equal(fareCity(FARES, FUKUOKA).id, "fukuoka");
assert.equal(estimateFare(FARES, FUKUOKA, null, [ride("SUBWAY", 2, "福岡市地下鉄")]).amount, 210,
  "one Fukuoka subway zone");
assert.equal(estimateFare(FARES, FUKUOKA, null, [ride("RAIL", 15, "西鉄")]).amount, 420,
  "Tenjin to Dazaifu on Nishitetsu");

// --- the demo trip the preview build seeds itself with ---
const DEMO = JSON.parse(fs.readFileSync(new URL("./data/demo.json", import.meta.url), "utf8"));
const bookingIds = new Set(DEMO.itinerary.map(b => b.id));
for (const e of DEMO.expenses) {
  assert.ok(!e.src || bookingIds.has(e.src), "expense points at a booking that is not there: " + e.desc);
  assert.ok(e.sharedBy.every(m => DEMO.members.includes(m)), "expense splits to a stranger: " + e.desc);
  assert.ok(DEMO.members.includes(e.payer), "expense paid by a stranger: " + e.desc);
}
const dates = DEMO.days.map(d => d.date);
assert.deepEqual(dates, [...dates].sort(), "demo days must run forward");
for (const day of DEMO.days) {
  assert.ok(clockOf(day.start) != null, "every demo day needs a start time: " + day.date);
  assert.ok(!day.end || clockOf(day.end) > clockOf(day.start),
    "a demo day that sets an end must end after it starts: " + day.date);
}
for (const d of DEMO.days) {
  for (const it of d.items) {
    assert.ok(it.name, "every demo stop needs a name");
    assert.equal(it.lat == null, it.lng == null, "a demo stop has half a coordinate: " + it.name);
    if (it.hotelId) assert.ok(bookingIds.has(it.hotelId), "demo stop links a missing hotel");
    if (it.flightId) assert.ok(bookingIds.has(it.flightId), "demo stop links a missing flight");
  }
}
assert.ok(fareCity(FARES, DEMO.days[0].items.find(i => i.lat != null)),
  "the demo city needs a fare table, or the demo shows no fares at all");
for (const day of DEMO.days) {
  for (const it of day.items) {
    if (!it.flightId) continue;
    const b = DEMO.itinerary.find(x => x.id === it.flightId);
    assert.equal(it.at, it.role === "arrive" ? b.end : b.start,
      "a demo airport stop must be pinned to its own end of the flight");
    assert.equal(it.atTz, it.role === "arrive" ? b.toTz : b.fromTz,
      "and to the zone that end is in");
  }
}

// --- step times belong to the destination, not the device ---
assert.equal(fmtInstant("2026-09-01T09:02:00Z", "Asia/Hong_Kong"), "17:02");
assert.equal(fmtInstant("2026-09-01T09:02:00Z", "Europe/London"), "10:02", "summer time applied");
assert.equal(fmtInstant("2026-12-01T09:02:00Z", "Europe/London"), "09:02", "winter time applied");
assert.equal(fmtInstant("", "Asia/Tokyo"), "", "no instant, no time");
assert.equal(fmtInstant("not a date", "Asia/Tokyo"), "", "junk does not throw");

console.log('all good');
