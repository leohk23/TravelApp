# Backlog

Deliberately not built yet. Each line says what would trigger building it.
Nothing here is a bug — see `ponytail:` comments in the code for the shortcuts
that have a known ceiling.

## Likely next

- **Opening hours.** Stops are scheduled blind; nothing stops the planner
  putting a museum at 21:00. Needs `regularOpeningHours` from Places on each
  POI and a warning badge in the timeline. *Build when a real trip gets planned
  into a closed door.*
- **Real route shapes on the map.** Currently straight lines between markers.
  One `DirectionsRenderer` per leg draws the actual bus/train path. *Build when
  the straight lines start misleading you about where you actually go.*
- **Per-stop notes / links.** Booking references, ticket URLs, "try the
  tonkotsu". One free-text field on a POI. *Build the first time you keep it in
  a separate notes app.*
- **Pin the last stop too.** Optimise pins only the first (your hotel). Days
  that end back at the hotel want both ends pinned — `optimizeOrder` already
  takes a flag, it just needs `pinLast`. *Build when a day ends far from bed.*

## Bigger, only if the app sticks

- **Multi-currency.** One currency per trip today. Real trips mix HKD/JPY/EUR.
  Needs a rate per expense (entered, not fetched — rates on the day you paid
  are what matter) and conversion in `settleUp`. *Build on the first trip that
  crosses a currency.*
- **Unequal splits.** Everything splits evenly among `sharedBy`. Shares,
  percentages, or exact amounts per person. *Build when someone actually
  objects to an even split.*
- **Sync / sharing.** State is per-browser `localStorage`; Export/Import JSON is
  the current sharing story. A real backend means auth, hosting, and a privacy
  question. *Build only if the party wants to edit the same trip live —
  otherwise Export is enough.*
- **Non-transit modes.** Transit only. Driving, walking-only days, ferries as a
  first-class choice. *Build for a trip where transit is not the default.*
- **More than 10 stops per day for Optimise.** Distance Matrix caps a client
  request at 100 elements. Beyond that, batch the matrix in chunks. *Build if a
  day genuinely needs 11+ stops, which usually means the day is wrong.*

## Known rough edges

- Legs are computed against the day's start time rolled to the future if it has
  already passed. Timetables on a Tuesday differ from a Sunday — set the date
  on the day tab for accurate results.
- Preview and production share `localStorage` (same origin). A broken preview
  build can scribble on your real trip data. Export before testing anything
  destructive.
- No undo. Deleting a stop or a day is immediate; days ask for confirmation,
  stops do not.
