-- Test schema. Run as the superuser `postgres`, so `postgres` owns the table.
-- The app connects as `app_user`: not superuser, not owner, no BYPASSRLS.
-- That is the only setup where RLS actually applies to the app.

DROP TABLE IF EXISTS "Note";
DROP ROLE IF EXISTS app_user;

CREATE ROLE app_user LOGIN PASSWORD 'app_user' NOSUPERUSER NOBYPASSRLS;

CREATE TABLE "Note" (
  id         serial PRIMARY KEY,
  "tenantId" uuid NOT NULL,
  title      text NOT NULL
);
CREATE INDEX ON "Note" ("tenantId");

GRANT SELECT, INSERT, UPDATE, DELETE ON "Note" TO app_user;
GRANT USAGE ON SEQUENCE "Note_id_seq" TO app_user;

ALTER TABLE "Note" ENABLE ROW LEVEL SECURITY;

-- Cast the setting, not the column, so the index on "tenantId" stays usable.
-- NULLIF: on a reused pooled connection the setting can be '' instead of NULL,
-- and ''::uuid would throw. NULL makes the comparison false -> zero rows.
CREATE POLICY tenant_isolation ON "Note"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
