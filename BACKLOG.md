# Backlog

Deliberately not built yet. Each line says what would trigger building it.

Removed once built, so everything here is still outstanding. Gone since the
last sweep: opening-hours warnings, real route shapes on the map, reordering a
day by touch, per-operator and exact fares, carrying a member's expenses through
a rename, and booking costs in a foreign currency.

## Parked (built, then removed on purpose)

- **Export / import a trip as JSON.** Worked fine; pulled to keep the UI focused
  while the shape of the app is still moving. It is the only way to move a trip
  between browsers or back one up, so it returns as soon as the data is worth
  keeping. *Rebuild before the first real trip.* About 20 lines: a Blob download
  of `state`, and a file input that merges the parsed object over `blank()`.
  Give preview a separate storage key when this returns, so testing cannot
  overwrite the production trip.

## Reliability and tidy-up

- **Cancel stale route calculations.** Two overlapping `recalc()` runs can
  write results for an old stop order. Give each day an `AbortController` or a
  generation counter, and capture the original day in every async add. *Build
  when editing while the busy indicator is visible produces a wrong leg.*
- **Validate the persisted route cache.** Changing a trip's dates currently
  recalculates only the selected day, leaving other days with routes for the old
  timetable. Store a small input signature with `legs`, or clear affected days.
  *Build before date-shifting a trip that already has routed days.*
- **Settle up in whole cents.** Renaming a member now carries their expenses
  with them, but an even split of an odd amount still leaves a fraction of a
  cent adrift in `settleUp`. Work in integer minor units and give the
  remainder to someone. *Build before settling a real shared trip.*
- **Defensive state loading.** Add a schema version and a tested
  `normalizeState()` so malformed or older localStorage cannot stop the app from
  opening. *Build when the next stored-data migration is needed.*
- **Focused boundary tests.** Add mocked provider responses plus checks for
  storage migration, member renaming and route-cache invalidation. Keep
  `node:assert`; no test framework is needed. *Build alongside those fixes.*
- **Dev-server and documentation housekeeping.** Bind `serve.mjs` to localhost,
  replace its string-prefix path check with a real containment check, remove its
  unused import, and keep provider documentation aligned with the runtime.
  *Build before sharing the dev server on a network.*

## Likely next

- **Pin the last stop too.** Optimise pins only the first stop. Days that end
  back at the hotel want both ends pinned — `optimizeOrder` already takes a
  flag, it just needs `pinLast`. *Build when a day ends far from bed.*
- **Automatic transit fares.** Checked directly against the API: Transitous
  supports GTFS-Fares but `debug.fares` is 0 in Hong Kong, Tokyo, Berlin and
  Chicago, because almost no agency publishes fares in its feed. Only some
  return `agencyFareUrl`, a link to their fare page. What exists instead is
  `data/mtr-fares.json` (exact, from MTR open data) and `data/fares.json`
  (hand-written bands per city and operator), with a fare you enter yourself
  remembered per journey and beating both. `route()` already carries a `fare`
  field for the day a feed provides one. *Build when a destination you use
  actually publishes fares, or if you decide a paid routing provider is worth
  it — Google Directions does return fares.*

## Bigger, only if the app sticks

- **Self-host the routing.** Every leg is a live call to Transitous, a service
  run by volunteers who ask to be contacted before anyone sends serious load.
  Their own answer to that is to run your own MOTIS instance over their source
  dataset. Committing the data instead is not an option: Japan alone lists 671
  operator feeds, routing needs a binary index built over the timetables and the
  OSM street graph, and the feeds are individually licensed. *Build when this
  stops being one traveller planning one trip — and talk to them first either
  way.*

- **Transit-aware Optimise.** Ordering uses straight-line distance, which is
  wrong wherever geography and the network disagree — across a harbour, up a
  hill, along a single rail line. MOTIS has a `one-to-many` endpoint that would
  give a real matrix, but it rejected every coordinate format tried. *Build when
  an optimised day sends you somewhere obviously silly.*
- **Multi-currency for expenses on the ground.** A *booking* can now be paid in
  another currency with a typed rate, which covers the flights and hotels booked
  before you leave. An expense added on the trip itself is still trip-currency
  only. Same shape: a currency and a rate per expense, and conversion inside
  `settleUp`. *Build on the first trip where the party pays for things in two
  currencies.*
- **Unequal splits.** Everything splits evenly among `sharedBy`. Shares,
  percentages, or exact amounts per person. *Build when someone actually objects
  to an even split.*
- **Sync / sharing.** State is per-browser `localStorage`. A real backend means
  auth, hosting and a privacy question. *Build only if the party wants to edit
  the same trip live — otherwise restoring Export/Import is enough.*
- **Non-transit modes.** Transit only. Driving, walking-only days, ferries as a
  first-class choice. *Build for a trip where transit is not the default.*
- **Vendor Leaflet.** It loads from unpkg with an SRI hash. If unpkg is down the
  map dies, though everything else still works. *Build if you want the site to
  have zero external runtime dependencies.*

## Known rough edges

- **The only copy of your data is one browser localStorage.** Export/Import is
  parked (above), so clearing site data or losing the device loses every
  confirmation number. Deliberate for now, deliberately recorded here.
- **Optimise does nothing, silently, on a short day.** Under four places
  there is no ordering worth computing, so `optimizeDay()` returns null and
  the button appears broken. It needs to say why, or disable itself, or both.
  *Build when someone other than the author presses it.*

- Transit coverage depends on community GTFS feeds. Verified in Hong Kong,
  Tokyo, London and Berlin. Elsewhere you may get "no public transport found",
  which is missing data rather than a bug.
- Timetables differ by weekday, so a day with no date routes against today and
  will be wrong. Set the date on the day tab.
- Cities are only labels on days. Nothing checks that your Tokyo hotel sits on a
  Tokyo day.
- Airport transit coverage is uneven. A journey from an airport falls back to
  the nearest rail stop when the published coordinate is unwalkable, and gives
  up rather than guess when the feed has no rail stop near it — Hong Kong has
  no Airport Express in the index, so HKG still answers "no route".
- Preview and production share `localStorage` (same origin). A broken preview
  build can scribble on your real trip data.
- No undo. Deleting a day asks for confirmation; deleting a stop does not.
