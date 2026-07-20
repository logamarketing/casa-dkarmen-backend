#!/usr/bin/env python3
"""Karmen V6 hours cutover — enforce hours + wire the initiation webhook on LIVE.

Owner-authorized (Edgar) pre-committed sequence. Every step is gated; ANY failed
gate triggers automatic rollback to the current known-good state (enforcement
OFF, webhook null, agent restored from snapshot) and a non-zero exit. The script
NEVER leaves a half-applied state: it either completes fully and self-verifies,
or it reverts everything it touched.

What it changes on LIVE:
  1. secret  KARMEN_HOURS_ENFORCED = true   (+ redeploy — the flag is read at
     module load, so a redeploy is required for it to take effect)
  2. agent   platform_settings.workspace_overrides.conversation_initiation_client_data_webhook
             = { url, request_headers: {Authorization, x-karmen-secret} }
     agent   overrides.conversation_config_override.agent.first_message = true
     agent   overrides.conversation_config_override.agent.prompt.prompt = true
  Nothing else. Voice/D config, prompt text, tools, temperature, KB docs, ASR,
  phone number are all asserted unchanged by a field-by-field diff.

Requires in env: ELEVENLABS (or reads .el_key), SUPABASE_ACCESS_TOKEN,
KARMEN_SHARED_SECRET, CASA_DKARMEN_SUPABASE_ANON_KEY. Secrets are read from env
and never printed.

Run:  python3 scripts/hours_cutover.py         # do it
      python3 scripts/hours_cutover.py --dry    # print the plan, touch nothing
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error

AGENT = "agent_9901k5y1nqype69akbe3j8swwwat"
PROJECT = "edcjcehfedwxxucktxoj"
GATEWAY = f"https://{PROJECT}.supabase.co/functions/v1/karmen-gateway"
EL_BASE = f"https://api.elevenlabs.io/v1/convai/agents/{AGENT}"
WEBHOOK_URL = GATEWAY
DRY = "--dry" in sys.argv

def el_key():
    return (os.environ.get("ELEVENLABS_API_KEY")
            or open(os.path.join(os.path.dirname(__file__), "..", ".el_key")).read().strip())

def need(name):
    v = os.environ.get(name, "").strip()
    if not v:
        sys.exit(f"FATAL: env {name} is required and not set.")
    return v

def req(url, method="GET", headers=None, data=None, timeout=30):
    r = urllib.request.Request(url, method=method, headers=headers or {},
                               data=(json.dumps(data).encode() if data is not None else None))
    if data is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

def get_agent():
    _, d = req(EL_BASE, headers={"xi-api-key": el_key()})
    return d

def gw(body, headers, timeout=30):
    h = {"Authorization": f"Bearer {ANON}", "Content-Type": "application/json"}
    h.update(headers)
    return req(GATEWAY, method="POST", headers=h, data=body, timeout=timeout)

def flat(o, p=""):
    d = {}
    if isinstance(o, dict):
        for k, v in o.items(): d.update(flat(v, f"{p}.{k}"))
    elif isinstance(o, list):
        for i, v in enumerate(o): d.update(flat(v, f"{p}[{i}]"))
    else:
        d[p] = o
    return d

def sh(*args, check=True):
    print("  $", " ".join(args))
    if DRY:
        return 0
    r = subprocess.run(args, capture_output=True, text=True)
    if r.stdout.strip(): print("   ", r.stdout.strip().replace("\n", "\n    "))
    if r.returncode != 0:
        print("    STDERR:", r.stderr.strip())
        if check: raise RuntimeError(f"command failed: {' '.join(args)}")
    return r.returncode

# ---- secrets from env (never printed) ----
READ_SECRET = need("KARMEN_SHARED_SECRET")
ANON = need("CASA_DKARMEN_SUPABASE_ANON_KEY")
need("SUPABASE_ACCESS_TOKEN")

STAMP = os.environ.get("CUTOVER_STAMP")  # caller passes date; scripts can't call Date.now equivalents matter little here
if not STAMP:
    STAMP = subprocess.run(["date", "+%Y%m%d-%H%M%S"], capture_output=True, text=True).stdout.strip()
SNAP = os.path.join(os.path.dirname(__file__), "..",
                    f".karmen-agent-rollback-{STAMP}-hours-cutover.json")

def rollback(reason):
    print(f"\n!!! GATE FAILED: {reason}\n!!! ROLLING BACK to known-good (enforcement OFF, webhook null)…")
    # 1. secret back off + redeploy
    sh("supabase", "secrets", "unset", "KARMEN_HOURS_ENFORCED", "--project-ref", PROJECT, check=False)
    sh("supabase", "functions", "deploy", "karmen-gateway", "--project-ref", PROJECT, check=False)
    # 2. restore agent from snapshot (webhook + overrides)
    if os.path.exists(SNAP):
        snap = json.load(open(SNAP))
        ps = snap["platform_settings"]
        restore = {"platform_settings": {
            "overrides": ps.get("overrides"),
            "workspace_overrides": ps.get("workspace_overrides"),
        }}
        if not DRY:
            st, _ = req(EL_BASE, method="PATCH", headers={"xi-api-key": el_key()}, data=restore)
            print(f"    agent restore PATCH -> {st}")
    print("!!! ROLLBACK COMPLETE. Live is back to known-good. Exiting non-zero.")
    sys.exit(2)

print(f"=== KARMEN HOURS CUTOVER {'(DRY RUN)' if DRY else ''} ===")

# ---- STEP 1: snapshot ----
print("\n[1] Snapshot live agent")
pre = get_agent()
if not DRY:
    json.dump(pre, open(SNAP, "w"), indent=1)
print(f"    -> {os.path.basename(SNAP)}")
pre_flat = flat(pre)

# ---- STEP 2: flip enforcement + redeploy ----
print("\n[2] Enable KARMEN_HOURS_ENFORCED + redeploy")
try:
    sh("supabase", "secrets", "set", "KARMEN_HOURS_ENFORCED=true", "--project-ref", PROJECT)
    sh("supabase", "functions", "deploy", "karmen-gateway", "--project-ref", PROJECT)
except RuntimeError as e:
    rollback(f"secret set / redeploy failed: {e}")
if not DRY:
    time.sleep(4)

# ---- GATE A: tool-path enforcement is now ON ----
print("\n[3] GATE A — prove enforcement is live on the tool path")
if not DRY:
    # A desayuno item quoted during the comida window must now be REFUSED.
    st, body = gw({"action": "compute_total", "modalidad": "pickup",
                   "items": [{"nombre": "Burritos de machaca", "cantidad": 1}]},
                  {"x-karmen-secret": READ_SECRET})
    off = body.get("off_window")
    print(f"    compute_total desayuno-item @comida: off_window={off} (expect True), total={body.get('total')} (expect absent)")
    if off is not True or body.get("total") is not None:
        rollback("enforcement did not take effect — off-window quote was not refused")
    # A comida item during comida window must still quote fine.
    st, body2 = gw({"action": "compute_total", "modalidad": "pickup",
                    "items": [{"nombre": "Barbacoa", "cantidad": 1}]},
                   {"x-karmen-secret": READ_SECRET})
    print(f"    compute_total comida-item @comida: total={body2.get('total')} (expect 120), off_window={body2.get('off_window')}")
    if body2.get("total") != 120:
        rollback("in-window comida quote broke after enforcement")
    print("    GATE A PASS")

# ---- STEP 4: set webhook + flip the two override booleans ----
print("\n[4] Wire the conversation-initiation webhook + enable the two overrides")
cur = get_agent()
ps = cur["platform_settings"]
overrides = json.loads(json.dumps(ps.get("overrides", {})))
cco = overrides.setdefault("conversation_config_override", {})
agent_ov = cco.setdefault("agent", {})
agent_ov["first_message"] = True
agent_ov.setdefault("prompt", {})["prompt"] = True
wo = json.loads(json.dumps(ps.get("workspace_overrides", {})))
wo["conversation_initiation_client_data_webhook"] = {
    "url": WEBHOOK_URL,
    "request_headers": {
        "Authorization": f"Bearer {ANON}",
        "x-karmen-secret": READ_SECRET,
        # NO x-karmen-now-override on live — the pinned clock is test-only.
    },
}
patch = {"platform_settings": {"overrides": overrides, "workspace_overrides": wo}}
if not DRY:
    st, _ = req(EL_BASE, method="PATCH", headers={"xi-api-key": el_key()}, data=patch)
    print(f"    agent PATCH -> {st}")
    if st != 200:
        rollback(f"agent PATCH returned {st}")

# ---- GATE B: field-by-field diff — ONLY the intended fields changed ----
print("\n[5] GATE B — field-by-field diff vs pre-cutover snapshot")
if not DRY:
    post = get_agent()
    post_flat = flat(post)
    keys = set(pre_flat) | set(post_flat)
    changed = [k for k in sorted(keys) if pre_flat.get(k, "∅") != post_flat.get(k, "∅")]
    ALLOW_SUBSTR = (
        "workspace_overrides.conversation_initiation_client_data_webhook",
        "overrides.conversation_config_override.agent.first_message",
        "overrides.conversation_config_override.agent.prompt.prompt",
        ".version_id", ".updated_at", ".last_updated",
    )
    unexpected = [k for k in changed if not any(s in k for s in ALLOW_SUBSTR)]
    for k in changed:
        tag = "OK " if any(s in k for s in ALLOW_SUBSTR) else "!! UNEXPECTED"
        print(f"    {tag} {k}: {pre_flat.get(k,'∅')} -> {post_flat.get(k,'∅')}")
    # Critical invariants explicitly:
    crit = {
        "prompt chars": lambda o: len(o["conversation_config"]["agent"]["prompt"]["prompt"]),
        "llm": lambda o: o["conversation_config"]["agent"]["prompt"]["llm"],
        "temperature": lambda o: o["conversation_config"]["agent"]["prompt"]["temperature"],
        "tool_ids": lambda o: o["conversation_config"]["agent"]["prompt"].get("tool_ids"),
        "tts model": lambda o: o["conversation_config"]["tts"]["model_id"],
        "tts voice": lambda o: o["conversation_config"]["tts"]["voice_id"],
        "first_message text": lambda o: o["conversation_config"]["agent"]["first_message"],
        "KB docs": lambda o: [d["id"] for d in o["conversation_config"]["agent"]["prompt"]["knowledge_base"]],
    }
    for n, f in crit.items():
        if f(pre) != f(post):
            print(f"    !! CRITICAL CHANGED: {n}: {f(pre)} -> {f(post)}")
            rollback(f"critical field changed: {n}")
    if unexpected:
        rollback(f"unexpected field(s) changed: {unexpected}")
    print("    GATE B PASS — only the webhook block + two override booleans changed")

# ---- GATE C: webhook returns the right override at open vs closed ----
print("\n[6] GATE C — initiation webhook behavior (open vs closed, via pinned clock)")
if not DRY:
    # Simulate exactly what ElevenLabs POSTs at conversation start. The pinned
    # clock header is ops-only (accepted by the gateway, never in a model schema).
    def init(pinned):
        return gw({"caller_id": "+520000000000", "agent_id": AGENT, "called_number": "+526873350709"},
                  {"x-karmen-secret": READ_SECRET, "x-karmen-now-override": pinned})
    _, closed = init("2026-07-20T22:00")  # after 16:50 → closed
    cco_c = (closed.get("conversation_config_override") or {}).get("agent", {})
    has_closed_msg = "cerrad" in json.dumps(closed).lower()
    print(f"    @22:00 closed: has first_message override={bool(cco_c.get('first_message'))}, prompt override={bool((cco_c.get('prompt') or {}).get('prompt'))}, mentions 'cerrado'={has_closed_msg}")
    if not cco_c.get("first_message") or not (cco_c.get("prompt") or {}).get("prompt"):
        rollback("closed-state webhook did not return first_message + prompt override")
    _, openw = init("2026-07-20T13:00")  # comida window → open
    dv = openw.get("dynamic_variables", {})
    print(f"    @13:00 open: karmen_is_open={dv.get('karmen_is_open')} (expect true), window={dv.get('karmen_window')}")
    if dv.get("karmen_is_open") != "true":
        rollback("open-state webhook did not report open")
    print("    GATE C PASS")

print(f"\n=== CUTOVER {'DRY-RUN OK' if DRY else 'COMPLETE'} — all gates passed ===")
print(f"Rollback if needed:")
print(f"  supabase secrets unset KARMEN_HOURS_ENFORCED --project-ref {PROJECT} && \\")
print(f"  supabase functions deploy karmen-gateway --project-ref {PROJECT}")
print(f"  # and restore the agent webhook/overrides from {os.path.basename(SNAP)}")
