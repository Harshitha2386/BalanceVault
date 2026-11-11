-- AlterTable
ALTER TABLE "LedgerTransaction" ADD COLUMN     "postedTxid" VARCHAR(20) NOT NULL DEFAULT '0';
