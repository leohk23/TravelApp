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

## Where the data comes from

| Need | Service | Cost |
|---|---|---|
| Search-as-you-type places | [Photon](https://photon.komoot.io) (komoot, OSM) | free, no key |
| Resolve a pasted address | [Nominatim](https://nominatim.openstreetmap.org) (OSM) | free, no key, 1 req/sec |
| Public transport routing | [Transitous](https://transitous.org) (MOTIS) | free, no key |
| Map tiles | [OpenStreetMap](https://www.openstreetmap.org) | free, no key |

All four are in [providers.js](providers.js) — that one file is the whole
integration surface, so swapping in a paid provider later touches nothing else.

Two things worth knowing:

- **Nominatim and Transitous are run by volunteers.** Be a good citizen: the
  app debounces search, caches routed legs, and throttles bulk geocoding to 1
  request/second. If this ever grows real traffic, self-host or pay someone.
- **Transit coverage comes from community-contributed GTFS feeds.** Verified
  working in Hong Kong, Tokyo, London and Berlin. Somewhere without a feed will
  show "no public transport found" — that is missing data, not a broken app.

## Using it

Three ribbon tabs, with the day tabs shared between the first two.

**Itinerary** — flights, trains, ferries and hotels, browsable by category (All,
Stays, Transport, This day) with a search over names and confirmation numbers. Hotels
match every night from check-in to check-out, so you always see where you sleep.
Each booking holds a confirmation number, cost and notes. `+ expense` files a
booking's cost into Expenses; `start day here` drops a hotel in as the day's
first stop.

**Day plan** — search a place to add it, drag the ⠿ handle to reorder, and
transit legs recompute with real line numbers and stop names. **Optimise**
reorders by geographic proximity, then re-looks-up the transit. Edit a stop's
name inline; edit the minutes to change how long you stay.

**Expenses** — set the party, add costs, toggle chips for who shares each one.
The settle-up panel shows the fewest transfers that square everyone up.

**+ Plan a trip** runs a four-step setup — name, cities, travel dates dragged
on a calendar, then headcount and currency — and generates the day tabs for you.
Cities are spread evenly across the dates; adjust the allocation afterwards in
Trip days, where ↓ applies a city to every following day.

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
