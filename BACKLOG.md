# Backlog

Deliberately not built yet. Each line says what would trigger building it.

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
- **Keep expenses attached when party names change.** Renaming a member can
  leave the old name in `payer`, and fractional splits can leave a one-cent
  remainder. Map old names to new names and settle in integer minor units.
  *Build before settling a real shared trip.*
- **Defensive state loading.** Add a schema version and a tested
  `normalizeState()` so malformed or older localStorage cannot stop the app from
  opening. *Build when the next stored-data migration is needed.*
- **Self-refreshing app shell.** Shell updates rely on manually bumping
  `sw.js`'s cache version. Move to network-first or stale-while-revalidate for
  local shell files. *Build the first time a deployed change looks stale.*
- **Focused boundary tests.** Add mocked provider responses plus checks for
  storage migration, member renaming and route-cache invalidation. Keep
  `node:assert`; no test framework is needed. *Build alongside those fixes.*
- **Dev-server and documentation housekeeping.** Bind `serve.mjs` to localhost,
  replace its string-prefix path check with a real containment check, remove its
  unused import, and keep provider documentation aligned with the runtime.
  *Build before sharing the dev server on a network.*

## Likely next

- **Opening hours.** Stops are scheduled blind; nothing stops the planner
  putting a museum at 21:00. OSM carries an `opening_hours` tag that Photon does
  not return, so this needs a separate Overpass lookup per POI, plus a warning
  badge in the timeline. *Build when a real trip gets planned into a closed door.*
- **Real route shapes on the map.** Currently straight lines between markers.
  Transitous returns an encoded polyline per leg that Leaflet can draw directly.
  *Build when the straight lines start misleading you about where you go.*
- **Pin the last stop too.** Optimise pins only the first stop. Days that end
  back at the hotel want both ends pinned — `optimizeOrder` already takes a
  flag, it just needs `pinLast`. *Build when a day ends far from bed.*
- **Transit fares.** Transitous carries no fare data, so each leg has a manual
  `+ fare` button that prompts for an amount. *Build a per-city fare table if
  typing them gets tedious.*

## Bigger, only if the app sticks

- **Transit-aware Optimise.** Ordering uses straight-line distance, which is
  wrong wherever geography and the network disagree — across a harbour, up a
  hill, along a single rail line. MOTIS has a `one-to-many` endpoint that would
  give a real matrix, but it rejected every coordinate format tried. *Build when
  an optimised day sends you somewhere obviously silly.*
- **Multi-currency.** One currency per trip today. Real trips mix HKD/JPY/EUR.
  Needs a rate per expense (entered, not fetched — the rate on the day you paid
  is what matters) and conversion inside `settleUp`. *Build on the first trip
  that crosses a currency.*
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

- **Drag-to-reorder does nothing on touch.** HTML5 drag-and-drop has no mobile
  support, and the app is now installable as a phone app. Swapping to Pointer
  Events is contained to `itemRow()`. *Build the first time you try to plan on
  a phone.*
- **The only copy of your data is one browser localStorage.** Export/Import is
  parked (above), so clearing site data or losing the device loses every
  confirmation number. Deliberate for now, deliberately recorded here.

- Transit coverage depends on community GTFS feeds. Verified in Hong Kong,
  Tokyo, London and Berlin. Elsewhere you may get "no public transport found",
  which is missing data rather than a bug.
- Timetables differ by weekday, so a day with no date routes against today and
  will be wrong. Set the date on the day tab.
- Cities are only labels on days. Nothing checks that your Tokyo hotel sits on a
  Tokyo day.
- Flight durations are not shown. Depart and arrive are local times, so
  subtracting them across time zones would display a lie. Hotels show nights,
  which is timezone-safe.
- Preview and production share `localStorage` (same origin). A broken preview
  build can scribble on your real trip data.
- No undo. Deleting a day asks for confirmation; deleting a stop does not.
