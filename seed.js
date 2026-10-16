// Fills the database with test data. Run: npm run seed
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');

const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

db.exec('DELETE FROM waitlist; DELETE FROM bookings; DELETE FROM sessions; DELETE FROM users;');

const addUser = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)');
const hash = (p) => bcrypt.hashSync(p, 10);

addUser.run('Gym Admin', 'admin@gym.com', hash('admin123'), 'admin');
addUser.run('Alice Member', 'alice@gym.com', hash('member123'), 'member');
const bobId = addUser.run('Bob Member', 'bob@gym.com', hash('member123'), 'member').lastInsertRowid;

const addSession = db.prepare('INSERT INTO sessions (date, start_hour, capacity) VALUES (?, ?, 20)');
const ids = [];
for (const [d, h] of [[0, 18], [0, 20], [1, 7], [1, 10], [1, 18], [2, 9], [2, 17], [3, 8]]) {
  ids.push(addSession.run(dayOffset(d), h).lastInsertRowid);
}

// Fill tomorrow 10:00 (index 3) completely with 20 filler members
const fullId = ids[3];
const filler = hash('filler123');
const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = () => Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join('');
for (let i = 1; i <= 20; i++) {
  const u = addUser.run(`Filler ${i}`, `filler${i}@gym.com`, filler, 'member').lastInsertRowid;
  db.prepare('INSERT INTO bookings (user_id, session_id, code) VALUES (?, ?, ?)').run(u, fullId, code());
}

// Bob already has a booking in one session
db.prepare('INSERT INTO bookings (user_id, session_id, code) VALUES (?, ?, ?)')
  .run(bobId, ids[4], code());

console.log('Seeded. Admin: admin@gym.com / admin123 | Member: alice@gym.com / member123');
