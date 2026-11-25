const { q } = require('../db');
const { HttpError, csv } = require('../http');
const D = (col) => `($1::date IS NULL OR ${col} >= $1) AND ($2::date IS NULL OR ${col} <= $2)`;
const REPORTS = {
  'sales-register': `SELECT * FROM v_sales_register WHERE ${D('invoice_date')} ORDER BY invoice_date, invoice_no`,
  'customer-sales': `SELECT customer_name, COUNT(*) invoices, SUM(taxable_paise) taxable_paise, SUM(total_paise) total_paise FROM invoices WHERE status='posted' AND ${D('invoice_date')} GROUP BY customer_name ORDER BY 4 DESC`,
  'product-sales': `SELECT l.description product, SUM(l.qty) qty, SUM(l.taxable_paise) taxable_paise FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE i.status='posted' AND ${D('i.invoice_date')} GROUP BY l.description ORDER BY 3 DESC`,
  'gst-summary': `SELECT * FROM v_gst_summary WHERE ${D('month')} ORDER BY month, place_of_supply`,
  'purchase-register': `SELECT p.bill_date, p.bill_no, s.name supplier, i.name item, l.qty, l.unit_code, l.rate_paise, l.value_paise FROM purchases p JOIN suppliers s ON s.id=p.supplier_id JOIN purchase_lines l ON l.purchase_id=p.id JOIN items i ON i.id=l.item_id WHERE p.status='posted' AND ${D('p.bill_date')} ORDER BY p.bill_date, p.id`,
  'stock-summary': `SELECT sku, name, type, base_unit, qty, value_paise, avg_cost_paise FROM v_stock_balance WHERE $1::date IS NULL AND $2::date IS NULL ORDER BY item_id`,
  'stock-ledger': `SELECT move_date, sku, name, move, qty_delta, value_delta, src_table, src_id, running_qty FROM v_stock_ledger WHERE ${D('move_date')} ORDER BY id`,
  'production-variance': `SELECT v.run_no, r.run_date, v.name, v.planned_qty, v.actual_qty, v.variance_bp, v.flagged FROM v_production_variance v JOIN production_runs r ON r.id=v.run_id WHERE ${D('r.run_date')} ORDER BY v.run_id`,
  'collections': `SELECT p.paid_on, c.name customer, p.mode, p.reference, p.amount_paise FROM payments p JOIN customers c ON c.id=p.customer_id WHERE ${D('p.paid_on')} ORDER BY p.paid_on`,
  'receivable-ageing': `SELECT * FROM v_receivable_ageing WHERE $1::date IS NULL AND $2::date IS NULL ORDER BY total DESC`
};
module.exports = route => {
  route('get', '/reports/:name', ['auditor', 'owner', 'admin'], async (req, res) => {
    const sql = REPORTS[req.params.name];
    if (!sql) throw new HttpError(404, 'NO_SUCH_REPORT', 'Unknown report');
    const rows = await q(sql, [req.query.from || null, req.query.to || null]);
    const f = req.query.format || 'json';
    if (f === 'csv') { res.type('text/csv').set('Content-Disposition', `attachment; filename="${req.params.name}.csv"`); return res.send(csv(rows)); }
    if (f !== 'json') throw new HttpError(501, 'FORMAT_NOT_BUILT', `${f} export is not built yet; use csv (opens in Excel) or json`);
    res.json({ report: req.params.name, rows, count: rows.length });
  });
  route('get', '/dashboard', ['admin', 'production', 'owner'], async (req, res) => {
    const r = req.user.role, d = {};
    const one = async s => (await q(s))[0];
    if (r !== 'production') {
      d.orders_to_verify = (await one(`SELECT COUNT(*)::int n FROM orders WHERE status='submitted'`)).n;
      d.receivables_paise = (await one('SELECT COALESCE(SUM(outstanding_paise),0)::bigint v FROM v_invoice_outstanding')).v;
    }
    d.finished_goods = await q(`SELECT name, qty FROM v_stock_balance WHERE type='finished'`);
    d.variance_alerts = (await one('SELECT COUNT(*)::int n FROM v_production_variance WHERE flagged')).n;
    if (r !== 'admin') {
      d.low_stock = await q('SELECT i.name, b.qty, i.reorder_level FROM items i JOIN v_stock_balance b ON b.item_id=i.id WHERE i.reorder_level IS NOT NULL AND b.qty < i.reorder_level');
      d.latest_cost = (await q('SELECT run_no, product, cost_per_unit_paise, sell_price_paise FROM v_run_costing ORDER BY run_id DESC LIMIT 1'))[0] ?? null;
    }
    if (r === 'owner') {
      const month = (await q(`WITH periods AS (
        SELECT (date_trunc('month', CURRENT_DATE) - interval '1 month')::date AS previous_start,
               date_trunc('month', CURRENT_DATE)::date AS current_start
      )
      SELECT to_char(previous_start, 'FMMonth YYYY') AS previous_label,
             to_char(current_start, 'FMMonth YYYY') || ' (to date)' AS current_label,
             COALESCE((SELECT SUM(i.taxable_paise) FROM invoices i WHERE i.status='posted' AND i.invoice_date >= p.previous_start AND i.invoice_date < p.current_start), 0)::bigint AS previous_sales_paise,
             COALESCE((SELECT SUM(i.cgst_paise + i.sgst_paise + i.igst_paise) FROM invoices i WHERE i.status='posted' AND i.invoice_date >= p.previous_start AND i.invoice_date < p.current_start), 0)::bigint AS previous_gst_paise,
             COALESCE((SELECT SUM(pay.amount_paise) FROM payments pay WHERE pay.paid_on >= p.previous_start AND pay.paid_on < p.current_start), 0)::bigint AS previous_collections_paise,
             COALESCE((SELECT SUM(i.taxable_paise) FROM invoices i WHERE i.status='posted' AND i.invoice_date >= p.current_start AND i.invoice_date <= CURRENT_DATE), 0)::bigint AS current_sales_paise,
             COALESCE((SELECT SUM(i.cgst_paise + i.sgst_paise + i.igst_paise) FROM invoices i WHERE i.status='posted' AND i.invoice_date >= p.current_start AND i.invoice_date <= CURRENT_DATE), 0)::bigint AS current_gst_paise,
             COALESCE((SELECT SUM(pay.amount_paise) FROM payments pay WHERE pay.paid_on >= p.current_start AND pay.paid_on <= CURRENT_DATE), 0)::bigint AS current_collections_paise
      FROM periods p`))[0];
      d.monthly_comparison = {
        periods: [month.previous_label, month.current_label],
        metrics: [
          { key: 'sales', label: 'Sales before GST', values: [month.previous_sales_paise, month.current_sales_paise] },
          { key: 'gst', label: 'GST on invoices', values: [month.previous_gst_paise, month.current_gst_paise] },
          { key: 'collections', label: 'Payments received', values: [month.previous_collections_paise, month.current_collections_paise] }
        ]
      };
    }
    res.json(d);
  });
  route('get', '/audit-log', ['auditor', 'owner', 'admin'], async (req, res) =>
    res.json(await q(`SELECT a.at, a.user_id, u.username, a.entity, a.entity_id, a.action, a.before, a.after FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
      WHERE ($1::text IS NULL OR a.entity=$1) AND ($2::bigint IS NULL OR a.entity_id=$2) ORDER BY a.id DESC LIMIT 200`, [req.query.entity || null, req.query.entity_id || null])));
};
