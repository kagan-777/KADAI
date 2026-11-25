const PDFDocument = require('pdfkit');
const { q, tx } = require('../db');
const { HttpError, need, pos } = require('../http');
const rs = p => 'Rs ' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });

const ORDER_SQL = `SELECT o.id, o.order_no, o.customer_id, c.name customer_name, o.salesman_id, o.status, o.notes, o.reject_reason, o.created_at,
  COALESCE(json_agg(json_build_object('item_id', l.item_id, 'name', i.name, 'qty', l.qty, 'rate_paise', l.rate_paise) ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL), '[]') lines,
  COALESCE(SUM(round(l.qty * l.rate_paise)), 0)::bigint total_paise
  FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN order_lines l ON l.order_id = o.id LEFT JOIN items i ON i.id = l.item_id`;
const getOrder = async (id, user, db = { query: (t, p) => q(t, p).then(rows => ({ rows })) }) => {
  const r = await db.query(`${ORDER_SQL} WHERE o.id = $1 ${user?.role === 'salesman' ? 'AND o.salesman_id = $2' : ''} GROUP BY o.id, c.name`, user?.role === 'salesman' ? [id, user.id] : [id]);
  if (!r.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
  return r.rows[0];
};
const getInvoice = async (id, db) => {
  const run = db ? (t, p) => db.query(t, p).then(r => r.rows) : q;
  const [inv] = await run('SELECT * FROM invoices WHERE id=$1', [id]);
  if (!inv) throw new HttpError(404, 'NOT_FOUND', 'Invoice not found');
  inv.lines = await run('SELECT description, hsn, qty, rate_paise, taxable_paise, gst_bp, cgst_paise, sgst_paise, igst_paise FROM invoice_lines WHERE invoice_id=$1 ORDER BY id', [id]);
  return inv;
};
const range = '($1::date IS NULL OR %s >= $1) AND ($2::date IS NULL OR %s <= $2)';

module.exports = route => {
  route('get', '/orders', ['salesman', 'admin', 'auditor', 'owner'], async (req, res) => {
    const sales = req.user.role === 'salesman', p = [req.query.from || null, req.query.to || null];
    if (sales) p.push(req.user.id);
    res.json(await q(`${ORDER_SQL} WHERE ${range.replace(/%s/g, 'o.created_at::date')} ${sales ? 'AND o.salesman_id=$3' : ''} GROUP BY o.id, c.name ORDER BY o.id DESC`, p));
  });
  route('post', '/orders', ['salesman'], async (req, res) => {
    need(req.body, ['customer_id', 'lines']);
    const { client_uuid, customer_id, notes, lines } = req.body;
    if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, 'VALIDATION', 'Add at least one product');
    const id = await tx(req.user, async c => {
      if (client_uuid) { const ex = await c.query('SELECT id FROM orders WHERE client_uuid=$1 AND salesman_id=$2', [client_uuid, req.user.id]); if (ex.rows[0]) return ex.rows[0].id; }   // offline retry
      const own = await c.query('SELECT 1 FROM customers WHERE id=$1 AND salesman_id=$2 AND active', [customer_id, req.user.id]);
      if (!own.rows[0]) throw new HttpError(403, 'NOT_YOUR_CUSTOMER', 'You can only order for your own customers');
      const o = (await c.query('INSERT INTO orders(customer_id, salesman_id, notes, client_uuid) VALUES($1,$2,$3,$4) RETURNING id', [customer_id, req.user.id, notes, client_uuid])).rows[0];
      await c.query("UPDATE orders SET order_no = 'SO-' || id WHERE id=$1", [o.id]);
      for (const l of lines) {
        need(l, ['item_id', 'qty']); pos(l.qty, 'qty');
        const pr = (await c.query(`SELECT COALESCE(cp.rate_paise, i.sell_price_paise) rate FROM items i LEFT JOIN customer_prices cp ON cp.item_id=i.id AND cp.customer_id=$2 WHERE i.id=$1 AND i.type='finished' AND i.active`, [l.item_id, customer_id])).rows[0];
        if (!pr || pr.rate == null) throw new HttpError(422, 'NOT_SELLABLE', `Item ${l.item_id} cannot be ordered`);
        await c.query('INSERT INTO order_lines(order_id,item_id,qty,rate_paise) VALUES($1,$2,$3,$4)', [o.id, l.item_id, l.qty, pr.rate]);
      }
      return o.id;
    });
    res.status(201).json(await getOrder(id, req.user));
  });
  route('get', '/orders/:id', ['salesman', 'admin'], async (req, res) => res.json(await getOrder(+req.params.id, req.user)));
  route('patch', '/orders/:id', ['admin'], async (req, res) => {
    const id = +req.params.id;
    await tx(req.user, async c => {
      const o = (await c.query('SELECT status FROM orders WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!o) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
      if (o.status !== 'submitted') throw new HttpError(409, 'INVALID_STATE', 'Only submitted orders can be edited');
      for (const l of req.body.lines || []) {
        need(l, ['item_id']);
        if (l.qty !== undefined) pos(l.qty, 'qty');
        const r = await c.query('UPDATE order_lines SET qty=COALESCE($3,qty), rate_paise=COALESCE($4,rate_paise) WHERE order_id=$1 AND item_id=$2', [id, l.item_id, l.qty ?? null, l.rate_paise ?? null]);
        if (!r.rowCount) throw new HttpError(422, 'NO_SUCH_LINE', `Item ${l.item_id} is not on this order`);
      }
    });
    res.json(await getOrder(id));
  });
  route('get', '/orders/:id/stock-check', ['admin'], async (req, res) =>
    res.json(await q('SELECT item_id, name, ordered, available, shortage FROM v_order_stock_check WHERE order_id=$1', [req.params.id])));
  const decide = (status, needReason) => async (req, res) => {
    if (needReason) need(req.body, ['reason']);
    const id = +req.params.id;
    await tx(req.user, async c => {
      const r = await c.query(`UPDATE orders SET status=$2, decided_by=$3, decided_at=now(), reject_reason=$4 WHERE id=$1 AND status='submitted' RETURNING id`, [id, status, req.user.id, req.body?.reason ?? null]);
      if (!r.rows[0]) throw new HttpError(409, 'INVALID_STATE', 'Only a submitted order can be approved or rejected');
    });
    res.json(await getOrder(id));
  };
  route('post', '/orders/:id/approve', ['admin'], decide('approved', false));
  route('post', '/orders/:id/reject', ['admin'], decide('rejected', true));
  route('post', '/orders/:id/invoice', ['admin'], async (req, res) => {
    const inv = await tx(req.user, async c => getInvoice((await c.query('SELECT create_invoice_from_order($1) id', [req.params.id])).rows[0].id, c));
    res.status(201).json(inv);
  });
  route('get', '/invoices', ['admin', 'auditor', 'owner'], async (req, res) =>
    res.json(await q(`SELECT * FROM invoices WHERE ${range.replace(/%s/g, 'invoice_date')} ORDER BY id DESC`, [req.query.from || null, req.query.to || null])));
  route('get', '/invoices/:id', ['admin', 'auditor', 'owner'], async (req, res) => res.json(await getInvoice(+req.params.id)));
  route('get', '/invoices/:id/pdf', ['admin', 'auditor'], async (req, res) => {
    const inv = await getInvoice(+req.params.id);
    const [co] = await q('SELECT name, gstin, address FROM company_settings');
    const d = new PDFDocument({ margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${inv.invoice_no.replace(/\//g, '-')}.pdf"`);
    d.pipe(res);
    d.fontSize(16).text(co.name).fontSize(9).text(`GSTIN: ${co.gstin || '-'}   ${co.address || ''}`).moveDown();
    d.fontSize(14).text(inv.status === 'cancelled' ? 'TAX INVOICE (CANCELLED)' : 'TAX INVOICE').fontSize(10)
      .text(`No: ${inv.invoice_no}    Date: ${inv.invoice_date}`).text(`Bill to: ${inv.customer_name}   GSTIN: ${inv.customer_gstin || '-'}`)
      .text(`Place of supply: ${inv.place_of_supply} (${inv.is_interstate ? 'IGST' : 'CGST + SGST'})`).moveDown();
    inv.lines.forEach(l => d.text(`${l.description}  HSN ${l.hsn || '-'}  Qty ${l.qty}  Rate ${rs(l.rate_paise)}  GST ${l.gst_bp / 100}%  Taxable ${rs(l.taxable_paise)}`));
    d.moveDown().text(`Taxable value: ${rs(inv.taxable_paise)}`);
    if (inv.is_interstate) d.text(`IGST: ${rs(inv.igst_paise)}`); else d.text(`CGST: ${rs(inv.cgst_paise)}`).text(`SGST: ${rs(inv.sgst_paise)}`);
    d.fontSize(13).text(`Total: ${rs(inv.total_paise)}`).end();
  });
  route('post', '/invoices/:id/dispatch', ['admin'], async (req, res) => {
    const d = await tx(req.user, async c => {
      const id = (await c.query('SELECT post_dispatch($1, $2) id', [req.params.id, req.body?.notes ?? null])).rows[0].id;
      return (await c.query('SELECT * FROM dispatches WHERE id=$1', [id])).rows[0];
    });
    res.status(201).json(d);
  });
  route('post', '/invoices/:id/cancel', ['admin'], async (req, res) => {
    need(req.body, ['reason']);
    const n = await tx(req.user, async c => {
      const id = (await c.query('SELECT cancel_invoice($1, $2) id', [req.params.id, req.body.reason])).rows[0].id;
      return (await c.query('SELECT * FROM credit_notes WHERE id=$1', [id])).rows[0];
    });
    res.json(n);
  });
  route('get', '/payments', ['admin', 'auditor', 'owner'], async (req, res) =>
    res.json(await q(`SELECT p.*, c.name customer_name FROM payments p JOIN customers c ON c.id=p.customer_id WHERE ${range.replace(/%s/g, 'p.paid_on')} ORDER BY p.id DESC`, [req.query.from || null, req.query.to || null])));
  route('post', '/payments', ['admin'], async (req, res) => {
    need(req.body, ['customer_id', 'amount_paise', 'mode']);
    const { customer_id, amount_paise, mode, reference, allocations = [] } = req.body;
    pos(amount_paise, 'amount_paise');
    const p = await tx(req.user, async c => {
      const pay = (await c.query('INSERT INTO payments(customer_id, amount_paise, mode, reference, recorded_by) VALUES($1,$2,$3,$4,$5) RETURNING *', [customer_id, amount_paise, mode, reference, req.user.id])).rows[0];
      for (const a of allocations) {
        const ok = await c.query(`SELECT 1 FROM invoices WHERE id=$1 AND customer_id=$2 AND status='posted'`, [a.invoice_id, customer_id]);
        if (!ok.rows[0]) throw new HttpError(422, 'BAD_ALLOCATION', `Invoice ${a.invoice_id} is not an open invoice of this customer`);
        await c.query('INSERT INTO payment_allocations(payment_id, invoice_id, amount_paise) VALUES($1,$2,$3)', [pay.id, a.invoice_id, pos(a.amount_paise, 'allocation amount')]);
      }
      return pay;
    });
    res.status(201).json(p);
  });
};
