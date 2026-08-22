import { settleUp, optimizeDay, scheduleDay, placePairs, isPlace, mapPlaces, sleepsOn, shiftDates, datesFrom, spreadCities, zonedDateTime, flightSeconds, flightCutoff, fareKey, estimateFare, fareCity, clockOf, pinMinutes, openHours, decodePolyline, bookingCost, fmtInstant, fmtMoney, fmtTime, fmtDur, fmtStay, pad } from './logic.js';
import { search, searchCity, searchAirports, geocode, otherName, openingHours, route, timeZoneAt, haversine, STAY_TAGS } from './providers.js';

const $ = s => document.querySelector(s);
const STORE = 'travelapp';
// Kept in step with sw.js by hand. Its whole job is to answer "is this the
// build we just deployed, or one the browser kept?" from the phone itself.
const BUILD = 'v63';

const blankDay = () => ({ date: '', city: '', timeZone: '', start: '09:00', end: '', items: [], legs: [] });
const blank = () => ({
  name: 'My trip', currency: 'HKD', members: ['Me'], tab: 'overview', itinView: 'all', moneyView: 'records',
  itinerary: [],                  // flights, trains, hotels - the trip skeleton
  days: [blankDay()], dayIdx: 0,   // per-day plans
  mapView: 'split', split: 0.72,   // Day plan layout and plan/map size ratio
  placeLang: 'en',                 // 'en' or 'local' for how place names are shown
  fares: {},                       // journey key -> amount you paid last time
  expenses: [],
});

// Spread over blank() so trips saved by an older version pick up new keys.
let state = { ...blank(), ...JSON.parse(localStorage.getItem(STORE) || 'null') };
for (const d of state.days) {          // days carried `pois` before free-form items existed
  if (d.pois && !d.items) d.items = d.pois;
  delete d.pois;                       // dead once items exists, either way
  d.items ||= [];
  delete d.seeded;                     // replaced by linked hotel-origin items
}
// A return flight is one booking with one confirmation number and two
// journeys. Flights used to be flat, one booking per direction, with the
// return carrying cost 0 because the fare had to go somewhere. The first leg
// keeps the booking's own id, so day stops that already point at it still do.
for (const b of state.itinerary || []) {
  if (b.kind !== 'Flight' || b.legs) continue;
  b.legs = [{
    id: b.id, ref: b.ref, from: b.from, to: b.to,
    fromPt: b.fromPt, toPt: b.toPt, fromTz: b.fromTz, toTz: b.toTz,
    start: b.start, end: b.end,
  }];
  for (const k of ['ref', 'from', 'to', 'fromPt', 'toPt', 'fromTz', 'toTz', 'start', 'end']) delete b[k];
}
// The itinerary filter is per kind now, built from what the trip holds.
if (state.itinView === 'stays') state.itinView = 'kind:Hotel';
if (state.itinView === 'transport') state.itinView = 'all';

// Move old defaults to the compact-map default; leave custom ratios alone.
if (state.split === 0.42 || state.split === 0.6) state.split = 0.72;
if (state.mapView === 'list') state.mapView = 'split';
const save = () => localStorage.setItem(STORE, JSON.stringify(state));
const day = () => state.days[state.dayIdx];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/**
 * Which of a place's two names to lead with, and which to show underneath.
 *
 * A sign at the station says 福岡タワー and your notes say Fukuoka Tower. Both
 * are worth having, so both are shown; the About setting decides which is the
 * heading. A place with only one name shows only that.
 */
const leadName = it => (state.placeLang === 'local' && it.localName ? it.localName : it.name);
const altName = it => (state.placeLang === 'local' && it.localName ? it.name : it.localName);

/**
 * What a stop is marked with, in the plan and on the map alike.
 *
 * A stop that came from a booking says what it is - you recognise your hotel
 * faster than you recognise that it was number 1. Everything else keeps its
 * number, and the numbering still counts the marked ones so the two views
 * never disagree about which stop is which.
 */
const stopMark = (it, n) => (it.flightId ? (it.role === 'arrive' ? '🛬' : '🛫')
  : it.hotelId ? '🏨' : String(n));
/** Only worth labelling days by city when the trip actually visits more than one. */
const multiCity = () => new Set(state.days.map(d => d.city).filter(Boolean)).size > 1;

/* ---------- in-app dialogs (native confirm/alert/prompt break the app illusion) ---------- */
let askResolve = null;

/** Modal yes/no. Resolves false on Escape or Cancel. */
function ask({ title, body = '', confirm = 'Confirm', danger = false }) {
  $('#askTitle').textContent = title;
  $('#askBody').textContent = body;
  $('#askBody').hidden = !body;
  $('#askInputWrap').hidden = true;
  const ok = $('#askOk');
  ok.textContent = confirm;
  ok.className = danger ? 'danger-solid' : 'primary';
  const dlg = $('#ask');
  // showModal() throws on an already-open dialog, and the throw comes out of
  // whatever click asked the question - so the button looks dead. Close the
  // stale one first, which resolves its promise false on the way out.
  if (dlg.open) dlg.close('');
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(res => { askResolve = () => res(dlg.returnValue === 'ok'); });
}

/** Modal single-field prompt. Resolves null if dismissed. */
function askText({ title, body = '', label, value = '', type = 'text', confirm = 'Save', multiline = false }) {
  $('#askTitle').textContent = title;
  $('#askBody').textContent = body;
  $('#askBody').hidden = !body;
  $('#askInputWrap').hidden = false;
  $('#askLabel').firstChild.textContent = label;
  // Notes on a booking run to a couple of sentences - a gate number, what the
  // deposit covers - and a one-line box makes you scroll to read your own words.
  const input = multiline ? $('#askArea') : $('#askInput');
  $('#askInput').hidden = multiline;
  $('#askArea').hidden = !multiline;
  if (!multiline) input.type = type;
  input.value = value;
  const ok = $('#askOk');
  ok.textContent = confirm;
  ok.className = 'primary';
  const dlg = $('#ask');
  dlg.returnValue = '';
  dlg.showModal();
  input.focus();
  input.select?.();
  return new Promise(res => {
    askResolve = () => res(dlg.returnValue === 'ok' ? input.value : null);
  });
}

$('#ask').addEventListener('close', () => { askResolve?.(); askResolve = null; });
$('#askOk').onclick = () => $('#ask').close('ok');
$('#askCancel').onclick = () => $('#ask').close('');
$('#askInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('#ask').close('ok'); }
});

/** Transient message. Non-blocking, because an error should not stop you working. */
function toast(msg, kind = 'bad') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, 4200);
}

let busy = 0;
const setBusy = n => { busy += n; $('#busy').hidden = busy <= 0; };

/** Resolve once per labelled city; an unlabelled day follows its first place. */
async function dayTimeZone(d) {
  if (d.timeZone) return d.timeZone;
  if (d.city && !d.cityPt) {
    const g = await geocode(d.city);
    d.cityPt = { lat: g.lat, lng: g.lng };
    save();
  }
  const point = d.cityPt || d.items.find(isPlace);
  if (!point) throw new Error('Set this day\'s city or add a place before calculating transit.');
  const timeZone = await timeZoneAt(point);
  if (d.city) { d.timeZone = timeZone; save(); }
  return timeZone;
}

/**
 * The instant a stop happens, for a stop you hold a ticket for.
 *
 * The ticket prints a local time at each end of a flight, so a departure
 * airport is read in its own zone and everything else in the day's.
 */
function pinnedInstant(it, dayTz, date) {
  if (!it.at) return null;
  const whole = it.at.includes('T');
  try {
    return zonedDateTime(
      whole ? it.at.slice(0, 10) : date,
      whole ? it.at.slice(11, 16) : it.at,
      (whole && it.atTz) || dayTz,
    );
  } catch { return null; }
}

/**
 * The leg between two stops of the same flight: the flight itself.
 *
 * No transit router has ever heard of CX 510, so asking one produced "no route"
 * between Hong Kong and Fukuoka. The booking already knows how long it takes.
 */
function flightHop(a, b) {
  if (!a?.flightId || a.flightId !== b?.flightId) return null;
  if (a.role !== 'depart' || b.role !== 'arrive') return null;
  const f = findLeg(a.flightId);
  if (!f) return null;
  return {
    seconds: flightSeconds(f.start, f.end, f.fromTz, f.toTz),
    summary: f.ref || 'Flight',
    transfers: 0, lines: [], steps: [], flight: true,
  };
}

/**
 * A day's legs as the plan should show them.
 *
 * A flight is not something a router answers: the booking already says how
 * long it takes. Waiting for a recalculation to fill it in left "no route"
 * printed across the middle of an arrival day, which is both wrong and the
 * first thing you see.
 */
function dayLegs(d) {
  const legs = { ...(d.legs || {}) };
  for (const [from, to] of placePairs(d.items)) {
    if (legs[from]) continue;
    const hop = flightHop(d.items[from], d.items[to]);
    if (hop) legs[from] = hop;
  }
  return legs;
}

/* ---------- routing ---------- */
async function recalc() {
  const d = day();
  const pairs = placePairs(d.items);
  if (!pairs.length) { d.legs = []; save(); return render(); }
  setBusy(1);
  try {
    const tz = await dayTimeZone(d);
    let t = zonedDateTime(d.date, d.start, tz);
    d.legs = [];
    for (const [from, to] of pairs) {
      // Everything between the two places still costs time, notes included, and
      // a stop with a ticket resets the clock to what the ticket says.
      for (let k = from; k < to; k++) {
        t = pinnedInstant(d.items[k], tz, d.date) || t;
        t = new Date(t.getTime() + (d.items[k].stayMin ?? 60) * 60000);
      }
      const hop = flightHop(d.items[from], d.items[to]);
      if (hop) { d.legs[from] = hop; save(); renderPlan(); continue; }
      try {
        const leg = await route(d.items[from], d.items[to], t);
        d.legs[from] = leg;          // keyed by origin index, matching scheduleDay
        if (leg) t = new Date(t.getTime() + leg.seconds * 1000);
      } catch (e) {
        d.legs[from] = null;
        console.warn('routing failed', e);
      }
      save();          // keep partial results if a later leg fails
      renderPlan();
    }
    render();
  } catch (e) {
    toast(e.message);
  } finally { setBusy(-1); }
}

/**
 * No free transit matrix exists, and an n x n plan sweep would be ~90 requests
 * against a community server. So order by straight-line distance, then fetch
 * real transit only for the order we settled on.
 */
async function optimize() {
  const d = day();
  const next = optimizeDay(d.items, haversine);
  if (!next) return toast('Add more places before optimising their order.');
  d.items = next;
  save();
  await recalc();
}

/* ---------- map (Leaflet + OpenStreetMap tiles) ---------- */
let map, layer;
/** The accent as the stylesheet currently has it, so the map follows the theme. */
const rideColour = () =>
  getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3388ff';

function drawMap() {
  const d = day();
  if (typeof L === "undefined") return;   // CDN blocked; the rest of the app still works
  if (!map) {
    map = L.map('map').setView([22.302, 114.17], 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      // Held back a little so the route reads over it. The map is context;
      // the line is the answer.
      opacity: 0.72,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &middot; transit <a href="https://transitous.org/sources/">Transitous</a>',
    }).addTo(map);
    map.attributionControl
      .setPrefix(false)                  // Leaflet credit is welcome, but optional and bulky on phones
      .setPosition('bottomleft');        // frees the other corner for the plan actions
  }
  layer?.remove();
  // Numbered against every stop, drawn for the ones that belong on this map,
  // so a pin and its row in the plan never disagree about which stop it is.
  const all = d.items.filter(isPlace);
  const places = mapPlaces(d.items);
  const legs = dayLegs(d);
  if (!places.length) return;

  layer = L.layerGroup(places.map(p => {
    const mark = stopMark(p, all.indexOf(p) + 1);
    const glyph = mark.length > 1;          // an emoji, not a number
    return L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: `pin${glyph ? ' glyph' : ''}`, html: mark, iconSize: [24, 24] }),
      title: leadName(p),
    }).bindPopup(`<b>${esc(leadName(p))}</b>`
      + (altName(p) ? `<br>${esc(altName(p))}` : '')
      + (p.address ? `<br><small>${esc(p.address)}</small>` : ''));
  })).addTo(map);
  // The route as it is actually travelled, where the router gave us one.
  // A straight line between two stops crosses whatever is in the way, which
  // in Fukuoka means the line to Nokonoshima ran over the sea and the subway
  // appeared to tunnel through the castle grounds.
  const drawn = [];
  const shown = new Set(places);
  for (const [from, to] of placePairs(d.items)) {
    const a = d.items[from], b = d.items[to];
    if (!shown.has(a) || !shown.has(b)) continue;      // one end is off this map
    const steps = legs[from]?.steps || [];
    let any = false;
    for (const s of steps) {
      if (!s.shape) continue;
      const line = decodePolyline(s.shape, s.shapePrecision ?? 5);
      if (line.length < 2) continue;
      any = true;
      const walk = String(s.mode || '').toUpperCase() === 'WALK';
      drawn.push(...line);
      // Back to a plain dashed line in the same colour as the ride, which read
      // better than the amber dots that replaced it. Visibility comes from the
      // tiles being held back instead, which costs the line nothing.
      L.polyline(line, {
        color: rideColour(),
        weight: walk ? 3 : 4,
        opacity: walk ? 0.6 : 0.9,
        dashArray: walk ? '4 6' : null,
      }).addTo(layer);
    }
    // No shape, so say only what is certain: these two stops are connected.
    if (!any) {
      L.polyline([[a.lat, a.lng], [b.lat, b.lng]],
        { weight: 2, opacity: 0.35, dashArray: '2 6' }).addTo(layer);
    }
  }

  const bounds = [...places.map(p => [p.lat, p.lng]), ...drawn];
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
}

/**
 * Swipe the day plan sideways to change day.
 *
 * An accelerator, never the only way: the tabs above still do it, and a
 * gesture nobody can see must not be the sole route to anything.
 *
 * `touch-action: pan-y` on the pane is what makes it work at all. It leaves
 * vertical scrolling to the browser and stops it claiming horizontal drags,
 * so the pointer stream survives long enough to tell a swipe from a scroll.
 * The map is excluded on purpose - Leaflet needs to be panned sideways.
 */
{
  const pane = $('#planPane');
  const wrap = $('#stopsWrap');
  const WAKE_X = 12;        // where a drift becomes a swipe
  const TAKE_X = 0.28;      // and how far across before letting go commits

  let id = null, x0 = 0, y0 = 0, dir = 0, ghost = null, settling = false;

  const shift = px => wrap.style.setProperty('--swipe', `${px}px`);
  const clear = () => {
    ghost?.remove();
    ghost = null; dir = 0;
    wrap.classList.remove('settling');
    shift(0);
  };

  pane.addEventListener('pointerdown', e => {
    // Mouse drags on a desktop are far more often a selection than a swipe.
    if (e.pointerType === 'mouse' || settling) return;
    // A stop being dragged by its grip, or a field being used, is not a swipe.
    if (e.target.closest('.grip, input, select, textarea')) return;
    id = e.pointerId; x0 = e.clientX; y0 = e.clientY; dir = 0;
  });

  pane.addEventListener('pointermove', e => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;

    if (!dir) {
      // Wait until the gesture has said which way it is going. Anything more
      // vertical than horizontal belongs to the scroller.
      if (Math.abs(dx) < WAKE_X) return;
      if (Math.abs(dx) < Math.abs(dy)) { id = null; return; }
      dir = dx < 0 ? 1 : -1;
      const next = state.days[state.dayIdx + dir];
      if (next) {
        // Built now, so the day you are heading for comes with your finger.
        // Seeing it arrive is the only thing that says this gesture exists.
        ghost = document.createElement('ol');
        ghost.className = `stops ghost ${dir > 0 ? 'next' : 'prev'}`;
        ghost.setAttribute('aria-hidden', 'true');
        fillStops(next, ghost);
        wrap.append(ghost);
      }
    }
    // Nothing to move to means a short pull that springs back, which reads as
    // "this is the end of the trip" rather than as a broken gesture.
    shift(ghost ? dx : dx * 0.22);
  });

  pane.addEventListener('pointercancel', () => {   // the browser took it for a scroll
    id = null; clear();
  });

  pane.addEventListener('pointerup', e => {
    if (e.pointerId !== id) return;
    id = null;
    if (!dir) return;

    const dx = e.clientX - x0;
    const width = wrap.offsetWidth || 1;
    const take = ghost && Math.abs(dx) > width * TAKE_X;
    const to = state.dayIdx + dir;

    settling = true;
    wrap.classList.add('settling');
    shift(take ? -dir * width : 0);
    setTimeout(() => {
      settling = false;
      clear();
      if (take) goDay(to, dir > 0 ? 'fwd' : 'back', false);
    }, 210);
  });
}

/* ---------- plan/map views and resizable split ---------- */
const MIN_SPLIT = 0.18, MAX_SPLIT = 0.82;
const EXPAND_ICON = 'M3 3h7v2H5v5H3V3zm11 0h7v7h-2V5h-5V3zM3 14h2v5h5v2H3v-7zm16 0h2v7h-7v-2h5v-5z';
const COLLAPSE_ICON = 'M10 3v5a2 2 0 0 1-2 2H3V8h5V3h2zm4 0h2v5h5v2h-5a2 2 0 0 1-2-2V3zM3 14h5a2 2 0 0 1 2 2v5H8v-5H3v-2zm13 0h5v2h-5v5h-2v-5a2 2 0 0 1 2-2z';

function applyMapLayout() {
  const cols = $('#localCols');
  const view = state.mapView === 'map' ? 'map' : 'split';
  const split = state.split ?? 0.72;
  cols.classList.toggle('view-map', view === 'map');
  cols.querySelector('.pane').style.flexBasis = `${split * 100}%`;
  const splitter = $('#localSplit');
  splitter.setAttribute('aria-orientation', matchMedia('(max-width: 820px)').matches ? 'horizontal' : 'vertical');
  splitter.setAttribute('aria-valuemin', Math.round(MIN_SPLIT * 100));
  splitter.setAttribute('aria-valuemax', Math.round(MAX_SPLIT * 100));
  splitter.setAttribute('aria-valuenow', Math.round(split * 100));
  const full = view === 'map';
  const btn = $('#mapFull');
  btn.title = full ? 'Show plan and map' : 'Expand map';
  btn.setAttribute('aria-label', btn.title);
  btn.querySelector('path').setAttribute('d', full ? COLLAPSE_ICON : EXPAND_ICON);
}

{
  const cols = $('#localCols');
  const splitter = $('#localSplit');
  let dragging = false;

  const vertical = () => matchMedia('(max-width: 820px)').matches;
  const setFromPointer = e => {
    const r = cols.getBoundingClientRect();
    const size = vertical() ? r.height : r.width;
    if (!size) return;
    const next = vertical() ? (e.clientY - r.top) / size : (e.clientX - r.left) / size;
    state.split = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, next));
    applyMapLayout();
    map?.invalidateSize();
  };

  splitter.addEventListener('pointerdown', e => {
    dragging = true;
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('active');
    e.preventDefault();
  });
  splitter.addEventListener('pointermove', e => { if (dragging) setFromPointer(e); });
  splitter.addEventListener('pointerup', e => {
    if (!dragging) return;
    dragging = false;
    try { splitter.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    splitter.classList.remove('active');
    save();
  });
  splitter.addEventListener('pointercancel', () => {
    dragging = false; splitter.classList.remove('active');
  });

  // Keyboard, because a drag handle with no alternative is unusable for some.
  splitter.addEventListener('keydown', e => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const less = vertical() ? e.key === 'ArrowUp' : e.key === 'ArrowLeft';
    const more = vertical() ? e.key === 'ArrowDown' : e.key === 'ArrowRight';
    if (less) state.split = Math.max(MIN_SPLIT, (state.split ?? 0.72) - step);
    else if (more) state.split = Math.min(MAX_SPLIT, (state.split ?? 0.72) + step);
    else return;
    e.preventDefault();
    applyMapLayout(); map?.invalidateSize(); save();
  });

  splitter.addEventListener('dblclick', () => {
    state.split = 0.72; applyMapLayout(); map?.invalidateSize(); save();
  });

  $('#mapFull').onclick = () => {
    state.mapView = state.mapView === 'map' ? 'split' : 'map';
    applyMapLayout(); save();
    setTimeout(() => map?.invalidateSize(), 0);
  };

  addEventListener('resize', () => { applyMapLayout(); map?.invalidateSize(); });
}

/* ---------- fare table ---------- */
// Loaded once, lazily: only a routed day needs it. Precached by the service
// worker, so it works with no signal.
let fareTable = null;
let exactTables = {};     // filename -> published fare table
function loadFares() {
  if (fareTable === null) {
    fareTable = fetch(new URL("./data/fares.json", import.meta.url))
      .then(r => (r.ok ? r.json() : null))
      .then(async t => {
        // Pull in any published tables the cities point at, so an exact fare is
        // ready on the same render as the estimate it replaces.
        const files = [...new Set((t?.cities || []).map(c => c.exact).filter(Boolean))];
        await Promise.all(files.map(f => fetch(new URL("./data/" + f, import.meta.url))
          .then(r => (r.ok ? r.json() : null))
          .then(j => { if (j) exactTables[f] = j; })
          .catch(() => {})));
        fareTable = t;
        render();
        return t;
      })
      .catch(() => { fareTable = undefined; });
  }
  return fareTable;
}

/* ---------- place search ---------- */
/** The stay for a day: the one you check into today, else the one covering it. */
function stayFor(d) {
  if (!d.date) return null;
  const covering = state.itinerary.filter(b => isStay(b.kind) && staysOn(b, d.date));
  return covering.find(b => dateOf(b.start) === d.date) || covering[0] || null;
}

/** Airport stops a flight contributes to this day, with the time they happen. */
function flightStops(d) {
  if (!d.date) return [];
  const out = [];
  for (const b of state.itinerary) {
    if (b.kind !== 'Flight') continue;
    for (const j of journeys(b)) {
      // Only airports picked from the list carry coordinates, and without
      // those there is nothing to route to.
      if (dateOf(j.start) === d.date && j.fromPt) {
        out.push({ at: j.start, tz: j.fromTz || '', role: 'depart', pt: j.fromPt, label: j.from, flightId: j.id });
      }
      if (dateOf(j.end) === d.date && j.toPt) {
        out.push({ at: j.end, tz: j.toTz || '', role: 'arrive', pt: j.toPt, label: j.to, flightId: j.id });
      }
    }
  }
  return out.sort((x, y) => String(x.at).localeCompare(String(y.at)));
}

/**
 * Rebuilds the stops a day derives from its bookings: the airports you pass
 * through and the hotel you sleep in, so the map and the routing show the real
 * journey rather than starting at the first sight you typed in.
 *
 * Order comes from the clock. The hotel lands after the last arrival of the
 * day, because that is when you can actually drop your bags, and anything
 * departing later goes at the end.
 */
async function ensureLinkedStops(d = day()) {
  const hotel = stayFor(d);
  const flights = flightStops(d);

  // The two ends of a flight sit in two timezones and the ticket prints a local
  // time at each, so 08:20 to 13:05 is a three-hour flight, not a five-hour one.
  // Resolved once per booking and kept, because it never changes.
  for (const f of flights) {
    if (f.tz) continue;
    const b = state.itinerary.find(x => x.id === f.flightId);
    if (!b) continue;
    const key = f.role === 'depart' ? 'fromTz' : 'toTz';
    if (b[key]) { f.tz = b[key]; continue; }
    setBusy(1);
    try {
      b[key] = await timeZoneAt(f.pt);
      f.tz = b[key];
      save();
    } catch { /* no zone means no duration; both clock times still read right */ }
    finally { setBusy(-1); }
  }

  let hotelPoint = hotel && hotel.lat != null && hotel.lng != null ? hotel : null;
  if (hotel && !hotelPoint) {
    const q = hotel.from || hotel.ref;
    if (q) {
      setBusy(1);
      try {
        const g = await geocode(q);
        hotel.lat = g.lat; hotel.lng = g.lng;
        if (!hotel.from) hotel.from = g.address;
        hotelPoint = hotel;
      } finally { setBusy(-1); }
    }
  }

  const derived = [];
  // You start the day where you slept. The exception is the day you check in,
  // when the hotel comes after the flight that brings you to it. A departure
  // day also ends in an arrival - the flight home - and putting the hotel after
  // that one had the last morning in Fukuoka starting in Hong Kong.
  const checkingIn = hotel && dateOf(hotel.start) === d.date;
  const lastArrival = checkingIn
    ? flights.reduce((k, f, i) => (f.role === 'arrive' ? i : k), -1)
    : -1;
  flights.forEach((f, i) => {
    derived.push({
      name: f.label || (f.role === 'arrive' ? 'Arrival airport' : 'Departure airport'),
      address: f.pt.name || f.pt.address || '',
      lat: f.pt.lat, lng: f.pt.lng, stayMin: 0,
      at: f.at, atTz: f.tz || '',
      flightId: f.flightId, role: f.role,
    });
    if (i === lastArrival && hotelPoint) derived.push(hotelItem(hotel, hotelPoint));
  });
  if (lastArrival < 0 && hotelPoint) derived.unshift(hotelItem(hotel, hotelPoint));

  // Head is everything up to and including the hotel; the rest is the tail.
  const hotelAt = derived.findIndex(it => it.hotelId);
  const cut = hotelAt >= 0 ? hotelAt + 1 : derived.length;
  const head = derived.slice(0, cut);
  const tail = derived.slice(cut);

  const own = d.items.filter(it => !it.hotelId && !it.flightId);
  const sameSpot = (a, b) => isPlace(a) && isPlace(b) && a.lat === b.lat && a.lng === b.lng;

  // You sleep here tonight, so the day ends where it ends and the last leg is
  // the one home. Not on the check-out date: that morning you leave for good.
  // Nor when the day already finishes at the hotel, which would route a stop
  // to itself.
  const bed = sleepsOn(hotel, d.date) && hotelPoint
    ? { ...hotelItem(hotel, hotelPoint), role: 'night' }
    : null;
  const kept = own.filter(it => ![...head, ...tail, bed].some(x => x && sameSpot(x, it)));
  const body = [...head, ...kept, ...tail];
  const night = bed && !sameSpot(body[body.length - 1] || {}, bed) ? [bed] : [];
  const next = [...body, ...night];

  const key = list => JSON.stringify(list.map(it =>
    [it.name, it.address, it.localName, it.lat, it.lng, it.stayMin, it.hotelId, it.flightId, it.role, it.at, it.atTz]));
  if (key(next) === key(d.items)) return false;
  d.items = next;
  save();
  return true;
}

const hotelItem = (hotel, point) => ({
  name: hotel.ref || hotel.from, address: hotel.from || point.address,
  // Carried through, or the next rebuild of the day's stops quietly drops the
  // name on the signs and the plan goes back to English only.
  localName: hotel.localName, localAddress: hotel.localAddress,
  lat: point.lat, lng: point.lng, stayMin: 0, hotelId: hotel.id,
});

const hotelStartPending = new WeakSet();
async function prepareDayPlan(d = day()) {
  if (hotelStartPending.has(d)) return;
  hotelStartPending.add(d);
  try {
    if (await ensureLinkedStops(d) && d === day()) recalc();
  } catch (err) { toast(`Could not place this day's bookings: ${err.message}`); }
  finally { hotelStartPending.delete(d); }
}

const addPoi = p => {
  day().items.push(p);
  save(); recalc();
};

/** Bias search near where you already are that day, else near the day's city. */
async function biasPoint(d = day()) {
  const places = d.items.filter(isPlace);
  if (places.length) return places[places.length - 1];
  if (d.city && !d.cityPt) {
    try { const g = await geocode(d.city); d.cityPt = { lat: g.lat, lng: g.lng }; save(); } catch { /* no bias */ }
  }
  return d.cityPt || null;
}

/**
 * Attaches type-ahead to an input, positioning the dropdown itself.
 * `bias` is async so it can geocode the day's city on first use.
 * `find` overrides the default place search (city search uses this).
 */
function attachSearch(input, { onPick, onDetails, bias, tags, clearOnPick = false, find }) {
  const list = document.createElement('ul');
  list.className = 'ac-list';
  list.hidden = true;
  list._owner = input;

  let timer, abort, hits = [], cursor = -1, asked = null;

  const place = () => {
    // A modal <dialog> paints in the top layer, which z-index cannot reach, so a
    // dropdown under <body> ends up behind the dialog and its backdrop blur. It
    // has to be a child of that dialog. Resolved here rather than at attach time
    // because rows are built detached and inserted afterwards, when closest()
    // would still return null.
    const host = input.closest('dialog') || document.body;
    if (list.parentElement !== host) {
      // Re-rendered rows leave their dropdowns behind; drop the orphans.
      for (const el of host.querySelectorAll(':scope > .ac-list')) {
        if (el !== list && el._owner && !el._owner.isConnected) el.remove();
      }
      host.append(list);
    }

    const r = input.getBoundingClientRect();
    list.style.left = `${r.left}px`;
    list.style.top = `${r.bottom + 4}px`;
    list.style.width = `${Math.max(r.width, 220)}px`;
  };
  const hide = () => {
    list.hidden = true;
    cursor = -1;
    removeEventListener('scroll', onScroll, true);
    removeEventListener('resize', onScroll);
  };

  // A phone scrolls a little whenever the keyboard opens or a tap drifts, and
  // closing on any scroll made the list look like it vanished at random. Follow
  // the field instead, and only give up once the field itself is off screen.
  const onScroll = () => {
    if (list.hidden) return;
    const r = input.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) hide();
    else place();
  };
  const draw = () => {
    list.replaceChildren(...hits.map((h, i) => {
      const li = document.createElement('li');
      li.className = i === cursor ? 'on' : '';
      li.innerHTML = `<b>${esc(h.name)}</b>${h.kind ? `<span class="ac-kind">${esc(h.kind)}</span>` : ''}${h.label ? `<small>${esc(h.label)}</small>` : ''}`;
      // Keeps focus in the field, so choosing never races the blur handler.
      // Safe to swallow the gesture because the list is capped to six and does
      // not need dragging to scroll.
      li.addEventListener('pointerdown', e => e.preventDefault());
      li.addEventListener('click', () => pick(i));
      return li;
    }));
    // Position and re-parent before revealing, so it never paints at a stale spot.
    if (hits.length) {
      place();
      addEventListener('scroll', onScroll, true);
      addEventListener('resize', onScroll);
    }
    list.hidden = !hits.length;
  };
  const pick = i => {
    const h = hits[i];
    if (!h) return;
    onPick(h);
    if (clearOnPick) input.value = '';
    hits = []; hide();

    // What the search result did not carry: the name on the signs, and the
    // opening hours. Fetched only for a place actually being added, and
    // deliberately after onPick, so the dialog fills straight away and these
    // arrive when they arrive, or never, without holding anything up.
    if (!onDetails || !h.osmId || !asked) return;
    Promise.allSettled([
      otherName(asked.q, { near: asked.near, tags }, h.osmId),
      openingHours(h.osmId),
    ]).then(([n, o]) => {
      const other = n.status === 'fulfilled' ? n.value : null;
      const localName = other?.name && other.name !== h.name ? other.name : null;
      const localAddress = other?.label && other.label !== h.label ? other.label : null;
      const hours = o.status === 'fulfilled' ? o.value : null;
      if (localName || localAddress || hours) onDetails(h, { localName, localAddress, hours });
    });
  };

  input.oninput = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { hits = []; return hide(); }
    timer = setTimeout(async () => {
      abort?.abort();
      abort = new AbortController();
      try {
        const near = await bias?.();
        asked = { q, near };            // what the other-language lookup replays
        hits = (find
          ? await find(q, abort.signal)
          // 'local' drops the lang hint, so Photon answers with the name on the
          // signs: bilingual in Hong Kong, Japanese in Japan.
          : await search(q, { near, tags,
              lang: state.placeLang === 'local' ? null : 'en' }, abort.signal)
        ).slice(0, 6);   // fits without scrolling, see the pointerdown note above
        cursor = -1;
        draw();
      } catch (e) {
        if (e.name !== 'AbortError') { hits = []; hide(); }
      }
    }, 300);
  };

  input.onkeydown = e => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { cursor = Math.min(cursor + 1, hits.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { cursor = Math.max(cursor - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(cursor < 0 ? 0 : cursor); }
    else if (e.key === 'Escape') hide();
  };
  input.onblur = () => setTimeout(hide, 150);
}

/* ---------- day tabs (shared by Itinerary and Day plan) ---------- */

/**
 * Open a day, and say which way you came.
 *
 * The short slide is the only thing that tells you a swipe worked: the plan
 * for two days of a trip can look much alike, and a screen that changes with
 * no motion reads as a screen that did not change.
 */
function goDay(i, from = null, animate = true) {
  if (i < 0 || i >= state.days.length || i === state.dayIdx) return false;
  const back = from ? from === 'back' : i < state.dayIdx;
  state.dayIdx = i;
  save(); render();
  if (state.tab === 'local') prepareDayPlan(day());
  const list = $('#stops');
  list.classList.remove('slide-back', 'slide-fwd');
  if (animate) {
    void list.offsetWidth;                    // restart the animation
    list.classList.add(back ? 'slide-back' : 'slide-fwd');
  }
  return true;
}
function renderDays() {
  const tabs = $('#dayTabs');
  tabs.innerHTML = '';
  const showCity = multiCity();
  state.days.forEach((d, i) => {
    const b = document.createElement('button');
    b.className = 'tab' + (i === state.dayIdx ? ' on' : '');
    // Just the number. Which date and city that is reads underneath, where
    // there is room to spell it out instead of abbreviating it to fit a pill.
    b.textContent = `Day ${i + 1}`;
    b.onclick = () => goDay(i);
    tabs.append(b);
  });
  const add = document.createElement('button');
  add.className = 'tab';
  add.textContent = '+';
  add.title = 'Add a day';
  add.onclick = () => addDayAfter(state.days.length - 1);
  tabs.append(add);

  const d = day();
  const hours = d ? [d.start, d.end].filter(Boolean).join(' to ') : '';
  $('#dayWhen').innerHTML = d?.date
    ? `<span class="dw-date">${esc(fmtDayFull(d.date))}</span>`
      + (showCity && d.city ? `<span class="dw-city">${esc(d.city)}</span>` : '')
      + (hours ? `<span class="dw-hours">${esc(hours)}</span>` : '')
    : '<span class="dw-none">No date set, so transit times cannot be looked up</span>';

  // With a long trip the selected tab can sit off-screen after a re-render.
  tabs.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Inserts a day after `idx`, carrying the date and city forward. */
function addDayAfter(idx) {
  const prev = state.days[idx];
  const d = blankDay();
  if (prev?.date) {
    const t = new Date(`${prev.date}T00:00`);
    t.setDate(t.getDate() + 1);
    d.date = isoDate(t);
    d.city = prev.city;
  }
  state.days.splice(idx + 1, 0, d);
  state.dayIdx = idx + 1;
  save(); render();
}

/* ---------- itinerary: flights, trains, stays ---------- */
const KINDS = ['Flight', 'Train', 'Bus', 'Ferry', 'Car', 'Hotel', 'Other'];

/**
 * What each kind of booking actually needs. A hotel has no seat or terminal,
 * and a flight has no address, so the wording follows the kind rather than
 * asking every booking the same questions.
 */
const KIND_CFG = {
  Flight: { ref: 'Flight number', from: 'From (airport)', to: 'To (airport)',
            conf: 'Booking ref', notes: 'Seat, terminal, baggage…' },
  Train:  { ref: 'Train or service number', from: 'From station', to: 'To station',
            conf: 'Booking ref', notes: 'Coach, platform, class…' },
  Bus:    { ref: 'Service number', from: 'From', to: 'To',
            conf: 'Booking ref', notes: 'Stop, seat…' },
  Ferry:  { ref: 'Sailing', from: 'From port', to: 'To port',
            conf: 'Booking ref', notes: 'Deck, vehicle, cabin…' },
  Car:    { ref: 'Rental company', from: 'Pick up', to: 'Drop off',
            conf: 'Reservation no.', notes: 'Insurance, fuel policy…' },
  Hotel:  { ref: 'Hotel name', from: 'Address', to: '',
            conf: 'Booking no.', notes: 'Breakfast, late check-in, floor…' },
  Other:  { ref: 'Name', from: 'From', to: 'To',
            conf: 'Reference', notes: 'Notes…' },
};
const cfgFor = kind => KIND_CFG[kind] || KIND_CFG.Other;
const ICON = { Flight: '✈', Train: '🚆', Bus: '🚌', Ferry: '⛴', Car: '🚗', Hotel: '🏨', Other: '📌' };
const BILL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h12a1 1 0 0 1 1 1v18l-3-2-2 2-2-2-2 2-2-2-3 2V3a1 1 0 0 1 1-1zm2 5v2h8V7H8zm0 4v2h8v-2H8z"/></svg>';
const BILLED_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h12a1 1 0 0 1 1 1v18l-3-2-2 2-2-2-2 2-2-2-3 2V3a1 1 0 0 1 1-1zm9.3 5.3L11 11.6 8.7 9.3 7.3 10.7l3.7 3.7 5.7-5.7-1.4-1.4z"/></svg>';
const isStay = k => k === 'Hotel';

/**
 * The journeys a booking contains.
 *
 * A flight can be a return: one confirmation number, one payment, two
 * journeys. Everything else is a single journey and is its own, so callers
 * never have to ask which kind they are holding.
 */
const journeys = b => (b.kind === 'Flight' ? (b.legs || (b.legs = [])) : [b]);

/** The journey of this booking that happens on that date, if any. */
const legOn = (b, date) => journeys(b).find(j =>
  dateOf(j.start) === date || (b.kind === 'Flight' && dateOf(j.end) === date)) || null;

/** When a booking first moves, for sorting a mixed itinerary by time. */
const startOf = b => journeys(b).map(j => j.start).filter(Boolean).sort()[0] || '';

/** The journey a day stop was derived from, wherever in the itinerary it lives. */
function findLeg(id) {
  for (const b of state.itinerary) {
    for (const j of journeys(b)) if (j.id === id) return j;
  }
  return null;
}
const dateOf = dt => (dt || '').slice(0, 10);

// A stay covers every night from check-in through check-out morning.
const staysOn = (b, d) => isStay(b.kind) && b.start && dateOf(b.start) <= d && d <= dateOf(b.end || b.start);
const movesOn = (b, d) => !isStay(b.kind) && legOn(b, d) != null;

function movementPhase(b, j, date) {
  if (b.kind !== 'Flight') return b.kind;
  const departs = dateOf(j.start) === date;
  const arrives = dateOf(j.end) === date;
  if (departs && arrives) return 'Flight';
  return departs ? 'Departing flight' : 'Arriving flight';
}

/**
 * When a movement happens on this day, tagged with the end it happens at.
 * "at 08:20" on a flight leaves the reader asking whose 08:20 it is.
 */
const movementTime = (b, j, date) => {
  const departing = dateOf(j.start) === date;
  const t = timeOf(departing ? j.start : j.end);
  const code = b.kind === 'Flight' ? (departing ? j.from : j.to) : '';
  return t && code ? `${t} ${code}` : t;
};

const newLeg = (start = '') =>
  ({ id: crypto.randomUUID(), ref: '', from: '', to: '', start, end: '' });

const newBooking = (kind, start = '') => (kind === 'Flight'
  ? { id: crypto.randomUUID(), kind, ref: '', conf: '', cost: 0, notes: '', legs: [newLeg(start)] }
  : { id: crypto.randomUUID(), kind, ref: '', from: '', to: '', start, end: '', conf: '', cost: 0, notes: '' });

/** Nights for a stay; nothing for transport, whose local times cross time zones. */
const timeOf = dt => (dt && dt.length > 10 ? dt.slice(11, 16) : '');

/** A zone read as a place: "Asia/Hong_Kong" -> "Hong Kong". */
const zoneLabel = tz => String(tz || '').split('/').pop().replace(/_/g, ' ');

function spanLabel(b, j = b) {
  if (!j.start || !j.end) return '';
  if (isStay(b.kind)) {
    // Compare dates only: a stay may carry no time at all.
    const nights = Math.round((parseISO(dateOf(j.end)) - parseISO(dateOf(j.start))) / dayMs);
    return nights > 0 ? `${nights} night${nights > 1 ? 's' : ''}` : '';
  }
  // A flight's two times are on two clocks, so the gap between them is not
  // the flight. Say how long you are actually in the air.
  const secs = b.kind === 'Flight' ? flightSeconds(j.start, j.end, j.fromTz, j.toTz) : null;
  return secs ? `${fmtDur(secs)} in the air` : '';
}

/** What the range button on a stay card reads. */
function stayLabel(b) {
  if (!b.start) return 'Set check-in and check-out';
  const t1 = timeOf(b.start), t2 = timeOf(b.end);
  const from = fmtDayLabel(b.start) + (t1 ? ` ${t1}` : '');
  const to = b.end ? fmtDayLabel(b.end) + (t2 ? ` ${t2}` : '') : '?';
  return `${from}  →  ${to}`;
}

/**
 * A flight's clock times are local to each end, as the airline prints them.
 * The airports are named on the row directly above and the fields you type
 * them into say which is which, so repeating the codes here was three copies
 * of the same fact. What the card adds instead is the time in the air, which
 * is the number you cannot get by subtracting the two.
 */
function journeyLabel(j) {
  if (!j.start) return 'Set depart and arrive';
  const end = dt => fmtDayLabel(dt) + (timeOf(dt) ? ` ${timeOf(dt)}` : '');
  return `${end(j.start)}  →  ${j.end ? end(j.end) : '?'}`;
}

function bookingCard(b) {
  const stay = isStay(b.kind);
  const flight = b.kind === 'Flight';
  const cfg = cfgFor(b.kind);
  const billed = state.expenses.some(e => e.src === b.id);
  const orphan = !onSomeDay(b);
  const legs = journeys(b);
  const currency = b.currency || state.currency;
  const foreign = currency !== state.currency;
  const converted = bookingCost(b, state.currency);

  const li = document.createElement('li');
  li.className = 'booking' + (stay ? ' is-stay' : '');
  li.dataset.bid = b.id;

  // One journey row per leg. A flight can be a return, and then the whole card
  // is one booking: one confirmation number, one payment, two journeys.
  const legRows = legs.map((j, n) => `
    <div class="leg-block"${flight ? ` data-leg="${esc(j.id)}"` : ''}>
      ${flight ? `<div class="brow leg-head">
        <input class="f-legref" value="${esc(j.ref || '')}" placeholder="${esc(cfg.ref)}">
        ${legs.length > 1 ? `<button class="leg-x x" type="button" title="Remove this flight">✕</button>` : ''}
      </div>` : ''}
      <div class="brow${flight ? ' flight-route' : ''}">
        ${flight
          ? `<span class="ac grow"><input class="f-from" value="${esc(j.from || '')}" placeholder="Search departure airport…" autocomplete="off"></span>`
          : `<input class="f-from grow" value="${esc(j.from || '')}" placeholder="${esc(cfg.from)}">`}
        ${stay ? '' : `<span class="arrow">→</span>${flight
          ? `<span class="ac grow"><input class="f-to" value="${esc(j.to || '')}" placeholder="Search arrival airport…" autocomplete="off"></span>`
          : `<input class="f-to grow" value="${esc(j.to || '')}" placeholder="${esc(cfg.to)}">`}`}
        ${stay ? '<button class="mapit" title="Open in OpenStreetMap">map</button>' : ''}
      </div>
      <div class="brow">
        <button class="daterange grow" type="button">${esc(stay ? stayLabel(b) : journeyLabel(j))}</button>
        <small class="span">${esc(spanLabel(b, j))}</small>
      </div>
    </div>`).join('');

  li.innerHTML = `
    <div class="brow head">
      <select class="f-kind" aria-label="Type">${KINDS.map(k =>
        `<option value="${k}"${k === b.kind ? ' selected' : ''}>${ICON[k]} ${k}</option>`).join('')}</select>
      ${stay
        ? `<span class="ac grow"><input class="f-ref" value="${esc(b.ref || '')}" placeholder="Search a hotel…" autocomplete="off"></span>`
        : `<input class="f-ref grow" value="${esc(b.ref || '')}" placeholder="${esc(flight ? 'Airline or booking name' : cfg.ref)}">`}
      ${orphan ? '<span class="chip warn" title="This booking is not on any day of the trip">off-trip</span>' : ''}
      <span class="spacer"></span>
      <button class="x" type="button" title="Remove">✕</button>
      <button class="bill icon${billed ? ' on' : ''}" type="button"${converted > 0 ? '' : ' disabled'}
        title="${billed ? 'Remove from expenses' : 'Add this cost to expenses'}"
        aria-label="${billed ? 'Remove from expenses' : 'Add this cost to expenses'}"
        aria-pressed="${billed}">${billed ? `${BILLED_SVG}` : `${BILL_SVG}`}</button>
      <button class="f-notes icon${b.notes ? ' on' : ''}" type="button"
        title="${b.notes ? 'Edit the notes' : 'Add notes'}"
        aria-label="Notes"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm8 1.5V9h4.5L13 4.5zM7 12v2h10v-2H7zm0 4v2h7v-2H7z"/></svg></button>
    </div>

    ${legRows}
    ${flight ? `<div class="brow"><button class="add-leg" type="button">+ Add a return or onward flight</button></div>` : ''}

    <div class="brow">
      <label>${esc(cfg.conf)}<input class="f-conf" value="${esc(b.conf || '')}" placeholder="optional"></label>
      <span class="cost-lbl"><span class="fld-k">Paid</span>
        <select class="f-cur" aria-label="Currency paid in">${currencyOptions(currency)}</select>
        <input type="number" class="f-cost" step="0.01" min="0" size="8" value="${b.cost || ''}"
          aria-label="Amount paid"></span>
      ${foreign ? `<span class="rate-lbl" title="What one ${esc(currency)} cost you in ${esc(state.currency)}">
        <span class="fld-k">Rate</span>
        <input type="number" class="f-rate" step="0.0001" min="0" size="7" value="${b.rate || ''}"
          aria-label="${esc(state.currency)} per ${esc(currency)}"
          placeholder="${esc(state.currency)} per ${esc(currency)}"></span>` : ''}
      ${foreign ? (converted === null
        ? '<span class="chip warn">Rate needed to total this</span>'
        : `<span class="converted">= ${esc(fmtMoney(converted, state.currency))}</span>`) : ''}
      <span class="spacer"></span>
    </div>

    <div class="brow note-row">
      <button class="f-notes-text${b.notes ? '' : ' empty'}" type="button">${
        b.notes ? esc(b.notes) : esc(cfg.notes)}</button>
    </div>`;

  // Plain text fields only save; anything affecting grouping or derived text redraws.
  const bind = (sel, key, redraw) => {
    const el = li.querySelector(sel);
    if (el) el.onchange = e => {
      b[key] = key === 'cost' || key === 'rate' ? (+e.target.value || 0) : e.target.value;
      save();
      if (redraw) render();
    };
  };
  bind('.f-kind', 'kind', true);
  bind('.f-ref', 'ref');
  bind('.f-conf', 'conf');
  bind('.f-cost', 'cost', true);
  bind('.f-rate', 'rate', true);

  li.querySelector('.f-cur').onchange = e => {
    b.currency = e.target.value;
    if (b.currency === state.currency) delete b.rate;   // nothing to convert
    save(); render();
  };

  const editNotes = async () => {
    const text = await askText({
      title: `Notes on ${b.ref || legs[0]?.ref || b.kind}`,
      label: 'Notes', value: b.notes || '', multiline: true,
      body: cfg.notes,
    });
    if (text === null) return;
    if (text.trim()) b.notes = text.trim(); else delete b.notes;
    save(); render();
  };
  li.querySelector('.f-notes').onclick = editNotes;
  li.querySelector('.f-notes-text').onclick = editNotes;

  li.querySelector('.x').onclick = async () => {
    const ok = await ask({
      title: `Remove ${b.ref || legs[0]?.ref || b.kind}?`,
      body: [billed ? 'Its expense entry is removed too.' : '',
        legs.length > 1 ? `All ${legs.length} journeys on this booking go with it.` : '']
        .filter(Boolean).join(' '),
      confirm: 'Remove', danger: true,
    });
    if (!ok) return;
    state.itinerary = state.itinerary.filter(x => x.id !== b.id);
    state.expenses = state.expenses.filter(e => e.src !== b.id);
    save(); render();
  };

  li.querySelector('.bill').onclick = () => {
    if (billed) state.expenses = state.expenses.filter(e => e.src !== b.id);
    else {
      const amount = bookingCost(b, state.currency);
      if (amount === null) return toast('Set the rate first, so this can be counted in ' + state.currency + '.');
      const route = legs.map(j => [j.from, j.to].filter(Boolean).join(' → ')).filter(Boolean).join(', ');
      state.expenses.push({
        desc: [b.kind, b.ref || legs.map(j => j.ref).filter(Boolean).join(' and '), route]
          .filter(Boolean).join(', '),
        amount, payer: state.members[0], sharedBy: [...state.members], src: b.id,
      });
    }
    save(); render();
  };

  li.querySelector('.add-leg')?.addEventListener('click', () => {
    const last = legs[legs.length - 1];
    // A return starts where the last one landed, which is nearly always right
    // and always easier to correct than to type.
    const back = newLeg();
    if (last) {
      back.from = last.to; back.to = last.from;
      back.fromPt = last.toPt; back.toPt = last.fromPt;
      back.fromTz = last.toTz; back.toTz = last.fromTz;
    }
    b.legs.push(back);
    save(); render();
  });

  // Per-leg wiring. Each journey block owns its own fields.
  li.querySelectorAll('.leg-block').forEach((block, n) => {
    const j = legs[n];
    if (!j) return;

    block.querySelector('.f-legref')?.addEventListener('change', e => {
      j.ref = e.target.value; save(); render();
    });

    block.querySelector('.leg-x')?.addEventListener('click', async () => {
      const ok = await ask({
        title: `Remove ${j.ref || 'this flight'}?`,
        body: 'The rest of the booking stays.', confirm: 'Remove', danger: true,
      });
      if (!ok) return;
      b.legs = b.legs.filter(x => x.id !== j.id);
      save(); render();
    });

    block.querySelector('.daterange')?.addEventListener('click', async () => {
      const res = await pickRange({
        title: j.ref || b.ref || (stay ? 'Hotel dates' : `${b.kind} times`),
        range: j.start ? [dateOf(j.start), dateOf(j.end || j.start)] : null,
        t1: timeOf(j.start),
        t2: timeOf(j.end),
        mode: stay ? 'stay' : 'journey',
        ends: flight ? [j.from, j.to] : null,
      });
      if (!res) return;
      // Times are optional: without one the value stays date-only, which every
      // day-matching helper already handles because they all slice to 10 chars.
      j.start = res.start ? res.start + (res.t1 ? `T${res.t1}` : '') : '';
      j.end = res.end ? res.end + (res.t2 ? `T${res.t2}` : '') : '';
      save(); render();
    });


    if (flight) {
      for (const [sel, key] of [['.f-from', 'from'], ['.f-to', 'to']]) {
        const input = block.querySelector(sel);
        const pointKey = `${key}Pt`;
        input.onchange = e => {
          if (e.target.value !== j[key]) delete j[pointKey];
          j[key] = e.target.value;
          save();
        };
        attachSearch(input, {
          find: searchAirports,
          onPick: h => {
            const shown = h.code || h.name;      // "NRT" beats "Narita International Airport"
            input.value = shown;
            j[key] = shown;
            j[pointKey] = { lat: h.lat, lng: h.lng, name: h.name, address: h.label };
            save();
            // The card wants to say how long the flight takes, and that needs
            // the zone at each end. Asked for on the pick rather than waiting
            // for the first recalculation on the Day plan.
            timeZoneAt(h)
              .then(tz => { j[`${key}Tz`] = tz; save(); renderItinerary(); })
              .catch(() => {});
          },
        });
      }
    } else if (!stay) {
      block.querySelector('.f-from').onchange = e => { j.from = e.target.value; save(); };
      block.querySelector('.f-to').onchange = e => { j.to = e.target.value; save(); };
    }
  });

  if (stay) {
    const nameField = li.querySelector('.f-ref');
    // Typing over the name means a different hotel, so its other-language
    // name goes with it rather than hanging around on the new one.
    nameField.onchange = e => {
      if (e.target.value !== b.ref) { delete b.localName; delete b.localAddress; }
      b.ref = e.target.value;
      save(); render();
    };
    attachSearch(nameField, {
      bias: biasPoint,
      tags: STAY_TAGS,
      onPick: h => {
        // Fills the name, address and coordinates at once, so the map and
        // Day-plan origin never have to geocode a selected hotel again.
        b.ref = h.name; b.from = h.label; b.lat = h.lat; b.lng = h.lng;
        b.osmId = h.osmId;
        delete b.localName; delete b.localAddress;
        save(); render();
      },
      onDetails: (h, extra) => {
        if (b.osmId !== h.osmId) return;
        if (extra.localName) b.localName = extra.localName;
        if (extra.localAddress) b.localAddress = extra.localAddress;
        save(); render();
      },
    });
    const address = li.querySelector('.f-from');
    address.onchange = e => {
      if (e.target.value !== b.from) { delete b.lat; delete b.lng; }
      b.from = e.target.value;
      save();
    };
    li.querySelector('.mapit')?.addEventListener('click', () => {
      const url = b.lat != null
        ? `https://www.openstreetmap.org/?mlat=${b.lat}&mlon=${b.lng}#map=17/${b.lat}/${b.lng}`
        : `https://www.openstreetmap.org/search?query=${encodeURIComponent(b.from || b.ref)}`;
      if (b.lat != null || b.from || b.ref) window.open(url, '_blank', 'noopener');
    });
  }

  return li;
}

/** True when a booking lands on at least one day of the trip. */
function onSomeDay(b) {
  return state.days.some(x => x.date && (isStay(b.kind) ? staysOn(b, x.date) : movesOn(b, x.date)));
}

const fmtDayLabel = dt => (dt
  ? new Date(`${dt.slice(0, 10)}T00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  : '');

/** The long form, for the one place a date is not squeezed into a pill. */
const fmtDayFull = dt => (dt
  ? new Date(`${dt.slice(0, 10)}T00:00`).toLocaleDateString(undefined,
    { weekday: 'long', day: 'numeric', month: 'long' })
  : '');

const haystack = b => [b.kind, b.ref, b.conf, b.notes,
  ...journeys(b).flatMap(j => [j.ref, j.from, j.to])]
  .filter(Boolean).join(' ').toLowerCase();

let itinQuery = '';

/**
 * The filters worth offering, which is the kinds the trip actually holds.
 *
 * A trip with no trains has no reason to offer a train filter, and a count on
 * each one answers "how many of those have I got" without pressing anything.
 */
function renderItinTabs(view, dayDate) {
  const counts = new Map();
  for (const b of state.itinerary) counts.set(b.kind, (counts.get(b.kind) || 0) + 1);
  const onDay = dayDate
    ? state.itinerary.filter(b => (isStay(b.kind) ? staysOn(b, dayDate) : movesOn(b, dayDate))).length
    : state.itinerary.length;

  const tabs = [
    { iv: 'all', label: 'All', icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v2H4zm0 6h16v2H4zm0 6h16v2H4z"/></svg>`, n: state.itinerary.length },
    ...KINDS.filter(k => counts.has(k)).map(k => ({
      iv: `kind:${k}`, label: k, glyph: ICON[k], n: counts.get(k),
    })),
    { iv: 'day', label: 'This day', icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 2h2v2h6V2h2v2h2a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2V2zM5 9v10h14V9H5z"/></svg>`, n: onDay },
  ];

  $('#itinTabs').replaceChildren(...tabs.map(t => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.dataset.iv = t.iv;
    btn.className = t.iv === view ? 'on' : '';
    btn.title = `${t.label} (${t.n})`;
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = (t.icon || `<span class="iv-glyph">${t.glyph}</span>`)
      + `<span class="iv-label">${esc(t.label)}</span>`
      + `<span class="iv-count">${t.n}</span>`;
    btn.onclick = () => { state.itinView = t.iv; save(); render(); syncChrome(); };
    return btn;
  }));
}

function renderItinerary() {
  const view = state.itinView || 'all';
  const d = day().date;
  const q = itinQuery.trim().toLowerCase();

  renderItinTabs(view, d);

  state.itinerary.sort((a2, b2) => (startOf(a2) || '~').localeCompare(startOf(b2) || '~'));

  let shown = state.itinerary;
  if (view.startsWith('kind:')) shown = shown.filter(b => b.kind === view.slice(5));
  else if (view === 'day') {
    shown = d
      ? shown.filter(b => (isStay(b.kind) ? staysOn(b, d) : movesOn(b, d)))
      : shown;
  }
  if (q) shown = shown.filter(b => haystack(b).includes(q));

  const list = $('#bookings');

  if (view === 'day') {
    // In day context the accommodation/transport split is genuinely useful.
    const stays = shown.filter(b => isStay(b.kind));
    const moves = shown.filter(b => !isStay(b.kind));
    list.replaceChildren(
      groupHead('Staying'),
      ...(stays.length ? stays.map(b => bookingCard(b)) : [emptyRow('Nowhere booked for this night.')]),
      groupHead('Getting there'),
      ...(moves.length ? moves.map(b => bookingCard(b)) : [emptyRow('Nothing scheduled to move you today.')]),
    );
    if (!d) list.prepend(hintRow('This day has no date, so every booking is listed. Set one under ⋯.'));
  } else {
    list.replaceChildren(...shown.map(b => bookingCard(b)));
    if (!shown.length) {
      list.append(emptyRow(q
        ? `Nothing matches "${itinQuery}".`
        : 'No bookings here yet. Add a hotel or a flight above.'));
    }
  }

  // A booking paid in another currency with no rate yet cannot be added up,
  // and counting it as nothing would understate the trip. Counted separately.
  let pending = 0;
  const total = shown.reduce((s, b) => {
    const c = bookingCost(b, state.currency);
    if (c === null) { pending++; return s; }
    return s + c;
  }, 0);
  const all = state.itinerary.length;
  $('#bookTotal').innerHTML = all
    ? `<span class="count">${shown.length}${shown.length === all ? '' : ` of ${all}`} booking${all === 1 ? '' : 's'}</span>`
      + `<span class="money">${esc(fmtMoney(total, state.currency))}</span>`
      + (pending ? `<span class="chip warn">${pending} needs a rate</span>` : '')
    : '';
}

function groupHead(text) {
  const li = document.createElement('li');
  li.className = 'grouphead';
  li.textContent = text;
  return li;
}
function emptyRow(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}
function hintRow(text) {
  const li = document.createElement('li');
  li.className = 'hint';
  li.textContent = text;
  return li;
}

/* ---------- day plan ---------- */
let dragFrom = null;

/**
 * Fill a list with a day's stops.
 *
 * Takes the day rather than reading the selected one, because a swipe needs
 * to build the day you are heading towards while you are still on this one.
 */
function fillStops(d, list) {
  list.innerHTML = '';

  // Places are numbered to match the map pins; free-form items are not.
  const ord = new Map();
  d.items.forEach((it, i) => { if (isPlace(it)) ord.set(i, ord.size + 1); });

  const rows = scheduleDay(d.items, dayLegs(d), d.start);
  // Nothing on a departure day should run so late that you miss the plane.
  const cutoff = flightCutoff(d.items, AIRPORT_BUFFER_MIN);
  for (const row of rows) {
    list.append(row.type === 'item' ? itemRow(d, row, ord, cutoff) : legRow(d, row));
  }
  if (!d.items.length) {
    list.innerHTML = '<li class="empty">Use + to add a place or activity.</li>';
  } else if (d.end) {
    // When the day is meant to stop, so the question "does this actually fit"
    // has an answer on the screen rather than in your head.
    const close = clockOf(d.end);
    const last = [...rows].reverse().find(r => r.type === 'item');
    const over = close != null && last && last.depart > close;
    const li = document.createElement('li');
    li.className = 'day-end' + (over ? ' over' : '');
    li.innerHTML = `<span class="when">${esc(d.end)}</span>`
      + `<span class="what">${over
          ? `Day ends, and the plan runs ${esc(fmtDur((last.depart - close) * 60))} past it`
          : 'Day ends'}</span>`;
    list.append(li);
  }
}

function renderPlan() {
  const d = day();
  renderDayBookings(d);
  fillStops(d, $('#stops'));
  drawMap();
}

/**
 * The flights this day cannot show you in the plan itself.
 *
 * A flight with coordinates at both ends becomes two stops and a leg between
 * them, which says the same thing better: the times in their own zones, the
 * hours in the air, and where it sits in the day. Repeating it in a card
 * above was the same fact three times. A flight whose airports were typed
 * rather than picked has no coordinates and so no stops, and then the card is
 * the only sign of it.
 */
function renderDayBookings(d) {
  const host = $('#dayBookings');
  const onPlan = new Set(d.items.map(it => it.flightId).filter(Boolean));
  const flights = [];
  for (const b of d.date ? state.itinerary.filter(x => x.kind === 'Flight') : []) {
    for (const j of journeys(b)) {
      if (onPlan.has(j.id)) continue;
      if (dateOf(j.start) === d.date || dateOf(j.end) === d.date) flights.push([b, j]);
    }
  }
  host.replaceChildren(...flights.map(([b, j]) => {
    const departs = dateOf(j.start) === d.date;
    const arrives = dateOf(j.end) === d.date;
    // Each time is local to its own airport, so each one says which.
    const at = (dt, code) => [timeOf(dt), code].filter(Boolean).join(' ');
    const time = departs && arrives
      ? [at(j.start, j.from), at(j.end, j.to)].filter(Boolean).join(' → ')
      : at(departs ? j.start : j.end, departs ? j.from : j.to);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'day-booking';
    card.innerHTML = `<span class="day-booking-kind">${movementPhase(b, j, d.date)}</span>`
      + `<b>${esc(j.ref || 'Flight')}</b>`
      + (time ? `<time>${esc(time)}</time>` : '')
      // The route is already in the time line once both codes are on it, so
      // what is worth the second row instead is how long the flight takes.
      + (departs && arrives && j.from && j.to
        ? (spanLabel(b, j) ? `<span class="day-booking-route">${esc(spanLabel(b, j))}</span>` : '')
        : j.from || j.to ? `<span class="day-booking-route">${esc(j.from || '?')} → ${esc(j.to || '?')}</span>` : '');
    card.onclick = () => {
      state.itinView = 'day';
      showTab('itinerary');
      setTimeout(() => document.querySelector(`[data-bid="${b.id}"]`)?.scrollIntoView({ block: 'center' }), 0);
    };
    return card;
  }));
  host.hidden = !flights.length;
}

function itemRow(d, row, ord, cutoff = null) {
  const it = d.items[row.i];
  const li = document.createElement('li');
  li.className = 'stop' + (row.place ? '' : ' note') + (it.flightId ? ' via-airport' : '') + (it.hotelId ? ' via-hotel' : '');
  const sub = it.notes || (row.place ? it.address : '') || '';
  const warn = stopWarning(d, it, row, cutoff);
  li.innerHTML = `
    <div class="grip" title="Drag to reorder">⠿</div>
    <div class="marker">${row.place ? stopMark(it, ord.get(row.i)) : '•'}</div>
    <div class="when${row.pinned ? ' fixed' : ''}">${fmtTime(row.arrive)}${
      it.atTz && it.atTz !== d.timeZone ? `<small class="tz">${esc(zoneLabel(it.atTz))} time</small>`
      : row.depart !== row.arrive ? `<small>${fmtTime(row.depart)}</small>` : ''}</div>
    <button class="what-btn" type="button">
      <b>${esc(leadName(it) || (row.place ? 'Unnamed stop' : 'What are you doing?'))}</b>
      ${altName(it) ? `<small class="alt">${esc(altName(it))}</small>` : ''}
      ${sub ? `<small>${it.notes ? '✎ ' : ''}${esc(sub)}</small>` : ''}
    </button>
    ${warn || fmtStay(it.stayMin ?? 60) ? `<div class="stop-tags">
      ${warn ? `<span class="chip ${warn.danger ? 'danger' : 'warn'}" title="${esc(warn.title)}">${esc(warn.text)}</span>` : ''}
      ${fmtStay(it.stayMin ?? 60) ? `<span class="dur-chip">${fmtStay(it.stayMin ?? 60)}</span>` : ''}
    </div>` : ''}`;

  li.dataset.i = row.i;
  li.querySelector('.what-btn').onclick = () => openActivity(row.i);

  // Pointer events rather than HTML5 drag-and-drop. That API has never worked
  // on touch at all, which is the wrong way round for an app used standing in
  // a station. One code path now covers mouse and finger alike.
  //
  // The list is not reordered while dragging: a re-render mid-gesture would
  // drop the pointer capture. The row under the finger is highlighted, and the
  // move happens when you let go.
  const grip = li.querySelector('.grip');
  const rowUnder = e => document
    .elementFromPoint(e.clientX, e.clientY)?.closest('.stop');

  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    dragFrom = row.i;
    li.classList.add('dragging');
  });
  grip.addEventListener('pointermove', e => {
    if (dragFrom !== row.i) return;
    const over = rowUnder(e);
    for (const el of $('#stops').children) {
      el.classList.toggle('over', el === over && el !== li);
    }
  });
  const drop = e => {
    if (dragFrom !== row.i) return;
    const over = rowUnder(e);
    li.classList.remove('dragging');
    for (const el of $('#stops').children) el.classList.remove('over');
    const to = over && over !== li ? +over.dataset.i : null;
    dragFrom = null;
    if (to == null || Number.isNaN(to)) return;
    d.items.splice(to, 0, ...d.items.splice(row.i, 1));
    save(); recalc();
  };
  grip.addEventListener('pointerup', drop);
  grip.addEventListener('pointercancel', () => {
    if (dragFrom !== row.i) return;
    li.classList.remove('dragging');
    for (const el of $('#stops').children) el.classList.remove('over');
    dragFrom = null;
  });
  return li;
}

/* ---------- the full journey, step by step ---------- */
const STEP_ICON = {
  WALK: '🚶', SUBWAY: '🚇', METRO: '🚇', BUS: '🚌', TRAM: '🚊',
  RAIL: '🚆', REGIONAL_RAIL: '🚆', HIGHSPEED_RAIL: '🚄', FERRY: '⛴', COACH: '🚌',
};
const stepIcon = m => STEP_ICON[String(m || '').toUpperCase()] || '🚌';
const prettyMode = m => String(m || '').toLowerCase().replace(/_/g, ' ');

function openJourney(d, row) {
  const leg = row.leg;
  if (!leg) return;
  const tz = d.timeZone || '';

  $('#jTitle').textContent = `${d.items[row.from].name} to ${d.items[row.to].name}`;
  const transfers = leg.transfers ?? 0;
  // An end with no footpath to it is routed from the nearest station instead,
  // so say so rather than letting the figure look like door to door.
  const moved = [leg.startedAt && `from ${leg.startedAt}`, leg.endedAt && `to ${leg.endedAt}`]
    .filter(Boolean).join(' and ');
  $('#jSub').textContent = [
    fmtDur(leg.seconds),
    transfers ? `${transfers} change${transfers > 1 ? 's' : ''}` : 'no changes',
  ].join(', ') + (moved ? `. Timed ${moved}, the nearest station.` : '');

  const steps = leg.steps || [];
  const rows = [];
  steps.forEach((s, i) => {
    // A gap between one step ending and the next starting is time on a platform.
    const prev = steps[i - 1];
    if (prev?.endTime && s.startTime) {
      const wait = Math.round((new Date(s.startTime) - new Date(prev.endTime)) / 1000);
      if (wait >= 60) {
        rows.push(`<li class="j-wait"><span class="j-time"></span>
          <span class="j-body">wait ${esc(fmtDur(wait))}</span></li>`);
      }
    }

    const walk = String(s.mode).toUpperCase() === 'WALK';
    const title = walk
      ? `Walk${s.metres != null ? ` ${s.metres} m` : ''}`
      : `${esc(s.lineName || s.line || prettyMode(s.mode))}${s.headsign ? ` toward ${esc(s.headsign)}` : ''}`;
    const detail = walk
      ? (s.to && s.to !== 'END' ? `to ${esc(s.to)}` : '')
      : [`${esc(s.from)} to ${esc(s.to)}`,
         s.stops ? `${s.stops} stop${s.stops > 1 ? 's' : ''} between` : '',
         esc(s.agency)].filter(Boolean).join('<br>');

    rows.push(`<li class="j-step${walk ? ' walk' : ''}">
      <span class="j-time">${esc(fmtInstant(s.startTime, tz))}</span>
      <span class="j-icon">${stepIcon(s.mode)}</span>
      <span class="j-body"><b>${title}</b>
        ${detail ? `<small>${detail}</small>` : ''}
        <small class="j-dur">${esc(fmtDur(s.seconds))}</small></span></li>`);
  });

  const last = steps[steps.length - 1];
  if (last?.endTime) {
    rows.push(`<li class="j-step arrive"><span class="j-time">${esc(fmtInstant(last.endTime, tz))}</span>
      <span class="j-icon">📍</span>
      <span class="j-body"><b>${esc(d.items[row.to].name)}</b></span></li>`);
  }

  $('#jSteps').innerHTML = rows.join('')
    || '<li class="empty">No step detail for this journey. Recalculate to fetch it.</li>';
  $('#journeyDlg').showModal();
}
$('#jDone').onclick = () => $('#journeyDlg').close();
/* ---------- activity editor ---------- */
let actIdx = null;
let actNew = false;
let actPicked = null;

/** Monday is 0, matching openHours(). getDay() starts the week on Sunday. */
const weekdayOf = date => (new Date(`${date}T00:00`).getDay() + 6) % 7;

/**
 * How this stop is marked when its opening hours are a problem.
 *
 * Only ever a warning. Hours are missing for most places and unreadable for
 * some, and a stop that says nothing is the normal case rather than a
 * reassurance that it is open.
 */
function hoursWarning(d, it, row) {
  if (!row.place || !d.date || !it.hours) return null;
  const open = openHours(it.hours, weekdayOf(d.date));
  if (!open) return null;                       // nothing recorded, or not readable
  if (!open.length) return 'closed all day';
  const window = open.find(([from, to]) => row.arrive >= from && row.arrive < to);
  if (!window) return 'closed when you arrive';
  // Getting in and being thrown out are different problems, so they read
  // differently.
  return row.depart > window[1] ? `closes ${fmtTime(window[1])}` : null;
}

// Long enough to check a bag, clear security and find the gate, and the
// number every airline prints on the ticket for an international flight.
const AIRPORT_BUFFER_MIN = 120;

/**
 * What this stop should warn about, if anything.
 *
 * Missing the plane beats finding a museum shut, so the flight comes first.
 * Only one chip: a row of them is a row nobody reads.
 */
function stopWarning(d, it, row, cutoff) {
  // Only what happens before the gate has to fit. An arrival day also holds a
  // departure - you left home that morning - and nothing after it is late.
  if (cutoff && row.i < cutoff.before && row.depart > cutoff.minutes) {
    return {
      text: 'too close to the flight', danger: true,
      title: `Leave for the airport by ${fmtTime(cutoff.minutes)} to be there two hours before departure.`,
    };
  }
  const hours = hoursWarning(d, it, row);
  return hours ? { text: hours, title: '' } : null;
}

/**
 * The opening hours on the activity dialog, verbatim.
 *
 * Shown as OpenStreetMap wrote them. Rephrasing would hide the parts this app
 * cannot read, and those are exactly the parts worth reading yourself.
 */
function showActDetails() {
  const line = (sel, text) => {
    const el = $(sel);
    el.hidden = !text;
    el.textContent = text || '';
  };
  line('#actAddr', actPicked?.address || actPicked?.label || '');
  // The address as the signs write it, for the half of finding a place that
  // happens after you have stopped looking at the phone.
  line('#actAddrLocal', actPicked?.localAddress || '');
  line('#actHours', actPicked?.hours ? `Opening hours  ${actPicked.hours}` : '');
}

function openActivity(i) {
  actNew = i == null;
  actIdx = i;
  const it = actNew ? { name: '', stayMin: 60 } : day().items[i];
  if (!it) return;
  actPicked = isPlace(it)
    ? { name: it.name, address: it.address, lat: it.lat, lng: it.lng,
        localName: it.localName, localAddress: it.localAddress, hours: it.hours }
    : null;
  $('#actTitle').textContent = actNew ? 'Add to this day' : (isPlace(it) ? 'Stop' : 'Activity');

  $('#actName').value = it.name || '';
  $('#actName').removeAttribute('aria-invalid');
  $('#actError').textContent = '';
  $('#actError').hidden = true;
  // A stop derived from a booking is timed by the booking, and hand-editing it
  // only lasts until the next rebuild. So the field is not offered there.
  const derived = Boolean(it.flightId || it.hotelId);
  $('#actAtWrap').hidden = derived;
  $('#actAt').value = derived ? '' : (it.at || '');
  $('#actMin').value = it.stayMin ?? 60;
  $('#actNotes').value = it.notes || '';
  showActDetails();
  $('#actDelete').hidden = actNew;
  $('#actDlg').returnValue = '';
  $('#actDlg').showModal();
  // Deliberately not focused. On a phone that threw the keyboard up and
  // zoomed the page in before you had even read the dialog; on a stop you are
  // only checking, the field is the last thing you want.
}

/** Reads the dialog back into the item. Returns true if routing must redo. */
function commitActivity() {
  const it = actNew ? {} : day().items[actIdx];
  if (!it) return false;
  const mins = Math.max(0, +$('#actMin').value || 0);
  const timingChanged = mins !== (it.stayMin ?? 60);
  const routeChanged = actPicked && (it.lat !== actPicked.lat || it.lng !== actPicked.lng);
  it.name = $('#actName').value.trim();
  it.stayMin = mins;
  if (actPicked) {
    it.address = actPicked.address || actPicked.label;
    it.lat = actPicked.lat;
    it.lng = actPicked.lng;
    // A different place is not called that any more, so a missing value clears
    // rather than leaving the last one behind.
    if (actPicked.localName) it.localName = actPicked.localName;
    else delete it.localName;
    if (actPicked.localAddress) it.localAddress = actPicked.localAddress;
    else delete it.localAddress;
    if (actPicked.hours) it.hours = actPicked.hours;
    else delete it.hours;
  }
  // A time you set holds the stop there; blank lets it follow the one before.
  if (!(it.flightId || it.hotelId)) {
    const at = $('#actAt').value;
    if (at && at !== it.at) { it.at = at; timingChanged = true; }
    else if (!at && it.at) { delete it.at; timingChanged = true; }
  }
  const notes = $('#actNotes').value.trim();
  if (notes) it.notes = notes; else delete it.notes;
  if (actNew) {
    if (actPicked) addPoi(it);
    else { day().items.push(it); save(); render(); }
    return false;
  }
  save();
  return timingChanged || routeChanged;
}

attachSearch($('#actName'), {
  bias: biasPoint,
  onPick: h => {
    actPicked = { ...h, address: h.label };
    $('#actName').value = h.name;
    showActDetails();
  },
  onDetails: (h, extra) => {
    if (actPicked?.osmId !== h.osmId) return;
    if (extra.localName) actPicked.localName = extra.localName;
    if (extra.localAddress) actPicked.localAddress = extra.localAddress;
    if (extra.hours) actPicked.hours = extra.hours;
    showActDetails();
  },
});

$('#actDone').onclick = () => {
  if (!$('#actName').value.trim()) {
    $('#actName').setAttribute('aria-invalid', 'true');
    $('#actError').textContent = 'Name the place or activity first.';
    $('#actError').hidden = false;
    $('#actName').focus();
    return;
  }
  $('#actDlg').close('ok');
};
$('#actName').addEventListener('input', () => {
  $('#actName').removeAttribute('aria-invalid');
  $('#actError').hidden = true;
});
$('#actCancel').onclick = () => $('#actDlg').close('');
$('#actPresets').onclick = e => {
  const b = e.target.closest('[data-min]');
  if (b) $('#actMin').value = b.dataset.min;
};
$('#actDelete').onclick = async () => {
  const idx = actIdx;
  const it = day().items[idx];
  $('#actDlg').close('delete');               // stacked modals fight over focus
  const ok = await ask({
    title: `Remove ${it?.name || 'this stop'}?`,
    confirm: 'Remove', danger: true,
  });
  if (!ok) return;
  day().items.splice(idx, 1);
  actIdx = null;
  save(); recalc();
};
$('#actDlg').addEventListener('close', () => {
  if ($('#actDlg').returnValue !== 'ok') {
    actIdx = null; actNew = false; actPicked = null; return;
  }
  if (!actNew && actIdx === null) return;
  const needsRoute = commitActivity();
  actIdx = null; actNew = false; actPicked = null;
  if (needsRoute) recalc(); else render();
});

function legRow(d, row) {
  const li = document.createElement('li');

  // A flight is not a journey any transit router has heard of, so it is drawn
  // from the booking rather than asked for and answered with "no route".
  if (row.leg?.flight) {
    li.className = 'leg flight';
    li.innerHTML = `
      <span class="dur">${row.leg.seconds ? esc(fmtDur(row.leg.seconds)) : 'in the air'}</span>
      <span class="via">✈ ${esc(row.leg.summary)}</span>`;
    return li;
  }

  li.className = 'leg' + (row.leg ? '' : ' bad');
  // No agency in the feeds tested publishes GTFS fares, so there is no amount to
  // read. What we can do is recognise a journey you have already paid for.
  const key = row.leg ? fareKey(row.leg.lines) : '';
  const known = key ? state.fares?.[key] : undefined;
  const url = row.leg?.fareUrl;

  // Walking costs nothing, so it gets no fare affordance at all.
  const ridden = (row.leg?.lines || []).length > 0;

  // A fare you entered beats a guess. Only guess when there is nothing better.
  let guess = null;
  if (ridden && known == null) {
    const table = fareTable;
    if (table && typeof table.then !== 'function') {
      const city = fareCity(table, d.items[row.from]);
      guess = estimateFare(table, d.items[row.from], d.items[row.to], row.leg.steps || [],
        city?.exact ? exactTables[city.exact] : null);
    } else loadFares();
  }

  // The fare table speaks the local currency; expenses are kept in the trip's.
  // Prefilling across that gap would record 180 yen as 180 dollars.
  const localCurrency = guess && guess.currency !== state.currency ? guess.currency : null;

  const shown = known != null ? `${esc(state.currency)} ${known}`
    : guess ? `${guess.exact ? "" : "~ "}${esc(guess.currency)} ${guess.amount}`
    : '+ fare';

  li.innerHTML = `
    <span class="dur">${row.leg ? fmtDur(row.leg.seconds) : 'no route'}</span>
    ${row.leg
      ? `<button class="via" type="button" title="Show every step">${esc(row.leg.summary)}</button>`
      : '<span class="via">no public transport found - walk it, or check the day has a date set</span>'}
    ${ridden && url ? `<a class="fare-link" href="${esc(url)}" target="_blank" rel="noopener"
       title="Operator fare information">fares</a>` : ''}
    ${ridden ? `<button class="fare${known != null ? ' known' : guess?.exact ? ' exact' : guess ? ' guess' : ''}"
      title="${known != null ? 'Remembered from the last time you rode this'
        : guess?.exact ? 'Published operator fare. Tap to add it or correct it.'
        : guess ? `Rough ${esc(guess.city)} fare, not from the operator. Tap to confirm or correct.`
        : 'Add what this leg cost'}">${shown}</button>` : ''}`;

  li.querySelector('button.via')?.addEventListener('click',
    () => openJourney(d, row));

  if (li.querySelector('.fare')) li.querySelector('.fare').onclick = async () => {
    const entered = await askText({
      title: 'What did this leg cost?',
      body: (() => {
        // Show the split when more than one operator charged, since that is
        // the part people do not expect.
        const parts = guess?.breakdown?.length > 1
          ? ` Made up of ${guess.breakdown.map(x => `${x.operator} ${x.amount}`).join(" + ")}.`
          : "";
        const source = guess?.exact ? "the operator's published fare" : `a rough ${guess?.city} fare, not from the operator`;
        return localCurrency
        ? `${d.items[row.from].name} → ${d.items[row.to].name}. This leg is ${localCurrency} ${guess.amount} from ${source}.${parts} This trip records expenses in ${state.currency}, so enter what you paid in ${state.currency}.`
        : guess
          ? `${d.items[row.from].name} → ${d.items[row.to].name}. The figure below is ${source}.${parts}`
          : `${d.items[row.from].name} → ${d.items[row.to].name}`;
      })(),
      label: state.currency,
      value: known != null ? String(known)
        : guess && !localCurrency ? String(guess.amount)
        : '',
      type: 'number', confirm: 'Add to expenses',
    });
    const v = +entered;
    if (!v) return;
    // Remembered against the services ridden, so the same journey on another day
    // offers the amount instead of an empty box.
    if (key) state.fares = { ...state.fares, [key]: v };
    state.expenses.push({
      desc: `Transit: ${d.items[row.from].name} → ${d.items[row.to].name}`,
      amount: v, payer: state.members[0], sharedBy: [...state.members],
    });
    save(); render();
  };
  return li;
}

/* ---------- expenses ---------- */

// Somewhere to start rather than every code in the world. A trip already
// carrying something else keeps it, so the list never loses anyone's currency.
const CURRENCIES = ['HKD', 'JPY', 'GBP', 'EUR', 'USD', 'CNY', 'TWD', 'KRW', 'SGD',
  'THB', 'MYR', 'VND', 'PHP', 'IDR', 'INR', 'AUD', 'NZD', 'CAD', 'CHF', 'AED'];

/** The currency picker markup, used by a booking card and the expenses tab alike. */
function currencyOptions(selected) {
  const codes = CURRENCIES.includes(selected) || !selected
    ? CURRENCIES : [selected, ...CURRENCIES];
  return codes.map(c =>
    `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('');
}

/** "Japanese Yen" where the browser knows it, the bare code where it does not. */
const currencyName = code => {
  try {
    const name = new Intl.DisplayNames(undefined, { type: 'currency' }).of(code);
    return name && name !== code ? `${code}  ${name}` : code;
  } catch { return code; }
};

/**
 * Renaming someone has to carry their expenses with them, or the settle-up
 * quietly starts counting a stranger who owes nothing and forgets the person
 * who does.
 */
function renameMember(i, next) {
  const was = state.members[i];
  if (!next || next === was) return;
  if (state.members.includes(next)) return toast(`${next} is already in the party.`);
  state.members[i] = next;
  for (const e of state.expenses) {
    if (e.payer === was) e.payer = next;
    e.sharedBy = e.sharedBy.map(m => (m === was ? next : m));
  }
  save(); render();
}

/** Removing someone re-splits what they shared. What they paid has to move first. */
async function removeMember(i) {
  const who = state.members[i];
  if (state.members.length < 2) return toast('A trip needs at least one person.');
  const paid = state.expenses.filter(e => e.payer === who).length;
  if (paid) {
    return toast(`${who} paid ${paid} expense${paid > 1 ? 's' : ''}. Change the payer on ${paid > 1 ? 'those' : 'that one'} first.`);
  }
  const shared = state.expenses.filter(e => e.sharedBy.includes(who)).length;
  const ok = await ask({
    title: `Remove ${who}?`,
    body: shared ? `${shared} expense${shared > 1 ? 's are' : ' is'} split with ${who}. Their share moves to everyone else.` : '',
    confirm: 'Remove', danger: true,
  });
  if (!ok) return;
  state.members.splice(i, 1);
  for (const e of state.expenses) e.sharedBy = e.sharedBy.filter(m => m !== who);
  save(); render();
}
function renderMoney() {
  const view = state.moneyView === 'summary' ? 'summary' : 'records';
  for (const button of document.querySelectorAll('[data-money-view]')) {
    const on = button.dataset.moneyView === view;
    button.classList.toggle('on', on);
    button.setAttribute('aria-selected', on);
  }
  $('#moneyRecords').hidden = view !== 'records';
  $('#settle').hidden = view !== 'summary';

  $('#currency').innerHTML = currencyOptions(state.currency);

  // A name per row with its own remove, so editing one person cannot fat-finger
  // the rest. Comma-separated text made every edit a re-type of the whole party.
  $('#memberList').replaceChildren(...state.members.map((m, i) => {
    const li = document.createElement('li');
    li.className = 'member';
    li.innerHTML = `<button class="m-name" type="button" title="Rename">${esc(m)}</button>`
      + `<button class="x" type="button" title="Remove from the party">✕</button>`;
    li.querySelector('.m-name').onclick = async () => {
      const next = await askText({
        title: 'Rename', label: 'Name', value: m, confirm: 'Rename',
        body: 'Their expenses come with them.',
      });
      if (next !== null) renameMember(i, next.trim());
    };
    li.querySelector('.x').onclick = () => removeMember(i);
    return li;
  }));

  $('#exPayer').innerHTML = state.members.map(m => `<option>${esc(m)}</option>`).join('');

  const list = $('#expenses');
  list.innerHTML = '';
  state.expenses.forEach((e, i) => {
    const li = document.createElement('li');
    li.className = 'expense';
    li.innerHTML = `
      <div class="what"><b>${esc(e.desc)}</b><small>paid by ${esc(e.payer)}</small>${e.src ? '<span class="chip src">from Itinerary</span>' : ''}</div>
      <div class="amt">${esc(fmtMoney(e.amount, state.currency))}</div>
      <div class="chips"></div>
      <button class="x" title="Remove">✕</button>`;
    const chips = li.querySelector('.chips');
    state.members.forEach(m => {
      const c = document.createElement('button');
      c.className = 'chip' + (e.sharedBy.includes(m) ? ' on' : '');
      c.textContent = m;
      c.title = 'Toggle who shares this';
      c.onclick = () => {
        e.sharedBy = e.sharedBy.includes(m) ? e.sharedBy.filter(x => x !== m) : [...e.sharedBy, m];
        save(); renderMoney();
      };
      chips.append(c);
    });
    li.querySelector('.x').onclick = () => { state.expenses.splice(i, 1); save(); render(); };
    list.append(li);
  });
  if (!state.expenses.length) list.innerHTML = '<li class="empty">No expenses yet.</li>';

  const total = state.expenses.reduce((s, e) => s + (+e.amount || 0), 0);
  const { balances, transfers } = settleUp(state.expenses, state.members);
  $('#settle').innerHTML = `
    <p class="total">Total ${esc(fmtMoney(total, state.currency))}</p>
    <ul class="bal">${state.members.map(m =>
      `<li><span>${esc(m)}</span><b class="${balances[m] < 0 ? 'neg' : 'pos'}">${balances[m] > 0 ? '+' : ''}${esc(fmtMoney(balances[m], state.currency))}</b></li>`).join('')}</ul>
    <ul class="tx">${transfers.length
      ? transfers.map(t => `<li><b>${esc(t.from)}</b> pays <b>${esc(t.to)}</b> ${esc(fmtMoney(t.amount, state.currency))}</li>`).join('')
      : '<li class="empty">All square.</li>'}</ul>`;
}

/**
 * A stop as the overview should read it.
 *
 * A hotel is already named in full, in both languages, on the Staying line
 * just above — printing it again at each end of the day said the same thing
 * three times. An airport is the opposite problem: HKG is a filing code, and
 * what you want on a printed itinerary is the airport.
 */
function ovStop(it) {
  if (it.hotelId) return '<span class="ov-name">🏨 Hotel</span>';
  if (it.flightId) return `<span class="ov-name">${it.role === 'arrive' ? '🛬' : '🛫'} ${
    esc(it.address || it.name || 'Airport')}</span>`;
  return `<span class="ov-name">${esc(leadName(it) || '—')}${
    altName(it) ? `<small>${esc(altName(it))}</small>` : ''}</span>`;
}

/* ---------- overview: the whole trip on one screen ---------- */
const wkday = iso => iso
  ? new Date(`${iso}T00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  : 'no date';

function renderOverview() {
  const el = $("#tripName");
  if (document.activeElement !== el) el.value = state.name;   // never fight the caret
  const dated = state.days.filter(d => d.date).map(d => d.date).sort();

  const cities = [...new Set(state.days.map(d => d.city).filter(Boolean))];
  const facts = [
    ['Days', `${state.days.length}`],
    dated.length ? ['When', `${wkday(dated[0])} – ${wkday(dated[dated.length - 1])}`] : null,
    cities.length ? [cities.length > 1 ? 'Cities' : 'City', cities.join(', ')] : null,
    ['Party', state.members.join(', ')],
  ].filter(Boolean);
  // A label cell and a value cell per fact, filling a two-column grid. Two
  // goes at an inline run of chips both ended up painting the city on top of
  // the dates; grid cells cannot share a space, so this removes the
  // possibility rather than tuning the sizing again.
  $('#ovMeta').innerHTML = facts
    .map(([k, v]) => `<span class="fact-k">${k}</span><span class="fact-v">${esc(v)}</span>`)
    .join('');

  const showCity = multiCity();
  $('#ovDays').replaceChildren(...state.days.map((d, i) => {
    const stays = state.itinerary.filter(b => isStay(b.kind) && d.date && staysOn(b, d.date));
    const moves = state.itinerary.filter(b => !isStay(b.kind) && d.date && movesOn(b, d.date));
    const rows = scheduleDay(d.items, dayLegs(d), d.start);
    const travel = rows.reduce((s, r) => s + (r.type === 'leg' && r.min ? r.min : 0), 0);

    const li = document.createElement('li');
    li.className = 'ovday' + (i === state.dayIdx ? ' on' : '');
    li.innerHTML = `
      <header>
        <b>Day ${i + 1}</b>
        <span>${esc(wkday(d.date))}</span>
        ${showCity && d.city ? `<em>${esc(d.city)}</em>` : ''}
        <span class="spacer"></span>
        ${travel ? `<small>${fmtDur(travel * 60)} travelling</small>` : ''}
      </header>

      ${stays.length ? `<div class="ovline"><span class="k">Staying</span><span>${stays.map(b =>
        `${esc(b.ref || 'Hotel')}${b.localName ? `<span class="ov-local">${esc(b.localName)}</span>` : ''}${
          b.conf ? ` <code>${esc(b.conf)}</code>` : ''}`
      ).join('<br>')}</span></div>` : ''}

      ${moves.length ? `<div class="ovline"><span class="k">Moving</span><span>${moves.map(b => {
        const j = legOn(b, d.date) || journeys(b)[0] || b;
        return `${esc(movementPhase(b, j, d.date))}: ${ICON[b.kind] || ''} ${esc(j.ref || b.ref || b.kind)}${
          j.from || j.to ? ` ${esc(j.from)} → ${esc(j.to)}` : ''}${
          movementTime(b, j, d.date) ? ` at ${esc(movementTime(b, j, d.date))}` : ''}${
          b.conf ? ` <code>${esc(b.conf)}</code>` : ''}`;
      }).join('<br>')}</span></div>` : ''}

      ${d.items.length ? `<ol class="ovstops">${rows.filter(r => r.type === 'item').map(r => `
        <li${r.place ? '' : ' class="note"'}><span class="t">${fmtTime(r.arrive)}</span>${ovStop(d.items[r.i])}</li>`
      ).join('')}</ol>` : '<div class="ovline dim">Nothing planned yet</div>'}`;

    li.onclick = () => { state.dayIdx = i; save(); render(); showTab('local'); };
    return li;
  }));

  if (!state.days.length) $('#ovDays').innerHTML = '<li class="empty">No days yet. Hit “+ Plan a trip”.</li>';
}

/* ---------- shell ---------- */
function render() {
  renderDays(); renderOverview(); renderItinerary(); renderPlan(); renderMoney();
}

/** The day strip only applies to views that are actually scoped to a day. */
function syncChrome() {
  const t = state.tab;
  const dayScoped = t === 'local' || (t === 'itinerary' && (state.itinView || 'all') === 'day');
  $('#daystrip').hidden = !dayScoped;
}

function showTab(name) {
  state.tab = name;
  render();          // pick up edits made under another tab
  for (const b of document.querySelectorAll('[data-tab]')) {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on);
    $('#' + b.dataset.tab).hidden = !on;
  }
  syncChrome();
  // Leaflet measures 0x0 while its container is hidden.
  if (name === 'local') {
    prepareDayPlan();
    setTimeout(() => map?.invalidateSize(), 0);
  }
  save();
}

/* ---------- guided setup ---------- */
const WIZ = [
  ['Plan a trip', 'Four questions, then you have a skeleton to fill in.'],
  ['Where are you going?', 'Add a row per city, in the order you will visit them.'],
  ['When are you going?', 'Drag across your travel dates, or tap the first and last.'],
  ['Who is going?', 'Just the headcount for now, and the money you will spend.'],
];
let wizStep = 0;
let wizRange = null;      // [startISO, endISO] chosen on the wizard calendar

// Built on first use. The calendar factory lives further down the file, and
// constructing eagerly here would depend on its helpers being initialised.
let wizCal = null;
const getWizCal = () => (wizCal ||= makeCalendar($('#wizCal'), {
  getRange: () => wizRange,
  onRange: (s, e) => { wizRange = [s, e]; wizWhen(); },
  hint: 'Days are created for every date in the range.',
}));

/** Live readout under the wizard calendar, and how the cities will be split. */
function wizWhen() {
  const sub = $('#wizSub');
  if (wizStep !== 2) return;
  if (!wizRange) { sub.textContent = WIZ[2][1]; return; }
  const n = spanDays(...wizRange);
  const names = wizCityNames();
  const split = names.length
    ? spreadCities(names, n).reduce((m, c) => m.set(c, (m.get(c) || 0) + 1), new Map())
    : null;
  sub.textContent = split
    ? `${n} days: ${[...split].map(([c, k]) => `${c} ${k}`).join(', ')}`
    : `${n} days`;
}

const wizCityNames = () => [...$('#wCities').children]
  .map(r => r.querySelector('.c-name').value.trim())
  .filter(Boolean);

function cityRow(name = '') {
  const div = document.createElement('div');
  div.className = 'cityrow';
  div.innerHTML = `
    <span class="ac grow"><input class="c-name" value="${esc(name)}" placeholder="Search a city…" autocomplete="off"></span>
    <button class="x" type="button" title="Remove">✕</button>`;
  div.querySelector('.x').onclick = () => {
    if ($('#wCities').children.length > 1) div.remove();
  };
  const input = div.querySelector('.c-name');
  attachSearch(input, {
    find: searchCity,
    onPick: h => {
      input.value = h.name;
      input.dataset.lat = h.lat;             // carried onto the days we generate
      input.dataset.lng = h.lng;
    },
  });
  return div;
}

function wizShow(step) {
  wizStep = Math.max(0, Math.min(WIZ.length - 1, step));
  $('#wizTitle').textContent = WIZ[wizStep][0];
  $('#wizSub').textContent = WIZ[wizStep][1];
  document.querySelectorAll('.wiz-body').forEach(b => { b.hidden = +b.dataset.step !== wizStep; });
  $('#wDots').querySelectorAll('i').forEach((d, i) => d.classList.toggle('on', i === wizStep));
  $('#wBack').disabled = wizStep === 0;
  $('#wNext').textContent = wizStep === WIZ.length - 1 ? 'Create trip' : 'Next';
  if (wizStep === 2) { getWizCal().focus(wizRange?.[0]); wizWhen(); }
  else $('#wizard').querySelector(`.wiz-body[data-step="${wizStep}"] input`)?.focus();
}

function openWizard() {
  $('#wTrip').value = state.name === 'My trip' ? '' : state.name;
  $('#wCities').replaceChildren(cityRow());
  wizRange = tripRange();
  $('#wCount').value = Math.max(1, state.members.length);
  // Same list the Expenses tab offers, so the two never disagree.
  $('#wCur').innerHTML = (CURRENCIES.includes(state.currency) || !state.currency
    ? CURRENCIES : [state.currency, ...CURRENCIES])
    .map(c => `<option value="${esc(c)}"${c === state.currency ? ' selected' : ''}>${esc(currencyName(c))}</option>`).join('');
  wizShow(0);
  $('#wizard').showModal();
}

async function buildTrip() {
  const rows = [...$('#wCities').children].map(r => {
    const el = r.querySelector('.c-name');
    return {
      name: el.value.trim(),
      pt: el.dataset.lat ? { lat: +el.dataset.lat, lng: +el.dataset.lng } : null,
    };
  }).filter(c => c.name);

  if (!rows.length) { toast('Add at least one city.'); wizShow(1); return; }
  if (!wizRange) { toast('Pick your travel dates.'); wizShow(2); return; }

  const n = spanDays(...wizRange);

  if (state.days.some(d => d.items.length)) {
    const ok = await ask({
      title: 'Replace the current plan?',
      body: `The ${state.days.length} day(s) you have now, and their stops, are replaced. Bookings and expenses are kept.`,
      confirm: 'Replace', danger: true,
    });
    if (!ok) return;
  }

  const dates = datesFrom(wizRange[0], n);
  const perDay = spreadCities(rows.map(c => c.name), n);
  const ptOf = new Map(rows.map(c => [c.name, c.pt]));

  state.days = dates.map((date, i) => {
    const d = blankDay();
    d.date = date;
    d.city = perDay[i] || '';
    const pt = ptOf.get(d.city);
    if (pt) d.cityPt = { ...pt };
    return d;
  });

  const count = Math.min(20, Math.max(1, +$('#wCount').value || 1));
  // Placeholder names, renamed on the Expenses tab. "Me" first so the settle-up
  // reads from your own point of view.
  state.members = ['Me', ...Array.from({ length: count - 1 }, (_, i) => `Traveller ${i + 2}`)];

  state.name = $('#wTrip').value.trim() || rows.map(c => c.name).join(' and ');
  state.currency = $('#wCur').value || 'HKD';
  state.dayIdx = 0;
  save();
  $('#wizard').close();
  render();
  showTab('itinerary');
}

$('#setupBtn').onclick = openWizard;
$('#aboutBtn').onclick = () => {
  $('#buildNo').textContent = BUILD;
  $('#placeLang').value = state.placeLang || 'en';
  $('#aboutDlg').showModal();
};
$('#placeLang').onchange = e => { state.placeLang = e.target.value; save(); };
$('#aboutDone').onclick = () => $('#aboutDlg').close();
$('#wAddCity').onclick = () => $('#wCities').append(cityRow());
const bumpCount = n => {
  const el = $('#wCount');
  el.value = Math.min(20, Math.max(1, (+el.value || 1) + n));
};
$('#wLess').onclick = () => bumpCount(-1);
$('#wMore').onclick = () => bumpCount(1);
$('#wBack').onclick = () => wizShow(wizStep - 1);
$('#wCancel').onclick = () => $('#wizard').close();
$('#wNext').onclick = () => (wizStep === WIZ.length - 1 ? buildTrip() : wizShow(wizStep + 1));
$('#wizard').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); $('#wNext').click(); }
});

/* ---------- wiring ---------- */
$('#tripName').oninput = e => { state.name = e.target.value; save(); };
$('#tripName').onchange = () => renderOverview();   // refresh the meta line under it

/* ---------- reusable range calendar ---------- */
const dayMs = 86400000;
const parseISO = iso => new Date(`${iso}T00:00`);
const orderPair = (x, y) => (x <= y ? [x, y] : [y, x]);
const spanDays = (s, e) => Math.round((parseISO(e) - parseISO(s)) / dayMs) + 1;

/** Monday in most of the world, Sunday in some. Fall back to Monday. */
function weekStart() {
  try {
    const info = new Intl.Locale(navigator.language).getWeekInfo?.();
    if (info?.firstDay) return info.firstDay % 7;   // Intl uses 7 for Sunday, Date uses 0
  } catch { /* older browser */ }
  return 1;
}

/**
 * Builds a month calendar inside `host` that selects a date range by dragging
 * or by tapping the two ends.
 *
 *   getRange()  -> [startISO, endISO] | null, the range to highlight
 *   onRange(s,e)-> called once a selection settles
 *
 * Pointer Events cover mouse and touch in one path. The grid keeps the capture
 * and elementFromPoint finds the cell under the finger, because touch pointer
 * events keep targeting whatever the gesture started on.
 */
function makeCalendar(host, { getRange, onRange, hint = '' }) {
  host.classList.add('cal');
  host.innerHTML = `
    <div class="cal-head">
      <button class="cal-prev icon" type="button" aria-label="Previous month">‹</button>
      <strong class="cal-label"></strong>
      <button class="cal-next icon" type="button" aria-label="Next month">›</button>
      <span class="spacer"></span>
      <small class="cal-count"></small>
    </div>
    <div class="cal-dow"></div>
    <div class="cal-grid"></div>
    ${hint ? `<small class="cal-hint">${hint}</small>` : ''}`;

  const labelEl = host.querySelector('.cal-label');
  const dowEl = host.querySelector('.cal-dow');
  const gridEl = host.querySelector('.cal-grid');
  const countEl = host.querySelector('.cal-count');

  let month = new Date();
  month.setDate(1);
  let anchor = null;      // first tap of a two-tap selection
  let preview = null;     // range being dragged, before it settles
  const cells = new Map();

  function render() {
    const y = month.getFullYear(), m = month.getMonth();
    labelEl.textContent = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    const ws = weekStart();
    dowEl.replaceChildren(...Array.from({ length: 7 }, (_, i) => {
      const d = new Date(2024, 0, 7 + ((ws + i) % 7));   // 2024-01-07 was a Sunday
      const s = document.createElement('span');
      s.textContent = d.toLocaleDateString(undefined, { weekday: 'narrow' });
      return s;
    }));

    const lead = (new Date(y, m, 1).getDay() - ws + 7) % 7;
    const cursor = new Date(y, m, 1 - lead);
    const today = isoDate(new Date());

    cells.clear();
    gridEl.replaceChildren(...Array.from({ length: 42 }, () => {
      const iso = isoDate(cursor);
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.d = iso;
      b.textContent = cursor.getDate();
      if (cursor.getMonth() !== m) b.classList.add('out');
      if (iso === today) b.classList.add('today');
      cells.set(iso, b);
      cursor.setDate(cursor.getDate() + 1);
      return b;
    }));
    paint();
  }

  function paint() {
    const r = preview || getRange();
    const [s, e] = r || [];
    for (const [iso, el] of cells) {
      el.classList.toggle('in', !!r && iso >= s && iso <= e);
      el.classList.toggle('s', iso === s);
      el.classList.toggle('e', iso === e);
    }
    if (!r) { countEl.textContent = ''; return; }
    const n = spanDays(s, e);
    countEl.textContent = `${n} day${n > 1 ? 's' : ''}`;
  }

  let dragFrom = null, moved = false;
  const cellAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('[data-d]');

  gridEl.addEventListener('pointerdown', e => {
    const cell = e.target.closest('[data-d]');
    if (!cell) return;
    e.preventDefault();
    gridEl.setPointerCapture(e.pointerId);
    dragFrom = cell.dataset.d;
    moved = false;
    preview = [dragFrom, dragFrom];
    paint();
  });

  gridEl.addEventListener('pointermove', e => {
    if (!dragFrom) return;
    const cell = cellAt(e.clientX, e.clientY);
    if (!cell) return;
    const next = orderPair(dragFrom, cell.dataset.d);
    if (preview && next[0] === preview[0] && next[1] === preview[1]) return;
    moved = true;
    preview = next;
    paint();
  });

  gridEl.addEventListener('pointerup', async e => {
    if (!dragFrom) return;
    const from = dragFrom;
    dragFrom = null;
    try { gridEl.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const to = cellAt(e.clientX, e.clientY)?.dataset.d ?? from;

    if (!moved && to === from) {              // a tap, not a drag
      if (!anchor) {
        anchor = to;                          // wait for the closing tap
        preview = [to, to];
        paint();
        return;
      }
      const [s, en] = orderPair(anchor, to);
      anchor = null; preview = null;
      await onRange(s, en);
      paint();
      return;
    }
    anchor = null;
    const [s, en] = orderPair(from, to);
    preview = null;
    await onRange(s, en);
    paint();
  });

  gridEl.addEventListener('pointercancel', () => {
    dragFrom = null; preview = null; paint();
  });

  host.querySelector('.cal-prev').onclick = () => { month.setMonth(month.getMonth() - 1); render(); };
  host.querySelector('.cal-next').onclick = () => { month.setMonth(month.getMonth() + 1); render(); };

  return {
    render,
    /** Jump to the month containing `iso` and drop any half-finished selection. */
    focus(iso) {
      month = iso ? parseISO(iso) : new Date();
      month.setDate(1);
      anchor = null;
      preview = null;
      render();
    },
  };
}

/* ---------- the trip's own dates ---------- */
/** The trip's current span, used to highlight the calendar. */
function tripRange() {
  const dates = state.days.map(d => d.date).filter(Boolean).sort();
  return dates.length ? [dates[0], dates[dates.length - 1]] : null;
}

const tripCal = makeCalendar($('#tripCal'), {
  getRange: tripRange,
  onRange: applyRange,
  hint: 'Drag across the days you are travelling, or tap the first and last. Days are added or removed to match.',
});

/**
 * Lays the trip across [startISO, endISO].
 *
 * Same number of days as now: a pure shift, so any deliberate gaps survive.
 * Different: days are re-dated consecutively and added or removed at the end.
 */
async function applyRange(startISO, endISO) {
  const n = spanDays(startISO, endISO);

  if (n < state.days.length) {
    const losing = state.days.slice(n).filter(d => d.items.length).length;
    if (losing) {
      const dropped = state.days.length - n;
      const ok = await ask({
        title: `Drop ${dropped} day${dropped > 1 ? 's' : ''}?`,
        body: `${losing} of them still ${losing > 1 ? 'have stops' : 'has stops'} planned. Bookings stay in the Itinerary.`,
        confirm: 'Drop them', danger: true,
      });
      if (!ok) return;
    }
  }

  // A shift needs an existing date to anchor on; a fresh trip has none, so it
  // has to take the consecutive path even when the count happens to match.
  const anchored = state.days.some(d => d.date);
  if (anchored && n === state.days.length) {
    shiftDates(state.days.map(d => d.date), startISO)
      .forEach((date, i) => { state.days[i].date = date; });
  } else {
    const dates = datesFrom(startISO, n);
    for (let i = 0; i < n; i++) {
      if (!state.days[i]) {
        const d = blankDay();
        const prev = state.days[i - 1];       // a new day inherits the city before it
        d.city = prev?.city || '';
        if (prev?.cityPt) d.cityPt = { ...prev.cityPt };
        state.days.push(d);
      }
      state.days[i].date = dates[i];
    }
    state.days.length = n;
    state.dayIdx = Math.min(state.dayIdx, n - 1);
  }

  save();
  render();
  renderDayTable();
  recalc();
}

/* ---------- shared booking date dialog ---------- */
let rangePending = null;      // [startISO, endISO] chosen but not yet saved
let rangeResolve = null;
let rangeMode = 'stay';

const rangeCal = makeCalendar($('#rangeCal'), {
  getRange: () => rangePending,
  onRange: (s, e) => { rangePending = [s, e]; updateRangeSub(); },
  hint: 'Drag across the dates, or tap the first and last.',
});

function updateRangeSub() {
  if (!rangePending) { $('#rangeSub').textContent = 'No dates set.'; return; }
  if (rangeMode === 'journey') {
    const days = spanDays(...rangePending);
    $('#rangeSub').textContent = days === 1 ? 'Same-day journey.' : `${days} calendar days.`;
    return;
  }
  const nights = spanDays(...rangePending) - 1;
  $('#rangeSub').textContent = nights > 0
    ? `${nights} night${nights > 1 ? 's' : ''}`
    : 'Same-day check-in and check-out.';
}

/** Resolves { start, end, t1, t2 } or null. Times may be empty strings. */
function pickRange({ title, range, t1 = '', t2 = '', mode = 'stay', ends = null }) {
  $('#rangeTitle').textContent = title;
  rangeMode = mode;
  rangePending = range;
  // Naming the airport on each field is the whole answer to "which clock is
  // this?": you copy both times straight off the ticket.
  $('#rangeLabel1').textContent = mode !== 'journey' ? 'Check in'
    : ends?.[0] ? `Departs ${ends[0]}` : 'Depart';
  $('#rangeLabel2').textContent = mode !== 'journey' ? 'Check out'
    : ends?.[1] ? `Arrives ${ends[1]}` : 'Arrive';
  $('#rangeCal .cal-hint').textContent = mode !== 'journey'
    ? 'Choose the check-in and check-out dates.'
    : ends
      ? 'Choose the departure and arrival dates, then copy both times from your ticket. Each one is the local time at its own airport.'
      : 'Choose the departure and arrival dates.';
  $('#rangeT1').value = t1;
  $('#rangeT2').value = t2;
  updateRangeSub();
  rangeCal.focus(range?.[0] || tripRange()?.[0]);
  $('#rangeDlg').returnValue = '';
  $('#rangeDlg').showModal();
  return new Promise(res => { rangeResolve = res; });
}

$('#rangeDlg').addEventListener('close', () => {
  const dlg = $('#rangeDlg');
  const done = rangeResolve;
  rangeResolve = null;
  if (!done) return;
  if (dlg.returnValue !== 'ok') return done(null);
  if (!rangePending) return done({ start: '', end: '', t1: '', t2: '' });
  done({ start: rangePending[0], end: rangePending[1], t1: $('#rangeT1').value, t2: $('#rangeT2').value });
});
$('#rangeOk').onclick = () => $('#rangeDlg').close('ok');
$('#rangeCancel').onclick = () => $('#rangeDlg').close('');
$('#rangeClear').onclick = () => { rangePending = null; updateRangeSub(); rangeCal.render(); };

/* ---------- trip days: edit every date and city in one table ---------- */
function openDayDlg() {
  const first = state.days.find(d => d.date);
  tripCal.focus(first?.date);
  renderDayTable();
  if (!$('#dayDlg').open) $('#dayDlg').showModal();   // showModal throws if already open
}

/**
 * The selected day's hours, on their own line under the calendar.
 *
 * They started life as two more cells in the table, which left the city with
 * about eight characters to live in. Only one day is being looked at anyway,
 * so they belong beside the calendar rather than repeated on every row.
 */
function renderDayHours() {
  const d = day();
  $('#ddHoursDay').textContent = `Day ${state.dayIdx + 1}`;
  $('#ddStart').value = d?.start || '';
  $('#ddEnd').value = d?.end || '';
}

$('#ddStart').onchange = e => {
  const d = day();
  d.start = e.target.value || '09:00';
  save(); render(); renderDayHours();
  recalc();                     // the whole plan hangs off the start time
};
$('#ddEnd').onchange = e => {
  day().end = e.target.value;
  save(); render(); renderDayHours();   // the end only draws a line, so no refetch
};

function renderDayTable() {
  renderDayHours();
  $('#ddRows').replaceChildren(...state.days.map((d, i) => {
    const tr = document.createElement('tr');
    if (i === state.dayIdx) tr.className = 'on';
    tr.innerHTML = `
      <th><button class="r-go" type="button" title="Open this day">Day ${i + 1}</button></th>
      <td class="r-when">${esc(wkday(d.date))}</td>
      <td><span class="ac"><input class="r-city" value="${esc(d.city || '')}" placeholder="City" autocomplete="off"></span></td>

      <td><button class="r-fill" type="button" title="Use this city for every later day">↓</button></td>
      <td><button class="r-del x" type="button" title="Delete this day"${state.days.length < 2 ? ' disabled' : ''}>✕</button></td>`;

    tr.querySelector('.r-go').onclick = () => {
      state.dayIdx = i;
      save(); render(); renderDayTable();
    };

    const cityInput = tr.querySelector('.r-city');
    attachSearch(cityInput, {
      find: searchCity,
      onPick: h => {
        d.city = h.name;
        d.cityPt = { lat: h.lat, lng: h.lng };
        delete d.timeZone;
        cityInput.value = h.name;
        save(); render(); renderDayTable();
      },
    });
    cityInput.onchange = e => {                 // free text is fine, it is only a label
      const v = e.target.value.trim();
      if (v === (d.city || '')) return;         // unchanged, e.g. straight after a pick
      d.city = v;
      delete d.cityPt;                          // the cached point belonged to the old city
      delete d.timeZone;
      save(); render(); renderDayTable();
    };


    tr.querySelector('.r-fill').onclick = () => {
      for (let k = i + 1; k < state.days.length; k++) {
        state.days[k].city = d.city;
        if (d.cityPt) state.days[k].cityPt = { ...d.cityPt };
        else delete state.days[k].cityPt;
        if (d.timeZone) state.days[k].timeZone = d.timeZone;
        else delete state.days[k].timeZone;
      }
      save(); render(); renderDayTable();
      toast(`${d.city || 'Blank'} applied to the following days.`, 'ok');
    };

    tr.querySelector('.r-del').onclick = async () => {
      if (state.days.length < 2) return toast('A trip needs at least one day.');
      $('#dayDlg').close();                     // stacked modals fight over focus
      const ok = await ask({
        title: `Delete day ${i + 1}?`,
        body: 'Its stops are lost. Bookings stay in the Itinerary.',
        confirm: 'Delete day', danger: true,
      });
      if (ok) {
        state.days.splice(i, 1);
        state.dayIdx = Math.min(state.dayIdx, state.days.length - 1);
        save(); render();
      }
      openDayDlg();
    };

    return tr;
  }));
}

$('#dayEdit').onclick = openDayDlg;
$('#ddDone').onclick = () => $('#dayDlg').close();
$('#ddAdd').onclick = () => { addDayAfter(state.days.length - 1); renderDayTable(); tripCal.render(); };
/** First night of the trip with no stay booked, so "+ Hotel" lands somewhere useful. */
function firstUncoveredDate() {
  for (const x of state.days) {
    if (!x.date) continue;
    if (!state.itinerary.some(b => isStay(b.kind) && staysOn(b, x.date))) return x.date;
  }
  return state.days.find(x => x.date)?.date || '';
}

const addBooking = (kind, time) => {
  const inDayView = state.tab === 'itinerary' && (state.itinView || 'all') === 'day';
  const d = inDayView
    ? day().date
    : (kind === 'Hotel' ? firstUncoveredDate() : state.days.find(x => x.date)?.date || '');
  const b = newBooking(kind, d ? `${d}T${time}` : '');
  if (kind === 'Hotel' && d) {                 // default to one night
    const t = new Date(`${d}T00:00`);
    t.setDate(t.getDate() + 1);
    b.end = `${isoDate(t)}T11:00`;
  }
  state.itinerary.push(b);
  // The filters are per kind now, so adding a hotel while looking at flights
  // would file it somewhere you cannot see - which looks exactly like it not
  // having been saved. Move to where it landed.
  const view = state.itinView || 'all';
  if (view.startsWith(`kind:`) && view !== `kind:${kind}`) state.itinView = `kind:${kind}`;
  save(); renderItinerary();
  document.querySelector(`[data-bid="${b.id}"] .f-ref`)?.focus();
};
/* ---------- floating add button ---------- */
{
  const wrap = $('#itinFab');
  const btn = $('#itinFabBtn');
  const menu = $('#itinFabMenu');

  menu.replaceChildren(...KINDS.map((kind, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fab-item';
    b.innerHTML = `<span class="fab-label">${kind}</span><span class="fab-icon">${ICON[kind]}</span>`;
    // Stagger so the menu unfurls instead of appearing all at once.
    b.style.transitionDelay = `${i * 22}ms`;
    b.onclick = () => {
      close();
      addBooking(kind, kind === 'Hotel' ? '15:00' : '09:00');
    };
    return b;
  }));

  const close = () => { wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); };
  const toggle = () => {
    const open = wrap.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  };

  btn.onclick = e => { e.stopPropagation(); toggle(); };
  addEventListener('click', e => { if (!wrap.contains(e.target)) close(); });
  addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}

$('#itinSearch').oninput = e => { itinQuery = e.target.value; renderItinerary(); };

$('#addActivity').onclick = () => openActivity(null);
$('#printBtn').onclick = () => window.print();
async function runPlanAction(button, working, action) {
  const ready = button.getAttribute('aria-label');
  button.disabled = true;
  button.classList.add('working');
  button.setAttribute('aria-label', working);
  try { await action(); }
  finally {
    button.setAttribute('aria-label', ready);
    button.classList.remove('working');
    button.disabled = false;
  }
}
$('#optimise').onclick = e => runPlanAction(e.currentTarget, 'Optimising…', optimize);
$('#recalc').onclick = e => runPlanAction(e.currentTarget, 'Refreshing…', recalc);

$('#addMember').onsubmit = e => {
  e.preventDefault();
  const name = $('#memberName').value.trim();
  if (!name) return;
  if (state.members.includes(name)) return toast(`${name} is already in the party.`);
  state.members.push(name);
  $('#memberName').value = '';
  save(); render();
};
$('#currency').onchange = e => { state.currency = e.target.value || 'HKD'; save(); render(); };
for (const button of document.querySelectorAll('[data-money-view]')) {
  button.onclick = () => {
    state.moneyView = button.dataset.moneyView;
    save(); renderMoney();
  };
}
$('#addExpense').onsubmit = e => {
  e.preventDefault();
  const desc = $('#exDesc').value.trim(), amount = +$('#exAmount').value;
  if (!desc || !amount) return;
  state.expenses.push({ desc, amount, payer: $('#exPayer').value, sharedBy: [...state.members] });
  $('#exDesc').value = ''; $('#exAmount').value = '';
  save(); renderMoney();
};

for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => showTab(b.dataset.tab);

applyMapLayout();
$('#env').hidden = !location.pathname.includes('/preview/');

// Installs the app shell so it opens instantly and works with no signal.
// file:// has no service workers, so this quietly does nothing there.
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(err =>
    console.warn("service worker not registered:", err.message)));
}

/**
 * The preview build opens on a worked-through trip instead of an empty one, so
 * a change can be tried against real-shaped data without typing a trip in
 * first. Legs are left out on purpose: fetching them live is the point.
 *
 * `?demo` reloads it over whatever is there, on any build. Production never
 * seeds itself.
 */
async function loadDemo(replacing) {
  // Seeding overwrites the trip that is already saved, so never do it silently.
  if (replacing && !await ask({
    title: 'Load the demo trip?',
    body: 'The trip saved in this browser is replaced by a sample Fukuoka trip. There is no undo.',
    confirm: 'Load demo', danger: true,
  })) return;
  try {
    const r = await fetch(new URL('./data/demo.json', import.meta.url));
    if (!r.ok) throw new Error(r.status);
    state = { ...blank(), ...await r.json() };
    save();
    render();
    showTab(state.tab);
  } catch { toast('The demo trip could not be loaded.'); }
}

const firstRun = !localStorage.getItem(STORE);
const seedDemo = location.search.includes('demo')
  || (firstRun && location.pathname.includes('/preview/'));
render();
showTab(state.tab);
if (seedDemo) loadDemo(!firstRun);
else if (firstRun) openWizard();
