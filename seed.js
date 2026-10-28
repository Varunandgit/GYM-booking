// Fills the database with test data. Run: npm run seed
const db = require('./db');
const seedData = require('./seed-data');

seedData(db);
