const { Pool, types } = require('pg');
types.setTypeParser(20, v => parseInt(v, 10));      // bigint (ids, paise) -> number
types.setTypeParser(1700, v => parseFloat(v));      // numeric (quantities) -> number
types.setTypeParser(1082, v => v);                  // date -> 'YYYY-MM-DD'
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, params) => pool.query(text, params).then(r => r.rows);

// One transaction per request. Sets app.user_id so the audit trigger knows who acted.
async function tx(user, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (user) await c.query("SELECT set_config('app.user_id', $1, true)", [String(user.id)]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}
module.exports = { pool, q, tx };
