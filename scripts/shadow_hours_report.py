#!/usr/bin/env python3
"""Pre-cutover shadow report for the business-hours rules (V6 / V17 / V18).

Answers the ONE question that gates the cutover:

    Across REAL traffic since the corrected shadow layer deployed, would the
    hours rule have wrongly refused or wrongly filtered anyone during open hours?

Reads `voice_events` and reports, per event:
  * the window the rule WOULD have applied (`shadow:<window>`),
  * whether that window matches the row's own wall-clock local_time,
  * what the menu filter WOULD have served vs what was actually served,
  * which quote/order lines the rule WOULD have refused.

V18 guard: this script FAILS LOUD if the shadow data is decorative — i.e. if
`window_item_count` never differs from `item_count` on an open-hours menu read.
A shadow layer whose output can't differ from the unfiltered output proves
nothing, and reporting it as "clean" is how a bad cutover gets signed off.

Usage:
    SUPABASE_ACCESS_TOKEN=... python3 scripts/shadow_hours_report.py [since_iso_utc]

Default `since` is the corrected layer's deploy time. Pass an ISO UTC timestamp
to widen or narrow the window.

Pointing this at a new client: change PROJECT_REF, TZ, and the window rules in
`expected_window()` to match that client's hours. Everything else is generic.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

PROJECT_REF = "edcjcehfedwxxucktxoj"
TZ_OFFSET = timedelta(hours=-7)  # America/Mazatlan, no DST
# Corrected shadow layer (get_daily_menu + compute_total) went live at 19:31:00Z;
# the submit_order half followed at ~19:34Z. Rows before this are the OLD,
# decorative instrumentation and must not be counted as evidence (V18).
DEFAULT_SINCE = "2026-07-20 19:31:00+00"

OPEN_MIN, BREAKFAST_END_MIN, CLOSE_MIN = 7 * 60 + 50, 11 * 60 + 30, 16 * 60 + 50

TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
if not TOKEN:
    sys.exit("SUPABASE_ACCESS_TOKEN is not set.")


def q(sql: str):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query",
        data=json.dumps({"query": sql}).encode(),
        # An explicit User-Agent is REQUIRED: the Management API answers 403 to
        # urllib's default "Python-urllib/3.x" while accepting the same token
        # from curl. A 403 here is a UA problem, not a credentials problem.
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json",
                 "User-Agent": "karmen-shadow-report/1.0"},
        method="POST",
    )
    return json.load(urllib.request.urlopen(req, timeout=60))


def expected_window(local_hhmm: str, weekday: int) -> str:
    """The window the clock alone implies — an INDEPENDENT recomputation, so a
    bug in the gateway's own serviceWindow() cannot validate itself."""
    if weekday == 6:  # Python Sunday == 6
        return "closed"
    h, m = (int(x) for x in local_hhmm.split(":"))
    mins = h * 60 + m
    if mins < OPEN_MIN or mins >= CLOSE_MIN:
        return "closed"
    return "desayuno" if mins <= BREAKFAST_END_MIN else "comida"


def main() -> int:
    since = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SINCE
    rows = q(
        "select id, event_type, created_at, "
        "payload->>'window' as win, payload->>'hours_enforced' as enf, "
        "payload->>'local_time' as local_time, "
        "payload->>'conversation_id' as conv, "
        "payload->>'item_count' as item_count, "
        "payload->>'window_item_count' as window_item_count, "
        "payload->>'off_window_would_block' as would_block, "
        "payload->>'off_window_blocked' as blocked, "
        "payload->>'total' as total, payload->>'time_overridden' as overridden "
        f"from voice_events where created_at > '{since}' "
        "and payload ? 'window' order by id;"
    )
    if isinstance(rows, dict):
        sys.exit(f"Query failed: {rows.get('message')}")

    real = [r for r in rows if (r.get("overridden") or "false") != "true"]
    tests = len(rows) - len(real)
    with_conv = [r for r in real if r.get("conv")]

    print(f"Shadow rows since {since}: {len(rows)}  "
          f"(real: {len(real)}, pinned-clock tests excluded: {tests})")
    print(f"Rows carrying a conversation_id (a real call): {len(with_conv)}\n")

    mismatches, wrong_refusals, filtered, decorative_evidence = [], [], [], []

    for r in real:
        win = (r.get("win") or "")
        shadow = win.split("shadow:")[-1] if win.startswith("shadow:") else win
        lt, created = r.get("local_time"), r.get("created_at")
        if lt and created:
            # Postgres renders the offset as "+00"; fromisoformat needs "+00:00"
            # (and cannot parse a trailing "Z" before Python 3.11).
            iso = created.replace("Z", "+00:00")
            if len(iso) > 3 and iso[-3] in "+-":
                iso += ":00"
            dt = datetime.fromisoformat(iso).astimezone(timezone(TZ_OFFSET))
            exp = expected_window(lt, dt.weekday())
            if exp != shadow:
                mismatches.append((r["id"], r["event_type"], lt, shadow, exp))

        wb = r.get("would_block")
        if wb and wb not in ("[]", "null"):
            entry = (r["id"], r["event_type"], lt, shadow, wb)
            (wrong_refusals if shadow in ("desayuno", "comida") else filtered).append(entry)

        if r["event_type"] == "get_daily_menu" and shadow in ("desayuno", "comida"):
            ic, wic = r.get("item_count"), r.get("window_item_count")
            if ic is not None and wic is not None:
                decorative_evidence.append(ic != wic)

    print("--- WINDOW CORRECTNESS (recomputed independently from each row's clock) ---")
    if mismatches:
        print(f"  {len(mismatches)} MISMATCH(ES) — the rule computed a window the clock does not imply:")
        for m in mismatches:
            print(f"    id={m[0]} {m[1]} local={m[2]} computed={m[3]} expected={m[4]}")
    else:
        print("  PASS — every computed window matched its wall-clock time.")

    print("\n--- WOULD-BE REFUSALS DURING OPEN HOURS (the expensive direction) ---")
    if wrong_refusals:
        print(f"  {len(wrong_refusals)} request(s) would have been refused while OPEN:")
        for w in wrong_refusals:
            print(f"    id={w[0]} {w[1]} local={w[2]} window={w[3]} would_block={w[4]}")
        print("  -> Each needs a human read: legitimately off-window (a breakfast dish")
        print("     ordered at lunch is a CORRECT refusal), or a real false positive?")
    else:
        print("  NONE — no open-hours request would have been refused.")

    print("\n--- V18 GUARD: is the shadow layer actually simulating? ---")
    if not decorative_evidence:
        print("  INCONCLUSIVE — no open-hours menu reads yet. Cannot certify the layer.")
        verdict_ok = False
    elif not any(decorative_evidence):
        print("  FAIL — window_item_count NEVER differed from item_count.")
        print("  The shadow layer is decorative (V18). Do NOT cut over on this data.")
        verdict_ok = False
    else:
        n = sum(1 for d in decorative_evidence if d)
        print(f"  PASS — {n}/{len(decorative_evidence)} open-hours menu reads show the")
        print("  filtered count differing from the unfiltered count. The layer is live.")
        verdict_ok = True

    print("\n=== VERDICT ===")
    if verdict_ok and not mismatches and not wrong_refusals:
        print("  Shadow data supports the cutover. No wrongful refusal or filtering seen.")
        if not with_conv:
            print("  CAVEAT: no row carried a conversation_id — this is harness traffic,")
            print("  not real customer calls. Weigh accordingly.")
        return 0
    print("  DO NOT CUT OVER on this data alone — see the failures above.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
