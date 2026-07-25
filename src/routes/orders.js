import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { assertBakerOwns } from '../lib/tenantScope.js';
import { config } from '../config.js';
import { notifyOrderPlaced, notifyDesignUpdated, notifyQuoteIssued, notifyQuoteAccepted, notifyQuoteQuestion, notifyOrderConfirmed, notifyOrderReady, notifyOrderCompleted } from '../services/notifications.js';
import { getOrderStatuses, getValidStatusKeys, isQuotePhase, idForKey } from '../lib/orderStatuses.js';
import { getDietaryRequirements, validateDietaryKeys, setOrderDietaryRequirements } from '../lib/dietaryRequirements.js';
import { getOrderAcceptance } from '../services/entitlements.js';
import { deleteObject } from '../services/r2.js';
import { logError } from '../lib/telemetry.js';
import { recordConsent } from '../services/legalConsent.js';
import { CONSENT_SUBJECT_TYPE, CONSENT_SOURCE, CONSENT_REQUIRED_DOC_KEYS } from '../constants/legalDocuments.js';

// Baker may attach at most this many photos to an order — per set (finished or reference).
const MAX_ORDER_PHOTOS = 3;

// Trial/plan gate at the storefront's order INTAKE — shares getOrderAcceptance with
// the storefront banner so the two can't drift. A baker stops taking NEW orders once
// their subscription lapses (Spark's 30-day window) OR they hit their plan's lifetime
// order cap. Gates CREATION only — existing orders stay manageable. Customer-facing.
// Returns a {error, code} block payload, or null when the baker can take the order.
async function orderIntakeBlock(bakerId) {
  const { accepting, code } = await getOrderAcceptance(bakerId);
  if (accepting) return null;
  return { error: "This bakery isn't accepting new orders right now.", code };
}

function toPublicUrl(key) {
  if (!key) return null;
  return `${config.r2.publicUrl}/${key}`;
}

// orders stores the compact `status_id`; reads embed `order_statuses ( key )`. This
// flattens a read row back to a readable `status` key for the HTTP response + route
// code, dropping the surrogate so callers never see ids. (Writes go the other way via
// idForKey.) Tolerates an already-flattened row (keeps its `status`).
function withStatusKey(row) {
  if (!row) return row;
  const { order_statuses, status_id, ...rest } = row;
  return { ...rest, status: order_statuses?.key ?? rest.status ?? null };
}

// Dietary requirements live in a child table, so reads embed them and this flattens
// the embed to a plain array of keys ( ['eggless'] ) for the HTTP response.
//
// Only rewrites the row when the embed was actually SELECTED. That matters: an absent
// key means "not fetched", while `dietary_requirements: []` means "this order states
// none" — and quietly turning the first into the second would let a caller that forgot
// the embed conclude a cake has no requirements. Same reason withStatusKey tolerates
// an already-flattened row instead of guessing.
const DIETARY_EMBED = 'order_dietary_requirements ( dietary_requirements ( key ) )';

function withDietaryKeys(row) {
  if (!row || !('order_dietary_requirements' in row)) return row;
  const { order_dietary_requirements, ...rest } = row;
  return {
    ...rest,
    dietary_requirements: (order_dietary_requirements ?? [])
      .map(r => r.dietary_requirements?.key)
      .filter(Boolean)
      .sort(),
  };
}

// A quote is "stale" when a design version exists past the one it priced — i.e. the
// design changed after the quote was issued. Derived, never stored.
function quoteStale(order) {
  return !!order.quoted_version_id && order.quoted_version_id !== order.current_version_id;
}

// Customer-facing order shape — everything the customer may see, NEVER the internal
// suggested_price. Includes design_snapshot so they can re-open/refine.
const CUSTOMER_ORDER_FIELDS = `
  id, status_id, order_statuses ( key ), quoted_price, quote_line_items, quote_valid_until, final_price,
  advance_amount, quote_note, advance_paid_at,
  weight_kg, flavours, special_instructions,
  order_dietary_requirements ( dietary_requirements ( key ) ),
  delivery_date, delivery_time, delivery_mode, delivery_address,
  design_thumbnail_url, design_snapshot, current_version_id, quoted_version_id,
  created_at, updated_at, baker_id, customer_id,
  bakers ( name, slug )
`;

function toCustomerOrder(o) {
  const { baker_id, customer_id, bakers, order_statuses, status_id, ...rest } = withDietaryKeys(o);
  return {
    ...rest,
    status:               order_statuses?.key ?? rest.status ?? null,
    baker_name:           bakers?.name ?? null,
    design_thumbnail_url: toPublicUrl(o.design_thumbnail_url),
    quote_stale:          quoteStale(o),
  };
}

// Load an order and verify the authenticated user is the customer who owns it
// (their auth_user_id is bound to the order's customer). Returns { order } or
// { status, error } for the route to return.
async function loadCustomerOrder(authUserId, orderId) {
  const { data: order } = await supabase
    .from('orders').select(CUSTOMER_ORDER_FIELDS).eq('id', orderId).maybeSingle();
  if (!order) return { status: 404, error: 'Order not found' };

  const { data: customer } = await supabase
    .from('customers').select('id')
    .eq('id', order.customer_id).eq('auth_user_id', authUserId).maybeSingle();
  if (!customer) return { status: 403, error: 'Not your order' };

  // Flatten status_id → readable `status` key so the route checks (order.status) work.
  return { order: withStatusKey(order) };
}

// Shared validation for the design + delivery part of an order body. Customer
// identity is validated separately because the trust boundary differs per entry
// point (public form vs. authenticated session). Returns an error string or null.
function validateOrderBody(body) {
  const { designSnapshot, deliveryMode = 'pickup', deliveryAddress } = body;
  if (!designSnapshot) return 'designSnapshot is required';
  if (!['pickup', 'home_delivery'].includes(deliveryMode)) return 'deliveryMode must be pickup or home_delivery';
  if (deliveryMode === 'home_delivery' && !deliveryAddress) return 'deliveryAddress is required for home_delivery';
  return null;
}

// Shared order creation: insert the row + fire-and-forget the baker notification.
// Callers resolve the baker and the customer FIRST (that's where the trust
// boundary lives) and hand a resolved customerId + contact here. Throws on insert
// error so the caller's try/catch maps it to a 500.
// Find-or-create a customer within a baker by email (preferred) or phone. Returns
// { customerId, emailNorm, phoneNorm }. Shared by the public order route and the
// baker's manual-order route (same upsert, different `source` label). Throws on insert
// error so the caller's try/catch maps it to a 500.
async function upsertCustomer(bakerId, customer, { source = 'online_order' } = {}) {
  const emailNorm = customer.email?.toLowerCase().trim() || null;
  const phoneNorm = customer.phone?.trim() || null;

  let lookup = supabase.from('customers').select('id').eq('baker_id', bakerId);
  lookup = emailNorm ? lookup.eq('email', emailNorm) : lookup.eq('phone', phoneNorm);
  let { data: existing } = await lookup.maybeSingle();

  if (!existing) {
    const { data: created, error } = await supabase
      .from('customers')
      .insert({
        baker_id:   bakerId,
        email:      emailNorm,
        first_name: customer.firstName,
        last_name:  customer.lastName ?? null,
        phone:      phoneNorm,
        source,
      })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    existing = created;
  }
  return { customerId: existing.id, emailNorm, phoneNorm };
}

async function insertOrderAndNotify({ baker, customerId, customerContact, body, authoredBy = 'customer', uploadedBy = null }) {
  const {
    designSnapshot = null, designThumbnailKey, referenceKeys, weightKg, flavours,
    specialInstructions, deliveryDate, deliveryTime,
    deliveryMode = 'pickup', deliveryAddress, dietaryRequirementKeys,
  } = body;

  // A manual order has no design — its picture is the primary reference photo. The
  // thumbnail mirror (design_thumbnail_url) holds whichever picture exists, so list/
  // detail/email render unchanged.
  const refKeys = Array.isArray(referenceKeys) ? referenceKeys : [];
  const thumbnailUrl = designThumbnailKey ?? refKeys[0] ?? null;

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .insert({
      baker_id:             baker.id,
      customer_id:          customerId,
      design_snapshot:      designSnapshot,          // null for a manual (no-designer) order
      design_thumbnail_url: thumbnailUrl,
      weight_kg:            weightKg ?? null,
      flavours:             flavours ?? null,
      special_instructions: specialInstructions ?? null,
      delivery_date:        deliveryDate ?? null,
      delivery_time:        deliveryTime ?? null,
      delivery_mode:        deliveryMode,
      delivery_address:     deliveryAddress ?? null,
      // Both the customer request and the baker walk-in start at 'requested'; the
      // baker advances from there. (status_id is a surrogate FK — set it explicitly,
      // there's no literal DB default for it.)
      status_id:            await idForKey('requested'),
    })
    .select('id, created_at')
    .single();

  if (orderError) throw new Error(orderError.message);

  // Seed version 1 of the design (append-only history starts here) — ONLY when there
  // is a design. A manual order has none, so the version table (design_snapshot NOT
  // NULL) is correctly left empty and X-Ray/Edit-in-3D stay off (they gate on the
  // snapshot).
  if (designSnapshot) {
    await appendDesignVersion({ orderId: order.id, designSnapshot, thumbnailKey: thumbnailUrl, authoredBy });
  }

  // Dietary requirements (eggless / allergen). Written HERE rather than in each route
  // because all three intake paths — the public designer, the storefront customer, and
  // the baker's manual order — funnel through this function, so one write covers every
  // way an order can be created and none can silently skip it.
  //
  // `authoredBy` already distinguishes those paths ('customer' by default, 'baker' for
  // a manual order), and that is exactly the assertion source the column records: the
  // customer stating their own requirement, or the baker writing down what a customer
  // told them on the phone. Keys were validated by the caller (validateDietaryKeys)
  // before we got here, so an unknown key is already a 400 rather than a silent drop.
  if (Array.isArray(dietaryRequirementKeys) && dietaryRequirementKeys.length) {
    await setOrderDietaryRequirements(order.id, dietaryRequirementKeys, authoredBy);
  }

  // Reference-photo gallery (manual orders only; ≤3, validated by the caller).
  if (refKeys.length) {
    const rows = refKeys.map((key, i) => ({ order_id: order.id, key, sort_order: i, uploaded_by: uploadedBy }));
    const { error: refErr } = await supabase.from('order_reference_photos').insert(rows);
    if (refErr) throw new Error(refErr.message);
  }

  // Insert notifications and enqueue — fire and forget, non-blocking
  notifyOrderPlaced({
    order: { ...order, delivery_date: deliveryDate, delivery_time: deliveryTime, delivery_mode: deliveryMode, delivery_address: deliveryAddress, weight_kg: weightKg, flavours, special_instructions: specialInstructions, design_thumbnail_url: toPublicUrl(thumbnailUrl) },
    baker,
    customer: customerContact,
  }).catch(err => console.error('[notifications] failed:', err.message));

  return order;
}

// Append a new design version (append-only history) and advance the order's current
// pointer + denormalized snapshot mirror. Used on order create (v1) and on every
// subsequent design edit (customer or baker). The UNIQUE(order_id, version_no)
// constraint is the integrity backstop if two edits race for the same number.
async function appendDesignVersion({ orderId, designSnapshot, thumbnailKey = null, authoredBy }) {
  const { data: last } = await supabase
    .from('order_design_versions')
    .select('version_no')
    .eq('order_id', orderId)
    .order('version_no', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextNo = (last?.version_no ?? 0) + 1;

  const { data: version, error: vErr } = await supabase
    .from('order_design_versions')
    .insert({
      order_id:             orderId,
      version_no:           nextNo,
      design_snapshot:      designSnapshot,
      design_thumbnail_url: thumbnailKey,
      authored_by:          authoredBy,
    })
    .select('id, version_no')
    .single();
  if (vErr) throw new Error(vErr.message);

  const { error: uErr } = await supabase
    .from('orders')
    .update({ current_version_id: version.id, design_snapshot: designSnapshot, design_thumbnail_url: thumbnailKey })
    .eq('id', orderId);
  if (uErr) throw new Error(uErr.message);

  return version;
}

const router = Router();

// ── POST /api/orders ──────────────────────────────────────────────────────────
// Public endpoint — no auth required. Called by the customer-facing designer.
//
// Body:
//   bakerSlug            string   required
//   customer             object   required  { email, firstName, lastName, phone? }
//   designSnapshot       object   required  full design JSON
//   designThumbnailKey   string?  R2 key of pre-uploaded thumbnail (e.g. "orders/thumbnails/uuid.png")
//   weightKg             number?
//   flavours             array?   [{ tier: 0, flavour: "vanilla" }, ...]
//   specialInstructions  string?
//   deliveryDate         string?  ISO date  "2026-06-15"
//   deliveryTime         string?  "14:30"
//   deliveryMode         string   "pickup" | "home_delivery"  (default: "pickup")
//   deliveryAddress      string?  required when deliveryMode = "home_delivery"

// ── GET /api/flavours?bakerSlug=xxx ──────────────────────────────────────────
// Public. Returns effective flavour list for a baker:
//   active global flavours (minus exclusions) + baker's custom flavours

router.get('/flavours', async (req, res) => {
  try {
    const { bakerSlug } = req.query;
    if (!bakerSlug) return res.status(400).json({ error: 'bakerSlug is required' });

    const { data: baker } = await supabase
      .from('bakers').select('id').eq('slug', bakerSlug).eq('is_active', true).maybeSingle();
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    // Excluded global flavour IDs for this baker
    const { data: exclusions } = await supabase
      .from('baker_flavour_exclusions')
      .select('flavour_id')
      .eq('baker_id', baker.id);
    const excludedIds = (exclusions ?? []).map(e => e.flavour_id);

    // Active global flavours minus exclusions
    let globalQuery = supabase
      .from('flavours')
      .select('id, name, description, sort_order')
      .eq('is_active', true)
      .order('sort_order').order('name');
    if (excludedIds.length) globalQuery = globalQuery.not('id', 'in', `(${excludedIds.join(',')})`);
    const { data: globals } = await globalQuery;

    // Baker's custom flavours
    const { data: custom } = await supabase
      .from('baker_flavours')
      .select('id, name, description, sort_order')
      .eq('baker_id', baker.id).eq('is_active', true)
      .order('sort_order').order('name');

    const result = [
      ...(globals ?? []).map(f => ({ ...f, source: 'global' })),
      ...(custom  ?? []).map(f => ({ ...f, source: 'baker'  })),
    ];

    res.json(result);
  } catch (err) {
    serverError(req, res, err);
  }
});

router.post('/orders', async (req, res) => {
  try {
    const { bakerSlug, customer } = req.body;

    // ── Validate required fields ────────────────────────────────────────────
    if (!bakerSlug)                         return res.status(400).json({ error: 'bakerSlug is required' });
    if (!customer?.firstName)               return res.status(400).json({ error: 'customer.firstName is required' });
    if (!customer?.phone && !customer?.email) return res.status(400).json({ error: 'customer.phone or customer.email is required' });
    const bodyErr = validateOrderBody(req.body);
    if (bodyErr) return res.status(400).json({ error: bodyErr });
    const dietErr = await validateDietaryKeys(req.body.dietaryRequirementKeys);
    if (dietErr) return res.status(400).json({ error: dietErr });

    // ── Resolve baker ───────────────────────────────────────────────────────
    const { data: baker, error: bakerError } = await supabase
      .from('bakers')
      .select('id, name, email')
      .eq('slug', bakerSlug)
      .eq('is_active', true)
      .maybeSingle();

    if (bakerError) return serverError(req, res, bakerError);
    if (!baker)     return res.status(404).json({ error: 'Baker not found' });

    const bakerId = baker.id;

    // ── Trial / order-cap gate (block before creating anything) ─────────────
    const intakeBlock = await orderIntakeBlock(bakerId);
    if (intakeBlock) return res.status(403).json(intakeBlock);

    // ── Upsert customer (find-or-create by email/phone) ─────────────────────
    const { customerId, emailNorm, phoneNorm } = await upsertCustomer(bakerId, customer);

    const order = await insertOrderAndNotify({
      baker,
      customerId,
      customerContact: { first_name: customer.firstName, last_name: customer.lastName, email: emailNorm, phone: phoneNorm },
      body:            req.body,
    });

    res.status(201).json({ orderId: order.id, createdAt: order.created_at });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/orders/manual ───────────────────────────────────────────────────
// A baker creates an order WITHOUT the 3D designer — the existing-workflow path: take
// a reference photo from the customer (or nothing) and bake it. Authenticated
// (order:manage), baker resolved FROM THE TOKEN (not a slug), so it can't be spoofed
// like the public POST /orders.
//
// No designSnapshot: the order has design_snapshot = null → no design version is
// seeded, and X-Ray / Edit-in-3D stay off (they gate on the snapshot). Up to 3
// reference photos (pre-uploaded to orders/reference/) form the gallery; the primary
// is mirrored into design_thumbnail_url so the order shows its picture everywhere.
//
// Body: { customer:{firstName,lastName?,phone?,email?} (required),
//         referenceKeys?:[uuid…] (≤3, under orders/reference/),
//         weightKg?, flavours?, specialInstructions?,
//         deliveryDate?, deliveryTime?, deliveryMode?, deliveryAddress? }
router.post('/orders/manual', requireAuth, requireCapability('order:manage'), async (req, res) => {
  try {
    const { data: appUser } = await supabase
      .from('baker_appusers').select('baker_id, id')
      .eq('auth_user_id', req.user.id).maybeSingle();
    if (!appUser) return res.status(403).json({ error: 'Not a baker account' });

    const { customer, referenceKeys, deliveryMode = 'pickup', deliveryAddress } = req.body ?? {};

    // Customer is required — the quote, delivery and notifications all address someone.
    if (!customer?.firstName)                 return res.status(400).json({ error: 'customer.firstName is required' });
    if (!customer?.phone && !customer?.email) return res.status(400).json({ error: 'customer.phone or customer.email is required' });
    if (!['pickup', 'home_delivery'].includes(deliveryMode)) return res.status(400).json({ error: 'deliveryMode must be pickup or home_delivery' });
    if (deliveryMode === 'home_delivery' && !deliveryAddress) return res.status(400).json({ error: 'deliveryAddress is required for home_delivery' });
    const dietErr = await validateDietaryKeys(req.body?.dietaryRequirementKeys);
    if (dietErr) return res.status(400).json({ error: dietErr });

    // Reference photos: optional, ≤3, must be under the reference folder (they were
    // signed-uploaded there). An order with zero reference photos is allowed.
    const keys = Array.isArray(referenceKeys) ? referenceKeys.map(k => String(k).replace(/^\/+/, '')) : [];
    if (keys.length > MAX_ORDER_PHOTOS) return res.status(400).json({ error: `At most ${MAX_ORDER_PHOTOS} reference photos` });
    if (keys.some(k => !k.startsWith('orders/reference/'))) {
      return res.status(400).json({ error: 'reference keys must be under orders/reference/' });
    }

    const { data: baker } = await supabase
      .from('bakers').select('id, name, email').eq('id', appUser.baker_id).maybeSingle();
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    const intakeBlock = await orderIntakeBlock(baker.id);
    if (intakeBlock) return res.status(403).json(intakeBlock);

    const { customerId, emailNorm, phoneNorm } = await upsertCustomer(baker.id, customer, { source: 'manual' });

    const order = await insertOrderAndNotify({
      baker,
      customerId,
      customerContact: { first_name: customer.firstName, last_name: customer.lastName, email: emailNorm, phone: phoneNorm },
      body:            { ...req.body, designSnapshot: null, referenceKeys: keys },
      authoredBy:      'baker',
      uploadedBy:      appUser.id,
    });

    res.status(201).json({ orderId: order.id, createdAt: order.created_at });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/customer/orders ─────────────────────────────────────────────────
// Authenticated customer order (the storefront path). The customer is derived
// FROM THE SESSION TOKEN (req.user → customers.auth_user_id), scoped to the
// baker's storefront slug. Any customer identity in the body is IGNORED — a
// logged-in customer can only ever place an order as themselves. This is the
// route that lets the storefront skip the customer-search step entirely.
//
// Body: bakerSlug (required) + the same design/delivery fields as POST /orders.
// NO customer object is read from the body.
router.post('/customer/orders', requireAuth, async (req, res) => {
  try {
    const { bakerSlug } = req.body;
    if (!bakerSlug) return res.status(400).json({ error: 'bakerSlug is required' });

    const bodyErr = validateOrderBody(req.body);
    if (bodyErr) return res.status(400).json({ error: bodyErr });
    const dietErr = await validateDietaryKeys(req.body.dietaryRequirementKeys);
    if (dietErr) return res.status(400).json({ error: dietErr });

    // ── Resolve baker ───────────────────────────────────────────────────────
    const { data: baker, error: bakerError } = await supabase
      .from('bakers')
      .select('id, name, email')
      .eq('slug', bakerSlug)
      .eq('is_active', true)
      .maybeSingle();
    if (bakerError) return serverError(req, res, bakerError);
    if (!baker)     return res.status(404).json({ error: 'Baker not found' });

    // ── Trial / order-cap gate (block before creating anything) ─────────────
    const intakeBlock = await orderIntakeBlock(baker.id);
    if (intakeBlock) return res.status(403).json(intakeBlock);

    // ── Resolve the customer FROM THE TOKEN, scoped to this baker ────────────
    // No bound customer row for (this baker, this auth user) → the caller isn't a
    // customer of this baker (never invited / never OTP-bound) → forbidden.
    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .select('id, first_name, last_name, email, phone, is_active')
      .eq('baker_id', baker.id)
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (custErr) return serverError(req, res, custErr);
    if (!customer || customer.is_active === false) {
      return res.status(403).json({ error: 'Not a customer of this baker' });
    }

    const order = await insertOrderAndNotify({
      baker,
      customerId:      customer.id,
      customerContact: { first_name: customer.first_name, last_name: customer.last_name, email: customer.email, phone: customer.phone },
      body:            req.body,
    });

    // ── Customer consent (DPDP "Layer 2", source 'quote') ───────────────────
    // Requesting a quote IS the affirmative act — the designer shows "By requesting a quote you
    // agree to the Terms of Service and Privacy Policy" directly above this button. Recorded HERE,
    // server-side, rather than by a client call the browser could skip: this is the ONLY moment a
    // storefront customer accepts anything, and it is what makes the ToS content warranties
    // (6.3/6.4 — "you have the right to use this image") actually bind them. It is also why we do
    // NOT prompt on every photo upload: ask once, prove it forever.
    //
    // Idempotent per (subject, current version), so re-quoting never duplicates a row, and a no-op
    // while the docs are still draft. Deliberately NON-FATAL: the order is the customer's, and an
    // audit write must not lose them their cake. A failure is logged, not surfaced.
    recordConsent({
      subjectType: CONSENT_SUBJECT_TYPE.CUSTOMER,
      subjectId:   req.user.id,
      docKeys:     [...CONSENT_REQUIRED_DOC_KEYS],
      source:      CONSENT_SOURCE.QUOTE,
      ip:          req.ip,
      userAgent:   req.headers['user-agent'] ?? null,
    }).catch(err => logError(err, req));

    res.status(201).json({ orderId: order.id, createdAt: order.created_at });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/customer/orders?bakerSlug=… ──────────────────────────────────────
// The customer's own requests/quotes with this baker (the "your quotes" view).
// Customer resolved FROM THE TOKEN, scoped to the baker's storefront slug.
router.get('/customer/orders', requireAuth, async (req, res) => {
  try {
    const { bakerSlug } = req.query;
    if (!bakerSlug) return res.status(400).json({ error: 'bakerSlug is required' });

    const { data: baker } = await supabase
      .from('bakers').select('id').eq('slug', bakerSlug).eq('is_active', true).maybeSingle();
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    const { data: customer } = await supabase
      .from('customers').select('id').eq('baker_id', baker.id).eq('auth_user_id', req.user.id).maybeSingle();
    if (!customer) return res.status(403).json({ error: 'Not a customer of this baker' });

    const { data, error } = await supabase
      .from('orders').select(CUSTOMER_ORDER_FIELDS)
      .eq('baker_id', baker.id).eq('customer_id', customer.id)
      .order('created_at', { ascending: false });
    if (error) return serverError(req, res, error);

    res.json((data ?? []).map(toCustomerOrder));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/customer/orders/:id ──────────────────────────────────────────────
router.get('/customer/orders/:id', requireAuth, async (req, res) => {
  try {
    const { order, status, error } = await loadCustomerOrder(req.user.id, req.params.id);
    if (error) return res.status(status).json({ error });
    res.json(toCustomerOrder(order));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/customer/orders/:id/accept ──────────────────────────────────────
// Customer accepts the current quote → order is confirmed (design locks). Only
// valid on a fresh (non-stale) 'quoted' order — a quote for a design that has since
// changed can't be accepted (the baker must re-confirm the price first).
router.post('/customer/orders/:id/accept', requireAuth, async (req, res) => {
  try {
    const { order, status, error } = await loadCustomerOrder(req.user.id, req.params.id);
    if (error) return res.status(status).json({ error });
    if (order.status !== 'quoted') return res.status(409).json({ error: 'No active quote to approve.' });
    if (quoteStale(order)) {
      return res.status(409).json({ error: 'The design changed since this quote — ask the baker to re-confirm the price.' });
    }

    // Customer approves the quote → 'quote_approved' (design + price agreed and locked).
    // The baker confirms separately (after the advance) — that's the 'confirmed' step.
    const { data: updated, error: uErr } = await supabase
      .from('orders')
      .update({ status_id: await idForKey('quote_approved'), final_price: order.quoted_price, approved_at: new Date().toISOString() })
      .eq('id', order.id)
      .select(CUSTOMER_ORDER_FIELDS)
      .maybeSingle();
    if (uErr) return serverError(req, res, uErr);

    await supabase.from('order_audit_log').insert({
      order_id: order.id, baker_id: order.baker_id,
      event: 'quote_approved',
      changes: { status: { from: 'quoted', to: 'quote_approved' } },
      changed_by_name: 'Customer',
    });

    // Notify the baker that the customer approved (so they can collect the advance + confirm).
    const [{ data: baker }, { data: cust }] = await Promise.all([
      supabase.from('bakers').select('id, name, email').eq('id', order.baker_id).maybeSingle(),
      supabase.from('customers').select('first_name, last_name').eq('id', order.customer_id).maybeSingle(),
    ]);
    notifyQuoteAccepted({ order: updated, baker: baker ?? {}, customer: cust ?? {} })
      .catch(err => console.error('[notifications] quote accepted failed:', err.message));

    res.json(toCustomerOrder(updated));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/customer/orders/:id/decline ─────────────────────────────────────
// Customer declines (the quote or their pending request) → cancelled. Allowed only
// while still in the quote phase (a confirmed order is locked).
router.post('/customer/orders/:id/decline', requireAuth, async (req, res) => {
  try {
    const { order, status, error } = await loadCustomerOrder(req.user.id, req.params.id);
    if (error) return res.status(status).json({ error });
    // Cancellable while in the quote phase OR after approving but before the baker
    // confirms (no advance committed yet). Once 'confirmed' it's locked.
    const cancellable = (await isQuotePhase(order.status)) || order.status === 'quote_approved';
    if (!cancellable) {
      return res.status(409).json({ error: 'This order can no longer be cancelled.' });
    }

    const { data: updated, error: uErr } = await supabase
      .from('orders').update({ status_id: await idForKey('cancelled') })
      .eq('id', order.id).select(CUSTOMER_ORDER_FIELDS).maybeSingle();
    if (uErr) return serverError(req, res, uErr);

    await supabase.from('order_audit_log').insert({
      order_id: order.id, baker_id: order.baker_id,
      event: 'status_changed', comment: req.body?.reason ?? null,
      changes: { status: { from: order.status, to: 'cancelled' } },
      changed_by_name: 'Customer',
    });

    res.json(toCustomerOrder(updated));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/customer/orders/:id/message ─────────────────────────────────────
// Customer asks the baker a question (the "Talk to {baker}" path on the quote screen).
// Records the note on the order and notifies the baker — keeps the quote open (the
// baker replies by revising the quote, or out-of-band via WhatsApp). Not a dead-end.
router.post('/customer/orders/:id/message', requireAuth, async (req, res) => {
  try {
    const { order, status, error } = await loadCustomerOrder(req.user.id, req.params.id);
    if (error) return res.status(status).json({ error });
    const message = (req.body?.message ?? '').toString().trim();
    if (!message) return res.status(400).json({ error: 'message is required' });

    await supabase.from('order_audit_log').insert({
      order_id: order.id, baker_id: order.baker_id,
      event: 'customer_message', comment: message,
      changed_by_name: 'Customer',
    });

    const [{ data: baker }, { data: cust }] = await Promise.all([
      supabase.from('bakers').select('id, name, email').eq('id', order.baker_id).maybeSingle(),
      supabase.from('customers').select('first_name, last_name').eq('id', order.customer_id).maybeSingle(),
    ]);
    notifyQuoteQuestion({ order, baker: baker ?? {}, customer: cust ?? {}, message })
      .catch(err => console.error('[notifications] quote question failed:', err.message));

    res.json({ ok: true });
  } catch (err) {
    serverError(req, res, err);
  }
});


// ── GET /api/orders ───────────────────────────────────────────────────────────
// Baker-facing: list orders for the authenticated baker's account.
// Query params: status, from, to (ISO dates)

router.get('/orders', requireAuth, requireCapability('order:view'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const { status, from, to } = req.query;

    let query = supabase
      .from('orders')
      .select(`
        id, status_id, order_statuses ( key ), weight_kg, delivery_date, delivery_time,
        delivery_mode, delivery_address, flavours,
        special_instructions, design_thumbnail_url, design_snapshot,
        approved_at, created_at, updated_at,
        quoted_price, quote_valid_until, current_version_id, quoted_version_id,
        ${DIETARY_EMBED},
        customers ( id, email, first_name, last_name, phone )
      `)
      .eq('baker_id', req.bakerId)
      .order('created_at', { ascending: false });

    if (status)               query = query.eq('status_id', await idForKey(status));
    if (from)                 query = query.gte('created_at', from);
    if (to)                   query = query.lte('created_at', to);
    if (req.query.delivery_date) query = query.eq('delivery_date', req.query.delivery_date);
    if (req.query.customer_id)   query = query.eq('customer_id', req.query.customer_id);

    const { data, error } = await query;
    if (error) return serverError(req, res, error);

    res.json(data.map(o => ({ ...withDietaryKeys(withStatusKey(o)), design_thumbnail_url: toPublicUrl(o.design_thumbnail_url), quote_stale: quoteStale(o) })));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/orders/:id ───────────────────────────────────────────────────────
// Returns full order including design_snapshot (for reconstructing the cake).

router.get('/orders/:id', requireAuth, requireCapability('order:view'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const order = await assertBakerOwns(req, 'orders', req.params.id, { select: `
        *,
        order_statuses ( key ),
        ${DIETARY_EMBED},
        customers ( id, email, first_name, last_name, phone )
      ` });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    res.json({ ...withDietaryKeys(withStatusKey(order)), quote_stale: quoteStale(order) });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/order-statuses ───────────────────────────────────────────────────
// The canonical lifecycle (label/phase/order/tone), served from the DB table so
// the baker UI and the customer "your quote" view render the same statuses we
// store — instead of each repo hardcoding its own copy.
router.get('/order-statuses', async (req, res) => {
  try {
    res.json(await getOrderStatuses());
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/dietary-requirements ─────────────────────────────────────────────
// The pickable requirement vocabulary (key/label/kind/order), served from the DB so
// the order form, the baker UI and the print sheet render the same set we store —
// instead of each repo hardcoding its own copy. Public: the customer-facing order
// form needs it before anyone is authenticated, and it is reference data, not a
// tenant's data. Same reasoning (and shape) as GET /api/order-statuses above.
router.get('/dietary-requirements', async (req, res) => {
  try {
    res.json(await getDietaryRequirements());
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── PATCH /api/orders/:id/status ──────────────────────────────────────────────

router.patch('/orders/:id/status', requireAuth, requireCapability('order:manage'), async (req, res) => {
  try {
    const { status, comment } = req.body;
    // Valid targets come from the order_statuses table (the source of truth), not a
    // hardcoded array — add/retire a status by editing the table.
    const validKeys = await getValidStatusKeys();
    if (!validKeys.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validKeys.join(', ')}` });
    }

    const { data: appUser } = await supabase
      .from('baker_appusers').select('baker_id, id, first_name, last_name')
      .eq('auth_user_id', req.user.id).maybeSingle();
    if (!appUser) return res.status(403).json({ error: 'Not a baker account' });

    const existingRow = await assertBakerOwns(req, 'orders', req.params.id, { select: 'status_id, current_version_id, order_statuses ( key )' });
    if (!existingRow) return res.status(404).json({ error: 'Order not found' });
    const existing = withStatusKey(existingRow);

    const updates = { status_id: await idForKey(status) };
    // Stamp lifecycle milestones. 'confirmed' = the BAKER confirms (advance received) —
    // approved_at was already set when the CUSTOMER approved (quote_approved), so here
    // we stamp advance_paid_at instead. 'quoted' records when the baker issued the price
    // + pins the quote to the design version it priced (later edits make quoted_version_id
    // != current → the quote is stale and must be re-affirmed or re-quoted).
    if (status === 'confirmed') { updates.advance_paid_at = new Date().toISOString(); updates.approved_by = appUser.id; }
    if (status === 'quoted') {
      if (!updates.priced_at) updates.priced_at = new Date().toISOString();
      updates.quoted_version_id = existing.current_version_id;
    }

    const { data: order, error } = await supabase
      .from('orders').update(updates).eq('id', req.params.id).eq('baker_id', appUser.baker_id)
      .select('id, status_id, order_statuses ( key ), approved_at, priced_at, quoted_version_id, current_version_id').maybeSingle();
    if (error) return serverError(req, res, error);

    await supabase.from('order_audit_log').insert({
      order_id: req.params.id, baker_id: appUser.baker_id,
      event: 'status_changed', comment: comment ?? null,
      changes: { status: { from: existing.status, to: status } },
      changed_by_name: `${appUser.first_name ?? ''} ${appUser.last_name ?? ''}`.trim() || req.user.email,
    });

    // Baker confirmed → let the customer know the order is locked in.
    if (status === 'confirmed') {
      const { data: ctx } = await supabase.from('orders')
        .select('id, final_price, design_thumbnail_url, bakers(name, slug), customers(email, first_name)')
        .eq('id', req.params.id).maybeSingle();
      notifyOrderConfirmed({
        order:    { id: req.params.id, final_price: ctx?.final_price ?? null, design_thumbnail_url: toPublicUrl(ctx?.design_thumbnail_url) },
        baker:    ctx?.bakers ?? {},
        customer: ctx?.customers ?? {},
      }).catch(err => console.error('[notifications] order confirmed failed:', err.message));
    }

    // Baker marked it ready → tell the customer it's ready for pickup/delivery.
    // Finished-cake photos (optional, ≤3) the baker uploaded before flipping to ready
    // ride along in the email — read them here so they're embedded inline. Ordered by
    // sort_order so the email matches the baker's chosen sequence.
    if (status === 'ready') {
      const { data: ctx } = await supabase.from('orders')
        .select('id, delivery_mode, delivery_date, delivery_time, design_thumbnail_url, bakers(name, slug), customers(email, first_name)')
        .eq('id', req.params.id).maybeSingle();
      const { data: photoRows } = await supabase.from('order_finished_photos')
        .select('key').eq('order_id', req.params.id).order('sort_order', { ascending: true });
      const photoUrls = (photoRows ?? []).map(p => toPublicUrl(p.key)).filter(Boolean);
      notifyOrderReady({
        order:    { id: req.params.id, delivery_mode: ctx?.delivery_mode, delivery_date: ctx?.delivery_date, delivery_time: ctx?.delivery_time, design_thumbnail_url: toPublicUrl(ctx?.design_thumbnail_url), photoUrls },
        baker:    ctx?.bakers ?? {},
        customer: ctx?.customers ?? {},
      }).catch(err => console.error('[notifications] order ready failed:', err.message));
    }

    // Baker marked it complete (delivered/picked up) → thank the customer.
    if (status === 'completed') {
      const { data: ctx } = await supabase.from('orders')
        .select('id, design_thumbnail_url, bakers(name, slug), customers(email, first_name)')
        .eq('id', req.params.id).maybeSingle();
      notifyOrderCompleted({
        order:    { id: req.params.id, design_thumbnail_url: toPublicUrl(ctx?.design_thumbnail_url) },
        baker:    ctx?.bakers ?? {},
        customer: ctx?.customers ?? {},
      }).catch(err => console.error('[notifications] order completed failed:', err.message));
    }

    res.json(withStatusKey(order));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Finished-cake photos ──────────────────────────────────────────────────────
// Optional (≤3) photos of the finished cake the baker uploads — typically right
// before marking the order 'ready', so they ride along in the order-ready email
// (see the ready branch above). Stored as bare R2 keys under orders/photos/ in
// order_finished_photos; served back as public URLs. Baker-scoped: every route
// verifies the order belongs to the caller's bakery.

// Resolve the caller's baker_appuser (for appUser.id, used to stamp uploads) + assert the order is
// theirs (SEC-14 assertBakerOwns — server-resolved req.bakerId). Returns { appUser } or
// { status, error } for the route to return.
async function loadBakerOrder(req, orderId) {
  const { data: appUser } = await supabase
    .from('baker_appusers').select('baker_id, id')
    .eq('auth_user_id', req.user.id).maybeSingle();
  if (!appUser) return { status: 403, error: 'Not a baker account' };
  const order = await assertBakerOwns(req, 'orders', orderId);
  if (!order) return { status: 404, error: 'Order not found' };
  return { appUser };
}

// One factory registers the GET/POST(replace)/DELETE trio for an order photo SET, so
// the finished-cake photos and the manual-order reference photos share identical
// handlers (they differ only by table + R2 folder). `mirrorThumbnail` maintains
// orders.design_thumbnail_url from the PRIMARY photo — used by the reference set so a
// manual order's picture stays in sync on edit (guarded to design-less orders so it
// can never clobber a real design thumbnail).
function registerOrderPhotoRoutes({ path, table, folder, mirrorThumbnail = false }) {
  // GET — list the set (ordered), as public URLs for display.
  router.get(`/orders/:id/${path}`, requireAuth, requireCapability('order:manage'), async (req, res) => {
    try {
      const ctx = await loadBakerOrder(req, req.params.id);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      const { data: rows, error } = await supabase
        .from(table).select('id, key, sort_order')
        .eq('order_id', req.params.id).order('sort_order', { ascending: true });
      if (error) return serverError(req, res, error);
      res.json((rows ?? []).map(r => ({ id: r.id, sort_order: r.sort_order, url: toPublicUrl(r.key) })));
    } catch (err) {
      serverError(req, res, err);
    }
  });

  // POST — replace the set with `keys` (≤3, ordered by position). Replace (not append)
  // is idempotent; the prior set's R2 objects are pruned so they don't leak. Keys must
  // live under this set's folder (the upload allow-list folder).
  router.post(`/orders/:id/${path}`, requireAuth, requireCapability('order:manage'), async (req, res) => {
    try {
      const ctx = await loadBakerOrder(req, req.params.id);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

      const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(k => String(k).replace(/^\/+/, '')) : null;
      if (!keys) return res.status(400).json({ error: 'keys must be an array' });
      if (keys.length > MAX_ORDER_PHOTOS) return res.status(400).json({ error: `At most ${MAX_ORDER_PHOTOS} photos` });
      if (keys.some(k => !k.startsWith(`${folder}/`))) {
        return res.status(400).json({ error: `keys must be under ${folder}/` });
      }

      // Prune the previous set's R2 objects (fresh uuid filenames ⇒ no overlap with `keys`).
      const { data: prior } = await supabase.from(table).select('key').eq('order_id', req.params.id);
      await supabase.from(table).delete().eq('order_id', req.params.id);
      await Promise.allSettled((prior ?? []).map(p => deleteObject(p.key)));

      let inserted = [];
      if (keys.length) {
        const rows = keys.map((key, i) => ({
          order_id: req.params.id, key, sort_order: i, uploaded_by: ctx.appUser.id,
        }));
        const { data, error } = await supabase.from(table).insert(rows).select('id, key, sort_order');
        if (error) return serverError(req, res, error);
        inserted = data ?? [];
      }

      // Keep the denormalised picture mirror in step with the primary reference photo,
      // but only for a design-less order (never overwrite a rendered design thumbnail).
      if (mirrorThumbnail) {
        await supabase.from('orders')
          .update({ design_thumbnail_url: keys[0] ?? null })
          .eq('id', req.params.id).is('design_snapshot', null);
      }

      res.json(inserted.map(r => ({ id: r.id, sort_order: r.sort_order, url: toPublicUrl(r.key) })));
    } catch (err) {
      serverError(req, res, err);
    }
  });

  // DELETE — remove one photo (row + its R2 object).
  router.delete(`/orders/:id/${path}/:photoId`, requireAuth, requireCapability('order:manage'), async (req, res) => {
    try {
      const ctx = await loadBakerOrder(req, req.params.id);
      if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
      const { data: row } = await supabase
        .from(table).select('id, key')
        .eq('id', req.params.photoId).eq('order_id', req.params.id).maybeSingle();
      if (!row) return res.status(404).json({ error: 'Photo not found' });
      await supabase.from(table).delete().eq('id', row.id);
      await deleteObject(row.key).catch(err => console.error('[orders] photo object delete failed:', err.message));

      if (mirrorThumbnail) {
        // Re-point the mirror at the new primary (lowest sort_order), or clear it.
        const { data: rest } = await supabase.from(table)
          .select('key').eq('order_id', req.params.id).order('sort_order', { ascending: true }).limit(1);
        await supabase.from('orders')
          .update({ design_thumbnail_url: rest?.[0]?.key ?? null })
          .eq('id', req.params.id).is('design_snapshot', null);
      }

      res.json({ ok: true });
    } catch (err) {
      serverError(req, res, err);
    }
  });
}

// Finished-cake photos (delivery) and manual-order reference photos (intake) — same
// trio of routes, different set. Paths/clients unchanged for the finished set.
registerOrderPhotoRoutes({ path: 'photos',           table: 'order_finished_photos',  folder: 'orders/photos' });
registerOrderPhotoRoutes({ path: 'reference-photos', table: 'order_reference_photos', folder: 'orders/reference', mirrorThumbnail: true });

// ── POST /api/orders/:id/quote ────────────────────────────────────────────────
// Baker issues (or re-issues) the quote: captures the price + optional line items,
// PINS the quote to the CURRENT design version, flips status → 'quoted', and emails
// the customer. Re-issuing with the same price on a stale quote = "price holds"
// (re-pin to the current version). Rejected once the order is past the quote phase.
router.post('/orders/:id/quote', requireAuth, requireCapability('order:manage'), async (req, res) => {
  try {
    const { price, lineItems, validUntil, comment, advanceAmount, note } = req.body;
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      return res.status(400).json({ error: 'price must be a positive number' });
    }
    const advanceNum = advanceAmount === '' || advanceAmount == null ? null : Number(advanceAmount);
    if (advanceNum != null && (!Number.isFinite(advanceNum) || advanceNum < 0 || advanceNum > priceNum)) {
      return res.status(400).json({ error: 'advanceAmount must be between 0 and the price' });
    }

    const { data: appUser } = await supabase
      .from('baker_appusers').select('baker_id, id, first_name, last_name')
      .eq('auth_user_id', req.user.id).maybeSingle();
    if (!appUser) return res.status(403).json({ error: 'Not a baker account' });

    const existingRow = await assertBakerOwns(req, 'orders', req.params.id, { select: 'status_id, current_version_id, order_statuses ( key ), bakers(name, slug), customers(email, first_name)' });
    if (!existingRow) return res.status(404).json({ error: 'Order not found' });
    const existing = withStatusKey(existingRow);

    // Quote only before the order is confirmed (design still open).
    if (!(await isQuotePhase(existing.status))) {
      return res.status(409).json({ error: 'A quote can only be issued before the order is confirmed.' });
    }

    const { data: order, error } = await supabase
      .from('orders')
      .update({
        quoted_price:      priceNum,
        quote_line_items:  Array.isArray(lineItems) ? lineItems : null,
        quote_valid_until: validUntil ?? null,
        advance_amount:    advanceNum,
        quote_note:        (note ?? '').toString().trim() || null,
        priced_at:         new Date().toISOString(),
        status_id:         await idForKey('quoted'),
        quoted_version_id: existing.current_version_id,   // pin to the priced design
      })
      .eq('id', req.params.id).eq('baker_id', appUser.baker_id)
      .select('id, status_id, order_statuses ( key ), quoted_price, quote_line_items, quote_valid_until, advance_amount, quote_note, priced_at, quoted_version_id, current_version_id')
      .maybeSingle();
    if (error) return serverError(req, res, error);

    const noteVal = (note ?? '').toString().trim() || null;
    await supabase.from('order_audit_log').insert({
      order_id: req.params.id, baker_id: appUser.baker_id,
      event: 'quoted', comment: comment ?? null,
      changes: {
        quoted_price: { to: priceNum },
        ...(advanceNum != null ? { advance: { to: advanceNum } } : {}),
        ...(noteVal ? { note: { to: noteVal } } : {}),
      },
      changed_by_name: `${appUser.first_name ?? ''} ${appUser.last_name ?? ''}`.trim() || req.user.email,
    });

    notifyQuoteIssued({
      order:    { id: req.params.id, quoted_price: priceNum, quote_valid_until: validUntil ?? null, advance_amount: advanceNum, quote_note: (note ?? '').toString().trim() || null },
      baker:    existing.bakers ?? {},
      customer: existing.customers ?? {},
    }).catch(err => console.error('[notifications] quote issued failed:', err.message));

    // Freshly pinned to the current version → never stale right after issuing.
    res.json({ ...withStatusKey(order), quote_stale: false });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── PATCH /api/orders/:id ─────────────────────────────────────────────────────
// Edit order details. Requires a comment explaining the change.

const EDITABLE_FIELDS = ['weight_kg', 'delivery_date', 'delivery_time', 'delivery_mode', 'delivery_address', 'special_instructions', 'flavours'];
// After 'confirmed' the design is locked, but delivery LOGISTICS stay editable —
// changing where/when it's delivered doesn't touch the cake or the agreed price.
// (weight_kg / flavours are price-bearing → locked with the design.)
const LOGISTICS_FIELDS = ['delivery_date', 'delivery_time', 'delivery_mode', 'delivery_address'];

router.patch('/orders/:id', requireAuth, requireCapability('order:manage'), async (req, res) => {
  try {
    const { comment, ...fields } = req.body;
    if (!comment?.trim()) return res.status(400).json({ error: 'comment is required when editing an order' });

    const { data: appUser } = await supabase
      .from('baker_appusers').select('baker_id, first_name, last_name')
      .eq('auth_user_id', req.user.id).maybeSingle();
    if (!appUser) return res.status(403).json({ error: 'Not a baker account' });

    const existingRow = await assertBakerOwns(req, 'orders', req.params.id, { select: ['status_id', 'order_statuses ( key )', ...EDITABLE_FIELDS].join(', ') });
    if (!existingRow) return res.status(404).json({ error: 'Order not found' });
    const existing = withStatusKey(existingRow);

    // Once locked (past the quote phase), only delivery logistics may change.
    const allowedFields = (await isQuotePhase(existing.status)) ? EDITABLE_FIELDS : LOGISTICS_FIELDS;
    const disallowed = Object.keys(fields).filter(f => EDITABLE_FIELDS.includes(f) && !allowedFields.includes(f));
    if (disallowed.length) {
      return res.status(409).json({ error: `Once the order is confirmed, only delivery details can be changed (not: ${disallowed.join(', ')}).` });
    }

    // Sanitize: empty strings → null; weight_kg → number or null;
    // flavours → array (jsonb) or null, keeping only entries with a name.
    function sanitize(field, val) {
      if (field === 'flavours') {
        if (!Array.isArray(val)) return null;
        const cleaned = val.filter(f => (f?.name ?? '').toString().trim());
        return cleaned.length ? cleaned : null;
      }
      if (val === '' || val === undefined) return null;
      if (field === 'weight_kg') return val === null ? null : parseFloat(val);
      return val;
    }

    const updates = {};
    const changes = {};
    for (const f of allowedFields) {
      if (!(f in fields)) continue;
      const sanitized = sanitize(f, fields[f]);
      const existing_val = existing[f] ?? null;
      // flavours is jsonb — compare by value; others compare as strings (e.g. 2 vs "2")
      const changed = f === 'flavours'
        ? JSON.stringify(sanitized) !== JSON.stringify(existing_val ?? null)
        : String(sanitized ?? '') !== String(existing_val ?? '');
      if (changed) {
        updates[f] = sanitized;
        changes[f] = { from: existing_val, to: sanitized };
      }
    }

    // Dietary requirements are a child-table SET, not a column, so they sit outside the
    // field loop above — but they are edited from the same form and must land in the
    // same audit entry, because "who changed the eggless flag, when, and why" is
    // exactly the question anyone will ask afterwards.
    //
    // Locked with the cake, not with logistics: the requirement determines what gets
    // baked, so it belongs with weight_kg/flavours in the quote phase. Once the order
    // is confirmed the honest answer is a conversation (and a cancel + recreate), not a
    // silent update to a cake that may already be in the oven. Change-Freeze — knowing
    // per-attribute what is still physically changeable — is the feature that would
    // relax this properly; until it exists, refusing is the safe default.
    let dietaryChange = null;
    if ('dietary_requirements' in fields) {
      if (!allowedFields.includes('flavours')) {
        return res.status(409).json({ error: 'Once the order is confirmed, dietary requirements cannot be changed here — cancel and recreate the order.' });
      }
      const requested = Array.isArray(fields.dietary_requirements) ? fields.dietary_requirements : [];
      const dietErr = await validateDietaryKeys(requested);
      if (dietErr) return res.status(400).json({ error: dietErr });

      const { data: currentRows } = await supabase
        .from('order_dietary_requirements')
        .select('dietary_requirements ( key )')
        .eq('order_id', req.params.id);
      const current = (currentRows ?? []).map(r => r.dietary_requirements?.key).filter(Boolean).sort();
      const next = [...new Set(requested)].sort();

      if (JSON.stringify(current) !== JSON.stringify(next)) {
        dietaryChange = { from: current, to: next };
        changes.dietary_requirements = dietaryChange;
      }
    }

    if (Object.keys(updates).length === 0 && !dietaryChange) return res.status(400).json({ error: 'No changes detected' });

    // `updates` can legitimately be empty when the ONLY change is the requirement set
    // (a child table), so read the row back rather than issuing an empty UPDATE.
    const selection = 'id, ' + EDITABLE_FIELDS.join(', ');
    const scoped = Object.keys(updates).length
      ? supabase.from('orders').update(updates).eq('id', req.params.id).eq('baker_id', appUser.baker_id).select(selection)
      : supabase.from('orders').select(selection).eq('id', req.params.id).eq('baker_id', appUser.baker_id);
    const { data: order, error } = await scoped.maybeSingle();
    if (error) return serverError(req, res, error);
    if (!order) return res.status(404).json({ error: 'Order not found after update' });

    // After the row write, so a failed column update never leaves the set half-applied.
    // 'baker' as the source: this endpoint is baker-authenticated, so whoever is typing
    // is recording what the customer told them — Spattoo still asserts nothing.
    if (dietaryChange) {
      await setOrderDietaryRequirements(req.params.id, dietaryChange.to, 'baker');
    }

    const { error: auditError } = await supabase.from('order_audit_log').insert({
      order_id: req.params.id, baker_id: appUser.baker_id,
      event: 'edited', comment: comment.trim(), changes,
      changed_by_name: `${appUser.first_name ?? ''} ${appUser.last_name ?? ''}`.trim() || req.user.email,
    });
    if (auditError) console.error('Audit log insert failed:', auditError.message);

    res.json(dietaryChange ? { ...order, dietary_requirements: dietaryChange.to } : order);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── PATCH /api/orders/:id/design ─────────────────────────────────────────────
// Baker edits the 3D design (the shared-pen window). Appends a new design VERSION
// (never overwrites), advances the current pointer, and emails the customer that
// the baker has recommendations / an update. Rejected once the design is locked
// (status past the quote phase — i.e. confirmed onward → cancel + recreate).
// Requires a comment.

router.patch('/orders/:id/design', requireAuth, requireCapability('order:manage'), async (req, res) => {
  try {
    const { designSnapshot, designThumbnailKey, comment } = req.body;
    if (!designSnapshot)    return res.status(400).json({ error: 'designSnapshot is required' });
    if (!comment?.trim())   return res.status(400).json({ error: 'comment is required' });

    const { data: appUser } = await supabase
      .from('baker_appusers').select('baker_id, first_name, last_name')
      .eq('auth_user_id', req.user.id).maybeSingle();
    if (!appUser) return res.status(403).json({ error: 'Not a baker account' });

    // Pull status + baker/customer contact (for the lock guard + customer email).
    const existingRow = await assertBakerOwns(req, 'orders', req.params.id, { select: 'id, status_id, order_statuses ( key ), bakers(name, slug), customers(email, first_name, last_name)' });
    if (!existingRow) return res.status(404).json({ error: 'Order not found' });
    const existing = withStatusKey(existingRow);

    // Design lock: editable only during the quote phase (initiated/requested/quoted).
    if (!(await isQuotePhase(existing.status))) {
      return res.status(409).json({ error: 'The design is locked once the order is confirmed. Cancel and recreate to change the cake.' });
    }

    // Append a new version (baker-authored) + advance the current pointer/mirror.
    // The quote (if any) auto-goes stale: quoted_version_id no longer == current.
    const thumbnailKey = designThumbnailKey ?? null;
    const version = await appendDesignVersion({
      orderId: req.params.id, designSnapshot, thumbnailKey, authoredBy: 'baker',
    });

    const { error: auditError } = await supabase.from('order_audit_log').insert({
      order_id: req.params.id, baker_id: appUser.baker_id,
      event: 'design_updated', comment: comment.trim(),
      changes: { design_version: { to: version.version_no } },
      changed_by_name: `${appUser.first_name ?? ''} ${appUser.last_name ?? ''}`.trim() || req.user.email,
    });
    if (auditError) console.error('Audit log insert failed:', auditError.message);

    // Email the customer: recommendations (still pre-quote) vs updated (after a quote).
    notifyDesignUpdated({
      order:    { id: req.params.id, design_thumbnail_url: toPublicUrl(thumbnailKey) },
      baker:    existing.bakers ?? {},
      customer: existing.customers ?? {},
      mode:     existing.status === 'quoted' ? 'updated' : 'recommendations',
    }).catch(err => console.error('[notifications] design update failed:', err.message));

    res.json({ orderId: req.params.id, versionNo: version.version_no, designThumbnailUrl: toPublicUrl(thumbnailKey) });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/orders/:id/versions ──────────────────────────────────────────────
// The design's append-only version history (newest first).
router.get('/orders/:id/versions', requireAuth, requireCapability('order:view'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'Not a baker account' });
    const order = await assertBakerOwns(req, 'orders', req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const { data, error } = await supabase
      .from('order_design_versions')
      .select('id, version_no, design_thumbnail_url, authored_by, created_at')
      .eq('order_id', req.params.id)
      .order('version_no', { ascending: false });
    if (error) return serverError(req, res, error);

    res.json((data ?? []).map(v => ({ ...v, design_thumbnail_url: toPublicUrl(v.design_thumbnail_url) })));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/orders/:id/audit ─────────────────────────────────────────────────

router.get('/orders/:id/audit', requireAuth, requireCapability('order:view'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'Not a baker account' });
    const order = await assertBakerOwns(req, 'orders', req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const { data, error } = await supabase
      .from('order_audit_log').select('id, event, comment, changes, changed_by_name, changed_at')
      .eq('order_id', req.params.id).order('changed_at', { ascending: false });
    if (error) return serverError(req, res, error);

    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
