-- Demo snack recipes: each BOM makes 200 x 200 g packets.
-- GST and HSN are placeholders for demonstration; verify them before live billing.
INSERT INTO items(sku,name,type,base_unit,hsn,gst_rate_bp,sell_price_paise) VALUES
  ('RM-RICEFLOUR','Rice flour','raw','kg',NULL,0,NULL),
  ('RM-BESAN','Gram flour (besan)','raw','kg',NULL,0,NULL),
  ('RM-PEANUT','Peanuts','raw','kg',NULL,0,NULL),
  ('RM-POHA','Flattened rice (poha)','raw','kg',NULL,0,NULL),
  ('RM-FRIEDGRAM','Fried gram','raw','kg',NULL,0,NULL),
  ('FG-MIX200','Mixture 200 g','finished','pkt','[DEMO HSN]',500,5000),
  ('FG-RP200','Ribbon Pakoda 200 g','finished','pkt','[DEMO HSN]',500,5000),
  ('FG-KS200','Kara Sev 200 g','finished','pkt','[DEMO HSN]',500,5000)
ON CONFLICT (sku) DO NOTHING;

INSERT INTO item_unit_conversions(item_id,unit_code,factor)
SELECT id,'carton',20 FROM items WHERE sku IN ('FG-MIX200','FG-RP200','FG-KS200')
ON CONFLICT (item_id,unit_code) DO NOTHING;

INSERT INTO boms(product_id,yield_qty)
SELECT id,200 FROM items WHERE sku IN ('FG-MIX200','FG-RP200','FG-KS200')
ORDER BY CASE sku WHEN 'FG-MIX200' THEN 1 WHEN 'FG-RP200' THEN 2 ELSE 3 END
ON CONFLICT (product_id,version) DO NOTHING;

INSERT INTO bom_lines(bom_id,item_id,qty)
SELECT b.id,i.id,v.qty
FROM (VALUES
  ('FG-MIX200','RM-POHA',15::numeric),('FG-MIX200','RM-BESAN',8),('FG-MIX200','RM-PEANUT',5),
  ('FG-MIX200','RM-FRIEDGRAM',5),('FG-MIX200','RM-RICEFLOUR',6),('FG-MIX200','RM-SPICE',1),
  ('FG-MIX200','RM-OIL',10),('FG-MIX200','PK-POUCH200',200),('FG-MIX200','PK-CARTON20',10),
  ('FG-RP200','RM-RICEFLOUR',25),('FG-RP200','RM-BESAN',15),('FG-RP200','RM-SPICE',1.2),
  ('FG-RP200','RM-OIL',8),('FG-RP200','PK-POUCH200',200),('FG-RP200','PK-CARTON20',10),
  ('FG-KS200','RM-BESAN',30),('FG-KS200','RM-RICEFLOUR',10),('FG-KS200','RM-SPICE',1.2),
  ('FG-KS200','RM-OIL',8),('FG-KS200','PK-POUCH200',200),('FG-KS200','PK-CARTON20',10)
) AS v(product_sku,ingredient_sku,qty)
JOIN items p ON p.sku=v.product_sku
JOIN boms b ON b.product_id=p.id AND b.version=1
JOIN items i ON i.sku=v.ingredient_sku
WHERE NOT EXISTS (
  SELECT 1 FROM bom_lines existing WHERE existing.bom_id=b.id AND existing.item_id=i.id
);

INSERT INTO customer_prices(customer_id,item_id,rate_paise)
SELECT c.id,i.id,5000
FROM customers c CROSS JOIN items i
WHERE c.active AND i.sku IN ('FG-MIX200','FG-RP200','FG-KS200')
ON CONFLICT (customer_id,item_id) DO NOTHING;

-- One batch of ingredients, packaging and finished goods for each demo product.
-- Extra oil and packaging let the original Murukku run and all three new runs be demonstrated.
WITH starter(sku,qty,value_paise) AS (VALUES
  ('RM-OIL',30::numeric,420000::bigint),
  ('PK-POUCH200',500,125000),('PK-CARTON20',30,45000),
  ('RM-RICEFLOUR',41,205000),('RM-BESAN',53,424000),('RM-PEANUT',5,75000),
  ('RM-POHA',15,75000),('RM-FRIEDGRAM',5,60000),
  ('FG-MIX200',50,150000),('FG-RP200',50,150000),('FG-KS200',50,150000)
)
INSERT INTO stock_ledger(item_id,move,qty_delta,value_delta,src_table,narration)
SELECT i.id,'opening',s.qty,s.value_paise,'snack_setup','Starter stock for demo snacks'
FROM starter s JOIN items i ON i.sku=s.sku
WHERE NOT EXISTS (
  SELECT 1 FROM stock_ledger existing
  WHERE existing.item_id=i.id AND existing.src_table='snack_setup'
    AND existing.narration='Starter stock for demo snacks'
);
