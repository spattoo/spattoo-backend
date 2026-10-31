import { supabase } from '../../services/supabase.js';
import { advanceGeneration, TERMINAL } from '../../services/ai3dAdvance.js';

// ── Finish a generation nobody is watching ───────────────────────────────────────────────────────
//
// Until this existed, the only thing that moved a 3D generation forward was a browser:
// `Element3DStudio` runs a setInterval against `GET /admin/ai3d/:id`. Close the tab and the run is
// frozen — the vendor finishes, we never notice, and the model is never stored.
//
// ⚠️ THAT IS AN INCONVENIENCE FOR STAFF AND A BILLING FAULT FOR A BAKER. A baker's credits are
// reserved when the run starts and settled when it ends, so with only a browser poll, whether they
// are CHARGED OR REFUNDED depends on keeping a tab open. Close the laptop and the credits sit in
// limbo: not spent, not returned, with nothing to resolve them.
//
// So: a tick that walks the runs still in flight and finishes them. The same tick is also the
// sweep for reservations nothing resolved — `aiCredits.js` already says "the sweep catches it"
// about a sweep that did not exist. One mechanism, both problems; a second one would be a second
// thing to keep correct.
//
// ⚠️ IT SHARES THE ADVANCE, IT DOES NOT REIMPLEMENT IT. `services/ai3dAdvance.js` is what the route
// calls too. Copied instead of shared, the job and the screen would answer differently about the
// same run — and the one nobody is watching is the one that drifts.

/* How far back to look. A run that has been IN_PROGRESS for longer than this is not coming back:
   both vendors finish in minutes, so a day is already generous by an order of magnitude. Past it
   the row is left alone rather than polled for ever — a vendor's task ids do not live indefinitely
   and a 404 loop is not a useful thing to run hourly. */
const STALE_AFTER_HOURS = 24;
/* A ceiling per tick. The tick is cheap but each row is a network call to a vendor, and an unbounded
   sweep would turn a backlog into a thundering herd against someone else's API. Whatever is left is
   picked up on the next tick; nothing is lost, it just drains. */
const MAX_PER_TICK = 25;

/**
 * The loop, separated from the reading so it can be ASSERTED. Takes the advance function rather
 * than importing it, because the one property worth guaranteeing here — that a single vendor
 * failure does not abandon the rest of the sweep — cannot be tested against a live vendor, and a
 * resilience rule nobody can exercise is a comment, not a rule. `check:ai3d-poll` drives it.
 */
export async function advanceAll(rows, advance) {
  let advanced = 0, finished = 0, failed = 0;
  for (const row of rows) {
    try {
      const out = await advance(row);
      if (out?.changed) advanced++;
      if (TERMINAL.includes(out?.row?.status)) finished++;
    } catch (err) {
      /* ⚠️ ONE VENDOR HICCUP MUST NOT STOP THE SWEEP, and must not mark a live run dead. The row
         keeps its last known state and is picked up again next tick — exactly how the studio treats
         a failed poll. Counted so a vendor outage reads as a pattern in the log rather than as one
         line among many. */
      failed++;
      console.error(`poll_ai3d: ${row.id} (${row.provider}):`, err.message);
    }
  }
  return { seen: rows.length, advanced, finished, failed };
}

/** Which runs are still worth asking about. Exported so the gate can assert the window. */
export function inFlightQuery(now = Date.now()) {
  return {
    notStatuses: TERMINAL,
    since: new Date(now - STALE_AFTER_HOURS * 3600_000).toISOString(),
    limit: MAX_PER_TICK,
  };
}

export async function pollAi3d() {
  const q = inFlightQuery();

  const { data: rows, error } = await supabase
    .from('ai3d_generations')
    .select('*')
    .not('status', 'in', `(${q.notStatuses.join(',')})`)
    .gte('created_at', q.since)
    .order('created_at', { ascending: true })
    .limit(q.limit);

  if (error) { console.error('poll_ai3d: could not read generations:', error.message); return; }
  if (!rows?.length) return;

  const r = await advanceAll(rows, advanceGeneration);
  console.log(`poll_ai3d: ${r.seen} in flight, ${r.advanced} advanced, ${r.finished} finished`
            + (r.failed ? `, ${r.failed} vendor error(s)` : ''));
}
