-- AlterTable
ALTER TABLE "ConversationSession" ADD COLUMN     "state" JSONB NOT NULL DEFAULT '{}';
-- NOTE: `prisma migrate dev` wants to drop DocumentChunk_search_idx and the default on the generated
-- "search" column (it cannot model GENERATED ... STORED / GIN on tsvector). Those statements were removed on purpose.
