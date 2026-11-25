// kadai frontend: plain JavaScript, talks to the Express API at /api/v1 (same origin, no CORS setup needed).
const API = '/api/v1';
const ROLES = { salesman: ['Salesman', 'Mobile order entry'], admin: ['Factory admin', 'Orders, GST, collections'], production: ['Production supervisor', 'Stock, BOM, batches'], auditor: ['Accountant / auditor', 'Read-only audit reports'], owner: ['Owner', 'Dashboard, view only'] };
const BADGE = { salesman: 'SALESMAN', admin: 'ADMIN / BILLING DESK', production: 'PRODUCTION SUPERVISOR', auditor: 'AUDITOR · READ-ONLY', owner: 'OWNER · VIEW ONLY' };
const LABEL = { 'new-order': 'New order', 'my-orders': 'My orders', overview: 'Overview', 'sales-orders': 'Sales orders', inventory: 'Inventory', collections: 'Collections', production: 'Production', purchases: 'Purchases', 'monthly-audit': 'Monthly audit', 'stock-ledger': 'Stock ledger' };
const REPORTS = ['sales-register', 'customer-sales', 'product-sales', 'gst-summary', 'purchase-register', 'stock-summary', 'stock-ledger', 'production-variance', 'collections', 'receivable-ageing', 'audit-log'];
const THEMES = [
  ['system', 'System default'],
  ['mint-teal', 'Mint Green · Teal Blue'],
  ['black-scallop', 'Black · Scallop'],
  ['desert-blue', 'Desert Sun · Dark Blue'],
  ['sun-navy', 'Sunshine · Navy']
];
const THEME_IDS = new Set(THEMES.map(([id]) => id));

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rs = p => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 });
const toPaise = v => Math.round(parseFloat(v) * 100);
const tag = (t, bad) => `<span class="tag ${bad ? 'bad' : ''}">${esc(t)}</span>`;
const kpi = (l, v, s = '', c = '') => `<div class="card ${c}"><div class="eye">${l}</div><div class="kp">${v}</div><div style="font-size:11px;opacity:.8">${s}</div></div>`;
const card = (h, c = '') => `<div class="card ${c}">${h}</div>`;
const tb = (h, r) => `<div class="tw"><table><tr>${h.map(x => `<th>${x}</th>`).join('')}</tr>${r.map(x => `<tr>${x.map(c => `<td>${c}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${h.length}">Nothing yet.</td></tr>`}</table></div>`;
const ownerComparison = comparison => {
  const metrics = comparison.metrics || [];
  if (!metrics.length) return '';
  const colors = { sales: '#28845B', gst: '#D69E2E', collections: '#5877D4' };
  const values = metrics.flatMap(m => m.values.map(Number));
  const max = Math.max(1, ...values), x = [150, 470], y = value => 180 - Number(value) / max * 145;
  const grid = [1, 0.5, 0].map(ratio => {
    const py = y(max * ratio);
    return `<line x1="95" y1="${py}" x2="525" y2="${py}" class="chart-grid"/><text x="86" y="${py + 4}" text-anchor="end" class="chart-label">${esc(rs(Math.round(max * ratio)))}</text>`;
  }).join('');
  const lines = metrics.map(m => {
    const color = colors[m.key] || '#667085', first = y(m.values[0]), second = y(m.values[1]);
    return `<line x1="${x[0]}" y1="${first}" x2="${x[1]}" y2="${second}" stroke="${color}" class="chart-line"/><circle cx="${x[0]}" cy="${first}" r="6" fill="${color}"/><circle cx="${x[1]}" cy="${second}" r="6" fill="${color}"/>`;
  }).join('');
  const change = (previous, current) => {
    const delta = Number(current) - Number(previous);
    if (!previous) return current ? `New (${rs(current)})` : `${rs(0)} (0%)`;
    const percent = (delta / Number(previous) * 100).toFixed(1);
    return `${delta > 0 ? '+' : delta < 0 ? '-' : ''}${rs(Math.abs(delta))} (${percent}%)`;
  };
  return card(`<h3>Month-over-month comparison</h3><p class="comparison-note">Previous full month compared with current month to date.</p>
    <svg class="owner-month-chart" viewBox="0 0 620 235" role="img" aria-label="Line chart comparing sales before GST, GST on invoices, and payments received">
      ${grid}${lines}<text x="${x[0]}" y="214" text-anchor="middle" class="chart-label">${esc(comparison.periods[0])}</text><text x="${x[1]}" y="214" text-anchor="middle" class="chart-label">${esc(comparison.periods[1])}</text>
    </svg>
    <div class="chart-legend">${metrics.map(m => `<span><i style="background:${colors[m.key] || '#667085'}"></i>${esc(m.label)}</span>`).join('')}</div>
    <h3 style="margin-top:18px">Monthly totals</h3>${tb(['Metric', esc(comparison.periods[0]), esc(comparison.periods[1]), 'Change'], metrics.map(m => [esc(m.label), rs(m.values[0]), rs(m.values[1]), esc(change(m.values[0], m.values[1]))]))}`);
};
const btn = (label, a, id, cls = '', extra = '') => `<button class="btn sm ${cls}" data-a="${a}" data-id="${id ?? ''}" ${extra}>${esc(label)}</button>`;
const head = (eye, title, sub = '') => `<div><div class="eye">${eye}</div><h1>${title}</h1>${sub ? `<p style="color:var(--mut);margin-top:4px">${sub}</p>` : ''}</div>`;
const opts = (rows, val, txt, sel) => rows.map(r => `<option value="${esc(r[val])}" ${String(r[val]) === String(sel) ? 'selected' : ''}>${esc(typeof txt === 'function' ? txt(r) : r[txt])}</option>`).join('');
const fmt = (k, v) => v == null ? '—' : /_paise$/.test(k) ? rs(v) : k === 'variance_bp' ? (v / 100).toFixed(1) + '%' : typeof v === 'boolean' ? (v ? tag('Yes / flagged', true) : '—') : typeof v === 'object' ? esc(JSON.stringify(v)).slice(0, 70) : esc(v);
const grid = rows => rows.length ? tb(Object.keys(rows[0]).map(k => esc(k.replace(/_/g, ' '))), rows.map(r => Object.keys(r).map(k => fmt(k, r[k])))) : '<p>No rows for this range.</p>';
const auditLabels = { id: 'Record ID', user_id: 'User ID', run_id: 'Production run ID', item_id: 'Item ID', customer_id: 'Customer ID', supplier_id: 'Supplier ID', amount_paise: 'Amount (₹)', total_paise: 'Total (₹)', taxable_paise: 'Taxable (₹)', cgst_paise: 'CGST (₹)', sgst_paise: 'SGST (₹)', igst_paise: 'IGST (₹)', rate_paise: 'Rate (₹)', value_paise: 'Value (₹)', gst_bp: 'GST rate (bp)', variance_bp: 'Variance (%)', is_interstate: 'Interstate' };
const auditFieldLabel = key => auditLabels[key] || key.replace(/_paise$/, ' (₹)').replace(/_bp$/, ' (bp)').replace(/_id$/, ' ID').replace(/_/g, ' ').replace(/\b[a-z]/g, c => c.toUpperCase());
const auditFieldValue = (key, value) => value == null ? '—' : /password|secret|token/i.test(key) ? 'Hidden' : /_paise$/.test(key) && typeof value === 'number' ? rs(value) : key === 'variance_bp' && typeof value === 'number' ? (value / 100).toFixed(1) + '%' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : typeof value === 'object' ? JSON.stringify(value) : String(value);
const auditDetails = (value, empty) => value == null ? `<span class="audit-empty">${esc(empty)}</span>` : typeof value !== 'object' ? esc(value) :
  `<dl class="audit-values">${Object.entries(value).map(([key, item]) => `<div><dt>${esc(auditFieldLabel(key))}</dt><dd>${esc(auditFieldValue(key, item))}</dd></div>`).join('')}</dl>`;
const auditGrid = rows => rows.length ? `<div class="audit-log-list">${rows.map(r => {
  const date = new Date(r.at), when = Number.isNaN(date.getTime()) ? r.at : date.toLocaleString();
  const action = ({ INSERT: 'Created', UPDATE: 'Updated', DELETE: 'Deleted' })[r.action] || r.action;
  return `<article class="audit-entry"><div class="audit-entry-head">${tag(action)}<strong>${esc((r.entity || '').replace(/_/g, ' '))}</strong><span>Record #${esc(r.entity_id ?? '—')}</span><span>By ${esc(r.username || '—')}</span><time>${esc(when)}</time></div><div class="audit-snapshots"><section class="audit-snapshot"><h4>Before · previous values</h4>${auditDetails(r.before, 'No previous record (created)')}</section><section class="audit-snapshot"><h4>After · saved values</h4>${auditDetails(r.after, 'No current record (deleted)')}</section></div></article>`;
}).join('')}</div>` : '<p>No rows for this range.</p>';

const savedTheme = localStorage.getItem('kadai_theme');
let S = { token: localStorage.getItem('kadai_token'), user: JSON.parse(localStorage.getItem('kadai_user') || 'null'), pick: 'salesman', msg: '', ok: '', err: '', run: null, inv: null, cust: null, custType: null, rep: 'sales-register', from: '', to: '', item: '', theme: THEME_IDS.has(savedTheme) ? savedTheme : 'system' };
let rid = 0;
function applyTheme() {
  if (S.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', S.theme);
}
const themeControl = () => `<div class="theme-control"><label for="theme-select">Color theme</label><select id="theme-select" data-change="theme" aria-label="Color theme">${THEMES.map(([id, name]) => `<option value="${id}" ${id === S.theme ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></div>`;
applyTheme();

async function api(method, path, body, raw) {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(S.token && { Authorization: 'Bearer ' + S.token }) }, body: body ? JSON.stringify(body) : undefined });
  if (raw && r.ok) return r;
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = {}; }
  if (!r.ok) { if (r.status === 401 && S.token) logout('Session expired. Please sign in again.'); const e = new Error(j.message || 'Request failed (' + r.status + ')'); e.status = r.status; e.code = j.code; throw e; }
  return j;
}
function logout(m = '') { S.token = null; S.user = null; S.cust = null; S.custType = null; localStorage.removeItem('kadai_token'); localStorage.removeItem('kadai_user'); S.err = m; location.hash = ''; render(); }
const go = r => { if (location.hash.slice(1) === r) render(); else location.hash = r; };

// ---- offline order queue (idempotent: each order carries a client_uuid) ----
const Q = () => JSON.parse(localStorage.getItem('kadai_q') || '[]');
async function flush() {
  const q = Q(); if (!q.length || !S.token || S.user.role !== 'salesman') return; const rest = [];
  for (const o of q) { try { await api('POST', '/orders', o); S.ok = 'Offline orders were sent to the factory.'; } catch (e) { if (!e.status) rest.push(o); } }
  localStorage.setItem('kadai_q', JSON.stringify(rest));
}
window.addEventListener('online', () => render());

// ---- views ----
const V = {
  async 'new-order'() {
    const custs = await api('GET', '/customers');
    if (!custs.length) return head('Capture once. Send to the factory.', 'New order') + card('<p>No customers are assigned to you yet. Ask the admin.</p>');
    const kinds = ['retailer', 'distributor'], availableKinds = new Set(custs.map(c => c.kind));
    if (!availableKinds.has(S.custType)) S.custType = availableKinds.has('retailer') ? 'retailer' : 'distributor';
    const visibleCustomers = custs.filter(c => c.kind === S.custType);
    S.cust = visibleCustomers.find(c => String(c.id) === String(S.cust))?.id ?? visibleCustomers[0].id;
    const prices = await api('GET', `/customers/${S.cust}/prices`);
    return head('Capture once. Send to the factory.', 'New order', `${Q().length ? Q().length + ' order(s) waiting to sync. ' : ''}Prices come from the price list.`) +
      card(`<label>Customer type<select id="cust-type" data-change="cust-type">${kinds.map(kind => {
        const label = kind === 'retailer' ? 'Retailer' : 'Distributor', count = custs.filter(c => c.kind === kind).length;
        return `<option value="${kind}" ${kind === S.custType ? 'selected' : ''} ${count ? '' : 'disabled'}>${label}${count ? ` (${count})` : ' (not assigned)'}</option>`;
      }).join('')}</select></label>
      <label>Retailer / distributor<select id="cust" data-change="cust">${opts(visibleCustomers, 'id', c => `${c.name} · ${c.state_code}`, S.cust)}</select></label>
      ${prices.map(p => `<label>${esc(p.name)} (${rs(p.rate_paise)} each)<input type="number" min="0" step="1" value="0" id="q-${p.item_id}" data-price="${p.rate_paise}" data-item="${p.item_id}" inputmode="numeric"></label>`).join('')}
      <div class="msg" style="margin-top:14px">Total before GST: <b id="tot">₹0</b>. GST is added when the factory raises the invoice.</div>
      <div style="margin-top:14px"><button class="btn" data-a="submit-order" style="width:100%">Submit order →</button></div>`) ;
  },
  async 'my-orders'() {
    const o = await api('GET', '/orders'), by = {};
    o.filter(x => !['rejected', 'cancelled'].includes(x.status)).forEach(x => by[x.customer_name] = (by[x.customer_name] || 0) + x.total_paise);
    return head('Status and customer-wise sales', 'My orders') + card(tb(['Order', 'Customer', 'Items', 'Value', 'Status'], o.map(x => [esc(x.order_no), esc(x.customer_name), x.lines.map(l => `${esc(l.name)} × ${l.qty}`).join(', '), rs(x.total_paise), tag(x.status, x.status === 'rejected')]))) +
      card(`<h3>Customer-wise sales</h3>${tb(['Customer', 'Order value'], Object.entries(by).map(([k, v]) => [esc(k), rs(v)]))}`);
  },
  async overview() {
    const d = await api('GET', '/dashboard'), k = [];
    if (d.orders_to_verify !== undefined) k.push(kpi('Orders to verify', String(d.orders_to_verify).padStart(2, '0'), 'waiting for admin', 'lime'));
    k.push(...d.finished_goods.map(f => kpi('Finished goods', f.qty.toLocaleString('en-IN'), esc(f.name))));
    if (d.receivables_paise !== undefined) k.push(kpi('Receivables', rs(d.receivables_paise), 'unpaid invoices'));
    k.push(kpi('Variance alerts', d.variance_alerts, 'beyond tolerance'));
    if (d.latest_cost) k.push(kpi('Cost per packet', rs(Math.round(d.latest_cost.cost_per_unit_paise)), `${esc(d.latest_cost.run_no)} · price ${rs(d.latest_cost.sell_price_paise)}`));
    return head('Operations', 'Good morning. Let’s keep things moving.', 'One source of truth, from the retailer’s order to the auditor’s desk.') + `<div class="row">${k.join('')}</div>` +
      (d.low_stock?.length ? card(`<h3>Low stock</h3>${tb(['Item', 'Balance', 'Reorder level'], d.low_stock.map(l => [esc(l.name), l.qty, l.reorder_level]))}`) : '') +
      (S.user.role === 'owner' ? ownerComparison(d.monthly_comparison) : '') +
      card('<h3>Two loops. One stock ledger.</h3><p>Sales order → GST invoice → dispatch (stock down). Purchase → production → finished goods (stock up).</p>', 'lime');
  },
  async 'sales-orders'() {
    const [orders, invs] = await Promise.all([api('GET', '/orders'), api('GET', '/invoices')]);
    const inv = {}; invs.forEach(i => inv[i.order_id] = i);
    const chk = {}; await Promise.all(orders.filter(o => ['submitted', 'approved', 'invoiced'].includes(o.status)).map(async o => chk[o.id] = await api('GET', `/orders/${o.id}/stock-check`)));
    const rows = orders.map(o => {
      const i = inv[o.id], sh = (chk[o.id] || []).reduce((a, x) => a + x.shortage, 0), a = [];
      if (o.status === 'submitted') a.push(btn('Approve', 'approve', o.id), btn('Reject', 'reject', o.id, 'alt'), btn('Edit qty', 'edit', o.id, 'alt'));
      if (o.status === 'approved') a.push(btn('Create invoice', 'invoice', o.id));
      if (o.status === 'invoiced' && i) a.push(btn('Dispatch', 'dispatch', i.id));
      if (i) a.push(btn(i.invoice_no, 'view', i.id, 'alt'));
      return [esc(o.order_no), esc(o.customer_name), o.lines.map(l => `${esc(l.name)} × ${l.qty}`).join(', '), rs(o.total_paise), chk[o.id] ? (sh > 0 ? tag('Short ' + sh, true) : tag('Stock covers')) : '—', tag(o.status, o.status === 'rejected'), a.join('')];
    });
    let h = head('Sales / Order verification', 'A clean order. No re-entry.', 'Verify, invoice, dispatch. Stock is checked before dispatch.') + card(tb(['Order', 'Customer', 'Items', 'Value', 'Stock check', 'Status', 'Actions'], rows));
    if (S.inv) {
      const i = await api('GET', '/invoices/' + S.inv);
      h += card(`<div class="sp"><div><b>${esc(i.invoice_no)}</b> · ${esc(i.invoice_date)} · ${i.status === 'cancelled' ? tag('CANCELLED', true) : tag('Posted')}<br><span style="color:var(--mut)">${esc(i.customer_name)} · GSTIN ${esc(i.customer_gstin || '-')} · place of supply ${esc(i.place_of_supply)} (${i.is_interstate ? 'IGST' : 'CGST + SGST'})</span></div><div>${btn('Open PDF', 'pdf', i.id)}${i.status === 'posted' ? btn('Cancel with credit note', 'cancel', i.id, 'alt') : ''}</div></div>` +
        tb(['Item', 'HSN', 'Qty', 'Rate', 'Taxable', 'GST'], i.lines.map(l => [esc(l.description), esc(l.hsn || '-'), l.qty, rs(l.rate_paise), rs(l.taxable_paise), l.gst_bp / 100 + '%'])) +
        `<p style="text-align:right;line-height:1.9;margin-top:10px">Taxable ${rs(i.taxable_paise)}<br>${i.is_interstate ? `IGST ${rs(i.igst_paise)}` : `CGST ${rs(i.cgst_paise)}<br>SGST ${rs(i.sgst_paise)}`}<br><b style="font-size:20px">Total ${rs(i.total_paise)}</b></p>`);
    }
    return h;
  },
  async collections() {
    const custs = await api('GET', '/customers'), pays = await api('GET', '/payments');
    const outs = await Promise.all(custs.map(async c => ({ c, o: await api('GET', `/customers/${c.id}/outstanding`) })));
    const rows = outs.flatMap(({ c, o }) => o.invoices.map(i => [esc(c.name), esc(i.invoice_no), esc(i.due_date), rs(i.outstanding_paise),
      `<input type="number" min="0" step="0.01" id="pay-${i.invoice_id}" value="${i.outstanding_paise / 100}">`, `<select id="mode-${i.invoice_id}"><option>upi</option><option>cash</option><option>bank</option><option>cheque</option></select>`,
      btn('Record', 'pay', i.invoice_id, '', `data-cust="${c.id}"`)]));
    return head('Collections', 'Payment received. Balance reconciled.') + `<div class="row">${kpi('Outstanding', rs(outs.reduce((a, x) => a + x.o.total_paise, 0)), 'all customers', 'lime')}</div>` +
      card(`<h3>Open invoices</h3>${tb(['Customer', 'Invoice', 'Due', 'Outstanding', 'Amount (₹)', 'Mode', ''], rows)}`) +
      card(`<h3>Receipts</h3>${tb(['Date', 'Customer', 'Mode', 'Amount'], pays.map(p => [esc(p.paid_on), esc(p.customer_name), esc(p.mode), rs(p.amount_paise)]))}`);
  },
  async inventory() {
    const [bal, items] = await Promise.all([api('GET', '/stock/balances'), api('GET', '/items')]);
    const led = await api('GET', '/stock/ledger' + (S.item ? '?item_id=' + S.item : ''));
    const adj = S.user.role === 'production' ? card(`<h3>Stock adjustment</h3><div class="row"><label>Item<select id="adj-item">${opts(items.filter(i => i.type !== 'finished'), 'id', 'name')}</select></label><label>Quantity (+ or −)<input id="adj-qty" type="number" step="0.001"></label><label>Reason<input id="adj-why"></label></div><div style="margin-top:12px"><button class="btn" data-a="adjust">Post adjustment</button></div>`) : '';
    return head('Inventory / Source document ledger', 'Where both loops meet.', 'Opening + receipts − issues ± adjustments = closing. Every row links to its source document.') +
      card(`<h3>Balances</h3>${tb(['Item', 'Type', 'Balance', 'Unit', 'Value', 'Avg cost'], bal.map(b => [esc(b.name), esc(b.type), b.qty, esc(b.base_unit), rs(b.value_paise), rs(b.avg_cost_paise)]))}`) + adj +
      card(`<div class="sp"><h3>Stock ledger</h3><select id="item-filter" data-change="item" style="max-width:260px"><option value="">All items</option>${opts(items, 'id', 'name', S.item)}</select></div>${tb(['Date', 'Item', 'Movement', 'In / out', 'Value', 'Source', 'Running'], led.slice(0, 100).map(l => [esc(l.move_date), esc(l.name), esc(l.move.replace(/_/g, ' ')), l.qty_delta, rs(l.value_delta), esc(l.src_table + (l.src_id ? ' #' + l.src_id : '')), l.running_qty]))}`);
  },
  async production() {
    const [runs, boms] = await Promise.all([api('GET', '/production-runs'), api('GET', '/boms')]);
    let h = head('Production', 'Know what went in. Know what came out.', 'Pick a recipe (BOM), enter actual issues and output, then post.') +
      card(`<h3>New production run</h3><div class="row"><label>Recipe<select id="run-bom">${opts(boms.filter(b => b.active), 'id', b => `${b.product_name} v${b.version} · yield ${b.yield_qty}`)}</select></label><label>Batches<input id="run-batches" type="number" step="0.1" min="0.1" value="1"></label><label>Batch no. (optional)<input id="run-bno"></label><label>Expiry (optional)<input id="run-exp" type="date"></label></div><div style="margin-top:12px"><button class="btn" data-a="new-run">Create run</button></div>`) +
      card(`<h3>Runs</h3>${tb(['Run', 'Date', 'Product', 'Expected', 'Actual', 'Status', ''], runs.map(r => [esc(r.run_no), esc(r.run_date), esc(r.product_name), r.expected_output, r.actual_output ?? '—', tag(r.status), btn('Open', 'open-run', r.id, 'alt')]))}`);
    if (S.run) {
      const r = await api('GET', '/production-runs/' + S.run), draft = r.status === 'draft';
      h += card(`<div class="sp"><h3>${esc(r.run_no)} · ${esc(r.product_name)}</h3>${tag(r.status)}</div>` +
        tb(['Material', 'Planned', 'Actual issue', 'Wastage', 'Value'], r.issues.map(i => [esc(i.name), i.planned_qty, draft ? `<input type="number" step="0.001" data-issue="${i.item_id}" value="${i.actual_qty}">` : i.actual_qty, draft ? `<input type="number" step="0.001" data-waste="${i.item_id}" value="${i.wastage_qty}">` : i.wastage_qty, i.value_paise == null ? '—' : rs(i.value_paise)])) +
        (draft ? `<label>Actual good output (${r.expected_output} expected)<input id="run-out" type="number" step="1" value="${r.actual_output ?? r.expected_output}"></label><div style="margin-top:12px">${btn('Save actuals', 'save-run', r.id, 'alt')} ${btn('Post run', 'post-run', r.id)}</div>` : ''));
      if (!draft) {
        const v = await api('GET', `/production-runs/${r.id}/variance`);
        h += card(`<h3>Planned vs actual (tolerance 3%)</h3>${grid(v)}`);
        try {
          const c = await api('GET', `/production-runs/${r.id}/costing`);
          h += `<div class="row">${kpi('Cost per packet', rs(Math.round(c.cost_per_unit_paise)), 'weighted-average materials + overheads ÷ good packets', 'lime')}${kpi('Materials', rs(c.material_paise))}${kpi('Overheads', rs(c.overhead_paise))}${kpi('Margin / packet', c.margin_paise == null ? '—' : rs(Math.round(c.margin_paise)), 'selling price − cost')}</div>`;
        } catch { /* costing needs a posted run */ }
        h += card(`<h3>Add overhead</h3><div class="row"><label>Kind<select id="oh-kind"><option>labour</option><option>gas</option><option>power</option><option>other</option></select></label><label>Amount (₹)<input id="oh-amt" type="number" step="0.01"></label></div><div style="margin-top:12px">${btn('Add overhead', 'overhead', r.id)}</div>` + (r.overheads.length ? tb(['Kind', 'Amount'], r.overheads.map(o => [esc(o.kind), rs(o.amount_paise)])) : ''));
      }
    }
    return h;
  },
  async purchases() {
    const [sup, items, pur] = await Promise.all([api('GET', '/suppliers'), api('GET', '/items'), api('GET', '/purchases')]);
    return head('Purchases', 'Raw material in. Stock up.', 'Posting a purchase adds a stock-ledger row at the purchase rate.') +
      card(`<h3>New purchase</h3><div class="row"><label>Supplier<select id="pu-sup">${opts(sup, 'id', 'name')}</select></label><label>Bill no.<input id="pu-bill"></label><label>Item<select id="pu-item">${opts(items.filter(i => i.type !== 'finished'), 'id', i => `${i.name} (${i.base_unit})`)}</select></label><label>Quantity<input id="pu-qty" type="number" step="0.001"></label><label>Unit<select id="pu-unit"><option>kg</option><option>g</option><option>l</option><option>ml</option><option>pc</option></select></label><label>Rate per unit (₹)<input id="pu-rate" type="number" step="0.01"></label></div><div style="margin-top:12px"><button class="btn" data-a="new-purchase">Save and post</button></div>`) +
      card(`<h3>Purchase register</h3>${tb(['Date', 'Bill', 'Supplier', 'Total', 'Status', ''], pur.map(p => [esc(p.bill_date), esc(p.bill_no || '-'), esc(p.supplier_name), rs(p.total_paise), tag(p.status), p.status === 'draft' ? btn('Post', 'post-purchase', p.id) : '']))}`);
  },
  async 'monthly-audit'() { return audit(false); },
  async 'stock-ledger'() { return audit(true); }
};
async function audit(fixed) {
  if (fixed) S.rep = 'stock-ledger';
  const qs = `?from=${S.from}&to=${S.to}`;
  const data = S.rep === 'audit-log' ? await api('GET', '/audit-log') : (await api('GET', `/reports/${S.rep}${qs}`)).rows;
  const sub = S.rep === 'audit-log' ? 'Before shows the previous values; After shows the saved values. New records have no previous values.' : 'Read-only. Filter by date and export to CSV (opens in Excel).';
  return head('Reports / Accountant & auditor', fixed ? 'Stock ledger' : 'Month end, without the scramble.', sub) +
    card(`<div class="row">${fixed ? '' : `<label>Report<select id="rep">${REPORTS.map(r => `<option ${r === S.rep ? 'selected' : ''}>${r}</option>`).join('')}</select></label>`}<label>From<input id="from" type="date" value="${S.from}"></label><label>To<input id="to" type="date" value="${S.to}"></label></div><div style="margin-top:12px"><button class="btn" data-a="run-report">Run</button> ${S.rep === 'audit-log' ? '' : '<button class="btn alt" data-a="csv">Export CSV</button>'}</div>`) + card(S.rep === 'audit-log' ? auditGrid(data) : grid(data));
}

// ---- actions ----
const prompted = (m, d = '') => { const v = prompt(m, d); if (v === null || v === '') throw Object.assign(new Error('Cancelled'), { quiet: true }); return v; };
const A = {
  async 'submit-order'() {
    const lines = [...document.querySelectorAll('[data-item]')].map(i => ({ item_id: +i.dataset.item, qty: +i.value })).filter(l => l.qty > 0);
    if (!lines.length) throw new Error('Enter a quantity for at least one product.');
    const body = { client_uuid: crypto.randomUUID(), customer_id: +$('cust').value, lines };
    try { const o = await api('POST', '/orders', body); S.ok = `Order ${o.order_no} submitted to the factory.`; }
    catch (e) { if (e.status) throw e; localStorage.setItem('kadai_q', JSON.stringify([...Q(), body])); S.ok = 'No network. The order is saved on this phone and will be sent automatically.'; }
    go('my-orders');
  },
  async approve(el) { await api('POST', `/orders/${el.dataset.id}/approve`); S.ok = 'Order approved.'; },
  async reject(el) { await api('POST', `/orders/${el.dataset.id}/reject`, { reason: prompted('Reason for rejecting?') }); S.ok = 'Order rejected.'; },
  async edit(el) {
    const o = await api('GET', '/orders/' + el.dataset.id), lines = [];
    for (const l of o.lines) lines.push({ item_id: l.item_id, qty: +prompted(`New quantity for ${l.name}`, l.qty) });
    await api('PATCH', '/orders/' + o.id, { lines }); S.ok = 'Order updated.';
  },
  async invoice(el) { const i = await api('POST', `/orders/${el.dataset.id}/invoice`); S.inv = i.id; S.ok = `Invoice ${i.invoice_no} created.`; },
  async dispatch(el) { await api('POST', `/invoices/${el.dataset.id}/dispatch`); S.inv = +el.dataset.id; S.ok = 'Dispatched. Finished-goods stock reduced.'; },
  async view(el) { S.inv = +el.dataset.id; },
  async pdf(el) { const r = await api('GET', `/invoices/${el.dataset.id}/pdf`, null, true); window.open(URL.createObjectURL(await r.blob()), '_blank'); },
  async cancel(el) { const n = await api('POST', `/invoices/${el.dataset.id}/cancel`, { reason: prompted('Reason for cancelling?') }); S.ok = `Credit note ${n.note_no} issued.`; },
  async pay(el) {
    const id = el.dataset.id, amt = toPaise($('pay-' + id).value);
    await api('POST', '/payments', { customer_id: +el.dataset.cust, amount_paise: amt, mode: $('mode-' + id).value, allocations: [{ invoice_id: +id, amount_paise: amt }] }); S.ok = 'Payment recorded.';
  },
  async adjust() { await api('POST', '/stock/adjustments', { item_id: +$('adj-item').value, qty_delta: +$('adj-qty').value, reason: $('adj-why').value }); S.ok = 'Adjustment posted.'; },
  async 'new-run'() {
    const r = await api('POST', '/production-runs', { bom_id: +$('run-bom').value, batches: +$('run-batches').value, batch_no: $('run-bno').value || undefined, expiry_date: $('run-exp').value || undefined });
    S.run = r.id; S.ok = `Run ${r.run_no} created. Enter the actual issues, then post.`;
  },
  async 'open-run'(el) { S.run = +el.dataset.id; },
  async 'save-run'(el) {
    const issues = [...document.querySelectorAll('[data-issue]')].map(i => ({ item_id: +i.dataset.issue, actual_qty: +i.value, wastage_qty: +document.querySelector(`[data-waste="${i.dataset.issue}"]`).value }));
    await api('PUT', `/production-runs/${el.dataset.id}/issues`, { actual_output: +$('run-out').value, issues }); S.ok = 'Actuals saved.';
  },
  async 'post-run'(el) { await A['save-run'](el); await api('POST', `/production-runs/${el.dataset.id}/post`); S.ok = 'Run posted: raw materials issued, finished goods received.'; },
  async overhead(el) { await api('POST', `/production-runs/${el.dataset.id}/overheads`, { kind: $('oh-kind').value, amount_paise: toPaise($('oh-amt').value) }); S.ok = 'Overhead added.'; },
  async 'new-purchase'() {
    const p = await api('POST', '/purchases', { supplier_id: +$('pu-sup').value, bill_no: $('pu-bill').value, lines: [{ item_id: +$('pu-item').value, qty: +$('pu-qty').value, unit_code: $('pu-unit').value, rate_paise: toPaise($('pu-rate').value) }] });
    await api('POST', `/purchases/${p.id}/post`); S.ok = 'Purchase posted. Stock updated.';
  },
  async 'post-purchase'(el) { await api('POST', `/purchases/${el.dataset.id}/post`); S.ok = 'Purchase posted.'; },
  async 'run-report'() { if ($('rep')) S.rep = $('rep').value; S.from = $('from').value; S.to = $('to').value; },
  async csv() {
    const r = await api('GET', `/reports/${S.rep}?from=${S.from}&to=${S.to}&format=csv`, null, true), a = document.createElement('a');
    a.href = URL.createObjectURL(await r.blob()); a.download = S.rep + '.csv'; a.click();
  },
  async login() {
    const r = await api('POST', '/auth/login', { username: $('u').value.trim(), password: $('pw').value, role: S.pick });
    S.token = r.token; S.user = r.user; localStorage.setItem('kadai_token', r.token); localStorage.setItem('kadai_user', JSON.stringify(r.user)); S.err = ''; location.hash = '';
  },
  async signout() { logout(); }
};

// ---- shell ----
function loginView() {
  return `<div class="login"><div class="card"><h1 style="font-size:34px">kadai</h1><div class="eye" style="margin-bottom:14px">Factory operations</div><p style="margin-bottom:12px">Choose your role, then sign in.</p>
  <div class="login-theme">${themeControl()}</div>
  <div class="tiles">${Object.entries(ROLES).map(([k, [n, d]]) => `<button class="tile ${S.pick === k ? 'on' : ''}" data-a="pick" data-id="${k}"><b>${n}</b><small>${d}</small></button>`).join('')}</div>
  <label>Username<input id="u" autocomplete="username" value="${S.pick === 'salesman' ? 'salesman_a' : S.pick}"></label><label>Password<input id="pw" type="password" autocomplete="current-password" value="kadai123"></label>
  <p class="err" id="login-err">${esc(S.err)}</p><p style="font-size:11px;color:var(--mut);margin-top:8px">Demo logins (password kadai123): salesman_a · admin · production · auditor · owner. The role must match the account.</p>
  <div style="margin-top:14px"><button class="btn" data-a="login" style="width:100%">Sign in as ${ROLES[S.pick][0]} →</button></div></div></div>`;
}
async function render() {
  const my = ++rid, app = $('app');
  if (!S.token) { app.innerHTML = loginView(); return; }
  const route = location.hash.slice(1) || S.user.screens[0];
  let body;
  try {
    await flush();
    body = S.user.screens.includes(route) ? await V[route]() : `<div class="card"><h1>Access denied</h1><p style="margin:8px 0 14px">The ${esc(ROLES[S.user.role][0])} role cannot open this screen.</p>${btn('Back to my home', 'home', '')}</div>`;
  } catch (e) { if (my !== rid) return; body = `<div class="msg">${esc(e.message)}</div>`; }
  if (my !== rid) return;
  const banner = S.ok ? `<div class="msg ok">${esc(S.ok)}</div>` : S.err ? `<div class="msg">${esc(S.err)}</div>` : '';
  S.ok = ''; S.err = '';
  app.innerHTML = `<div class="app"><nav class="side"><div class="logo">kadai</div><div class="sub">FACTORY OPERATIONS</div>${S.user.screens.map(s => `<button class="nav ${s === route ? 'on' : ''}" data-a="go" data-id="${s}">${LABEL[s]}</button>`).join('')}
    <div class="foot" style="margin-top:auto;font-size:11px;color:var(--side-muted);padding:8px">${esc(S.user.full_name)}<br>Role locked by account</div><button class="nav" data-a="signout" style="border:1px solid var(--side-muted);margin-top:6px">Sign out</button></nav>
    <main class="main"><div class="top"><b>Sri Lakshmi Snacks</b> / Factory workspace${themeControl()}<span class="badge">${BADGE[S.user.role]}</span></div>${banner}${body}</main></div>`;
}
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-a]'); if (!el) return;
  const a = el.dataset.a;
  if (a === 'pick') { S.pick = el.dataset.id; S.err = ''; return render(); }
  if (a === 'go') return go(el.dataset.id);
  if (a === 'home') { location.hash = ''; return render(); }
  try { await A[a](el); } catch (err) { if (!err.quiet) { if (a === 'login') S.err = err.message; else S.err = err.message; } }
  if (a === 'login' || a === 'signout') return render();
  render();
});
document.addEventListener('change', e => {
  const k = e.target.dataset.change;
  if (k === 'theme' && THEME_IDS.has(e.target.value)) {
    S.theme = e.target.value;
    localStorage.setItem('kadai_theme', S.theme);
    applyTheme();
  }
  if (k === 'cust-type') { S.custType = e.target.value; S.cust = null; render(); }
  if (k === 'cust') { S.cust = e.target.value; render(); }
  if (k === 'item') { S.item = e.target.value; render(); }
});
document.addEventListener('input', e => {
  if (e.target.dataset.price === undefined) return;
  $('tot').textContent = rs([...document.querySelectorAll('[data-price]')].reduce((a, i) => a + Math.round((+i.value || 0) * i.dataset.price), 0));
});
window.addEventListener('hashchange', render);
render();
