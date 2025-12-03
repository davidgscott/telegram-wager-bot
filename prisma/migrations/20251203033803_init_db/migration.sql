-- CreateTable
CREATE TABLE "Wager" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" INTEGER,
    "text" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "assetId" TEXT,
    "operator" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voteDeadline" TIMESTAMP(3) NOT NULL,
    "resolutionTime" TIMESTAMP(3) NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "finalPrice" DOUBLE PRECISION,
    "outcomeYes" BOOLEAN,

    CONSTRAINT "Wager_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WagerVote" (
    "id" SERIAL NOT NULL,
    "wagerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WagerVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderboardScore" (
    "id" SERIAL NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "periodType" TEXT NOT NULL,
    "periodKey" TEXT,
    "points" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LeaderboardScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WagerVote_wagerId_userId_key" ON "WagerVote"("wagerId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderboardScore_chatId_userId_periodType_periodKey_key" ON "LeaderboardScore"("chatId", "userId", "periodType", "periodKey");

-- AddForeignKey
ALTER TABLE "WagerVote" ADD CONSTRAINT "WagerVote_wagerId_fkey" FOREIGN KEY ("wagerId") REFERENCES "Wager"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
