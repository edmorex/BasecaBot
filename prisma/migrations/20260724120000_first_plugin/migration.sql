-- CreateTable
CREATE TABLE "FirstStat" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "firsts" INTEGER NOT NULL DEFAULT 0,
    "topTens" INTEGER NOT NULL DEFAULT 0,
    "sumTimeSeconds" INTEGER NOT NULL DEFAULT 0,
    "sumPlace" INTEGER NOT NULL DEFAULT 0,
    "points" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "FirstStat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FirstCheckin" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "streamKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "place" INTEGER NOT NULL,
    "timeSeconds" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FirstCheckin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FirstCheckin_streamKey_idx" ON "FirstCheckin"("streamKey");

-- CreateIndex
CREATE UNIQUE INDEX "FirstCheckin_streamKey_userId_key" ON "FirstCheckin"("streamKey", "userId");

