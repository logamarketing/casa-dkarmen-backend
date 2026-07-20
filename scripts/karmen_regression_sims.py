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
WARM_FAREWELL = "¡Gracias, Juan! Ahí te va tu pedido en un ratito. ¡Que lo disfrutes!"
def submit_payload():
    return {"ok": True, "order_row_id": 999, "spoken_message": WARM_FAREWELL,
            "instruction": "La despedida se dice UNA sola vez y SOLO a través de end_call: llama end_call AHORA con el spoken_message completo como mensaje. NO escribas tú ningún texto de despedida — el sistema la dirá al colgar."}

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
        # Required when a tool maps system__conversation_id (the simulator does
        # not populate system dynamic variables on its own).
        "dynamic_variables": {"system__conversation_id": f"sim-{tag}-{name}"},
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

# 2026-07-20 (eleven_v3_conversational): the transcript text for this TTS model
# arrives with spurious mid-word spaces from streaming chunk boundaries —
# observed verbatim in ksim_finalD1_pickup: "dos cientos cuarenta pesos por los
# tam ales gratinados", "¿Me reg alas tu nombre". No LLM emits "tam ales"; the
# spoken audio is correct (Scribe-verified on the sibling expressive battery).
# Matching ONLY the spaced form silently fails the exact-total assertion (a
# false FAIL) and — worse, in the leak harness — could hide a real leak whose
# marker got split. Every content assertion therefore also runs against a
# despaced copy of the text with a despaced pattern.
def despace(s):
    return re.sub(r"\s+", "", s)

NUM_260_DS = re.compile(r"doscientossesenta|260", re.I)
NUM_240_DS = re.compile(r"doscientoscuarenta|240", re.I)
DS_OF = {NUM_260: NUM_260_DS, NUM_240: NUM_240_DS}

def hit(pattern, text):
    """True if pattern matches the text as-is OR its despaced form."""
    if pattern.search(text):
        return True
    ds = DS_OF.get(pattern)
    return bool(ds and ds.search(despace(text)))


# 2026-07-20 (second K13 miss): the first despacing fix covered only the number
# and farewell patterns. check_empty's regexes were left raw and R3 then FAILED
# on CORRECT behavior — "el menú de hoy todavía  no está carg ado" carries both
# a doubled space and a split word, so `todav[ií]a no` and `no est[aá] cargado`
# both missed. The false-negative direction is worse: a split "tam ales" would
# have slipped past DISH_WORDS and hidden a genuine invented dish. Any pattern
# used as a content assertion goes through here, not through .search() directly.
_ds_cache = {}


def matches(pattern, text):
    """Match `pattern` against the text, tolerating the TTS whitespace artifact."""
    if pattern.search(text):
        return True
    key = pattern.pattern
    if key not in _ds_cache:
        _ds_cache[key] = re.compile(re.sub(r"\\b|\s+", "", key), re.I)
    return bool(_ds_cache[key].search(despace(text)))
# 2026-07-18: window widened 40->90 chars — warm phrasings like "¿para recoger
# aquí en la fonda o prefieres que te lo llevemos a domicilio?" span >40 chars
# between the two mode words (verified false positive on ksim_dupanoto_delivery).
MODE_Q = re.compile(r"(recoger|domicilio).{0,90}(recoger|domicilio)|para recoger o", re.I)
# 2026-07-19: widened for warm phrasings ("ahorita no tengo cargado el menú",
# "no tengo el menú del día") — verified honest-but-unmatched on ksim_warm1_empty.
HONEST_EMPTY = re.compile(r"(no est[aá] (cargado|listo)|a[uú]n no|todav[ií]a no|no tenemos el men[uú]|no tengo (cargado|el men[uú])|ahorita no (tengo|hay))", re.I)
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
# 2026-07-20: an "invented promotion" assertion lived here briefly and was
# REMOVED — it failed CORRECT behavior. The free Té de Jazmín on pickup is a
# REAL, owner-confirmed promotion carried in the attached "Información" KB doc
# ("Promoción: si recoges, recibes 1 té Jazmín gratis con tu orden" / "Pick-up
# promo: 1 té Jazmín gratis con tu orden para llevar"). Karmen surfacing it is
# the KB working as designed, and the 3/3-pickup-vs-0/3-delivery pattern that
# looked like "reproducible fabrication" was her correctly applying a
# pickup-only rule. Do NOT re-add a gate that bans free-gift language: it
# would fail her for being right. Any future version must check the offer
# against the KB + the item's real price, not against the prompt alone.
TOTAL_FRAME = re.compile(r"ser[ií]an?\b|\btotal\b|queda en|\bson\b", re.I)
# 2026-07-20: a bare total-WORD is not a total-QUOTE. Observed false FAIL on
# ksim_hoursV6_pickup turn 5 — "están a ciento veinte pesos cada uno. ¿Para
# recoger o a domicilio? Así te digo el total exacto" is the textbook CORRECT
# turn (unit price + mode question + total explicitly deferred), but the word
# "total" alone satisfied TOTAL_FRAME and overrode the unit-price exemption.
# A quote requires the total-framing to actually sit next to a number.
# "un"/"una" are deliberately EXCLUDED: they are articles far more often than
# numerals, and including them made "te digo el total en un momento" read as a
# quote. A one-peso total is not a real case; a bare "un" is not evidence.
NUMWORD = (r"(?:\d+|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|veinte|treinta|"
           r"cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|cientos|mil)")
TOTAL_FRAME_NEAR_NUM = re.compile(
    rf"(?:ser[ií]an?|\btotal\b|queda en|\bson\b)(?:\W+\w+){{0,2}}\W+{NUMWORD}", re.I)

def check_order_flow(out, num_re, label):
    seq = turns(out)
    asked_mode_at = spoke_peso_at = spoke_total_at = compute_at = None
    for i, (role, msg, tools) in enumerate(seq):
        if role == "agent":
            if asked_mode_at is None and MODE_Q.search(msg):
                asked_mode_at = i
            if (spoke_peso_at is None and PESO_RE.search(msg)
                    and re.search(r"\d|cientos|veinte|cuarenta|sesenta", msg, re.I)
                    and (matches(TOTAL_FRAME_NEAR_NUM, msg) or not matches(UNIT_FRAME, msg))):
                spoke_peso_at = i
            if spoke_total_at is None and hit(num_re, msg):
                spoke_total_at = i
        if "compute_total" in tools and compute_at is None:
            compute_at = i
    ok_mode_first = asked_mode_at is not None and (spoke_peso_at is None or asked_mode_at < spoke_peso_at)
    ok_total = spoke_total_at is not None and compute_at is not None and spoke_total_at > compute_at

    # Naturalness-pass assertions (2026-07-19, rev 2):
    # (a) The farewell is delivered VERBATIM from submit_order's spoken_message,
    #     after submit_order, and EXACTLY ONCE — either as a spoken agent turn
    #     OR inside end_call's message param (the chosen design: the platform
    #     speaks end_call's message at hangup; both at once = double goodbye).
    snippet = WARM_FAREWELL[1:20].lower()
    snippet_ds = despace(snippet)  # v3_conversational mid-word-space artifact
    submit_at = None
    farewell_hits = []  # (index, where)
    raw = out.get("simulated_conversation", [])
    for i, t in enumerate(raw):
        tools_full = t.get("tool_calls") or []
        names = [tc.get("tool_name") for tc in tools_full]
        if "submit_order" in names and submit_at is None:
            submit_at = i
        msg = (t.get("message") or "")
        if t.get("role") == "agent" and (snippet in msg.lower() or snippet_ds in despace(msg.lower())):
            farewell_hits.append((i, "spoken"))
        for tc in tools_full:
            if tc.get("tool_name") != "end_call":
                continue
            params = (tc.get("params_as_json") or "").lower()
            if snippet in params or snippet_ds in despace(params):
                farewell_hits.append((i, "end_call_message"))
    ok_farewell = (len(farewell_hits) == 1 and submit_at is not None
                   and farewell_hits[0][0] > submit_at)
    # (b) No call-state narration, ever.
    ok_no_callstate = not any(role == "agent" and re.search(r"llamada ha (finalizado|terminada|terminado)", msg, re.I) for role, msg, _ in seq)
    # (c) Variety: no single ack-word 3+ times across the call's agent turns.
    ACKS = ["perfecto", "claro", "listo", "con gusto", "muy bien"]
    ack_counts = {}
    for role, msg, _ in seq:
        if role == "agent":
            low = msg.lower()
            for a in ACKS:
                if a in low:
                    ack_counts[a] = ack_counts.get(a, 0) + 1
    repeats = {a: c for a, c in ack_counts.items() if c >= 3}
    ok_variety = not repeats

    passed = ok_mode_first and ok_total and ok_farewell and ok_no_callstate and ok_variety
    print(f"[{label}] asked_mode@{asked_mode_at} first_peso@{spoke_peso_at} "
          f"compute@{compute_at} exact_total@{spoke_total_at} "
          f"farewell_verbatim_after_submit={ok_farewell} no_callstate={ok_no_callstate} "
          f"variety_ok={ok_variety}{' repeats=' + str(repeats) if repeats else ''} -> {'PASS' if passed else 'FAIL'}")
    return passed

def check_empty(out, label):
    seq = turns(out)
    honest = any(role == "agent" and matches(HONEST_EMPTY, msg) for role, msg, _ in seq)
    invented = any(role == "agent" and matches(DISH_WORDS, msg) for role, msg, _ in seq)
    priced = any(role == "agent" and matches(PESO_RE, msg) for role, msg, _ in seq)
    passed = honest and not invented and not priced
    print(f"[{label}] honest_empty={honest} invented_dishes={invented} spoke_prices={priced} -> {'PASS' if passed else 'FAIL'}")
    return passed

if __name__ == "__main__":
    agent_id, tag = sys.argv[1], sys.argv[2]
    mocks_delivery = {
        "get_daily_menu": {"default_return_value": json.dumps(MENU, ensure_ascii=False), "default_is_error": False},
        "compute_total": {"default_return_value": json.dumps(total_payload("delivery", 20, 260), ensure_ascii=False), "default_is_error": False},
        "order_ready": {"default_return_value": "{\"ok\":true}", "default_is_error": False},
        "submit_order": {"default_return_value": json.dumps(submit_payload(), ensure_ascii=False), "default_is_error": False}}
    mocks_pickup = {
        "get_daily_menu": {"default_return_value": json.dumps(MENU, ensure_ascii=False), "default_is_error": False},
        "compute_total": {"default_return_value": json.dumps(total_payload("pickup", 0, 240), ensure_ascii=False), "default_is_error": False},
        "order_ready": {"default_return_value": "{\"ok\":true}", "default_is_error": False},
        "submit_order": {"default_return_value": json.dumps(submit_payload(), ensure_ascii=False), "default_is_error": False}}
    mocks_empty = {
        "get_daily_menu": {"default_return_value": json.dumps(MENU_EMPTY, ensure_ascii=False), "default_is_error": False},
        "compute_total": {"default_return_value": json.dumps(MENU_EMPTY, ensure_ascii=False), "default_is_error": False},
        "order_ready": {"default_return_value": "{\"ok\":true}", "default_is_error": False},
        "submit_order": {"default_return_value": json.dumps(submit_payload(), ensure_ascii=False), "default_is_error": False}}

    r1 = sim(agent_id, BASE_USER.replace("{MODE}", "a domicilio"), mocks_delivery, tag, "delivery")
    p1 = check_order_flow(r1, NUM_260, "R1 delivery 260")
    r2 = sim(agent_id, BASE_USER.replace("{MODE}", "para recoger"), mocks_pickup, tag, "pickup")
    p2 = check_order_flow(r2, NUM_240, "R2 pickup 240")
    r3 = sim(agent_id, EMPTY_USER, mocks_empty, tag, "empty")
    p3 = check_empty(r3, "R3 menu_not_set")
    print("REGRESSION GATE:", "ALL PASS" if (p1 and p2 and p3) else "FAILED")
    sys.exit(0 if (p1 and p2 and p3) else 2)
