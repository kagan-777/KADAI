const { q, tx } = require('../db');
const { HttpError, need, pos } = require('../http');
const ALL = ['production', 'admin', 'auditor', 'owner'];
module.exports = route => {
  route('get', '/purchases', ['production', 'admin', 'auditor'], async (req, res) =>
    res.json(await q(`SELECT p.id, p.supplier_id, s.name supplier_name, p.bill_no, p.bill_date, p.status,
      COALESCE(SUM(round(l.qty*l.rate_paise)),0)::bigint total_paise FROM purchases p JOIN suppliers s ON s.id=p.supplier_id
      LEFT JOIN purchase_lines l ON l.purchase_id=p.id WHERE ($1::date IS NULL OR p.bill_date>=$1) AND ($2::date IS NULL OR p.bill_date<=$2)
      GROUP BY p.id, s.name ORDER BY p.id DESC`, [req.query.from || null, req.query.to || null])));
  route('post', '/purchases', ['production'], async (req, res) => {
    need(req.body, ['supplier_id', 'lines']);
    const b = req.body;
    if (!Array.isArray(b.lines) || !b.lines.length) throw new HttpError(400, 'VALIDATION', 'Add at least one line');
    const p = await tx(req.user, async c => {
      const h = (await c.query('INSERT INTO purchases(supplier_id, bill_no, bill_date, created_by) VALUES($1,$2,COALESCE($3, current_date),$4) RETURNING *', [b.supplier_id, b.bill_no, b.bill_date, req.user.id])).rows[0];
      for (const l of b.lines) {
        need(l, ['item_id', 'qty', 'unit_code', 'rate_paise']); pos(l.qty, 'qty');
        const it = (await c.query('SELECT type FROM items WHERE id=$1', [l.item_id])).rows[0];
        if (!it || it.type === 'finished') throw new HttpError(422, 'NOT_PURCHASABLE', `Item ${l.item_id} is not a raw or packaging item`);
        await c.query('INSERT INTO purchase_lines(purchase_id,item_id,qty,unit_code,rate_paise) VALUES($1,$2,$3,$4,$5)', [h.id, l.item_id, l.qty, l.unit_code, l.rate_paise]);
      }
      return h;
    });
    res.status(201).json(p);
  });
  route('post', '/purchases/:id/post', ['production'], async (req, res) => {
    const p = await tx(req.user, async c => { await c.query('SELECT post_purchase($1)', [req.params.id]); return (await c.query('SELECT * FROM purchases WHERE id=$1', [req.params.id])).rows[0]; });
    res.json(p);
  });
  route('get', '/stock/balances', ALL, async (req, res) =>
    res.json(await q('SELECT item_id, sku, name, type, base_unit, qty, value_paise, avg_cost_paise FROM v_stock_balance WHERE ($1::item_type IS NULL OR type=$1) ORDER BY item_id', [req.query.type || null])));
  route('get', '/stock/ledger', ALL, async (req, res) =>
    res.json(await q(`SELECT id, move_date, item_id, sku, name, move, qty_delta, value_delta, src_table, src_id, narration, running_qty FROM v_stock_ledger
      WHERE ($1::bigint IS NULL OR item_id=$1) AND ($2::date IS NULL OR move_date>=$2) AND ($3::date IS NULL OR move_date<=$3) ORDER BY id DESC LIMIT 1000`,
      [req.query.item_id || null, req.query.from || null, req.query.to || null])));
  route('post', '/stock/adjustments', ['production'], async (req, res) => {
    need(req.body, ['item_id', 'qty_delta', 'reason']);
    const { item_id, qty_delta, reason } = req.body;
    if (!Number(qty_delta)) throw new HttpError(400, 'VALIDATION', 'qty_delta cannot be 0');
    const row = await tx(req.user, async c => (await c.query(`INSERT INTO stock_ledger(item_id, move, qty_delta, value_delta, src_table, narration, posted_by)
      VALUES($1,'adjustment',$2, round(avg_cost($1) * $2), 'adjustments', $3, $4) RETURNING *`, [item_id, qty_delta, reason, req.user.id])).rows[0]);
    res.status(201).json(row);
  });
};
