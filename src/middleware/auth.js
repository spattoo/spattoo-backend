import { supabase } from '../services/supabase.js';

export async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  req.user = user;
  next();
}

// Resolves whether the caller is a baker app-user or an admin.
// Sets req.bakerId (string) for baker users, null for admins.
// Must run after requireAuth.
export async function attachBakerContext(req, res, next) {
  const { data } = await supabase
    .from('baker_appusers')
    .select('baker_id')
    .eq('auth_user_id', req.user.id)
    .maybeSingle();

  /* ⚠️ DOES NOT CLOBBER A BAKER THE PRINCIPAL ALREADY RESOLVED. `loadPrincipal` sets `req.bakerId`
     for a CUSTOMER too — from the customers row they are bound to — and this middleware runs AFTER
     `requireCapability` on several routes. Overwriting unconditionally threw that away, so a
     signed-in storefront customer arrived at `GET /api/templates` with no baker at all and fell
     through to the unscoped branch, which answers with every baker's templates.

     A baker app-user still wins when there is one: their `baker_appusers` row is the authority for
     which bakery they are staff of. This only preserves a value that is already on the request, and
     on routes that never run `ensurePrincipal` (deviceTokens, notifications) `req.bakerId` is
     `undefined`, so the behaviour there is unchanged. */
  req.bakerId = data?.baker_id ?? req.bakerId ?? null;
  next();
}
