// Very simple single-page app: hash routing (#/login, #/sessions ...), no libraries.
const app = document.getElementById('app');
const nav = document.getElementById('nav');

let token = localStorage.getItem('token');
let user = JSON.parse(localStorage.getItem('user') || 'null');
let timer = null;   // polling timer for the sessions page
let busy = false;   // true while a request is in flight (buttons get disabled)

// ---------- helpers ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const hourText = (h) => String(h).padStart(2, '0') + ':00';
const go = (page) => { location.hash = '#/' + page; };

async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (res.status === 401 && token) { logout(); throw new Error('Please log in again'); }
  if (!res.ok) throw new Error((data && data.error && data.error.message) || 'Something went wrong');
  return data;
}

function logout() {
  token = null; user = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  go('login');
}

function renderNav() {
  if (!user) { nav.innerHTML = ''; return; }
  nav.innerHTML =
    '<a href="#/sessions">Sessions</a><a href="#/bookings">My bookings</a>' +
    (user.role === 'admin' ? '<a href="#/admin">Admin</a>' : '') +
    `<button id="logout">Log out (${esc(user.name)})</button>`;
  document.getElementById('logout').onclick = logout;
}

// ---------- router ----------
function route() {
  clearInterval(timer);
  const page = location.hash.slice(2) || 'sessions';
  renderNav();
  const publicPages = ['login', 'register'];
  if (!user && !publicPages.includes(page)) return go('login');          // protected routes
  if (user && publicPages.includes(page)) return go('sessions');
  if (page === 'admin' && user.role !== 'admin') return go('sessions');  // members can't open admin
  const pages = { login: loginPage, register: registerPage, sessions: sessionsPage, bookings: bookingsPage, admin: adminPage };
  (pages[page] || sessionsPage)();
}
window.addEventListener('hashchange', route);

// ---------- login / register ----------
function authForm(isRegister) {
  app.innerHTML = `
    <div class="card">
      <h2>${isRegister ? 'Register' : 'Log in'}</h2>
      <form id="f" novalidate>
        ${isRegister ? '<label for="name">Name</label><input id="name" autocomplete="name" /><div class="field-error" id="e-name"></div>' : ''}
        <label for="email">Email</label><input id="email" type="email" autocomplete="email" />
        <div class="field-error" id="e-email"></div>
        <label for="password">Password</label><input id="password" type="password" autocomplete="${isRegister ? 'new-password' : 'current-password'}" />
        <div class="field-error" id="e-password"></div>
        <div id="msg" role="alert"></div>
        <button id="submit" type="submit">${isRegister ? 'Register' : 'Log in'}</button>
      </form>
      <p>${isRegister ? 'Have an account? <a href="#/login">Log in</a>' : 'No account? <a href="#/register">Register</a>'}</p>
    </div>`;

  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const v = (id) => (document.getElementById(id) ? document.getElementById(id).value.trim() : '');
    const name = v('name'), email = v('email'), password = document.getElementById('password').value;
    // inline validation
    const errs = {};
    if (isRegister && !name) errs.name = 'Error: name is required';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = 'Error: enter a valid email';
    if (isRegister ? password.length < 6 : !password) errs.password = isRegister ? 'Error: password must be at least 6 characters' : 'Error: password is required';
    ['name', 'email', 'password'].forEach((k) => { const el = document.getElementById('e-' + k); if (el) el.textContent = errs[k] || ''; });
    if (Object.keys(errs).length) return;

    const btn = document.getElementById('submit');
    const msg = document.getElementById('msg');
    btn.disabled = true; msg.innerHTML = '';
    try {
      if (isRegister) await api('/register', 'POST', { name, email, password });
      const data = await api('/login', 'POST', { email, password });
      token = data.token; user = data.user;
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      go('sessions'); route();
    } catch (err) {
      msg.innerHTML = `<div class="error">Error: ${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  };
}
const loginPage = () => authForm(false);
const registerPage = () => authForm(true);

// ---------- sessions list ----------
let sessions = [];
let sessionsError = '';
let sessionsLoaded = false;
let actionMsg = '';

async function sessionsPage() {
  sessionsLoaded = false; sessionsError = ''; actionMsg = '';
  app.innerHTML = `
    <h2>Sessions</h2>
    <label for="date">Filter by date</label>
    <input id="date" type="date" />
    <div id="list"><p>Loading sessions...</p></div>`;
  document.getElementById('date').onchange = () => { sessionsLoaded = false; drawSessions(); loadSessions(); };
  await loadSessions();
  timer = setInterval(() => { if (!busy) loadSessions(); }, 10000); // poll for seat changes
}

async function loadSessions() {
  const date = document.getElementById('date') ? document.getElementById('date').value : '';
  try {
    sessions = await api('/sessions' + (date ? '?date=' + date : ''));
    sessionsError = '';
  } catch (err) { sessionsError = err.message; }
  sessionsLoaded = true;
  drawSessions();
}

function drawSessions() {
  const list = document.getElementById('list');
  if (!list) return;
  if (!sessionsLoaded) { list.innerHTML = '<p>Loading sessions...</p>'; return; }
  let html = '';
  if (actionMsg) html += `<div class="error" role="alert">Error: ${esc(actionMsg)}</div>`;
  if (sessionsError) html += `<div class="error" role="alert">Error: ${esc(sessionsError)}</div>`;
  if (!sessions.length && !sessionsError) html += '<p>No sessions found.</p>';
  for (const s of sessions) {
    let button, extra = '';
    if (s.started) button = '<span>Started</span>';
    else if (s.my_booking) {
      button = `<button data-act="cancel" data-id="${s.my_booking.id}" ${busy ? 'disabled' : ''}>Cancel booking</button>`;
      extra = `<div>Booked. Your code: <span class="code">${esc(s.my_booking.code || '')}</span></div>`;
    } else if (s.on_waitlist) { extra = `<div>You are on the waitlist${s.waitlist_position ? ' (position ' + s.waitlist_position + ')' : ''}</div>`; button = `<button data-act="leave" data-id="${s.id}" ${busy ? 'disabled' : ''}>Leave waitlist</button>`; }
    else if (s.seats_remaining > 0) button = `<button data-act="book" data-id="${s.id}" ${busy ? 'disabled' : ''}>Book</button>`;
    else button = `<button data-act="wait" data-id="${s.id}" ${busy ? 'disabled' : ''}>Join waitlist</button>`;
    html += `<div class="card">
      <div class="row">
        <div><strong>${esc(s.date)} at ${hourText(s.start_hour)}</strong><br>Seats left: ${s.seats_remaining} / ${s.capacity}${s.seats_remaining === 0 ? ' (full)' : ''}</div>
        ${button}
      </div>${extra}</div>`;
  }
  list.innerHTML = html;
  list.querySelectorAll('button[data-act]').forEach((b) => (b.onclick = () => sessionAction(b.dataset.act, Number(b.dataset.id))));
}

async function sessionAction(act, id) {
  actionMsg = '';
  busy = true;
  const before = JSON.parse(JSON.stringify(sessions)); // saved copy for rollback
  const s = act === 'cancel' ? sessions.find((x) => x.my_booking && x.my_booking.id === id) : sessions.find((x) => x.id === id);

  // optimistic update: change the screen first
  if (act === 'book') { s.seats_remaining--; s.my_booking = { id: 0, code: '...' }; }
  if (act === 'cancel') { s.seats_remaining++; s.my_booking = null; }
  if (act === 'wait') s.on_waitlist = true;
  if (act === 'leave') s.on_waitlist = false;
  drawSessions();

  try {
    if (act === 'book') await api(`/sessions/${id}/book`, 'POST');
    if (act === 'cancel') await api(`/bookings/${id}`, 'DELETE');
    if (act === 'wait') await api(`/sessions/${id}/waitlist`, 'POST');
    if (act === 'leave') await api(`/sessions/${id}/waitlist`, 'DELETE');
  } catch (err) {
    sessions = before;     // server refused -> roll back
    actionMsg = err.message;
  }
  busy = false;
  await loadSessions();    // get the real numbers from the server
}

// ---------- my bookings ----------
async function bookingsPage() {
  app.innerHTML = '<h2>My bookings</h2><div id="list"><p>Loading...</p></div>';
  await drawBookings('');
}

async function drawBookings(message) {
  const list = document.getElementById('list');
  try {
    const [rows, waits] = await Promise.all([api('/bookings/mine'), api('/waitlist/mine')]);
    let html = message ? `<div class="error" role="alert">Error: ${esc(message)}</div>` : '';
    if (!rows.length) html += '<p>You have no bookings yet.</p>';
    for (const b of rows) {
      const active = b.status === 'confirmed';
      html += `<div class="card"><div class="row">
        <div><strong>${esc(b.date)} at ${hourText(b.start_hour)}</strong><br>
          Status: ${active ? (b.checked_in_at ? 'Checked in' : 'Confirmed') : 'Cancelled'}
          ${active ? `<br>Code: <span class="code">${esc(b.code)}</span>` : ''}</div>
        ${active && !b.started && !b.checked_in_at ? `<button data-cancel="${b.id}">Cancel</button>` : ''}
      </div></div>`;
    }
    html += '<h3>My waitlists</h3>';
    if (!waits.length) html += '<p>You are not on any waitlist.</p>';
    for (const w of waits) {
      html += `<div class="card"><div class="row">
        <div><strong>${esc(w.date)} at ${hourText(w.start_hour)}</strong><br>Waitlist position: ${w.position}</div>
        <button data-leave="${w.session_id}">Leave waitlist</button>
      </div></div>`;
    }
    list.innerHTML = html;
    list.querySelectorAll('button').forEach((btn) => {
      btn.onclick = async () => {
        list.querySelectorAll('button').forEach((x) => (x.disabled = true));
        let m = '';
        try {
          if (btn.dataset.cancel) await api('/bookings/' + btn.dataset.cancel, 'DELETE');
          else await api(`/sessions/${btn.dataset.leave}/waitlist`, 'DELETE');
        } catch (err) { m = err.message; }
        drawBookings(m);
      };
    });
  } catch (err) {
    list.innerHTML = `<div class="error" role="alert">Error: ${esc(err.message)}</div>`;
  }
}

// ---------- admin ----------
async function adminPage() {
  app.innerHTML = `
    <h2>Admin</h2>
    <div class="card">
      <h3>Create session</h3>
      <form id="create" novalidate>
        <label for="c-date">Date</label><input id="c-date" type="date" />
        <label for="c-hour">Start hour (0-23)</label><input id="c-hour" type="number" min="0" max="23" />
        <div class="field-error" id="c-err" role="alert"></div>
        <div id="c-msg" role="status"></div>
        <button id="c-btn" type="submit">Create (capacity 20)</button>
      </form>
    </div>
    <div class="card">
      <h3>Check in a member</h3>
      <form id="checkin" novalidate>
        <label for="code">Code</label><input id="code" maxlength="6" autocomplete="off" />
        <div id="k-msg" role="status"></div>
        <button id="k-btn" type="submit">Mark present</button>
      </form>
    </div>
    <div class="card">
      <h3>Bookings of a session</h3>
      <label for="pick">Session</label><select id="pick"></select>
      <div id="bk"></div>
    </div>`;

  // create session
  document.getElementById('create').onsubmit = async (e) => {
    e.preventDefault();
    const date = document.getElementById('c-date').value;
    const hourStr = document.getElementById('c-hour').value;
    const hour = Number(hourStr);
    const err = document.getElementById('c-err'), msg = document.getElementById('c-msg');
    err.textContent = ''; msg.innerHTML = '';
    if (!date) { err.textContent = 'Error: choose a date'; return; }
    if (hourStr === '' || !Number.isInteger(hour) || hour < 0 || hour > 23) { err.textContent = 'Error: hour must be a whole number 0-23'; return; }
    const btn = document.getElementById('c-btn'); btn.disabled = true;
    try {
      await api('/sessions', 'POST', { date, start_hour: hour });
      msg.innerHTML = '<div class="success">Success: session created</div>';
      loadPicker();
    } catch (er) { msg.innerHTML = `<div class="error">Error: ${esc(er.message)}</div>`; }
    btn.disabled = false;
  };

  // check-in
  document.getElementById('checkin').onsubmit = async (e) => {
    e.preventDefault();
    const code = document.getElementById('code').value.trim();
    const msg = document.getElementById('k-msg');
    if (code.length !== 6) { msg.innerHTML = '<div class="error">Error: code must be 6 characters</div>'; return; }
    const btn = document.getElementById('k-btn'); btn.disabled = true; msg.innerHTML = '';
    try {
      const r = await api('/checkin', 'POST', { code });
      msg.innerHTML = `<div class="success">Success: ${esc(r.name)} (${esc(r.email)}) is present for ${esc(r.date)} ${hourText(r.start_hour)}</div>`;
      document.getElementById('code').value = '';
      showBookings();
    } catch (er) { msg.innerHTML = `<div class="error">Error: ${esc(er.message)}</div>`; }
    btn.disabled = false;
  };

  document.getElementById('pick').onchange = showBookings;
  loadPicker();
}

async function loadPicker() {
  const pick = document.getElementById('pick');
  const bk = document.getElementById('bk');
  try {
    const all = await api('/sessions');
    const current = pick.value;
    pick.innerHTML = all.map((s) => `<option value="${s.id}">${esc(s.date)} ${hourText(s.start_hour)} (${s.capacity - s.seats_remaining}/${s.capacity})</option>`).join('');
    if (current) pick.value = current;
    if (!all.length) bk.innerHTML = '<p>No sessions yet.</p>'; else showBookings();
  } catch (err) { bk.innerHTML = `<div class="error">Error: ${esc(err.message)}</div>`; }
}

async function showBookings() {
  const pick = document.getElementById('pick'), bk = document.getElementById('bk');
  if (!pick || !pick.value) return;
  bk.innerHTML = '<p>Loading...</p>';
  try {
    const rows = await api(`/sessions/${pick.value}/bookings`);
    if (!rows.length) { bk.innerHTML = '<p>No bookings for this session.</p>'; return; }
    bk.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Code</th><th>Status</th></tr></thead><tbody>` +
      rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${esc(r.code)}</td>
        <td>${r.status === 'cancelled' ? 'Cancelled' : r.checked_in_at ? 'Present' : 'Not yet'}</td></tr>`).join('') +
      '</tbody></table></div>';
  } catch (err) { bk.innerHTML = `<div class="error">Error: ${esc(err.message)}</div>`; }
}

route();
