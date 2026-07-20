#!/usr/bin/env python3
"""expressive_mode ON vs OFF on eleven_v3_conversational — real-call battery.

Reuses voice_latency_ab's harness (same no-order scenario, same server-side
metrics). Flips ONLY tts.expressive_mode between interleaved calls; model stays
eleven_v3_conversational throughout. Also greps every agent transcript turn for
bracketed audio tags ([laughs] etc.) leaking into TEXT — with expressive mode
the TTS must consume them, and the discipline checks (verbatim farewell) would
break if the LLM starts wrapping speech in tags.

Usage: python3 scripts/expressive_ab.py <agent_id> <outdir>
"""
import json, os, re, sys, time, asyncio, statistics as st
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import voice_latency_ab as vab

ARMS = {"OFF": False, "ON": True}
ORDER = ["OFF", "ON", "OFF", "ON", "OFF", "ON", "OFF", "ON"]
TAG_RE = re.compile(r"\[[a-záéíóú ]{2,20}\]", re.I)


def main():
    agent_id, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    for text in vab.LINES:
        vab.caller_pcm(text)
    calls = []
    current = None
    for i, arm in enumerate(ORDER):
        if ARMS[arm] != current:
            vab.api(f"/convai/agents/{agent_id}",
                    {"conversation_config": {"tts": {"model_id": "eleven_v3_conversational",
                                                     "expressive_mode": ARMS[arm]}}},
                    method="PATCH")
            current = ARMS[arm]
            time.sleep(2)
        wav = os.path.join(outdir, f"expr_{i:02d}_{arm}.wav")
        try:
            cid = asyncio.run(vab.run_call(agent_id, wav))
            print(f"[{i:02d}] {arm}: {cid}", flush=True)
            calls.append({"i": i, "arm": arm, "conversation_id": cid})
        except Exception as e:
            print(f"[{i:02d}] {arm}: FAILED {type(e).__name__}: {e}", flush=True)
            calls.append({"i": i, "arm": arm, "conversation_id": None,
                          "error": f"{type(e).__name__}: {e}"})
        json.dump(calls, open(os.path.join(outdir, "expr_manifest.json"), "w"), indent=1)
        time.sleep(3)

    print("\n--- metrics + tag scan ---", flush=True)
    agg = {a: {f: [] for f in vab.FIELDS} for a in ARMS}
    tag_hits = {a: [] for a in ARMS}
    for c in calls:
        if not c.get("conversation_id"):
            continue
        s = vab.fetch_metrics(c["conversation_id"])
        for f in vab.FIELDS:
            agg[c["arm"]][f].extend(s[f])
        d = vab.api(f"/convai/conversations/{c['conversation_id']}")
        for t in d.get("transcript", []):
            if t.get("role") == "agent" and TAG_RE.search(t.get("message") or ""):
                tag_hits[c["arm"]].append((c["i"], (t.get("message") or "")[:120]))
    for f in vab.FIELDS:
        print(vab.LABELS[f])
        for a in ARMS:
            xs = sorted(agg[a][f])
            if not xs:
                print(f"  {a:3s} (no data)"); continue
            p25 = xs[int(0.25 * (len(xs) - 1))]
            p75 = xs[int(0.75 * (len(xs) - 1))]
            print(f"  {a:3s} n={len(xs):>3} median={st.median(xs):>6.0f}ms  p25={p25:>6.0f}  p75={p75:>6.0f}")
        print()
    for a, hits in tag_hits.items():
        print(f"audio-tags-in-transcript {a}: {len(hits)}" + (f" {hits}" if hits else ""))


if __name__ == "__main__":
    main()
