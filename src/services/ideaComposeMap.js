/* ── The composer's arithmetic: what the model is shown, and what it is allowed to say back ──────
 *
 * ⚠️ PURE, AND IN ITS OWN FILE SO IT CAN BE CHECKED WITHOUT THE SERVER — the same split
 * `inspirationMaps.js` has from `inspirationMatch.js`, and `storyRank.js` from `storyMatch.js`, and
 * for the same reason: the impure half imports `config.js`, which refuses to load without every
 * runtime secret including a Redis URL. A guardrail that cannot be exercised without Redis is a
 * guardrail nobody exercises — and this one decides whether a hallucinated id reaches a cake.
 *
 * Two jobs:
 *   · turn the catalogue into lines a model can choose from
 *   · turn what it says back into a spec, keeping only what is true
 */

/* The surfaces a spec may name. These are the four the SEAT honours, not the six the designer's
   ZONES enumerates — see `seatableZones`. */
export const ZONES = Object.freeze(['top_surface', 'side', 'rim', 'board']);

/* ⚠️ THE ZONES THE SEAT WILL HONOUR, NOT THE ONES THE ROW NAMES — the same distinction the
   placement chooser draws with `zonePoses`, and it was got wrong here first. `placementSlots`
   collapses `middle_tier` into a SIDE slot: there is no middle_tier seat, only a side one on an
   inner tier. Showing a row's `allowed_zones` verbatim therefore offered the model a surface that
   does not exist, and `specFromModel` then refused it — caught on the first real run, where the
   model dutifully put a Lion on `middle_tier` because the parts list said it could.
   A model cannot be blamed for choosing something it was offered. */
const ZONE_ALIAS = Object.freeze({ middle_tier: 'side', top: 'top_surface' });
export const seatZone = (z) => ZONE_ALIAS[z] ?? z;

/** A row's zones, reduced to the ones a seat exists for, de-duplicated and in a stable order. */
export function seatableZones(row) {
  const out = [...new Set((row?.allowed_zones ?? []).map(seatZone))].filter(z => ZONES.includes(z));
  return out.length ? out : ['top_surface'];
}
export const PROMINENCE = Object.freeze(['hero', 'feature', 'accent']);

/* ⚠️ A CAP, BECAUSE "COUNT" IS THE ONE FIELD A MODEL CAN RUIN A CAKE WITH. Asked for sprinkles it
   will happily say 200, and every one is a real placement through the real add path. Twelve is
   more than any composed cake has needed and small enough that a bad answer is ugly, not fatal. */
export const MAX_COUNT = 12;
/* And a cap on how many DIFFERENT pieces, for the same reason one notch up: a cake with eleven
   kinds of decoration on it is not a design, it is the shortlist tipped onto a tier. */
export const MAX_KINDS = 8;

/**
 * The catalogue, as the model sees it.
 *
 * ⚠️ SHORT INDICES, NOT UUIDS, AND IT IS NOT A MICRO-OPTIMISATION. A UUID is about 16 tokens; at
 * 200 shortlisted elements that is 3,200 tokens of pure identifier before a single description —
 * and every one is a string the model can mistype into a plausible-looking id that matches nothing.
 * An integer it cannot typo into another valid element, and `specFromModel` maps it back.
 *
 * ⚠️ AND THE ZONES ARE SHOWN. Without them the model guesses where a piece can go, is wrong a
 * third of the time, and every wrong guess is a dropped element the baker never sees. Showing them
 * costs four words a line and turns a refusal into a non-event.
 */
export function elementLines(rows = []) {
  return rows.map((r, i) => {
    const zones = seatableZones(r).join(',');
    const type = r.element_types?.name ?? r.type ?? '';
    /* One line, pipe-separated, description last and clipped: it is the longest field and the least
       load-bearing once the name is good. A name like "Terracotta Pot Overflowing with Butter"
       carries most of the meaning on its own. */
    const desc = String(r.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 110);
    return `${i}|${r.name}|${type}|${zones}|${desc}`;
  }).join('\n');
}

/** The prompt. Kept here, next to the parser, so the shape asked for and the shape read agree. */
export function composePrompt({ brief, lines }) {
  const { subject = '', ages = [], gender = null, occasion = null, weightKg = null } = brief ?? {};
  const who = [
    ages.length ? `age ${ages.join(' and ')}` : null,
    gender && gender !== 'anyone' ? gender : null,
    occasion || null,
  ].filter(Boolean).join(', ');

  return `You are a cake designer composing ONE cake from a fixed parts list.

THE BRIEF
subject: ${subject || '(none given)'}${who ? `\nfor: ${who}` : ''}${weightKg ? `\nsize: about ${weightKg}kg` : ''}

THE PARTS YOU MAY USE — one per line, as:
index|name|type|zones it can go on|description
${lines}

RULES
1. Choose ONLY by index from the list above. Never invent a part.
2. Put a part only on a zone ITS OWN line lists.
3. If something clearly belongs on this cake and is NOT in the list, name it in "wanted" and
   compose the cake without it. Do not substitute something unrelated.
4. At most ${MAX_KINDS} different parts, and at most ${MAX_COUNT} of any one.
5. Pick colours that suit the subject. Hex, and they must read against each other.

Return ONLY a JSON object, no prose, no code fence:
{
  "cake": { "shape": "round|square|heart", "tiers": [ { "color": "<hex>" } ] },
  "message": { "text": "<short, or null>", "look": "cream|fondant|acrylic", "surface": "top|side|board", "color": "<hex>" },
  "age": { "number": <integer> } or null,
  "elements": [ { "i": <index>, "zone": "<zone>", "count": <integer>, "prominence": "hero|feature|accent" } ],
  "palette": ["<hex>", "..."],
  "wanted": ["<a part this cake wants that the list does not have>", "..."],
  "why": "<one sentence: why this looks like the subject>"
}`;
}

/** Strip a code fence the model was told not to use and sometimes uses anyway. */
export function parseJson(raw) {
  const t = String(raw ?? '').trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  try { return { ok: true, value: JSON.parse(t) }; }
  catch (e) { return { ok: false, error: e.message, raw: t.slice(0, 400) }; }
}

/**
 * What the model said → a spec, keeping only what is TRUE.
 *
 * ⚠️ THE GUARDRAILS ARE HERE, NOT IN THE PROMPT. Every rule in `composePrompt` is a request; each
 * one below is enforced. The difference matters because a model that breaks rule 2 produces a cake
 * that looks composed and places nothing — the failure is silent, and silent is the expensive kind.
 *
 * ⚠️ AND A REFUSAL IS RECORDED, NEVER DROPPED. `rejected` is how a prompt gets improved: if the
 * model keeps putting side-only pieces on the board, that is a line to add, not noise to swallow.
 */
export function specFromModel(out, rows = [], { brief = {} } = {}) {
  const rejected = [];
  const el = [];
  const seen = new Set();

  for (const e of (out?.elements ?? [])) {
    const row = rows[Number(e?.i)];
    if (!row) { rejected.push({ i: e?.i, why: 'no such index in the parts list' }); continue; }

    /* Read through the same alias the parts list was written with, so a model that echoes back a
       row's own wording is understood rather than refused. */
    const zone = seatZone(e?.zone);
    const allows = seatableZones(row);
    if (!ZONES.includes(zone)) { rejected.push({ name: row.name, why: `invented zone ${e?.zone}` }); continue; }
    if (!allows.includes(zone)) {
      rejected.push({ name: row.name, why: `${zone} is not one of ${allows.join(', ')}` });
      continue;
    }
    /* One row, one zone. A model asked for a hero piece will sometimes list it three times on the
       same surface believing it is adding emphasis; `count` is how emphasis is expressed. */
    const key = `${row.id}|${zone}`;
    if (seen.has(key)) { rejected.push({ name: row.name, why: 'already placed on that zone' }); continue; }
    seen.add(key);

    if (el.length >= MAX_KINDS) { rejected.push({ name: row.name, why: `over the ${MAX_KINDS}-part limit` }); continue; }

    el.push({
      elementId: row.id,
      zone,
      count: Math.min(MAX_COUNT, Math.max(1, Math.round(Number(e.count) || 1))),
      prominence: PROMINENCE.includes(e.prominence) ? e.prominence : 'feature',
    });
  }

  const tiers = Array.isArray(out?.cake?.tiers) && out.cake.tiers.length
    ? out.cake.tiers.map(t => ({ color: typeof t?.color === 'string' ? t.color : undefined }))
    : [{}];

  const msg = out?.message;
  const message = msg && typeof msg.text === 'string' && msg.text.trim()
    ? { text: msg.text.trim(), look: msg.look ?? 'cream', surface: msg.surface ?? 'top', color: msg.color }
    : null;

  return {
    spec: {
      version: 1,
      brief,
      cake: {
        shape: typeof out?.cake?.shape === 'string' ? out.cake.shape : 'round',
        tiers,
        weightKg: brief.weightKg ?? null,
      },
      message,
      age: Number.isInteger(out?.age?.number) ? { number: out.age.number } : null,
      elements: el,
      palette: Array.isArray(out?.palette) ? out.palette.filter(c => typeof c === 'string') : [],
      /* The commissioning queue. Trimmed and de-duplicated because a model will say "a cow" and
         "cow figurine" in one breath and they are one missing element, not two. */
      wanted: [...new Set((out?.wanted ?? [])
        .filter(w => typeof w === 'string')
        .map(w => w.trim().toLowerCase())
        .filter(Boolean))],
      why: typeof out?.why === 'string' ? out.why : '',
    },
    rejected,
  };
}

/* ── Placing ONE thing, from one sentence ────────────────────────────────────────────────────────
 *
 * "add a coral on the board". A whole cake is the hard problem and the arrangement is the half it
 * was losing, so this is that half on its own: one instruction, one group of pieces, laid out.
 * Sandeep: *"i want to first check if we build this capability"* — and a capability is easier to
 * trust when the only thing it is being asked to do is the thing under test.
 *
 * ⚠️ IT ASKS FOR SEVERAL INDICES, NOT ONE. The catalogue holds four coral rows, two of them named
 * identically with character-identical descriptions, so a model asked for "a coral" can only pick
 * one and repeat it — which is exactly how six copies of one coral happened. Asking for the whole
 * MATCHING SET turns the duplicate names from a trap into the variety a band wants.
 *
 * ⚠️ AND THE ARRANGEMENT IS A WORD FROM A CLOSED LIST, NEVER COORDINATES. The model does not know
 * how wide this cake is; `arrangeOnSlot` in the designer does. Same rule as the spec's zones, and
 * the vocabulary is the one the catalogue already uses on its piping rows.
 */

/** The arrangement vocabulary, mirroring `designer/idea/arrange.js`. */
export const ARRANGEMENTS = Object.freeze(['single', 'ring', 'arc', 'pair', 'cluster', 'scatter']);

export function placePrompt({ instruction, lines }) {
  return `You are placing decorations on a cake. Someone asked for exactly this:

"${instruction}"

THE PARTS YOU MAY USE — one per line, as:
index|name|type|zones it can go on|description
${lines}

RULES
1. Choose ONLY by index from the list above. Never invent a part.
2. Choose EVERY index that matches what was asked for, not just the best one. Several rows often
   describe the same thing with different artwork — a group built from four of them looks hand
   made, and the same row repeated looks stamped.
3. Ignore any index that is not the thing that was asked for. Returning nothing is a fine answer.
4. "zone" must be one that EVERY index you chose lists on its own line.
5. "arrangement" is one of: ${ARRANGEMENTS.join(', ')}. Choose what suits the thing and the surface
   — a ring runs all the way round, an arc only across the front, a cluster is one tight group.
6. "count" is how many PIECES in total, 1 to ${MAX_COUNT}. One is a perfectly good answer.

Return ONLY a JSON object, no prose, no code fence:
{
  "i": [<index>, ...],
  "zone": "<zone>",
  "arrangement": "<arrangement>",
  "count": <integer>,
  "why": "<one short sentence>"
}`;
}

/**
 * What the model said → one placeable group, keeping only what is TRUE.
 *
 * Returns `{ group, rejected }`. `group` is null when nothing survived — a real answer when the
 * catalogue has none of what was asked for, and the caller reports it rather than inventing a
 * substitute.
 */
export function groupFromModel(out, rows = []) {
  const rejected = [];
  const zone = seatZone(out?.zone);
  if (!ZONES.includes(zone)) {
    return { group: null, rejected: [{ why: `invented zone ${JSON.stringify(out?.zone)}` }] };
  }

  const ids = [];
  const seen = new Set();
  const asked = Array.isArray(out?.i) ? out.i : [out?.i];
  for (const raw of asked) {
    const row = rows[Number(raw)];
    if (!row) { rejected.push({ i: raw, why: 'no such index in the parts list' }); continue; }
    const allows = seatableZones(row);
    if (!allows.includes(zone)) {
      rejected.push({ name: row.name, why: `${zone} is not one of ${allows.join(', ')}` });
      continue;
    }
    if (seen.has(row.id)) { rejected.push({ name: row.name, why: 'named twice' }); continue; }
    seen.add(row.id);
    ids.push(row.id);
  }
  if (!ids.length) return { group: null, rejected };

  const arrangement = ARRANGEMENTS.includes(out?.arrangement) ? out.arrangement : 'cluster';
  /* ⚠️ COUNT IS AT LEAST ONE PER CHOSEN ROW. A model that picks four corals and then says count:1
     has thrown away three of them; the point of choosing a set is that the set gets used. */
  const count = Math.min(MAX_COUNT, Math.max(ids.length, Math.round(Number(out?.count) || ids.length)));

  return {
    group: { elementIds: ids, zone, arrangement, count: arrangement === 'single' ? 1 : count,
             why: typeof out?.why === 'string' ? out.why.slice(0, 200) : '' },
    rejected,
  };
}
