-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CommandTrigger" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "word" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "commandId" INTEGER NOT NULL,
    CONSTRAINT "CommandTrigger_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "CustomCommand" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_CommandTrigger" ("commandId", "id", "isPrimary", "word") SELECT "commandId", "id", "isPrimary", "word" FROM "CommandTrigger";
DROP TABLE "CommandTrigger";
ALTER TABLE "new_CommandTrigger" RENAME TO "CommandTrigger";
CREATE UNIQUE INDEX "CommandTrigger_word_key" ON "CommandTrigger"("word");
CREATE INDEX "CommandTrigger_commandId_idx" ON "CommandTrigger"("commandId");
CREATE TABLE "new_CustomCommand" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
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
INSERT INTO "new_CustomCommand" ("createdAt", "enabled", "globalCooldown", "group", "id", "kind", "name", "permission", "response", "updatedAt", "usageCount", "userCooldown") SELECT "createdAt", "enabled", "globalCooldown", "group", "id", "kind", "name", "permission", "response", "updatedAt", "usageCount", "userCooldown" FROM "CustomCommand";
DROP TABLE "CustomCommand";
ALTER TABLE "new_CustomCommand" RENAME TO "CustomCommand";
CREATE INDEX "CustomCommand_kind_enabled_idx" ON "CustomCommand"("kind", "enabled");
CREATE UNIQUE INDEX "CustomCommand_kind_name_key" ON "CustomCommand"("kind", "name");
CREATE TABLE "new_EventLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "userId" TEXT,
    "amount" INTEGER,
    "meta" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EventLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_EventLog" ("amount", "createdAt", "id", "meta", "type", "userId") SELECT "amount", "createdAt", "id", "meta", "type", "userId" FROM "EventLog";
DROP TABLE "EventLog";
ALTER TABLE "new_EventLog" RENAME TO "EventLog";
CREATE INDEX "EventLog_type_idx" ON "EventLog"("type");
CREATE INDEX "EventLog_createdAt_idx" ON "EventLog"("createdAt");
CREATE TABLE "new_List" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "displayName" TEXT,
    "description" TEXT,
    "addPermission" INTEGER NOT NULL DEFAULT 3,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "List_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_List" ("addPermission", "createdAt", "createdById", "createdByName", "description", "displayName", "id", "name", "updatedAt") SELECT "addPermission", "createdAt", "createdById", "createdByName", "description", "displayName", "id", "name", "updatedAt" FROM "List";
DROP TABLE "List";
ALTER TABLE "new_List" RENAME TO "List";
CREATE UNIQUE INDEX "List_name_key" ON "List"("name");
CREATE TABLE "new_PointsBalance" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "PointsBalance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PointsBalance" ("balance", "id", "userId") SELECT "balance", "id", "userId" FROM "PointsBalance";
DROP TABLE "PointsBalance";
ALTER TABLE "new_PointsBalance" RENAME TO "PointsBalance";
CREATE UNIQUE INDEX "PointsBalance_userId_key" ON "PointsBalance"("userId");
CREATE TABLE "new_Quote" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "text" TEXT NOT NULL,
    "quotedUser" TEXT NOT NULL,
    "game" TEXT,
    "quoteDate" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Quote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Quote" ("createdAt", "createdById", "createdByName", "game", "id", "quoteDate", "quotedUser", "text") SELECT "createdAt", "createdById", "createdByName", "game", "id", "quoteDate", "quotedUser", "text" FROM "Quote";
DROP TABLE "Quote";
ALTER TABLE "new_Quote" RENAME TO "Quote";
CREATE TABLE "new_Setting" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL
);
INSERT INTO "new_Setting" ("id", "key", "value") SELECT "id", "key", "value" FROM "Setting";
DROP TABLE "Setting";
ALTER TABLE "new_Setting" RENAME TO "Setting";
CREATE UNIQUE INDEX "Setting_key_key" ON "Setting"("key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

