// Drops everything in the public schema and reloads schema, benchmark seed and demo snacks. DEV ONLY.
require('dotenv').config();
const fs = require('fs'), path = require('path'), { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['schema.sql', 'seed.sql', 'snack-products.sql']) await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
  await c.end();
  console.log('Database reset: schema + benchmark seed + demo snacks loaded.');
})().catch(e => { console.error(e.message); process.exit(1); });
