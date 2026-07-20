#!/usr/bin/env python3
"""Re-scan finished conversations with the CURRENT leak scanner.

Why this exists: a battery run loads `scan()` at process start, so a scanner
fix landed mid-run does not apply to results already printed. Re-scanning the
server-side transcript (the authoritative record) with the current patterns is
what makes a "0 leaks" claim mean anything — see K13, where a TTS transcript
artifact could split a marker past the old scanner.

Usage: python3 scripts/rescan_leaks.py <conversation_id> [conversation_id ...]
"""
import json, os, sys, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("ELEVENLABS_API_KEY", "x")
import importlib.util

spec = importlib.util.spec_from_file_location(
    "lh", os.path.join(os.path.dirname(os.path.abspath(__file__)), "karmen_leak_harness.py"))
lh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lh)

KEY = open(".el_key").read().strip()


def conv(cid):
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/convai/conversations/{cid}", headers={"xi-api-key": KEY})
    return json.load(urllib.request.urlopen(req))


def main():
    total_turns = total_leaks = 0
    tools_fired = []
    for cid in sys.argv[1:]:
        d = conv(cid)
        turns = leaks = 0
        for t in d.get("transcript", []):
            for tc in (t.get("tool_calls") or []):
                tools_fired.append((cid, tc.get("tool_name")))
            if t.get("role") != "agent":
                continue
            msg = (t.get("message") or "").strip()
            if not msg:
                continue
            turns += 1
            hits = lh.scan(msg)
            if hits:
                leaks += 1
                print(f"  LEAK {cid} turn{turns}: {hits}")
                print(f"       text: {msg[:200]}")
        print(f"{cid}: agent_turns={turns} leak_turns={leaks}")
        total_turns += turns
        total_leaks += leaks
    ordering = [t for t in tools_fired if t[1] in ("order_ready", "submit_order")]
    print(f"\nTOTAL agent turns: {total_turns}")
    print(f"TOTAL leak turns : {total_leaks}")
    print(f"ordering-tool fires: {ordering if ordering else 'NONE'}")


if __name__ == "__main__":
    main()
