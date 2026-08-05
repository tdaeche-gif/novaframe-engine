-- Add SHA-256 checksum columns to engine_releases.
--
-- Why: the .exe/.dmg mirrored into the engine-releases bucket have no published
-- checksum, so a user cannot verify a download and a corrupted upload is
-- invisible until someone runs it. The release workflow now computes both and
-- PATCHes them onto the release row.
--
-- Safe to run against an existing table: both columns are nullable, so historic
-- rows simply have no checksum. The release workflow's checksum PATCH is
-- non-fatal, so applying this is not blocking — until it runs, checksums are
-- computed and logged in CI but not persisted.
--
-- Run against: Novaframe production Supabase.

alter table public.engine_releases
  add column if not exists windows_sha256 text,
  add column if not exists mac_sha256     text;

comment on column public.engine_releases.windows_sha256
  is 'SHA-256 of the Windows installer in the engine-releases bucket. Set by the release workflow.';
comment on column public.engine_releases.mac_sha256
  is 'SHA-256 of the macOS .dmg in the engine-releases bucket. Set by the release workflow.';
