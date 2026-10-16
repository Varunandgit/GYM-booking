require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const PORT = process.env.PORT || 3000;
const CAPACITY = 20;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
// Create an error with a status code. The global handler turns it into JSON.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Session start time (server's local time). Date is "YYYY-MM-DD".
function startTime(s) {
  return new Date(`${s.date}T${String(s.start_hour).padStart(2, '0')}:00:00`);
}
const hasStarted = (s) => Date.now() >= startTime(s).getTime();

// true only for real calendar dates like 2026-10-16 (rejects 2026-02-31)
function isRealDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function parseId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, 'Invalid id');
  return n;
}

// 6 characters, random (not sequential), no confusing letters like O/0 or I/1
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  while (true) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!db.prepare('SELECT 1 FROM bookings WHERE code = ?').get(code)) return code;
  }
}

const countConfirmed = (sessionId) =>
  db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE session_id = ? AND status = 'confirmed'").get(sessionId).n;

// ---------- middleware ----------
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(httpError(401, 'Please log in'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(payload.id);
    if (!user) return next(httpError(401, 'Please log in again'));
    req.user = user;
    next();
  } catch (e) {
    next(httpError(401, 'Invalid or expired token'));
  }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return next(httpError(403, 'Admins only'));
  next();
}

// ---------- accounts ----------
app.post('/api/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 60)
    throw httpError(422, 'Name is required (max 60 characters)');
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw httpError(422, 'Enter a valid email');
  if (typeof password !== 'string' || password.length < 6 || password.length > 72)
    throw httpError(422, 'Password must be 6 to 72 characters');

  const cleanEmail = email.trim().toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(cleanEmail))
    throw httpError(409, 'That email is already registered');

  // role is always "member" here - admins are created directly in the database
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'member')")
    .run(name.trim(), cleanEmail, bcrypt.hashSync(password, 10));
  res.status(201).json({ id: info.lastInsertRowid, name: name.trim(), email: cleanEmail, role: 'member' });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string')
    throw httpError(422, 'Email and password are required');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    throw httpError(401, 'Wrong email or password');
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

// ---------- sessions ----------
app.get('/api/sessions', auth, (req, res) => {
  const date = req.query.date;
  if (date !== undefined && date !== '' && !isRealDate(date))
    throw httpError(400, 'date must be a real date like 2026-10-16');

  const rows = date
    ? db.prepare('SELECT * FROM sessions WHERE date = ? ORDER BY date, start_hour').all(date)
    : db.prepare('SELECT * FROM sessions ORDER BY date, start_hour').all();

  const result = rows.map((s) => {
    const myBooking = db
      .prepare("SELECT id, code FROM bookings WHERE session_id = ? AND user_id = ? AND status = 'confirmed'")
      .get(s.id, req.user.id);
    const myWait = db.prepare('SELECT id FROM waitlist WHERE session_id = ? AND user_id = ?').get(s.id, req.user.id);
    const position = myWait
      ? db.prepare('SELECT COUNT(*) AS n FROM waitlist WHERE session_id = ? AND id <= ?').get(s.id, myWait.id).n
      : null;
    return {
      id: s.id,
      date: s.date,
      start_hour: s.start_hour,
      capacity: s.capacity,
      seats_remaining: s.capacity - countConfirmed(s.id),
      started: hasStarted(s),
      my_booking: myBooking || null,
      on_waitlist: !!myWait,
      waitlist_position: position,
    };
  });
  res.json(result);
});

app.post('/api/sessions', auth, adminOnly, (req, res) => {
  const { date, start_hour } = req.body || {};
  if (!isRealDate(date)) throw httpError(422, 'date must be a real date like 2026-10-16');
  if (!Number.isInteger(start_hour) || start_hour < 0 || start_hour > 23)
    throw httpError(422, 'start_hour must be a whole number from 0 to 23');
  if (hasStarted({ date, start_hour })) throw httpError(422, 'Session must be in the future');
  if (db.prepare('SELECT 1 FROM sessions WHERE date = ? AND start_hour = ?').get(date, start_hour))
    throw httpError(409, 'A session already exists at that time');

  const info = db.prepare('INSERT INTO sessions (date, start_hour, capacity) VALUES (?, ?, ?)').run(date, start_hour, CAPACITY);
  res.status(201).json({ id: info.lastInsertRowid, date, start_hour, capacity: CAPACITY });
});

// Admin: see all bookings of one session
app.get('/api/sessions/:id/bookings', auth, adminOnly, (req, res) => {
  const id = parseId(req.params.id);
  if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)) throw httpError(404, 'Session not found');
  const rows = db
    .prepare(
      `SELECT b.id, b.code, b.status, b.checked_in_at, u.name, u.email
       FROM bookings b JOIN users u ON u.id = b.user_id
       WHERE b.session_id = ? ORDER BY b.id`
    )
    .all(id);
  res.json(rows);
});

// ---------- bookings ----------
// The transaction makes "check the count + insert" one step, so two people
// can never both take the last seat (SQLite runs one write at a time).
const bookTx = db.transaction((userId, sessionId) => {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!s) throw httpError(404, 'Session not found');
  if (hasStarted(s)) throw httpError(409, 'This session has already started');
  if (db.prepare("SELECT 1 FROM bookings WHERE user_id = ? AND session_id = ? AND status = 'confirmed'").get(userId, sessionId))
    throw httpError(409, 'You already booked this session');
  if (countConfirmed(sessionId) >= s.capacity) throw httpError(409, 'This session is full');

  const code = newCode();
  const info = db.prepare('INSERT INTO bookings (user_id, session_id, code) VALUES (?, ?, ?)').run(userId, sessionId, code);
  db.prepare('DELETE FROM waitlist WHERE user_id = ? AND session_id = ?').run(userId, sessionId);
  return { id: info.lastInsertRowid, session_id: sessionId, code };
});

app.post('/api/sessions/:id/book', auth, (req, res) => {
  res.status(201).json(bookTx(req.user.id, parseId(req.params.id)));
});

// Move people from the waitlist into free seats (never for a started session)
function promoteWaitlist(sessionId) {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!s || hasStarted(s)) return;
  while (countConfirmed(sessionId) < s.capacity) {
    const next = db.prepare('SELECT * FROM waitlist WHERE session_id = ? ORDER BY id LIMIT 1').get(sessionId);
    if (!next) break;
    db.prepare('INSERT INTO bookings (user_id, session_id, code) VALUES (?, ?, ?)').run(next.user_id, sessionId, newCode());
    db.prepare('DELETE FROM waitlist WHERE id = ?').run(next.id);
  }
}

const cancelTx = db.transaction((userId, bookingId) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!b) throw httpError(404, 'Booking not found');
  if (b.user_id !== userId) throw httpError(403, 'This is not your booking'); // ownership check
  if (b.status !== 'confirmed') throw httpError(409, 'Booking is already cancelled');
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(b.session_id);
  if (hasStarted(s)) throw httpError(409, 'Cannot cancel after the session has started');
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(bookingId);
  promoteWaitlist(b.session_id);
});

app.delete('/api/bookings/:id', auth, (req, res) => {
  cancelTx(req.user.id, parseId(req.params.id));
  res.json({ ok: true });
});

// Members only see their own bookings
app.get('/api/bookings/mine', auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT b.id, b.code, b.status, b.checked_in_at, s.id AS session_id, s.date, s.start_hour
       FROM bookings b JOIN sessions s ON s.id = b.session_id
       WHERE b.user_id = ? ORDER BY s.date DESC, s.start_hour DESC`
    )
    .all(req.user.id);
  res.json(rows.map((r) => ({ ...r, started: hasStarted(r) })));
});

// ---------- waitlist ----------
app.post('/api/sessions/:id/waitlist', auth, (req, res) => {
  const id = parseId(req.params.id);
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!s) throw httpError(404, 'Session not found');
  if (hasStarted(s)) throw httpError(409, 'This session has already started');
  if (countConfirmed(id) < s.capacity) throw httpError(409, 'Seats are available - book directly');
  if (db.prepare("SELECT 1 FROM bookings WHERE user_id = ? AND session_id = ? AND status = 'confirmed'").get(req.user.id, id))
    throw httpError(409, 'You already booked this session');
  if (db.prepare('SELECT 1 FROM waitlist WHERE user_id = ? AND session_id = ?').get(req.user.id, id))
    throw httpError(409, 'You are already on the waitlist');
  db.prepare('INSERT INTO waitlist (user_id, session_id) VALUES (?, ?)').run(req.user.id, id);
  res.status(201).json({ ok: true });
});

app.delete('/api/sessions/:id/waitlist', auth, (req, res) => {
  const id = parseId(req.params.id);
  const info = db.prepare('DELETE FROM waitlist WHERE user_id = ? AND session_id = ?').run(req.user.id, id);
  if (info.changes === 0) throw httpError(404, 'You are not on this waitlist');
  res.json({ ok: true });
});

// Sessions the logged-in member is waiting for, with their place in line
app.get('/api/waitlist/mine', auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT w.id, s.id AS session_id, s.date, s.start_hour,
        (SELECT COUNT(*) FROM waitlist w2 WHERE w2.session_id = w.session_id AND w2.id <= w.id) AS position
       FROM waitlist w JOIN sessions s ON s.id = w.session_id
       WHERE w.user_id = ? ORDER BY s.date, s.start_hour`
    )
    .all(req.user.id);
  res.json(rows);
});

// ---------- check-in (admin) ----------
const checkInTx = db.transaction((rawCode) => {
  const b = db
    .prepare(
      `SELECT b.*, u.name, u.email FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.code = ?`
    )
    .get(rawCode);
  if (!b) throw httpError(404, 'Code not found');
  if (b.status !== 'confirmed') throw httpError(409, 'That booking was cancelled');
  if (b.checked_in_at) throw httpError(409, `${b.name} is already checked in`);
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(b.session_id);
  const start = startTime(s).getTime();
  const now = Date.now();
  if (now < start || now >= start + 60 * 60 * 1000)
    throw httpError(409, 'Code only works during the session hour');
  db.prepare('UPDATE bookings SET checked_in_at = CURRENT_TIMESTAMP WHERE id = ?').run(b.id);
  return { name: b.name, email: b.email, date: s.date, start_hour: s.start_hour };
});

app.post('/api/checkin', auth, adminOnly, (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== 'string' || !/^[A-Za-z0-9]{6}$/.test(code.trim()))
    throw httpError(422, 'Code must be 6 letters/numbers');
  res.json(checkInTx(code.trim().toUpperCase()));
});

// ---------- errors ----------
app.use('/api', (req, res, next) => next(httpError(404, 'Route not found')));

// Global error handler: always JSON, never a stack trace
app.use((err, req, res, next) => {
  let status = err.status || 500;
  let message = err.message;
  if (err.type === 'entity.parse.failed') { status = 400; message = 'Invalid JSON'; }
  if (status >= 500) {
    console.error(err);
    message = 'Something went wrong on the server';
  }
  res.status(status).json({ error: { status, message } });
});

app.listen(PORT, () => console.log(`Gym booking running at http://localhost:${PORT}`));
