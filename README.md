# Travel Planner

Static page. Plan a day's stops, let it work out the buses/trains between them,
drag to reorder, split the costs. No backend, no build step, no dependencies.

## Run it

```
python -m http.server 8000     # or: npx serve
```

Then open http://localhost:8000. A plain `file://` open will not work — ES
modules need an HTTP origin.

## Google Maps API key

Click **API key** in the header and paste one. It is kept in your browser's
localStorage only; nothing is committed and there is no server to leak it.

Enable on the key: **Maps JavaScript API**, **Geocoding API**, **Directions
API**, **Distance Matrix API**, and **Places API (New)** for search-as-you-type.
Since the site is public, restrict the key by HTTP referrer to your Pages
domain and `localhost`.

## Using it

- **Search a place** adds a stop. Or paste a list of addresses, one per line.
- Drag the ⠿ handle to reorder — transit legs recompute automatically.
- Edit a stop's name inline; edit the minutes to change how long you stay.
- **Optimise** reorders the day for the least total transit time, keeping the
  first stop where it is (your hotel). Up to 10 stops per day.
- Legs that come back with a fare get a `+` button that files it as an expense.
- **Expenses**: set the party, add costs, toggle chips for who shares each one.
  The settle-up panel shows the fewest transfers that square everyone up.
- **Export / Import** moves a trip between browsers as JSON.

## Environments

| Branch    | URL                                       |
|-----------|-------------------------------------------|
| `main`    | `https://<user>.github.io/<repo>/`         |
| `preview` | `https://<user>.github.io/<repo>/preview/` |

Push to `preview` to try things; merge to `main` to ship. Both are published by
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) on every push. In
repo Settings → Pages, set **Source: GitHub Actions**. The preview build shows
an orange `preview` badge in the header. Preview shares localStorage with prod
(same origin), so a trip you make in one shows up in the other.

## Tests

```
node test.mjs
```

Covers the settle-up split, the route optimiser and the day schedule — the
three bits where a bug is silent. CI runs it before deploying.
