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

// Stage A (order integrity): submit_order is a WRITE action and gets its OWN
// secret, never the read secret above — mirrors karmen-menu-admin's existing
// separate-secret precedent (KARMEN_ADMIN_SECRET). A leak of the read secret
// (embedded in the read-only get_daily_menu/compute_total tool configs) must
// never grant order-injection.
const KARMEN_ORDER_SECRET = Deno.env.get("KARMEN_ORDER_SECRET") ?? "";
const KARMEN_ORDER_SECRET_NEW = Deno.env.get("KARMEN_ORDER_SECRET_NEW") ?? "";

// New, notify-only n8n webhook (Stage A) — wired to ONLY the proven Telegram-
// formatting node, never the old broken $0/no-idempotency SQL insert branch.
const KARMEN_ORDER_NOTIFY_URL = Deno.env.get("KARMEN_ORDER_NOTIFY_URL") ?? "";

// Direct-to-human alert, independent of BOTH Supabase and n8n — the channel
// that must still work if either of those is the thing that's down. Real
// Telegram Bot API call, no n8n involved. Unset until Edgar provisions a bot
// via @BotFather; see docs/stage-A-order-integrity-design.md §5(a).
const KARMEN_ALERT_BOT_TOKEN = Deno.env.get("KARMEN_ALERT_BOT_TOKEN") ?? "";
const KARMEN_ALERT_CHAT_ID = Deno.env.get("KARMEN_ALERT_CHAT_ID") ?? "";

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

// ---------------------------------------------------------------------------
// BUSINESS HOURS + SERVICE WINDOWS (V6). Owner-specified, America/Mazatlan
// (no DST — same fixed offset year-round, so wall-clock math is safe here).
//
// These live in CODE, not the prompt: prompt-only compliance measured ~50/50 at
// temperature 0.4 this week, and the failure mode is refusing a real customer
// or taking an order nobody is there to cook. Minutes-since-local-midnight.
//
// Boundaries are exact and asymmetric on purpose:
//   open  iff  OPEN_MIN <= t < CLOSE_MIN   -> 7:49 closed, 7:50 open,
//                                             4:49 open,  4:50 closed
//   breakfast iff t <= BREAKFAST_END_MIN   -> 11:30 desayuno, 11:31 comida
// Sunday is closed all day regardless of the clock.
const OPEN_MIN = 7 * 60 + 50; // 7:50 AM
const CLOSE_MIN = 16 * 60 + 50; // 4:50 PM (exclusive — 4:50 is CLOSED)
const BREAKFAST_END_MIN = 11 * 60 + 30; // 11:30 AM (inclusive — 11:30 is desayuno)

type ServiceWindow = "desayuno" | "comida" | "closed";

// CUTOVER GATE. This gateway is shared by LIVE Karmen and the warm duplicate —
// there is no per-agent distinction in the request — so shipping the hours rules
// would have changed live behaviour the moment the function deployed. Default
// OFF preserves today's live behaviour exactly (full menu, no time gating).
// Enforcement turns on when:
//   * KARMEN_HOURS_ENFORCED=true          -> the cutover switch (Edgar's go), or
//   * an ops `now_override` is supplied   -> so the boundary battery proves the
//                                            REAL rules before cutover.
// Flip at cutover with:
//   supabase secrets set KARMEN_HOURS_ENFORCED=true --project-ref edcjcehfedwxxucktxoj
const HOURS_ENFORCED = (Deno.env.get("KARMEN_HOURS_ENFORCED") ?? "").trim().toLowerCase() === "true";

// Bebidas and extras stay available in BOTH open windows: the owner's rule
// restricts the MAINS (no comidas at breakfast, no desayunos at lunch), and
// drinks/extras accompany either — including the free Té de Jazmín pickup promo,
// which is a `bebida` and must remain quotable all day.
function allowedCategories(w: ServiceWindow): Category[] {
  if (w === "desayuno") return ["desayuno", "bebida", "extra"];
  if (w === "comida") return ["comida", "bebida", "extra"];
  return [];
}

interface LocalNow {
  date: string; // YYYY-MM-DD, local
  minutes: number; // minutes since local midnight
  weekday: number; // 0 = Sunday
  hhmm: string;
  overridden: boolean;
}

// Weekday for a local calendar date. Noon UTC maps to 05:00 in Mazatlan, i.e.
// always the SAME calendar date, so the UTC weekday is the local weekday.
function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

const TIME_OVERRIDE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// `now_override` is ops/test-only and mirrors service_date's existing pattern —
// it is NEVER present in the ElevenLabs tool schema, so the model cannot move
// the clock and talk itself into an open restaurant. Interpreted as LOCAL
// wall-clock in MENU_TZ, which is what makes boundary testing meaningful.
function resolveNow(override: string): LocalNow | null {
  if (override) {
    if (!TIME_OVERRIDE_RE.test(override)) return null;
    const date = override.slice(0, 10);
    if (!isValidServiceDate(date)) return null;
    const hh = Number(override.slice(11, 13));
    const mm = Number(override.slice(14, 16));
    if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 23 || mm > 59) return null;
    return {
      date,
      minutes: hh * 60 + mm,
      weekday: weekdayOf(date),
      hhmm: override.slice(11),
      overridden: true,
    };
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MENU_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  // hour12:false yields "24" for midnight in some ICU builds — normalize.
  const hh = Number(get("hour")) % 24;
  const mm = Number(get("minute"));
  return {
    date,
    minutes: hh * 60 + mm,
    weekday: weekdayOf(date),
    hhmm: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
    overridden: false,
  };
}

function serviceWindow(now: LocalNow): ServiceWindow {
  if (now.weekday === 0) return "closed"; // Sundays: closed all day
  if (now.minutes < OPEN_MIN || now.minutes >= CLOSE_MIN) return "closed";
  return now.minutes <= BREAKFAST_END_MIN ? "desayuno" : "comida";
}

// null = hours not enforced for this request (pre-cutover live traffic). The
// window is still COMPUTED and logged in that case, so `voice_events` shows
// what the rules WOULD have done before they are switched on for real.
function enforcedWindow(now: LocalNow): ServiceWindow | null {
  return (HOURS_ENFORCED || now.overridden) ? serviceWindow(now) : null;
}

// The ONE spoken source of truth for hours. Warm, brief, states the real hours,
// wishes them a good day. Server-dictated so the wording cannot drift at
// temperature 0.4, and so the hours can never contradict the code that gates
// the door. Numbers are spelled out — TTS reads digits inconsistently.
const HOURS_SPOKEN = "de siete cincuenta de la mañana a cuatro cincuenta de la tarde, de lunes a sábado";

function closedSpokenMessage(now: LocalNow): string {
  if (now.weekday === 0) {
    return `¡Hola! Qué gusto que llames a Casa D'Karmen. Hoy es domingo y descansamos, pero te esperamos ${HOURS_SPOKEN}. ¡Que tengas bonito día!`;
  }
  return `¡Hola! Qué gusto que llames a Casa D'Karmen. Ahorita ya estamos cerrados; atendemos ${HOURS_SPOKEN}. ¡Que tengas bonito día!`;
}

// Told to the MODEL (never spoken): say the spoken_message and nothing else,
// then hang up. No order path, and explicitly no transfer — when we are closed
// there is nobody on the other end to transfer to.
const CLOSED_INSTRUCTION =
  "El restaurante está CERRADO en este momento. Di ÚNICAMENTE el spoken_message, palabra por palabra, y termina la llamada con end_call usando ese mismo mensaje. NO tomes pedidos, NO calcules totales, NO ofrezcas el menú, NO transfieras a nadie (no hay quien conteste) y NO inventes otro horario.";

function windowInstruction(w: ServiceWindow): string {
  return w === "desayuno"
    ? "En este momento SOLO se sirven DESAYUNOS (más bebidas y extras). No ofrezcas ni aceptes platillos de comida; si los piden, explica con calidez que la comida del día empieza a las once y media."
    : "En este momento SOLO se sirve la COMIDA DEL DÍA (más bebidas y extras). No ofrezcas ni aceptes desayunos; si los piden, explica con calidez que los desayunos se sirven hasta las once y media.";
}

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

// Same two-secret rotation shape as isAuthorized, but a DISTINCT secret family
// (KARMEN_ORDER_SECRET*) — see the const declarations above for why.
function isOrderAuthorized(provided: string | null): boolean {
  if (!provided) return false;
  if (KARMEN_ORDER_SECRET && provided === KARMEN_ORDER_SECRET) return true;
  if (KARMEN_ORDER_SECRET_NEW && provided === KARMEN_ORDER_SECRET_NEW) return true;
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

// ---------------------------------------------------------------------------
// Stage A — submit_order. Full design: docs/stage-A-order-integrity-design.md
// Invariant: an order Karmen confirms out loud has verifiably landed (a row
// written AND the kitchen notified, carrying the caller-approved total) — or
// she does NOT confirm; instead the order is captured to a durable record and
// a human is alerted, and she says so honestly.
// ---------------------------------------------------------------------------

const PAYMENT_METHODS = ["cash", "card"]; // "transfer" was in order_ready's tool
// description but the PROMPT says "no hay transferencias" for every modality —
// a pre-existing contradiction in the system this design does not resolve,
// only follows the stricter (prompt) side of. Flagged, not silently kept.

interface OrderFields {
  cliente_nombre: string;
  telefono: string;
  modalidad: string; // normalized pickup|delivery
  direccion: string;
  metodo_de_pago: string;
  cash_amount: string;
  notes: string;
}

// Server-side presence/shape validation (K5): a provider `required` schema
// flag is satisfied by empty strings, so this re-checks everything order_ready
// used to only ask for in its description and trust the model to honor.
function validateOrderFields(body: any, modalidad: string): { ok: true; fields: OrderFields } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const cliente_nombre = typeof body?.cliente_nombre === "string" ? body.cliente_nombre.trim() : "";
  if (!cliente_nombre) missing.push("cliente_nombre");

  const telefono = typeof body?.telefono === "string" ? body.telefono.replace(/\D/g, "") : "";
  if (telefono.length !== 10) missing.push("telefono");

  const isDelivery = DELIVERY_MODES.includes(modalidad);
  const isPickup = PICKUP_MODES.includes(modalidad);
  if (!isDelivery && !isPickup) missing.push("modalidad");

  const direccion = typeof body?.direccion === "string" ? body.direccion.trim() : "";
  if (isDelivery && !direccion) missing.push("direccion");

  const metodo_de_pago = typeof body?.metodo_de_pago === "string" ? body.metodo_de_pago.toLowerCase().trim() : "";
  if (!PAYMENT_METHODS.includes(metodo_de_pago)) missing.push("metodo_de_pago");
  if (isDelivery && metodo_de_pago !== "cash") missing.push("metodo_de_pago"); // delivery is cash-only

  const cashAmountRaw = body?.cash_amount;
  const cash_amount = cashAmountRaw == null ? "" : String(cashAmountRaw).trim();
  if (metodo_de_pago === "cash" && !cash_amount) missing.push("cash_amount");

  const notes = typeof body?.notes === "string" ? body.notes.trim() : "";

  if (missing.length > 0) return { ok: false, missing: [...new Set(missing)] };
  return {
    ok: true,
    fields: {
      cliente_nombre,
      telefono,
      modalidad: isDelivery ? "delivery" : "pickup",
      direccion,
      metodo_de_pago,
      cash_amount,
      notes,
    },
  };
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Explicit, UNSWALLOWED capture — deliberately NOT safeLog/logInBackground,
// whose whole purpose is to swallow their own errors for lossy telemetry. This
// is the safety-of-last-resort for a mutation; if it fails we need to KNOW.
async function captureFailure(
  call_sid: string | null,
  event_type: string,
  payload: Record<string, unknown>,
): Promise<{ captured: boolean; error?: string }> {
  try {
    const { error } = await supabase.from("voice_events").insert({ call_sid, event_type, payload });
    if (error) return { captured: false, error: String(error.message ?? error) };
    return { captured: true };
  } catch (err: any) {
    return { captured: false, error: String(err?.message ?? err) };
  }
}

// Direct-to-human alert, independent of Supabase AND n8n (Telegram Bot API
// called straight from this function, no n8n round-trip). If the credential
// isn't provisioned yet, this returns that fact honestly instead of pretending
// to have sent anything.
async function directAlert(text: string): Promise<{ sent: boolean; error?: string }> {
  if (!KARMEN_ALERT_BOT_TOKEN || !KARMEN_ALERT_CHAT_ID) {
    return { sent: false, error: "alert_credential_missing" };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${KARMEN_ALERT_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: KARMEN_ALERT_CHAT_ID, text }),
    });
    if (!res.ok) return { sent: false, error: `telegram_http_${res.status}` };
    return { sent: true };
  } catch (err: any) {
    return { sent: false, error: String(err?.message ?? err) };
  }
}

// Kitchen notify: the NEW, notify-only n8n webhook (Telegram formatting only —
// never the old SQL-insert branch). Inline retry; `simulateFailure` is an
// ops/test-only hook (never exposed to the model) so the failure branch is
// provable without needing a real outage.
async function notifyKitchen(
  payload: Record<string, unknown>,
  simulateFailure: boolean,
): Promise<{ sent: boolean; attempts: number; error?: string }> {
  if (simulateFailure) return { sent: false, attempts: 2, error: "simulated_notify_failure" };
  if (!KARMEN_ORDER_NOTIFY_URL) return { sent: false, attempts: 0, error: "notify_url_not_configured" };

  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(KARMEN_ORDER_NOTIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) return { sent: true, attempts: attempt };
      lastError = `http_${res.status}`;
    } catch (err: any) {
      lastError = String(err?.message ?? err);
    }
    if (attempt < 2) await sleep(400);
  }
  return { sent: false, attempts: 2, error: lastError };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "POST only" }, 405);
  }

  // Two independent secret families checked up front, fail-closed exactly as
  // before (a request with neither valid secret 401s before JSON is even
  // parsed — unchanged behavior for existing callers). WHICH secret must have
  // matched is enforced per-action below, once the action is known — this is
  // what keeps the read secret (embedded in read-only tool configs) from
  // granting write access to submit_order.
  const readSecret = req.headers.get("x-karmen-secret");
  const orderSecret = req.headers.get("x-karmen-order-secret");
  const readOk = isAuthorized(readSecret);
  const orderOk = isOrderAuthorized(orderSecret);
  if (!readOk && !orderOk) {
    logInBackground(null, "unauthorized", { has_secret: !!(readSecret || orderSecret) });
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

  // ---------------------------------------------------------------------
  // CONVERSATION INITIATION WEBHOOK (V6 gap closer).
  //
  // Found by the closed-state sample call: hours enforced only on the TOOL
  // paths let Karmen answer "¿todavía están abiertos?" from imagination —
  // she said "¡Claro que sí! Aquí seguimos" at 22:00 because she never
  // called get_daily_menu. A caller can ask about hours without ever
  // triggering a tool, so the tool paths alone CANNOT close this.
  //
  // ElevenLabs calls this at conversation start (before the agent speaks) and
  // honours the returned overrides, so when we are closed her greeting AND her
  // whole instruction set are replaced server-side. She cannot claim to be
  // open because she is never told she is.
  //
  // ElevenLabs owns this request body (no `action` field), so the shape is the
  // discriminator. Auth is the read secret, same as every other read path.
  const isInitWebhook = !action &&
    (body?.caller_id !== undefined || body?.agent_id !== undefined ||
     body?.called_number !== undefined || body?.conversation_id !== undefined);
  if (isInitWebhook) {
    if (!readOk) {
      logInBackground(null, "unauthorized", { action: "conversation_init" });
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
    // Ops-only pinned clock, supplied via the per-agent webhook request_headers
    // (the DUPLICATE carries it; live does not). Same class as now_override —
    // the model can never set it, because the model never builds this request.
    const hdrOverride = req.headers.get("x-karmen-now-override") ?? "";
    const nowInit = resolveNow(hdrOverride.trim());
    if (!nowInit) {
      return json({ ok: false, error: "Invalid x-karmen-now-override" }, 400);
    }
    const winInit = enforcedWindow(nowInit);
    const shadow = serviceWindow(nowInit);
    logInBackground(null, "conversation_init", {
      local_time: nowInit.hhmm,
      weekday: nowInit.weekday,
      window: winInit ?? `shadow:${shadow}`,
      hours_enforced: winInit !== null,
      time_overridden: nowInit.overridden,
    });

    const payload: Record<string, unknown> = {
      type: "conversation_initiation_client_data",
      dynamic_variables: {
        // Present in EVERY case so the prompt can reference them safely.
        karmen_hours: HOURS_SPOKEN,
        karmen_is_open: winInit === null ? "true" : String(winInit !== "closed"),
        karmen_window: winInit ?? "unenforced",
        karmen_local_time: nowInit.hhmm,
      },
    };

    if (winInit === "closed") {
      const msg = closedSpokenMessage(nowInit);
      // Replace the greeting AND the prompt: from her very first word she is a
      // closed restaurant, with no menu, no order path, and no transfer.
      payload.conversation_config_override = {
        agent: {
          first_message: msg,
          prompt: {
            prompt:
              `Eres Karmen, de Casa D'Karmen. El restaurante está CERRADO en este momento.\n\n` +
              `Tu ÚNICA tarea: decir exactamente este mensaje y terminar la llamada:\n"${msg}"\n\n` +
              `REGLAS ABSOLUTAS:\n` +
              `- NO tomes pedidos ni ofrezcas menú, platillos o precios.\n` +
              `- NO transfieras a nadie: no hay quien conteste.\n` +
              `- NO inventes otro horario. El horario real es: ${HOURS_SPOKEN}.\n` +
              `- Si insisten, repite con calidez que ahorita está cerrado y el horario, y despídete.\n` +
              `- Llama a end_call en cuanto te despidas.`,
          },
        },
      };
    } else if (winInit !== null) {
      payload.conversation_config_override = {
        agent: {
          prompt: {
            prompt_extension:
              `\n\nHORARIO ACTUAL (autoridad del sistema, no lo contradigas): ` +
              `son las ${nowInit.hhmm}, el restaurante está ABIERTO y ` +
              `${windowInstruction(winInit)} Horario: ${HOURS_SPOKEN}.`,
          },
        },
      };
    }
    return json(payload);
  }

  if (!action) {
    return json({ ok: false, error: "Missing action" }, 400);
  }

  // Per-action secret enforcement: submit_order needs the ORDER secret
  // specifically; every other action needs the READ secret specifically. A
  // caller holding only one of the two can never reach the other's action.
  const isOrderAction = action === "submit_order";
  if (isOrderAction && !orderOk) {
    logInBackground(call_sid, "unauthorized", { action, reason: "read_secret_insufficient_for_order" });
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  if (!isOrderAction && !readOk) {
    logInBackground(call_sid, "unauthorized", { action, reason: "order_secret_insufficient_for_read" });
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  try {
    if (action === "get_daily_menu") {
      // Ops/test-only override; the ElevenLabs tool never sends this, so the
      // model always gets today's menu in the restaurant's timezone.
      const override = typeof body?.service_date === "string" ? body.service_date.trim() : "";
      const nowOverride = typeof body?.now_override === "string" ? body.now_override.trim() : "";
      const now = resolveNow(nowOverride);
      if (!now) {
        return json({ ok: false, error: "Invalid now_override (expected YYYY-MM-DDTHH:MM)" }, 400);
      }
      let serviceDate: string;
      if (override) {
        if (!isValidServiceDate(override)) {
          return json({ ok: false, error: "Invalid service_date (expected YYYY-MM-DD)" }, 400);
        }
        serviceDate = override;
      } else {
        // With a clock override and no explicit date, the overridden day IS the
        // service day — otherwise a Sunday boundary test would read Monday's menu.
        serviceDate = now.overridden ? now.date : todayInTz(MENU_TZ);
      }

      // CLOSED short-circuits before any menu read: nothing to offer, and the
      // caller gets one warm, server-dictated line instead of a menu (V6).
      const win = enforcedWindow(now);
      if (win === "closed") {
        logInBackground(call_sid, "get_daily_menu", {
          service_date: serviceDate,
          closed: true,
          local_time: now.hhmm,
          weekday: now.weekday,
          time_overridden: now.overridden,
        });
        return json({
          ok: true,
          closed: true,
          service_date: serviceDate,
          timezone: MENU_TZ,
          local_time: now.hhmm,
          currency: CURRENCY,
          menu_available: false,
          item_count: 0,
          menu: { desayuno: [], comida: [], bebida: [], extra: [] },
          hours: HOURS_SPOKEN,
          spoken_message: closedSpokenMessage(now),
          instruction: CLOSED_INSTRUCTION,
        });
      }

      const started = Date.now();
      const { value, cacheHit } = await loadMenu(serviceDate);
      const ms = Date.now() - started;

      // Serve ONLY what the kitchen is making right now. She can only offer
      // from what she is handed, so the window rule cannot be talked around.
      // When hours are not yet enforced (pre-cutover), the full menu passes
      // through untouched — today's live behaviour, bit for bit.
      const allowed = win ? allowedCategories(win) : [...CATEGORIES];
      const windowMenu: Record<Category, MenuItem[]> = { desayuno: [], comida: [], bebida: [], extra: [] };
      for (const c of CATEGORIES) {
        if (allowed.includes(c)) windowMenu[c] = value.menu[c];
      }
      const windowItemCount = allowed.reduce((n, c) => n + windowMenu[c].length, 0);
      const windowEmpty = windowItemCount === 0;

      // TELEMETRY ONLY — never served, never branched on. Computed against the
      // CLOCK's window rather than the enforced one, so the shadow row shows the
      // rule's real effect before cutover. The original bug: this was logged as
      // `windowItemCount`, which pre-cutover is derived from an unfiltered
      // `allowed` and therefore always equalled `item_count` (61 == 61 in BOTH
      // windows) — a shadow number that could not differ from the unfiltered one
      // is decorative, and it manufactured confidence the data never earned.
      // When hours ARE enforced this is identical to `windowItemCount` by
      // construction (`win === serviceWindow(now)`), so the field means the same
      // thing in both modes: what the window rule would serve.
      const wouldServeItemCount = allowedCategories(serviceWindow(now))
        .reduce((n, c) => n + value.menu[c].length, 0);

      logInBackground(call_sid, "get_daily_menu", {
        service_date: serviceDate,
        item_count: value.item_count,
        // Both fields below are computed from the CLOCK's window even when
        // unenforced, so a shadow row shows what enforcement WOULD have done and
        // can be checked against real traffic before the switch is flipped.
        // `item_count` above is what was actually served; when `hours_enforced`
        // is false the two are expected to DIFFER — if they never differ, the
        // shadow layer is not exercising the rule and proves nothing.
        window: win ?? `shadow:${serviceWindow(now)}`,
        hours_enforced: win !== null,
        window_item_count: wouldServeItemCount,
        local_time: now.hhmm,
        time_overridden: now.overridden,
        menu_not_set: value.menu_not_set,
        dropped: value.dropped,
        cache_hit: cacheHit,
        ms,
      });

      const res: Record<string, unknown> = {
        ok: true,
        closed: false,
        service_date: serviceDate,
        timezone: MENU_TZ,
        local_time: now.hhmm,
        currency: CURRENCY,
        menu_available: !value.menu_not_set && !windowEmpty,
        item_count: windowItemCount,
        menu: windowMenu,
      };
      if (win) {
        res.window = win;
        res.hours = HOURS_SPOKEN;
        res.window_instruction = windowInstruction(win);
      }

      if (value.menu_not_set) {
        // Explicit "not loaded" state — NEVER fall back to another day's rows
        // (core ledger B12). The prompt turns this into "let me check / I can
        // pass you to a person"; the instruction is a model hint, not speech.
        res.menu_not_set = true;
        res.instruction =
          "El menú de hoy aún no está cargado. No inventes platillos ni precios; ofrece verificar o transferir con una persona.";
      } else if (win && windowEmpty) {
        // The day's menu IS loaded, but nothing in it belongs to the CURRENT
        // window (e.g. no desayuno rows on a day that only has comidas). A
        // distinct, honest state — not "menu not loaded", not an empty silence.
        res.window_empty = true;
        res.instruction = win === "desayuno"
          ? "Hoy no hay desayunos cargados para esta hora. No inventes platillos ni precios; dilo con calidez y menciona que la comida del día empieza a las once y media."
          : "Hoy no hay platillos de comida cargados para esta hora. No inventes platillos ni precios; dilo con calidez y ofrece verificar más tarde.";
      } else if (win) {
        res.instruction = windowInstruction(win);
      }

      return json(res);
    }

    if (action === "compute_total") {
      const override = typeof body?.service_date === "string" ? body.service_date.trim() : "";
      const nowOverrideCT = typeof body?.now_override === "string" ? body.now_override.trim() : "";
      const nowCT = resolveNow(nowOverrideCT);
      if (!nowCT) {
        return json({ ok: false, error: "Invalid now_override (expected YYYY-MM-DDTHH:MM)" }, 400);
      }
      let serviceDate: string;
      if (override) {
        if (!isValidServiceDate(override)) {
          return json({ ok: false, error: "Invalid service_date (expected YYYY-MM-DD)" }, 400);
        }
        serviceDate = override;
      } else {
        serviceDate = nowCT.overridden ? nowCT.date : todayInTz(MENU_TZ);
      }

      // Closed: no quote, ever. Enforced here and not merely in the prompt, so
      // a model that "helpfully" quotes anyway still gets no number to say (V6).
      const winCT = enforcedWindow(nowCT);
      if (winCT === "closed") {
        logInBackground(call_sid, "compute_total", {
          service_date: serviceDate, closed: true, local_time: nowCT.hhmm, blocked: true,
        });
        return json({
          ok: true,
          closed: true,
          service_date: serviceDate,
          currency: CURRENCY,
          hours: HOURS_SPOKEN,
          spoken_message: closedSpokenMessage(nowCT),
          instruction: CLOSED_INSTRUCTION,
        });
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

      // Window enforcement (V6): the quote is computed first because only the
      // matched breakdown knows each item's real category — but if anything
      // falls outside the current window we return NO total/subtotal/breakdown,
      // so there is no number for the model to voice. Blocking after the maths
      // but before the response keeps the check honest without trusting names.
      // Computed UNCONDITIONALLY (observation, not action): pre-cutover this is
      // the ONLY evidence of whether the rule would have refused a real quote —
      // the expensive failure direction. Previously the whole filter sat behind
      // `winCT ? ... : []`, so in shadow mode it was never evaluated and every
      // pre-cutover quote logged `window: null` — zero coverage on the one path
      // that can refuse a paying customer.
      const shadowWinCT = serviceWindow(nowCT);
      const offWindowWouldBlock = (res.breakdown as QuoteLine[] | undefined ?? [])
        .filter((l) => !allowedCategories(shadowWinCT).includes(l.categoria));
      // ACTING stays gated on winCT. When enforced, winCT === shadowWinCT (the
      // "closed" case returned above), so this is byte-identical to the old
      // expression — the change is observational only.
      const offWindow = winCT ? offWindowWouldBlock : [];
      if (winCT && offWindow.length > 0) {
        logInBackground(call_sid, "compute_total", {
          service_date: serviceDate,
          window: winCT,
          hours_enforced: true,
          local_time: nowCT.hhmm,
          off_window_blocked: offWindow.map((l) => l.nombre),
        });
        return json({
          ok: true,
          service_date: serviceDate,
          currency: CURRENCY,
          window: winCT,
          off_window: true,
          off_window_items: offWindow.map((l) => l.nombre),
          instruction: winCT === "desayuno"
            ? "Uno o más de esos platillos son de la COMIDA del día y a esta hora solo se sirven DESAYUNOS. NO des ningún total. Explica con calidez que la comida del día empieza a las once y media y ofrece algo del desayuno."
            : "Uno o más de esos platillos son DESAYUNOS y a esta hora solo se sirve la COMIDA del día. NO des ningún total. Explica con calidez que los desayunos se sirven hasta las once y media y ofrece algo de la comida del día.",
        });
      }

      logInBackground(call_sid, "compute_total", {
        service_date: serviceDate,
        window: winCT ?? `shadow:${shadowWinCT}`,
        hours_enforced: winCT !== null,
        local_time: nowCT.hhmm,
        // Pre-cutover: which lines the window rule WOULD have refused. Empty on
        // a quote that enforcement would have let through untouched.
        off_window_would_block: offWindowWouldBlock.map((l) => l.nombre),
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

    if (action === "submit_order") {
      // Ops/test-only, mirrors service_date's existing override pattern —
      // NEVER present in the ElevenLabs tool schema, so the model can't set
      // either. dry_run proves every branch below without a real write, real
      // Telegram send, or real alert; simulate_failure forces a specific
      // failure branch deterministically for the same reason.
      const dryRun = body?.dry_run === true;
      const simulateFailure = body?.simulate_failure === "db" || body?.simulate_failure === "notify" ? body.simulate_failure : null;

      const override = typeof body?.service_date === "string" ? body.service_date.trim() : "";
      const nowOverrideSO = typeof body?.now_override === "string" ? body.now_override.trim() : "";
      const nowSO = resolveNow(nowOverrideSO);
      if (!nowSO) {
        return json({ ok: false, error: "Invalid now_override (expected YYYY-MM-DDTHH:MM)" }, 400);
      }
      let serviceDate: string;
      if (override) {
        if (!isValidServiceDate(override)) {
          return json({ ok: false, error: "Invalid service_date (expected YYYY-MM-DD)" }, 400);
        }
        serviceDate = override;
      } else {
        serviceDate = nowSO.overridden ? nowSO.date : todayInTz(MENU_TZ);
      }

      // CLOSED: refuse the order outright, before validation, idempotency, or
      // any write. Nobody is in the kitchen — an accepted order here becomes a
      // ticket nobody cooks and a customer who shows up to a locked door (V6).
      const winSO = enforcedWindow(nowSO);
      if (winSO === "closed") {
        logInBackground(call_sid, "submit_order", {
          service_date: serviceDate, closed: true, local_time: nowSO.hhmm, blocked: true,
        });
        return json({
          ok: true,
          closed: true,
          order_placed: false,
          hours: HOURS_SPOKEN,
          spoken_message: closedSpokenMessage(nowSO),
          instruction: CLOSED_INSTRUCTION,
        });
      }

      const conversationId = typeof body?.conversation_id === "string" && body.conversation_id.trim()
        ? body.conversation_id.trim()
        : null;

      const items = Array.isArray(body?.items) ? body.items : [];
      const modalidadRaw = body?.modalidad;
      const modalidad = typeof modalidadRaw === "string"
        ? modalidadRaw.toLowerCase().trim().replace(/^(?:para|a)\s+/, "")
        : "";

      const fieldCheck = validateOrderFields(body, modalidad);
      if (!fieldCheck.ok) {
        logInBackground(call_sid, "submit_order", { service_date: serviceDate, conversation_id: conversationId, validation_failed: true, missing: fieldCheck.missing });
        return json({
          ok: true,
          validation_failed: true,
          missing_fields: fieldCheck.missing,
          instruction:
            "Faltan o son inválidos algunos datos del pedido (ver missing_fields). NO confirmes el pedido todavía; pide con calidez el dato que falta y vuelve a intentar. Nunca inventes un dato.",
        });
      }

      if (items.length === 0) {
        return json({ ok: false, error: "submit_order requires a non-empty items array" }, 400);
      }

      // Idempotency: a hit means this exact ElevenLabs call already produced a
      // verified insert — answer idempotently, never insert a second row.
      if (conversationId && !dryRun) {
        const { data: existing } = await supabase
          .from("order_submissions")
          .select("order_row_id")
          .eq("conversation_id", conversationId)
          .maybeSingle();
        if (existing?.order_row_id) {
          logInBackground(call_sid, "submit_order", { service_date: serviceDate, conversation_id: conversationId, idempotent_hit: true, order_row_id: existing.order_row_id });
          return json({
            ok: true,
            order_row_id: existing.order_row_id,
            spoken_message: body?.style === "warm"
              ? "¡Listo! Tu pedido ya quedó. ¡Que lo disfrutes!"
              : "Muchísimas gracias. Ha sido un placer atenderte. Te deseamos un excelente día y que disfrutes tu comida.",
          });
        }
      }

      // Server-verified total: re-run the SAME computeTotal the caller already
      // heard from, never trust a number the model merely echoes back (V2).
      const quote = await computeTotal(serviceDate, items as QuoteItem[], modalidad);
      if (!quote.all_matched) {
        return json({ ok: true, total_mismatch: true, instruction: quote.instruction ?? "No se pudo confirmar el precio de uno o más platillos. No confirmes el pedido; vuelve a verificar." });
      }
      // Window enforcement on the WRITE path (V6). Checked against the same
      // server-verified breakdown used for the total — an order containing a
      // dish the kitchen isn't cooking right now is refused before any insert
      // or kitchen ticket, not merely discouraged in the prompt.
      // Computed UNCONDITIONALLY — same reasoning as compute_total above: the
      // write path is where a real order gets refused, so pre-cutover it needs
      // shadow evidence too. Observation only; ACTING stays gated on winSO.
      const shadowWinSO = serviceWindow(nowSO);
      const offWindowWouldBlockSO = (quote.breakdown as QuoteLine[])
        .filter((l) => !allowedCategories(shadowWinSO).includes(l.categoria));
      const offWindowSO = winSO ? offWindowWouldBlockSO : [];
      if (winSO && offWindowSO.length > 0) {
        logInBackground(call_sid, "submit_order", {
          service_date: serviceDate,
          conversation_id: conversationId,
          window: winSO,
          local_time: nowSO.hhmm,
          off_window_blocked: offWindowSO.map((l) => l.nombre),
        });
        return json({
          ok: true,
          order_placed: false,
          off_window: true,
          window: winSO,
          off_window_items: offWindowSO.map((l) => l.nombre),
          instruction: winSO === "desayuno"
            ? "Ese pedido trae platillos de la COMIDA del día y a esta hora solo se sirven DESAYUNOS. NO confirmes el pedido. Explica con calidez que la comida del día empieza a las once y media."
            : "Ese pedido trae DESAYUNOS y a esta hora solo se sirve la COMIDA del día. NO confirmes el pedido. Explica con calidez que los desayunos se sirven hasta las once y media.",
        });
      }

      const callerTotal = Number(body?.total);
      if (!Number.isFinite(callerTotal) || callerTotal !== quote.total) {
        logInBackground(call_sid, "submit_order", { service_date: serviceDate, conversation_id: conversationId, total_mismatch: true, caller_total: body?.total, server_total: quote.total });
        return json({
          ok: true,
          total_mismatch: true,
          instruction: "El total que traes no coincide con el total verificado por el sistema. NO confirmes ningún total ni pedido; vuelve a calcular con compute_total y confirma de nuevo con el cliente.",
        });
      }

      const breakdown = quote.breakdown as QuoteLine[];
      const byCat = (c: Category) => breakdown.filter((l) => l.categoria === c);
      const platillos = byCat("comida").map((l) => ({ nombre: l.nombre, precio: l.unit_price, cantidad: l.cantidad }));
      const bebidas = byCat("bebida").map((l) => ({ nombre: l.nombre, precio: l.unit_price, cantidad: l.cantidad }));
      const extraLines = byCat("extra");
      const extras = extraLines.map((l) => ({ name: l.nombre, price: l.unit_price, qty: l.cantidad }));
      const desayunoLines = byCat("desayuno");
      // Correctly derived from the verified breakdown (fixes a pre-existing
      // bug: the old n8n Code node hardcoded desayunos:false, comidas:true on
      // every order regardless of what was actually ordered). Not expanded
      // scope — this payload is built fresh here either way.
      const hasDesayuno = desayunoLines.length > 0;
      const hasComida = byCat("comida").length > 0 || hasDesayuno;

      const subtotal_comida = byCat("comida").reduce((s, l) => s + l.line_total, 0) + desayunoLines.reduce((s, l) => s + l.line_total, 0);
      const subtotal_bebidas = byCat("bebida").reduce((s, l) => s + l.line_total, 0);
      const subtotal_extras = extraLines.reduce((s, l) => s + l.line_total, 0);
      const precio_por_extra: Record<string, number> = {};
      for (const l of extraLines) precio_por_extra[l.nombre] = l.unit_price;

      const nowMs = Date.now();
      const horaExacta = new Intl.DateTimeFormat("es-MX", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: MENU_TZ,
      }).format(nowMs);
      const diaDeLaSemana = new Intl.DateTimeFormat("es-MX", { weekday: "long", timeZone: MENU_TZ }).format(nowMs);

      const orderPayload = {
        cliente_nombre: fieldCheck.fields.cliente_nombre,
        telefono: fieldCheck.fields.telefono,
        direccion: fieldCheck.fields.modalidad === "delivery" ? fieldCheck.fields.direccion : null,
        platillos_consumidos: { items: platillos.concat(desayunoLines.map((l) => ({ nombre: l.nombre, precio: l.unit_price, cantidad: l.cantidad }))) },
        bebidas,
        precio_total: quote.total,
        notas: fieldCheck.fields.notes || "N/A",
        proveniencia: "Agente de Voz",
        metodo_de_pago: fieldCheck.fields.metodo_de_pago,
        modalidad: fieldCheck.fields.modalidad,
        recoger: fieldCheck.fields.modalidad === "pickup",
        entrega_a_domicilio: fieldCheck.fields.modalidad === "delivery",
        dia_de_la_semana: diaDeLaSemana,
        cliente_nuevo: false, // no reliable signal available yet — same default the prior path used
        precio_por_platillo: platillos.map((p) => p.precio),
        precio_por_bebida: bebidas.map((b) => b.precio),
        cantidad_platillos: platillos.length,
        cantidad_bebidas: bebidas.length,
        subtotal_comida,
        subtotal_bebidas,
        extras,
        cantidad_extras: extras.length,
        subtotal_extras,
        precio_por_extra,
        hora_exacta: horaExacta,
        desayunos: hasDesayuno,
        comidas: hasComida,
        cargo_envio: quote.delivery_fee,
        fecha: new Date(nowMs).toISOString(),
      };

      // Naturalness pass (2026-07-19): a warm, ROTATING, name-aware farewell —
      // still 100% server-dictated (V8: the model reads spoken_message verbatim
      // and can never compose its own confirmation). Gated on the tool sending
      // style:"warm" as a constant, so the LIVE agent's fixed farewell stays
      // byte-identical until Edgar approves the warm variant by ear.
      const isWarm = body?.style === "warm";
      const firstName = fieldCheck.fields.cliente_nombre.split(/\s+/)[0].slice(0, 30);
      const warmSuccess = [
        `¡Gracias, ${firstName}! Ahí te va tu pedido en un ratito. ¡Que lo disfrutes!`,
        `¡Listo, ${firstName}! Ya quedó tu pedido. ¡Buen provecho, y gracias por llamar!`,
        `¡Sale, ${firstName}! Tu pedido ya está en la cocina. ¡Que lo disfrutes mucho!`,
        `¡Gracias por tu pedido, ${firstName}! En un ratito lo tienes. ¡Cuídate!`,
      ];
      const SUCCESS_MESSAGE = isWarm
        ? warmSuccess[Math.floor(Math.random() * warmSuccess.length)]
        : "Muchísimas gracias. Ha sido un placer atenderte. Te deseamos un excelente día y que disfrutes tu comida.";
      const CAPTURED_ONLY_MESSAGE = isWarm
        ? `${firstName}, tu pedido ya quedó guardado — nada más deja que alguien del equipo te confirme en un momentito, ¿va?`
        : "Tu pedido quedó registrado. En un momento alguien de nuestro equipo te confirma los detalles.";
      const FAILURE_MESSAGE = isWarm
        ? `Ay, ${firstName}, fíjate que tuve un problemita para registrar tu pedido — no te lo puedo confirmar todavía. ¿Te paso con alguien del equipo para que te lo tome de una vez?`
        : "Tuvimos un problema técnico para registrar tu pedido. No puedo confirmarlo todavía — con gusto te paso con una persona para que lo tome directamente.";

      if (dryRun) {
        // Every branch below is exercised WITHOUT a real insert, real
        // Telegram send, or real alert — proof, not production.
        if (simulateFailure === "db") {
          const cap = await captureFailure(call_sid, "order_submit_failed", { ...orderPayload, dry_run: true, simulated: true });
          const alert = await directAlert(`[DRY RUN] Simulated DB failure — order would have been lost. Captured: ${cap.captured}`);
          return json({ ok: false, dry_run: true, simulated: "db_failure", captured: cap.captured, capture_error: cap.error, alert_sent: alert.sent, alert_error: alert.error, spoken_message: FAILURE_MESSAGE, instruction: "No pudimos registrar el pedido. Discúlpate con honestidad y ofrece pasar con una persona. NO confirmes el pedido." });
        }
        if (simulateFailure === "notify") {
          const notify = await notifyKitchen(orderPayload, true);
          const cap = await captureFailure(call_sid, "order_notify_failed", { ...orderPayload, dry_run: true, simulated: true, order_row_id: -1 });
          const alert = await directAlert(`[DRY RUN] Simulated notify failure — order row would exist but kitchen not told. Captured: ${cap.captured}`);
          return json({ ok: true, dry_run: true, simulated: "notify_failure", order_captured: true, kitchen_notify_failed: true, notify_attempts: notify.attempts, captured: cap.captured, alert_sent: alert.sent, spoken_message: CAPTURED_ONLY_MESSAGE, instruction: "El pedido quedó registrado pero no se pudo avisar a cocina. Di la frase honesta indicada; NO uses la confirmación completa de 'ha sido un placer'." });
        }
        return json({ ok: true, dry_run: true, order_row_id: -1, would_insert: orderPayload, spoken_message: SUCCESS_MESSAGE });
      }

      // --- Real write path ---
      let newId: number | null = null;
      if (simulateFailure !== "db") {
        try {
          const { data, error } = await supabase.rpc("api_insert_orden_av_flex", { payload: orderPayload });
          if (error) throw error;
          newId = typeof data === "number" ? data : Number(data);
          if (!Number.isFinite(newId)) throw new Error(`RPC returned non-numeric id: ${JSON.stringify(data)}`);
        } catch (err: any) {
          newId = null;
          (orderPayload as any).__rpc_error = String(err?.message ?? err);
        }
      }

      if (newId == null) {
        const cap = await captureFailure(call_sid, "order_submit_failed", orderPayload);
        const alert = await directAlert(`Karmen: DB insert FAILED for a customer order. call_sid=${call_sid ?? "?"} captured=${cap.captured}. Check voice_events.order_submit_failed.`);
        logInBackground(call_sid, "submit_order", { service_date: serviceDate, conversation_id: conversationId, db_write_failed: true, captured: cap.captured, alert_sent: alert.sent });
        return json({
          ok: false,
          spoken_message: FAILURE_MESSAGE,
          instruction: "No pudimos registrar el pedido en el sistema. Discúlpate con honestidad, NO confirmes el pedido, y ofrece pasar con una persona (transfer_to_number).",
        });
      }

      if (conversationId) {
        // Best-effort; ON CONFLICT is not needed because a genuine race here
        // means someone else already recorded this exact conversation_id —
        // the real order row (newId) is already safely written either way.
        await supabase.from("order_submissions").insert({ conversation_id: conversationId, order_row_id: newId }).select().maybeSingle();
      } else {
        logInBackground(call_sid, "submit_order", { service_date: serviceDate, order_row_id: newId, no_conversation_id: true, note: "idempotency not enforceable for this call" });
      }

      const notify = await notifyKitchen(orderPayload, simulateFailure === "notify");
      if (!notify.sent) {
        const cap = await captureFailure(call_sid, "order_notify_failed", { ...orderPayload, order_row_id: newId });
        const alert = await directAlert(`Karmen: kitchen notify FAILED after ${notify.attempts} attempts for order #${newId}. call_sid=${call_sid ?? "?"} captured=${cap.captured}. Error: ${notify.error}`);
        logInBackground(call_sid, "submit_order", { service_date: serviceDate, conversation_id: conversationId, order_row_id: newId, notify_failed: true, notify_error: notify.error, captured: cap.captured, alert_sent: alert.sent });
        return json({
          ok: true,
          order_row_id: newId,
          order_captured: true,
          kitchen_notify_failed: true,
          spoken_message: CAPTURED_ONLY_MESSAGE,
          instruction: "El pedido se registró pero no se pudo avisar a cocina automáticamente. Di la frase honesta indicada — NO uses la confirmación completa de 'ha sido un placer atenderte' con la promesa de que ya se está preparando.",
        });
      }

      logInBackground(call_sid, "submit_order", { service_date: serviceDate, conversation_id: conversationId, order_row_id: newId, total: quote.total, modalidad: fieldCheck.fields.modalidad, ok: true, window: winSO ?? `shadow:${shadowWinSO}`, hours_enforced: winSO !== null, local_time: nowSO.hhmm, off_window_would_block: offWindowWouldBlockSO.map((l) => l.nombre) });
      const successRes: Record<string, unknown> = { ok: true, order_row_id: newId, spoken_message: SUCCESS_MESSAGE };
      if (isWarm) {
        // K9-style server-side discipline: the instruction arrives at the exact
        // decision moment, which prompt-only rules obey ~50/50 at temp 0.4
        // (observed: farewell spoken AND repeated in end_call's message).
        successRes.instruction =
          "La despedida se dice UNA sola vez y SOLO a través de end_call: llama end_call AHORA con el spoken_message completo como mensaje. NO escribas tú ningún texto de despedida — el sistema la dirá al colgar.";
      }
      return json(successRes);
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
