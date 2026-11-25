const { q, tx } = require('../db');
const { HttpError, need } = require('../http');
const ALL = ['salesman', 'admin', 'production', 'auditor', 'owner'];
function patchSql(table, allowed, body, id) {
  const keys = Object.keys(body).filter(k => allowed.includes(k));
  if (!keys.length) throw new HttpError(400, 'VALIDATION', 'Nothing to update');
  return [`UPDATE ${table} SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')} WHERE id=$${keys.length + 1} RETURNING *`, [...keys.map(k => body[k]), id]];
}
module.exports = route => {
  route('get', '/customers', ['salesman', 'admin'], async (req, res) => {
    const sales = req.user.role === 'salesman';
    res.json(await q(`SELECT id,name,kind,gstin,address,state_code,credit_days,salesman_id FROM customers WHERE active ${sales ? 'AND salesman_id=$1' : ''} ORDER BY name`, sales ? [req.user.id] : []));
  });
  route('post', '/customers', ['admin'], async (req, res) => {
    need(req.body, ['name', 'kind', 'state_code']);
    const b = req.body;
    const [c] = await tx(req.user, async c => (await c.query('INSERT INTO customers(name,kind,gstin,address,state_code,credit_days,salesman_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [b.name, b.kind, b.gstin, b.address, b.state_code, b.credit_days ?? 0, b.salesman_id]).then(r => r.rows)));
    res.status(201).json(c);
  });
  route('patch', '/customers/:id', ['admin'], async (req, res) => {
    const [sql, p] = patchSql('customers', ['name', 'kind', 'gstin', 'address', 'state_code', 'credit_days', 'salesman_id', 'active'], req.body, +req.params.id);
    const r = await tx(req.user, c => c.query(sql, p));
    if (!r.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Customer not found');
    res.json(r.rows[0]);
  });
  route('get', '/customers/:id/prices', ['salesman', 'admin'], async (req, res) => {
    if (req.user.role === 'salesman' && !(await q('SELECT 1 FROM customers WHERE id=$1 AND salesman_id=$2', [req.params.id, req.user.id])).length) throw new HttpError(403, 'NOT_YOUR_CUSTOMER', 'Not your customer');
    res.json(await q(`SELECT i.id item_id, i.name, COALESCE(cp.rate_paise, i.sell_price_paise) rate_paise FROM items i LEFT JOIN customer_prices cp ON cp.item_id=i.id AND cp.customer_id=$1 WHERE i.type='finished' AND i.active`, [req.params.id]));
  });
  route('get', '/customers/:id/outstanding', ['admin', 'auditor', 'owner'], async (req, res) => {
    const invoices = await q('SELECT invoice_id, invoice_no, outstanding_paise, due_date FROM v_invoice_outstanding WHERE customer_id=$1 AND outstanding_paise>0 ORDER BY due_date', [req.params.id]);
    const [ageing] = await q('SELECT COALESCE(not_due,0) not_due, COALESCE(d1_30,0) d1_30, COALESCE(d31_60,0) d31_60, COALESCE(d60_plus,0) d60_plus, COALESCE(total,0) total FROM v_receivable_ageing WHERE customer_id=$1', [req.params.id]);
    res.json({ customer_id: +req.params.id, total_paise: ageing?.total ?? 0, ageing: ageing ?? { not_due: 0, d1_30: 0, d31_60: 0, d60_plus: 0 }, invoices });
  });
  route('get', '/items', ALL, async (req, res) => {
    res.json(await q('SELECT id,sku,name,type,base_unit,hsn,gst_rate_bp,sell_price_paise,reorder_level FROM items WHERE active AND ($1::item_type IS NULL OR type=$1) ORDER BY id', [req.query.type || null]));
  });
  route('post', '/items', ['admin', 'production'], async (req, res) => {
    need(req.body, ['sku', 'name', 'type', 'base_unit']);
    const b = req.body;
    const r = await tx(req.user, c => c.query('INSERT INTO items(sku,name,type,base_unit,hsn,gst_rate_bp,sell_price_paise,reorder_level) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [b.sku, b.name, b.type, b.base_unit, b.hsn, b.gst_rate_bp ?? 0, b.sell_price_paise, b.reorder_level]));
    res.status(201).json(r.rows[0]);
  });
  route('patch', '/items/:id', ['admin', 'production'], async (req, res) => {
    const [sql, p] = patchSql('items', ['name', 'hsn', 'gst_rate_bp', 'sell_price_paise', 'reorder_level', 'active'], req.body, +req.params.id);
    const r = await tx(req.user, c => c.query(sql, p));
    if (!r.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Item not found');
    res.json(r.rows[0]);
  });
  route('get', '/suppliers', ['admin', 'production', 'auditor'], async (req, res) => res.json(await q('SELECT id,name,gstin,phone FROM suppliers ORDER BY name')));
  route('post', '/suppliers', ['production'], async (req, res) => {
    need(req.body, ['name']);
    const r = await tx(req.user, c => c.query('INSERT INTO suppliers(name,gstin,phone) VALUES($1,$2,$3) RETURNING *', [req.body.name, req.body.gstin, req.body.phone]));
    res.status(201).json(r.rows[0]);
  });
};
