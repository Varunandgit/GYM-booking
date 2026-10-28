# Gym Slot Booking

Members book/cancel one-hour gym sessions (20 seats), join a waitlist when full, and get a check-in code.
Admins create sessions, see bookings and mark members present.

## Design note
- Stack: Node.js + Express backend, SQLite database (Node's built-in `node:sqlite`), plain HTML/CSS/JS frontend served by the same server (no build step).
- Auth: bcrypt password hashes, JWT token; `auth` middleware on every private route, `adminOnly` on admin routes.
- Tables: `users` (role member/admin), `sessions` (UNIQUE date+start_hour), `bookings` (status, unique code, checked_in_at), `waitlist` (UNIQUE user+session).
- A partial unique index allows only one *confirmed* booking per member per session, so rebooking after cancelling works.
- Booking runs inside a database transaction (count seats, then insert) so the last seat can't be double-booked.
- Cancelling promotes the first waitlisted member inside the same transaction (never for a started session).
- Check-in codes are 6 random characters (crypto.randomInt), unique in the DB, not derived from each other.
- Errors are always JSON `{ "error": { "status", "message" } }`; a global error handler hides stack traces.
- Frontend: hash routing, protected routes, optimistic seat updates with rollback, polling every 10 seconds.

## How to run
Requires Node.js 22.5 or newer (built-in SQLite).
```
npm install
cp .env.example .env     (Windows: copy .env.example .env) - then change JWT_SECRET
npm run seed             # creates gym.db with test data
npm start
```
Open http://localhost:3000

## Deploy to Vercel

### Option 1: Import via Git (GitHub / GitLab / Bitbucket)
1. Push this repository to GitHub.
2. Go to [vercel.com/new](https://vercel.com/new) and import the repository.
3. In **Environment Variables**, set:
   - `JWT_SECRET`: Any random string (e.g. generated via `openssl rand -hex 32`)
4. Click **Deploy**.

### Option 2: Deploy using Vercel CLI
```bash
npm install -g vercel
vercel
```
Follow the interactive prompts, then set the production environment variable if prompted:
```bash
vercel env add JWT_SECRET
vercel --prod
```

> **Note on SQLite on Vercel:**  
> Vercel Serverless Functions use an ephemeral filesystem where `/tmp` is the writable directory. On first invocation on a serverless container, the application automatically initializes the database schema and seeds the default admin and member accounts. For long-term persistent production storage across distributed lambdas, a hosted database (such as Turso/libSQL or Postgres) can be connected.

## Test logins
| Role   | Email          | Password   |
|--------|----------------|------------|
| Admin  | admin@gym.com  | admin123   |
| Member | alice@gym.com  | member123  |
| Member | bob@gym.com    | member123  |

Tomorrow at 10:00 is a **full** session (try joining its waitlist as Alice, then cancel a filler booking in the DB/API to see promotion).
Check-in only works during the session's hour, so to try it create a session for the current hour as admin (date today, hour now), book it as a member, and enter the code on the Admin page.
The admin account is created by the seed script (directly in the database), never through registration.

## Making another admin
Register normally on the website, then run `npm run make-admin -- someone@example.com`.
(Running `npm run seed` again wipes all users and recreates the defaults.)

## Assumptions
- Times use the server's local timezone.
- Capacity is fixed at 20 per session.
- Admins cannot book sessions (they can, but it is not a feature); admins can't be created via the API.
- Checking in is allowed only from the start of the session hour until the hour ends.
- Seats update by polling every 10 seconds.
- A cancelled booking keeps its row (status = cancelled) so history is kept; its code no longer works.
