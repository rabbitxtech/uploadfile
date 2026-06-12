-- Task5 #14 — teams: Group/GroupMember, and grants can target a group.

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Group_name_key" ON "Group"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GroupMember_groupId_userId_key" ON "GroupMember"("groupId", "userId");

-- CreateIndex
CREATE INDEX "GroupMember_userId_idx" ON "GroupMember"("userId");

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: FileGrant.userId becomes optional, add groupId
ALTER TABLE "FileGrant" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "FileGrant" ADD COLUMN "groupId" TEXT;

-- AddForeignKey
ALTER TABLE "FileGrant" ADD CONSTRAINT "FileGrant_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "FileGrant_fileId_groupId_key" ON "FileGrant"("fileId", "groupId");

-- CreateIndex
CREATE INDEX "FileGrant_groupId_idx" ON "FileGrant"("groupId");

-- AlterTable: FolderGrant.userId becomes optional, add groupId
ALTER TABLE "FolderGrant" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "FolderGrant" ADD COLUMN "groupId" TEXT;

-- AddForeignKey
ALTER TABLE "FolderGrant" ADD CONSTRAINT "FolderGrant_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "FolderGrant_folderId_groupId_key" ON "FolderGrant"("folderId", "groupId");

-- CreateIndex
CREATE INDEX "FolderGrant_groupId_idx" ON "FolderGrant"("groupId");
