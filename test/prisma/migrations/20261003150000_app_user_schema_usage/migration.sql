-- `prisma migrate reset` recreates the `public` schema without the default
-- USAGE grant, so app_user can't even see the tables. Grant it explicitly.
GRANT USAGE ON SCHEMA public TO app_user;
