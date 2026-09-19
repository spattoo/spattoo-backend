import express from 'express';
import { supabase } from '../services/supabase.js';
import { config } from '../config.js';
import { rateLimit } from '../middleware/rateLimit.js';

// ── GET /o/:orderId — the ONE customer-facing link ───────────────────────────────────────────────
//
// Resolves an order to the bakery that owns it and redirects to that bakery's storefront. It exists
// so every customer link we send has a SINGLE, FIXED host.
//
// ── WHY, because "add a redirect" looks like pointless indirection ───────────────────────────────
//
// The storefront is a SUBDOMAIN PER BAKER — `{slug}.spattoo.com` — so the natural link,
// `feelings-and-flavours.spattoo.com/orders/<uuid>`, has a host that changes with every bakery. Three
// things break on that, and all three are outside our control:
//
//   1. A WhatsApp URL BUTTON is a static base plus a variable suffix, and the base includes the host.
//      A per-baker host cannot be a button at all — the link has to sit in the body text instead.
//   2. A DLT CTA whitelist is per DOMAIN. One `Domain*` field cannot cover every baker's subdomain,
//      and whether an approved apex covers them is stated nowhere (see sms-dlt-templates.md).
//   3. It is 85 characters against an SMS budget of 160.
//
// One fixed host fixes all three at once: `www.spattoo.com/o/{{1}}` is a valid button base, one
// whitelist entry, and 62 characters.
//
// ── WHY THE ORDER ID IS THE TOKEN, and not something new ─────────────────────────────────────────
//
// It already WAS the link reference — the old URL ended `/orders/<uuid>` — and access is gated by OTP
// behind it either way. The id grants nothing on its own, exactly as `customer_invites.sql` says of
// the invite id. So moving it from a path segment to the suffix of a shared host discloses nothing
// that was not already in the link, and it needs no new column, no token table and no collision
// handling. A shorter code is a later optimisation, and only worth it if SMS length starts to matter.
//
// ── WHY IT LIVES HERE AND NOT ON THE MARKETING SITE ──────────────────────────────────────────────
//
// `www.spattoo.com` is the marketing app (Next.js on Vercel). It holds no database credentials and
// has no API client, and giving it either — for one redirect — would buy a new env var, a new
// failure mode and a network hop. Instead the marketing app REWRITES `/o/*` to this route, so the
// browser keeps the `www` host (which is the entire point) while the lookup happens where the data
// already is.
const router = express.Router();

// ⚠️ A public id→bakery lookup is an ENUMERATION SURFACE: guess ids, learn which bakery each belongs
// to. Guessing a v4 uuid is not realistic, so this is a brake on volume rather than a secret-keeper —
// but an unauthenticated route that hits the database on every call needs one regardless.
const perIp = rateLimit({
  name: 'order-link-ip', limit: 60, windowSec: 600, key: req => req.ip,
  message: 'Too many requests. Please wait a few minutes and try again.',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/o/:orderId', perIp, async (req, res) => {
  const { orderId } = req.params;

  /* ⚠️ A CUSTOMER TAPPED THIS, so there is no such thing as an error page worth showing them. Every
     failure below lands on the marketing site rather than a 404: they see something of ours, and the
     baker hears "your link didn't work" instead of the customer assuming the bakery is gone. */
  const giveUp = () => res.redirect(302, config.marketing.url);

  // Shape-check before touching the database — a malformed id is a bad link, not a lookup.
  if (!UUID.test(orderId ?? '')) return giveUp();

  const { data, error } = await supabase
    .from('orders')
    .select('id, bakers(slug)')
    .eq('id', orderId)
    .maybeSingle();

  if (error) {
    // Log it: a database fault here is invisible to us otherwise — the customer just sees the
    // marketing home page and nobody ever finds out the link was supposed to open an order.
    console.error('[orderLink] lookup failed', JSON.stringify({ orderId, error: error.message }));
    return giveUp();
  }

  const baker = Array.isArray(data?.bakers) ? data.bakers[0] : data?.bakers;
  if (!baker?.slug) return giveUp();

  const base = config.storefront.urlTemplate.replace('{slug}', baker.slug).replace(/\/+$/, '');
  // 302, never 301. A permanent redirect is cached by the browser forever, and this mapping is only
  // as permanent as the bakery's slug — which a baker can change in settings.
  return res.redirect(302, `${base}/orders/${orderId}`);
});

/* ── GET /i/:inviteId — the same idea, for an invite ─────────────────────────────────────────────
 *
 * An invite is the one customer notification with no order behind it, so it carries its own link
 * (`routes/customers.js`) — and that link had the same per-baker host, so `customer_invite` could not
 * have a button either. Same fix, same reason: one host, the id as the tail.
 *
 * ⚠️ The destination shape differs and must. An invite opens the storefront ROOT with `?invite=<id>`,
 * not an order page — `customer_invites.sql`: "The row `id` IS the link reference: /<baker-slug>?
 * invite=<id>". It grants nothing on its own; OTP still gates what is behind it.
 */
router.get('/i/:inviteId', perIp, async (req, res) => {
  const { inviteId } = req.params;
  const giveUp = () => res.redirect(302, config.marketing.url);
  if (!UUID.test(inviteId ?? '')) return giveUp();

  const { data, error } = await supabase
    .from('customer_invites')
    .select('id, bakers(slug)')
    .eq('id', inviteId)
    .maybeSingle();

  if (error) {
    console.error('[orderLink] invite lookup failed', JSON.stringify({ inviteId, error: error.message }));
    return giveUp();
  }
  const baker = Array.isArray(data?.bakers) ? data.bakers[0] : data?.bakers;
  if (!baker?.slug) return giveUp();

  /* ⚠️ An EXPIRED or cancelled invite is deliberately NOT filtered here. The storefront already owns
     that decision and says so properly ("this invite has expired, ask the bakery for a new one");
     bouncing to the marketing home page instead would tell the customer nothing and look broken. */
  const base = config.storefront.urlTemplate.replace('{slug}', baker.slug).replace(/\/+$/, '');

  /* ⚠️ CARRY `?session=` THROUGH. Design Together binds the customer to a live room by putting the
     session id on the invite link, and a redirect that rebuilds the URL from scratch drops it — the
     invite still works, so nothing errors, and the baker is simply left sitting in an empty room
     wondering why the customer never joined. Only this one param: anything else on the URL is not
     ours and has no meaning on the storefront. */
  const session = typeof req.query.session === 'string' && UUID.test(req.query.session)
    ? `&session=${req.query.session}` : '';
  return res.redirect(302, `${base}/?invite=${inviteId}${session}`);
});

export default router;
