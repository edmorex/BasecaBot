-- CreateTable
CREATE TABLE "Boss" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "image" TEXT NOT NULL DEFAULT '',
    "hp" INTEGER NOT NULL DEFAULT 20,
    "emotesPublic" TEXT NOT NULL DEFAULT '[]',
    "emotesPrivate" TEXT NOT NULL DEFAULT '[]',
    "emotesHeal" TEXT NOT NULL DEFAULT '[]',
    "tauntOpening" TEXT NOT NULL DEFAULT '',
    "tauntBattle" TEXT NOT NULL DEFAULT '[]',
    "tauntDeath" TEXT NOT NULL DEFAULT '',
    "tauntEscape" TEXT NOT NULL DEFAULT '',
    "escapeSeconds" INTEGER NOT NULL DEFAULT 180,
    "size" INTEGER NOT NULL DEFAULT 256,
    "speedFull" INTEGER NOT NULL DEFAULT 9,
    "speedNearDeath" INTEGER NOT NULL DEFAULT 2,
    "styles" TEXT NOT NULL DEFAULT '["pingpong"]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BossStat" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "defeats" INTEGER NOT NULL DEFAULT 0,
    "kills" INTEGER NOT NULL DEFAULT 0,
    "lastAt" DATETIME,
    CONSTRAINT "BossStat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
