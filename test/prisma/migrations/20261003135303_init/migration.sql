-- CreateTable
CREATE TABLE "Tenant" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid,
    "title" TEXT NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" SERIAL NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid,
    "noteId" INTEGER NOT NULL,
    "body" TEXT NOT NULL,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Note_tenantId_idx" ON "Note"("tenantId");

-- CreateIndex
CREATE INDEX "Comment_tenantId_idx" ON "Comment"("tenantId");

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Added by hand: Prisma schema cannot express RLS.
-- The `app_user` role is created by test/global-setup.ts (roles are cluster-wide,
-- they don't belong in a per-database migration).

GRANT SELECT ON "Tenant" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Note", "Comment" TO app_user;
GRANT USAGE ON SEQUENCE "Note_id_seq", "Comment_id_seq" TO app_user;

ALTER TABLE "Note" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Note"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "Comment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Comment"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
