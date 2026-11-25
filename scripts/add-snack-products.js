require('dotenv').config();
const fs = require('fs'), path = require('path'), { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'snack-products.sql'), 'utf8'));
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
  console.log('Demo snack products, recipes, prices and starter stock added.');
})().catch(e => { console.error(e.message); process.exit(1); });
