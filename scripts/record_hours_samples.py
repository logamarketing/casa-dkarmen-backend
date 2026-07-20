#!/usr/bin/env python3
"""Record one sample call per service state (breakfast / comida / closed).

The agent cannot send the ops clock override itself (that is the point — the
model must never be able to move the clock). So for these recordings ONLY, the
duplicate agent temporarily swaps its real get_daily_menu for a test copy whose
`now_override` is pinned to a constant, and this script PATCHes that constant
between calls. The real tool is restored at the end, always.

Nothing here can place an order: each scenario ends without confirming, and the
closed scenario has no order path to reach.

Usage: ELEVENLABS_API_KEY=... python3 scripts/record_hours_samples.py <agent_id> <test_tool_id>
"""
import asyncio, json, os, sys, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import record_call

KEY = os.environ["ELEVENLABS_API_KEY"]
REAL_MENU_TOOL = "tool_9801kws1pvvxfsh87dr1be8q9kfq"

STATES = [
    ("desayuno", "2026-07-20T09:00", [
        ("say", "Hola, buenos días."),
        ("say", "¿Qué tienen hoy de comer?"),
        ("say", "¿Y no tienen cazuela o algo de comida fuerte?"),
        ("say", "Ah, ok. Gracias, al rato les marco."),
    ]),
    ("comida", "2026-07-20T13:00", [
        ("say", "Hola, buenas tardes."),
        ("say", "¿Qué tienen hoy?"),
        ("say", "¿Y no tienen chilaquiles o algo de desayuno?"),
        ("say", "Está bien, gracias. Luego les marco."),
    ]),
    ("cerrado", "2026-07-20T22:00", [
        ("say", "Hola, buenas noches."),
        ("say", "¿Todavía están abiertos? Quiero pedir algo."),
    ]),
]


def api(path, data=None, method=None):
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1{path}",
        data=json.dumps(data, ensure_ascii=False).encode("utf-8") if data is not None else None,
        headers={"xi-api-key": KEY, "Content-Type": "application/json"},
        method=method or ("POST" if data is not None else "GET"))
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def set_pinned_time(tool_id, when):
    cfg = api(f"/convai/tools/{tool_id}")["tool_config"]
    cfg["api_schema"]["request_body_schema"]["properties"]["now_override"]["constant_value"] = when
    api(f"/convai/tools/{tool_id}", {"tool_config": cfg}, method="PATCH")


def set_agent_tools(agent_id, tool_ids):
    api(f"/convai/agents/{agent_id}",
        {"conversation_config": {"agent": {"prompt": {"tool_ids": tool_ids}}}}, method="PATCH")


def main():
    agent_id, test_tool = sys.argv[1], sys.argv[2]
    original = api(f"/convai/agents/{agent_id}")["conversation_config"]["agent"]["prompt"]["tool_ids"]
    print("original tool_ids:", original)
    swapped = [test_tool if t == REAL_MENU_TOOL else t for t in original]
    results = []
    try:
        set_agent_tools(agent_id, swapped)
        for name, when, scenario in STATES:
            set_pinned_time(test_tool, when)
            record_call.SCENARIO = scenario
            out = f"voice-samples/HOURS-{name}-D.wav"
            print(f"\n--- recording {name} @ {when} -> {out}", flush=True)
            cid = asyncio.run(record_call.main(agent_id, out))
            results.append((name, when, out))
    finally:
        set_agent_tools(agent_id, original)
        restored = api(f"/convai/agents/{agent_id}")["conversation_config"]["agent"]["prompt"]["tool_ids"]
        print("\nRESTORED tool_ids:", restored)
        print("restore OK:", restored == original)
    print("\nrecorded:", results)


if __name__ == "__main__":
    main()
