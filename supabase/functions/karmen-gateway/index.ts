import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Casa D'Karmen voice gateway — the read path for the "Karmen" ElevenLabs
// agent. One action, get_daily_menu: returns TODAY's available menu from
// public.daily_menu so Karmen never reads a hardcoded prompt menu again.
// Cloned from the shipped La Bodega "Lisa" gateway. Engine = this code;
// soul = the client's daily_menu rows. Additive only — touches nothing on
// ordenes*, chat_context, n8n_chat_histories, ordenes_unificadas, or n8n.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const KARMEN_SHARED_SECRET = Deno.env.get("KARMEN_SHARED_SECRET") ?? "";
const KARMEN_SHARED_SECRET_NEW = Deno.env.get("KARMEN_SHARED_SECRET_NEW") ?? "";

// Sinaloa (Guasave) is America/Mazatlan: UTC-7, no DST. "Today" MUST be
// resolved here, never in UTC — after UTC-midnight (17:00 local) a UTC date
// would serve the wrong day's menu.
const MENU_TZ = "America/Mazatlan";
const CURRENCY = "MXN";

// Flat delivery surcharge (pesos). The single source of truth for an order
// total is THIS gateway, never the model's mental math (V2). compute_total sums
// today's DB prices deterministically in code so a wrong-arithmetic total (a
// real live-call bug: "$370" spoken for a $275 order) can never be voiced.
const DELIVERY_FEE = 20;

// Fulfillment modes the CALLER can actually choose. compute_total refuses to
// quote until one of these arrives: a mode-less call must never default to a
// pickup total, or the spoken amount jumps +$20 when delivery emerges (K9).
const PICKUP_MODES = ["pickup", "recoger"];
const DELIVERY_MODES = ["delivery", "domicilio"];

// Menu availability is time-sensitive (a dish sells out mid-service), so the
// cache is short by design: a sold-out flip reflects within one TTL. The cache
// still removes the DB round-trip from bursts of concurrent tool calls.
const MENU_CACHE_MS = (() => {
  const n = Number(Deno.env.get("KARMEN_MENU_CACHE_MS"));
  return Number.isFinite(n) && n >= 0 ? n : 15_000;
})();

const CATEGORIES = ["desayuno", "comida", "bebida", "extra"] as const;
type Category = (typeof CATEGORIES)[number];

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-karmen-secret,authorization",
  "access-control-allow-methods": "POST,OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

// Telemetry never blocks the voice hot path (the caller waits in silence during
// a tool call). waitUntil keeps the insert alive after the response returns.
async function safeLog(
  call_sid: string | null,
  event_type: string,
  payload: Record<string, unknown>,
) {
  try {
    await supabase.from("voice_events").insert({ call_sid, event_type, payload });
  } catch {
    // Never break the main flow on a telemetry failure.
  }
}

function logInBackground(
  call_sid: string | null,
  event_type: string,
  payload: Record<string, unknown>,
) {
  const p = safeLog(call_sid, event_type, payload);
  try {
    (globalThis as any).EdgeRuntime?.waitUntil?.(p);
  } catch {
    // waitUntil unavailable — safeLog still runs, may be cut off at shutdown.
  }
}

// Two-secret rotation, fail-closed: if neither env secret is set, nothing can
// match, so every request is refused. Remove the legacy branch after the
// ElevenLabs tool is cut to the new secret and the old env var is deleted.
function isAuthorized(provided: string | null): boolean {
  if (!provided) return false;
  if (KARMEN_SHARED_SECRET && provided === KARMEN_SHARED_SECRET) return true;
  if (KARMEN_SHARED_SECRET_NEW && provided === KARMEN_SHARED_SECRET_NEW) return true;
  return false;
}

// Current calendar date in the restaurant's timezone. en-CA formats as
// YYYY-MM-DD, which is exactly the shape of daily_menu.service_date.
function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A service_date override is ops/test-only (never exposed in the ElevenLabs
// tool schema). Validate strictly: shape AND that it round-trips to the same
// calendar date, so "2026-13-40" can't slip through to a wrong-day query.
function isValidServiceDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

interface MenuItem {
  name: string;
  price: number;
  sides?: string;
}
interface MenuPayload {
  menu: Record<Category, MenuItem[]>;
  item_count: number;
  menu_not_set: boolean;
  dropped: number; // items excluded for a non-finite price (should be 0)
}

const menuCache = new Map<string, { value: MenuPayload; expires: number }>();

async function loadMenu(serviceDate: string): Promise<{ value: MenuPayload; cacheHit: boolean }> {
  const cached = menuCache.get(serviceDate);
  if (cached && Date.now() < cached.expires) {
    return { value: cached.value, cacheHit: true };
  }

  const { data, error } = await supabase
    .from("daily_menu")
    .select("category,item_name,price,sides,sort_order")
    .eq("service_date", serviceDate)
    .eq("is_available", true);
  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const menu: Record<Category, MenuItem[]> = { desayuno: [], comida: [], bebida: [], extra: [] };
  let dropped = 0;

  for (const r of rows) {
    const cat = String((r as any).category) as Category;
    if (!CATEGORIES.includes(cat)) continue; // defensive: CHECK constraint already guarantees this
    // Truthfulness (V1/V2): never surface a broken price. Drop an ABSENT price
    // explicitly first — Number(null) is 0, so without this a null would read
    // as a bogus "sin costo" item. (postgREST returns numeric as a STRING, so a
    // real 0 arrives as "0" and is kept; only a true null/undefined is dropped.)
    const rawPrice = (r as any).price;
    if (rawPrice == null) {
      dropped++;
      continue;
    }
    const price = Number(rawPrice);
    if (!Number.isFinite(price)) {
      dropped++;
      continue;
    }
    const item: MenuItem = { name: String((r as any).item_name), price };
    const sides = (r as any).sides;
    if (sides != null && String(sides).trim() !== "") item.sides = String(sides);
    (menu[cat] as MenuItem[]).push({ item, sort: (r as any).sort_order } as any);
  }

  // Sort each category by sort_order (nulls last), then unwrap.
  for (const cat of CATEGORIES) {
    const arr = menu[cat] as any[];
    arr.sort((a, b) => {
      const sa = a.sort == null ? Number.POSITIVE_INFINITY : Number(a.sort);
      const sb = b.sort == null ? Number.POSITIVE_INFINITY : Number(b.sort);
      if (sa !== sb) return sa - sb;
      return String(a.item.name).localeCompare(String(b.item.name), "es");
    });
    menu[cat] = arr.map((x) => x.item);
  }

  const item_count = CATEGORIES.reduce((n, c) => n + menu[c].length, 0);
  const value: MenuPayload = { menu, item_count, menu_not_set: item_count === 0, dropped };

  // Opportunistically evict stale (expired) date keys so the map can't grow
  // unbounded across day rollovers on a long-lived isolate.
  const now = Date.now();
  for (const [k, v] of menuCache) {
    if (v.expires <= now) menuCache.delete(k);
  }
  menuCache.set(serviceDate, { value, expires: now + MENU_CACHE_MS });
  return { value, cacheHit: false };
}

// Order-item name matching is normalized so a name the model read back from
// get_daily_menu matches its DB row regardless of case, accents, or spacing.
function normalizeName(s: string): string {
  return String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

interface QuoteItem {
  nombre: string;
  categoria?: string;
  cantidad?: number;
}
interface QuoteLine {
  nombre: string;
  categoria: Category;
  unit_price: number;
  cantidad: number;
  line_total: number;
}

// Deterministic order total. Authoritative per-item prices come from TODAY's
// daily_menu rows (never the model), are summed here in code, plus the flat
// delivery fee. Any item whose name can't be matched to a live row is returned
// in `unmatched` and flips all_matched=false — the prompt must NOT confirm a
// total until every line matched, so a mis-heard dish can't inflate/deflate the
// bill and the model can never improvise the arithmetic (V2).
async function computeTotal(
  serviceDate: string,
  items: QuoteItem[],
  modalidad: string,
): Promise<Record<string, unknown>> {
  const { value } = await loadMenu(serviceDate);
  // name -> price; plus a category-qualified key to disambiguate a name that
  // appears in more than one category.
  const byName = new Map<string, { price: number; category: Category }>();
  const byCatName = new Map<string, { price: number; category: Category }>();
  for (const cat of CATEGORIES) {
    for (const it of value.menu[cat]) {
      const n = normalizeName(it.name);
      if (!byName.has(n)) byName.set(n, { price: it.price, category: cat });
      byCatName.set(`${cat}|${n}`, { price: it.price, category: cat });
    }
  }

  const breakdown: QuoteLine[] = [];
  const unmatched: string[] = [];
  let subtotal = 0;
  for (const raw of items) {
    const nombre = String(raw?.nombre ?? "").trim();
    if (!nombre) continue;
    const qtyNum = Number(raw?.cantidad);
    const cantidad = Number.isFinite(qtyNum) && qtyNum > 0 ? Math.floor(qtyNum) : 1;
    const n = normalizeName(nombre);
    const cat = typeof raw?.categoria === "string" ? raw.categoria.toLowerCase() : "";
    const hit = (cat && byCatName.get(`${cat}|${n}`)) || byName.get(n);
    if (!hit) {
      unmatched.push(nombre);
      continue;
    }
    const line_total = hit.price * cantidad;
    subtotal += line_total;
    breakdown.push({ nombre, categoria: hit.category, unit_price: hit.price, cantidad, line_total });
  }

  const isDelivery = DELIVERY_MODES.includes(modalidad);
  const delivery_fee = isDelivery ? DELIVERY_FEE : 0;
  const total = subtotal + delivery_fee;
  const all_matched = unmatched.length === 0;

  const res: Record<string, unknown> = {
    ok: true,
    service_date: serviceDate,
    currency: CURRENCY,
    modalidad: isDelivery ? "delivery" : "pickup",
    breakdown,
    subtotal,
    delivery_fee,
    total,
    all_matched,
    unmatched,
  };
  if (!all_matched) {
    // The model must treat this as "cannot quote yet", not a total to read.
    res.instruction =
      "No pude confirmar el precio de uno o más platillos (ver unmatched). NO digas ni confirmes un total; verifica esos platillos con el cliente y vuelve a calcular. Nunca inventes el total.";
  }
  return res;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "POST only" }, 405);
  }

  const secret = req.headers.get("x-karmen-secret");
  if (!isAuthorized(secret)) {
    logInBackground(null, "unauthorized", { has_secret: !!secret });
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const action = typeof body?.action === "string" ? body.action : "";
  const call_sid = typeof body?.call_sid === "string" ? body.call_sid : null;
  if (!action) {
    return json({ ok: false, error: "Missing action" }, 400);
  }

  try {
    if (action === "get_daily_menu") {
      // Ops/test-only override; the ElevenLabs tool never sends this, so the
      // model always gets today's menu in the restaurant's timezone.
      const override = typeof body?.service_date === "string" ? body.service_date.trim() : "";
      let serviceDate: string;
      if (override) {
        if (!isValidServiceDate(override)) {
          return json({ ok: false, error: "Invalid service_date (expected YYYY-MM-DD)" }, 400);
        }
        serviceDate = override;
      } else {
        serviceDate = todayInTz(MENU_TZ);
      }

      const started = Date.now();
      const { value, cacheHit } = await loadMenu(serviceDate);
      const ms = Date.now() - started;

      logInBackground(call_sid, "get_daily_menu", {
        service_date: serviceDate,
        item_count: value.item_count,
        menu_not_set: value.menu_not_set,
        dropped: value.dropped,
        cache_hit: cacheHit,
        ms,
      });

      const res: Record<string, unknown> = {
        ok: true,
        service_date: serviceDate,
        timezone: MENU_TZ,
        currency: CURRENCY,
        menu_available: !value.menu_not_set,
        item_count: value.item_count,
        menu: value.menu,
      };

      if (value.menu_not_set) {
        // Explicit "not loaded" state — NEVER fall back to another day's rows
        // (core ledger B12). The prompt turns this into "let me check / I can
        // pass you to a person"; the instruction is a model hint, not speech.
        res.menu_not_set = true;
        res.instruction =
          "El menú de hoy aún no está cargado. No inventes platillos ni precios; ofrece verificar o transferir con una persona.";
      }

      return json(res);
    }

    if (action === "compute_total") {
      const override = typeof body?.service_date === "string" ? body.service_date.trim() : "";
      let serviceDate: string;
      if (override) {
        if (!isValidServiceDate(override)) {
          return json({ ok: false, error: "Invalid service_date (expected YYYY-MM-DD)" }, 400);
        }
        serviceDate = override;
      } else {
        serviceDate = todayInTz(MENU_TZ);
      }

      const items = Array.isArray(body?.items) ? body.items : [];
      // Accept the natural spoken forms too ("a domicilio", "para recoger") by
      // stripping a leading preposition; ambiguous forms ("para llevar") stay
      // unmatched and fall through to mode_missing — ask, never guess.
      const modalidadRaw = body?.modalidad;
      const modalidad = typeof modalidadRaw === "string"
        ? modalidadRaw.toLowerCase().trim().replace(/^(?:para|a)\s+/, "")
        : "";
      if (items.length === 0) {
        return json({ ok: false, error: "compute_total requires a non-empty items array" }, 400);
      }

      // Mode is REQUIRED before any quote (K9, V2's sibling): a mode-less call
      // used to default to a pickup total — spoken, then jumping +$20 when the
      // caller chose delivery. Mirror the all_matched:false "cannot quote yet"
      // shape: ok:true + HTTP 200 so ElevenLabs delivers the instruction to the
      // model, mode_missing flag, NO total/subtotal/breakdown to read.
      if (!PICKUP_MODES.includes(modalidad) && !DELIVERY_MODES.includes(modalidad)) {
        logInBackground(call_sid, "compute_total", {
          service_date: serviceDate,
          mode_missing: true,
          modalidad: null,
          // Truly raw (pre-coercion) so telemetry shows which token to whitelist
          // next; JSON-encoded to distinguish "", null, absent, and non-strings.
          modalidad_raw: modalidadRaw === undefined ? null : (JSON.stringify(modalidadRaw) ?? "null").slice(0, 60),
        });
        return json({
          ok: true,
          service_date: serviceDate,
          currency: CURRENCY,
          mode_missing: true,
          spoken_message: "¿Va a ser para recoger, o te lo mandamos a domicilio?",
          instruction:
            "Aún no sabes si el pedido es para recoger o a domicilio. NO digas ni confirmes ningún total todavía; pregunta con calidez si es para recoger o a domicilio y vuelve a calcular ya con la modalidad. Nunca inventes el total.",
        });
      }

      const started = Date.now();
      const res = await computeTotal(serviceDate, items as QuoteItem[], modalidad);
      const ms = Date.now() - started;

      logInBackground(call_sid, "compute_total", {
        service_date: serviceDate,
        mode_missing: false,
        modalidad: res.modalidad,
        total: res.total,
        subtotal: res.subtotal,
        delivery_fee: res.delivery_fee,
        line_count: (res.breakdown as unknown[]).length,
        unmatched: res.unmatched,
        all_matched: res.all_matched,
        ms,
      });

      return json(res);
    }

    return json({ ok: false, error: `Unknown action: ${action}` }, 400);
  } catch (err: any) {
    // Raw DB/internal text must never reach the voice model — full detail goes
    // to voice_events only; the model gets a clean, Spanish, do-not-invent hint.
    logInBackground(call_sid, "error", { action, error: String(err?.message ?? err) });
    // Return 200 (not 500) on this mid-call runtime failure ON PURPOSE: the whole
    // fabrication mitigation is this instruction reaching the LLM, and ElevenLabs
    // may treat a non-2xx tool response as an opaque failure and let the model
    // improvise a price (V1/V2). ok:false + an error code keeps any programmatic
    // caller from reading it as success (B4). Parity with the menu_not_set path.
    return json({
      ok: false,
      error: {
        code: "temporarily_unavailable",
        message:
          "Problema temporal del sistema — no inventes el menú. Ofrece verificar en un momento o transferir con una persona.",
      },
    });
  }
});
