
# Browser test: clicks through the full benchmark in the real UI. Needs: pip install playwright && playwright install chromium
import os, re, shutil, sys, tempfile
from playwright.sync_api import sync_playwright
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
VIDEO_PATH = os.environ.get("UI_VIDEO_PATH")
fails = []; errors = []
def check(name, cond):
    print(("PASS  " if cond else "FAIL  ") + name); 
    if not cond: fails.append(name)
with sync_playwright() as p:
    b = p.chromium.launch()
    video_dir = tempfile.mkdtemp(prefix="kadai-ui-video-") if VIDEO_PATH else None
    context_options = {"viewport": {"width": 1280, "height": 900}, "accept_downloads": True, "color_scheme": "dark"}
    if video_dir:
        context_options.update(record_video_dir=video_dir, record_video_size={"width": 1280, "height": 900})
    ctx = b.new_context(**context_options); pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "status of 4" not in m.text else None)
    def login(role_label, user):
        pg.goto(BASE); pg.evaluate("localStorage.clear()"); pg.reload()
        pg.click(f".tile:has-text('{role_label}')"); pg.fill("#u", user); pg.fill("#pw", "kadai123"); pg.click("[data-a=login]")
        pg.wait_for_selector(".side")
    def nav(label): pg.click(f".nav:has-text('{label}')"); pg.wait_for_timeout(400)
    def text(): return pg.inner_text("body")
    def produce_snack(name):
        nav("Production")
        option = pg.locator("#run-bom option").filter(has_text=name).first
        pg.select_option("#run-bom", value=option.get_attribute("value"))
        pg.click("[data-a=new-run]"); pg.wait_for_selector(f"h3:has-text('{name}')")
        pg.fill("#run-out", "200"); pg.click("[data-a=post-run]")
        pg.wait_for_selector(".msg.ok:has-text('Run posted')")
        check(f"{name} production posted", name in text() and "Run posted" in text())
    pg.goto(BASE)
    check("dark scheme is active", pg.locator("body").evaluate("(el) => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()") == "#0F1915")
    palettes = {
        "mint-teal": ("#DBE8D7", "#01949B"),
        "black-scallop": ("#161E2B", "#DEB3A3"),
        "desert-blue": ("#1F273E", "#DC9851"),
        "sun-navy": ("#154360", "#FFDB58")
    }
    for theme, expected in palettes.items():
        pg.select_option("#theme-select", theme)
        actual = pg.locator("html").evaluate("(el) => { const s = getComputedStyle(el); return [s.getPropertyValue('--bg').trim(), s.getPropertyValue('--lime').trim()]; }")
        check(f"{theme} palette colors", actual == list(expected))
    pg.select_option("#theme-select", "black-scallop"); pg.reload()
    check("theme choice persists after reload", pg.input_value("#theme-select") == "black-scallop" and pg.locator("html").evaluate("(el) => getComputedStyle(el).getPropertyValue('--bg').trim()") == "#161E2B")
    pg.select_option("#theme-select", "system")
    # role mismatch
    pg.goto(BASE); pg.click(".tile:has-text('Salesman')"); pg.fill("#u", "admin"); pg.fill("#pw", "kadai123"); pg.click("[data-a=login]"); pg.wait_for_selector("#login-err:not(:empty)")
    check("role mismatch shows error", "not a salesman account" in text())
    # production: purchase, run, overheads
    login("Production supervisor", "production")
    check("production menu has no Sales/Collections", "Sales orders" not in text() and "Collections" not in text())
    nav("Purchases")
    pg.select_option("#pu-item", label="Flour (kg)"); pg.fill("#pu-qty", "60"); pg.select_option("#pu-unit", "kg"); pg.fill("#pu-rate", "45"); pg.fill("#pu-bill", "GRN-001"); pg.click("[data-a=new-purchase]")
    pg.wait_for_selector(".ok"); check("purchase posted", "Purchase posted" in text())
    nav("Production"); pg.select_option("#run-bom", index=0); pg.fill("#run-bno", "MK200-001"); pg.click("[data-a=new-run]"); pg.wait_for_selector("[data-issue]")
    for item, qty, w in [(1, "40", "0"), (2, "10.5", "0"), (3, "1.2", "0"), (4, "194", "6"), (5, "9", "0")]:
        pg.fill(f"[data-issue='{item}']", qty); pg.fill(f"[data-waste='{item}']", w)
    pg.fill("#run-out", "188"); pg.click("[data-a=post-run]"); pg.wait_for_selector("text=Planned vs actual")
    t = text(); check("yield -6.0% flagged", "-6.0%" in t); check("oil +5.0% flagged", "5.0%" in t)
    pg.fill("#oh-amt", "1200"); pg.select_option("#oh-kind", "labour"); pg.click("[data-a=overhead]"); pg.wait_for_selector("tr:has-text('labour')")
    pg.fill("#oh-amt", "600"); pg.select_option("#oh-kind", "gas"); pg.click("[data-a=overhead]"); pg.wait_for_selector("tr:has-text('gas')"); pg.wait_for_timeout(400)
    check("cost per packet ₹31.14", "₹31.14" in text())
    nav("Inventory"); t = text(); check("inventory shows flour 120", re.search(r"Flour\s+raw\s+120", t) is not None); check("finished goods 238", re.search(r"Murukku 200 g\s+finished\s+238", t) is not None)
    for snack in ["Mixture 200 g", "Ribbon Pakoda 200 g", "Kara Sev 200 g"]:
        produce_snack(snack)
    nav("Inventory"); t = text()
    for snack in ["Mixture 200 g", "Ribbon Pakoda 200 g", "Kara Sev 200 g"]:
        check(f"{snack} stock is 250", re.search(re.escape(snack) + r"\s+finished\s+250", t) is not None)
    # salesman A
    login("Salesman", "salesman_a")
    check("salesman A selects assigned retailer type", pg.input_value("#cust-type") == "retailer" and pg.locator("#cust option").all_inner_texts() == ["Retailer A · 33", "Retailer C · 33", "Retailer E · 33"])
    check("all four snack products are orderable", all(name in text() for name in ["Murukku 200 g", "Mixture 200 g", "Ribbon Pakoda 200 g", "Kara Sev 200 g"]))
    pg.locator("label:has-text('Murukku 200 g') input[data-item]").fill("150"); check("live total ₹7,500", pg.inner_text("#tot") == "₹7,500"); pg.click("[data-a=submit-order]"); pg.wait_for_selector(".ok")
    check("order visible in My orders", "SO-1" in text() and "submitted" in text())
    pg.goto(BASE + "/#sales-orders"); pg.wait_for_timeout(500); check("salesman blocked from sales-orders", "Access denied" in text())
    # salesman B
    login("Salesman", "salesman_b")
    check("salesman B selects assigned distributor type", pg.input_value("#cust-type") == "distributor" and pg.locator("#cust option").all_inner_texts() == ["Distributor B · 29", "Distributor D · 33"])
    pg.locator("label:has-text('Murukku 200 g') input[data-item]").fill("120"); pg.click("[data-a=submit-order]"); pg.wait_for_selector(".ok")
    # admin
    login("Factory admin", "admin"); nav("Sales orders")
    pg.click("tr:has-text('SO-1') [data-a=approve]"); pg.wait_for_selector("tr:has-text('SO-1') [data-a=invoice]"); pg.click("tr:has-text('SO-1') [data-a=invoice]"); pg.wait_for_selector("text=Total ₹7,875")
    check("invoice ₹7,875 with CGST+SGST", "CGST ₹187.50" in text() and "SGST ₹187.50" in text())
    pg.click("tr:has-text('SO-1') [data-a=dispatch]"); pg.wait_for_selector("text=Dispatched")
    with ctx.expect_page() as popup: pg.click("[data-a=pdf]")
    check("invoice PDF opens", popup.value is not None); popup.value.close()
    pg.wait_for_selector("tr:has-text('SO-2'):has-text('Short 32')"); check("shortage 32 shown after A is dispatched", True)
    pg.click("tr:has-text('SO-2') [data-a=approve]"); pg.wait_for_selector("tr:has-text('SO-2') [data-a=invoice]"); pg.click("tr:has-text('SO-2') [data-a=invoice]"); pg.wait_for_selector("text=Total ₹6,300")
    check("Distributor B uses IGST", "IGST ₹300" in text() and "CGST" not in text().split("Total ₹6,300")[0][-200:])
    pg.click("tr:has-text('SO-2') [data-a=dispatch]"); pg.wait_for_timeout(700)
    check("dispatch blocked: insufficient stock", "Insufficient stock" in text())
    nav("Collections"); pg.fill("#pay-1", "4000"); pg.click("[data-a=pay][data-id='1']"); pg.wait_for_selector(".ok")
    check("outstanding ₹3,875 for Retailer A", "₹3,875" in text())
    # auditor
    login("Accountant", "auditor"); check("auditor sees only audit screens", "Sales orders" not in text() and "Monthly audit" in text())
    pg.select_option("#rep", "gst-summary"); pg.click("[data-a=run-report]"); pg.wait_for_timeout(600); check("GST summary rows", "₹187.50" in text() and "₹300" in text())
    with pg.expect_download() as d: pg.click("[data-a=csv]")
    check("CSV export downloads", d.value.suggested_filename == "gst-summary.csv")
    pg.select_option("#rep", "audit-log"); pg.click("[data-a=run-report]"); pg.wait_for_timeout(600); t = text()
    t = t.lower()
    check("audit log explains before and after", "before" in t and "after" in t and "no previous record (created)" in t)
    pg.goto(BASE + "/#collections"); pg.wait_for_timeout(500); check("auditor blocked from collections", "Access denied" in text())
    login("Owner", "owner"); pg.wait_for_timeout(500); t = text()
    check("owner dashboard", "receivables" in t.lower() and "cost per packet" in t.lower() and "₹24.55" in t)
    check("owner month comparison chart and table", pg.locator(".owner-month-chart").count() == 1 and all(label in t for label in ["Sales before GST", "GST on invoices", "Payments received", "Monthly totals"]))
    video = pg.video if VIDEO_PATH else None
    ctx.close()
    if video:
        os.makedirs(os.path.dirname(os.path.abspath(VIDEO_PATH)), exist_ok=True)
        video.save_as(VIDEO_PATH)
        shutil.rmtree(video_dir)
    b.close()
check("no browser console/page errors", not errors)
if errors: print(errors)
print("\nALL PASSED" if not fails else f"\n{len(fails)} FAILED: {fails}"); sys.exit(1 if fails else 0)
