export const PLAN = {
  SPARK: 1,
  FLAME: 2,
  BLAZE: 3,
  FORGE: 4,
  ID_BY_NAME:   { spark: 1, flame: 2, blaze: 3, forge: 4 },
  NAME_BY_ID:   { 1: 'spark', 2: 'flame', 3: 'blaze', 4: 'forge' },
  // Tier RANK (mirrors subscription_plans.sort_order) — the ORDERING used to decide upgrade vs
  // downgrade. Kept explicit (not "plan_id happens to sort") so a future non-ordered id can't flip it.
  RANK_BY_ID:   { 1: 0, 2: 1, 3: 2, 4: 3 },
};
