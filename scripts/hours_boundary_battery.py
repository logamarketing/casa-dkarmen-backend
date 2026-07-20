#!/usr/bin/env python3
"""V6 hours/service-window boundary battery — real HTTP against karmen-gateway.

Drives the ops-only `now_override` (never model-facing) across every boundary the
owner specified and asserts the gateway's behaviour, not the prompt's:

  7:49 closed | 7:50 desayuno | 11:30 desayuno | 11:31 comida
  16:49 comida | 16:50 closed | Sunday any time closed

and, per window, that ONLY the valid categories come back and that the order
path is refused when closed or when an item is out of window.

Credentials come from loga-secrets/.env.local (read path). The order path needs
KARMEN_ORDER_SECRET / _NEW passed via env KARMEN_ORDER_SECRET.

Usage: python3 scripts/hours_boundary_battery.py [--with-order]
"""
import json, os, sys, urllib.request, urllib.error

URL = "https://edcjcehfedwxxucktxoj.supabase.co/functions/v1/karmen-gateway"
ENVFILE = os.path.expanduser("~/Projects/loga-secrets/.env.local")

MON = "2026-07-20"  # Monday
SUN = "2026-07-26"  # Sunday


def env(name):
    for line in open(ENVFILE):
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


ANON = env("CASA_DKARMEN_SUPABASE_ANON_KEY")
READ_SECRET = env("KARMEN_SHARED_SECRET")
ORDER_SECRET = os.environ.get("KARMEN_ORDER_SECRET", "")

fails = []


def call(payload, order=False):
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {ANON}",
    }
    headers["x-karmen-order-secret" if order else "x-karmen-secret"] = (
        ORDER_SECRET if order else READ_SECRET)
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   {detail}" if detail and not cond else ""))
    if not cond:
        fails.append(label)


print("=== A. WINDOW BOUNDARIES (get_daily_menu) ===")
for date, hhmm, want_closed, want_window in [
    (MON, "07:49", True, None), (MON, "07:50", False, "desayuno"),
    (MON, "11:30", False, "desayuno"), (MON, "11:31", False, "comida"),
    (MON, "16:49", False, "comida"), (MON, "16:50", True, None),
    (MON, "03:00", True, None), (MON, "22:00", True, None),
    (SUN, "12:00", True, None), (SUN, "09:00", True, None),
]:
    st, r = call({"action": "get_daily_menu", "now_override": f"{date}T{hhmm}"})
    if want_closed:
        check(f"{date} {hhmm} -> closed", r.get("closed") is True, json.dumps(r)[:160])
        check(f"{date} {hhmm} -> spoken_message present", bool(r.get("spoken_message")))
        check(f"{date} {hhmm} -> no menu items", r.get("item_count") == 0)
    else:
        check(f"{date} {hhmm} -> open/{want_window}",
              r.get("closed") is False and r.get("window") == want_window, json.dumps(r)[:160])

print("\n=== B. CATEGORY FILTERING PER WINDOW ===")
for hhmm, window, must_be_empty, must_have in [
    ("09:00", "desayuno", "comida", "desayuno"),
    ("13:00", "comida", "desayuno", "comida"),
]:
    st, r = call({"action": "get_daily_menu", "now_override": f"{MON}T{hhmm}"})
    menu = r.get("menu", {})
    check(f"{hhmm} {window}: '{must_be_empty}' empty", len(menu.get(must_be_empty, [])) == 0,
          f"got {len(menu.get(must_be_empty, []))}")
    check(f"{hhmm} {window}: '{must_have}' present", len(menu.get(must_have, [])) > 0)
    # bebidas/extras stay available in BOTH windows (the promo tea is a bebida)
    check(f"{hhmm} {window}: bebidas still offered", len(menu.get("bebida", [])) > 0)
    tea = [i for i in menu.get("bebida", []) if "jazm" in i.get("name", "").lower()]
    check(f"{hhmm} {window}: Té de Jazmín quotable (promo)", len(tea) > 0)

print("\n=== C. compute_total BLOCKED WHEN CLOSED ===")
st, r = call({"action": "compute_total", "now_override": f"{MON}T22:00", "modalidad": "pickup",
              "items": [{"nombre": "Flautas", "categoria": "comida", "cantidad": 1}]})
check("closed compute_total -> closed:true", r.get("closed") is True, json.dumps(r)[:200])
check("closed compute_total -> NO total", "total" not in r, json.dumps(r)[:200])
check("closed compute_total -> spoken_message", bool(r.get("spoken_message")))

print("\n=== D. compute_total BLOCKED OFF-WINDOW ===")
st, r = call({"action": "get_daily_menu", "now_override": f"{MON}T13:00"})
comida_name = (r.get("menu", {}).get("comida") or [{}])[0].get("name")
st, r2 = call({"action": "get_daily_menu", "now_override": f"{MON}T09:00"})
desayuno_name = (r2.get("menu", {}).get("desayuno") or [{}])[0].get("name")
print(f"  (using comida='{comida_name}', desayuno='{desayuno_name}')")

st, r = call({"action": "compute_total", "now_override": f"{MON}T09:00", "modalidad": "pickup",
              "items": [{"nombre": comida_name, "categoria": "comida", "cantidad": 1}]})
check("comida dish at 09:00 -> off_window", r.get("off_window") is True, json.dumps(r)[:200])
check("comida dish at 09:00 -> NO total", "total" not in r)

st, r = call({"action": "compute_total", "now_override": f"{MON}T13:00", "modalidad": "pickup",
              "items": [{"nombre": desayuno_name, "categoria": "desayuno", "cantidad": 1}]})
check("desayuno dish at 13:00 -> off_window", r.get("off_window") is True, json.dumps(r)[:200])
check("desayuno dish at 13:00 -> NO total", "total" not in r)

print("\n=== E. IN-WINDOW QUOTES STILL WORK (no regression) ===")
st, r = call({"action": "compute_total", "now_override": f"{MON}T13:00", "modalidad": "pickup",
              "items": [{"nombre": comida_name, "categoria": "comida", "cantidad": 1}]})
check("comida dish at 13:00 -> real total", isinstance(r.get("total"), (int, float)) and r.get("total") > 0,
      json.dumps(r)[:200])
check("comida dish at 13:00 -> not off_window", not r.get("off_window"))
st, r = call({"action": "compute_total", "now_override": f"{MON}T09:00", "modalidad": "pickup",
              "items": [{"nombre": desayuno_name, "categoria": "desayuno", "cantidad": 1}]})
check("desayuno dish at 09:00 -> real total", isinstance(r.get("total"), (int, float)) and r.get("total") > 0,
      json.dumps(r)[:200])

print("\n=== F. now_override IS OPS-ONLY / VALIDATED ===")
st, r = call({"action": "get_daily_menu", "now_override": "not-a-time"})
check("garbage now_override -> 400", st == 400, f"{st} {json.dumps(r)[:120]}")
st, r = call({"action": "get_daily_menu", "now_override": f"{MON}T99:99"})
check("out-of-range now_override -> 400", st == 400, f"{st} {json.dumps(r)[:120]}")

if "--with-order" in sys.argv and ORDER_SECRET:
    print("\n=== G. submit_order BLOCKED (closed + off-window) ===")
    base = {"action": "submit_order", "cliente_nombre": "PRUEBA HORARIO", "telefono": "6870000000",
            "modalidad": "pickup", "metodo_de_pago": "cash", "cash_amount": "200", "dry_run": True}
    st, r = call({**base, "now_override": f"{MON}T22:00", "total": 120,
                  "items": [{"nombre": comida_name, "categoria": "comida", "cantidad": 1}],
                  "conversation_id": "hours-test-closed"}, order=True)
    check("closed submit_order -> closed:true", r.get("closed") is True, json.dumps(r)[:220])
    check("closed submit_order -> order_placed false", r.get("order_placed") is False)
    check("closed submit_order -> no order_row_id", "order_row_id" not in r)

    st, r = call({**base, "now_override": f"{MON}T09:00", "total": 120,
                  "items": [{"nombre": comida_name, "categoria": "comida", "cantidad": 1}],
                  "conversation_id": "hours-test-offwindow"}, order=True)
    check("off-window submit_order -> off_window", r.get("off_window") is True, json.dumps(r)[:220])
    check("off-window submit_order -> order_placed false", r.get("order_placed") is False)
    check("off-window submit_order -> no order_row_id", "order_row_id" not in r)

    print("\n=== H. IN-WINDOW submit_order STILL WORKS (dry_run) ===")
    st, r = call({**base, "now_override": f"{MON}T13:00", "total": 120,
                  "items": [{"nombre": comida_name, "categoria": "comida", "cantidad": 1}],
                  "conversation_id": "hours-test-inwindow"}, order=True)
    check("in-window submit_order -> ok, not blocked",
          r.get("ok") is True and not r.get("closed") and not r.get("off_window"), json.dumps(r)[:260])
else:
    print("\n(=== G/H submit_order tests skipped: no KARMEN_ORDER_SECRET ===)")

print("\n" + ("ALL BOUNDARY TESTS PASS" if not fails else f"{len(fails)} FAILURES: {fails}"))
sys.exit(0 if not fails else 2)
