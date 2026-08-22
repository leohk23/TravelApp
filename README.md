# Travel Planner

Plan a trip's flights and hotels, work out the buses and trains between each
day's stops, drag to reorder, and split the costs with whoever came along.

Static page. No backend, no build step, no npm dependencies — **and no API keys
or billing account.** Everything runs against free, keyless services.

## Run it

```
node serve.mjs          # or: node serve.mjs 8080
```

Then open http://localhost:8000. A plain `file://` open will not work — ES
modules need an HTTP origin. `serve.mjs` is Node stdlib only and is a dev
convenience, not part of the deployed site.

With VS Code's Debugger for Firefox installed, start the server above and press
F5 using **Launch Travel Planner in Firefox**. The configuration lives in
`.vscode/launch.json` and maps the local URL back to this workspace for
breakpoints.

## Where the data comes from

| Need | Service | Cost |
|---|---|---|
| Search-as-you-type places | [Photon](https://photon.komoot.io) (komoot, OSM) | free, no key |
| Resolve a typed hotel or city | [Nominatim](https://nominatim.openstreetmap.org) (OSM) | free, no key, 1 req/sec |
| Public transport routing | [Transitous](https://transitous.org) (MOTIS) | free, no key |
| Destination timezone | [Open-Meteo](https://open-meteo.com/) | free, no key |
| Map tiles | [OpenStreetMap](https://www.openstreetmap.org) | free, no key |

The four data calls are in [providers.js](providers.js); Leaflet loads map tiles
directly. Transit times are converted in the destination timezone, not the
timezone of the phone or computer planning the trip.

Two things worth knowing:

- **Nominatim and Transitous are run by volunteers.** Be a good citizen: the
  app debounces search and caches routed legs. If this ever grows real traffic,
  self-host or pay someone.
- **Transit coverage comes from community-contributed GTFS feeds.** Verified
  working in Hong Kong, Tokyo, London and Berlin. Somewhere without a feed will
  show "no public transport found" — that is missing data, not a broken app.

## Using it

Three ribbon tabs, with the day tabs shared between the first two.

**Itinerary** — flights, trains, ferries and hotels, browsable by category (All,
Stays, Transport, This day) with a search over names and confirmation numbers. Hotels
match every night from check-in to check-out, so you always see where you sleep.
Each booking holds a confirmation number, cost and notes. `+ expense` files a
booking's cost into Expenses. A booked hotel automatically becomes the day's
first stop. Flight endpoints use airport search, while departure and arrival
dates use the same calendar as trip setup. Flights appear on both their
departure and arrival days and link back to their itinerary entry.

**Day plan** — tap + and either search for a place or type a free-form activity
in the same prompt. Drag the ⠿ handle to reorder, and transit legs recompute
with real line numbers and stop names. **Optimise** reorders by geographic
proximity, then re-looks-up the transit. Tap an item to edit its name, duration
or notes. The map starts compact; drag the divider vertically on a phone or
horizontally on a desktop to adjust it. The layout is remembered, and the map's
expand button opens a full-map view when needed.

**Expenses** — use Records to pick a three-letter currency code, add costs and
toggle who shares each one. Summary keeps totals, balances and the fewest
transfers that square everyone up on a separate screen.

**Trip settings** — the gear beside **+ Plan a trip** holds the whole-trip date
range, party members, cities and each day's hours. These settings stay out of
the task-focused Expenses and Day plan screens.

**+ Plan a trip** runs a four-step setup — name, cities, travel dates dragged
on a calendar, then headcount and currency — and generates the day tabs for you.
Cities are spread evenly across the dates; adjust the allocation afterwards in
Trip settings, where ↓ applies a city to every following day.

## Environments

| Branch    | URL                                       |
|-----------|-------------------------------------------|
| `main`    | `https://leohk23.github.io/TravelApp/`         |
| `preview` | `https://leohk23.github.io/TravelApp/preview/` |

Push to `preview` to try things; merge to `main` to ship. Both are published by
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) on every push. The
preview build shows an orange `preview` badge in the header, and shares
localStorage with production since it is the same origin.

## Tests

```
node test.mjs
```

Covers the settle-up split, the route optimiser and the day schedule. CI runs it
before deploying. Note that `providers.js` **cannot** be tested from Node —
Nominatim and Transitous return 403 to Node's default User-Agent. Verify those
in a browser.
