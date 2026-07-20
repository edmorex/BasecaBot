-- Built-in aliases: a trigger can now point at a built-in command instead of a
-- custom one. `commandId` becomes nullable and `builtinTarget` is added; an
-- alias sets exactly one of the two. Existing rows (all custom) are preserved.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CommandTrigger" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "word" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "args" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "commandId" INTEGER,
    "builtinTarget" TEXT,
    CONSTRAINT "CommandTrigger_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "CustomCommand" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_CommandTrigger" ("args", "commandId", "enabled", "id", "isPrimary", "word") SELECT "args", "commandId", "enabled", "id", "isPrimary", "word" FROM "CommandTrigger";
DROP TABLE "CommandTrigger";
ALTER TABLE "new_CommandTrigger" RENAME TO "CommandTrigger";
CREATE UNIQUE INDEX "CommandTrigger_word_key" ON "CommandTrigger"("word");
CREATE INDEX "CommandTrigger_commandId_idx" ON "CommandTrigger"("commandId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
