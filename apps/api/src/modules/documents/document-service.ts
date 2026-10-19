import { createHash } from "node:crypto";
import { basename } from "node:path";
import { Prisma, type DocumentType } from "@prisma/client";
import { chunkPage, contentHash, extractDeclaredBrand, extractDeclaredModels, extractExpiry } from "@fixloop/domain";
import type { Db } from "../../db.js";
import type { BlobStorage } from "../../adapters/storage.js";
import { AppError, forbidden, notFound } from "../../errors.js";
import type { Principal } from "../../principal.js";
import { extractPages, sniffType } from "./extract.js";

export interface IngestInput { filename: string; contentType: string; bytes: Buffer; type: DocumentType; applianceId?: string | undefined; sourceType?: string }

const cleanName = (n: string) => basename(n).replace(/[^\p{L}\p{N}._ ()-]/gu, "_").slice(0, 200) || "document";

export class DocumentService {
  constructor(private readonly db: Db, private readonly storage: BlobStorage, private readonly maxBytes: number) {}

  async ingest(p: Principal, input: IngestInput) {
    if (p.role === "VIEWER") throw forbidden();
    if (input.bytes.length === 0) throw new AppError("EMPTY_DOCUMENT", "Document is empty", 422);
    if (input.bytes.length > this.maxBytes) throw new AppError("DOCUMENT_TOO_LARGE", `Document exceeds ${this.maxBytes} bytes`, 413);
    const type = sniffType(input.contentType, input.bytes);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");

    const existing = await this.db.applianceDocument.findUnique({ where: { householdId_sha256: { householdId: p.householdId, sha256 } } });
    if (existing) return { document: existing, duplicate: true as const, chunkCount: await this.db.documentChunk.count({ where: { documentId: existing.id } }) };

    if (input.applianceId) {
      const a = await this.db.appliance.findUnique({ where: { id: input.applianceId } });
      if (!a || a.householdId !== p.householdId) throw notFound("appliance");
    }

    const pages = await extractPages(type, input.bytes);
    const fullText = pages.join("\n");
    const rows = pages.flatMap((text, i) => chunkPage(text).map((content, chunkIndex) => ({ pageNumber: i + 1, chunkIndex, content, contentHash: contentHash(content) })));
    const storagePath = await this.storage.put(sha256, input.bytes);

    try {
      const document = await this.db.$transaction(async (tx) => {
        const doc = await tx.applianceDocument.create({ data: {
          householdId: p.householdId, applianceId: input.applianceId ?? null, type: input.type, originalFilename: cleanName(input.filename),
          contentType: type, sha256, storagePath, sourceType: input.sourceType ?? "USER_UPLOAD", extractedAt: new Date(), processingStatus: "PROCESSED",
          declaredModels: extractDeclaredModels(fullText), declaredBrand: extractDeclaredBrand(fullText), expiresOn: extractExpiry(fullText),
        } });
        await tx.documentChunk.createMany({ data: rows.map((r) => ({ ...r, documentId: doc.id })) });
        return doc;
      });
      return { document, duplicate: false as const, chunkCount: rows.length };
    } catch (e) {
      // Concurrent identical upload lost the race: return the winner.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const winner = await this.db.applianceDocument.findUnique({ where: { householdId_sha256: { householdId: p.householdId, sha256 } } });
        if (winner) return { document: winner, duplicate: true as const, chunkCount: await this.db.documentChunk.count({ where: { documentId: winner.id } }) };
      }
      throw e;
    }
  }

  async get(p: Principal, id: string) {
    const doc = await this.db.applianceDocument.findUnique({ where: { id } });
    if (!doc || doc.householdId !== p.householdId) throw notFound("document");
    return { ...doc, chunkCount: await this.db.documentChunk.count({ where: { documentId: id } }) };
  }

  async list(p: Principal, applianceId?: string) {
    return this.db.applianceDocument.findMany({ where: { householdId: p.householdId, ...(applianceId ? { applianceId } : {}) }, orderBy: { uploadedAt: "asc" } });
  }
}
