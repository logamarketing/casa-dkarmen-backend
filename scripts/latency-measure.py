#!/usr/bin/env python3
"""Karmen latency measurement — real per-turn ms from the ElevenLabs conversation API.

Pulls the last N real calls for the agent and reports median ASR/LLM/TTS + end-of-turn
metrics. ONLY real audio calls carry these metrics; simulate-conversation returns
conversation_turn_metrics=None, so this cannot be run against simulated conversations.

Usage:
  ELEVENLABS_API_KEY=... python3 scripts/latency-measure.py [N]     # default N=8
  # or it reads the key from ./.el_key

Metric fields (seconds in the API; printed as ms):
  convai_llm_service_ttfb            LLM time-to-first-byte  (the core LLM latency)
  convai_llm_service_ttf_sentence    LLM time-to-first-sentence
  convai_tts_service_ttfb            TTS time-to-first-byte
  convai_ttf_audio_since_silence     end-of-turn: user-silence -> first audio (turn detect + ASR + LLM + TTS)
NOTE: there is NO discrete ASR-latency field (convai_asr_provider is null).

Dedupe: tool-continuation turns repeat the prior turn's LLM value; identical
consecutive values within a call are dropped so medians reflect distinct invocations.
"""
import json, os, sys, urllib.request, statistics as st

AGENT = "agent_9901k5y1nqype69akbe3j8swwwat"
API = "https://api.elevenlabs.io/v1/convai"
FIELDS = ["convai_llm_service_ttfb", "convai_llm_service_ttf_sentence",
          "convai_tts_service_ttfb", "convai_ttf_audio_since_silence"]
LABELS = {"convai_llm_service_ttfb": "LLM TTFB",
          "convai_llm_service_ttf_sentence": "LLM time-to-first-sentence",
          "convai_tts_service_ttfb": "TTS TTFB",
          "convai_ttf_audio_since_silence": "End-of-turn (silence->first audio)"}


def key():
    k = os.environ.get("ELEVENLABS_API_KEY")
    if not k and os.path.exists(".el_key"):
        k = open(".el_key").read().strip()
    if not k:
        sys.exit("No API key (ELEVENLABS_API_KEY or ./.el_key)")
    return k


def get(url, k):
    req = urllib.request.Request(url, headers={"xi-api-key": k})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    k = key()
    lst = get(f"{API}/conversations?agent_id={AGENT}&page_size={n}", k)
    cids = [c["conversation_id"] for c in lst.get("conversations", [])][:n]
    agg = {f: [] for f in FIELDS}
    llms = set()
    for cid in cids:
        d = get(f"{API}/conversations/{cid}", k)
        prev = {f: None for f in FIELDS}
        for t in d.get("transcript", []):
            if t.get("role") != "agent":
                continue
            m = (t.get("conversation_turn_metrics") or {}).get("metrics") or {}
            for f in FIELDS:
                v = m.get(f)
                val = v.get("elapsed_time") if isinstance(v, dict) else None
                if val is None:
                    continue
                if prev[f] is not None and abs(val - prev[f]) < 1e-9:
                    prev[f] = val
                    continue
                agg[f].append(val * 1000.0)
                prev[f] = val
    print(f"Calls sampled: {len(cids)}")
    print(f"{'metric':38s} {'n':>4} {'median':>9} {'p25':>7} {'p75':>7}")
    for f in FIELDS:
        xs = sorted(agg[f])
        if not xs:
            print(f"{LABELS[f]:38s} {'0':>4}   (no data)")
            continue
        p25 = xs[int(0.25 * (len(xs) - 1))]
        p75 = xs[int(0.75 * (len(xs) - 1))]
        print(f"{LABELS[f]:38s} {len(xs):>4} {st.median(xs):>8.0f}ms {p25:>6.0f} {p75:>6.0f}")
    print("\nASR latency: not exposed as a discrete field (convai_asr_provider=null).")


if __name__ == "__main__":
    main()
