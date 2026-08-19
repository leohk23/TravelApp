import { settleUp, optimizeOrder, scheduleDay, fmtTime, fmtDur, pad } from './logic.js';

const $ = s => document.querySelector(s);
const STORE = 'travelapp';

const blankDay = () => ({ date: '', start: '09:00', pois: [], legs: [] });
const blank = () => ({
  name: 'My trip', currency: 'HKD', members: ['Me'],
  expenses: [], dayIdx: 0, days: [blankDay()],
});

let state = JSON.parse(localStorage.getItem(STORE) || 'null') || blank();
const save = () => localStorage.setItem(STORE, JSON.stringify(state));
const day = () => state.days[state.dayIdx];
const ll = p => ({ lat: p.lat, lng: p.lng });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- Google Maps ---------- */
let mapsPromise;
function maps() {
  if (mapsPromise) return mapsPromise;
  const key = localStorage.getItem('gmapsKey');
  if (!key) { askKey(); return Promise.reject(new Error('Add your Google Maps API key first.')); }
  mapsPromise = new Promise((res, rej) => {
    window.__gmapsReady = res;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&callback=__gmapsReady`;
    s.onerror = () => rej(new Error('Maps failed to load - check the key.'));
    document.head.appendChild(s);
  });
  return mapsPromise;
}

function askKey() {
  const k = prompt('Google Maps API key (enable Maps JavaScript, Geocoding, Directions and Distance Matrix APIs):', localStorage.getItem('gmapsKey') || '');
  if (k) { localStorage.setItem('gmapsKey', k.trim()); location.reload(); }
}

/** Departure clock for a day. Transit routing wants a future time, so roll forward. */
function startDate(d) {
  const [h, mi] = d.start.split(':').map(Number);
  const t = d.date ? new Date(`${d.date}T${pad(h)}:${pad(mi)}:00`) : new Date();
  if (!d.date) t.setHours(h, mi, 0, 0);
  if (t < Date.now()) t.setDate(t.getDate() + 1);
  return t;
}

const stepLabel = s => s.travel_mode === 'TRANSIT'
  ? `${s.transit.line.short_name || s.transit.line.name} (${s.transit.line.vehicle.name}) · ${s.transit.departure_stop.name} → ${s.transit.arrival_stop.name}`
  : `walk ${s.distance.text}`;

async function geocode(q) {
  await maps();
  const { results } = await new google.maps.Geocoder().geocode({ address: q });
  if (!results.length) throw new Error(`Not found: ${q}`);
  const g = results[0];
  return {
    name: q, address: g.formatted_address, stayMin: 60,
    lat: g.geometry.location.lat(), lng: g.geometry.location.lng(),
  };
}

const addPoi = p => { day().pois.push(p); save(); recalc(); };

/** Search-as-you-type POI picker. Falls back to plain geocoding if Places is off. */
async function mountSearch() {
  if (!localStorage.getItem('gmapsKey')) return;
  const box = $('#poiSearch');
  try {
    await maps();
    const { PlaceAutocompleteElement } = await google.maps.importLibrary('places');
    const el = new PlaceAutocompleteElement();
    el.placeholder = 'Search a place…';
    box.replaceChildren(el);
    // ponytail: both event names - Google renamed this once already.
    for (const ev of ['gmp-select', 'gmp-placeselect']) el.addEventListener(ev, async d => {
      const place = (d.placePrediction || d.place).toPlace?.() ?? d.place;
      await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
      addPoi({
        name: place.displayName, address: place.formattedAddress, stayMin: 60,
        lat: place.location.lat(), lng: place.location.lng(),
      });
      el.value = '';
    });
  } catch {
    const el = $('#poiSearchFallback');
    el.hidden = false;
    el.onkeydown = async e => {
      if (e.key !== 'Enter' || !el.value.trim()) return;
      setBusy(1);
      try { addPoi(await geocode(el.value.trim())); el.value = ''; } catch (err) { alert(err.message); }
      setBusy(-1);
    };
  }
}

let busy = 0;
const setBusy = n => { busy += n; $('#busy').hidden = busy <= 0; };

async function recalc() {
  const d = day();
  if (d.pois.length < 2) { d.legs = []; save(); return render(); }
  setBusy(1);
  try {
    await maps();
    const svc = new google.maps.DirectionsService();
    let t = startDate(d);
    d.legs = [];
    for (let i = 0; i < d.pois.length - 1; i++) {
      t = new Date(t.getTime() + (d.pois[i].stayMin ?? 60) * 60000);
      try {
        const res = await svc.route({
          origin: ll(d.pois[i]), destination: ll(d.pois[i + 1]),
          travelMode: 'TRANSIT', transitOptions: { departureTime: t },
        });
        const route = res.routes[0], leg = route.legs[0];
        d.legs[i] = {
          seconds: leg.duration.value,
          summary: leg.steps.map(stepLabel).join('  →  '),
          fare: route.fare ? { value: route.fare.value, currency: route.fare.currency } : null,
        };
        t = new Date(t.getTime() + leg.duration.value * 1000);
      } catch {
        d.legs[i] = null; // no transit route - shown as a gap in the timeline
      }
    }
    save(); render();
  } catch (e) {
    alert(e.message);
  } finally { setBusy(-1); }
}

async function optimize() {
  const d = day();
  if (d.pois.length < 4) return;
  // ponytail: Distance Matrix caps a client request at 100 elements, so n <= 10 stops.
  if (d.pois.length > 10) return alert('Optimise handles up to 10 stops a day (API matrix limit). Split the day.');
  setBusy(1);
  try {
    await maps();
    const pts = d.pois.map(ll);
    const { rows } = await new google.maps.DistanceMatrixService().getDistanceMatrix({
      origins: pts, destinations: pts, travelMode: 'TRANSIT',
      transitOptions: { departureTime: startDate(d) },
    });
    const M = rows.map(r => r.elements.map(e => e.status === 'OK' ? e.duration.value : 1e6));
    d.pois = optimizeOrder(M, true).map(i => d.pois[i]);
    save();
  } catch (e) {
    alert(e.message); setBusy(-1); return;
  }
  setBusy(-1);
  recalc();
}

/* ---------- map ---------- */
let map, overlays = [];
async function drawMap() {
  const d = day();
  if (!d.pois.length || !localStorage.getItem('gmapsKey')) return;
  await maps();
  map ||= new google.maps.Map($('#map'), {
    center: ll(d.pois[0]), zoom: 13, mapTypeControl: false, streetViewControl: false,
  });
  overlays.forEach(o => o.setMap(null));
  // ponytail: legacy Marker + straight polyline. Real route shapes want one
  // DirectionsRenderer per leg - add that if the straight lines ever mislead.
  overlays = d.pois.map((p, i) => new google.maps.Marker({
    map, position: ll(p), label: String(i + 1), title: p.name,
  }));
  overlays.push(new google.maps.Polyline({ map, path: d.pois.map(ll), strokeOpacity: 0.6, strokeWeight: 3 }));
  const b = new google.maps.LatLngBounds();
  d.pois.forEach(p => b.extend(ll(p)));
  map.fitBounds(b, 60);
}

/* ---------- rendering ---------- */
let dragFrom = null;

function renderDays() {
  const tabs = $('#dayTabs');
  tabs.innerHTML = '';
  state.days.forEach((d, i) => {
    const b = document.createElement('button');
    b.className = 'tab' + (i === state.dayIdx ? ' on' : '');
    b.textContent = `Day ${i + 1}${d.date ? ` · ${d.date.slice(5)}` : ''}`;
    b.onclick = () => { state.dayIdx = i; save(); render(); };
    tabs.append(b);
  });
  const add = document.createElement('button');
  add.className = 'tab';
  add.textContent = '+';
  add.title = 'Add a day';
  add.onclick = () => { state.days.push(blankDay()); state.dayIdx = state.days.length - 1; save(); render(); };
  tabs.append(add);
}

function renderPlan() {
  const d = day();
  $('#dayDate').value = d.date;
  $('#dayStart').value = d.start;
  const list = $('#stops');
  list.innerHTML = '';

  for (const row of scheduleDay(d.pois, d.legs, d.start)) {
    if (row.type === 'poi') {
      const p = d.pois[row.i];
      const li = document.createElement('li');
      li.className = 'stop';
      li.innerHTML = `
        <div class="grip" title="Drag to reorder">⠿</div>
        <div class="when">${fmtTime(row.arrive)}<small>${fmtTime(row.depart)}</small></div>
        <div class="what">
          <input class="rename" value="${esc(p.name)}" aria-label="Stop name">
          <small>${esc(p.address || '')}</small>
        </div>
        <label class="stay"><input class="stay-in" type="number" min="0" step="15" value="${p.stayMin ?? 60}">min</label>
        <button class="x" title="Remove">✕</button>`;
      li.querySelector('.rename').onchange = e => { p.name = e.target.value.trim() || p.name; save(); render(); };
      li.querySelector('.stay-in').onchange = e => { p.stayMin = +e.target.value; save(); recalc(); };
      li.querySelector('.x').onclick = () => { d.pois.splice(row.i, 1); save(); recalc(); };
      // draggable only from the grip, so the name field stays selectable
      li.querySelector('.grip').onmousedown = () => { li.draggable = true; };
      li.ondragstart = e => { dragFrom = row.i; e.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging'); };
      li.ondragend = () => { li.draggable = false; li.classList.remove('dragging'); };
      li.ondragover = e => { e.preventDefault(); li.classList.add('over'); };
      li.ondragleave = () => li.classList.remove('over');
      li.ondrop = e => {
        e.preventDefault(); li.classList.remove('over');
        if (dragFrom === null || dragFrom === row.i) return;
        d.pois.splice(row.i, 0, ...d.pois.splice(dragFrom, 1));
        dragFrom = null; save(); recalc();
      };
      list.append(li);
    } else {
      const li = document.createElement('li');
      li.className = 'leg' + (row.leg ? '' : ' bad');
      const fare = row.leg && row.leg.fare;
      li.innerHTML = `
        <span class="dur">${row.leg ? fmtDur(row.leg.seconds) : 'no route'}</span>
        <span class="via">${esc(row.leg ? row.leg.summary : 'no transit found - walk it, or hit Recalculate')}</span>
        ${fare ? `<button class="fare" title="Add to expenses">${esc(fare.currency)} ${fare.value} +</button>` : ''}`;
      if (fare) li.querySelector('.fare').onclick = () => {
        state.expenses.push({
          desc: `Transit: ${d.pois[row.i].name} → ${d.pois[row.i + 1].name}`,
          amount: fare.value, payer: state.members[0], sharedBy: [...state.members],
        });
        save(); renderMoney();
      };
      list.append(li);
    }
  }
  if (!d.pois.length) list.innerHTML = '<li class="empty">Add points of interest below, then hit Optimise.</li>';
  drawMap();
}

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
      <div class="what"><b>${esc(e.desc)}</b><small>paid by ${esc(e.payer)}</small></div>
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
    li.querySelector('.x').onclick = () => { state.expenses.splice(i, 1); save(); renderMoney(); };
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

function render() {
  $('#tripName').value = state.name;
  renderDays(); renderPlan(); renderMoney();
}

/* ---------- wiring ---------- */
$('#tripName').oninput = e => { state.name = e.target.value; save(); };
$('#dayDate').onchange = e => { day().date = e.target.value; save(); recalc(); };
$('#dayStart').onchange = e => { day().start = e.target.value; save(); recalc(); };
$('#delDay').onclick = () => {
  if (state.days.length < 2 || !confirm(`Delete day ${state.dayIdx + 1}?`)) return;
  state.days.splice(state.dayIdx, 1);
  state.dayIdx = Math.min(state.dayIdx, state.days.length - 1);
  save(); render();
};

$('#addPoi').onsubmit = async e => {
  e.preventDefault();
  const input = $('#poiInput'), q = input.value.trim();
  if (!q) return;
  setBusy(1);
  try {
    for (const part of q.split('\n').map(s => s.trim()).filter(Boolean)) {
      day().pois.push(await geocode(part));
    }
    input.value = ''; save(); setBusy(-1); recalc();
  } catch (err) { alert(err.message); setBusy(-1); }
};
$('#optimise').onclick = optimize;
$('#recalc').onclick = recalc;
$('#keyBtn').onclick = askKey;

$('#members').onchange = e => {
  state.members = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
  if (!state.members.length) state.members = ['Me'];
  for (const ex of state.expenses) ex.sharedBy = ex.sharedBy.filter(m => state.members.includes(m));
  save(); renderMoney();
};
$('#currency').onchange = e => { state.currency = e.target.value.trim() || 'HKD'; save(); renderMoney(); };
$('#addExpense').onsubmit = e => {
  e.preventDefault();
  const desc = $('#exDesc').value.trim(), amount = +$('#exAmount').value;
  if (!desc || !amount) return;
  state.expenses.push({ desc, amount, payer: $('#exPayer').value, sharedBy: [...state.members] });
  $('#exDesc').value = ''; $('#exAmount').value = '';
  save(); renderMoney();
};

for (const b of document.querySelectorAll('[data-tab]')) {
  b.onclick = () => {
    document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
    $('#plan').hidden = b.dataset.tab !== 'plan';
    $('#money').hidden = b.dataset.tab !== 'money';
  };
}

$('#exportBtn').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  a.download = `${state.name.replace(/\W+/g, '-')}.json`;
  a.click();
};
$('#importFile').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const next = JSON.parse(await f.text());
    if (!Array.isArray(next.days)) throw new Error('Not a trip file.');
    state = { ...blank(), ...next, dayIdx: 0 };
    save(); render();
  } catch (err) { alert(err.message); }
  e.target.value = '';
};

$('#env').hidden = !location.pathname.includes('/preview/');

render();
mountSearch();
