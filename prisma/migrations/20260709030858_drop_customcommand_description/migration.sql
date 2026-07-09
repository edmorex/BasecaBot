/*
  Warnings:

  - You are about to drop the column `description` on the `CustomCommand` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CustomCommand" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'trigger',
    "name" TEXT NOT NULL,
    "response" TEXT,
    "group" TEXT,
    "permission" INTEGER NOT NULL DEFAULT 0,
    "globalCooldown" INTEGER NOT NULL DEFAULT 0,
    "userCooldown" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CustomCommand" ("channel", "createdAt", "enabled", "globalCooldown", "group", "id", "kind", "name", "permission", "response", "updatedAt", "usageCount", "userCooldown") SELECT "channel", "createdAt", "enabled", "globalCooldown", "group", "id", "kind", "name", "permission", "response", "updatedAt", "usageCount", "userCooldown" FROM "CustomCommand";
DROP TABLE "CustomCommand";
ALTER TABLE "new_CustomCommand" RENAME TO "CustomCommand";
CREATE INDEX "CustomCommand_channel_kind_enabled_idx" ON "CustomCommand"("channel", "kind", "enabled");
CREATE UNIQUE INDEX "CustomCommand_channel_kind_name_key" ON "CustomCommand"("channel", "kind", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
