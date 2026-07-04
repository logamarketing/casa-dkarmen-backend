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

// Menu availability is time-sensitive (a dish sells out mid-service), so the
// cache is short by design: a sold-out flip reflects within one TTL. The cache
// still removes the DB round-trip from bursts of concurrent tool calls.
const MENU_CACHE_MS = (() => {
  const n = Number(Deno.env.get("KARMEN_MENU_CACHE_MS"));
  return Number.isFinite(n) && n >= 0 ? n : 15_000;
})();

const CATEGORIES = ["comida", "bebida", "extra"] as const;
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
  const menu: Record<Category, MenuItem[]> = { comida: [], bebida: [], extra: [] };
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
