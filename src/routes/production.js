const { q, tx } = require('../db');
const { HttpError, need, pos } = require('../http');
const READ = ['production', 'admin', 'auditor', 'owner'];

const getRun = async (id, db) => {
  const run = db ? (t, p) => db.query(t, p).then(r => r.rows) : q;
  const [r] = await run('SELECT r.*, i.name product_name FROM production_runs r JOIN items i ON i.id=r.product_id WHERE r.id=$1', [id]);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'Production run not found');
  r.issues = await run('SELECT pi.item_id, it.name, pi.planned_qty, pi.actual_qty, pi.wastage_qty, pi.value_paise FROM production_issues pi JOIN items it ON it.id=pi.item_id WHERE pi.run_id=$1 ORDER BY pi.id', [id]);
  r.overheads = await run('SELECT kind, amount_paise, created_at FROM production_overheads WHERE run_id=$1 ORDER BY id', [id]);
  return r;
};

module.exports = route => {
  route('get', '/boms', READ, async (req, res) =>
    res.json(await q(`SELECT b.id, b.product_id, p.name product_name, b.version, b.yield_qty, b.active,
      COALESCE(json_agg(json_build_object('item_id', l.item_id, 'name', i.name, 'qty', l.qty) ORDER BY l.item_id), '[]') lines
      FROM boms b JOIN items p ON p.id=b.product_id LEFT JOIN bom_lines l ON l.bom_id=b.id LEFT JOIN items i ON i.id=l.item_id GROUP BY b.id, p.name ORDER BY b.id`)));
  route('post', '/boms', ['production'], async (req, res) => {
    need(req.body, ['product_id', 'yield_qty', 'lines']);
    const { product_id, yield_qty, lines } = req.body;
    pos(yield_qty, 'yield_qty');
    if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, 'VALIDATION', 'A BOM needs at least one line');
    const id = await tx(req.user, async c => {
      await c.query('UPDATE boms SET active=false WHERE product_id=$1', [product_id]);
      const v = (await c.query('SELECT COALESCE(MAX(version),0)+1 v FROM boms WHERE product_id=$1', [product_id])).rows[0].v;
      const b = (await c.query('INSERT INTO boms(product_id, version, yield_qty) VALUES($1,$2,$3) RETURNING id', [product_id, v, yield_qty])).rows[0];
      for (const l of lines) {
        need(l, ['item_id', 'qty']);
        const qty = (await c.query('SELECT to_base_qty($1,$2,$3) q', [l.item_id, l.qty, l.unit || (await c.query('SELECT base_unit FROM items WHERE id=$1', [l.item_id])).rows[0]?.base_unit])).rows[0].q;
        await c.query('INSERT INTO bom_lines(bom_id,item_id,qty) VALUES($1,$2,$3)', [b.id, l.item_id, qty]);
      }
      return b.id;
    });
    res.status(201).json((await q(`SELECT b.*, (SELECT json_agg(json_build_object('item_id',item_id,'qty',qty)) FROM bom_lines WHERE bom_id=b.id) lines FROM boms b WHERE id=$1`, [id]))[0]);
  });
  route('get', '/production-runs', READ, async (req, res) =>
    res.json(await q(`SELECT r.id, r.run_no, r.run_date, i.name product_name, r.batches, r.expected_output, r.actual_output, r.status
      FROM production_runs r JOIN items i ON i.id=r.product_id WHERE ($1::date IS NULL OR r.run_date>=$1) AND ($2::date IS NULL OR r.run_date<=$2) ORDER BY r.id DESC`, [req.query.from || null, req.query.to || null])));
  route('post', '/production-runs', ['production'], async (req, res) => {
    need(req.body, ['bom_id', 'batches']);
    const { bom_id, batches, run_date, batch_no, expiry_date } = req.body;
    pos(batches, 'batches');
    const id = await tx(req.user, async c => {
      const b = (await c.query('SELECT * FROM boms WHERE id=$1 AND active', [bom_id])).rows[0];
      if (!b) throw new HttpError(422, 'NO_ACTIVE_BOM', 'BOM not found or not active');
      let batchId = null;
      if (batch_no) batchId = (await c.query('INSERT INTO stock_batches(item_id, batch_no, mfg_date, expiry_date) VALUES($1,$2,COALESCE($3,current_date),$4) RETURNING id', [b.product_id, batch_no, run_date, expiry_date])).rows[0].id;
      const r = (await c.query('INSERT INTO production_runs(run_no, bom_id, product_id, run_date, batches, expected_output, batch_id, supervisor_id) VALUES(gen_random_uuid()::text,$1,$2,COALESCE($3,current_date),$4,$5,$6,$7) RETURNING id',
        [bom_id, b.product_id, run_date, batches, b.yield_qty * batches, batchId, req.user.id])).rows[0];
      await c.query("UPDATE production_runs SET run_no = 'B-' || lpad(id::text, 3, '0') WHERE id=$1", [r.id]);
      await c.query('INSERT INTO production_issues(run_id,item_id,planned_qty,actual_qty) SELECT $1, item_id, qty*$2, qty*$2 FROM bom_lines WHERE bom_id=$3', [r.id, batches, bom_id]);
      return r.id;
    });
    res.status(201).json(await getRun(id));
  });
  route('get', '/production-runs/:id', READ, async (req, res) => res.json(await getRun(+req.params.id)));
  route('put', '/production-runs/:id/issues', ['production'], async (req, res) => {
    need(req.body, ['actual_output', 'issues']);
    const id = +req.params.id;
    if (Number(req.body.actual_output) < 0) throw new HttpError(400, 'VALIDATION', 'actual_output cannot be negative');
    await tx(req.user, async c => {
      const r = (await c.query('SELECT status FROM production_runs WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new HttpError(404, 'NOT_FOUND', 'Production run not found');
      if (r.status !== 'draft') throw new HttpError(409, 'ALREADY_POSTED', 'Posted runs are locked');
      for (const i of req.body.issues) {
        need(i, ['item_id', 'actual_qty']);
        const base = (await c.query('SELECT to_base_qty($1,$2, COALESCE($3, (SELECT base_unit FROM items WHERE id=$1))) q', [i.item_id, i.actual_qty, i.unit ?? null])).rows[0].q;
        const u = await c.query('UPDATE production_issues SET actual_qty=$3, wastage_qty=COALESCE($4,0) WHERE run_id=$1 AND item_id=$2', [id, i.item_id, base, i.wastage_qty ?? 0]);
        if (!u.rowCount) throw new HttpError(422, 'NOT_IN_BOM', `Item ${i.item_id} is not part of this run`);
      }
      await c.query('UPDATE production_runs SET actual_output=$2 WHERE id=$1', [id, req.body.actual_output]);
    });
    res.json(await getRun(id));
  });
  route('post', '/production-runs/:id/post', ['production'], async (req, res) => {
    const r = await tx(req.user, async c => { await c.query('SELECT post_production_run($1)', [req.params.id]); return getRun(+req.params.id, c); });
    res.json(r);
  });
  route('post', '/production-runs/:id/overheads', ['production'], async (req, res) => {
    need(req.body, ['kind', 'amount_paise']);
    pos(req.body.amount_paise, 'amount_paise');
    const r = await tx(req.user, async c => { await c.query('SELECT add_overhead($1,$2,$3)', [req.params.id, req.body.kind, req.body.amount_paise]); return getRun(+req.params.id, c); });
    res.status(201).json(r);
  });
  route('get', '/production-runs/:id/variance', READ, async (req, res) =>
    res.json(await q('SELECT name, planned_qty, actual_qty, variance_bp, flagged FROM v_production_variance WHERE run_id=$1', [req.params.id])));
  route('get', '/production-runs/:id/costing', READ, async (req, res) => {
    const [c] = await q('SELECT * FROM v_run_costing WHERE run_id=$1', [req.params.id]);
    if (!c) throw new HttpError(404, 'NOT_FOUND', 'Costing is available once the run is posted');
    res.json({ ...c, margin_paise: c.sell_price_paise == null ? null : c.sell_price_paise - c.cost_per_unit_paise });
  });
};
