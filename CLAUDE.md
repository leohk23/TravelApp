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
- **No new dependencies.** Leaflet (CDN, SRI-pinned) is the only one. Drag-and-drop
  is the native HTML5 API, dates are `<input type="date">`, the setup wizard is a
  native `<dialog>`, storage is `localStorage`. Keep reaching for the platform first.
- **Nothing that needs an API key.** That constraint is deliberate, not
  incidental — see the services table below.
- `render()` redraws everything from `state`. It is small and cheap. Do not
  introduce a diffing layer or a framework because a render feels wasteful.
- Cache remote results in `state` (legs already persist) rather than re-fetching
  on every render. These are volunteer-run servers.
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
  dayIdx,                                    // which day tab is open
  mapView, split,                             // "split" | "map", plan-pane ratio
  itinerary: [{ id, kind, ref, from, to, fromPt?, toPt?, start, end, conf, cost, notes }],
  days: [{
    date, city, timeZone, start,             // "2026-04-02", "Tokyo", "Asia/Tokyo", "09:00"
    cityPt,                                  // cached geocode of city, for search bias
    items: [{ name, address?, lat?, lng?, stayMin, hotelId?, flightId?, role? }],
    legs: { [originIndex]: { seconds, summary, transfers, arrival } | null },
  }],
  expenses: [{ desc, amount, payer, sharedBy: [name], src? }],  // src = booking id
}
```

Some of a day's stops are **derived from its bookings** and rebuilt by
`ensureLinkedStops()`: the airports a flight passes through that day
(`flightId` plus `role`) and the hotel you sleep in (`hotelId`). Order comes
from the clock, with the hotel placed after the last arrival, so an arrival day
routes airport to hotel rather than starting at the first sight you typed.

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
- **Nominatim** (`nominatim.openstreetmap.org`) — resolves a typed hotel or city
  when it was not selected from search.
- **Transitous** (`api.transitous.org`, a MOTIS instance) — transit routing.
  Returns a pareto set, not a sorted list, so `route()` picks earliest arrival.
  No fare data, and its `one-to-many` matrix endpoint rejected every coordinate
  format tried.
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
- **Airport index** (`data/airports.json`) — committed IATA lookup built by
  `tools/make-airports.mjs` from OurAirports. Photon indexes airport names but
  not codes, so "NRT" found nothing; Overpass could query the tag but its public
  endpoints answered 500 or refused. Precached, so it works with no signal.
- **Open-Meteo** (`api.open-meteo.com`) — resolves coordinates to an IANA
  timezone. The day caches it so its local start time becomes the correct UTC
  instant for Transitous without depending on the device timezone.
- **OpenStreetMap tiles** via Leaflet.

Nominatim and Transitous are volunteer-run. Debounce, cache, throttle. Both
return **403 to Node's default User-Agent**, so `providers.js` cannot be
exercised from a Node script — verify it in a browser.

Because no free transit matrix exists, `optimize()` builds its cost matrix from
`haversine()` distance and only then fetches real legs for the chosen order.

Attribution for OSM data is a licence condition, not decoration. It lives in the
Leaflet attribution control and the credit line under the day plan.

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
