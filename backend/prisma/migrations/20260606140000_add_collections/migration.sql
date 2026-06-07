-- H5: Collections (virtual file groupings + saved searches).
CREATE TABLE "Collection" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'manual',
    "filter" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Collection_ownerId_idx" ON "Collection"("ownerId");

ALTER TABLE "Collection" ADD CONSTRAINT "Collection_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- implicit many-to-many join table (Prisma naming: _CollectionFiles, A=Collection, B=File)
CREATE TABLE "_CollectionFiles" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

CREATE UNIQUE INDEX "_CollectionFiles_AB_unique" ON "_CollectionFiles"("A", "B");
CREATE INDEX "_CollectionFiles_B_index" ON "_CollectionFiles"("B");

ALTER TABLE "_CollectionFiles" ADD CONSTRAINT "_CollectionFiles_A_fkey"
    FOREIGN KEY ("A") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_CollectionFiles" ADD CONSTRAINT "_CollectionFiles_B_fkey"
    FOREIGN KEY ("B") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;
