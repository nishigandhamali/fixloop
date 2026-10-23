import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./db.js";
import type { BlobStorage } from "./adapters/storage.js";
import { DocumentService } from "./modules/documents/document-service.js";
import type { Principal } from "./principal.js";

export const FIXTURE_DIR = new URL("../../../fixtures/", import.meta.url).pathname;

export interface FixtureSpec {
  file: string;
  type: "MANUAL" | "WARRANTY";
  contentType: string;
}
export const FIXTURES = {
  manual: { file: "manuals/aquavelle-aq-dw450-manual.pdf", type: "MANUAL", contentType: "application/pdf" },
  wrongModel: { file: "manuals/aquavelle-aq-dw900-manual-WRONG-MODEL.pdf", type: "MANUAL", contentType: "application/pdf" },
  expiredWarranty: { file: "warranties/aquavelle-aq-dw450-warranty-EXPIRED.txt", type: "WARRANTY", contentType: "text/plain" },
  noCoverageWarranty: { file: "warranties/aquavelle-aq-dw450-warranty-NO-COVERAGE-INFO.txt", type: "WARRANTY", contentType: "text/plain" },
  conflicting: { file: "manuals/aquavelle-aq-dw450-service-bulletin-CONFLICTING.txt", type: "MANUAL", contentType: "text/plain" },
} as const satisfies Record<string, FixtureSpec>;

export async function ingestFixture(db: Db, storage: BlobStorage, p: Principal, applianceId: string, spec: FixtureSpec) {
  const bytes = await readFile(join(FIXTURE_DIR, spec.file));
  return new DocumentService(db, storage, 50_000_000).ingest(p, {
    filename: spec.file.split("/").pop()!,
    contentType: spec.contentType,
    bytes,
    type: spec.type,
    applianceId,
    sourceType: "SYNTHETIC_FIXTURE",
  });
}

/** Default demo set: correct manual + expired warranty (the two documents a real user would plausibly have). */
export async function seedDocuments(db: Db, storage: BlobStorage, p: Principal, applianceId: string) {
  for (const k of ["manual", "expiredWarranty"] as const) await ingestFixture(db, storage, p, applianceId, FIXTURES[k]);
}
