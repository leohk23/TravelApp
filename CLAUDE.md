# CLAUDE.md

## What this is for

Three goals. Everything else is secondary; check work against these before
building it.

1. **Replace the Excel trip-planning template.** Same job a spreadsheet does -
   lay out a trip day by day - but graphical and not bound to typing into
   cells. The thing a spreadsheet cannot do is look up how to actually get
   between two places, which is why transit routing is core rather than a
   flourish.
2. **One place to retrieve flight and hotel booking details.** Confirmation
   numbers, times, addresses. Retrieval matters more than entry: the app is
   opened at an airport counter, not at a desk.
3. **Track travel expenses and split them across the party.**

Wanderlog is the reference for feel.

## Shape

Six files. Keep it that way unless there is a reason.

| File | Job |
|---|---|
| `index.html` | All markup. Static, no templating. |
| `style.css` | All styles. CSS variables at the top, light/dark via `prefers-color-scheme`. |
| `app.js` | State, rendering, event wiring. |
| `providers.js` | Every remote call. Nothing else talks to the network. |
| `logic.js` | Pure functions only — no DOM, no fetch. Everything testable lives here. |
| `test.mjs` | `node test.mjs`. Plain `node:assert`, no framework. |

Plus `serve.mjs`, a Node-stdlib dev server, and `.github/workflows/pages.yml`.

No build step, no bundler, no npm dependencies. ES modules loaded directly by
the browser, which is why it needs an HTTP server rather than `file://`.

## Rules that matter

- **New non-trivial logic goes in `logic.js` with an assert in `test.mjs`.** If
  it can be written as a pure function, it must be.
- **No new dependencies.** Leaflet (CDN, SRI-pinned) is the only one. Reordering
  a day is Pointer Events, so one path serves mouse and finger, dates are `<input type="date">`, the setup wizard is a
  native `<dialog>`, storage is `localStorage`. Keep reaching for the platform first.
- **Nothing that needs an API key.** That constraint is deliberate, not
  incidental — see the services table below.
- `render()` redraws everything from `state`. It is small and cheap. Do not
  introduce a diffing layer or a framework because a render feels wasteful.
- Cache remote results in `state` (legs already persist) rather than re-fetching
  on every render. These are volunteer-run servers.
- **A `<label>` owns exactly one control.** iOS forwards a touch anywhere on a
  label to the control it owns, so a label wrapped round a word, a select and
  an input hands a drag on the blank part of the row to the picker and the pane
  never scrolls. Wrap one control, or use a span and give each control its own
  `aria-label`.
- `[hidden] { display: none !important }` is load-bearing. Without it, any
  `display:` rule on the same element silently defeats the `hidden` attribute —
  which is exactly how the three ribbon sections once all rendered at once.

## Mobile first, desktop second

This is a trip planner. It gets used standing in a station, not sitting at a
desk, and it installs to a home screen. **Design the phone layout first and let
the desktop one be the adaptation**, not the other way round.

In practice:

- Base CSS is the phone layout. Widen it in `@media (min-width: …)` blocks.
  Never write a desktop layout and shrink it in `max-width` blocks.
- Every control is touch-sized (`--tap`, 40px+) before it is anything else.
- Nothing important may depend on hover: hover does not exist on a phone.
- Check a change on a narrow viewport before a wide one. If it only works
  wide, it does not work.

## Writing the interface

- **Never separate facts with a middle dot.** No `Aug 20 · Tokyo · Me`. A dot
  chain flattens unrelated things into one grey run that has to be parsed word
  by word. Give each fact its own element and let spacing, weight, colour or a
  short label do the separating. If they genuinely belong in one sentence, use a
  comma and write the sentence.
- Prefer a label over a separator when the reader cannot infer what a value is.
  `Party  Alice, Bob` beats `Alice, Bob` floating between two dots.
- Say what a thing is, not what category it belongs to. "3 of 7 bookings" beats
  "3/7".

## State

One object in `localStorage['travelapp']`, written by `save()`:

```js
{
  name, currency, members: [name], tab,      // tab = which ribbon section is open
  itinView, moneyView,                       // active sub-tabs
  dayIdx,                                    // which day tab is open
  mapView, split,                             // "split" | "map", plan-pane ratio
  itinerary: [{ id, kind, ref, conf, cost, currency?, rate?, notes,
    // a flight carries journeys; every other kind is its own single journey
    legs?: [{ id, ref, from, to, fromPt?, toPt?, fromTz?, toTz?, start, end }],
    from?, to?, start?, end?, lat?, lng?                       // non-flight kinds
  }],
  days: [{
    date, city, timeZone, start, end,        // "2026-04-02", "Tokyo", "Asia/Tokyo", "09:00", "22:00"
    cityPt,                                  // cached geocode of city, for search bias
    items: [{ name, localName?, address?, localAddress?, hours?, lat?, lng?, stayMin,
              at?, atTz?, hotelId?, flightId?, role? }],   // at = a ticket instant, or a clock time you set
    legs: { [originIndex]: { seconds, summary, transfers, arrival } | null },
  }],
  expenses: [{ desc, amount, payer, sharedBy: [name], src? }],  // src = booking id
}
```

Some of a day's stops are **derived from its bookings** and rebuilt by
`ensureLinkedStops()`: the airports a flight passes through that day
(`flightId` plus `role`) and the hotel you sleep in (`hotelId`). Order comes
from the clock. You start the day where you slept, except on the day you check
in, when the hotel follows the flight that brings you to it. A departure day
also ends in an arrival — the flight home — and treating that one as the
flight that brings you here once started the last morning in Hong Kong.

A **return flight is one booking**: one confirmation number, one payment, two
journeys. `journeys(b)` hands back a flight's `legs` and, for every other
kind, the booking itself — so nothing downstream has to ask which it is
holding. A day stop's `flightId` names a **journey**, not a booking, and
`findLeg()` resolves it. Flights used to be flat, one booking per direction,
with the return carrying `cost: 0` because the fare had to go somewhere.

`flightCutoff()` gives the latest a day can still be doing something and make
its flight, as `{ minutes, before }`. The index is load-bearing: an arrival day
also contains a departure — you left home that morning — and without it the
first day of a trip warns about every stop on it. Only stops before that index
are checked. `dayLegs()` fills in flight legs at render time, because a flight
needs no router and waiting for a recalculation printed "no route" across the
middle of an arrival day.

A booking can be paid in another currency: `currency` plus a `rate` you type.
Fetching a rate would be the wrong number — what matters is what your card was
charged on the day, months before the trip. `bookingCost()` returns null when
the currencies differ and no rate is set, which is deliberately not zero: the
Itinerary total counts those separately rather than understating the trip.

The hotel is added **again at the end** of every day you sleep there, so the
last leg is the one back to your room. `sleepsOn()` decides: check-in night
through the last night, never the check-out date, when you leave with your
bags and the day ends at an airport. It is skipped when the day already
finishes at the hotel, which would route a stop to itself.

A derived airport stop carries `at`, the time the ticket prints, and `atTz`,
the zone that time is in. `scheduleDay()` **pins** the timeline to `at` rather
than accumulating towards it, so a day starts when the flight leaves and the
landing row reads the landing time. The two ends of a flight are in two zones,
so the day plan tags the odd one out — a Hong Kong departure says so — and
`flightSeconds()` gives the real time in the air. Subtracting the printed
times makes an 08:20 to 13:05 hop look like 4h 45 when it is 3h 45; the extra
hour is the timezone. Zones resolve once per booking into `fromTz`/`toTz`.

Two stops of the same flight are never routed: no transit router has heard of
CX 510, so `flightHop()` draws that leg from the booking instead of reporting
no route across the East China Sea.

Airports only become stops when picked from the airport list, since only then do
they carry coordinates. Never hand-edit a derived item: the next rebuild wins.

A day item is a **place** only when it carries coordinates. Without them it is a
free-form entry — "breakfast", "buy JR pass" — that occupies `stayMin` on the
timeline but is never routed to or from. `placePairs()` skips them, so a note
sitting between two stops does not break the leg between those stops.

`legs` is derived — `recalc()` rebuilds it — but persisted so a reload does not
re-hit the routing service. It is keyed by the **origin item index**, not by
position, and is sparse. `legs[i] === null` means nothing runs between those two
places.

Days used to store `pois`; the loader migrates that to `items` on read.

`expenses[].src` links an expense back to the booking that generated it, so the
`+ expense` toggle can add and remove exactly one entry without double-counting.

There are no API keys anywhere. Nothing secret ever enters this repo.

## Remote services (all free, no keys)

Everything network-facing is in `providers.js`:

- **Photon** (`photon.komoot.io`) — type-ahead search. Always pass a `near`
  bias for local places; airport search is global and filtered to aerodromes.
  It answers in **one language at a time**, and `lang=en` is what lets an
  English query reach a Japanese name at all — so a place keeps `localName`
  too, fetched by replaying the query with no `lang` and matching on OSM id.
  Matching on position instead lands on a tree in the grounds of Dazaifu
  Tenmangu. Both extra lookups (this and the hours) happen **once, when a
  place is added** — never while typing.
- **Nominatim** (`nominatim.openstreetmap.org`) — resolves a typed hotel or city
  when it was not selected from search, and `lookup` with `extratags=1` returns
  the `opening_hours` tag for an OSM id, which Photon does not carry.
- **Transitous** (`api.transitous.org`, a MOTIS instance) — transit routing.
  Returns a pareto set, not a sorted list, so `route()` picks earliest arrival.
  No fare data, and its `one-to-many` matrix endpoint rejected every coordinate
  format tried. An empty plan is usually not "nothing runs" but "one end is not
  on the walking network": an airport publishes a reference point, and Fukuoka's
  is out on the runway. On empty, `route()` asks `map/stops` what stops are
  within 3 km of each end and `strandedStop()` picks one — only for an end with
  nothing inside 400 m, and only a **rail** stop, because the closest stop to
  Fukuoka Airport is a coach stand to Kumamoto that turned an 11-minute subway
  ride into 72. The leg carries `startedAt`/`endedAt` so the journey view can
  say the clock starts at the station. Two extra requests, never on the happy
  path.
- **MTR fares** (`data/mtr-fares.json`) — the one city with *exact* fares.
  MTR publishes its full station-to-station table as open CSV with no key, so
  `tools/make-mtr-fares.mjs` commits it and `exactFare()` prices Hong Kong
  journeys from it. A network charges entry to exit however many lines you
  change, so it prices first-entry to last-exit, not per leg. Anything it
  cannot cover falls back to the bands below and the result stops being exact.
- Transitous carries **overlapping Tokyo feeds**, and one puts an internal
  route id in `route_short_name`. `routeName()` drops anything that is only
  digits and long, so a passenger sees the line or the mode rather than
  "3582461". Bus routes keep their kanji.
- **Fare table** (`data/fares.json`) — approximate single fares per city, and
  per **operator** where a city lists them. Operators charge separately and the
  fares are summed, because that is how Tokyo works: Metro then Toei is two
  fares, less a named transfer discount. Matching is case-insensitive substring
  on the agency name from the router, first match wins, so specific names come
  before general ones (Toei bus before Toei). Hand-written and not
  authoritative: no agency publishes fares in an open feed without
  registration. It pre-fills the fare dialog and is never added silently, and a
  fare the traveller enters wins. Correct the JSON when a figure is wrong.
  Cities also carry `urbanKm` and optional `routes`: beyond the urban network
  the distance bands are meaningless, so a journey either matches a named route
  or gets **no estimate at all**. Pricing the two-hour Kawaguchiko coach as city
  metro produced 324 yen against a real 2200.
- **Line kilometrage** (`lines` inside `data/fares.json`) — a metro charges by
  its own track, and a straight line across the map is a different number.
  Fukuoka Airport to Hakata is 2.8 km as the crow flies and 3.3 km by rail,
  which is the first fare zone against the second. Where a city lists a line's
  stations and their kilometrage, `railKm()` prices a step on the track instead.
  Fukuoka's Kūkō Line is the one that has it: distances from Wikipedia
  (CC BY-SA), fares from the operator's own published zones. Jorudan is not a
  source for this — its page is a commercial search form, not a dataset.
- **Airport index** (`data/airports.json`) — committed IATA lookup built by
  `tools/make-airports.mjs` from OurAirports. Photon indexes airport names but
  not codes, so "NRT" found nothing; Overpass could query the tag but its public
  endpoints answered 500 or refused. Precached, so it works with no signal.
- **Open-Meteo** (`api.open-meteo.com`) — resolves coordinates to an IANA
  timezone. The day caches it so its local start time becomes the correct UTC
  instant for Transitous without depending on the device timezone.
- **OpenStreetMap tiles** via Leaflet.

Transitous asks three things of anything using its API, and all three are
conditions rather than courtesies: the source must be published under an
open-source licence (MIT, in `LICENSE`); a browser client that cannot set a
User-Agent must put contact details on its own site (the About dialog links
the repository); and the visible attribution must point at
<https://transitous.org/sources/>, not the home page, because the data behind
it is hundreds of separate operators with their own terms.

Committing their dataset is not an option and the question is settled: Japan
alone lists 671 operator feeds, routing needs MOTIS to build a binary index
over the timetables and the OSM street graph, and the feeds are individually
licensed. Self-hosting MOTIS is their own suggested answer if usage grows,
and it needs a server this app deliberately does not have.

Nominatim and Transitous are volunteer-run. Debounce, cache, throttle. Both
return **403 to Node's default User-Agent**, so `providers.js` cannot be
exercised from a Node script — verify it in a browser.

`openHours()` reads OSM's `opening_hours` tag for one weekday and answers with
the day's open windows, `[]` for shut all day, or **null when the tag says
something it cannot read** — public holidays, seasons, sunset, week numbers.
That third answer has to stay distinct from `[]`, or a closed day and an
unparsed one look the same. A stop only ever warns; it never reassures, since
most places have no hours recorded at all.

Because no free transit matrix exists, `optimizeDay()` builds its cost matrix
from `haversine()` distance and only then fetches real legs for the chosen
order. It reorders **only the stops you typed in**: a stop derived from a
booking sits where the clock puts it, and shuffling those moved the arrival
airport behind the afternoon sights until the next `ensureLinkedStops()` run
quietly undid it. The last fixed place before the first movable one anchors
the route, so the answer is the best way round starting from your hotel rather
than the best loop in the abstract.

Attribution for map and transit data is a licence condition, not decoration.
Keep the compact OpenStreetMap and Transitous links visible in the Leaflet
attribution control; the fuller source notes live in About. Leaflet's own prefix
is optional and deliberately omitted to preserve map space on phones.

## Caching

`sw.js` is **network-first for same-origin code**: a reload always gets the
deployed build, and the cache is only a fallback for being offline. Cache-first
served the previous build for one extra reload after every deploy, which meant
bugs got reported against code that no longer existed. Large reference data
under `data/` is stale-while-revalidate, and map tiles stay cache-first with a
400-entry cap.

## Deploying

`main` → site root. `preview` → `/preview/`. One workflow,
`.github/workflows/pages.yml`, runs `test.mjs` and publishes both on any push to
either branch. Settings → Pages must be on **Source: GitHub Actions**.

`data/demo.json` is a worked-through Fukuoka trip. The preview build seeds
itself with it on a first visit, so a change can be tried against real-shaped
data without typing a trip in. `?demo` reloads it anywhere, asking first when a
trip is already saved. Production never seeds itself. Keep it in the current
state shape — `test.mjs` checks its links and dates, not its taste.

## Before finishing a change

```
node test.mjs
```

Then load the page and click through the flow you touched. Most of this app is
network behaviour and DOM wiring that `test.mjs` cannot reach.

See [BACKLOG.md](BACKLOG.md) for what was deliberately left out and when to
build it.
