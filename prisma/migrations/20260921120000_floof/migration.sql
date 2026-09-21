-- CreateTable
CREATE TABLE "FloofStat" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "lastWonAt" DATETIME,
    CONSTRAINT "FloofStat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
