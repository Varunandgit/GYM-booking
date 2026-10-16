// Promote an existing user to admin (admins are never created through the website).
// Usage: node make-admin.js someone@example.com
const db = require('./db');

const email = process.argv[2];
if (!email) {
  console.log('Usage: node make-admin.js someone@example.com');
  process.exit(1);
}
const result = db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(email.trim().toLowerCase());
console.log(result.changes ? `${email} is now an admin` : 'No user found with that email');
