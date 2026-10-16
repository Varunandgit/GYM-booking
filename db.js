// Opens the SQLite database and creates the tables if they do not exist.
// Uses the SQLite that is built into Node (22.5 or newer) - nothing to compile.
const { DatabaseSync } = require('node:sqlite');
const raw = new DatabaseSync('gym.db');
raw.exec('PRAGMA foreign_keys = ON');

const db = {
  exec: (sql) => raw.exec(sql),
  prepare: (sql) => raw.prepare(sql),
  // Runs fn as one all-or-nothing step (rolls back if it throws)
  transaction: (fn) => (...args) => {
    raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(...args);
      raw.exec('COMMIT');
      return result;
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
  },
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,              -- YYYY-MM-DD
  start_hour INTEGER NOT NULL CHECK (start_hour BETWEEN 0 AND 23),
  capacity INTEGER NOT NULL DEFAULT 20,
  UNIQUE (date, start_hour)        -- two sessions cannot share a start time
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  code TEXT NOT NULL UNIQUE,       -- check-in code
  checked_in_at TEXT,              -- set when staff mark the member present
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- one ACTIVE booking per member per session (cancelled ones don't count)
CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking
  ON bookings(user_id, session_id) WHERE status = 'confirmed';

CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  UNIQUE (user_id, session_id)     -- cannot join twice
);
`);

module.exports = db;
