# CLAUDE.md

Travel planner: point-of-interest list per day → real transit legs between them,
drag to reorder, plus expense splitting. Wanderlog is the reference for feel.

## Shape

Five files. Keep it that way unless there is a reason.

| File | Job |
|---|---|
| `index.html` | All markup. Static, no templating. |
| `style.css` | All styles. CSS variables at the top, light/dark via `prefers-color-scheme`. |
| `app.js` | State, Google Maps calls, rendering, event wiring. |
| `logic.js` | Pure functions only — no DOM, no Google. Everything testable lives here. |
| `test.mjs` | `node test.mjs`. Plain `node:assert`, no framework. |

No build step, no bundler, no npm dependencies. ES modules loaded directly by
the browser, which is why it needs an HTTP server rather than `file://`.

## Rules that matter

- **New non-trivial logic goes in `logic.js` with an assert in `test.mjs`.** If
  it can be written as a pure function, it must be.
- **No new dependencies.** Drag-and-drop is the native HTML5 API; dates are
  `<input type="date">`; storage is `localStorage`. Keep reaching for the
  platform first.
- `render()` redraws everything from `state`. It is small and cheap. Do not
  introduce a diffing layer or a framework because a render feels wasteful.
- Google API calls cost money per request. Cache results in `state` (legs are
  already persisted) rather than re-fetching on every render.
- `ponytail:` comments mark deliberate shortcuts and name their ceiling. Read
  the comment before "fixing" the thing it describes.

## State

One object in `localStorage['travelapp']`, written by `save()`:

```js
{
  name, currency, members: [name],
  dayIdx,                                   // which day tab is open
  days: [{
    date, start,                            // "2026-04-02", "09:00"
    pois:  [{ name, address, lat, lng, stayMin }],
    legs:  [ { seconds, summary, fare } | null ],   // legs[i] = pois[i] -> pois[i+1]
  }],
  expenses: [{ desc, amount, payer, sharedBy: [name] }],
}
```

`legs` is derived — `recalc()` rebuilds it — but persisted so a reload does not
re-bill the Directions API. `legs[i] === null` means no transit route was found.

The API key lives in `localStorage['gmapsKey']`, never in the repo.

## Google APIs in use

`Geocoder` (paste-a-list input), `PlaceAutocompleteElement` from the Places
library (search box, with a Geocoder fallback if Places is unavailable),
`DirectionsService` with `travelMode: 'TRANSIT'` (each leg), and
`DistanceMatrixService` (the n×n matrix that `optimizeOrder` consumes). The
matrix is capped at 100 elements per client request, hence the 10-stop ceiling
on Optimise.

## Deploying

`main` → site root. `preview` → `/preview/`. One workflow,
`.github/workflows/pages.yml`, runs `test.mjs` and publishes both on any push
to either branch. Settings → Pages must be on **Source: GitHub Actions**.

The site is public. Nothing secret may enter the repo; the key stays in the
user's browser and should be HTTP-referrer restricted.

## Before finishing a change

```
node test.mjs
```

Then load the page and click through the flow you touched — most of this app is
API behaviour that tests cannot reach.

See [BACKLOG.md](BACKLOG.md) for what was deliberately left out and when to
build it.
