import { settleUp, optimizeOrder, scheduleDay, placePairs, isPlace, fmtTime, fmtDur, pad } from './logic.js';
import { search, geocode, route, haversine, STAY_TAGS } from './providers.js';

const $ = s => document.querySelector(s);
const STORE = 'travelapp';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const blankDay = () => ({ date: '', city: '', start: '09:00', items: [], legs: [] });
const blank = () => ({
  name: 'My trip', currency: 'HKD', members: ['Me'], tab: 'overview',
  itinerary: [],                  // flights, trains, hotels - the trip skeleton
  days: [blankDay()], dayIdx: 0,   // per-day local plans
  expenses: [],
});

// Spread over blank() so trips saved by an older version pick up new keys.
let state = { ...blank(), ...JSON.parse(localStorage.getItem(STORE) || 'null') };
for (const d of state.days) {          // days carried `pois` before free-form items existed
  if (d.items && !d.items) { d.items = d.items; delete d.items; }
  d.items ||= [];
}
const save = () => localStorage.setItem(STORE, JSON.stringify(state));
const day = () => state.days[state.dayIdx];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

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

/** Departure clock for a day. Timetables differ by weekday, so the date matters. */
function startDate(d) {
  const [h, mi] = d.start.split(':').map(Number);
  const t = d.date ? new Date(`${d.date}T${pad(h)}:${pad(mi)}:00`) : new Date();
  if (!d.date) t.setHours(h, mi, 0, 0);
  return t;
}

/* ---------- routing ---------- */
async function recalc() {
  const d = day();
  if (d.items.length < 2) { d.legs = []; save(); return render(); }
  setBusy(1);
  try {
    let t = startDate(d);
    d.legs = [];
    for (let i = 0; i < d.items.length - 1; i++) {
      t = new Date(t.getTime() + (d.items[i].stayMin ?? 60) * 60000);
      try {
        const leg = await route(d.items[i], d.items[i + 1], t);
        d.legs[i] = leg;
        if (leg) t = new Date(t.getTime() + leg.seconds * 1000);
      } catch (e) {
        d.legs[i] = null;
        console.warn('routing failed', e);
      }
      save();          // keep partial results if a later leg fails
      renderPlan();
    }
    render();
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
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · transit <a href="https://transitous.org">Transitous</a>',
    }).addTo(map);
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

/* ---------- place search ---------- */
const addPoi = p => { day().items.push(p); save(); recalc(); };

/** Bias search near where you already are that day, else near the day's city. */
async function biasPoint() {
  const d = day();
  const places = d.items.filter(isPlace);
  if (places.length) return places[places.length - 1];
  if (d.city && !d.cityPt) {
    try { const g = await geocode(d.city); d.cityPt = { lat: g.lat, lng: g.lng }; save(); } catch { /* no bias */ }
  }
  return d.cityPt || null;
}

/**
 * Attaches type-ahead to an input. Its parent must carry .ac (position:relative).
 * `bias` is async so it can geocode the day's city on first use.
 */
function attachSearch(input, { onPick, bias, tags, clearOnPick = false, list }) {
  if (!list) {
    list = document.createElement('ul');
    list.className = 'ac-list';
    list.hidden = true;
    input.parentElement.append(list);
  }
  let timer, abort, hits = [], cursor = -1;

  const hide = () => { list.hidden = true; cursor = -1; };
  const draw = () => {
    list.replaceChildren(...hits.map((h, i) => {
      const li = document.createElement('li');
      li.className = i === cursor ? 'on' : '';
      li.innerHTML = `<b>${esc(h.name)}</b><small>${esc([h.kind, h.label].filter(Boolean).join(' · '))}</small>`;
      li.onmousedown = e => { e.preventDefault(); pick(i); };
      return li;
    }));
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
        hits = await search(q, { near: await bias?.(), tags }, abort.signal);
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

function mountSearch() {
  attachSearch($('#poiSearch'), {
    list: $('#poiResults'),
    bias: biasPoint,
    clearOnPick: true,
    onPick: h => addPoi({ name: h.name, address: h.label, lat: h.lat, lng: h.lng, stayMin: 60 }),
  });
}

/* ---------- day tabs (shared by Itinerary and Local travel) ---------- */
function renderDays() {
  const tabs = $('#dayTabs');
  tabs.innerHTML = '';
  state.days.forEach((d, i) => {
    const b = document.createElement('button');
    b.className = 'tab' + (i === state.dayIdx ? ' on' : '');
    b.textContent = [`Day ${i + 1}`, d.date && d.date.slice(5), d.city].filter(Boolean).join(' · ');
    b.onclick = () => { state.dayIdx = i; save(); render(); };
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
const ICON = { Flight: '✈', Train: '🚆', Bus: '🚌', Ferry: '⛴', Car: '🚗', Hotel: '🏨', Other: '📌' };
const isStay = k => k === 'Hotel';
const dateOf = dt => (dt || '').slice(0, 10);

// A stay covers every night from check-in through check-out morning.
const staysOn = (b, d) => isStay(b.kind) && b.start && dateOf(b.start) <= d && d <= dateOf(b.end || b.start);
const movesOn = (b, d) => !isStay(b.kind) && dateOf(b.start) === d;

const newBooking = (kind, start = '') =>
  ({ id: crypto.randomUUID(), kind, ref: '', from: '', to: '', start, end: '', conf: '', cost: 0, notes: '' });

/** Nights for a stay; nothing for transport, whose local times cross time zones. */
function spanLabel(b) {
  if (!b.start || !b.end || !isStay(b.kind)) return '';
  const nights = Math.round((new Date(b.end) - new Date(b.start)) / 86400000);
  return nights > 0 ? `${nights} night${nights > 1 ? 's' : ''}` : '';
}

function bookingCard(b) {
  const stay = isStay(b.kind);
  const billed = state.expenses.some(e => e.src === b.id);
  const li = document.createElement('li');
  li.className = 'booking' + (stay ? ' is-stay' : '');
  li.dataset.bid = b.id;
  li.innerHTML = `
    <div class="brow head">
      <select class="f-kind" aria-label="Type">${KINDS.map(k =>
        `<option value="${k}"${k === b.kind ? ' selected' : ''}>${ICON[k]} ${k}</option>`).join('')}</select>
      ${stay
        ? `<span class="ac grow"><input class="f-ref" value="${esc(b.ref || '')}" placeholder="Search a hotel…" autocomplete="off"></span>`
        : `<input class="f-ref grow" value="${esc(b.ref || '')}" placeholder="Flight / service no.">`}
      <span class="spacer"></span>
      <button class="bill${billed ? ' on' : ''}"${+b.cost > 0 ? '' : ' disabled'}
        title="${billed ? 'Remove from expenses' : 'Add this cost to expenses'}">${billed ? '✓ expensed' : '+ expense'}</button>
      <button class="x" title="Remove">✕</button>
    </div>

    <div class="brow">
      <input class="f-from grow" value="${esc(b.from || '')}" placeholder="${stay ? 'Address' : 'From'}">
      ${stay ? '' : `<span class="arrow">→</span><input class="f-to grow" value="${esc(b.to || '')}" placeholder="To">`}
      ${stay ? '<button class="mapit" title="Open in OpenStreetMap">map</button><button class="startday" title="Add as the first stop of this day under Local travel">start day here</button>' : ''}
    </div>

    <div class="brow">
      <label>${stay ? 'Check in' : 'Depart'}<input type="datetime-local" class="f-start" value="${esc(b.start || '')}"></label>
      <label>${stay ? 'Check out' : 'Arrive'}<input type="datetime-local" class="f-end" value="${esc(b.end || '')}"></label>
      <small class="span">${esc(spanLabel(b))}</small>
    </div>

    <div class="brow">
      <label>Booking no.<input class="f-conf" value="${esc(b.conf || '')}" placeholder="confirmation ref"></label>
      <label>${esc(state.currency)}<input type="number" class="f-cost" step="0.01" min="0" size="8" value="${b.cost || ''}"></label>
      <input class="f-notes grow" value="${esc(b.notes || '')}" placeholder="Seat, terminal, breakfast included…">
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
  bind('.f-from', 'from');
  bind('.f-to', 'to');
  bind('.f-start', 'start', true);
  bind('.f-end', 'end', true);
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
      desc: [b.kind, b.ref, b.from && b.to ? `${b.from} → ${b.to}` : b.from].filter(Boolean).join(' · '),
      amount: +b.cost, payer: state.members[0], sharedBy: [...state.members], src: b.id,
    });
    save(); render();
  };

  if (stay) attachSearch(li.querySelector('.f-ref'), {
    bias: biasPoint,
    tags: STAY_TAGS,
    onPick: h => {
      // Fills the name, address and coordinates at once, so neither the map link
      // nor "start day here" has to geocode again.
      b.ref = h.name; b.from = h.label; b.lat = h.lat; b.lng = h.lng;
      save(); render();
    },
  });

  li.querySelector('.mapit')?.addEventListener('click', () => {
    const url = b.lat != null
      ? `https://www.openstreetmap.org/?mlat=${b.lat}&mlon=${b.lng}#map=17/${b.lat}/${b.lng}`
      : `https://www.openstreetmap.org/search?query=${encodeURIComponent(b.from || b.ref)}`;
    if (b.lat != null || b.from || b.ref) window.open(url, '_blank', 'noopener');
  });

  li.querySelector('.startday')?.addEventListener('click', async () => {
    if (b.lat != null) {                       // picked from the list, already located
      day().items.unshift({ name: b.ref || b.from, address: b.from, lat: b.lat, lng: b.lng, stayMin: 0 });
      save(); showTab('local'); recalc();
      return;
    }
    const q = b.from || b.ref;
    if (!q) return toast('Give the hotel an address first, or pick it from the search list.');
    setBusy(1);
    try {
      const poi = await geocode(q);
      poi.name = b.ref || poi.name;
      poi.stayMin = 0;
      day().items.unshift(poi);
      save(); setBusy(-1); showTab('local'); recalc();
    } catch (err) { toast(err.message); setBusy(-1); }
  });

  return li;
}

function renderItinerary() {
  const d = day().date;
  state.itinerary.sort((a, b) => (a.start || '~').localeCompare(b.start || '~'));

  // With no date on the day there is nothing to file against, so show everything.
  const all = !d;
  $('#noDate').hidden = !all || !state.itinerary.length;

  const stays = state.itinerary.filter(b => all ? isStay(b.kind) : staysOn(b, d));
  const moves = state.itinerary.filter(b => all ? !isStay(b.kind) : movesOn(b, d));
  // Anything that lands on no day at all - undated, or dated outside the trip -
  // would otherwise be invisible from every tab.
  const onSomeDay = b => state.days.some(x => x.date && (isStay(b.kind) ? staysOn(b, x.date) : movesOn(b, x.date)));
  const loose = all ? [] : state.itinerary.filter(b => !onSomeDay(b));

  fill('#stays', stays, 'Nowhere booked for this night.');
  fill('#transport', moves, 'Nothing scheduled to move you on this day.');
  fill('#undated', loose, '');
  $('#undatedGroup').hidden = !loose.length;

  const total = state.itinerary.reduce((s, b) => s + (+b.cost || 0), 0);
  $('#bookTotal').textContent = total ? `Bookings total ${state.currency} ${total.toFixed(2)}` : '';

  function fill(sel, items, emptyMsg) {
    const ul = $(sel);
    ul.replaceChildren(...items.map(bookingCard));
    if (!items.length && emptyMsg) ul.innerHTML = `<li class="empty">${emptyMsg}</li>`;
  }
}

/* ---------- local travel ---------- */
let dragFrom = null;

function renderPlan() {
  const d = day();
  $('#dayStart').value = d.start;
  const list = $('#stops');
  list.innerHTML = '';

  // Places are numbered to match the map pins; free-form items are not.
  const ord = new Map();
  d.items.forEach((it, i) => { if (isPlace(it)) ord.set(i, ord.size + 1); });

  for (const row of scheduleDay(d.items, d.legs, d.start)) {
    list.append(row.type === 'item' ? itemRow(d, row, ord) : legRow(d, row));
  }
  if (!d.items.length) {
    list.innerHTML = '<li class="empty">Search for a place, or add a free-form entry like "breakfast" or "buy JR pass".</li>';
  }
  drawMap();
}

function itemRow(d, row, ord) {
  const it = d.items[row.i];
  const li = document.createElement('li');
  li.className = 'stop' + (row.place ? '' : ' note');
  li.innerHTML = `
    <div class="grip" title="Drag to reorder">⠿</div>
    <div class="marker">${row.place ? ord.get(row.i) : '•'}</div>
    <div class="when">${fmtTime(row.arrive)}<small>${fmtTime(row.depart)}</small></div>
    <div class="what">
      <input class="rename" value="${esc(it.name || '')}" aria-label="Name"
             placeholder="${row.place ? 'Stop name' : 'What are you doing?'}">
      ${row.place ? `<small>${esc(it.address || '')}</small>` : ''}
    </div>
    <label class="stay"><input class="stay-in" type="number" min="0" step="15" value="${it.stayMin ?? 60}">min</label>
    <button class="x" title="Remove">✕</button>`;

  li.querySelector('.rename').onchange = e => { it.name = e.target.value.trim(); save(); render(); };
  li.querySelector('.stay-in').onchange = e => { it.stayMin = +e.target.value; save(); recalc(); };
  li.querySelector('.x').onclick = () => { d.items.splice(row.i, 1); save(); recalc(); };
  // draggable only from the grip, so the name field stays selectable
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

function legRow(d, row) {
  const li = document.createElement('li');
  li.className = 'leg' + (row.leg ? '' : ' bad');
  li.innerHTML = `
    <span class="dur">${row.leg ? fmtDur(row.leg.seconds) : 'no route'}</span>
    <span class="via">${esc(row.leg ? row.leg.summary : 'no public transport found - walk it, or check the day has a date set')}</span>
    <button class="fare" title="Add what this leg cost to Expenses">+ fare</button>`;
  li.querySelector('.fare').onclick = async () => {
    const v = +await askText({
      title: 'What did this leg cost?',
      body: `${d.items[row.from].name} → ${d.items[row.to].name}`,
      label: state.currency, type: 'number', confirm: 'Add to expenses',
    });
    if (!v) return;
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
      <div class="what"><b>${esc(e.desc)}</b><small>paid by ${esc(e.payer)}${e.src ? ' · from Itinerary' : ''}</small></div>
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
  const dated = state.days.filter(d => d.date).map(d => d.date).sort();
  $('#ovTitle').textContent = state.name;
  $('#ovMeta').textContent = [
    `${state.days.length} day${state.days.length > 1 ? 's' : ''}`,
    dated.length ? `${wkday(dated[0])} – ${wkday(dated[dated.length - 1])}` : null,
    [...new Set(state.days.map(d => d.city).filter(Boolean))].join(' · ') || null,
    state.members.join(', '),
  ].filter(Boolean).join('  ·  ');

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
        ${d.city ? `<em>${esc(d.city)}</em>` : ''}
        <span class="spacer"></span>
        ${travel ? `<small>${fmtDur(travel * 60)} travelling</small>` : ''}
      </header>

      ${stays.length ? `<div class="ovline"><span class="k">Staying</span><span>${stays.map(b =>
        `${esc(b.ref || 'Hotel')}${b.conf ? ` <code>${esc(b.conf)}</code>` : ''}${b.from ? ` — ${esc(b.from)}` : ''}`
      ).join('<br>')}</span></div>` : ''}

      ${moves.length ? `<div class="ovline"><span class="k">Moving</span><span>${moves.map(b =>
        `${ICON[b.kind] || ''} ${esc(b.ref || b.kind)}${b.from || b.to ? ` ${esc(b.from)} → ${esc(b.to)}` : ''}${
          b.start ? ` at ${esc(b.start.slice(11, 16))}` : ''}${b.conf ? ` <code>${esc(b.conf)}</code>` : ''}`
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
  $('#tripName').value = state.name;
  renderDays(); renderOverview(); renderItinerary(); renderPlan(); renderMoney();
}

function showTab(name) {
  state.tab = name;
  for (const b of document.querySelectorAll('[data-tab]')) {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on);
    $('#' + b.dataset.tab).hidden = !on;
  }
  $('#daystrip').hidden = name === 'money' || name === 'overview';
  // Leaflet measures 0x0 while its container is hidden.
  if (name === 'local') setTimeout(() => map?.invalidateSize(), 0);
  save();
}

/* ---------- guided setup ---------- */
const WIZ = [
  ['Plan a trip', 'Three questions, then you have a skeleton to fill in.'],
  ['Where are you going?', 'Add a row per city and say how many nights in each.'],
  ['When, and with whom?', 'Dates fill in the day tabs; the party drives expense splitting.'],
];
let wizStep = 0;

function cityRow(name = '', nights = 3) {
  const div = document.createElement('div');
  div.className = 'cityrow';
  div.innerHTML = `
    <input class="c-name grow" value="${esc(name)}" placeholder="Tokyo">
    <input class="c-nights" type="number" min="1" max="60" value="${nights}"> nights
    <button class="x" type="button" title="Remove">✕</button>`;
  div.querySelector('.x').onclick = () => {
    if ($('#wCities').children.length > 1) div.remove();
  };
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
  $('#wizard').querySelector(`.wiz-body[data-step="${wizStep}"] input`)?.focus();
}

function openWizard() {
  $('#wTrip').value = state.name === 'My trip' ? '' : state.name;
  $('#wCities').replaceChildren(cityRow());
  $('#wStart').value = day().date || isoDate(new Date());
  $('#wWho').value = state.members.join(', ');
  $('#wCur').value = state.currency;
  wizShow(0);
  $('#wizard').showModal();
}

async function buildTrip() {
  const cities = [...$('#wCities').children]
    .map(r => ({ name: r.querySelector('.c-name').value.trim(), nights: +r.querySelector('.c-nights').value || 1 }))
    .filter(c => c.name);
  if (!cities.length) { toast('Add at least one city.'); wizShow(1); return; }

  const start = $('#wStart').value;
  if (!start) { toast('Pick the first day of the trip.'); return; }

  if (state.days.some(d => d.items.length)) {
    const ok = await ask({
      title: 'Replace the current plan?',
      body: `The ${state.days.length} day(s) you have now, and their stops, are replaced. Bookings and expenses are kept.`,
      confirm: 'Replace', danger: true,
    });
    if (!ok) return;
  }

  const t = new Date(`${start}T00:00`);
  const days = [];
  for (const c of cities) {
    for (let n = 0; n < c.nights; n++) {
      const d = blankDay();
      d.date = isoDate(t);
      d.city = c.name;
      days.push(d);
      t.setDate(t.getDate() + 1);
    }
  }

  state.name = $('#wTrip').value.trim() || cities.map(c => c.name).join(' & ');
  state.members = $('#wWho').value.split(',').map(s => s.trim()).filter(Boolean);
  if (!state.members.length) state.members = ['Me'];
  state.currency = $('#wCur').value.trim() || 'HKD';
  state.days = days;
  state.dayIdx = 0;
  save();
  $('#wizard').close();
  render();
  showTab('itinerary');
}

$('#setupBtn').onclick = openWizard;
$('#wAddCity').onclick = () => $('#wCities').append(cityRow('', 3));
$('#wBack').onclick = () => wizShow(wizStep - 1);
$('#wCancel').onclick = () => $('#wizard').close();
$('#wNext').onclick = () => (wizStep === WIZ.length - 1 ? buildTrip() : wizShow(wizStep + 1));
$('#wizard').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); $('#wNext').click(); }
});

/* ---------- wiring ---------- */
$('#tripName').oninput = e => { state.name = e.target.value; save(); };

/* ---------- day settings ---------- */
function openDayDlg() {
  $('#ddTitle').textContent = `Day ${state.dayIdx + 1}`;
  $('#ddDate').value = day().date;
  $('#ddCity').value = day().city || '';
  $('#ddDelete').disabled = state.days.length < 2;
  // showModal() throws on an already-open dialog, and "add a day" reopens it.
  if (!$('#dayDlg').open) $('#dayDlg').showModal();
}

$('#dayEdit').onclick = openDayDlg;
$('#ddDone').onclick = () => $('#dayDlg').close();
$('#ddAdd').onclick = () => { addDayAfter(state.dayIdx); openDayDlg(); };

$('#ddDate').onchange = e => {
  day().date = e.target.value;
  // Fill blank later days with consecutive dates - saves typing out a long trip.
  if (day().date) {
    let t = new Date(`${day().date}T00:00`);
    for (let i = state.dayIdx + 1; i < state.days.length; i++) {
      t.setDate(t.getDate() + 1);
      if (state.days[i].date) t = new Date(`${state.days[i].date}T00:00`);
      else state.days[i].date = isoDate(t);
    }
  }
  save(); render(); recalc();
};

$('#ddCity').onchange = e => {
  day().city = e.target.value.trim();
  delete day().cityPt;          // the cached geocode belonged to the old city
  save(); render();
};

$('#ddDelete').onclick = async () => {
  if (state.days.length < 2) return toast('A trip needs at least one day.');
  $('#dayDlg').close();         // close first: stacked modals fight for focus
  const ok = await ask({
    title: `Delete day ${state.dayIdx + 1}?`,
    body: 'Its stops are lost. Bookings stay in the Itinerary.',
    confirm: 'Delete day', danger: true,
  });
  if (!ok) return;
  state.days.splice(state.dayIdx, 1);
  state.dayIdx = Math.min(state.dayIdx, state.days.length - 1);
  save(); render();
};
$('#dayStart').onchange = e => { day().start = e.target.value; save(); recalc(); };
const addBooking = (kind, time) => {
  const d = day().date;
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
$('#addStay').onclick = () => addBooking('Hotel', '15:00');
$('#addBooking').onclick = () => addBooking('Flight', '09:00');

$('#addPoi').onsubmit = async e => {
  e.preventDefault();
  const input = $('#poiInput');
  const lines = input.value.split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) return;
  setBusy(1);
  try {
    for (const [i, q] of lines.entries()) {
      if (i) await sleep(1100);        // Nominatim allows 1 request per second
      day().items.push(await geocode(q));
    }
    input.value = ''; save(); setBusy(-1); recalc();
  } catch (err) { toast(err.message); save(); setBusy(-1); render(); }
};
$('#addNote').onclick = () => {
  day().items.push({ name: '', stayMin: 30 });   // no coords, so never routed
  save(); renderPlan();
  const notes = document.querySelectorAll('#stops .stop.note .rename');
  notes[notes.length - 1]?.focus();
};
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
mountSearch();
if (firstRun) openWizard();
