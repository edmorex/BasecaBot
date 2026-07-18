-- Global name index.
--
-- Replaces `UserAlias` (aliases only) with `UserName`, which indexes EVERY name
-- a user can be referenced by — login, custom display name, and aliases — in one
-- globally-unique namespace. A typed name therefore resolves to at most one
-- person, and no display name or alias can shadow another user's Twitch account.
--
-- Also links quotes to the person quoted (`Quote.quotedUserId`), so display can
-- render the live display name instead of a frozen string.
--
-- Conflict policy for the backfill: logins are inserted first and always win;
-- aliases and custom display names are inserted with OR IGNORE, so any that
-- collide with an already-claimed name are DROPPED rather than blocking the
-- migration. Affected users can simply re-add a non-conflicting alias.

-- CreateTable
CREATE TABLE "UserName" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserName_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "UserName_normalized_key" ON "UserName"("normalized");

-- CreateIndex
CREATE INDEX "UserName_userId_idx" ON "UserName"("userId");

-- CreateIndex
CREATE INDEX "UserName_userId_kind_idx" ON "UserName"("userId", "kind");

-- Backfill: logins first (highest precedence, and already unique on User).
-- Placeholder logins left by a Twitch rename contain ':' and are not real names.
INSERT INTO "UserName" ("userId", "name", "normalized", "kind", "createdAt")
SELECT "id", "login", lower("login"), 'login', "firstSeenAt"
FROM "User"
WHERE instr("login", ':') = 0;

-- Backfill: custom (locked) display names that differ from the login. A synced
-- Twitch display name is just the login recapitalized, so it needs no row.
INSERT OR IGNORE INTO "UserName" ("userId", "name", "normalized", "kind", "createdAt")
SELECT "id", "displayName", lower(trim("displayName")), 'display', "firstSeenAt"
FROM "User"
WHERE "displayNameLocked" = 1
  AND trim("displayName") <> ''
  AND lower(trim("displayName")) <> lower("login");

-- Backfill: aliases.
INSERT OR IGNORE INTO "UserName" ("userId", "name", "normalized", "kind", "createdAt")
SELECT "userId", "alias", "normalized", 'alias', "createdAt"
FROM "UserAlias";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "UserAlias";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Quote" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "text" TEXT NOT NULL,
    "quotedUser" TEXT NOT NULL,
    "quotedUserId" TEXT,
    "game" TEXT,
    "quoteDate" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Quote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Quote_quotedUserId_fkey" FOREIGN KEY ("quotedUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Quote" ("createdAt", "createdById", "createdByName", "game", "id", "quoteDate", "quotedUser", "text") SELECT "createdAt", "createdById", "createdByName", "game", "id", "quoteDate", "quotedUser", "text" FROM "Quote";
DROP TABLE "Quote";
ALTER TABLE "new_Quote" RENAME TO "Quote";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Backfill: link existing quotes whose attributed name resolves to a known user.
-- Names that match nobody (guests, "chat", imported one-offs) stay unlinked and
-- keep rendering from the `quotedUser` snapshot.
UPDATE "Quote"
SET "quotedUserId" = (
    SELECT "userId" FROM "UserName"
    WHERE "UserName"."normalized" = lower(trim(replace("Quote"."quotedUser", '@', '')))
)
WHERE "quotedUserId" IS NULL;
