-- A background-removed (transparent PNG) version of the baker's logo. Generated asynchronously via
-- remove.bg whenever a logo is set/changed (job: remove_logo_bg). The storefront falls back to the
-- original logo_url until this is ready, or if background removal fails — so it never breaks.
alter table bakers add column if not exists logo_transparent_key text;
