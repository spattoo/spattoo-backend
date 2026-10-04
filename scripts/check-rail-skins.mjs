#!/usr/bin/env node
// ── a skin may not make the rail unreadable ──────────────────────────────────────────────────────
//
// Rail skins are master data: a new one is a ROW, which is the point — an admin adds a look without
// a deploy. That is also the danger. The rail's labels are 9px and a skin is the BACKGROUND they sit
// on, so the person choosing the colours is deciding whether the navigation can be read, and
// nothing about picking a nice brown tells them they just did that.
//
// ⚠️ THIS IS NOT HYPOTHETICAL. On 2026-10-04 a mid-oak handle was built, looked exactly like wood,
// and put every label on it at 2.61 : 1 — barely half the 4.5 floor for small text. The build was
// green, the smoke was green, and the only reason it did not ship is that somebody measured. This
// gate is that measurement, run for every row, every time.
//
// Pure — lib/railSkin.js imports nothing — so no network, no config, no database. The SEEDED rows
// are checked here; rows added later are checked by the same arithmetic on the write path, which is
// why the formula lives in the lib and not in this file.
import { readFileSync } from 'node:fs';
import {
  servedRailSkin, FALLBACK_RAIL_SKIN, worstInkContrast, MIN_RAIL_CONTRAST, parseColour,
} from '../src/lib/railSkin.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`);
};

// ── the seeded rows, read out of the migration itself ────────────────────────
// Parsed rather than hardcoded here: a second list of the skins is a second thing to keep in step,
// and the one that drifts is always the copy nobody is looking at.
const sql = readFileSync(new URL('../migrations/120_rail_skins.sql', import.meta.url), 'utf8');
const rows = [...sql.matchAll(
  /\('([a-z]+)',\s*'([^']+)',\s*(true|false),\s*(true|false),\s*'(\[[^\]]*\])'::jsonb,\s*(NULL|[\d.]+),\s*'([a-z]+)',\s*'([^']+)',\s*(\d+)\)/g
)].map(m => ({
  key: m[1], name: m[2], is_default: m[3] === 'true', is_premium: m[4] === 'true',
  stops: JSON.parse(m[5]), joint_at: m[6] === 'NULL' ? null : +m[6], texture: m[7], ink: m[8],
}));

// ⚠️ A TEXTURE THE RENDERER DOES NOT KNOW DRAWS NOTHING, silently. Keys live here so adding one in
// admin without teaching core about it fails the build rather than shipping a skin that is just a
// gradient wearing a name.
const TEXTURES = new Set(['none', 'grain']);

ok(rows.length >= 2, 'the migration seeds more than one skin — one is not a choice', `${rows.length}`);

// ── every skin must be readable ──────────────────────────────────────────────
for (const r of rows) {
  const worst = worstInkContrast(r);
  ok(worst !== null, `${r.key}: its stops and ink parse`, String(r.ink));
  if (worst === null) continue;
  ok(worst >= MIN_RAIL_CONTRAST,
     `${r.key}: labels clear AA against every one of its own stops`,
     `${worst.toFixed(2)} : 1, floor ${MIN_RAIL_CONTRAST}`);
  ok(r.stops.length === 4, `${r.key}: four stops`, `${r.stops.length}`);
  ok(r.stops.every(parseColour), `${r.key}: every stop is a colour`);
  ok(TEXTURES.has(r.texture), `${r.key}: its texture is one core can draw`, r.texture);
  // A joint is a FRACTION of the handle, not a pixel — the rail is drawn to its measured height.
  ok(r.joint_at === null || (r.joint_at > 0 && r.joint_at < 1),
     `${r.key}: any joint is a fraction between 0 and 1`, String(r.joint_at));
}

// ── exactly one default, and it is free ──────────────────────────────────────
const defaults = rows.filter(r => r.is_default);
ok(defaults.length === 1, 'exactly one skin is the default', `${defaults.length}`);
ok(defaults[0]?.key === FALLBACK_RAIL_SKIN,
   'the default row IS the fallback the resolver names', `${defaults[0]?.key} vs ${FALLBACK_RAIL_SKIN}`);
// ⚠️ A premium default would withhold the thing a downgrade falls BACK to, which is a baker on
// Spark with no rail at all.
ok(defaults[0]?.is_premium === false, 'the default is not premium — it is what everyone falls back to');

// ── the resolver ─────────────────────────────────────────────────────────────
const ENT = { rail_skins: true }, NO_ENT = { rail_skins: false };
ok(servedRailSkin('walnut', rows, ENT) === 'walnut',       'Blaze gets the skin it chose');
ok(servedRailSkin('walnut', rows, NO_ENT) === 'chrome',    'without the entitlement it falls back');
ok(servedRailSkin('chrome', rows, NO_ENT) === 'chrome',    'a free skin is served on every plan');
ok(servedRailSkin(null, rows, ENT) === 'chrome',           'no choice is the default');
// A key that no longer exists: the row was retired after somebody picked it. Draw the default —
// never throw, and never clear their column, which is the caller's business and not this function's.
ok(servedRailSkin('gone', rows, ENT) === 'chrome',         'an unknown key falls back rather than throwing');
ok(servedRailSkin('walnut', rows, null) === 'chrome',      'no entitlements resolved yet is not a licence');

if (failures) {
  console.error(`\n✗ check:rail-skins — ${failures} failing`);
  process.exit(1);
}
console.log(`✓ check:rail-skins — ${rows.length} skins, every one readable; the default is free and is the fallback`);
