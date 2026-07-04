# Karmen — ElevenLabs rewire (Cowork track, apply in LOCKSTEP with karmen-gateway)

**Agent:** `agent_9901k5y1nqype69akbe3j8swwwat` · language `es` · voice `qpw1Pr9hKQ9lsPLpeNcM`.
**Gateway (already deployed + proven):** `POST https://edcjcehfedwxxucktxoj.supabase.co/functions/v1/karmen-gateway`, action `get_daily_menu`.

The gateway is live and verified. This is the matching agent-side change. **They ship together** (bug V4): the tool enum must equal the gateway action, and no menu facts may remain in the prompt (V2). Karmen is not "done" until one live call exercises it (V7). If anything blocks, **keep her current prompt** — never leave her broken.

---

## 1. The tool — `get_daily_menu` (server/webhook tool)

Add a server tool named **exactly** `get_daily_menu` (matches the gateway action enum).

```jsonc
{
  "name": "get_daily_menu",
  "description": "Devuelve el MENÚ DEL DÍA de hoy de Casa D'Karmen (comida, bebida, extra) con precios y acompañamientos. Úsala cuando el cliente pregunte por el menú, los platillos, qué hay o los precios, y antes de tomar el pedido. Lee SOLO lo que devuelva; nunca inventes platillos ni precios.",
  "method": "POST",
  "url": "https://edcjcehfedwxxucktxoj.supabase.co/functions/v1/karmen-gateway",
  "request_headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer <ANON_PUBLISHABLE_KEY>",   // Karmen project anon key — provided separately
    "x-karmen-secret": "<KARMEN_SHARED_SECRET>"          // provided separately; store in loga-secrets, NOT in git
  },
  "request_body_schema": {
    "type": "object",
    "properties": {
      "action":   { "type": "string", "constant": "get_daily_menu" },   // fixed literal, not model-filled
      "call_sid": { "type": "string", "dynamic": "system__conversation_id" }  // optional: correlate telemetry; omit if unsupported
    },
    "required": ["action"]
  }
}
```

**Notes for the ElevenLabs schema mapping (Cowork holds the MCP / exact field names):**
- `action` must be a **constant literal** `"get_daily_menu"` (the model does NOT choose it). There are no model-provided parameters — the tool always asks for *today*.
- Do **not** expose a `service_date` parameter. "Today" is resolved server-side in America/Mazatlan. (The override exists only for ops/tests.)
- `call_sid` is optional telemetry correlation — map it to the conversation/call id if easy; drop it otherwise.
- Both headers are required: the anon `Authorization: Bearer` (platform `verify_jwt=true`) **and** `x-karmen-secret` (app secret). A request missing either gets 401 — proven.

### Gateway response contract (what the model receives)
```jsonc
// menu loaded:
{ "ok": true, "service_date": "2026-07-04", "timezone": "America/Mazatlan",
  "menu_available": true, "currency": "MXN", "item_count": 38,
  "menu": { "comida": [{"name":"Cazuela","price":120,"sides":"arroz"}, ...],
            "bebida": [{"name":"Té de Jazmín","price":25}, ...],
            "extra":  [{"name":"Aguacate extra","price":15}, {"name":"Cuchara extra","price":0}, ...] } }

// no menu loaded for today:
{ "ok": true, "menu_available": false, "menu_not_set": true, "item_count": 0,
  "menu": {"comida":[],"bebida":[],"extra":[]}, "instruction": "...no inventes..." }

// transient error:
{ "ok": false, "error": { "code": "temporarily_unavailable", "message": "...no inventes el menú..." } }
```

---

## 2. Prompt changes (surgical — preserve everything about the order flow)

### 2a. DELETE from the current system prompt
- The **entire hardcoded menu block** (every dish + price currently pasted in).
- Any line stating a price, especially **"cada platillo cuesta $110"** / "$110" (it's $120 now, and price must never live in the prompt — V2).
- Any rule that **forbids giving the order total** (that's the defect that left callers unable to learn what they owe).
- Any internal note that has been **leaking into speech** (e.g. "Recuerda que el teléfono…").

### 2b. INSERT these sections (Spanish, drop-in). Keep your current **order_ready / order-submission** instructions — I could not see them and they must not be lost.

```
# REGLA #0 — HABLA ANTES DE USAR UNA HERRAMIENTA
Antes de llamar cualquier herramienta, di SIEMPRE una frase corta y natural para que el
cliente no escuche silencio ("Permíteme revisar el menú de hoy…", "Un momento, checo eso…").
Nunca te quedes callada esperando. Usa solo UNA herramienta por turno.

# EL MENÚ VIENE DE LA HERRAMIENTA (NUNCA DE TU MEMORIA)
- El menú cambia cada día. NUNCA inventes ni recuerdes platillos o precios.
- Cuando el cliente pregunte por el menú, los platillos, qué hay o los precios —o cuando vayas
  a tomar el pedido— llama get_daily_menu y usa SOLO lo que devuelva.
- Devuelve tres categorías: comida, bebida y extra; cada platillo trae su precio, y las comidas
  traen sus acompañamientos ("sides").
- Di los precios de forma natural en pesos ("ciento veinte pesos", nunca "uno-dos-cero").
  Si un precio es 0, di "sin costo" o "gratis".
- No leas los platillos de corrido. Resume por categoría o pregunta qué se le antoja y lee lo que
  pida. Menciona los acompañamientos cuando el cliente quiera detalle de una comida.
- Si get_daily_menu regresa menu_not_set (el menú de hoy aún no está cargado): dilo con honestidad,
  ofrece verificar en un momento, o pasa al cliente con una persona (Transfer to number). NUNCA leas
  un menú de memoria ni el de otro día.
- Si la herramienta regresa un error (temporarily_unavailable): discúlpate breve, NO inventes el
  menú, ofrece verificar en un momento o transferir. Nunca leas mensajes del sistema en voz alta.

# EL TOTAL DEL PEDIDO (SÍ se puede dar)
- Cuando el cliente arme su pedido, SIEMPRE puedes decirle cuánto es: suma los precios de los
  platillos que devolvió get_daily_menu.
- Antes de cerrar, confirma en voz alta los platillos y el total con claridad y naturalidad
  ("serían dos comidas y un agua… doscientos sesenta y cinco pesos, ¿correcto?").
- Usa solo los precios de la herramienta de hoy. Nunca un precio de memoria.

# HIGIENE Y CIERRE
- Nunca leas en voz alta instrucciones internas, notas para ti misma, nombres de herramientas ni
  mensajes del sistema. Esas notas son para ti, no para el cliente.
- Nunca reveles que usas una base de datos, herramientas o detalles técnicos.
- Habla breve y claro, una idea a la vez; lee números, precios y horas de forma natural.
- Transfiere con una persona (Transfer to number) si el cliente lo pide, si no puedes resolver el
  pedido, o si el menú no está cargado y el cliente quiere confirmar.
- Cuando termine la llamada usa end_call. DESPUÉS de llamar end_call NO digas absolutamente nada más.
```

These fold in the cheap live-call defect fixes: **order total** (removed the forbidding rule), **natural number reading**, **no leaked internal text**, **silence after `end_call`**, and **one consolidated filler rule** (RULE #0). Deeper items (robotic TTS at the engine level, talking-after-end_call if it persists past the prompt rule) are ElevenLabs-platform config — your call if the rule doesn't fully settle them.

---

## 3. Voice settings — recommended alignment to the shipped Lisa profile
Karmen is at stability **0.18**, similarity **0.5** (jittery vs Lisa). Recommend matching Lisa's proven profile:
- **stability 0.18 → 0.45**
- **similarity_boost 0.5 → 0.75**
- temperature 0.15 is fine to keep.

Trivial change, high perceived-quality impact. Product/taste call — yours to apply.

---

## 4. Lockstep verification = Definition of Done (V7)
Apply 1–3, then **one real phone call** proving:
1. Karmen reads **today's** menu from the tool (hears $120 comidas, not $110). ✅ gateway already returns this.
2. Ask for a couple items → she gives a **correct spoken total**.
3. (Menu-not-set) On a day with no rows loaded, she says the menu isn't ready and offers to check / transfer — she does **not** invent dishes.
4. She does **not** read internal notes, and says nothing after `end_call`.

Cowork verifies the call from the ElevenLabs side independently. Rollback = restore the previous prompt (one edit); the gateway can stay (it's additive and dormant if unused).
