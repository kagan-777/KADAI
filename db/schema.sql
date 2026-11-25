-- kadai · Order-to-Audit database (PostgreSQL 14+)
-- Money = integer paise (bigint). Quantities = numeric(18,3) in the item's BASE unit.
-- Stock = append-only ledger; balances are always derived from it.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role    AS ENUM ('salesman','admin','production','auditor','owner');
CREATE TYPE item_type    AS ENUM ('raw','packaging','finished');
CREATE TYPE move_type    AS ENUM ('opening','purchase','production_issue','production_output','dispatch','sales_return','adjustment','cost_adjustment');
CREATE TYPE order_status AS ENUM ('submitted','approved','rejected','invoiced','dispatched','cancelled');
CREATE TYPE doc_status   AS ENUM ('draft','posted','cancelled');

-- ---------- settings, users, audit ----------
CREATE TABLE company_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name text NOT NULL, gstin text, address text,
  state_code char(2) NOT NULL,                      -- GST state code, 33 = Tamil Nadu
  variance_tolerance_bp int NOT NULL DEFAULT 300    -- 300 = 3.00 %
);
CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username text NOT NULL UNIQUE, full_name text NOT NULL,
  password_hash text NOT NULL, role user_role NOT NULL,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(), user_id bigint REFERENCES users(id),
  entity text NOT NULL, entity_id bigint, action text NOT NULL, before jsonb, after jsonb
);
CREATE INDEX ON audit_log (entity, entity_id);

-- ---------- masters ----------
CREATE TABLE units (
  code text PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('mass','volume','count')),
  to_base numeric(18,6) NOT NULL CHECK (to_base > 0)   -- kg, l, pc are base (1)
);
CREATE TABLE items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku text NOT NULL UNIQUE, name text NOT NULL, type item_type NOT NULL,
  base_unit text NOT NULL REFERENCES units(code),
  hsn text, gst_rate_bp int NOT NULL DEFAULT 0 CHECK (gst_rate_bp BETWEEN 0 AND 2800),  -- 500 = 5 %
  sell_price_paise bigint CHECK (sell_price_paise >= 0),            -- finished goods only
  reorder_level numeric(18,3), active boolean NOT NULL DEFAULT true
);
CREATE TABLE item_unit_conversions (            -- e.g. carton of 20 packets for one product
  item_id bigint REFERENCES items(id), unit_code text REFERENCES units(code),
  factor numeric(18,6) NOT NULL CHECK (factor > 0), PRIMARY KEY (item_id, unit_code)
);
CREATE TABLE suppliers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL, gstin text, phone text
);
CREATE TABLE customers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL, kind text NOT NULL CHECK (kind IN ('retailer','distributor')),
  gstin text, address text, state_code char(2) NOT NULL, credit_days int NOT NULL DEFAULT 0,
  salesman_id bigint REFERENCES users(id), active boolean NOT NULL DEFAULT true
);
CREATE TABLE customer_prices (
  customer_id bigint REFERENCES customers(id), item_id bigint REFERENCES items(id),
  rate_paise bigint NOT NULL CHECK (rate_paise >= 0), PRIMARY KEY (customer_id, item_id)
);
CREATE TABLE boms (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES items(id), version int NOT NULL DEFAULT 1,
  yield_qty numeric(18,3) NOT NULL CHECK (yield_qty > 0),   -- packets per batch
  active boolean NOT NULL DEFAULT true, UNIQUE (product_id, version)
);
CREATE TABLE bom_lines (
  bom_id bigint REFERENCES boms(id) ON DELETE CASCADE, item_id bigint REFERENCES items(id),
  qty numeric(18,3) NOT NULL CHECK (qty > 0),               -- per batch, base unit
  PRIMARY KEY (bom_id, item_id)
);
CREATE TABLE stock_batches (                                -- optional batch / expiry tracking
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, item_id bigint NOT NULL REFERENCES items(id),
  batch_no text NOT NULL, mfg_date date, expiry_date date, UNIQUE (item_id, batch_no)
);

-- ---------- the stock ledger (append-only) ----------
CREATE TABLE stock_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  move_date date NOT NULL DEFAULT current_date,
  item_id bigint NOT NULL REFERENCES items(id), batch_id bigint REFERENCES stock_batches(id),
  move move_type NOT NULL,
  qty_delta numeric(18,3) NOT NULL, value_delta bigint NOT NULL,   -- signed, paise
  src_table text NOT NULL, src_id bigint,                          -- traceability
  narration text, posted_by bigint REFERENCES users(id), posted_at timestamptz NOT NULL DEFAULT now(),
  CHECK (qty_delta <> 0 OR move = 'cost_adjustment')
);
CREATE INDEX ON stock_ledger (item_id, move_date);
CREATE INDEX ON stock_ledger (src_table, src_id);

-- ---------- purchases ----------
CREATE TABLE purchases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, supplier_id bigint NOT NULL REFERENCES suppliers(id),
  bill_no text, bill_date date NOT NULL DEFAULT current_date, status doc_status NOT NULL DEFAULT 'draft',
  created_by bigint REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE purchase_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, purchase_id bigint NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_id bigint NOT NULL REFERENCES items(id), qty numeric(18,3) NOT NULL CHECK (qty > 0),
  unit_code text NOT NULL REFERENCES units(code), rate_paise bigint NOT NULL CHECK (rate_paise >= 0), -- per entered unit
  qty_base numeric(18,3), value_paise bigint                                                            -- set on posting
);

-- ---------- sales ----------
CREATE TABLE orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, order_no text UNIQUE,
  client_uuid uuid UNIQUE,                                    -- idempotency key for offline sync
  customer_id bigint NOT NULL REFERENCES customers(id), salesman_id bigint NOT NULL REFERENCES users(id),
  status order_status NOT NULL DEFAULT 'submitted', notes text, reject_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), decided_by bigint REFERENCES users(id), decided_at timestamptz
);
CREATE TABLE order_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id bigint NOT NULL REFERENCES items(id), qty numeric(18,3) NOT NULL CHECK (qty > 0),
  rate_paise bigint NOT NULL CHECK (rate_paise >= 0), UNIQUE (order_id, item_id)
);
CREATE TABLE invoice_sequences (fy text PRIMARY KEY, last_no int NOT NULL);
CREATE TABLE invoices (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_no text NOT NULL UNIQUE, fy text NOT NULL, invoice_date date NOT NULL DEFAULT current_date,
  order_id bigint REFERENCES orders(id), customer_id bigint NOT NULL REFERENCES customers(id),
  customer_name text NOT NULL, customer_gstin text, place_of_supply char(2) NOT NULL, is_interstate boolean NOT NULL,
  taxable_paise bigint NOT NULL DEFAULT 0, cgst_paise bigint NOT NULL DEFAULT 0, sgst_paise bigint NOT NULL DEFAULT 0,
  igst_paise bigint NOT NULL DEFAULT 0, total_paise bigint NOT NULL DEFAULT 0,
  status doc_status NOT NULL DEFAULT 'posted', created_by bigint REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invoice_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, invoice_id bigint NOT NULL REFERENCES invoices(id),
  item_id bigint NOT NULL REFERENCES items(id), description text NOT NULL, hsn text,
  qty numeric(18,3) NOT NULL, rate_paise bigint NOT NULL, taxable_paise bigint NOT NULL, gst_bp int NOT NULL,
  cgst_paise bigint NOT NULL DEFAULT 0, sgst_paise bigint NOT NULL DEFAULT 0, igst_paise bigint NOT NULL DEFAULT 0
);
CREATE TABLE credit_notes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note_no text NOT NULL UNIQUE,
  invoice_id bigint NOT NULL UNIQUE REFERENCES invoices(id), reason text NOT NULL,
  taxable_paise bigint NOT NULL, tax_paise bigint NOT NULL, total_paise bigint NOT NULL,
  created_by bigint REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dispatches (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, invoice_id bigint NOT NULL UNIQUE REFERENCES invoices(id),
  dispatched_on date NOT NULL DEFAULT current_date, dispatched_by bigint REFERENCES users(id), notes text
);
CREATE TABLE payments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_id bigint NOT NULL REFERENCES customers(id),
  paid_on date NOT NULL DEFAULT current_date, amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  mode text NOT NULL CHECK (mode IN ('cash','upi','bank','cheque')), reference text,
  recorded_by bigint REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payment_allocations (
  payment_id bigint REFERENCES payments(id), invoice_id bigint REFERENCES invoices(id),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0), PRIMARY KEY (payment_id, invoice_id)
);

-- ---------- production ----------
CREATE TABLE production_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run_no text NOT NULL UNIQUE,
  bom_id bigint NOT NULL REFERENCES boms(id), product_id bigint NOT NULL REFERENCES items(id),
  run_date date NOT NULL DEFAULT current_date, batches numeric(10,3) NOT NULL DEFAULT 1 CHECK (batches > 0),
  expected_output numeric(18,3) NOT NULL, actual_output numeric(18,3),
  status doc_status NOT NULL DEFAULT 'draft', batch_id bigint REFERENCES stock_batches(id),
  supervisor_id bigint REFERENCES users(id), posted_at timestamptz
);
CREATE TABLE production_issues (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run_id bigint NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
  item_id bigint NOT NULL REFERENCES items(id), planned_qty numeric(18,3) NOT NULL, actual_qty numeric(18,3) NOT NULL CHECK (actual_qty >= 0),
  wastage_qty numeric(18,3) NOT NULL DEFAULT 0 CHECK (wastage_qty >= 0),   -- part of actual_qty that was scrap/damaged
  value_paise bigint, UNIQUE (run_id, item_id)
);
CREATE TABLE production_overheads (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run_id bigint NOT NULL REFERENCES production_runs(id),
  kind text NOT NULL CHECK (kind IN ('labour','gas','power','other')), amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  recorded_by bigint REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);

-- ================= functions =================
CREATE FUNCTION app_user() RETURNS bigint LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::bigint $$;   -- API runs: SET LOCAL app.user_id = '<id>'

CREATE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log(user_id, entity, entity_id, action, before, after)
  VALUES (app_user(), TG_TABLE_NAME, COALESCE(to_jsonb(NEW)->>'id', to_jsonb(OLD)->>'id')::bigint, TG_OP,
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END, CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
  RETURN NULL;
END $$;

CREATE FUNCTION ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'stock_ledger is append-only'; END IF;
  PERFORM 1 FROM items WHERE id = NEW.item_id FOR UPDATE;               -- serialise movements per item
  IF NEW.qty_delta < 0 AND (SELECT COALESCE(SUM(qty_delta),0) FROM stock_ledger WHERE item_id = NEW.item_id) + NEW.qty_delta < 0 THEN
    RAISE EXCEPTION 'Insufficient stock for item %', NEW.item_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_ins BEFORE INSERT ON stock_ledger FOR EACH ROW EXECUTE FUNCTION ledger_guard();
CREATE TRIGGER ledger_mut BEFORE UPDATE OR DELETE ON stock_ledger FOR EACH ROW EXECUTE FUNCTION ledger_guard();

CREATE FUNCTION invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Invoices cannot be deleted; issue a credit note'; END IF;
  IF OLD.status = 'cancelled' THEN RAISE EXCEPTION 'Cancelled invoice is final'; END IF;
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') AND OLD.status = 'posted' THEN
    RAISE EXCEPTION 'Posted invoice cannot be edited; issue a credit note'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_lock BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_guard();

CREATE FUNCTION posted_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s doc_status;
BEGIN
  SELECT status INTO s FROM production_runs WHERE id = COALESCE(NEW.run_id, OLD.run_id);
  IF s <> 'draft' THEN RAISE EXCEPTION 'Posted production run is locked'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER issue_lock BEFORE INSERT OR UPDATE OR DELETE ON production_issues FOR EACH ROW
  WHEN (current_setting('app.posting', true) IS DISTINCT FROM 'on') EXECUTE FUNCTION posted_run_guard();

CREATE FUNCTION allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t bigint; a bigint; pa bigint; pt bigint;
BEGIN
  SELECT total_paise INTO t FROM invoices WHERE id = NEW.invoice_id;
  SELECT COALESCE(SUM(amount_paise),0) INTO a FROM payment_allocations WHERE invoice_id = NEW.invoice_id;
  SELECT COALESCE(SUM(amount_paise),0) INTO pa FROM payment_allocations WHERE payment_id = NEW.payment_id;
  SELECT amount_paise INTO pt FROM payments WHERE id = NEW.payment_id;
  IF a > t THEN RAISE EXCEPTION 'Allocation exceeds invoice outstanding'; END IF;
  IF pa > pt THEN RAISE EXCEPTION 'Allocation exceeds payment amount'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER alloc_chk AFTER INSERT ON payment_allocations DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION allocation_guard();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['items','customers','customer_prices','boms','bom_lines','orders','order_lines','invoices','credit_notes',
                           'payments','production_runs','production_issues','production_overheads','purchases','users'] LOOP
    EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$s FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP; END $$;

CREATE FUNCTION fy_of(d date) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN extract(month FROM d) >= 4
    THEN extract(year FROM d)::int || '-' || lpad(((extract(year FROM d)::int + 1) % 100)::text, 2, '0')
    ELSE (extract(year FROM d)::int - 1) || '-' || lpad((extract(year FROM d)::int % 100)::text, 2, '0') END $$;

CREATE FUNCTION next_invoice_no(d date) RETURNS text LANGUAGE plpgsql AS $$
DECLARE f text := fy_of(d); n int;
BEGIN
  INSERT INTO invoice_sequences(fy, last_no) VALUES (f, 1)
  ON CONFLICT (fy) DO UPDATE SET last_no = invoice_sequences.last_no + 1 RETURNING last_no INTO n;
  RETURN 'INV/' || f || '/' || lpad(n::text, 4, '0');
END $$;

CREATE FUNCTION to_base_qty(p_item bigint, p_qty numeric, p_unit text) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT p_qty * COALESCE((SELECT factor FROM item_unit_conversions WHERE item_id = p_item AND unit_code = p_unit),
                          (SELECT to_base FROM units WHERE code = p_unit)) $$;

CREATE FUNCTION avg_cost(p_item bigint) RETURNS numeric LANGUAGE sql STABLE AS $$       -- weighted average, paise per base unit
  SELECT CASE WHEN COALESCE(SUM(qty_delta),0) > 0 THEN SUM(value_delta)::numeric / SUM(qty_delta) ELSE 0 END
  FROM stock_ledger WHERE item_id = p_item $$;

CREATE FUNCTION post_purchase(p_id bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE l purchase_lines; p purchases;
BEGIN
  SELECT * INTO p FROM purchases WHERE id = p_id FOR UPDATE;
  IF p.status <> 'draft' THEN RAISE EXCEPTION 'Purchase % already %', p_id, p.status; END IF;
  FOR l IN SELECT * FROM purchase_lines WHERE purchase_id = p_id LOOP
    UPDATE purchase_lines SET qty_base = to_base_qty(l.item_id, l.qty, l.unit_code), value_paise = round(l.qty * l.rate_paise) WHERE id = l.id;
    INSERT INTO stock_ledger(move_date, item_id, move, qty_delta, value_delta, src_table, src_id, posted_by)
    VALUES (p.bill_date, l.item_id, 'purchase', to_base_qty(l.item_id, l.qty, l.unit_code), round(l.qty * l.rate_paise), 'purchases', p_id, app_user());
  END LOOP;
  UPDATE purchases SET status = 'posted' WHERE id = p_id;
END $$;

CREATE FUNCTION create_invoice_from_order(p_order bigint) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE o orders; c customers; co company_settings; inv bigint; l record; t bigint; cg bigint; sg bigint; ig bigint; inter boolean;
BEGIN
  SELECT * INTO o FROM orders WHERE id = p_order FOR UPDATE;
  IF o.status <> 'approved' THEN RAISE EXCEPTION 'Order must be approved before invoicing (is %)', o.status; END IF;
  SELECT * INTO c FROM customers WHERE id = o.customer_id;  SELECT * INTO co FROM company_settings;
  inter := c.state_code <> co.state_code;
  INSERT INTO invoices(invoice_no, fy, order_id, customer_id, customer_name, customer_gstin, place_of_supply, is_interstate, status, created_by)
  VALUES (next_invoice_no(current_date), fy_of(current_date), p_order, c.id, c.name, c.gstin, c.state_code, inter, 'draft', app_user()) RETURNING id INTO inv;
  FOR l IN SELECT ol.*, i.name, i.hsn, i.gst_rate_bp FROM order_lines ol JOIN items i ON i.id = ol.item_id WHERE ol.order_id = p_order LOOP
    t := round(l.qty * l.rate_paise);
    IF inter THEN cg := 0; sg := 0; ig := round(t * l.gst_rate_bp / 10000.0);
    ELSE cg := round(t * l.gst_rate_bp / 20000.0); sg := cg; ig := 0; END IF;
    INSERT INTO invoice_lines(invoice_id, item_id, description, hsn, qty, rate_paise, taxable_paise, gst_bp, cgst_paise, sgst_paise, igst_paise)
    VALUES (inv, l.item_id, l.name, l.hsn, l.qty, l.rate_paise, t, l.gst_rate_bp, cg, sg, ig);
  END LOOP;
  UPDATE invoices i SET taxable_paise = s.t, cgst_paise = s.c, sgst_paise = s.s, igst_paise = s.g, total_paise = s.t + s.c + s.s + s.g
  FROM (SELECT SUM(taxable_paise) t, SUM(cgst_paise) c, SUM(sgst_paise) s, SUM(igst_paise) g FROM invoice_lines WHERE invoice_id = inv) s WHERE i.id = inv;
  UPDATE invoices SET status = 'posted' WHERE id = inv;     -- locked from here on
  UPDATE orders SET status = 'invoiced' WHERE id = p_order;
  RETURN inv;
END $$;

CREATE FUNCTION post_dispatch(p_invoice bigint, p_notes text DEFAULT NULL) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE inv invoices; d bigint; l invoice_lines;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = p_invoice FOR UPDATE;
  IF inv.status <> 'posted' THEN RAISE EXCEPTION 'Invoice % is %', inv.invoice_no, inv.status; END IF;
  INSERT INTO dispatches(invoice_id, dispatched_by, notes) VALUES (p_invoice, app_user(), p_notes) RETURNING id INTO d;
  FOR l IN SELECT * FROM invoice_lines WHERE invoice_id = p_invoice LOOP
    INSERT INTO stock_ledger(item_id, move, qty_delta, value_delta, src_table, src_id, posted_by)
    VALUES (l.item_id, 'dispatch', -l.qty, -round(avg_cost(l.item_id) * l.qty), 'dispatches', d, app_user());
  END LOOP;
  UPDATE orders SET status = 'dispatched' WHERE id = inv.order_id;
  RETURN d;
END $$;

CREATE FUNCTION cancel_invoice(p_invoice bigint, p_reason text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE inv invoices; n bigint;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = p_invoice FOR UPDATE;
  IF inv.status <> 'posted' THEN RAISE EXCEPTION 'Invoice already %', inv.status; END IF;
  IF EXISTS (SELECT 1 FROM payment_allocations WHERE invoice_id = p_invoice) THEN RAISE EXCEPTION 'Invoice has payments allocated'; END IF;
  INSERT INTO credit_notes(note_no, invoice_id, reason, taxable_paise, tax_paise, total_paise, created_by)
  VALUES ('CN/' || inv.fy || '/' || lpad(inv.id::text, 4, '0'), p_invoice, p_reason, inv.taxable_paise,
          inv.cgst_paise + inv.sgst_paise + inv.igst_paise, inv.total_paise, app_user()) RETURNING id INTO n;
  UPDATE invoices SET status = 'cancelled' WHERE id = p_invoice;
  RETURN n;
END $$;

CREATE FUNCTION post_production_run(p_run bigint) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE r production_runs; i production_issues; v bigint; tot bigint := 0;
BEGIN
  SELECT * INTO r FROM production_runs WHERE id = p_run FOR UPDATE;
  IF r.status <> 'draft' THEN RAISE EXCEPTION 'Run % already %', r.run_no, r.status; END IF;
  IF COALESCE(r.actual_output, 0) <= 0 THEN RAISE EXCEPTION 'Enter actual output before posting'; END IF;
  PERFORM set_config('app.posting', 'on', true);
  FOR i IN SELECT * FROM production_issues WHERE run_id = p_run LOOP
    v := round(avg_cost(i.item_id) * i.actual_qty);
    INSERT INTO stock_ledger(move_date, item_id, batch_id, move, qty_delta, value_delta, src_table, src_id, posted_by)
    VALUES (r.run_date, i.item_id, NULL, 'production_issue', -i.actual_qty, -v, 'production_runs', p_run, app_user());
    UPDATE production_issues SET value_paise = v WHERE id = i.id;
    tot := tot + v;
  END LOOP;
  INSERT INTO stock_ledger(move_date, item_id, batch_id, move, qty_delta, value_delta, src_table, src_id, posted_by)
  VALUES (r.run_date, r.product_id, r.batch_id, 'production_output', r.actual_output, tot, 'production_runs', p_run, app_user());
  UPDATE production_runs SET status = 'posted', posted_at = now() WHERE id = p_run;
  PERFORM set_config('app.posting', 'off', true);
  RETURN tot;
END $$;

CREATE FUNCTION add_overhead(p_run bigint, p_kind text, p_amount bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r production_runs;
BEGIN
  SELECT * INTO r FROM production_runs WHERE id = p_run;
  INSERT INTO production_overheads(run_id, kind, amount_paise, recorded_by) VALUES (p_run, p_kind, p_amount, app_user());
  IF r.status = 'posted' THEN        -- capitalise into finished-goods value (qty 0, value only)
    INSERT INTO stock_ledger(item_id, move, qty_delta, value_delta, src_table, src_id, narration, posted_by)
    VALUES (r.product_id, 'cost_adjustment', 0, p_amount, 'production_overheads', p_run, p_kind, app_user());
  END IF;
END $$;

-- ================= reporting views =================
CREATE VIEW v_stock_balance AS
SELECT i.id item_id, i.sku, i.name, i.type, i.base_unit, COALESCE(SUM(l.qty_delta),0) qty, COALESCE(SUM(l.value_delta),0) value_paise,
       CASE WHEN COALESCE(SUM(l.qty_delta),0) > 0 THEN round(SUM(l.value_delta)::numeric / SUM(l.qty_delta), 4) ELSE 0 END avg_cost_paise
FROM items i LEFT JOIN stock_ledger l ON l.item_id = i.id GROUP BY i.id;

CREATE VIEW v_stock_ledger AS
SELECT l.*, i.sku, i.name, SUM(l.qty_delta) OVER (PARTITION BY l.item_id ORDER BY l.id) running_qty
FROM stock_ledger l JOIN items i ON i.id = l.item_id;

CREATE VIEW v_order_stock_check AS
SELECT ol.order_id, ol.item_id, i.name, ol.qty ordered, b.qty available, GREATEST(ol.qty - b.qty, 0) shortage
FROM order_lines ol JOIN items i ON i.id = ol.item_id JOIN v_stock_balance b ON b.item_id = ol.item_id;

CREATE VIEW v_invoice_outstanding AS
SELECT i.id invoice_id, i.invoice_no, i.customer_id, i.customer_name, i.invoice_date, i.total_paise,
       COALESCE(SUM(a.amount_paise),0) paid_paise, i.total_paise - COALESCE(SUM(a.amount_paise),0) outstanding_paise,
       i.invoice_date + c.credit_days due_date
FROM invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN payment_allocations a ON a.invoice_id = i.id
WHERE i.status = 'posted' GROUP BY i.id, c.credit_days;

CREATE VIEW v_receivable_ageing AS
SELECT customer_id, customer_name,
  SUM(outstanding_paise) FILTER (WHERE current_date - due_date <= 0) not_due,
  SUM(outstanding_paise) FILTER (WHERE current_date - due_date BETWEEN 1 AND 30) d1_30,
  SUM(outstanding_paise) FILTER (WHERE current_date - due_date BETWEEN 31 AND 60) d31_60,
  SUM(outstanding_paise) FILTER (WHERE current_date - due_date > 60) d60_plus,
  SUM(outstanding_paise) total
FROM v_invoice_outstanding WHERE outstanding_paise > 0 GROUP BY customer_id, customer_name;

CREATE VIEW v_production_variance AS
SELECT r.id run_id, r.run_no, i.item_id, it.name, i.planned_qty, i.actual_qty,
       round((i.actual_qty - i.planned_qty) * 10000 / NULLIF(i.planned_qty,0)) variance_bp,
       abs(round((i.actual_qty - i.planned_qty) * 10000 / NULLIF(i.planned_qty,0))) > cs.variance_tolerance_bp flagged
FROM production_runs r JOIN production_issues i ON i.run_id = r.id JOIN items it ON it.id = i.item_id CROSS JOIN company_settings cs
UNION ALL
SELECT r.id, r.run_no, r.product_id, 'YIELD: ' || it.name, r.expected_output, r.actual_output,
       round((r.actual_output - r.expected_output) * 10000 / r.expected_output),
       abs(round((r.actual_output - r.expected_output) * 10000 / r.expected_output)) > cs.variance_tolerance_bp
FROM production_runs r JOIN items it ON it.id = r.product_id CROSS JOIN company_settings cs WHERE r.actual_output IS NOT NULL;

CREATE VIEW v_run_costing AS
SELECT r.id run_id, r.run_no, it.name product, r.actual_output,
       COALESCE((SELECT SUM(value_paise) FROM production_issues WHERE run_id = r.id),0) material_paise,
       COALESCE((SELECT SUM(amount_paise) FROM production_overheads WHERE run_id = r.id),0) overhead_paise,
       round((COALESCE((SELECT SUM(value_paise) FROM production_issues WHERE run_id = r.id),0)
            + COALESCE((SELECT SUM(amount_paise) FROM production_overheads WHERE run_id = r.id),0))::numeric / NULLIF(r.actual_output,0), 2) cost_per_unit_paise,
       it.sell_price_paise
FROM production_runs r JOIN items it ON it.id = r.product_id WHERE r.status = 'posted';

CREATE VIEW v_sales_register AS
SELECT i.invoice_date, i.invoice_no, i.customer_name, i.customer_gstin, i.place_of_supply, i.is_interstate,
       i.taxable_paise, i.cgst_paise, i.sgst_paise, i.igst_paise, i.total_paise, i.status FROM invoices i;

CREATE VIEW v_gst_summary AS            -- shape for GSTR-1 / 3B outward supplies
SELECT date_trunc('month', i.invoice_date)::date AS month, i.place_of_supply, l.gst_bp, l.hsn,
       SUM(l.taxable_paise) taxable_paise, SUM(l.cgst_paise) cgst_paise, SUM(l.sgst_paise) sgst_paise, SUM(l.igst_paise) igst_paise
FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id WHERE i.status = 'posted' GROUP BY 1,2,3,4;
