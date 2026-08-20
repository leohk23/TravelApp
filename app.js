import { settleUp, optimizeOrder, scheduleDay, placePairs, isPlace, shiftDates, datesFrom, spreadCities, zonedDateTime, fareKey, estimateFare, fmtInstant, fmtTime, fmtDur, fmtStay, pad } from './logic.js';
import { search, searchCity, searchAirports, geocode, route, timeZoneAt, haversine, STAY_TAGS } from './providers.js';

const $ = s => document.querySelector(s);
const STORE = 'travelapp';

const blankDay = () => ({ date: '', city: '', timeZone: '', start: '09:00', items: [], legs: [] });
const blank = () => ({
  name: 'My trip', currency: 'HKD', members: ['Me'], tab: 'overview', itinView: 'all',
  itinerary: [],                  // flights, trains, hotels - the trip skeleton
  days: [blankDay()], dayIdx: 0,   // per-day plans
  mapView: 'split', split: 0.72,   // Day plan layout and plan/map size ratio
  fares: {},                       // journey key -> amount you paid last time
  expenses: [],
});

// Spread over blank() so trips saved by an older version pick up new keys.
let state = { ...blank(), ...JSON.parse(localStorage.getItem(STORE) || 'null') };
for (const d of state.days) {          // days carried `pois` before free-form items existed
  if (d.pois && !d.items) { d.items = d.pois; delete d.pois; }
  d.items ||= [];
  delete d.seeded;                     // replaced by linked hotel-origin items
}
// Move old defaults to the compact-map default; leave custom ratios alone.
if (state.split === 0.42 || state.split === 0.6) state.split = 0.72;
if (state.mapView === 'list') state.mapView = 'split';
const save = () => localStorage.setItem(STORE, JSON.stringify(state));
const day = () => state.days[state.dayIdx];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(res => { askResolve = () => res(dlg.returnValue === 'ok'); });
}

/** Modal single-field prompt. Resolves null if dismissed. */
function askText({ title, body = '', label, value = '', type = 'text', confirm = 'Save' }) {
  $('#askTitle').textContent = title;
  $('#askBody').textContent = body;
  $('#askBody').hidden = !body;
  $('#askInputWrap').hidden = false;
  $('#askLabel').firstChild.textContent = label;
  const input = $('#askInput');
  input.type = type;
  input.value = value;
  const ok = $('#askOk');
  ok.textContent = confirm;
  ok.className = 'primary';
  const dlg = $('#ask');
  dlg.returnValue = '';
  dlg.showModal();
  input.focus();
  input.select();
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

/** Departure clock in the destination, never the device's timezone. */
async function startDate(d) {
  return zonedDateTime(d.date, d.start, await dayTimeZone(d));
}

/* ---------- routing ---------- */
async function recalc() {
  const d = day();
  const pairs = placePairs(d.items);
  if (!pairs.length) { d.legs = []; save(); return render(); }
  setBusy(1);
  try {
    let t = await startDate(d);
    d.legs = [];
    for (const [from, to] of pairs) {
      // Everything between the two places still costs time, notes included.
      for (let k = from; k < to; k++) t = new Date(t.getTime() + (d.items[k].stayMin ?? 60) * 60000);
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
  const slots = d.items.map((it, i) => (isPlace(it) ? i : -1)).filter(i => i >= 0);
  if (slots.length < 4) return;
  const places = slots.map(i => d.items[i]);
  const M = places.map(a => places.map(b => haversine(a, b)));
  // Free-form items keep their positions; only the places shuffle between slots.
  optimizeOrder(M, true).forEach((src, k) => { d.items[slots[k]] = places[src]; });
  save();
  await recalc();
}

/* ---------- map (Leaflet + OpenStreetMap tiles) ---------- */
let map, layer;
function drawMap() {
  const d = day();
  if (typeof L === "undefined") return;   // CDN blocked; the rest of the app still works
  if (!map) {
    map = L.map('map').setView([22.302, 114.17], 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, transit <a href="https://transitous.org">Transitous</a>',
    }).addTo(map);
    map.attributionControl.setPosition('bottomleft');   // frees the corner for the button
  }
  layer?.remove();
  const places = d.items.filter(isPlace);
  if (!places.length) return;

  layer = L.layerGroup(places.map((p, i) => L.marker([p.lat, p.lng], {
    icon: L.divIcon({ className: 'pin', html: String(i + 1), iconSize: [24, 24] }),
    title: p.name,
  }).bindPopup(`<b>${esc(p.name)}</b><br>${esc(p.address || '')}`))).addTo(map);
  L.polyline(places.map(p => [p.lat, p.lng]), { weight: 3, opacity: 0.6 }).addTo(layer);
  map.fitBounds(places.map(p => [p.lat, p.lng]), { padding: [40, 40], maxZoom: 15 });
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
function loadFares() {
  if (fareTable === null) {
    fareTable = fetch(new URL("./data/fares.json", import.meta.url))
      .then(r => (r.ok ? r.json() : null))
      .then(t => { fareTable = t; render(); return t; })
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
    // Only airports picked from the list carry coordinates, and without those
    // there is nothing to route to.
    if (dateOf(b.start) === d.date && b.fromPt) {
      out.push({ at: b.start, role: 'depart', pt: b.fromPt, label: b.from, flightId: b.id });
    }
    if (dateOf(b.end) === d.date && b.toPt) {
      out.push({ at: b.end, role: 'arrive', pt: b.toPt, label: b.to, flightId: b.id });
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
  const lastArrival = flights.reduce((k, f, i) => (f.role === 'arrive' ? i : k), -1);
  flights.forEach((f, i) => {
    derived.push({
      name: f.label || (f.role === 'arrive' ? 'Arrival airport' : 'Departure airport'),
      address: f.pt.name || f.pt.address || '',
      lat: f.pt.lat, lng: f.pt.lng, stayMin: 0,
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
  const kept = own.filter(it => ![...head, ...tail].some(x => sameSpot(x, it)));
  const next = [...head, ...kept, ...tail];

  const key = list => JSON.stringify(list.map(it =>
    [it.name, it.address, it.lat, it.lng, it.stayMin, it.hotelId, it.flightId, it.role]));
  if (key(next) === key(d.items)) return false;
  d.items = next;
  save();
  return true;
}

const hotelItem = (hotel, point) => ({
  name: hotel.ref || hotel.from, address: hotel.from || point.address,
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
function attachSearch(input, { onPick, bias, tags, clearOnPick = false, find }) {
  const list = document.createElement('ul');
  list.className = 'ac-list';
  list.hidden = true;
  list._owner = input;

  let timer, abort, hits = [], cursor = -1;

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
    removeEventListener('scroll', hide, true);
  };
  const draw = () => {
    list.replaceChildren(...hits.map((h, i) => {
      const li = document.createElement('li');
      li.className = i === cursor ? 'on' : '';
      li.innerHTML = `<b>${esc(h.name)}</b>${h.kind ? `<span class="ac-kind">${esc(h.kind)}</span>` : ''}${h.label ? `<small>${esc(h.label)}</small>` : ''}`;
      li.onmousedown = e => { e.preventDefault(); pick(i); };
      return li;
    }));
    // Position and re-parent before revealing, so it never paints at a stale spot.
    if (hits.length) { place(); addEventListener('scroll', hide, true); }
    list.hidden = !hits.length;
  };
  const pick = i => {
    const h = hits[i];
    if (!h) return;
    onPick(h);
    if (clearOnPick) input.value = '';
    hits = []; hide();
  };

  input.oninput = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { hits = []; return hide(); }
    timer = setTimeout(async () => {
      abort?.abort();
      abort = new AbortController();
      try {
        hits = find
          ? await find(q, abort.signal)
          : await search(q, { near: await bias?.(), tags }, abort.signal);
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
function renderDays() {
  const tabs = $('#dayTabs');
  tabs.innerHTML = '';
  const showCity = multiCity();
  state.days.forEach((d, i) => {
    const b = document.createElement('button');
    b.className = 'tab' + (i === state.dayIdx ? ' on' : '');
    b.innerHTML = `<span class="t-n">Day ${i + 1}</span>`
      + (d.date ? `<span class="t-d">${esc(fmtDayLabel(d.date))}</span>` : '')
      + (showCity && d.city ? `<span class="t-c">${esc(d.city)}</span>` : '');
    b.onclick = () => {
      state.dayIdx = i; save(); render();
      if (state.tab === 'local') prepareDayPlan(d);
    };
    tabs.append(b);
  });
  const add = document.createElement('button');
  add.className = 'tab';
  add.textContent = '+';
  add.title = 'Add a day';
  add.onclick = () => addDayAfter(state.days.length - 1);
  tabs.append(add);

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
const isStay = k => k === 'Hotel';
const dateOf = dt => (dt || '').slice(0, 10);

// A stay covers every night from check-in through check-out morning.
const staysOn = (b, d) => isStay(b.kind) && b.start && dateOf(b.start) <= d && d <= dateOf(b.end || b.start);
const movesOn = (b, d) => !isStay(b.kind)
  && (dateOf(b.start) === d || (b.kind === 'Flight' && dateOf(b.end) === d));

function movementPhase(b, date) {
  if (b.kind !== 'Flight') return b.kind;
  const departs = dateOf(b.start) === date;
  const arrives = dateOf(b.end) === date;
  if (departs && arrives) return 'Flight';
  return departs ? 'Departing flight' : 'Arriving flight';
}

const movementTime = (b, date) => timeOf(dateOf(b.start) === date ? b.start : b.end);

const newBooking = (kind, start = '') =>
  ({ id: crypto.randomUUID(), kind, ref: '', from: '', to: '', start, end: '', conf: '', cost: 0, notes: '' });

/** Nights for a stay; nothing for transport, whose local times cross time zones. */
const timeOf = dt => (dt && dt.length > 10 ? dt.slice(11, 16) : '');

function spanLabel(b) {
  if (!b.start || !b.end || !isStay(b.kind)) return '';
  // Compare dates only: a stay may carry no time at all.
  const nights = Math.round((parseISO(dateOf(b.end)) - parseISO(dateOf(b.start))) / dayMs);
  return nights > 0 ? `${nights} night${nights > 1 ? 's' : ''}` : '';
}

/** What the range button on a stay card reads. */
function stayLabel(b) {
  if (!b.start) return 'Set check-in and check-out';
  const t1 = timeOf(b.start), t2 = timeOf(b.end);
  const from = fmtDayLabel(b.start) + (t1 ? ` ${t1}` : '');
  const to = b.end ? fmtDayLabel(b.end) + (t2 ? ` ${t2}` : '') : '?';
  return `${from}  →  ${to}`;
}

function journeyLabel(b) {
  if (!b.start) return 'Set depart and arrive';
  const from = fmtDayLabel(b.start) + (timeOf(b.start) ? ` ${timeOf(b.start)}` : '');
  const to = b.end ? fmtDayLabel(b.end) + (timeOf(b.end) ? ` ${timeOf(b.end)}` : '') : '?';
  return `${from}  →  ${to}`;
}

function bookingCard(b, { showDate = false } = {}) {
  const stay = isStay(b.kind);
  const cfg = cfgFor(b.kind);
  const billed = state.expenses.some(e => e.src === b.id);
  const orphan = !onSomeDay(b);
  const li = document.createElement('li');
  li.className = 'booking' + (stay ? ' is-stay' : '');
  li.dataset.bid = b.id;
  li.innerHTML = `
    <div class="brow head">
      <select class="f-kind" aria-label="Type">${KINDS.map(k =>
        `<option value="${k}"${k === b.kind ? ' selected' : ''}>${ICON[k]} ${k}</option>`).join('')}</select>
      ${stay
        ? `<span class="ac grow"><input class="f-ref" value="${esc(b.ref || '')}" placeholder="Search a hotel…" autocomplete="off"></span>`
        : `<input class="f-ref grow" value="${esc(b.ref || '')}" placeholder="${esc(cfg.ref)}">`}
      ${showDate && b.start ? `<span class="when-chip">${esc(fmtDayLabel(b.start))}</span>` : ''}
      ${orphan ? '<span class="chip warn" title="This booking is not on any day of the trip">off-trip</span>' : ''}
      <span class="spacer"></span>
      <button class="bill${billed ? ' on' : ''}"${+b.cost > 0 ? '' : ' disabled'}
        title="${billed ? 'Remove from expenses' : 'Add this cost to expenses'}">${billed ? '✓ expensed' : '+ expense'}</button>
      <button class="x" title="Remove">✕</button>
    </div>

    <div class="brow${b.kind === 'Flight' ? ' flight-route' : ''}">
      ${b.kind === 'Flight'
        ? `<span class="ac grow"><input class="f-from" value="${esc(b.from || '')}" placeholder="Search departure airport…" autocomplete="off"></span>`
        : `<input class="f-from grow" value="${esc(b.from || '')}" placeholder="${esc(cfg.from)}">`}
      ${stay ? '' : `<span class="arrow">→</span>${b.kind === 'Flight'
        ? `<span class="ac grow"><input class="f-to" value="${esc(b.to || '')}" placeholder="Search arrival airport…" autocomplete="off"></span>`
        : `<input class="f-to grow" value="${esc(b.to || '')}" placeholder="${esc(cfg.to)}">`}`}
      ${stay ? '<button class="mapit" title="Open in OpenStreetMap">map</button>' : ''}
    </div>

    <div class="brow">
      <button class="daterange grow" type="button">${esc(stay ? stayLabel(b) : journeyLabel(b))}</button>
      <small class="span">${esc(spanLabel(b))}</small>
    </div>

    <div class="brow">
      <label>${esc(cfg.conf)}<input class="f-conf" value="${esc(b.conf || '')}" placeholder="optional"></label>
      <label>${esc(state.currency)}<input type="number" class="f-cost" step="0.01" min="0" size="8" value="${b.cost || ''}"></label>
      <input class="f-notes grow" value="${esc(b.notes || '')}" placeholder="${esc(cfg.notes)}">
    </div>`;

  // Plain text fields only save; anything affecting grouping or derived text redraws.
  const bind = (sel, key, redraw) => {
    const el = li.querySelector(sel);
    if (el) el.onchange = e => {
      b[key] = key === 'cost' ? (+e.target.value || 0) : e.target.value;
      save();
      if (redraw) render();
    };
  };
  bind('.f-kind', 'kind', true);
  bind('.f-ref', 'ref');
  if (b.kind !== 'Flight') {
    bind('.f-from', 'from');
    bind('.f-to', 'to');
  }

  li.querySelector('.daterange')?.addEventListener('click', async () => {
    const res = await pickRange({
      title: b.ref || (stay ? 'Hotel dates' : `${b.kind} times`),
      range: b.start ? [dateOf(b.start), dateOf(b.end || b.start)] : null,
      t1: timeOf(b.start),
      t2: timeOf(b.end),
      mode: stay ? 'stay' : 'journey',
    });
    if (!res) return;
    // Times are optional: without one the value stays date-only, which every
    // day-matching helper already handles because they all slice to 10 chars.
    b.start = res.start ? res.start + (res.t1 ? `T${res.t1}` : '') : '';
    b.end = res.end ? res.end + (res.t2 ? `T${res.t2}` : '') : '';
    save(); render();
  });
  bind('.f-conf', 'conf');
  bind('.f-cost', 'cost', true);
  bind('.f-notes', 'notes');

  li.querySelector('.x').onclick = async () => {
    const ok = await ask({
      title: `Remove ${b.ref || b.kind}?`,
      body: billed ? 'Its expense entry is removed too.' : '',
      confirm: 'Remove', danger: true,
    });
    if (!ok) return;
    state.itinerary = state.itinerary.filter(x => x.id !== b.id);
    state.expenses = state.expenses.filter(e => e.src !== b.id);
    save(); render();
  };

  li.querySelector('.bill').onclick = () => {
    if (billed) state.expenses = state.expenses.filter(e => e.src !== b.id);
    else state.expenses.push({
      desc: [b.kind, b.ref, b.from && b.to ? `${b.from} → ${b.to}` : b.from].filter(Boolean).join(', '),
      amount: +b.cost, payer: state.members[0], sharedBy: [...state.members], src: b.id,
    });
    save(); render();
  };

  if (stay) attachSearch(li.querySelector('.f-ref'), {
    bias: biasPoint,
    tags: STAY_TAGS,
    onPick: h => {
      // Fills the name, address and coordinates at once, so the map and Day-plan
      // origin never have to geocode a selected hotel again.
      b.ref = h.name; b.from = h.label; b.lat = h.lat; b.lng = h.lng;
      save(); render();
    },
  });
  if (stay) {
    const address = li.querySelector('.f-from');
    address.onchange = e => {
      if (e.target.value !== b.from) { delete b.lat; delete b.lng; }
      b.from = e.target.value;
      save();
    };
  }

  if (b.kind === 'Flight') {
    const airportPicker = (sel, key) => {
      const input = li.querySelector(sel);
      const pointKey = `${key}Pt`;
      input.onchange = e => {
        if (e.target.value !== b[key]) delete b[pointKey];
        b[key] = e.target.value;
        save();
      };
      attachSearch(input, {
        find: searchAirports,
        onPick: h => {
          const shown = h.code || h.name;      // "NRT" beats "Narita International Airport"
          input.value = shown;
          b[key] = shown;
          b[pointKey] = { lat: h.lat, lng: h.lng, name: h.name, address: h.label };
          save();
        },
      });
    };
    airportPicker('.f-from', 'from');
    airportPicker('.f-to', 'to');
  }

  li.querySelector('.mapit')?.addEventListener('click', () => {
    const url = b.lat != null
      ? `https://www.openstreetmap.org/?mlat=${b.lat}&mlon=${b.lng}#map=17/${b.lat}/${b.lng}`
      : `https://www.openstreetmap.org/search?query=${encodeURIComponent(b.from || b.ref)}`;
    if (b.lat != null || b.from || b.ref) window.open(url, '_blank', 'noopener');
  });

  return li;
}

/** True when a booking lands on at least one day of the trip. */
function onSomeDay(b) {
  return state.days.some(x => x.date && (isStay(b.kind) ? staysOn(b, x.date) : movesOn(b, x.date)));
}

const fmtDayLabel = dt => (dt
  ? new Date(`${dt.slice(0, 10)}T00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  : '');

const haystack = b => [b.kind, b.ref, b.from, b.to, b.conf, b.notes]
  .filter(Boolean).join(' ').toLowerCase();

let itinQuery = '';

function renderItinerary() {
  const view = state.itinView || 'all';
  const d = day().date;
  const q = itinQuery.trim().toLowerCase();

  for (const btn of document.querySelectorAll('[data-iv]')) {
    btn.classList.toggle('on', btn.dataset.iv === view);
  }

  state.itinerary.sort((a2, b2) => (a2.start || '~').localeCompare(b2.start || '~'));

  let shown = state.itinerary;
  if (view === 'stays') shown = shown.filter(b => isStay(b.kind));
  else if (view === 'transport') shown = shown.filter(b => !isStay(b.kind));
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
    list.replaceChildren(...shown.map(b => bookingCard(b, { showDate: true })));
    if (!shown.length) {
      list.append(emptyRow(q
        ? `Nothing matches "${itinQuery}".`
        : 'No bookings here yet. Add a hotel or a flight above.'));
    }
  }

  const total = shown.reduce((s, b) => s + (+b.cost || 0), 0);
  const all = state.itinerary.length;
  $('#bookTotal').innerHTML = all
    ? `<span class="count">${shown.length}${shown.length === all ? '' : ` of ${all}`} booking${all === 1 ? '' : 's'}</span>`
      + `<span class="money">${esc(state.currency)} ${total.toFixed(2)}</span>`
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

function renderPlan() {
  const d = day();
  $('#dayStart').value = d.start;
  renderDayBookings(d);
  const list = $('#stops');
  list.innerHTML = '';

  // Places are numbered to match the map pins; free-form items are not.
  const ord = new Map();
  d.items.forEach((it, i) => { if (isPlace(it)) ord.set(i, ord.size + 1); });

  for (const row of scheduleDay(d.items, d.legs, d.start)) {
    list.append(row.type === 'item' ? itemRow(d, row, ord) : legRow(d, row));
  }
  if (!d.items.length) {
    list.innerHTML = '<li class="empty">Use + to add a place or activity.</li>';
  }
  drawMap();
}

function renderDayBookings(d) {
  const host = $('#dayBookings');
  const flights = d.date
    ? state.itinerary.filter(b => b.kind === 'Flight' && movesOn(b, d.date))
    : [];
  host.replaceChildren(...flights.map(b => {
    const departs = dateOf(b.start) === d.date;
    const arrives = dateOf(b.end) === d.date;
    const time = departs && arrives
      ? [timeOf(b.start), timeOf(b.end)].filter(Boolean).join(' → ')
      : timeOf(departs ? b.start : b.end);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'day-booking';
    card.innerHTML = `<span class="day-booking-kind">${movementPhase(b, d.date)}</span>`
      + `<b>${esc(b.ref || 'Flight')}</b>`
      + (time ? `<time>${esc(time)}</time>` : '')
      + (b.from || b.to ? `<span class="day-booking-route">${esc(b.from || '?')} → ${esc(b.to || '?')}</span>` : '');
    card.onclick = () => {
      state.itinView = 'day';
      showTab('itinerary');
      setTimeout(() => document.querySelector(`[data-bid="${b.id}"]`)?.scrollIntoView({ block: 'center' }), 0);
    };
    return card;
  }));
  host.hidden = !flights.length;
}

function itemRow(d, row, ord) {
  const it = d.items[row.i];
  const li = document.createElement('li');
  li.className = 'stop' + (row.place ? '' : ' note') + (it.flightId ? ' via-airport' : '') + (it.hotelId ? ' via-hotel' : '');
  const sub = it.notes || (row.place ? it.address : '') || '';
  li.innerHTML = `
    <div class="grip" title="Drag to reorder">⠿</div>
    <div class="marker">${it.flightId ? (it.role === 'arrive' ? '🛬' : '🛫') : it.hotelId ? '🏨' : row.place ? ord.get(row.i) : '•'}</div>
    <div class="when">${fmtTime(row.arrive)}<small>${fmtTime(row.depart)}</small></div>
    <button class="what-btn" type="button">
      <b>${esc(it.name || (row.place ? 'Unnamed stop' : 'What are you doing?'))}</b>
      ${sub ? `<small>${it.notes ? '✎ ' : ''}${esc(sub)}</small>` : ''}
    </button>
    ${fmtStay(it.stayMin ?? 60) ? `<span class="dur-chip">${fmtStay(it.stayMin ?? 60)}</span>` : ''}`;

  li.querySelector('.what-btn').onclick = () => openActivity(row.i);
  // draggable only from the grip, so a tap on the row still opens the editor
  li.querySelector('.grip').onmousedown = () => { li.draggable = true; };
  li.ondragstart = e => { dragFrom = row.i; e.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging'); };
  li.ondragend = () => { li.draggable = false; li.classList.remove('dragging'); };
  li.ondragover = e => { e.preventDefault(); li.classList.add('over'); };
  li.ondragleave = () => li.classList.remove('over');
  li.ondrop = e => {
    e.preventDefault(); li.classList.remove('over');
    if (dragFrom === null || dragFrom === row.i) return;
    d.items.splice(row.i, 0, ...d.items.splice(dragFrom, 1));
    dragFrom = null; save(); recalc();
  };
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
  $('#jSub').textContent = [
    fmtDur(leg.seconds),
    transfers ? `${transfers} change${transfers > 1 ? 's' : ''}` : 'no changes',
  ].join(', ');

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
      : `${esc(s.line || prettyMode(s.mode))}${s.headsign ? ` toward ${esc(s.headsign)}` : ''}`;
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

function openActivity(i) {
  actNew = i == null;
  actIdx = i;
  const it = actNew ? { name: '', stayMin: 60 } : day().items[i];
  if (!it) return;
  actPicked = isPlace(it) ? { name: it.name, address: it.address, lat: it.lat, lng: it.lng } : null;
  $('#actTitle').textContent = actNew ? 'Add to this day' : (isPlace(it) ? 'Stop' : 'Activity');
  $('#actAddr').textContent = it.address || '';
  $('#actAddr').hidden = !it.address;
  $('#actName').value = it.name || '';
  $('#actName').removeAttribute('aria-invalid');
  $('#actError').textContent = '';
  $('#actError').hidden = true;
  $('#actMin').value = it.stayMin ?? 60;
  $('#actNotes').value = it.notes || '';
  $('#actDelete').hidden = actNew;
  $('#actDlg').returnValue = '';
  $('#actDlg').showModal();
  $('#actName').focus();
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
    $('#actAddr').textContent = h.label;
    $('#actAddr').hidden = !h.label;
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
      guess = estimateFare(table, d.items[row.from], d.items[row.to],
        (row.leg.lines || []).map(l => l.mode));
    } else loadFares();
  }

  const shown = known != null ? `${esc(state.currency)} ${known}`
    : guess ? `~ ${esc(guess.currency)} ${guess.amount}`
    : '+ fare';

  li.innerHTML = `
    <span class="dur">${row.leg ? fmtDur(row.leg.seconds) : 'no route'}</span>
    ${row.leg
      ? `<button class="via" type="button" title="Show every step">${esc(row.leg.summary)}</button>`
      : '<span class="via">no public transport found - walk it, or check the day has a date set</span>'}
    ${ridden && url ? `<a class="fare-link" href="${esc(url)}" target="_blank" rel="noopener"
       title="Operator fare information">fares</a>` : ''}
    ${ridden ? `<button class="fare${known != null ? ' known' : guess ? ' guess' : ''}"
      title="${known != null ? 'Remembered from the last time you rode this'
        : guess ? `Rough ${esc(guess.city)} fare, not from the operator. Tap to confirm or correct.`
        : 'Add what this leg cost'}">${shown}</button>` : ''}`;

  li.querySelector('button.via')?.addEventListener('click',
    () => openJourney(d, row));

  if (li.querySelector('.fare')) li.querySelector('.fare').onclick = async () => {
    const entered = await askText({
      title: 'What did this leg cost?',
      body: guess
        ? `${d.items[row.from].name} → ${d.items[row.to].name}. The figure below is a rough ${guess.city} fare, not from the operator.`
        : `${d.items[row.from].name} → ${d.items[row.to].name}`,
      label: state.currency,
      value: known != null ? String(known) : guess ? String(guess.amount) : '',
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
function renderMoney() {
  $('#members').value = state.members.join(', ');
  $('#currency').value = state.currency;
  $('#exPayer').innerHTML = state.members.map(m => `<option>${esc(m)}</option>`).join('');

  const list = $('#expenses');
  list.innerHTML = '';
  state.expenses.forEach((e, i) => {
    const li = document.createElement('li');
    li.className = 'expense';
    li.innerHTML = `
      <div class="what"><b>${esc(e.desc)}</b><small>paid by ${esc(e.payer)}</small>${e.src ? '<span class="chip src">from Itinerary</span>' : ''}</div>
      <div class="amt">${esc(state.currency)} ${(+e.amount).toFixed(2)}</div>
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
    <p class="total">Total ${esc(state.currency)} ${total.toFixed(2)}</p>
    <ul class="bal">${state.members.map(m =>
      `<li><span>${esc(m)}</span><b class="${balances[m] < 0 ? 'neg' : 'pos'}">${balances[m] > 0 ? '+' : ''}${balances[m].toFixed(2)}</b></li>`).join('')}</ul>
    <ul class="tx">${transfers.length
      ? transfers.map(t => `<li><b>${esc(t.from)}</b> pays <b>${esc(t.to)}</b> ${esc(state.currency)} ${t.amount.toFixed(2)}</li>`).join('')
      : '<li class="empty">All square.</li>'}</ul>`;
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
  $('#ovMeta').innerHTML = facts
    .map(([k, v]) => `<span class="fact${k === 'When' ? ' when' : ''}"><span class="k">${k}</span>${esc(v)}</span>`)
    .join('');

  const showCity = multiCity();
  $('#ovDays').replaceChildren(...state.days.map((d, i) => {
    const stays = state.itinerary.filter(b => isStay(b.kind) && d.date && staysOn(b, d.date));
    const moves = state.itinerary.filter(b => !isStay(b.kind) && d.date && movesOn(b, d.date));
    const rows = scheduleDay(d.items, d.legs, d.start);
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
        `${esc(b.ref || 'Hotel')}${b.conf ? ` <code>${esc(b.conf)}</code>` : ''}${b.from ? ` — ${esc(b.from)}` : ''}`
      ).join('<br>')}</span></div>` : ''}

      ${moves.length ? `<div class="ovline"><span class="k">Moving</span><span>${moves.map(b =>
        `${esc(movementPhase(b, d.date))}: ${ICON[b.kind] || ''} ${esc(b.ref || b.kind)}${b.from || b.to ? ` ${esc(b.from)} → ${esc(b.to)}` : ''}${
          movementTime(b, d.date) ? ` at ${esc(movementTime(b, d.date))}` : ''}${b.conf ? ` <code>${esc(b.conf)}</code>` : ''}`
      ).join('<br>')}</span></div>` : ''}

      ${d.items.length ? `<ol class="ovstops">${rows.filter(r => r.type === 'item').map(r => `
        <li${r.place ? '' : ' class="note"'}><span class="t">${fmtTime(r.arrive)}</span>${esc(d.items[r.i].name || '—')}</li>`
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
  $('#wCur').value = state.currency;
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
  state.currency = $('#wCur').value.trim() || 'HKD';
  state.dayIdx = 0;
  save();
  $('#wizard').close();
  render();
  showTab('itinerary');
}

$('#setupBtn').onclick = openWizard;
$('#aboutBtn').onclick = () => $('#aboutDlg').showModal();
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
function pickRange({ title, range, t1 = '', t2 = '', mode = 'stay' }) {
  $('#rangeTitle').textContent = title;
  rangeMode = mode;
  rangePending = range;
  $('#rangeLabel1').textContent = mode === 'journey' ? 'Depart' : 'Check in';
  $('#rangeLabel2').textContent = mode === 'journey' ? 'Arrive' : 'Check out';
  $('#rangeCal .cal-hint').textContent = mode === 'journey'
    ? 'Choose the departure and arrival dates.'
    : 'Choose the check-in and check-out dates.';
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

function renderDayTable() {
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
$('#dayStart').onchange = e => { day().start = e.target.value; save(); recalc(); };
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

for (const btn of document.querySelectorAll('[data-iv]')) {
  btn.onclick = () => { state.itinView = btn.dataset.iv; save(); render(); syncChrome(); };
}
$('#itinSearch').oninput = e => { itinQuery = e.target.value; renderItinerary(); };

$('#addActivity').onclick = () => openActivity(null);
$('#printBtn').onclick = () => window.print();
$('#optimise').onclick = optimize;
$('#recalc').onclick = recalc;

$('#members').onchange = e => {
  state.members = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
  if (!state.members.length) state.members = ['Me'];
  for (const ex of state.expenses) ex.sharedBy = ex.sharedBy.filter(m => state.members.includes(m));
  save(); renderMoney();
};
$('#currency').onchange = e => { state.currency = e.target.value.trim() || 'HKD'; save(); render(); };
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

const firstRun = !localStorage.getItem(STORE);
render();
showTab(state.tab);
if (firstRun) openWizard();
