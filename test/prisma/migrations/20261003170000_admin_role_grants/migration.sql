-- Admin (bypass) role: BYPASSRLS skips the policies, but it can still only do
-- what is granted here. Least privilege: read and update, no insert/delete.
GRANT USAGE ON SCHEMA public TO rowguard_admin;
GRANT SELECT, UPDATE ON "Tenant", "Note", "Comment" TO rowguard_admin;
