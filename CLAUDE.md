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

## State

One object in `localStorage['travelapp']`, written by `save()`:

```js
{
  name, currency, members: [name], tab,      // tab = which ribbon section is open
  dayIdx,                                    // which day tab is open
  itinerary: [{ id, kind, ref, from, to, start, end, conf, cost, notes }],
  days: [{
    date, city, start,                       // "2026-04-02", "Tokyo", "09:00"
    cityPt,                                  // cached geocode of city, for search bias
    seeded,                                  // hotel origin already offered once
    items: [{ name, address?, lat?, lng?, stayMin }],  // no lat/lng = free-form entry
    legs: { [originIndex]: { seconds, summary, transfers, arrival } | null },
  }],
  expenses: [{ desc, amount, payer, sharedBy: [name], src? }],  // src = booking id
}
```

The first stop of a day is seeded from the hotel covering that night, once, the
first time a stop is added. `seeded` records that it happened so deleting the
hotel stop does not make it come back.

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
  bias; unbiased results are close to useless.
- **Nominatim** (`nominatim.openstreetmap.org`) — resolves one pasted address.
  Hard limit of 1 request/second, so bulk adds sleep 1.1s between calls.
- **Transitous** (`api.transitous.org`, a MOTIS instance) — transit routing.
  Returns a pareto set, not a sorted list, so `route()` picks earliest arrival.
  No fare data, and its `one-to-many` matrix endpoint rejected every coordinate
  format tried.
- **OpenStreetMap tiles** via Leaflet.

Nominatim and Transitous are volunteer-run. Debounce, cache, throttle. Both
return **403 to Node's default User-Agent**, so `providers.js` cannot be
exercised from a Node script — verify it in a browser.

Because no free transit matrix exists, `optimize()` builds its cost matrix from
`haversine()` distance and only then fetches real legs for the chosen order.

Attribution for OSM data is a licence condition, not decoration. It lives in the
Leaflet attribution control and the credit line under the search box.

## Deploying

`main` → site root. `preview` → `/preview/`. One workflow,
`.github/workflows/pages.yml`, runs `test.mjs` and publishes both on any push to
either branch. Settings → Pages must be on **Source: GitHub Actions**.

## Before finishing a change

```
node test.mjs
```

Then load the page and click through the flow you touched. Most of this app is
network behaviour and DOM wiring that `test.mjs` cannot reach.

See [BACKLOG.md](BACKLOG.md) for what was deliberately left out and when to
build it.
