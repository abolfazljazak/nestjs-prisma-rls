// Prisma CLI config for the package's own tests (the test schema lives in test/prisma).
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'test/prisma/schema.prisma',
  migrations: { path: 'test/prisma/migrations' },
  datasource: {
    // Migrations run as the superuser, so it owns the tables (like a real deploy user).
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:54329/rowguard_prisma',
  },
});
