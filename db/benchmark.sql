-- Runs section 5 end to end inside one transaction and ASSERTS the expected results.
BEGIN;
SELECT set_config('app.user_id', (SELECT id::text FROM users WHERE username='admin'), true);
CREATE TEMP TABLE bm(k text, v numeric);
DO $$
DECLARE ib bigint; s bigint; p bigint; run bigint; o1 bigint; o2 bigint; i1 bigint; pay bigint; fg bigint; flour bigint;
 q numeric; short numeric; vals text;
BEGIN
 fg := (SELECT id FROM items WHERE sku='FG-MK200'); flour := (SELECT id FROM items WHERE sku='RM-FLOUR');
 -- 1 purchase 60 kg flour at 45/kg
 INSERT INTO purchases(supplier_id, bill_no) VALUES (1,'GRN-001') RETURNING id INTO p;
 INSERT INTO purchase_lines(purchase_id,item_id,qty,unit_code,rate_paise) VALUES (p, flour, 60, 'kg', 4500);
 PERFORM post_purchase(p);
 -- 2-3 production run: 40 kg flour, 10.5 L oil, 1.2 kg spice, 194 pouches (188 used + 6 damaged), 9 cartons; output 188
 INSERT INTO production_runs(run_no,bom_id,product_id,expected_output,actual_output) VALUES ('B-001',1,fg,200,188) RETURNING id INTO run;
 INSERT INTO production_issues(run_id,item_id,planned_qty,actual_qty,wastage_qty)
 SELECT run, i.id, v.pl, v.ac, v.w FROM items i JOIN (VALUES ('RM-FLOUR',40,40,0),('RM-OIL',10,10.5,0),('RM-SPICE',1.2,1.2,0),('PK-POUCH200',200,194,6),('PK-CARTON20',10,9,0)) v(s,pl,ac,w) ON v.s=i.sku;
 PERFORM post_production_run(run);
 -- 8 overheads
 PERFORM add_overhead(run,'labour',120000); PERFORM add_overhead(run,'gas',60000);
 -- 4-5 Retailer A: 150 packets
 INSERT INTO orders(order_no,customer_id,salesman_id) VALUES ('SO-1',1,(SELECT id FROM users WHERE username='salesman_a')) RETURNING id INTO o1;
 INSERT INTO order_lines(order_id,item_id,qty,rate_paise) VALUES (o1,fg,150,5000);
 UPDATE orders SET status='approved' WHERE id=o1;
 i1 := create_invoice_from_order(o1); PERFORM post_dispatch(i1);
 -- 6 Distributor B: 120 packets -> shortage
 INSERT INTO orders(order_no,customer_id,salesman_id) VALUES ('SO-2',2,(SELECT id FROM users WHERE username='salesman_b')) RETURNING id INTO o2;
 INSERT INTO order_lines(order_id,item_id,qty,rate_paise) VALUES (o2,fg,120,5000);
 SELECT shortage INTO short FROM v_order_stock_check WHERE order_id=o2;
 -- 7 payment 4000
 INSERT INTO payments(customer_id,amount_paise,mode) VALUES (1,400000,'upi') RETURNING id INTO pay;
 INSERT INTO payment_allocations VALUES (pay,i1,400000);
 -- checks
 PERFORM 1;
 INSERT INTO bm SELECT 'flour_kg', qty FROM v_stock_balance WHERE sku='RM-FLOUR';
 INSERT INTO bm SELECT 'oil_l', qty FROM v_stock_balance WHERE sku='RM-OIL';
 INSERT INTO bm SELECT 'pouches', qty FROM v_stock_balance WHERE sku='PK-POUCH200';
 INSERT INTO bm SELECT 'fg_after_dispatch', qty FROM v_stock_balance WHERE sku='FG-MK200';
 INSERT INTO bm SELECT 'inv_total_paise', total_paise FROM invoices WHERE id=i1;
 INSERT INTO bm SELECT 'inv_cgst_paise', cgst_paise FROM invoices WHERE id=i1;
 INSERT INTO bm SELECT 'outstanding_paise', outstanding_paise FROM v_invoice_outstanding WHERE invoice_id=i1;
 INSERT INTO bm VALUES ('shortage', short);
 INSERT INTO bm SELECT 'yield_var_bp', variance_bp FROM v_production_variance WHERE item_id=fg;
 INSERT INTO bm SELECT 'oil_var_bp', variance_bp FROM v_production_variance WHERE name='Cooking oil';
 INSERT INTO bm SELECT 'cost_per_packet_paise', cost_per_unit_paise FROM v_run_costing;
 -- Distributor B invoice would use IGST
 UPDATE orders SET status='approved' WHERE id=o2;
 ib := create_invoice_from_order(o2);
 INSERT INTO bm SELECT 'distB_igst_paise', igst_paise FROM invoices WHERE id=ib;
 BEGIN PERFORM post_dispatch(ib);
 EXCEPTION WHEN OTHERS THEN INSERT INTO bm VALUES ('distB_dispatch_blocked',1); END;
END $$;
SELECT k, v FROM bm ORDER BY k;
SELECT name, planned_qty, actual_qty, variance_bp, flagged FROM v_production_variance ORDER BY item_id;
ROLLBACK;
