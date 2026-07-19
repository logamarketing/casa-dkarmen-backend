# ElevenLabs KB + MCP Inventory — Karmen (drift risk record, 2026-07-18)

*Discovered during the V10 model-hardening pass (K10) and documented here so the
repo knows every knowledge source attached to the live agent. **Nothing was
moved or removed** — whether these facts migrate into tables/tools is an owner
decision. Ledger entry: K11. All contents below were fetched from the live
ElevenLabs API on 2026-07-18; raw dumps preserved alongside the fetch session.*

**Agent:** `agent_9901k5y1nqype69akbe3j8swwwat` (Karmen, live line `+526873350709`).
All four KB docs are `usage_mode: auto` — ElevenLabs RAG decides per-turn whether
to inject them; they are NOT gated by any tool. Uploader on all: `logamarketingokc@gmail.com`.

---

## Knowledge-base documents (4)

### 1. "Extras" — text, `7Wrmj1bAbKQdxoJGYIUU` (created 2025-09-25)
Full contents (107 bytes):
> Extras: Cuchara extra / Tenedor extra / Poner mayonesa / Aguacate extra $15 /
> Tortillas extra $5 / Totopos extra $5

**Purpose:** free-form extras + prices.
**Drift risk: HIGH.** `daily_menu` also carries an `extra` category with prices;
two sources for the same prices (V5 three-sources class). If a `daily_menu` extra
price ever changes, this doc still whispers the old number to the model.

### 2. "Bebidas" — text, `J5RMxqq7HFKR9zkVaxqd` (created 2025-09-25)
Full contents (357 bytes): drinks at **$25 each** (Té de Jazmín, Agua de Jamaica,
Agua de Tamarindo, Coca-Cola 400ml / Zero / Light, Fanta Fresa/Naranja, Soda de
Manzana/Sprite/Fresca) **plus a duplicate of the whole "Extras" block above.**

**Purpose:** static drinks list.
**Drift risk: HIGH.** Same V5 shape — `daily_menu.bebida` is the authoritative
tool-read source ($25 today, but per-day by design). The embedded second copy of
the Extras list doubles the duplication.

### 3. "Untitled document-2.docx" — file, `DUinhY6brFXOlQlVNyKI` (created 2025-09-25; real title inside: **"Información de Casa De Karmen"**)
Contents (business KB, ~3KB):
- **Hours: Desayunos 8:00–11:30 AM; Comida del Día 11:30 AM–5:00 PM; closed nights.**
  ← this is where Karmen's spoken business-hours answers come from (proven in the
  overnight harness: the marathon scenario asks "¿hasta qué hora están abiertos?").
- Modalities: pickup (cash or card; **no transfers**), delivery within Guasave
  (**flat $20**, cash or card on receipt).
- Payment methods (cash w/ change if announced, credit/debit card, no transfers).
- **Promotions: "Pick-up promo: 1 té Jazmín GRATIS con tu orden para llevar."**
  ← nothing else in the stack (prompt, gateway, order flow) knows this promo exists.
- General info / culture ("Comida que Enamora"), location Guasave, Sinaloa.

**Purpose:** the de-facto business-facts KB (hours, payment, delivery fee, promo).
**Drift risk: MEDIUM.** Hours/payment are stable-ish, but the **$20 delivery fee
is ALSO hardcoded in the gateway (`DELIVERY_FEE`) and stated in the prompt** —
three places to change if the fee ever moves. The free-tea promo is undocumented
anywhere else and unverifiable from this repo.

### 4. "Menú de Desayunos Casa D'Karmen (3).docx" — file, `iQtX99KLhW9TinuWeoGx` (created **2026-03-28**)
Contents: static breakfast menu — **CLÁSICOS $115 each** (16 items: huevos
variants, hot cakes, chilaquiles rojos/verdes, enchiladas suizas, sincronizadas,
machaca, burritos, huevos montados), **COMBINACIONES $140** (6 combos), drinks
$25 (same list as doc 2).

**Purpose:** breakfast menu, from before `daily_menu` served desayuno.
**Drift risk: HIGH — this is the sharpest one.** As of the Stage-3 edit-path work
(commits `1617ab5`/`ca75421`, 2026-07-12) **desayuno is a live `daily_menu`
category served by `get_daily_menu`**. A static March docx with fixed $115/$140
prices now competes with the per-day tool read — the exact V5 "three sources of
truth" failure: if staff change a desayuno price via the admin path, the RAG doc
still carries the old number and the model may blend them.

---

## MCP server (1) — ~~attached~~ **DETACHED 2026-07-19**

### "Menu del dia" — `H2Gc9CPREDxMsH6hN1sN` (created 2025-09-25; **detached from Karmen 2026-07-19, owner-authorized**)
- **URL:** `https://docs.google.com/document/d/1NYsiwXD1gJzKvmu2TH_HR968ZRhz6MGz2Zl-hVwepxw/export?format=txt`
- Transport `STREAMABLE_HTTP`, no auth headers, `approval_policy: auto_approve_all`,
  `response_timeout_secs: 30`.
- **This is not actually an MCP server.** It is a Google Doc plain-text export URL
  registered *as* one. A doc export cannot speak the MCP protocol, so tool listing
  from it should fail — consistent with the overnight harness never seeing its
  content surface. It appears to be a **pre-gateway relic of the original "menu in
  a Google Doc" era** (created the same day as the KB docs, 2025-09-25).
- **Verified 2026-07-18: the Google Doc is PUBLICLY readable and contains a STALE
  menu at "$ciento diez" ($110)** — the pre-correction price that Stage 1 fixed to
  $120. If ElevenLabs ever *did* surface this source (or someone "fixes" the MCP
  wiring), Karmen would have a second, wrong, uncontrolled menu.
- No evidence it reaches the model live: 173 overnight harness turns + all
  regression sims (7/18 AND the 7/19 removal-verification pass) produced zero
  $110 quotes and zero off-`daily_menu` dishes.

**REMOVED 2026-07-19 (owner-authorized cleanup pass).** Snapshot taken first:
`.karmen-agent-rollback-20260719-075607-remove110.json`. Confirmed via
`GET /v1/convai/mcp-servers/H2Gc9CPREDxMsH6hN1sN` that **Karmen was the only
dependent agent** (the earlier harness duplicate had already been deleted), so
detaching was safe with no blast radius beyond Karmen. Action taken:
**detached only** — `PATCH /v1/convai/agents/{id}` with
`conversation_config.agent.prompt.mcp_server_ids: []`. The MCP-server *object*
itself (id `H2Gc9CPREDxMsH6hN1sN`) was **not hard-deleted** — it still exists in
the ElevenLabs workspace with zero dependent agents, and a full delete is a
separate, later, more-irreversible step (queued below).
Verification: live `GET` on the agent shows `mcp_server_ids: []` (was
`['H2Gc9CPREDxMsH6hN1sN']`); every other field (prompt, llm, backup_llm_config,
turn, tts, asr, tool_ids, built-in tools, knowledge_base, first_message,
language, phone_numbers, platform_settings) is byte-identical to the snapshot.
Post-detach regression sims (delivery/pickup/menu_not_set) **ALL PASS** — mode
asked before total, $120 unit price / $260 delivery total spoken exactly, no
`$110`/`ciento diez` anywhere in any transcript, honest `menu_not_set`; 18
agent turns scanned, **0 leaks**.

---

## Owner decisions queued (NOT taken here)
1. ~~**Remove or archive the "Menu del dia" MCP server**~~ **DONE 2026-07-19**
   (detached from Karmen; see above). **Still open:** hard-delete the orphaned
   MCP-server object `H2Gc9CPREDxMsH6hN1sN` itself once confirmed no future
   agent needs it — that's the fully-irreversible step, deliberately deferred.
2. **Desayuno docx vs `daily_menu.desayuno`** — pick one source; if `daily_menu`
   wins (recommended), retire doc 4.
3. **Extras/Bebidas docs vs `daily_menu`** — same call as #2 for docs 1–2.
4. **"Información" doc stays** (hours/payment/promo have no other home today), but
   its facts should eventually live in a table or tool the repo controls; at
   minimum keep this inventory dated and re-verify on menu-price changes.
