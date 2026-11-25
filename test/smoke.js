// End-to-end check of the section 5 benchmark over HTTP. Run: npm run db:reset && npm start (other terminal) && npm test
const BASE = process.env.BASE || 'http://localhost:8000/api/v1';
let fails = 0;
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); };
async function call(token, method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) }, body: body && JSON.stringify(body) });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { s: r.status, j };
}
const login = async (u, role) => (await call(null, 'POST', '/auth/login', { username: u, password: 'kadai123', role })).j.token;
(async () => {
  const sa = await login('salesman_a', 'salesman'), sb = await login('salesman_b', 'salesman'), ad = await login('admin', 'admin'),
        pr = await login('production', 'production'), au = await login('auditor', 'auditor'), ow = await login('owner', 'owner');
  // role safety
  check('role mismatch rejected', (await call(null, 'POST', '/auth/login', { username: 'admin', password: 'kadai123', role: 'salesman' })).s, 403);
  check('salesman cannot see invoices', (await call(sa, 'GET', '/invoices')).s, 403);
  check('admin cannot post production', (await call(ad, 'POST', '/production-runs', { bom_id: 1, batches: 1 })).s, 403);
  check('auditor cannot create orders', (await call(au, 'POST', '/orders', {})).s, 403);
  check('no token -> 401', (await call(null, 'GET', '/items')).s, 401);
  check('five demo customers seeded', (await call(ad, 'GET', '/customers')).j.length, 5);
  const items = (await call(pr, 'GET', '/items')).j, id = s => items.find(i => i.sku === s).id;
  const snacks = [
    { sku: 'FG-MIX200', name: 'Mixture 200 g' },
    { sku: 'FG-RP200', name: 'Ribbon Pakoda 200 g' },
    { sku: 'FG-KS200', name: 'Kara Sev 200 g' }
  ];
  check('three additional snack products seeded', items.filter(i => snacks.some(s => s.sku === i.sku)).map(i => i.sku).sort(), ['FG-KS200', 'FG-MIX200', 'FG-RP200']);
  // 1 purchase 60 kg flour @ Rs45
  const p = (await call(pr, 'POST', '/purchases', { supplier_id: 1, bill_no: 'GRN-001', lines: [{ item_id: id('RM-FLOUR'), qty: 60, unit_code: 'kg', rate_paise: 4500 }] })).j;
  check('purchase posted', (await call(pr, 'POST', `/purchases/${p.id}/post`)).j.status, 'posted');
  // 2-3 production run
  const run = (await call(pr, 'POST', '/production-runs', { bom_id: 1, batches: 1, batch_no: 'MK200-001', expiry_date: '2027-03-01' })).j;
  await call(pr, 'PUT', `/production-runs/${run.id}/issues`, { actual_output: 188, issues: [
    { item_id: id('RM-FLOUR'), actual_qty: 40 }, { item_id: id('RM-OIL'), actual_qty: 10.5 }, { item_id: id('RM-SPICE'), actual_qty: 1200, unit: 'g' },
    { item_id: id('PK-POUCH200'), actual_qty: 194, wastage_qty: 6 }, { item_id: id('PK-CARTON20'), actual_qty: 9 }] });
  check('admin cannot post a run', (await call(ad, 'POST', `/production-runs/${run.id}/post`)).s, 403);
  check('run posted', (await call(pr, 'POST', `/production-runs/${run.id}/post`)).j.status, 'posted');
  const bal = async () => Object.fromEntries((await call(pr, 'GET', '/stock/balances')).j.map(b => [b.sku, b.qty]));
  let b = await bal();
  check('flour 120', b['RM-FLOUR'], 120); check('oil 49.5', b['RM-OIL'], 49.5); check('spice 3.8', b['RM-SPICE'], 3.8);
  check('pouches 806', b['PK-POUCH200'], 806); check('finished goods 238', b['FG-MK200'], 238);
  const v = (await call(pr, 'GET', `/production-runs/${run.id}/variance`)).j, vf = n => v.find(x => x.name.includes(n));
  check('yield -6% flagged', [vf('YIELD').variance_bp, vf('YIELD').flagged], [-600, true]);
  check('oil +5% flagged', [vf('oil').variance_bp, vf('oil').flagged], [500, true]);
  const boms = (await call(pr, 'GET', '/boms')).j;
  for (const snack of snacks) {
    const bom = boms.find(x => x.product_id === id(snack.sku));
    if (!bom) throw new Error(`Missing active recipe for ${snack.name}`);
    const draft = (await call(pr, 'POST', '/production-runs', { bom_id: bom.id, batches: 1 })).j;
    await call(pr, 'PUT', `/production-runs/${draft.id}/issues`, {
      actual_output: 200,
      issues: bom.lines.map(line => ({ item_id: line.item_id, actual_qty: Number(line.qty), wastage_qty: 0 }))
    });
    check(`${snack.name} production posted`, (await call(pr, 'POST', `/production-runs/${draft.id}/post`)).j.status, 'posted');
  }
  b = await bal();
  for (const snack of snacks) check(`${snack.name} finished stock`, b[snack.sku], 250);
  // 4-5 Retailer A
  const ca = (await call(sa, 'GET', '/customers')).j;
  check('salesman A sees assigned demo customers', ca.map(c => c.name), ['Retailer A', 'Retailer C', 'Retailer E']);
  const cbCustomers = (await call(sb, 'GET', '/customers')).j;
  check('salesman B sees assigned demo customers', cbCustomers.map(c => c.name), ['Distributor B', 'Distributor D']);
  const oa = (await call(sa, 'POST', '/orders', { client_uuid: crypto.randomUUID(), customer_id: ca[0].id, lines: [{ item_id: id('FG-MK200'), qty: 150 }] })).j;
  check('order total 7500', oa.total_paise, 750000);
  check('salesman B cannot read A order', (await call(sb, 'GET', `/orders/${oa.id}`)).s, 404);
  check('stock covers order', (await call(ad, 'GET', `/orders/${oa.id}/stock-check`)).j[0].shortage, 0);
  await call(ad, 'POST', `/orders/${oa.id}/approve`);
  const ia = (await call(ad, 'POST', `/orders/${oa.id}/invoice`)).j;
  check('invoice no', ia.invoice_no, 'INV/2026-27/0001');
  check('invoice 7500 + 187.50 + 187.50 = 7875', [ia.taxable_paise, ia.cgst_paise, ia.sgst_paise, ia.igst_paise, ia.total_paise], [750000, 18750, 18750, 0, 787500]);
  check('dispatch ok', (await call(ad, 'POST', `/invoices/${ia.id}/dispatch`)).s, 201);
  check('finished goods 88', (await bal())['FG-MK200'], 88);
  check('invoice pdf', (await fetch(`${BASE}/invoices/${ia.id}/pdf`, { headers: { Authorization: 'Bearer ' + ad } })).headers.get('content-type'), 'application/pdf');
  check('posted invoice cannot be re-dispatched', (await call(ad, 'POST', `/invoices/${ia.id}/dispatch`)).s, 409);
  // 6 Distributor B
  const cb = cbCustomers[0];
  const ob = (await call(sb, 'POST', '/orders', { customer_id: cb.id, lines: [{ item_id: id('FG-MK200'), qty: 120 }] })).j;
  check('shortage 32', (await call(ad, 'GET', `/orders/${ob.id}/stock-check`)).j[0].shortage, 32);
  await call(ad, 'POST', `/orders/${ob.id}/approve`);
  const ib = (await call(ad, 'POST', `/orders/${ob.id}/invoice`)).j;
  check('Distributor B uses IGST', [ib.is_interstate, ib.igst_paise, ib.cgst_paise], [true, 30000, 0]);
  const dd = await call(ad, 'POST', `/invoices/${ib.id}/dispatch`);
  check('dispatch blocked: INSUFFICIENT_STOCK', [dd.s, dd.j.code], [409, 'INSUFFICIENT_STOCK']);
  check('stock unchanged after blocked dispatch', (await bal())['FG-MK200'], 88);
  // 7 payment 4000
  const pay = await call(ad, 'POST', '/payments', { customer_id: ca[0].id, amount_paise: 400000, mode: 'upi', allocations: [{ invoice_id: ia.id, amount_paise: 400000 }] });
  check('payment recorded', pay.s, 201);
  check('outstanding 3875', (await call(ad, 'GET', `/customers/${ca[0].id}/outstanding`)).j.total_paise, 387500);
  // 8 overheads + cost per packet
  await call(pr, 'POST', `/production-runs/${run.id}/overheads`, { kind: 'labour', amount_paise: 120000 });
  await call(pr, 'POST', `/production-runs/${run.id}/overheads`, { kind: 'gas', amount_paise: 60000 });
  const cost = (await call(ow, 'GET', `/production-runs/${run.id}/costing`)).j;
  check('cost per packet Rs31.14', Math.round(cost.cost_per_unit_paise), 3114);
  // 9 reports + audit + cancel
  check('sales register rows', (await call(au, 'GET', '/reports/sales-register')).j.count, 2);
  const gst = (await call(au, 'GET', '/reports/gst-summary')).j.rows;
  check('gst summary TN CGST', gst.find(r => r.place_of_supply === '33').cgst_paise, 18750);
  check('gst summary KA IGST', gst.find(r => r.place_of_supply === '29').igst_paise, 30000);
  check('csv export', (await call(au, 'GET', '/reports/stock-summary?format=csv')).s, 200);
  check('invoice audit trail exists', (await call(au, 'GET', `/audit-log?entity=invoices&entity_id=${ia.id}`)).j.length > 0, true);
  check('cancel needs a credit note', (await call(ad, 'POST', `/invoices/${ib.id}/cancel`, { reason: 'Stock not available' })).j.note_no.startsWith('CN/'), true);
  const ownerDashboard = (await call(ow, 'GET', '/dashboard')).j;
  check('owner dashboard', typeof ownerDashboard.receivables_paise, 'number');
  check('owner latest snack cost', Math.round(ownerDashboard.latest_cost.cost_per_unit_paise), 2455);
  const comparison = ownerDashboard.monthly_comparison, metric = key => comparison.metrics.find(m => m.key === key);
  check('owner comparison periods', comparison.periods.length, 2);
  check('owner comparison taxable sales', metric('sales').values, [0, 750000]);
  check('owner comparison GST', metric('gst').values, [0, 37500]);
  check('owner comparison collections', metric('collections').values, [0, 400000]);
  for (const snack of snacks) {
    const customerPrices = (await call(sa, 'GET', `/customers/${ca[0].id}/prices`)).j;
    check(`${snack.name} retailer price`, Number(customerPrices.find(p => p.item_id === id(snack.sku))?.rate_paise), 5000);
    const order = (await call(sa, 'POST', '/orders', { client_uuid: crypto.randomUUID(), customer_id: ca[0].id, lines: [{ item_id: id(snack.sku), qty: 2 }] })).j;
    check(`${snack.name} order total`, order.total_paise, 10000);
    await call(ad, 'POST', `/orders/${order.id}/approve`);
    const invoice = (await call(ad, 'POST', `/orders/${order.id}/invoice`)).j;
    check(`${snack.name} 5% GST invoice`, [invoice.taxable_paise, invoice.cgst_paise, invoice.sgst_paise, invoice.igst_paise, invoice.total_paise], [10000, 250, 250, 0, 10500]);
    check(`${snack.name} dispatch`, (await call(ad, 'POST', `/invoices/${invoice.id}/dispatch`)).s, 201);
  }
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
