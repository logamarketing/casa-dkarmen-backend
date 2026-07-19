#!/usr/bin/env python3
"""Karmen Stage 2 regression gate — three mocked simulate-conversation runs.

Gate checks (all must PASS):
  R1 delivery: asks recoger/domicilio BEFORE any peso amount; speaks exactly the
     mocked compute_total total (260) after mode is known; order_ready allowed
     (mocked, no side effects).
  R2 pickup: same, total 240.
  R3 menu_not_set: honestly says today's menu isn't loaded; offers to check
     later / transfer; never lists dishes or prices.
All tools are MOCKED — zero live side effects.

Usage: ELEVENLABS_API_KEY=... python3 karmen_regression_sims.py <agent_id> <tag>
"""
import json, re, sys, os, urllib.request, urllib.error

KEY = os.environ["ELEVENLABS_API_KEY"]
SCRATCH = os.path.dirname(os.path.abspath(__file__))

MENU = {"ok": True, "service_date": "2026-07-17", "timezone": "America/Mazatlan",
        "currency": "MXN", "menu_available": True, "item_count": 3,
        "menu": {"desayuno": [], "comida": [{"name": "Tamales Gratinados", "price": 120},
                                            {"name": "Cazuela", "price": 120}],
                 "bebida": [{"name": "Agua de Jamaica", "price": 25}], "extra": []}}
MENU_EMPTY = {"ok": True, "service_date": "2026-07-17", "timezone": "America/Mazatlan",
              "currency": "MXN", "menu_available": False, "item_count": 0,
              "menu": {"desayuno": [], "comida": [], "bebida": [], "extra": []},
              "menu_not_set": True,
              "instruction": "El menú de hoy aún no está cargado. No inventes platillos ni precios; ofrece verificar o transferir con una persona."}
def total_payload(mode, fee, total):
    return {"ok": True, "service_date": "2026-07-17", "currency": "MXN", "modalidad": mode,
            "breakdown": [{"nombre": "Tamales Gratinados", "categoria": "comida",
                           "unit_price": 120, "cantidad": 2, "line_total": 240}],
            "subtotal": 240, "delivery_fee": fee, "total": total,
            "all_matched": True, "unmatched": []}

BASE_USER = """Eres un cliente que llama por teléfono a Casa D'Karmen. Hablas español, respuestas cortas y naturales.
Tu pedido: dos Tamales Gratinados. Nada más.
REGLAS ESTRICTAS:
1. NO digas si es para recoger o a domicilio hasta que la agente te lo PREGUNTE explícitamente.
2. Justo después de pedir los tamales, pregunta "¿cuánto sería?" — ANTES de que se sepa la modalidad.
3. Cuando la agente pregunte si es para recoger o a domicilio, responde "{MODE}".
4. Datos si te los piden: te llamas Juan Pérez, teléfono 6871234567, dirección Calle Obregón 123, entre Juárez y Morelos, colonia Centro. Pagas con quinientos pesos en efectivo.
5. Cuando te digan el total, di que está bien.
6. No pidas bebidas ni nada más."""

EMPTY_USER = """Eres un cliente que llama a Casa D'Karmen. Hablas español, corto y natural.
1. Pregunta qué hay hoy en el menú.
2. Si te dicen que no está listo o no está cargado, pregunta "¿entonces no puedo pedir nada?".
3. Después despídete y cuelga. No insistas más de eso, no pidas nada."""

def sim(agent_id, user_prompt, mocks, tag, name):
    body = {"simulation_specification": {
        "simulated_user_config": {"language": "es", "prompt": {"prompt": user_prompt}},
        "tool_mock_config": mocks}}
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/convai/agents/{agent_id}/simulate-conversation",
        data=json.dumps(body, ensure_ascii=False).encode(),
        headers={"xi-api-key": KEY, "Content-Type": "application/json"}, method="POST")
    out = json.load(urllib.request.urlopen(req, timeout=280))
    json.dump(out, open(os.path.join(SCRATCH, f"ksim_{tag}_{name}.json"), "w"),
              ensure_ascii=False, indent=1)
    return out

PESO_RE = re.compile(r"(\bpesos?\b|\$\s*\d)", re.I)
NUM_260 = re.compile(r"doscientos sesenta|\b260\b", re.I)
NUM_240 = re.compile(r"doscientos cuarenta|\b240\b", re.I)
# 2026-07-18: window widened 40->90 chars — warm phrasings like "¿para recoger
# aquí en la fonda o prefieres que te lo llevemos a domicilio?" span >40 chars
# between the two mode words (verified false positive on ksim_dupanoto_delivery).
MODE_Q = re.compile(r"(recoger|domicilio).{0,90}(recoger|domicilio)|para recoger o", re.I)
HONEST_EMPTY = re.compile(r"(no est[aá] (cargado|listo)|a[uú]n no|todav[ií]a no|no tenemos el men[uú])", re.I)
DISH_WORDS = re.compile(r"tamal|cazuela|jamaica|chile|enchilada", re.I)

def turns(out):
    seq = []
    for t in out.get("simulated_conversation", []):
        msg = (t.get("message") or "").strip()
        tools = [tc.get("tool_name") for tc in (t.get("tool_calls") or [])]
        seq.append((t.get("role"), msg, tools))
    return seq

# 2026-07-18: K9 forbids a TOTAL before mode — a menu UNIT price ("los tamales
# están a ciento veinte pesos cada uno") is a legitimate menu read, not a quote.
# Verified false positive on ksim_dupv3_pickup turn 4 (unit price + mode question
# in the same turn). A peso amount counts as a quote unless it is unit-framed
# without any total-framing.
UNIT_FRAME = re.compile(r"cada un[oa]|est[áa]n? a\b|cuesta", re.I)
TOTAL_FRAME = re.compile(r"ser[ií]an?\b|\btotal\b|queda en|\bson\b", re.I)

def check_order_flow(out, num_re, label):
    seq = turns(out)
    asked_mode_at = spoke_peso_at = spoke_total_at = compute_at = None
    for i, (role, msg, tools) in enumerate(seq):
        if role == "agent":
            if asked_mode_at is None and MODE_Q.search(msg):
                asked_mode_at = i
            if (spoke_peso_at is None and PESO_RE.search(msg)
                    and re.search(r"\d|cientos|veinte|cuarenta|sesenta", msg, re.I)
                    and (TOTAL_FRAME.search(msg) or not UNIT_FRAME.search(msg))):
                spoke_peso_at = i
            if spoke_total_at is None and num_re.search(msg):
                spoke_total_at = i
        if "compute_total" in tools and compute_at is None:
            compute_at = i
    ok_mode_first = asked_mode_at is not None and (spoke_peso_at is None or asked_mode_at < spoke_peso_at)
    ok_total = spoke_total_at is not None and compute_at is not None and spoke_total_at > compute_at
    passed = ok_mode_first and ok_total
    print(f"[{label}] asked_mode@{asked_mode_at} first_peso@{spoke_peso_at} "
          f"compute@{compute_at} exact_total@{spoke_total_at} -> {'PASS' if passed else 'FAIL'}")
    return passed

def check_empty(out, label):
    seq = turns(out)
    honest = any(role == "agent" and HONEST_EMPTY.search(msg) for role, msg, _ in seq)
    invented = any(role == "agent" and DISH_WORDS.search(msg) for role, msg, _ in seq)
    priced = any(role == "agent" and PESO_RE.search(msg) for role, msg, _ in seq)
    passed = honest and not invented and not priced
    print(f"[{label}] honest_empty={honest} invented_dishes={invented} spoke_prices={priced} -> {'PASS' if passed else 'FAIL'}")
    return passed

if __name__ == "__main__":
    agent_id, tag = sys.argv[1], sys.argv[2]
    mocks_delivery = {
        "get_daily_menu": {"default_return_value": json.dumps(MENU, ensure_ascii=False), "default_is_error": False},
        "compute_total": {"default_return_value": json.dumps(total_payload("delivery", 20, 260), ensure_ascii=False), "default_is_error": False},
        "order_ready": {"default_return_value": "{\"ok\":true}", "default_is_error": False}}
    mocks_pickup = {
        "get_daily_menu": {"default_return_value": json.dumps(MENU, ensure_ascii=False), "default_is_error": False},
        "compute_total": {"default_return_value": json.dumps(total_payload("pickup", 0, 240), ensure_ascii=False), "default_is_error": False},
        "order_ready": {"default_return_value": "{\"ok\":true}", "default_is_error": False}}
    mocks_empty = {
        "get_daily_menu": {"default_return_value": json.dumps(MENU_EMPTY, ensure_ascii=False), "default_is_error": False},
        "compute_total": {"default_return_value": json.dumps(MENU_EMPTY, ensure_ascii=False), "default_is_error": False},
        "order_ready": {"default_return_value": "{\"ok\":true}", "default_is_error": False}}

    r1 = sim(agent_id, BASE_USER.replace("{MODE}", "a domicilio"), mocks_delivery, tag, "delivery")
    p1 = check_order_flow(r1, NUM_260, "R1 delivery 260")
    r2 = sim(agent_id, BASE_USER.replace("{MODE}", "para recoger"), mocks_pickup, tag, "pickup")
    p2 = check_order_flow(r2, NUM_240, "R2 pickup 240")
    r3 = sim(agent_id, EMPTY_USER, mocks_empty, tag, "empty")
    p3 = check_empty(r3, "R3 menu_not_set")
    print("REGRESSION GATE:", "ALL PASS" if (p1 and p2 and p3) else "FAILED")
    sys.exit(0 if (p1 and p2 and p3) else 2)
