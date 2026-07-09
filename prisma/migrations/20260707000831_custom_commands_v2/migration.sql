/*
  Warnings:

  - You are about to drop the column `cooldown` on the `CustomCommand` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "CommandTrigger" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "channel" TEXT NOT NULL,
    "word" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "commandId" INTEGER NOT NULL,
    CONSTRAINT "CommandTrigger_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "CustomCommand" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CustomCommand" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'trigger',
    "name" TEXT NOT NULL,
    "response" TEXT,
    "description" TEXT NOT NULL DEFAULT 'Custom response command.',
    "permission" INTEGER NOT NULL DEFAULT 0,
    "globalCooldown" INTEGER NOT NULL DEFAULT 0,
    "userCooldown" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CustomCommand" ("channel", "createdAt", "id", "name", "permission", "response", "updatedAt") SELECT "channel", "createdAt", "id", "name", "permission", "response", "updatedAt" FROM "CustomCommand";
DROP TABLE "CustomCommand";
ALTER TABLE "new_CustomCommand" RENAME TO "CustomCommand";
CREATE INDEX "CustomCommand_channel_kind_enabled_idx" ON "CustomCommand"("channel", "kind", "enabled");
CREATE UNIQUE INDEX "CustomCommand_channel_kind_name_key" ON "CustomCommand"("channel", "kind", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CommandTrigger_commandId_idx" ON "CommandTrigger"("commandId");

-- CreateIndex
CREATE UNIQUE INDEX "CommandTrigger_channel_word_key" ON "CommandTrigger"("channel", "word");
