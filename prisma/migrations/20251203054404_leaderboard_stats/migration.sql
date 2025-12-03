/*
  Warnings:

  - The primary key for the `LeaderboardScore` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `periodKey` on the `LeaderboardScore` table. All the data in the column will be lost.
  - You are about to drop the column `periodType` on the `LeaderboardScore` table. All the data in the column will be lost.
  - You are about to drop the column `points` on the `LeaderboardScore` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[chatId,userId,scope,monthKey]` on the table `LeaderboardScore` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `scope` to the `LeaderboardScore` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `LeaderboardScore` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "LeaderboardScore_chatId_userId_periodType_periodKey_key";

-- AlterTable
ALTER TABLE "LeaderboardScore" DROP CONSTRAINT "LeaderboardScore_pkey",
DROP COLUMN "periodKey",
DROP COLUMN "periodType",
DROP COLUMN "points",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "losses" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "monthKey" TEXT,
ADD COLUMN     "powerScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "scope" TEXT NOT NULL,
ADD COLUMN     "total" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "wins" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "LeaderboardScore_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "LeaderboardScore_id_seq";

-- CreateIndex
CREATE UNIQUE INDEX "LeaderboardScore_chatId_userId_scope_monthKey_key" ON "LeaderboardScore"("chatId", "userId", "scope", "monthKey");
