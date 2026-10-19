-- AlterTable
ALTER TABLE "ApplianceDocument" ADD COLUMN     "declaredBrand" TEXT,
ADD COLUMN     "declaredModels" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "expiresOn" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DocumentChunk" ADD COLUMN     "search" tsvector GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED;

-- Ranked full-text search index
CREATE INDEX "DocumentChunk_search_idx" ON "DocumentChunk" USING GIN ("search");
