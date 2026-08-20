import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Casa D'Karmen menu admin — the WRITE path (Stage 3, Phases 1–2). The owner's
// daily-menu app calls this to set today's menu WITHOUT hand-editing a prompt or a
// SQL seed. It is the deliberate counterpart to karmen-gateway (the read path):
// separate function, separate secret, mirroring the gateway's fail-closed posture.
//
// GUARDRAILS (hard): additive only. Writes ONLY public.daily_menu (+ reads
// public.menu_catalog) via the service role; daily_menu stays RLS deny-all so the
// browser cannot write it directly. Touches nothing on karmen-gateway, Karmen's
// prompt, ordenes*, chat_context, n8n_chat_histories, ordenes_unificadas, or n8n.
// A past service_date is NEVER writable (a served day is history). "Today" is
// resolved in America/Mazatlan — identical logic to the gateway — so the editor and
// Karmen always agree on which day is "today".

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Two-var secret rotation, fail-closed — SEPARATE from the gateway's read secret,
// because write is more sensitive than read. If NEITHER is set, nothing can match
// and every request is refused.
const ADMIN_SECRET = Deno.env.get("KARMEN_ADMIN_SECRET") ?? "";
const ADMIN_SECRET_NEW = Deno.env.get("KARMEN_ADMIN_SECRET_NEW") ?? "";

// Sinaloa (Guasave) is America/Mazatlan: UTC-7, no DST. "Today" MUST be resolved
// here, never in UTC — after UTC-midnight a UTC date would edit the wrong day.
const MENU_TZ = "America/Mazatlan";
const CURRENCY = "MXN";

const CATEGORIES = ["desayuno", "comida", "bebida", "extra"] as const;
type Category = (typeof CATEGORIES)[number];

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-karmen-admin-secret,authorization,apikey",
  "access-control-allow-methods": "POST,OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

// Best-effort audit into the existing voice_events table (additive reuse). Never
// blocks or breaks the write on a telemetry failure.
async function safeLog(event_type: string, payload: Record<string, unknown>) {
  try {
    await supabase.from("voice_events").insert({ call_sid: null, event_type, payload });
  } catch {
    // swallow — telemetry must never break an admin write
  }
}
function logInBackground(event_type: string, payload: Record<string, unknown>) {
  const p = safeLog(event_type, payload);
  try {
    (globalThis as any).EdgeRuntime?.waitUntil?.(p);
  } catch {
    // waitUntil unavailable — safeLog still runs
  }
}

// Fail-closed: neither secret set OR no match → unauthorized.
function isAuthorized(provided: string | null): boolean {
  if (!provided) return false;
  if (ADMIN_SECRET && provided === ADMIN_SECRET) return true;
  if (ADMIN_SECRET_NEW && provided === ADMIN_SECRET_NEW) return true;
  return false;
}

// Current calendar date in the restaurant's timezone. en-CA => YYYY-MM-DD, exactly
// the shape of daily_menu.service_date. String compare on YYYY-MM-DD is chronological.
function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidServiceDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

// Resolve an incoming service_date: default = today (America/Mazatlan). A provided
// value must be valid AND (for writes) not in the past. Returns {date} or {error}.
function resolveDate(
  raw: unknown,
  { allowPast }: { allowPast: boolean },
): { date: string } | { error: string } {
  const today = todayInTz(MENU_TZ);
  if (raw == null || raw === "") return { date: today };
  const s = String(raw).trim();
  if (!isValidServiceDate(s)) return { error: "service_date inválido (se espera YYYY-MM-DD)." };
  if (!allowPast && s < today) {
    return { error: `No se puede editar un día pasado (${s}). El día ya sirvió; solo hoy o futuro.` };
  }
  return { date: s };
}

// Coerce/validate a price: finite number >= 0. postgREST returns numeric as string.
function parsePrice(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// ---- DISH PHOTOS (additive, read-only) --------------------------------------
// Same source of truth as the gateway/ordering site: menu_catalog.photo_path,
// a filename in the PUBLIC "platos" bucket. list_catalog reads the column
// directly; list_day joins by normalized (category, item_name) — identical
// matching to the gateway so the admin and the site always show the same
// photo for the same dish. Decoration is fail-soft: a photo lookup failure
// degrades to the exact pre-photo response, never breaks the action.
const PHOTO_BUCKET = "platos";

function photoUrl(path: unknown): string | null {
  const p = String(path ?? "").trim();
  if (!p) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${encodeURIComponent(p)}`;
}

// Same normalization the gateway uses for its photo join — case, accents,
// and whitespace never break the match.
function normalizeName(s: string): string {
  return String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function loadPhotoMap(): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("menu_catalog")
    .select("category,item_name,photo_path")
    .not("photo_path", "is", null);
  if (error) throw error;
  const map = new Map<string, string>();
  for (const r of (data ?? []) as any[]) {
    const path = String(r.photo_path ?? "").trim();
    if (path) map.set(`${r.category}|${normalizeName(String(r.item_name))}`, path);
  }
  return map;
}

// ---- ACTIONS ---------------------------------------------------------------

// list_day: ALL rows for a day, INCLUDING is_available=false (unlike the gateway,
// which hides them) so the owner can un-sell-out an item. Ordered category, then
// sort_order (nulls last), then name.
async function listDay(body: any) {
  const r = resolveDate(body?.service_date, { allowPast: true }); // reading a past day is fine
  if ("error" in r) return json({ ok: false, error: r.error }, 400);

  const { data, error } = await supabase
    .from("daily_menu")
    .select("id,service_date,category,item_name,price,sides,is_available,sort_order")
    .eq("service_date", r.date);
  if (error) throw error;

  const rows: any[] = (Array.isArray(data) ? data : []).map((x: any) => ({
    id: x.id,
    category: x.category as Category,
    item_name: x.item_name,
    price: Number(x.price),
    sides: x.sides ?? null,
    is_available: x.is_available,
    sort_order: x.sort_order,
  }));
  rows.sort((a, b) => {
    if (a.category !== b.category) return CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category);
    const sa = a.sort_order == null ? Number.POSITIVE_INFINITY : Number(a.sort_order);
    const sb = b.sort_order == null ? Number.POSITIVE_INFINITY : Number(b.sort_order);
    if (sa !== sb) return sa - sb;
    return String(a.item_name).localeCompare(String(b.item_name), "es");
  });

  // Photo decoration — fail-soft: on any lookup error, return the exact
  // pre-photo response and log the failure distinctly.
  try {
    const photoMap = await loadPhotoMap();
    for (const row of rows) {
      const path = photoMap.get(`${row.category}|${normalizeName(row.item_name)}`);
      if (path) {
        row.photo_path = path;
        row.photo_url = photoUrl(path);
      }
    }
  } catch (err: any) {
    logInBackground("menu_admin_photo_map_error", { error: String(err?.message ?? err) });
  }

  return json({
    ok: true,
    service_date: r.date,
    timezone: MENU_TZ,
    currency: CURRENCY,
    item_count: rows.length,
    items: rows,
  });
}

// list_catalog: active reusable dishes for the picker.
async function listCatalog() {
  const { data, error } = await supabase
    .from("menu_catalog")
    .select("id,category,item_name,default_price,default_sides,sort_hint,is_active,photo_path")
    .eq("is_active", true);
  if (error) throw error;

  const rows = (Array.isArray(data) ? data : []).map((x: any) => ({
    id: x.id,
    category: x.category as Category,
    item_name: x.item_name,
    default_price: Number(x.default_price),
    default_sides: x.default_sides ?? null,
    sort_hint: x.sort_hint,
    // Additive: null for dishes without a photo — existing clients ignore it.
    photo_path: String(x.photo_path ?? "").trim() || null,
    photo_url: photoUrl(x.photo_path),
  }));
  rows.sort((a, b) => {
    if (a.category !== b.category) return CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category);
    const sa = a.sort_hint == null ? Number.POSITIVE_INFINITY : Number(a.sort_hint);
    const sb = b.sort_hint == null ? Number.POSITIVE_INFINITY : Number(b.sort_hint);
    if (sa !== sb) return sa - sb;
    return String(a.item_name).localeCompare(String(b.item_name), "es");
  });

  return json({ ok: true, item_count: rows.length, catalog: rows });
}

// upsert_item: add or edit one dish on a day. Natural idempotency via the
// (service_date, category, item_name) unique key — a repeat with the same values
// is a no-op update.
async function upsertItem(body: any) {
  const r = resolveDate(body?.service_date, { allowPast: false });
  if ("error" in r) return json({ ok: false, error: r.error }, 400);

  const category = typeof body?.category === "string" ? body.category.toLowerCase() : "";
  if (!CATEGORIES.includes(category as Category)) {
    return json({ ok: false, error: "category debe ser desayuno, comida, bebida o extra." }, 400);
  }
  const item_name = typeof body?.item_name === "string" ? body.item_name.trim() : "";
  if (!item_name) return json({ ok: false, error: "item_name es obligatorio." }, 400);

  const price = parsePrice(body?.price);
  if (price == null) return json({ ok: false, error: "price debe ser un número mayor o igual a 0." }, 400);

  const sidesRaw = body?.sides;
  const sides = sidesRaw == null || String(sidesRaw).trim() === "" ? null : String(sidesRaw).trim();
  const sortRaw = body?.sort_order;
  const sort_order =
    sortRaw == null || sortRaw === "" || !Number.isFinite(Number(sortRaw)) ? null : Math.trunc(Number(sortRaw));
  const is_available = typeof body?.is_available === "boolean" ? body.is_available : true;

  const row = {
    service_date: r.date,
    category,
    item_name,
    price,
    sides,
    is_available,
    sort_order,
  };

  const { data, error } = await supabase
    .from("daily_menu")
    .upsert(row, { onConflict: "service_date,category,item_name" })
    .select("id,service_date,category,item_name,price,sides,is_available,sort_order")
    .single();
  if (error) throw error;

  // A genuinely new dish also becomes reusable for future days (build spec:
  // "escribe uno nuevo" path ... it also lands in menu_catalog). DO NOTHING on
  // conflict — never overwrite a curated catalog default with today's one-off
  // price. Best-effort: a catalog-side failure must never fail the menu write
  // that already succeeded.
  const { error: catalogErr } = await supabase
    .from("menu_catalog")
    .upsert(
      { category, item_name, default_price: price, default_sides: sides },
      { onConflict: "category,item_name", ignoreDuplicates: true },
    );
  if (catalogErr) {
    logInBackground("menu_admin_catalog_upsert_failed", {
      category,
      item_name,
      error: String((catalogErr as any)?.message ?? catalogErr),
    });
  }

  logInBackground("menu_admin_upsert_item", { service_date: r.date, category, item_name, price });

  // Same fail-soft photo decoration as list_day, so an optimistic UI that
  // swaps in this response never loses a thumbnail it already had.
  const item: any = { ...data, price: Number((data as any).price) };
  try {
    const photoMap = await loadPhotoMap();
    const path = photoMap.get(`${category}|${normalizeName(item_name)}`);
    if (path) {
      item.photo_path = path;
      item.photo_url = photoUrl(path);
    }
  } catch (err: any) {
    logInBackground("menu_admin_photo_map_error", { error: String(err?.message ?? err) });
  }
  return json({ ok: true, item });
}

// set_available: the sold-out toggle. Today/future only (a served day is history).
async function setAvailable(body: any) {
  const id = Number(body?.id);
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: "id inválido." }, 400);
  if (typeof body?.is_available !== "boolean") {
    return json({ ok: false, error: "is_available debe ser true o false." }, 400);
  }

  // Guard: never mutate a past day. Look up the row's date first.
  const { data: existing, error: readErr } = await supabase
    .from("daily_menu")
    .select("id,service_date")
    .eq("id", id)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!existing) return json({ ok: false, error: "No existe un platillo con ese id." }, 404);
  const today = todayInTz(MENU_TZ);
  if (String((existing as any).service_date) < today) {
    return json({ ok: false, error: "No se puede modificar un día pasado." }, 400);
  }

  const { data, error } = await supabase
    .from("daily_menu")
    .update({ is_available: body.is_available })
    .eq("id", id)
    .select("id,service_date,category,item_name,price,sides,is_available,sort_order")
    .single();
  if (error) throw error;

  logInBackground("menu_admin_set_available", { id, is_available: body.is_available });
  return json({ ok: true, item: { ...data, price: Number((data as any).price) } });
}

// delete_item: hard-remove one dish from a day. Today/future only.
async function deleteItem(body: any) {
  const id = Number(body?.id);
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: "id inválido." }, 400);

  const { data: existing, error: readErr } = await supabase
    .from("daily_menu")
    .select("id,service_date,category,item_name")
    .eq("id", id)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!existing) return json({ ok: false, error: "No existe un platillo con ese id.", deleted: 0 }, 404);
  const today = todayInTz(MENU_TZ);
  if (String((existing as any).service_date) < today) {
    return json({ ok: false, error: "No se puede eliminar de un día pasado.", deleted: 0 }, 400);
  }

  const { error } = await supabase.from("daily_menu").delete().eq("id", id);
  if (error) throw error;

  logInBackground("menu_admin_delete_item", {
    id,
    service_date: (existing as any).service_date,
    item_name: (existing as any).item_name,
  });
  return json({ ok: true, deleted: 1, id });
}

// copy_day: clone a source day's rows into a target day. ON CONFLICT DO NOTHING so
// it NEVER clobbers an edit the owner already made on the target day. If from_date
// is omitted, use the most recent PRIOR day that has rows.
async function copyDay(body: any) {
  const to = resolveDate(body?.to_date, { allowPast: false });
  if ("error" in to) return json({ ok: false, error: to.error }, 400);
  const toDate = to.date;

  // Resolve source: explicit from_date (must be valid, and != target), else the most
  // recent day strictly before the target that actually has rows.
  let fromDate: string;
  if (body?.from_date != null && body?.from_date !== "") {
    const s = String(body.from_date).trim();
    if (!isValidServiceDate(s)) return json({ ok: false, error: "from_date inválido (YYYY-MM-DD)." }, 400);
    fromDate = s;
  } else {
    const { data, error } = await supabase
      .from("daily_menu")
      .select("service_date")
      .lt("service_date", toDate)
      .order("service_date", { ascending: false })
      .limit(1);
    if (error) throw error;
    if (!data || data.length === 0) {
      return json({ ok: false, error: "No hay un día anterior con menú para copiar." }, 404);
    }
    fromDate = String((data[0] as any).service_date);
  }
  if (fromDate === toDate) {
    return json({ ok: false, error: "from_date y to_date no pueden ser el mismo día." }, 400);
  }

  const { data: srcRows, error: srcErr } = await supabase
    .from("daily_menu")
    .select("category,item_name,price,sides,is_available,sort_order")
    .eq("service_date", fromDate);
  if (srcErr) throw srcErr;
  if (!srcRows || srcRows.length === 0) {
    return json({ ok: false, error: `El día origen ${fromDate} no tiene platillos.` }, 404);
  }

  // Which (category,item_name) already exist on the target — those are preserved
  // (conflict rows), never overwritten.
  const { data: existingRows, error: exErr } = await supabase
    .from("daily_menu")
    .select("category,item_name")
    .eq("service_date", toDate);
  if (exErr) throw exErr;
  const existingKeys = new Set(
    (existingRows ?? []).map((x: any) => `${x.category}|${x.item_name}`),
  );

  const toInsert = (srcRows as any[])
    .filter((x) => !existingKeys.has(`${x.category}|${x.item_name}`))
    .map((x) => ({
      service_date: toDate,
      category: x.category,
      item_name: x.item_name,
      price: x.price,
      sides: x.sides,
      is_available: x.is_available,
      sort_order: x.sort_order,
    }));

  let inserted = 0;
  if (toInsert.length > 0) {
    // ignoreDuplicates = ON CONFLICT DO NOTHING — belt-and-suspenders with the
    // pre-filter above, so a concurrent edit can't cause a clobber or an error.
    const { data, error } = await supabase
      .from("daily_menu")
      .upsert(toInsert, { onConflict: "service_date,category,item_name", ignoreDuplicates: true })
      .select("id");
    if (error) throw error;
    inserted = Array.isArray(data) ? data.length : 0;
  }

  logInBackground("menu_admin_copy_day", { from_date: fromDate, to_date: toDate, inserted });
  return json({
    ok: true,
    from_date: fromDate,
    to_date: toDate,
    source_count: srcRows.length,
    skipped_existing: srcRows.length - toInsert.length,
    inserted,
  });
}

// ---- ROUTER ----------------------------------------------------------------

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const secret = req.headers.get("x-karmen-admin-secret");
  if (!isAuthorized(secret)) {
    logInBackground("menu_admin_unauthorized", { has_secret: !!secret });
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const action = typeof body?.action === "string" ? body.action : "";
  if (!action) return json({ ok: false, error: "Missing action" }, 400);

  try {
    switch (action) {
      case "list_day":
        return await listDay(body);
      case "list_catalog":
        return await listCatalog();
      case "upsert_item":
        return await upsertItem(body);
      case "set_available":
        return await setAvailable(body);
      case "delete_item":
        return await deleteItem(body);
      case "copy_day":
        return await copyDay(body);
      default:
        return json({ ok: false, error: `Unknown action: ${action}` }, 400);
    }
  } catch (err: any) {
    // Raw DB/internal text never leaks to the client. Full detail → voice_events.
    logInBackground("menu_admin_error", { action, error: String(err?.message ?? err) });
    return json(
      { ok: false, error: { code: "temporarily_unavailable", message: "Problema temporal del sistema. Intenta de nuevo." } },
      500,
    );
  }
});
