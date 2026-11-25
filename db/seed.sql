-- Section 5 master data. Password for every demo user: kadai123
INSERT INTO company_settings(name, gstin, address, state_code) VALUES ('Sri Lakshmi Snacks','[YOUR GSTIN]','Tiruchirappalli, Tamil Nadu','33');
INSERT INTO units(code, kind, to_base) VALUES ('kg','mass',1),('g','mass',0.001),('l','volume',1),('ml','volume',0.001),('pc','count',1),('pkt','count',1),('carton','count',1);
INSERT INTO users(username, full_name, password_hash, role) VALUES
 ('salesman_a','Salesman A',crypt('kadai123',gen_salt('bf')),'salesman'),('salesman_b','Salesman B',crypt('kadai123',gen_salt('bf')),'salesman'),
 ('admin','Factory Admin',crypt('kadai123',gen_salt('bf')),'admin'),('production','Production Supervisor',crypt('kadai123',gen_salt('bf')),'production'),
 ('auditor','Auditor',crypt('kadai123',gen_salt('bf')),'auditor'),('owner','Owner',crypt('kadai123',gen_salt('bf')),'owner');
INSERT INTO items(sku,name,type,base_unit,hsn,gst_rate_bp,sell_price_paise) VALUES
 ('RM-FLOUR','Flour','raw','kg',NULL,0,NULL),('RM-OIL','Cooking oil','raw','l',NULL,0,NULL),('RM-SPICE','Salt and spice mix','raw','kg',NULL,0,NULL),
 ('PK-POUCH200','200 g pouch','packaging','pc',NULL,0,NULL),('PK-CARTON20','Carton (20 packets)','packaging','pc',NULL,0,NULL),
 ('FG-MK200','Murukku 200 g','finished','pkt','[HSN]',500,5000);        -- HSN is a placeholder: confirm before live billing
INSERT INTO item_unit_conversions(item_id, unit_code, factor) SELECT id,'carton',20 FROM items WHERE sku='FG-MK200';
-- (unit 'carton' must exist in units for the FK; add it)
INSERT INTO boms(product_id, yield_qty) SELECT id, 200 FROM items WHERE sku='FG-MK200';
INSERT INTO bom_lines(bom_id, item_id, qty) SELECT 1, id, q FROM items JOIN (VALUES ('RM-FLOUR',40),('RM-OIL',10),('RM-SPICE',1.2),('PK-POUCH200',200),('PK-CARTON20',10)) v(s,q) ON v.s = items.sku;
INSERT INTO suppliers(name) VALUES ('Cauvery Mills');
INSERT INTO customers(name, kind, gstin, state_code, credit_days, salesman_id) VALUES
 ('Retailer A','retailer','33AAAAA0000A1Z5','33',7,(SELECT id FROM users WHERE username='salesman_a')),
 ('Distributor B','distributor','29BBBBB0000B1Z5','29',15,(SELECT id FROM users WHERE username='salesman_b')),
 ('Retailer C','retailer','33CCCCC0000C1Z5','33',7,(SELECT id FROM users WHERE username='salesman_a')),
 ('Distributor D','distributor','33DDDDD0000D1Z5','33',15,(SELECT id FROM users WHERE username='salesman_b')),
 ('Retailer E','retailer','33EEEEE0000E1Z5','33',7,(SELECT id FROM users WHERE username='salesman_a'));
-- Opening balances go through the ledger, valued at the benchmark rates. Opening FG cost ₹30/packet is an ASSUMPTION.
INSERT INTO stock_ledger(item_id, move, qty_delta, value_delta, src_table, narration)
SELECT i.id, 'opening', q, v, 'seed', 'Opening balance' FROM items i JOIN (VALUES
 ('RM-FLOUR',100,420000),('RM-OIL',30,420000),('RM-SPICE',5,100000),('PK-POUCH200',500,125000),('PK-CARTON20',30,45000),('FG-MK200',50,150000)) v(s,q,v) ON v.s = i.sku;
