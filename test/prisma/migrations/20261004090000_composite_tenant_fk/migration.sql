-- Foreign keys are checked WITHOUT RLS: a plain "noteId" -> "Note".id FK let one
-- tenant attach comments to another tenant's note and probe which ids exist.
-- A composite FK (noteId, tenantId) -> Note(id, tenantId) requires the parent
-- row to belong to the same tenant.

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_noteId_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "Note_id_tenantId_key" ON "Note"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_noteId_tenantId_fkey" FOREIGN KEY ("noteId", "tenantId") REFERENCES "Note"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

